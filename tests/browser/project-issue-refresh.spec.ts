import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import { STATUS, type Issue, type SavedView, type WorkspaceSnapshot } from '../../shared/types';

const workspaceUrl = (url: URL) => url.pathname === '/api/workspace';
const conditionalUrl = (url: URL) => workspaceUrl(url) && url.searchParams.has('ganttSince');
const conditionalResponse = (response: Response, status: number) => conditionalUrl(new URL(response.url())) && response.status() === status;
const refresh = (page: Page) => page.getByRole('button', { name: '업무 새로고침', exact: true });
const card = (board: Locator, issue: Issue, status: string) => board.locator(`[data-status-id="${status}"] .issue-board-card[data-issue-id="${issue.id}"]`);
const listRow = (page: Page, issue: Issue) => page.getByRole('region', { name: '업무 목록', exact: true }).locator(`tr[data-issue-id="${issue.id}"]`);
const statusCell = (row: Locator) => row.getByRole('cell').nth(1);

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function fixture(request: APIRequestContext, layout: SavedView['layout']) {
  const { projects: [project], users: [actor, peer] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const peerHeaders = { 'X-Actor-Id': peer.id };
  const prefix = `프로젝트 업무 갱신 ${randomUUID().slice(0, 8)}`;
  const issueIds: string[] = [];
  const view = await json<SavedView>(await request.post('/api/views', { headers, data: {
    projectId: project.id, name: `${prefix} 보기`, layout,
    filters: { query: prefix, status: 'all', assigneeId: 'all', type: 'all' },
  } }), 201);
  const route = `#/${project.id}/issues?savedView=${view.id}`;
  return {
    actor, prefix, route, view,
    async issue(label: string, matchesSearch = true) {
      const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
        projectId: project.id, title: `${matchesSearch ? prefix : `그 외 업무 ${randomUUID().slice(0, 8)}`} ${label}`, status: 'in_progress',
      } }), 201);
      issueIds.push(issue.id);
      return issue;
    },
    async update(issue: Issue, change: Partial<Pick<Issue, 'status' | 'title' | 'assigneeId'>>) {
      return json<Issue>(await request.patch(`/api/issues/${issue.id}`, {
        headers: peerHeaders, data: { expectedVersion: issue.version, ...change },
      }));
    },
    async close() {
      await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`, { headers });
      for (const id of issueIds) {
        const removed = await request.delete(`/api/issues/${id}`, { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

async function openProject(page: Page, data: Awaited<ReturnType<typeof fixture>>) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.clock.install();
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), data.actor.id);
  await page.goto(`/${data.route}`);
  const search = page.getByLabel('업무 검색', { exact: true });
  const picker = page.getByLabel('저장된 업무 보기', { exact: true });
  await expect(search).toHaveValue(data.prefix);
  await expect(picker).toHaveValue(data.view.id);
  const unchanged = page.waitForResponse(response => conditionalResponse(response, 204), { timeout: 10_000 });
  await page.clock.runFor(15_100);
  const outcome = await unchanged;
  expect(outcome.headers()['content-length'] ?? '0').toBe('0');
  expect(new URL(outcome.url()).searchParams.get('ganttSince')).toMatch(/^[a-f0-9]{32}$/u);
  return { search, picker };
}

test('360px 공유 프로젝트 보드에서 동료가 바꾼 상태를 자동 반영하고 목록을 수동 갱신한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const data = await fixture(request, 'board');
  try {
    const issue = await data.issue('갱신 대상');
    const excluded = await data.issue('검색 조건 밖', false);
    const { search, picker } = await openProject(page, data);
    const board = page.getByRole('region', { name: '업무 보드', exact: true });
    const previous = card(board, issue, 'in_progress');
    const moved = card(board, issue, 'review');
    await previous.focus();
    await expect(previous).toBeFocused();

    const remote = await data.update(issue, { status: 'review' });
    const changed = page.waitForResponse(response => conditionalResponse(response, 200));
    await page.clock.runFor(15_100);
    expect((await json<WorkspaceSnapshot>(await changed)).issues.find(entry => entry.id === issue.id)).toEqual(remote);
    await expect(previous).toHaveCount(0);
    await expect(moved).toBeFocused();
    await expect(board.locator(`[data-issue-id="${excluded.id}"]`)).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === data.route);
    await expect(search).toHaveValue(data.prefix);
    await expect(picker).toHaveValue(data.view.id);

    await page.getByRole('button', { name: '목록', exact: true }).click();
    const state = statusCell(listRow(page, issue));
    await expect(state).toHaveText(STATUS.review.label);
    await data.update(remote, { status: 'done' });
    await expect(state).toHaveText(STATUS.review.label);
    const button = refresh(page);
    await button.click();
    await expect(state).toHaveText(STATUS.done.label);
    await expect(page.getByText('업무를 새로고침했습니다.', { exact: true })).toBeVisible();
    await expect(button).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === data.route);
    await expect(search).toHaveValue(data.prefix);
    await expect(picker).toHaveValue(data.view.id);
  } finally {
    await data.close();
  }
});

test('프로젝트 목록의 지연된 갱신을 상세 초안에 적용하지 않고 닫은 뒤 최신 업무를 읽는다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const data = await fixture(request, 'list');
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const issue = await data.issue('편집 전 제목');
    const { search, picker } = await openProject(page, data);
    const row = listRow(page, issue);
    const opener = row.locator('.issue-title-button');
    const remoteTitle = `${data.prefix} 동료가 바꾼 제목`;
    await data.update(issue, { title: remoteTitle, status: 'review' });

    await page.route(conditionalUrl, async route => {
      try {
        const response = await route.fetch();
        const received = await json<WorkspaceSnapshot>(response);
        expect(received.issues.find(entry => entry.id === issue.id)?.title).toBe(remoteTitle);
        held.resolve();
        await release.promise;
        await route.fulfill({ response }).catch(() => undefined);
      } catch (error) {
        held.reject(error);
        await route.abort().catch(() => undefined);
      }
    }, { times: 1 });

    await page.clock.runFor(15_100);
    await held.promise;
    const aborted = page.waitForEvent('requestfailed', sent => conditionalUrl(new URL(sent.url())));
    await opener.click();
    expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
    const details = page.getByRole('dialog', { name: issue.title, exact: true });
    const title = details.getByLabel('제목', { exact: true });
    const status = details.getByLabel('상태', { exact: true });
    await expect(title).toHaveValue(issue.title);
    const draft = `${data.prefix} 내가 편집 중인 제목`;
    await title.fill(draft);
    release.resolve();
    await page.clock.runFor(15_100);
    await expect(title).toHaveValue(draft);
    await expect(status).toHaveValue(issue.status);
    await expect(title).toBeFocused();

    const latest = page.waitForResponse(response => conditionalResponse(response, 200));
    page.once('dialog', dialog => dialog.accept());
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await page.clock.runFor(100);
    await latest;
    await expect(details).toHaveCount(0);
    await expect(opener).toContainText(remoteTitle);
    await expect(statusCell(row)).toHaveText(STATUS.review.label);
    await expect(page).toHaveURL(url => url.hash === data.route);
    await expect(search).toHaveValue(data.prefix);
    await expect(picker).toHaveValue(data.view.id);
    const saved = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(saved.issues.find(entry => entry.id === issue.id)).toMatchObject({ title: remoteTitle, status: 'review', version: issue.version + 1 });
  } finally {
    release.resolve();
    await data.close();
  }
});
