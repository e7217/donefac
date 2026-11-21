import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type { Issue, IssueFieldBreakdown, IssueFieldBreakdownPage, SavedFieldBreakdown, SavedView, WorkspaceSnapshot } from '../../shared/types';

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
    prefix, member, peer, reportPath, reportApi, presetApi,
    async issue(suffix: string, assigneeId: string) {
      const created = await json<Issue>(await request.post('/api/issues', { data: {
        projectId: project.id, title: `${prefix} ${suffix}`, status: 'in_progress', assigneeId,
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
