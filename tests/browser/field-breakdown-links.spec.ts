import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type { Issue, IssueFieldBreakdown, IssueFieldBreakdownPage, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

function posted(page: Page, pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
}

function route(page: Page) {
  const [path, query] = new URL(page.url()).hash.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

function fieldReport(page: Page) {
  const form = page.getByRole('form', { name: '필드 집계 조회 조건', exact: true });
  return {
    main: page.getByRole('region', { name: '업무 필드 집계', exact: true }),
    group: form.getByRole('combobox', { name: '집계 기준', exact: true }),
    compare: form.getByRole('combobox', { name: '비교 기준', exact: true }),
    scope: form.getByRole('combobox', { name: '필드 집계 저장된 보기', exact: true }),
    submit: form.getByRole('button', { name: '필드 집계 조회', exact: true }),
    result: page.getByLabel('필드 집계 결과', { exact: true }),
    matrix: page.getByRole('table', { name: '필드 교차 집계 표', exact: true }),
  };
}

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [member, outsider] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `필드 집계 공유 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  const views: SavedView[] = [];
  async function removeView(view: SavedView) {
    await json(await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`));
    const index = views.findIndex(value => value.id === view.id);
    if (index !== -1) views.splice(index, 1);
  }
  return {
    first, second, member, outsider, prefix, removeView,
    async issue(title: string, assigneeId: string, status = 'in_progress') {
      const issue = await json<Issue>(await request.post('/api/issues', { data: { projectId: first.id, title, status, assigneeId } }), 201);
      issues.push(issue);
      return issue;
    },
    async view(projectId = first.id, label = '보드') {
      const view = await json<SavedView>(await request.post('/api/views', { data: {
        projectId, name: `${prefix} ${label}`, layout: 'board',
        filters: { query: prefix, status: 'all', assigneeId: member.id, type: 'all' },
      } }), 201);
      views.push(view);
      return view;
    },
    async close() {
      for (const view of views.slice()) await removeView(view);
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

test('360px 저장 보드에서 집계한 조건을 공유하고 업무 상세와 보드를 다시 연다', async ({ page, context, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    const target = await f.issue(`${f.prefix} 배정된 업무`, f.member.id);
    const outside = await f.issue(`${f.prefix} 다른 담당자의 업무`, f.outsider.id);
    const unrelated = await f.issue('저장한 검색어에 포함하지 않은 업무', f.member.id);
    const view = await f.view();
    const boardPath = `#/${f.first.id}/issues`;
    const reportPath = `#/${f.first.id}/reports/fields`;
    const reportApi = `/api/projects/${f.first.id}/field-breakdown`;
    const boardQuery = { savedView: view.id };
    const confirmed = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: view.id };
    const reportQuery = { groupBy: 'status', comparisonBy: 'assignee', savedView: view.id };
    const sent: unknown[] = [];
    page.on('request', outgoing => {
      if (new URL(outgoing.url()).pathname === reportApi && outgoing.method() === 'POST') sent.push(outgoing.postDataJSON());
    });

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${boardPath}?${new URLSearchParams(boardQuery)}`);
    const picker = page.getByRole('combobox', { name: '저장된 업무 보기', exact: true });
    const search = page.getByLabel('업무 검색', { exact: true });
    const card = (issue: Issue) => page.locator('.issue-board-card').filter({ hasText: issue.title });
    const expectBoard = async () => {
      await expect.poll(() => route(page)).toEqual({ path: boardPath, query: boardQuery });
      await expect(picker).toHaveValue(view.id);
      await expect(search).toHaveValue(f.prefix);
      await expect(card(target)).toBeVisible();
      await expect(card(outside)).toHaveCount(0);
      await expect(card(unrelated)).toHaveCount(0);
    };
    await expectBoard();
    await search.fill(`${f.prefix} 임시 조건`);
    await expect(card(target)).toHaveCount(0);
    await page.getByRole('button', { name: '필드 집계에서 열기', exact: true }).click();
    await expect.poll(() => route(page)).toEqual({ path: reportPath, query: boardQuery });
    const report = fieldReport(page);
    await expect(report.scope).toHaveValue(view.id);
    await expect(report.group).toHaveValue('');
    await expect(report.submit).toBeDisabled();
    await expect(report.result).toHaveCount(0);
    expect(sent).toEqual([]);

    await report.group.selectOption('status');
    await report.compare.selectOption('assignee');
    await expect.poll(() => route(page)).toEqual({ path: reportPath, query: boardQuery });
    const requested = posted(page, reportApi);
    await report.submit.click();
    const response = await requested;
    expect(response.request().postDataJSON()).toEqual(confirmed);
    const summary = await json<IssueFieldBreakdown>(response);
    expect(summary.savedView).toMatchObject({ id: view.id, name: view.name });
    expect(summary.totalIssues).toBe(1);
    expect(summary.comparison?.columns.map(column => [column.label, column.count])).toEqual([[f.member.name, 1]]);
    await expect.poll(() => route(page)).toEqual({ path: reportPath, query: reportQuery });
    await expect(report.matrix).toBeVisible();

    const copy = report.main.getByRole('button', { name: '필드 집계 링크 복사', exact: true });
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await copy.click();
    await expect.poll(clipboard).toBe(page.url());
    const link = await clipboard();
    await report.compare.selectOption('priority');
    await expect(report.matrix.getByRole('columnheader', { name: f.member.name, exact: true })).toBeVisible();
    await page.evaluate(() => navigator.clipboard.writeText('아직 링크를 복사하지 않음'));
    await copy.click();
    await expect.poll(clipboard).toBe(link);
    await expect.poll(() => route(page)).toEqual({ path: reportPath, query: reportQuery });
    expect(sent).toEqual([confirmed]);

    const reopened = await context.newPage();
    try {
      await reopened.setViewportSize({ width: 360, height: 820 });
      const automatic = posted(reopened, reportApi);
      await reopened.goto(link);
      const restored = await automatic;
      expect(restored.request().postDataJSON()).toEqual(confirmed);
      expect((await json<IssueFieldBreakdown>(restored)).totalIssues).toBe(1);
      const fresh = fieldReport(reopened);
      await expect(fresh.scope).toHaveValue(view.id);
      await expect(fresh.compare).toHaveValue('assignee');
      const populated = summary.groups.find(group => group.count > 0)!;
      const cell = fresh.matrix.getByRole('button', { name: `${populated.label} × ${f.member.name} 업무 보기 · 1개`, exact: true });
      const drill = posted(reopened, `${reportApi}/issues`);
      await cell.click();
      const work = await json<IssueFieldBreakdownPage>(await drill);
      expect(work.issues.map(issue => issue.id)).toEqual([target.id]);
      const panel = reopened.getByRole('region', { name: '필드 집계 그룹 업무', exact: true });
      await panel.getByRole('button', { name: `${target.key} ${target.title}`, exact: true }).click();
      const drawer = reopened.getByRole('dialog', { name: target.title, exact: true });
      await expect(drawer).toBeVisible();
      await expect.poll(() => route(reopened)).toEqual({ path: reportPath, query: { ...reportQuery, issue: target.id } });
      await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
      await expect.poll(() => route(reopened)).toEqual({ path: reportPath, query: reportQuery });
      await expect(cell).toHaveAttribute('aria-pressed', 'true');

      await reopened.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true, value: () => Promise.reject(new DOMException('Clipboard blocked', 'NotAllowedError')),
      }));
      await fresh.main.getByRole('button', { name: '필드 집계 링크 복사', exact: true }).click();
      const fallback = fresh.main.getByLabel('필드 집계 링크 주소', { exact: true });
      await expect(fallback).toHaveValue(link);
      await expect(fallback).toHaveAttribute('readonly', '');
      await expect(fallback).toBeFocused();
      expect(await fallback.evaluate((field: HTMLInputElement) => [field.selectionStart, field.selectionEnd])).toEqual([0, link.length]);
    } finally { await reopened.close(); }

    const board = report.main.getByRole('button', { name: '저장한 업무 보기 열기', exact: true });
    const cancel = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.message()).toContain('조회하지 않은 필드 집계 조건');
      await dialog.dismiss();
    });
    await board.click();
    await cancel;
    await expect(report.compare).toHaveValue('priority');
    await expect.poll(() => route(page)).toEqual({ path: reportPath, query: reportQuery });
    await report.compare.selectOption('assignee');
    await board.click();
    await expectBoard();
  } finally { await f.close(); }
});

test('삭제됐거나 다른 프로젝트에 속한 저장 보기의 필드 집계 링크는 조회 범위를 넓히지 않는다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  try {
    await f.issue(`${f.prefix} 정상 보드 업무`, f.member.id);
    await f.issue(`${f.prefix} 다른 담당자의 업무`, f.outsider.id);
    const archive = await f.view(f.first.id, '삭제 예정');
    const foreign = await f.view(f.second.id, '다른 프로젝트');
    const valid = await f.view(f.first.id, '복구할 보기');
    await f.removeView(archive);
    await page.setViewportSize({ width: 360, height: 820 });
    const report = fieldReport(page);
    const reportPath = `#/${f.first.id}/reports/fields`;
    const endpoint = `/api/projects/${f.first.id}/field-breakdown`;
    const axes = { groupBy: 'status', comparisonBy: 'assignee' };
    const sent: unknown[] = [];
    page.on('request', outgoing => {
      if (new URL(outgoing.url()).pathname === endpoint && outgoing.method() === 'POST') sent.push(outgoing.postDataJSON());
    });

    for (const missing of [archive, foreign]) {
      const query = { ...axes, savedView: missing.id };
      const loading = posted(page, endpoint);
      await page.goto(`/${reportPath}?${new URLSearchParams(query)}`);
      const response = await loading;
      expect(response.request().postDataJSON()).toEqual({ ...axes, savedViewId: missing.id });
      const { error } = await json<{ error: string }>(response, 404);
      await expect(report.main.getByRole('alert').filter({ hasText: error })).toBeVisible();
      await expect(report.scope).toHaveValue(missing.id);
      await expect(report.scope.locator('option:checked')).toContainText('현재 목록 없음');
      await expect(report.matrix).toHaveCount(0);
      await expect(report.main.getByRole('button', { name: '필드 집계 링크 복사', exact: true })).toHaveCount(0);
      await expect.poll(() => route(page)).toEqual({ path: reportPath, query });
    }

    await report.scope.selectOption(valid.id);
    expect(sent).toEqual([archive, foreign].map(view => ({ ...axes, savedViewId: view.id })));
    const retried = posted(page, endpoint);
    await report.submit.click();
    const response = await retried;
    expect(response.request().postDataJSON()).toEqual({ ...axes, savedViewId: valid.id });
    const restored = await json<IssueFieldBreakdown>(response);
    expect(restored.totalIssues).toBe(1);
    await expect(report.matrix).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ path: reportPath, query: { ...axes, savedView: valid.id } });
    const expectedRequests = [archive, foreign, valid].map(view => ({ ...axes, savedViewId: view.id }));
    expect(sent).toEqual(expectedRequests);

    await page.goto(`/#/missing-${randomUUID()}/reports/fields?${new URLSearchParams({ ...axes, savedView: valid.id })}`);
    await expect(report.main.getByText(/이 링크의 필드 집계 조건을 확인할 수 없습니다/)).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ path: reportPath, query: { invalid: '1' } });
    await expect(report.matrix).toHaveCount(0);
    expect(sent).toEqual(expectedRequests);
  } finally { await f.close(); }
});
