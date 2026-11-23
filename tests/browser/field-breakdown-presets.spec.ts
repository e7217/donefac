import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type { CustomFieldDefinition, CustomFieldValue, Issue, IssueBulkEditPreview, IssueBulkEditResult, IssueFieldBreakdown,
  IssueFieldBreakdownPage, ProjectIssueSchema, SavedFieldBreakdown, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

function responseAt(page: Page, method: string, pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
}

function route(page: Page) {
  const [path, query] = new URL(page.url()).hash.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

function report(page: Page) {
  const form = page.getByRole('form', { name: '필드 집계 조회 조건', exact: true });
  const presets = page.getByRole('region', { name: '저장한 필드 집계', exact: true });
  return {
    main: page.getByRole('region', { name: '업무 필드 집계', exact: true }),
    field: form.getByRole('combobox', { name: '집계 기준', exact: true }),
    comparison: form.getByRole('combobox', { name: '비교 기준', exact: true }),
    view: form.getByRole('combobox', { name: '필드 집계 저장된 보기', exact: true }),
    submit: form.getByRole('button', { name: '필드 집계 조회', exact: true }),
    matrix: page.getByRole('table', { name: '필드 교차 집계 표', exact: true }),
    drilldown: page.getByRole('region', { name: '필드 집계 그룹 업무', exact: true }),
    presets,
    savePreset: presets.getByRole('button', { name: '현재 집계 저장', exact: true }),
    editName: presets.getByRole('textbox', { name: '집계 이름', exact: true }),
    saveEditor: presets.getByRole('button', { name: '저장', exact: true }),
    openPreset: (name: string) => presets.getByRole('button', { name: `집계 열기: ${name}`, exact: true }),
    editPreset: (name: string) => presets.getByRole('button', { name: `집계 편집: ${name}`, exact: true }),
    deletePreset: (name: string) => presets.getByRole('button', { name: `집계 삭제: ${name}`, exact: true }),
  };
}

async function fixture(request: APIRequestContext) {
  const { projects: [project], users: [member, peer] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `저장 집계 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  const reportPath = `#/${project.id}/reports/fields`;
  const reportApi = `/api/projects/${project.id}/field-breakdown`;
  const presetApi = `${reportApi}-presets`;
  return {
    prefix, project, member, peer, reportPath, reportApi, presetApi,
    async issue(suffix: string, assigneeId: string, customFields?: Record<string, CustomFieldValue>) {
      const created = await json<Issue>(await request.post('/api/issues', { data: {
        projectId: project.id, title: `${prefix} ${suffix}`, status: 'in_progress', assigneeId, customFields,
      } }), 201);
      issues.push(created);
      return created;
    },
    async view(suffix: string, assigneeId = member.id) {
      return json<SavedView>(await request.post('/api/views', { data: {
        projectId: project.id, name: `${prefix} ${suffix}`, layout: 'board',
        filters: { query: prefix, status: 'all', assigneeId, type: 'all' },
      } }), 201);
    },
    async removeView(view: SavedView) {
      await json(await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`));
    },
    async close() {
      const presets = await json<SavedFieldBreakdown[]>(await request.get(presetApi));
      for (const preset of presets.filter(value => value.name.startsWith(prefix))) {
        await json(await request.delete(`${presetApi}/${preset.id}?expectedVersion=${preset.version}`));
      }
      const views = await json<SavedView[]>(await request.get(`/api/views?projectId=${encodeURIComponent(project.id)}`));
      for (const view of views.filter(value => value.name.startsWith(prefix))) {
        await json(await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`));
      }
      for (const issue of issues) {
        const removed = await request.delete(`/api/issues/${issue.id}`);
        if (removed.ok()) {
          const { trashEntryId } = await removed.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
    },
  };
}

test('360px에서 프로젝트 필드 집계를 이름으로 저장한 뒤 최신 업무로 다시 열고 셀의 티켓을 확인한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    await f.issue('첫 담당자의 업무', f.member.id);
    const peerIssue = await f.issue('조회 범위에 추가할 업무', f.peer.id);
    const view = await f.view('팀 보드');
    const name = `${f.prefix} 담당자별 상태`;
    const savedQuery = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: view.id };
    const location = { path: f.reportPath, query: { groupBy: 'status', comparisonBy: 'assignee', savedView: view.id } };
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${f.reportPath}`);
    const ui = report(page);
    await expect(ui.savePreset).toBeDisabled();
    await ui.field.selectOption('status');
    await ui.comparison.selectOption('assignee');
    await ui.view.selectOption(view.id);
    const initial = responseAt(page, 'POST', f.reportApi);
    await ui.submit.click();
    expect((await json<IssueFieldBreakdown>(await initial)).totalIssues).toBe(1);
    await expect.poll(() => route(page)).toEqual(location);

    await ui.savePreset.click();
    await expect(ui.editName).toBeFocused();
    await ui.editName.fill(name);
    await ui.comparison.selectOption('type');
    const alternate = responseAt(page, 'POST', f.reportApi);
    await ui.submit.click();
    expect((await json<IssueFieldBreakdown>(await alternate)).comparison?.by).toBe('type');
    await expect.poll(() => route(page)).toEqual({ ...location, query: { ...location.query, comparisonBy: 'type' } });
    await expect(ui.editName).toHaveValue(name);
    const saving = responseAt(page, 'POST', f.presetApi);
    await ui.saveEditor.click();
    const savedResponse = await saving;
    expect(savedResponse.request().postDataJSON()).toEqual({ name, query: savedQuery });
    const saved = await json<SavedFieldBreakdown>(savedResponse, 201);
    expect(saved.query).toEqual(savedQuery);
    await expect(ui.openPreset(name)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const openingOriginal = responseAt(page, 'POST', f.reportApi);
    await ui.openPreset(name).click();
    expect((await json<IssueFieldBreakdown>(await openingOriginal)).comparison?.by).toBe('assignee');
    await expect.poll(() => route(page)).toEqual(location);

    await ui.comparison.selectOption('priority');
    await expect(ui.savePreset).toBeDisabled();
    const stay = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.message()).toContain('조회하지 않은 필드 집계 조건');
      await dialog.dismiss();
    });
    await ui.openPreset(name).click();
    await stay;
    await expect(ui.comparison).toHaveValue('priority');
    await expect(ui.matrix.getByRole('columnheader', { name: f.member.name, exact: true })).toBeVisible();
    await expect.poll(() => route(page)).toEqual(location);
    await ui.comparison.selectOption('assignee');

    await json<SavedView>(await request.patch(`/api/views/${view.id}`, { data: {
      expectedVersion: view.version, filters: { ...view.filters, assigneeId: 'all' },
    } }));
    await page.goto('about:blank');
    await page.goto(`/${f.reportPath}`);
    const reopening = responseAt(page, 'POST', f.reportApi);
    await ui.openPreset(name).click();
    const openedResponse = await reopening;
    expect(openedResponse.request().postDataJSON()).toEqual(savedQuery);
    const current = await json<IssueFieldBreakdown>(openedResponse);
    expect(current.totalIssues).toBe(2);
    expect(current.savedView?.version).toBe(view.version + 1);
    await expect.poll(() => route(page)).toEqual(location);
    await expect(ui.comparison).toHaveValue('assignee');
    await expect(ui.view).toHaveValue(view.id);

    const row = current.groups.find(bucket => bucket.count === 2);
    expect(row).toBeTruthy();
    const cell = ui.matrix.getByRole('button', { name: `${row!.label} × ${f.peer.name} 업무 보기 · 1개`, exact: true });
    const drilling = responseAt(page, 'POST', `${f.reportApi}/issues`);
    await cell.click();
    expect((await json<IssueFieldBreakdownPage>(await drilling)).issues.map(issue => issue.id)).toEqual([peerIssue.id]);
    await ui.drilldown.getByRole('button', { name: `${peerIssue.key} ${peerIssue.title}`, exact: true }).click();
    const ticket = page.getByRole('dialog', { name: peerIssue.title, exact: true });
    await expect(ticket).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ path: location.path, query: { ...location.query, issue: peerIssue.id } });
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect.poll(() => route(page)).toEqual(location);
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
  } finally { await f.close(); }
});

test('삭제된 보기의 집계 이름을 유지하고 동시 변경을 확인한 뒤 새 조회 조건으로 고친다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    await f.issue('교체한 보기의 업무', f.peer.id);
    const deleted = await f.view('삭제할 보기');
    const replacement = await f.view('교체할 보기', f.peer.id);
    const original = `${f.prefix} 원래 집계`;
    const renamed = `${f.prefix} 복구한 집계`;
    const axes = { groupBy: 'status', comparisonBy: 'assignee' };
    const preset = await json<SavedFieldBreakdown>(await request.post(f.presetApi, { data: {
      name: original, query: { ...axes, savedViewId: deleted.id },
    } }), 201);
    const presetPath = `${f.presetApi}/${preset.id}`;
    await f.removeView(deleted);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${f.reportPath}`);
    const ui = report(page);
    const missing = responseAt(page, 'POST', f.reportApi);
    await ui.openPreset(original).click();
    await json(await missing, 404);
    await expect(ui.main.getByRole('alert').filter({ hasText: '조회 범위나 필드를 다시 선택해 주세요' })).toBeVisible();
    await expect(ui.openPreset(original)).toBeVisible();
    await expect(ui.view).toHaveValue(deleted.id);
    await expect(ui.matrix).toHaveCount(0);
    await expect.poll(() => route(page)).toEqual({ path: f.reportPath, query: { ...axes, savedView: deleted.id } });

    await ui.view.selectOption(replacement.id);
    const reviewed = responseAt(page, 'POST', f.reportApi);
    await ui.submit.click();
    expect((await json<IssueFieldBreakdown>(await reviewed)).totalIssues).toBe(1);
    await ui.editPreset(original).click();
    await ui.editName.fill(renamed);
    const replace = ui.presets.getByRole('checkbox', { name: '현재 조회 조건으로 바꾸기', exact: true });
    await replace.check();
    await ui.comparison.selectOption('type');
    const alternate = responseAt(page, 'POST', f.reportApi);
    await ui.submit.click();
    expect((await json<IssueFieldBreakdown>(await alternate)).comparison?.by).toBe('type');
    await expect.poll(() => route(page)).toEqual({ path: f.reportPath, query: { groupBy: 'status', comparisonBy: 'type', savedView: replacement.id } });
    await expect(ui.editName).toHaveValue(renamed);
    await expect(replace).toBeChecked();
    const peerEdit = await json<SavedFieldBreakdown>(await request.patch(presetPath, { headers: { 'X-Actor-Id': f.peer.id }, data: {
      name: `${f.prefix} 다른 팀원의 이름`, expectedVersion: preset.version,
    } }));
    const conflict = responseAt(page, 'PATCH', presetPath);
    await ui.saveEditor.click();
    await json(await conflict, 409);
    await expect(ui.editName).toHaveValue(renamed);
    await expect(replace).toBeChecked();
    await expect(ui.saveEditor).toBeDisabled();
    await ui.presets.getByRole('button', { name: '최신 버전으로 다시 편집', exact: true }).click();
    await expect(ui.editName).toHaveValue(renamed);
    await expect(replace).toBeChecked();
    const changing = responseAt(page, 'PATCH', presetPath);
    await ui.saveEditor.click();
    const changedResponse = await changing;
    expect(changedResponse.request().postDataJSON()).toEqual({
      name: renamed, query: { ...axes, savedViewId: replacement.id }, expectedVersion: peerEdit.version,
    });
    const repaired = await json<SavedFieldBreakdown>(changedResponse);
    expect(repaired).toMatchObject({ id: preset.id, version: peerEdit.version + 1, query: { ...axes, savedViewId: replacement.id } });
    await expect(ui.presets.getByRole('listitem').filter({ hasText: renamed })).toContainText(replacement.name);

    const confirmation = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.message()).toContain(renamed);
      await dialog.accept();
    });
    const deleting = responseAt(page, 'DELETE', presetPath);
    await ui.deletePreset(renamed).click();
    await confirmation;
    const deletedResponse = await deleting;
    expect(new URL(deletedResponse.url()).searchParams.get('expectedVersion')).toBe(String(repaired.version));
    await json(deletedResponse);
    await expect(ui.openPreset(renamed)).toHaveCount(0);
    await expect(ui.presets.getByRole('button', { name: '저장한 필드 집계 새로고침', exact: true })).toBeFocused();
  } finally { await f.close(); }
});

