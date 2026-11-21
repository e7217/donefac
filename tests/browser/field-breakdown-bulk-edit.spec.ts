import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type { Issue, IssueBulkEditPreview, IssueBulkEditResult, IssueFieldBreakdown, IssueFieldBreakdownPage, Project, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

function postAt(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

const sortIds = (rows: { id: string }[]) => rows.map(row => row.id).sort();

async function fixture(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `집계 일괄 ${suffix}`;
  const project = await json<Project>(await request.post('/api/projects', { data: { key: `FB${suffix}`, name: prefix } }), 201);
  const readWorkspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { users: [, assignee] } = await readWorkspace();
  const issues: Issue[] = [];
  const filters = { query: prefix, status: 'all', assigneeId: 'all', type: 'all' };
  let view = await json<SavedView>(await request.post('/api/views', { data: { projectId: project.id, name: prefix, layout: 'board', filters } }), 201);
  return {
    project, prefix, assignee,
    reportPath: `/api/projects/${project.id}/field-breakdown`, bulkPath: `/api/projects/${project.id}/issues/bulk`,
    view: () => view,
    async renameView() {
      view = await json<SavedView>(await request.patch(`/api/views/${view.id}`, { data: { expectedVersion: view.version, name: `${prefix} 다시 저장` } }));
    },
    async issue(title: string, data: { assigneeId?: string; status?: string; labels?: string[] } = {}) {
      const issue = await json<Issue>(await request.post('/api/issues', { data: { projectId: project.id, status: 'todo', title, ...data } }), 201);
      issues.push(issue);
      return issue;
    },
    async savedIssues() {
      return (await readWorkspace()).issues.filter(issue => issue.projectId === project.id);
    },
    async close() {
      await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
      for (const issue of issues) {
        const archived = await request.delete(`/api/issues/${issue.id}`);
        if (archived.ok()) await request.delete(`/api/trash/${(await archived.json() as { trashEntryId: string }).trashEntryId}`);
      }
    },
  };
}

async function openReport(page: Page, f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const scope = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: f.view().id };
  const urlScope = new URLSearchParams({ groupBy: scope.groupBy, comparisonBy: scope.comparisonBy, savedView: scope.savedViewId });
  await page.setViewportSize({ width: 360, height: 820 });
  const reading = postAt(page, f.reportPath);
  await page.goto(`/#/${f.project.id}/reports/fields?${urlScope}`);
  const report = await json<IssueFieldBreakdown>(await reading);
  const unassigned = report.comparison?.columns.find(column => column.label === '미지정');
  expect(unassigned).toBeTruthy();
  const row = report.groups.find(bucket => report.comparison?.counts[bucket.id]?.[unassigned!.id] === count);
  expect(row).toBeTruthy();
  const matrix = page.getByRole('table', { name: '필드 교차 집계 표', exact: true });
  const cell = (total: number) => matrix.getByRole('button', { name: `${row!.label} × 미지정 업무 보기 · ${total}개`, exact: true });
  const panel = page.getByRole('region', { name: '필드 집계 그룹 업무', exact: true });
  const loading = postAt(page, `${f.reportPath}/issues`);
  await cell(count).click();
  const firstPage = await json<IssueFieldBreakdownPage>(await loading);
  await expect(panel.getByRole('heading', { name: `${row!.label} × 미지정`, exact: true })).toBeVisible();
  const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
  return {
    matrix, cell, panel, editor, firstPage, row: row!, unassigned: unassigned!, scope, report,
    choose: (issue: { key: string }) => panel.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }),
    async edit() {
      await panel.getByRole('button', { name: '집계 업무 일괄 편집', exact: true }).click();
      await expect(editor).toBeVisible();
    },
  };
}

