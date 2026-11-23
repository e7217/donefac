import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import { jiraFieldDigest } from '../../server/migration-planner';
import type {
  Issue, IssueChangeHistoryEntry, JiraDeadlineRecoveryReview, LegacyPackageSummary, MigrationApplyResult,
  MigrationOptions, MigrationPreview, SourceImport, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types';

async function read<T>(response: Pick<APIResponse, 'status' | 'text'>, status = 200) {
  const text = await response.text();
  expect(response.status(), text).toBe(status);
  return JSON.parse(text) as T;
}

test('Jira 원본 기록에서 검증한 마감일을 복구하고 응답 유실과 팀 편집을 확인한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const key = `DR${suffix}`;
  const date = '2026-12-17';
  const base = `/api/legacy-import/packages?${new URLSearchParams({ filename: `${key}.json`, product: 'jira', instanceKey: key })}`;
  const headers = { 'Content-Type': 'application/octet-stream' };
  const original = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const [actor] = original.users;
  const data = Buffer.from(JSON.stringify({ issues: ['마감일 누락', '팀에서 마감일을 지운 업무'].map((title, index) => ({
    id: String(80200 + index), key: `${key}-${index + 1}`,
    fields: { summary: `${title} ${suffix}`, project: { id: '80000', key, name: `원본 Jira ${suffix}` }, duedate: date,
      status: { id: '1', name: 'Open' }, issuetype: { id: '1', name: 'Task' },
      created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z' },
  })) }));
  const staged = await read<LegacyPackageSummary>(await request.post(base, { headers, data }), 201);
  const issueIds: string[] = [];
  try {
    const { defaultConfiguration } = await read<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${staged.id}`));
    const preview = await read<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration: defaultConfiguration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    const { import: receipt } = await read<MigrationApplyResult>(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
    const [projectId] = receipt.projectIds;
    const restored = await read<WorkspaceSnapshot & {
      exportedAt: string; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[]; issueChangeHistory: IssueChangeHistoryEntry[];
    }>(await request.get('/api/export'));
    const migrated = restored.issues.filter(issue => issue.projectId === projectId).sort((left, right) => left.key.localeCompare(right.key));
    expect(migrated).toHaveLength(2);
    const oldReceipt = restored.sourceImports.find(item => item.id === receipt.id)!;
    // Build a historical native backup with the prior importer's empty canonical due value and a later unrelated title edit.
    oldReceipt.id = randomUUID();
    delete oldReceipt.integrity;
    const oldRecords = restored.sourceRecords.filter(row => row.sourceImportId === receipt.id);
    for (const record of oldRecords) {
      record.id = randomUUID();
      record.sourceImportId = oldReceipt.id;
    }
    for (const issue of migrated) {
      issueIds.push(issue.id);
      expect(issue.dueDate).toBe(date);
      const archive = oldRecords.find(row => row.targetId === issue.id)!;
      archive.jiraIssueFieldHashes = { ...archive.jiraIssueFieldHashes, dueDate: jiraFieldDigest('dueDate', null) };
      const initialTitle = issue.title;
      issue.dueDate = null;
      issue.version++;
      issue.title += ' 검토';
      issue.updatedAt = restored.exportedAt;
      restored.issueChangeHistory.push({ id: randomUUID(), issueId: issue.id, projectId, previousProjectId: projectId,
        issueVersion: issue.version, actorId: actor.id, actorName: actor.name, origin: 'user', occurredAt: issue.updatedAt,
        changes: [{ field: 'title', label: '제목', before: { value: initialTitle, display: initialTitle }, after: { value: issue.title, display: issue.title } }],
      });
    }
    await read(await request.post('/api/import', { data: { confirm: 'REPLACE', data: restored } }));
    const [candidate, cleared] = migrated;
    const recoveryPath = (issue: Issue) => `/api/issues/${issue.id}/jira-deadline-recovery`;
    const readReview = (issue: Issue) => request.get(recoveryPath(issue)).then(value => read<{ review: JiraDeadlineRecoveryReview | null }>(value));
    expect((await readReview(candidate)).review).toMatchObject({ status: 'ready', sourceDueDate: date, currentDueDate: null });
    const afterSet = await read<Issue>(await request.patch(`/api/issues/${cleared.id}`, {
      data: { expectedVersion: cleared.version, dueDate: '2026-12-23' },
    }));
    await read<Issue>(await request.patch(`/api/issues/${cleared.id}`, { data: { expectedVersion: afterSet.version, dueDate: null } }));
    expect((await readReview(cleared)).review).toMatchObject({ status: 'local-change', currentDueDate: null });

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${projectId}/issues?issue=${candidate.id}`);
    const panel = page.getByRole('dialog', { name: candidate.title, exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const due = panel.getByLabel('목표 마감일', { exact: true });
    const source = panel.getByRole('button', { name: '원본 기록', exact: true });
    const details = panel.getByRole('button', { name: '상세 정보', exact: true });
    const recovery = panel.getByRole('region', { name: 'Jira 마감일 복구', exact: true });
    const open = recovery.getByRole('button', { name: 'Jira 마감일 복구', exact: true });
    const apply = recovery.getByRole('button', { name: '복구 적용', exact: true });
    const draft = `${candidate.title} 초안`;
    await title.fill(draft);
    await due.fill('2026-12-29');
    await source.click();
    await expect(recovery).toContainText(date);
    await expect(open).toBeDisabled();
    await details.click();
    await expect(due).toHaveValue('2026-12-29');
    await due.fill('');
    await source.click();
    await open.click();
    const reviewed = await readReview(candidate);
    let applied: Issue | undefined;
    await page.route(url => url.pathname === recoveryPath(candidate), async route => {
      if (route.request().method() !== 'POST') return route.continue();
      expect(route.request().postDataJSON()).toEqual({ revision: reviewed.review?.revision });
      expect(route.request().headers()['x-actor-id']).toBe(actor.id);
      applied = (await read<{ issue: Issue }>(await route.fetch())).issue;
      await route.abort('failed');
    });
    await apply.click();
    await expect(recovery).toContainText('현재 마감일이 Jira 원본과 같습니다.');
    expect(applied).toMatchObject({ id: candidate.id, dueDate: date, version: candidate.version + 1 });
    await details.click();
    await expect(title).toHaveValue(draft);
    await expect(due).toHaveValue(date);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${candidate.id}` && response.request().method() === 'PATCH');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect(await read<Issue>(await saved)).toMatchObject({ title: draft, dueDate: date });

    await page.goto(`/#/${projectId}/issues?issue=${cleared.id}`);
    const edited = page.getByRole('dialog', { name: cleared.title, exact: true });
    await edited.getByRole('button', { name: '원본 기록', exact: true }).click();
    const blockedRecovery = edited.getByRole('region', { name: 'Jira 마감일 복구', exact: true });
    await expect(blockedRecovery).toContainText(date);
    await expect(blockedRecovery.getByRole('button', { name: 'Jira 마감일 복구', exact: true })).toHaveCount(0);
  } finally {
    for (const issueId of issueIds) {
      const response = await request.delete(`/api/issues/${issueId}`);
      if (response.ok()) await request.delete(`/api/trash/${(await response.json() as { trashEntryId: string }).trashEntryId}`);
    }
    await request.delete(`/api/legacy-import/packages/${staged.id}?expectedVersion=${staged.version}`);
  }
});
