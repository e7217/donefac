import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type {
  Dependency, Issue, IssueRelation, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, WorkspaceSnapshot,
} from '../../shared/types';

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

async function preview(page: Page, settings: Locator) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/migrations/preview' && response.request().method() === 'POST');
  await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as MigrationPreview;
}

function dateAt(offset: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

test('360px에서 기존 Jira 업무의 새 관계를 이관해 일정 연결을 검토한다', async ({ page, request, context }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });

  const suffix = randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
  const sourceKey = `JR${suffix}`, targetKey = `TR${suffix}`;
  const sourceProject = { id: '4100', key: sourceKey, name: `Jira 관계 원본 ${suffix}` };
  const title = (number: number) => `${suffix} 업무 ${number}`;
  const jira = (withLink: boolean) => ({
    issues: [1, 2, 3].map(number => ({
      id: String(4100 + number), key: `${sourceKey}-${number}`,
      fields: {
        project: sourceProject, summary: title(number), status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
        created: '2020-01-01T00:00:00Z', updated: withLink ? '2020-01-03T00:00:00Z' : '2020-01-02T00:00:00Z',
        issuelinks: withLink && number === 2 ? [{
          id: '4201', type: { id: '4301', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: { id: '4101', key: `${sourceKey}-1` },
        }] : [],
      },
    })),
  });
  const staged: LegacyPackageSummary[] = [];
  const originalIssues: Issue[] = [];
  async function upload(name: string, withLink: boolean) {
    const filename = `${name}-${suffix}.json`;
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: `relation-refresh-${suffix}` });
    const response = await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify(jira(withLink))),
    });
    expect(response.status(), await response.text()).toBe(201);
    const pkg = await response.json() as LegacyPackageSummary;
    staged.push(pkg);
    return pkg;
  }

  try {
    const original = await upload('jira-before-link', false);
    const { defaultConfiguration } = await read<MigrationOptions>(request, `/api/migrations/options?packageId=${original.id}`);
    const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(project => ({ ...project, key: targetKey })) };
    const planning = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(planning.status(), await planning.text()).toBe(201);
    const initialPlan = await planning.json() as MigrationPreview;
    expect(initialPlan.canApply, JSON.stringify(initialPlan.notices)).toBe(true);
    const first = await request.post(`/api/migrations/previews/${initialPlan.id}/apply`, { data: {
      expectedVersion: initialPlan.version, acknowledgements: initialPlan.requiredAcknowledgements,
    } });
    expect(first.status(), await first.text()).toBe(201);
    const { import: { projectIds: [projectId] } } = await first.json() as MigrationApplyResult;
    originalIssues.push(...(await read<WorkspaceSnapshot>(request, '/api/workspace')).issues.filter(issue => issue.projectId === projectId));
    expect(originalIssues).toHaveLength(3);
    const [rawBlocker, rawBlocked, nativeNeighbor] = [1, 2, 3].map(number => originalIssues.find(issue => issue.title === title(number))!);
    async function setDates(issue: Issue, offset: number) {
      const response = await request.patch(`/api/issues/${issue.id}`, { data: {
        expectedVersion: issue.version, startDate: dateAt(offset), endDate: dateAt(offset + 1),
      } });
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as Issue;
    }
    const blocker = await setDates(rawBlocker, 1);
    const blocked = await setDates(rawBlocked, 4);
    const nativeEndpoint = `/api/issues/${blocked.id}/relations`;
    const local = await request.post(nativeEndpoint, { data: { otherIssueId: nativeNeighbor.id, type: 'related', direction: 'outgoing' } });
    expect(local.status(), await local.text()).toBe(201);
    const localRelation = await local.json() as IssueRelation;
    expect(localRelation.origin).toBe('teamspace');

    const followUp = await upload('jira-with-link', true);
    await page.goto(`/#/${projectId}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    const mode = settings.getByRole('combobox', { name: '이관 방식', exact: true });
    async function selectFollowUp() {
      await settings.getByLabel(`이관 패키지 ${followUp.filename}`, { exact: true }).check();
      await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
      await mode.selectOption('append');
    }
    await selectFollowUp();
    const option = settings.getByRole('checkbox', { name: '기존 Jira 업무 사이의 새 관계 추가', exact: true });
    await expect(option).not.toBeChecked();
    expect((await preview(page, settings)).canApply).toBe(false);
    expect(await read<IssueRelation[]>(request, nativeEndpoint)).toEqual([localRelation]);

    await option.check();
    await mode.selectOption('new');
    await mode.selectOption('append');
    await expect(option).toBeChecked();
    const reviewed = await preview(page, settings);
    expect(reviewed.canApply, JSON.stringify(reviewed.notices)).toBe(true);
    expect(reviewed.configuration.appendTo).toMatchObject({ projectId, refreshRelations: true });
    expect(reviewed.counts).toMatchObject({ issues: 0, issueRelations: 1, newJiraRelations: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const count = '기존 업무 사이의 새 Jira 관계 1';
    await expect(review.getByText(count, { exact: true })).toBeVisible();
    const plannedRelations = review.getByRole('region', { name: '추가할 Jira 관계', exact: true });
    await expect(plannedRelations.getByText(`${blocker.key} → ${blocked.key}`, { exact: true })).toBeVisible();
    const sourceButton = plannedRelations.getByRole('button', { name: 'Jira 관계 원본 보기', exact: true });
    await sourceButton.click();
    const originalDialog = page.getByRole('dialog', { name: 'Jira 관계 원본 기록', exact: true });
    await expect(originalDialog.getByRole('region', { name: '원본 객체 상세', exact: true })).toContainText('4201 · 관계');
    await originalDialog.getByRole('button', { name: 'Jira 관계 원본 닫기', exact: true }).click();
    await expect(sourceButton).toBeFocused();
    const downloading = page.waitForEvent('download');
    await review.getByRole('button', { name: '이관 사전 검토 JSON 내보내기', exact: true }).click();
    const downloaded = await downloading;
    const preflight = await readFile((await downloaded.path())!, 'utf8');
    expect(JSON.parse(preflight).counts).toMatchObject({ newJiraRelations: 1 });
    expect(preflight).not.toContain(blocker.key);
    await downloaded.delete();
    const bounds = await review.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    for (const code of reviewed.requiredAcknowledgements) {
      await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    }

    const applying = page.waitForResponse(response => new URL(response.url()).pathname === `/api/migrations/previews/${reviewed.id}/apply` && response.request().method() === 'POST');
    let confirmation = '';
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const result = await applying;
    expect(result.status(), await result.text()).toBe(201);
    expect(confirmation).toContain('기존 업무 사이의 새 Jira 관계 1건 추가');
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    await expect(receipt.getByText(count, { exact: true })).toBeVisible();

    const relations = await read<IssueRelation[]>(request, nativeEndpoint);
    expect(relations).toHaveLength(2);
    expect(relations).toContainEqual(localRelation);
    const imported = relations.find(relation => relation.id !== localRelation.id)!;
    expect([imported.sourceIssueId, imported.targetIssueId].sort()).toEqual([blocked.id, blocker.id].sort());
    expect(imported.origin).toBeUndefined();
    const after = await read<WorkspaceSnapshot>(request, '/api/workspace');
    expect(after.issues.filter(issue => issue.projectId === projectId)).toHaveLength(originalIssues.length);
    for (const issue of [blocker, blocked, nativeNeighbor]) expect(after.issues.find(current => current.id === issue.id)).toEqual(issue);
    expect(after.dependencies.some(edge => edge.predecessorId === blocker.id || edge.successorId === blocked.id)).toBe(false);

    await selectFollowUp();
    await option.check();
    const repeated = await preview(page, settings);
    expect(repeated.canApply).toBe(false);
    expect(repeated.counts.newJiraRelations).toBe(0);
    await expect(review.getByText('Jira 관계 원본 보관 1', { exact: true })).toBeVisible();
    await expect(review.getByRole('heading', { name: '적용할 Jira 변경이 없습니다', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();
    expect(await read<IssueRelation[]>(request, nativeEndpoint)).toEqual(relations);

    const issuePage = await context.newPage();
    try {
      await issuePage.goto(`/#/${projectId}/issues?issue=${blocked.id}`);
      const panel = issuePage.getByRole('dialog', { name: blocked.title, exact: true });
      const relationList = panel.getByRole('region', { name: '업무 관계', exact: true });
      await relationList.getByRole('button', { name: `${blocker.key} 일정 연결 검토`, exact: true }).click();
      const schedule = issuePage.getByRole('dialog', { name: '관계에서 일정 연결', exact: true });
      const direction = schedule.getByRole('combobox', { name: '일정 연결 방향', exact: true });
      await expect(direction).toHaveValue('');
      await direction.selectOption(imported.sourceIssueId === blocker.id ? 'source-first' : 'target-first');
      const writing = issuePage.waitForResponse(response => new URL(response.url()).pathname === `${nativeEndpoint}/${imported.id}/schedule-dependency` && response.request().method() === 'POST');
      await schedule.getByRole('button', { name: '업무 연결', exact: true }).click();
      const saved = await writing;
      expect(saved.status(), await saved.text()).toBe(201);
      const dependency = await saved.json() as Dependency;
      expect(dependency).toMatchObject({ predecessorId: blocker.id, successorId: blocked.id, type: 'FS' });
      await expect(relationList.getByText('일정 연결됨', { exact: true })).toBeVisible();
      await issuePage.goto(`/#/${projectId}/gantt`);
      await expect(issuePage.locator(`[data-dependency-id="${dependency.id}"]`)).toBeVisible();
    } finally { await issuePage.close(); }
  } finally {
    for (const issue of originalIssues) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});