test('360px 집계 교차표의 두 페이지에서 선택하고 적용 응답을 잃어도 같은 결과를 확인한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  const f = await fixture(request);
  try {
    const firstLabel = '첫 페이지의 근거';
    const lastLabel = '둘째 페이지의 근거';
    const matching: Issue[] = [];
    for (let index = 1; index <= 51; index++) {
      const labels = index === 51 ? [lastLabel, '유지'] : [];
      matching.push(await f.issue(`${f.prefix} 업무 ${index}`, { labels }));
    }
    const otherColumn = await f.issue(`${f.prefix} 다른 열`, { assigneeId: f.assignee.id });
    const otherRow = await f.issue(`${f.prefix} 다른 행`, { status: 'review' });
    const outside = await f.issue('저장 보기 밖의 업무');
    let first = matching[0];
    await page.route(url => url.pathname === f.reportPath, async route => {
      // The initial workspace request has already returned the earlier issue version.
      first = await json<Issue>(await request.patch(`/api/issues/${first.id}`, {
        data: { expectedVersion: first.version, labels: [firstLabel, '유지'] },
      }));
      await route.continue();
    }, { times: 1 });
    const report = await openReport(page, f, 51);
    const before = await f.savedIssues();
    expect(first.version).toBe(matching[0].version + 1);
    expect(report.firstPage.total).toBe(51);
    expect(report.firstPage.issues).toHaveLength(50);
    await report.edit();
    const last = matching[50];
    await report.choose(first).check();
    const drillPath = `${f.reportPath}/issues`;
    async function turn(direction: '이전' | '다음', offset: number) {
      const pending = postAt(page, drillPath);
      await report.panel.getByRole('button', { name: `필드 집계 업무 ${direction} 페이지`, exact: true }).click();
      const response = await pending;
      expect(response.request().postDataJSON()).toMatchObject({ includeEditTargets: true, offset });
      return json<IssueFieldBreakdownPage>(response);
    }
    const secondPage = await turn('다음', 50);
    expect(secondPage.issues.map(issue => issue.id)).toEqual([last.id]);
    expect(secondPage.editTargets).toEqual([{ id: last.id, version: last.version, labels: last.labels }]);
    await expect(report.choose(first)).toHaveCount(0);
    await expect(report.choose(otherColumn)).toHaveCount(0);
    await report.panel.getByRole('checkbox', { name: '이 페이지의 업무 전체 선택', exact: true }).check();
    await expect(report.choose(last)).toBeChecked();
    await expect(report.editor.getByRole('status').filter({ hasText: '2개 선택 · 최대 100개' })).toBeVisible();
    await turn('이전', 0);
    await expect(report.choose(first)).toBeChecked();
    await turn('다음', 50);
    await expect(report.choose(last)).toBeChecked();
    await expect(report.editor.getByRole('status').filter({ hasText: '2개 선택 · 최대 100개' })).toBeVisible();

    const declined = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.message()).toContain('작성 중인 일괄 편집을 버릴까요?');
      await dialog.dismiss();
    });
    await report.matrix.getByRole('button', { name: `${report.row.label} × ${f.assignee.name} 업무 보기 · 1개`, exact: true }).click();
    await declined;
    await expect(report.choose(last)).toBeChecked();

    await report.editor.getByRole('combobox', { name: '일괄 변경 담당자', exact: true }).selectOption({ label: f.assignee.name });
    await report.editor.getByText('제거할 라벨 선택', { exact: true }).click();
    await report.editor.getByRole('checkbox', { name: `${firstLabel} 라벨 제거`, exact: true }).check();
    await expect(report.editor.getByRole('checkbox', { name: `${lastLabel} 라벨 제거`, exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const proposed = postAt(page, `${f.bulkPath}-preview`);
    await report.editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const previewResponse = await proposed;
    expect(previewResponse.request().postDataJSON()).toMatchObject({
      fieldBreakdown: { ...report.scope, revision: report.report.revision, bucketId: report.row.id, comparisonBucketId: report.unassigned.id },
      changes: { assigneeId: f.assignee.id, removeLabels: [firstLabel] },
    });
    const targets = previewResponse.request().postDataJSON().issues as { id: string; expectedVersion: number }[];
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map(target => `${target.id}:${target.expectedVersion}`))).toEqual(new Set([`${first.id}:${first.version}`, `${last.id}:${last.version}`]));
    const preview = await json<IssueBulkEditPreview>(previewResponse);
    expect(sortIds(preview.rows)).toEqual(sortIds([first, last]));
    expect(preview.rows.find(row => row.id === first.id)?.after?.labels).toEqual(['유지']);
    expect(preview.rows.find(row => row.id === last.id)?.after?.labels).toEqual(last.labels);
    expect(await f.savedIssues()).toEqual(before);

    const applyPath = `${f.bulkPath}-apply`;
    const attempted: unknown[] = [];
    let actual: IssueBulkEditResult | undefined;
    await page.route(url => url.pathname === applyPath, async route => {
      attempted.push(route.request().postDataJSON());
      const server = await route.fetch();
      if (attempted.length === 1) {
        expect(server.status(), await server.text()).toBe(200);
        actual = await server.json() as IssueBulkEditResult;
        await route.fulfill({ status: 502, json: { error: '합성 적용 응답 유실' } });
      } else await route.fulfill({ response: server });
    });
    const lost = postAt(page, applyPath);
    await report.editor.getByRole('button', { name: '일괄 적용', exact: true }).click();
    expect((await lost).status()).toBe(502);
    await expect(report.editor.getByRole('alert')).toContainText('적용 결과를 확인하지 못했습니다');
    const retry = postAt(page, applyPath);
    await report.editor.getByRole('button', { name: '적용 결과 다시 확인', exact: true }).click();
    expect(await json<IssueBulkEditResult>(await retry)).toEqual(actual);
    expect(attempted).toEqual([{ previewId: preview.previewId }, { previewId: preview.previewId }]);
    await expect(report.cell(49)).toBeVisible();
    await expect(page).toHaveURL(url => new URLSearchParams(url.hash.split('?')[1]).get('savedView') === f.view().id);
    const after = await f.savedIssues();
    for (const issue of [first, last]) expect(after.find(current => current.id === issue.id)).toMatchObject({
      assigneeId: f.assignee.id, version: issue.version + 1, labels: issue.id === first.id ? ['유지'] : issue.labels,
    });
    for (const issue of [matching[1], otherColumn, otherRow, outside]) expect(after.find(current => current.id === issue.id)).toEqual(issue);
  } finally { await f.close(); }
});

