import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { DocPage, Issue, ProjectIssueOrder, SavedView, WorkspaceSnapshot } from '../../shared/types';

type MoveResponse = { order: ProjectIssueOrder; issue: Issue };

async function createIssue(request: APIRequestContext, projectId: string, title: string, status = 'todo') {
  const response = await request.post('/api/issues', { data: { projectId, title, status } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as Issue;
}

function expectMove(page: Page, projectId: string) {
  return page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}/issue-order`) && response.request().method() === 'PATCH');
}

function issueIds(rows: Locator) {
  return rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-issue-id')));
}

test('360px 업무 목록을 키보드로 정렬하고 새로고침 뒤 보드와 문서에서 같은 순서를 읽는다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = workspace.projects[0].id;
  const tag = randomUUID();
  const query = `순서-${tag}`;
  const created: Issue[] = [];
  let view: SavedView | undefined;
  let document: DocPage | undefined;
  try {
    for (const title of [`${query} A`, `숨김 A ${tag}`, `숨김 B ${tag}`, `${query} B`]) {
      created.push(await createIssue(request, projectId, title));
    }
    const [a, hiddenOne, hiddenTwo, b] = created;
    const saved = await request.post('/api/views', { data: {
      projectId, name: query, layout: 'list', filters: { query, status: 'all', assigneeId: 'all', type: 'all' },
    } });
    expect(saved.ok()).toBeTruthy();
    view = await saved.json() as SavedView;
    const made = await request.post('/api/documents', { data: {
      projectId, title: `회의록 ${query}`,
      content: { type: 'doc', content: [{ type: 'issueList', attrs: { label: query, projectId, savedViewId: view.id } }] },
    } });
    expect(made.ok()).toBeTruthy();
    document = await made.json() as DocPage;

    await page.goto(`/#/${projectId}/issues`);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await expect(search).toBeVisible({ timeout: 24_000 });
    await search.fill(query);
    const rows = page.locator('.issue-table tbody tr[data-issue-id]');
    await expect.poll(() => issueIds(rows)).toEqual([a.id, b.id]);
    const edit = page.getByRole('button', { name: '순서 편집', exact: true });
    await edit.click();
    await expect(edit).toHaveAttribute('aria-pressed', 'true');
    const up = page.getByRole('button', { name: `${b.key} 위로 이동`, exact: true });
    await expect(up).toBeEnabled();
    await up.focus();
    const savedMove = expectMove(page, projectId);
    await page.keyboard.press('Enter');
    const response = await savedMove;
    expect(response.ok()).toBeTruthy();
    expect(response.request().postDataJSON()).toMatchObject({ issueId: b.id, anchorId: a.id, position: 'before' });
    const applied = await response.json() as MoveResponse;
    expect(applied.order.issueIds.filter(id => created.some(issue => id === issue.id))).toEqual([b.id, a.id, hiddenOne.id, hiddenTwo.id]);
    await expect(page.getByRole('status', { name: '업무 순서 상태', exact: true })).toContainText(`${b.key} 업무 순서를 변경했습니다.`);
    await expect.poll(() => issueIds(rows)).toEqual([b.id, a.id]);
    await expect(up).toBeDisabled();
    await expect(up).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.reload();
    await search.fill(query);
    await expect.poll(() => issueIds(rows)).toEqual([b.id, a.id]);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await expect.poll(() => issueIds(page.locator('.issue-board-column[data-status-id="todo"] .issue-board-card[data-issue-id]'))).toEqual([b.id, a.id]);

    await page.goto(`/#/${projectId}/documents/${document.id}`);
    const cards = page.getByRole('region', { name: '업무 목록', exact: true });
    const links = cards.getByRole('button', { name: /^목록 업무 열기/ });
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAccessibleName(`목록 업무 열기 ${b.key} ${b.title}`);
    await expect(links.nth(1)).toHaveAccessibleName(`목록 업무 열기 ${a.key} ${a.title}`);
  } finally {
    if (document) await request.delete(`/api/documents/${document.id}`);
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of created) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('보드에서 다른 상태의 카드 앞이나 빈 열에 내려놓으면 티켓 상태와 위치를 함께 저장한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = workspace.projects[0].id;
  const query = `보드순서-${randomUUID()}`;
  const created: Issue[] = [];
  try {
    created.push(await createIssue(request, projectId, `${query} 목표`, 'in_progress'));
    created.push(await createIssue(request, projectId, `${query} 출발`));
    const [anchor, moving] = created;
    await page.goto(`/#/${projectId}/issues`);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await expect(search).toBeVisible({ timeout: 24_000 });
    await search.fill(query);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    const card = (id: string) => page.locator(`.issue-board-card[data-issue-id="${id}"]`);
    const notice = page.getByRole('status', { name: '업무 순서 상태', exact: true });
    const dropping = expectMove(page, projectId);
    await card(moving.id).dragTo(card(anchor.id), { targetPosition: { x: 30, y: 8 } });
    const response = await dropping;
    expect(response.ok()).toBeTruthy();
    expect(response.request().postDataJSON()).toMatchObject({ issueId: moving.id, anchorId: anchor.id, position: 'before', status: 'in_progress' });
    const moved = await response.json() as MoveResponse;
    expect(moved.issue.status).toBe('in_progress');
    expect(moved.issue.version).toBe(moving.version + 1);
    await expect(notice).toContainText(`${moving.key} 업무 순서와 상태를 변경했습니다.`);
    const destination = page.locator('.issue-board-column[data-status-id="in_progress"] .issue-board-card');
    await expect.poll(() => issueIds(destination)).toEqual([moving.id, anchor.id]);

    const review = page.locator('.issue-board-column[data-status-id="review"]');
    const empty = review.locator('.issue-column-empty');
    const droppingEmpty = expectMove(page, projectId);
    await card(moving.id).dragTo(empty);
    const emptyResponse = await droppingEmpty;
    expect(emptyResponse.ok()).toBeTruthy();
    expect(emptyResponse.request().postDataJSON()).toMatchObject({ issueId: moving.id, anchorId: null, position: 'after', status: 'review' });
    const landed = await emptyResponse.json() as MoveResponse;
    expect(landed.order.issueIds.at(-1)).toBe(moving.id);
    expect(landed.issue.status).toBe('review');
    await expect(review.locator(`.issue-board-card[data-issue-id="${moving.id}"]`)).toBeVisible();
  } finally {
    for (const issue of created) await request.delete(`/api/issues/${issue.id}`);
  }
});