test('360px에서 두 사용자 정의 필드의 교차표를 공유하고 해당 셀의 업무만 변경한다', async ({ page, context, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const schemaPath = `/api/projects/${f.project.id}/issue-schema`;
  const original = await json<ProjectIssueSchema>(await request.get(schemaPath));
  const suffix = randomUUID().slice(0, 8);
  const tags = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`, name: `${prefix} ${String(index + 1).padStart(2, '0')}`, archived: false,
  }));
  const field = (id: string, name: string, options: CustomFieldDefinition['options']): CustomFieldDefinition => ({
    id, name, options, kind: 'multi_select', description: '', required: false, issueTypes: [], archived: false,
  });
  const rows = field(`report-rows-${suffix}`, '작업 범위', tags('stage', 26));
  const columns = field(`report-cols-${suffix}`, '검토 기준', tags('review', 11));
  await json<ProjectIssueSchema>(await request.patch(schemaPath, { data: {
    ...original, expectedVersion: original.version, fields: [...original.fields, rows, columns],
  } }));
  try {
    const targetFields = { [rows.id]: rows.options.map(option => option.id), [columns.id]: columns.options.map(option => option.id) };
    const target = await f.issue('셀에 있는 업무', f.member.id, targetFields);
    const other = await f.issue('다른 셀 업무', f.member.id, { [rows.id]: [rows.options[0].id], [columns.id]: [columns.options[0].id] });
    const outside = await f.issue('보기 밖에서 같은 값을 가진 업무', f.peer.id, targetFields);
    const view = await f.view('비교 대상 보기');
    const query = { fieldId: rows.id, comparisonFieldId: columns.id, savedViewId: view.id };
    const hashQuery = { fieldId: rows.id, comparisonFieldId: columns.id, savedView: view.id };
    const location = { path: f.reportPath, query: hashQuery };
    const presetName = `${f.prefix} 사용자 정의 비교`;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${f.reportPath}`);
    const ui = report(page);
    await ui.field.selectOption('custom');
    await page.getByLabel('집계할 사용자 정의 필드', { exact: true }).selectOption(rows.id);
    await expect(ui.comparison.locator(`option[value="custom:${rows.id}"]`)).toHaveCount(0);
    await ui.comparison.selectOption(`custom:${columns.id}`);
    await ui.view.selectOption(view.id);
    const summarized = responseAt(page, 'POST', f.reportApi);
    await ui.submit.click();
    const response = await summarized;
    expect(response.request().postDataJSON()).toEqual(query);
    const summary = await json<IssueFieldBreakdown>(response);
    expect(summary.comparison?.field).toMatchObject({ id: columns.id, name: columns.name, kind: 'multi_select' });
    expect(summary).toMatchObject({ totalIssues: 2, populatedIssues: 2 });
    expect(summary.comparison?.columns).toHaveLength(11);
    await expect.poll(() => route(page)).toEqual(location);
    await expect(ui.main.getByRole('heading', { name: '작업 범위 × 검토 기준', exact: true })).toBeVisible();
    await expect(ui.main.getByText('여러 선택 필드는 값을 선택한 만큼', { exact: false })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await ui.savePreset.click();
    await ui.editName.fill(presetName);
    const saving = responseAt(page, 'POST', f.presetApi);
    await ui.saveEditor.click();
    expect((await json<SavedFieldBreakdown>(await saving, 201)).query).toEqual(query);
    await expect(ui.openPreset(presetName)).toBeVisible();

    const copy = ui.main.getByRole('button', { name: '필드 집계 링크 복사', exact: true });
    await copy.click();
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await expect.poll(clipboard).toBe(page.url());
    const sharedUrl = await clipboard();

    const row = summary.groups.find(bucket => bucket.label === 'stage 26')!;
    const column = summary.comparison!.columns.find(bucket => bucket.label === 'review 11')!;
    const previousRows = ui.main.getByRole('button', { name: '필드 집계 그룹 이전 페이지', exact: true });
    const previousColumns = ui.main.getByRole('button', { name: '교차 집계 열 이전 페이지', exact: true });
    await ui.main.getByRole('button', { name: '필드 집계 그룹 다음 페이지', exact: true }).click();
    await ui.main.getByRole('button', { name: '교차 집계 열 다음 페이지', exact: true }).click();
    const cell = ui.matrix.getByRole('button', { name: 'stage 26 × review 11 업무 보기 · 1개', exact: true });
    const drilling = responseAt(page, 'POST', `${f.reportApi}/issues`);
    await cell.click();
    const drilledResponse = await drilling;
    expect(drilledResponse.request().postDataJSON()).toMatchObject({ ...query, revision: summary.revision,
      bucketId: row.id, comparisonBucketId: column.id, includeEditTargets: true });
    expect((await json<IssueFieldBreakdownPage>(drilledResponse)).issues.map(issue => issue.id)).toEqual([target.id]);
    await ui.drilldown.getByRole('button', { name: `${target.key} ${target.title}`, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: target.title, exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '업무 상세 닫기' }).click();
    await expect.poll(() => route(page)).toEqual(location);
    await expect(previousRows).toBeEnabled();
    await expect(previousColumns).toBeEnabled();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');

    const bulkPath = `/api/projects/${f.project.id}/issues/bulk`;
    await ui.drilldown.getByRole('button', { name: '집계 업무 일괄 편집', exact: true }).click();
    const editor = ui.drilldown.getByRole('region', { name: '업무 일괄 편집', exact: true });
    await ui.drilldown.getByRole('checkbox', { name: `${target.key} 선택`, exact: true }).check();
    await editor.getByRole('combobox', { name: '일괄 변경 우선순위', exact: true }).selectOption('high');
    const previewing = responseAt(page, 'POST', `${bulkPath}-preview`);
    await editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const previewResponse = await previewing;
    expect(previewResponse.request().postDataJSON()).toEqual({ issues: [{ id: target.id, expectedVersion: target.version }],
      changes: { priority: 'high' }, fieldBreakdown: { ...query, revision: summary.revision, bucketId: row.id, comparisonBucketId: column.id } });
    const preview = await json<IssueBulkEditPreview>(previewResponse);
    expect(preview.changed).toBe(1);
    const applying = responseAt(page, 'POST', `${bulkPath}-apply`);
    await editor.getByRole('button', { name: '일괄 적용', exact: true }).click();
    expect((await json<IssueBulkEditResult>(await applying)).updated.map(issue => issue.id)).toEqual([target.id]);
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(workspace.issues.find(issue => issue.id === target.id)).toMatchObject({ priority: 'high', version: target.version + 1 });
    for (const untouched of [other, outside]) expect(workspace.issues.find(issue => issue.id === untouched.id)).toEqual(untouched);

    await expect(editor.getByRole('button', { name: '일괄 편집 닫기', exact: true })).toBeEnabled();
    await page.goto('about:blank');
    const loadingShared = responseAt(page, 'POST', f.reportApi);
    await page.goto(sharedUrl);
    const sharedResponse = await loadingShared;
    expect(sharedResponse.request().postDataJSON()).toEqual(query);
    expect((await json<IssueFieldBreakdown>(sharedResponse)).comparison?.field?.id).toBe(columns.id);
    await expect(ui.comparison).toHaveValue(`custom:${columns.id}`);

    const missingId = 'missing-comparison';
    const loadingMissing = responseAt(page, 'POST', f.reportApi);
    await page.goto(`/${f.reportPath}?${new URLSearchParams({ ...hashQuery, comparisonFieldId: missingId })}`);
    await json(await loadingMissing, 404);
    await expect(ui.comparison).toHaveValue(`custom:${missingId}`);
    await expect(ui.comparison.locator(`option[value="custom:${missingId}"]`)).toHaveText(`${missingId} · 현재 정의 없음`);
    const openingPreset = responseAt(page, 'POST', f.reportApi);
    await ui.openPreset(presetName).click();
    const presetResponse = await openingPreset;
    expect(presetResponse.request().postDataJSON()).toEqual(query);
    expect((await json<IssueFieldBreakdown>(presetResponse)).comparison?.field?.id).toBe(columns.id);
    await expect.poll(() => route(page)).toEqual(location);
  } finally {
    try { await f.close(); }
    finally {
      const latest = await json<ProjectIssueSchema>(await request.get(schemaPath));
      await json(await request.patch(schemaPath, { data: { ...original, expectedVersion: latest.version } }));
    }
  }
});