test('저장 보기가 바뀌면 집계 일괄 적용을 멈추고 편집값을 유지한 채 다시 선택한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    const first = await f.issue(`${f.prefix} 첫 번째 업무`);
    const second = await f.issue(`${f.prefix} 두 번째 업무`);
    const before = await f.savedIssues();
    const report = await openReport(page, f, 2);
    await report.edit();
    await report.choose(first).check();
    const priority = report.editor.getByRole('combobox', { name: '일괄 변경 우선순위', exact: true });
    await priority.selectOption('high');
    const previewPath = `${f.bulkPath}-preview`;
    const applyPath = `${f.bulkPath}-apply`;
    const previewButton = report.editor.getByRole('button', { name: '변경 미리보기', exact: true });
    const applyButton = report.editor.getByRole('button', { name: '일괄 적용', exact: true });
    const creating = postAt(page, previewPath);
    await previewButton.click();
    const stale = await json<IssueBulkEditPreview>(await creating);
    expect(stale.previewId).toBeTruthy();
    await f.renameView();
    const attempting = postAt(page, applyPath);
    await applyButton.click();
    expect(await json<{ details: { reason: string } }>(await attempting, 409)).toMatchObject({
      details: { reason: 'field_breakdown_stale' },
    });
    await expect(report.editor.getByRole('alert')).toBeVisible();
    await expect(priority).toHaveValue('high');
    await expect(applyButton).toHaveCount(0);
    expect(await f.savedIssues()).toEqual(before);

    const reloading = postAt(page, f.reportPath);
    await report.editor.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    const current = await json<IssueFieldBreakdown>(await reloading);
    expect(current.revision).not.toBe(report.report.revision);
    expect(current.savedView).toMatchObject({ id: f.view().id, version: f.view().version });
    await expect(report.choose(first)).not.toBeChecked();
    await expect(priority).toHaveValue('high');
    await expect(previewButton).toBeDisabled();
    await report.choose(second).check();
    const refreshed = postAt(page, previewPath);
    await previewButton.click();
    const response = await refreshed;
    expect(response.request().postDataJSON()).toMatchObject({
      issues: [{ id: second.id, expectedVersion: second.version }], changes: { priority: 'high' },
      fieldBreakdown: { revision: current.revision, savedViewId: f.view().id },
    });
    const latest = await json<IssueBulkEditPreview>(response);
    expect(latest.previewId).not.toBe(stale.previewId);
    expect(sortIds(latest.rows)).toEqual([second.id]);
    const applying = postAt(page, applyPath);
    await applyButton.click();
    const saved = await json<IssueBulkEditResult>(await applying);
    expect(saved.updated).toEqual([{ id: second.id, key: second.key, version: second.version + 1 }]);
    const after = await f.savedIssues();
    expect(after.find(issue => issue.id === first.id)).toEqual(first);
    expect(after.find(issue => issue.id === second.id)?.priority).toBe('high');
  } finally { await f.close(); }
});
