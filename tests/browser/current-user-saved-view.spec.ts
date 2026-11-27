import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { DocPage, Issue, JiraSavedViewPreview, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'text' | 'status'>, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

function postTo(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function fixture(request: APIRequestContext) {
  const { projects: [project], users: [first, second] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const label = `current-viewer-${randomUUID().slice(0, 10)}`;
  const issues: Issue[] = [];
  const views: SavedView[] = [];
  const documents: DocPage[] = [];
  const createIssue = async (title: string, assigneeId: string | null, reporterId: string | null, status = 'todo') => {
    const issue = await json<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${label} ${title}`, assigneeId, reporterId, status, labels: [label],
      startDate: '2026-11-23', endDate: '2026-11-25',
    } }), 201);
    issues.push(issue);
    return issue;
  };

  async function close() {
    for (const kind of ['documents', 'issues'] as const) {
      for (const resource of kind === 'documents' ? documents : issues) {
        const trash = await json<{ trashEntryId: string }>(await request.delete(`/api/${kind}/${resource.id}?expectedVersion=${resource.version}`));
        expect((await request.delete(`/api/trash/${trash.trashEntryId}`)).ok()).toBe(true);
      }
    }
    if (!views.length) return;
    const current = await json<SavedView[]>(await request.get(`/api/views?projectId=${project.id}`));
    for (const saved of current.filter(view => views.some(expected => expected.id === view.id))) {
      expect((await request.delete(`/api/views/${saved.id}?expectedVersion=${saved.version}`)).ok()).toBe(true);
    }
  }

  return { project, first, second, label, views, documents, createIssue, close };
}

async function selectActorOnLoad(page: Page, actorId: string) {
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actorId);
}

test('360px에서 같은 공유 보기를 두 작업자가 열고 각자의 담당 업무를 목록·보드·간트와 문서에서 확인한다', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const otherContext = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    const firstIssue = await f.createIssue('첫 번째 작업자의 담당', f.first.id, f.second.id);
    const secondIssue = await f.createIssue('두 번째 작업자의 담당', f.second.id, f.first.id);
    const unassigned = await f.createIssue('담당 미지정', null, null);
    const otherState = await f.createIssue('다른 상태', f.first.id, f.first.id, 'in_progress');
    const other = await otherContext.newPage();
    await Promise.all([selectActorOnLoad(page, f.first.id), selectActorOnLoad(other, f.second.id)]);
    await page.setViewportSize({ width: 360, height: 820 });
    const path = `/#/${f.project.id}/issues`;
    await page.goto(path);
    const assignee = page.getByRole('combobox', { name: '담당자 필터', exact: true });
    await page.getByRole('textbox', { name: '업무 검색', exact: true }).fill(f.label);
    await page.getByRole('combobox', { name: '상태 필터', exact: true }).selectOption('todo');
    await assignee.selectOption({ label: '현재 사용자' });
    const list = page.locator('.issue-table tbody tr[data-issue-id]');
    await expect(list).toHaveCount(1);
    await expect(list.first()).toHaveAttribute('data-issue-id', firstIssue.id);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    await expect(dialog.getByText('담당자 · 현재 사용자', { exact: true })).toBeVisible();
    await dialog.getByLabel('보기 이름', { exact: true }).fill(`${f.label} 담당자`);
    const pendingSave = postTo(page, '/api/views');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    const view = await json<SavedView>(await pendingSave, 201);
    f.views.push(view);
    expect(view).toMatchObject({ layout: 'board', filters: {
      query: f.label, status: 'todo', assigneeId: 'all', assignee: { kind: 'current-user' },
    } });

    const sharedPath = `${path}?savedView=${view.id}`;
    await Promise.all([page.goto(sharedPath), other.goto(sharedPath)]);
    const cards = (viewer: Page) => viewer.locator('.issue-board-card');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).getByText(firstIssue.title, { exact: true })).toBeVisible();
    await expect(cards(other)).toHaveCount(1);
    await expect(cards(other).getByText(secondIssue.title, { exact: true })).toBeVisible();
    expect(page.url()).toBe(other.url());
    const actor = other.getByRole('combobox', { name: '작업자 선택', exact: true });
    await actor.selectOption(f.first.id);
    await expect(cards(other).getByText(firstIssue.title, { exact: true })).toBeVisible();
    await expect(cards(other).getByText(secondIssue.title, { exact: true })).toHaveCount(0);
    await actor.selectOption(f.second.id);

    const ganttPath = `/#/${f.project.id}/gantt?savedView=${view.id}`;
    await Promise.all([page.goto(ganttPath), other.goto(ganttPath)]);
    for (const [viewer, issue] of [[page, firstIssue], [other, secondIssue]] as const) {
      const rows = viewer.getByRole('region', { name: '간트 차트', exact: true }).locator('.gantt-row[data-issue-id]');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toHaveAttribute('data-issue-id', issue.id);
    }
    const [exported] = await Promise.all([
      other.waitForEvent('download'), other.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click(),
    ]);
    const html = await readFile(await exported.path(), 'utf8');
    expect(html).toContain('담당자 · 현재 사용자');
    expect(html).toContain(secondIssue.title);
    for (const issue of [firstIssue, unassigned, otherState]) expect(html).not.toContain(issue.title);

    const attrs = { projectId: f.project.id, savedViewId: view.id, label: view.name };
    const doc = await json<DocPage>(await request.post('/api/documents', { data: {
      title: `${f.label} 업무 위키`, projectId: f.project.id,
      content: { type: 'doc', content: [{ type: 'issueList', attrs }, { type: 'issueSummary', attrs: { ...attrs, groupBy: 'status' } }] },
    } }), 201);
    f.documents.push(doc);
    for (const [viewer, issue] of [[page, firstIssue], [other, secondIssue]] as const) {
      await viewer.goto(`/#/${f.project.id}/documents`);
      await viewer.reload();
      await viewer.getByRole('button', { name: new RegExp(`${doc.title} 초안$`, 'u') }).click();
      await expect(viewer.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(doc.title);
      const docList = viewer.getByRole('region', { name: '업무 목록', exact: true });
      await expect(docList.getByRole('button', { name: /^목록 업무 열기 / })).toHaveCount(1);
      await expect(docList.getByRole('button', { name: `목록 업무 열기 ${issue.key} ${issue.title}`, exact: true })).toBeVisible();
      const summary = viewer.getByRole('region', { name: '업무 현황', exact: true });
      await summary.getByRole('button', { name: '할 일 1개', exact: true }).click();
      await expect(summary.getByRole('button', { name: /^현황 업무 열기 / })).toHaveCount(1);
      await expect(summary.getByRole('button', { name: `현황 업무 열기 ${issue.key} ${issue.title}`, exact: true })).toBeVisible();
    }

    await other.goto(sharedPath);
    await other.getByRole('combobox', { name: '담당자 필터', exact: true }).selectOption({ label: f.first.name });
    await other.getByRole('button', { name: '보기 수정', exact: true }).click();
    const editing = other.getByRole('dialog', { name: '저장된 보기 수정', exact: true });
    const pendingUpdate = other.waitForResponse(response => new URL(response.url()).pathname === `/api/views/${view.id}` && response.request().method() === 'PATCH');
    await editing.getByRole('button', { name: '저장', exact: true }).click();
    const fixed = await json<SavedView>(await pendingUpdate);
    expect(fixed.filters.assignee).toBeUndefined();
    expect(fixed.filters.assigneeId).toBe(f.first.id);
    await other.reload();
    await expect(cards(other)).toHaveCount(1);
    await expect(cards(other).getByText(firstIssue.title, { exact: true })).toBeVisible();
  } finally {
    await otherContext.close();
    await f.close();
  }
});

test('Jira 요청자의 현재 사용자 조건을 저장하고 같은 보기에서 다른 작업자의 요청을 확인한다', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const firstRequest = await f.createIssue('첫 요청자의 티켓', f.second.id, f.first.id);
    const secondRequest = await f.createIssue('둘째 요청자의 티켓', f.first.id, f.second.id);
    await f.createIssue('요청자 미지정', f.first.id, null);
    await page.setViewportSize({ width: 360, height: 820 });
    await selectActorOnLoad(page, f.first.id);
    const path = `/#/${f.project.id}/issues`;
    await page.goto(path);
    await page.getByRole('button', { name: 'Jira 필터 옮기기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Jira 필터 옮기기', exact: true });
    await dialog.getByLabel('Jira 검색식 (JQL)', { exact: true }).fill(`project = ${f.project.key} AND reporter = currentUser() AND labels = "${f.label}"`);
    const pendingPreview = postTo(page, '/api/views/jira/preview');
    await dialog.getByRole('button', { name: '조건 미리보기', exact: true }).click();
    const preview = await json<JiraSavedViewPreview>(await pendingPreview);
    expect(preview.filters.reporter).toEqual({ kind: 'current-user' });
    expect(preview.issues.map(issue => issue.id)).toEqual([firstRequest.id]);
    const review = dialog.getByRole('region', { name: 'Jira 필터 미리보기', exact: true });
    await expect(review).toContainText('요청자 · 현재 사용자');
    await expect(review).toContainText(firstRequest.title);
    await expect(review).not.toContainText(secondRequest.title);
    await dialog.getByLabel('보기 이름', { exact: true }).fill(`${f.label} 요청자`);
    const pendingImport = postTo(page, '/api/views/jira/import');
    await dialog.getByRole('button', { name: '공유 보기 저장', exact: true }).click();
    const view = await json<SavedView>(await pendingImport, 201);
    f.views.push(view);
    expect(view.filters.reporter).toEqual({ kind: 'current-user' });

    await page.goto(`${path}?savedView=${view.id}`);
    const reporter = page.getByRole('combobox', { name: '요청자 필터', exact: true });
    await expect(reporter.locator('option:checked')).toHaveText('현재 사용자');
    const rows = page.locator('.issue-table tbody tr[data-issue-id]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-issue-id', firstRequest.id);
    await page.getByRole('combobox', { name: '작업자 선택', exact: true }).selectOption(f.second.id);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-issue-id', secondRequest.id);
    await expect(page.getByRole('combobox', { name: '저장된 업무 보기', exact: true })).toHaveValue(view.id);
  } finally {
    await f.close();
  }
});
