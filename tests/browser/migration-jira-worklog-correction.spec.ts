import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  IssueWorklogPage, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview,
  SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot,
} from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

test('360px Jira 작업 시간 수정에서 반영할 기록, 팀에서 수정한 기록, 보존 원본을 구분한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });

  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const key = `JWC${suffix}`;
  const title = `Jira 작업 시간 수정 ${suffix}`;
  const sourceUrl = `https://${suffix.toLowerCase()}.jira.example.test/company/rest/api/2/issue/1901`;
  const author = { accountId: `worker-${suffix}`, displayName: `원본 작업자 ${suffix}` };
  const initialUpdated = '2020-08-03T00:00:00Z';
  const nextUpdated = '2020-08-06T00:00:00Z';
  const teamNote = '팀에서 편집한 작업 메모';
  const original = [
    { id: '401', date: '2020-08-01', seconds: 61, note: '기존 작업 메모' },
    { id: '402', date: '2020-08-02', seconds: 73, note: '팀에서 수정하기 전 메모' },
    { id: '403', date: '2020-08-03', seconds: 91, note: '수정 시각을 확인할 기존 메모' },
  ];
  const corrected = [
    { id: '401', date: '2020-08-04', seconds: 121, note: 'Jira에서 수정한 메모' },
    { id: '402', date: '2020-08-05', seconds: 131, note: '팀 수정을 덮으면 안 되는 메모' },
    { id: '403', date: '2020-08-06', seconds: 151, note: '수정 시각 없이 받은 원본 메모' },
  ];
  const staged: LegacyPackageSummary[] = [];
  async function stage(next: boolean) {
    const filename = `jira-worklog-${next ? 'correction' : 'original'}-${suffix}.zip`;
    const worklogs = (next ? corrected : original).map(row => ({
      id: row.id, self: `${sourceUrl}/worklog/${row.id}`, issueId: '1901', author,
      started: `${row.date}T09:30:00.000+0900`, timeSpentSeconds: row.seconds, comment: row.note,
      ...(!next ? { updated: initialUpdated } : row.id !== '403' ? { updated: nextUpdated } : {}),
    }));
    const pages = {
      'issue.json': { issues: [{ id: '1901', key: `${key}-1`, self: sourceUrl, fields: {
        project: { id: '101', key, name: `Jira 시간 견본 ${suffix}` }, summary: title,
        status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
        created: '2020-08-01T00:00:00Z', updated: next ? nextUpdated : initialUpdated,
      } }] },
      'worklog.json': { startAt: 0, total: worklogs.length, worklogs },
    };
    const response = await request.post(`/api/legacy-import/packages?${new URLSearchParams({
      filename, product: 'jira', instanceKey: `jira-worklog-correction-${suffix}`,
    })}`, { headers: { 'Content-Type': 'application/octet-stream' }, data: zip(Object.entries(pages).map(([path, body]) => ({
      path, bytes: Buffer.from(JSON.stringify(body)),
    }))) });
    expect(response.status(), await response.text()).toBe(201);
    const result = await response.json() as LegacyPackageSummary;
    staged.push(result);
    return result;
  }

  const workspace = async () => {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as WorkspaceSnapshot;
  };
  try {
    const seed = await workspace();
    const [settingsProject] = seed.projects;
    const [mappedAuthor] = seed.users;
    const initial = await stage(false);
    const optionsResponse = await request.get(`/api/migrations/options?packageId=${initial.id}`);
    expect(optionsResponse.ok(), await optionsResponse.text()).toBe(true);
    const options = await optionsResponse.json() as MigrationOptions;
    const identity = options.identities.find(item => item.label === author.displayName);
    assert.ok(identity);
    const initialResponse = await request.post('/api/migrations/preview', { data: { configuration: {
      ...options.defaultConfiguration, users: { ...options.defaultConfiguration.users, [identity.id]: mappedAuthor.id },
    } } });
    expect(initialResponse.status(), await initialResponse.text()).toBe(201);
    const initialPlan = await initialResponse.json() as MigrationPreview;
    expect(initialPlan.canApply, JSON.stringify(initialPlan.notices)).toBe(true);
    expect(initialPlan.counts.worklogs).toBe(3);
    const created = await request.post(`/api/migrations/previews/${initialPlan.id}/apply`, { data: {
      expectedVersion: initialPlan.version, acknowledgements: initialPlan.requiredAcknowledgements,
    } });
    expect(created.status(), await created.text()).toBe(201);
    const { import: initialReceipt } = await created.json() as MigrationApplyResult;
    const issue = (await workspace()).issues.find(item => initialReceipt.projectIds.includes(item.projectId) && item.title === title);
    assert.ok(issue);
    const logPath = `/api/issues/${issue.id}/worklogs`;
    const readWorklogs = async () => {
      const response = await request.get(logPath);
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as IssueWorklogPage;
    };
    const initialLogs = await readWorklogs();
    const local = initialLogs.entries.find(entry => entry.note === original[1].note);
    assert.ok(local);
    const edited = await request.patch(`${logPath}/${local.id}`, { headers: { 'X-Actor-Id': mappedAuthor.id }, data: {
      expectedVersion: local.version, note: teamNote,
    } });
    expect(edited.ok(), await edited.text()).toBe(true);
    const before = await readWorklogs();
    expect(before.totalMinutes * 60).toBe(225);

    const next = await stage(true);
    await page.goto(`/#/${settingsProject.id}/settings?section=migration`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await settings.getByLabel(`이관 패키지 ${next.filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await settings.getByLabel('이관 방식', { exact: true }).selectOption('append');
    await settings.getByText('사용자 매핑', { exact: true }).click();
    await settings.getByLabel(`사용자 매핑 ${author.displayName}`, { exact: true }).selectOption(mappedAuthor.id);
    const corrections = settings.getByRole('checkbox', { name: '기존 Jira 작업 시간 기록의 수정분 검토', exact: true });
    const appendHistory = settings.getByRole('checkbox', { name: '기존 Jira 업무에 댓글과 작업 시간 기록 추가', exact: true });
    const preview = async () => {
      const pending = page.waitForResponse(response => response.url().endsWith('/api/migrations/preview') && response.request().method() === 'POST');
      await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
      const response = await pending;
      expect(response.status(), await response.text()).toBe(201);
      return await response.json() as MigrationPreview;
    };
    await expect(corrections).not.toBeChecked();
    const disabled = await preview();
    expect(disabled.canApply).toBe(false);
    expect(disabled.jiraWorklogReview).toBeUndefined();

    await corrections.check();
    await expect(appendHistory).not.toBeChecked();
    const plan = await preview();
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendTo).toMatchObject({ projectId: issue.projectId, refreshWorklogs: true });
    expect(plan.configuration.appendTo?.refreshHistory).toBeUndefined();
    expect(plan.counts).toMatchObject({ updatedJiraWorklogs: 1, conflictingJiraWorklogs: 1, archivedJiraWorklogCorrections: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const outcomes = review.getByRole('region', { name: 'Jira 작업 시간 수정 검토', exact: true });
    const safeRow = outcomes.getByRole('article', { name: 'Jira 작업 시간 worklog:401', exact: true });
    await expect(safeRow.getByText('수정 반영', { exact: true })).toBeVisible();
    await expect(safeRow.getByRole('listitem', { name: '현재 기록' })).toContainText('2020-08-01');
    await expect(safeRow.getByRole('listitem', { name: '현재 기록' })).toContainText('61초');
    await expect(safeRow.getByRole('listitem', { name: '현재 기록' })).toContainText(original[0].note);
    await expect(safeRow.getByRole('listitem', { name: 'Jira 수정본' })).toContainText('2020-08-04');
    await expect(safeRow.getByRole('listitem', { name: 'Jira 수정본' })).toContainText('121초');
    await expect(safeRow.getByRole('listitem', { name: 'Jira 수정본' })).toContainText(corrected[0].note);
    const conflict = outcomes.getByRole('article', { name: 'Jira 작업 시간 worklog:402', exact: true });
    await expect(conflict.getByText('팀에서 수정한 기록 유지', { exact: true })).toBeVisible();
    await expect(conflict.getByRole('listitem', { name: '현재 기록' })).toContainText(teamNote);
    const archived = outcomes.getByRole('article', { name: 'Jira 작업 시간 worklog:403', exact: true });
    await expect(archived.getByText('원본에만 보관', { exact: true })).toBeVisible();
    await expect(archived).toContainText('Jira 수정 시각');

    const opener = archived.getByRole('button', { name: 'Jira 작업 시간 원본 보기', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('dialog', { name: 'Jira 작업 시간 수정 원본 기록', exact: true });
    await expect(detail).toContainText(next.filename);
    await expect(detail.getByLabel('원본 본문', { exact: true })).toHaveText(corrected[2].note);
    await expect(detail).toContainText('worklog:403');
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await readWorklogs()).toEqual(before);

    for (const code of plan.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`) && response.request().method() === 'POST');
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Jira 작업 시간 수정 1건 반영');
      await dialog.accept();
    });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applying;
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    const receiptDetail = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receiptDetail.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    for (const label of ['반영한 Jira 작업 시간 수정 1', '팀 변경을 유지한 Jira 작업 시간 1', '원본에만 보관한 Jira 작업 시간 수정 1']) {
      await expect(receiptDetail.getByText(label, { exact: true })).toBeVisible();
    }

    const after = await readWorklogs();
    const originalSafe = before.entries.find(entry => entry.note === original[0].note);
    assert.ok(originalSafe);
    expect(after.totalEntries).toBe(3);
    expect(after.totalMinutes * 60).toBe(285);
    expect(after.entries.find(entry => entry.id === originalSafe.id)).toMatchObject({
      durationSeconds: 121, workDate: corrected[0].date, note: corrected[0].note, version: originalSafe.version + 1,
    });
    expect(after.entries.filter(entry => entry.id !== originalSafe.id)).toEqual(before.entries.filter(entry => entry.id !== originalSafe.id));
    const archiveResponse = await request.get(`/api/source-imports/${receipt.id}/records?kind=history`);
    expect(archiveResponse.ok(), await archiveResponse.text()).toBe(true);
    const preserved = (await archiveResponse.json() as SourceRecordPage).records.find(record => record.record.sourceId === 'worklog:403');
    assert.ok(preserved);
    const preservedResponse = await request.get(`/api/source-imports/${receipt.id}/records/${preserved.id}`);
    expect(preservedResponse.ok(), await preservedResponse.text()).toBe(true);
    const preservedArchive = await preservedResponse.json() as SourceRecordArchive;
    expect(preservedArchive.record.text).toBe(corrected[2].note);
    expect(preservedArchive.jiraWorklogCorrection).toBeUndefined();

    await expect(settings.getByRole('button', { name: '이관 원본·영수증 새로고침', exact: true })).toBeEnabled();
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const issueDetail = page.getByRole('dialog', { name: title, exact: true });
    await issueDetail.getByRole('button', { name: '작업 시간', exact: true }).click();
    const worklogs = issueDetail.getByRole('region', { name: '업무 작업 기록', exact: true });
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('4분 45초');
    await expect(worklogs.getByLabel('작업 기록 목록', { exact: true })).toContainText(corrected[0].note);
  } finally {
    for (const item of staged) await request.delete(`/api/legacy-import/packages/${item.id}?expectedVersion=${item.version}`);
  }
});
