import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Dialog, type Locator, type Page } from '@playwright/test';
import type { Issue, Project, SavedView, SavedViewState, WorkspaceSnapshot } from '../../shared/types';

const viewport = { width: 360, height: 820 };
const button = (scope: Locator | Page, name: string) => scope.getByRole('button', { name, exact: true });
const drawer = (page: Page, issue: Issue) => page.getByRole('dialog', { name: issue.title, exact: true });
const review = (panel: Locator) => panel.locator('[aria-label="업무 검토 순서"]');
const previous = (panel: Locator) => button(review(panel), '이전 업무');
const next = (panel: Locator) => button(review(panel), '다음 업무');
const hash = (page: Page) => new URL(page.url()).hash;

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const elementIds = (elements: Locator) => elements.evaluateAll(rows => rows.map(row => row.getAttribute('data-issue-id')));

function waitForMutation(page: Page, method: string, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `업무검토 ${randomUUID().slice(0, 8)}`;
  const created = new Set<string>();
  const views: SavedView[] = [];
  async function discard(id: string) {
    const current = (await workspace(request)).issues.find(issue => issue.id === id);
    if (!current) return;
    const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(
      `/api/issues/${id}?expectedVersion=${current.version}`, { headers },
    ));
    const removed = await request.delete(`/api/trash/${trashEntryId}`, { headers });
    expect(removed.ok(), await removed.text()).toBeTruthy();
    created.delete(id);
  }
  return {
    first, second, actor, peer, prefix,
    async issue(project: Project, label: string, fields: Partial<Issue> = {}) {
      const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
        projectId: project.id, title: `${prefix} ${label}`, status: 'todo', assigneeId: actor.id, ...fields,
      } }), 201);
      created.add(issue.id);
      return issue;
    },
    async view(state: SavedViewState) {
      const view = await json<SavedView>(await request.post('/api/views', { headers, data: {
        projectId: first.id, name: `${prefix} 공유 보기`, ...state,
      } }), 201);
      views.push(view);
      return view;
    },
    discard,
    async close() {
      for (const view of views) {
        const removed = await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`, { headers });
        expect(removed.ok(), await removed.text()).toBeTruthy();
      }
      for (const id of created) await discard(id);
    },
  };
}

async function expectPosition(panel: Locator, total: number, index: number) {
  await expect(review(panel).getByRole('status')).toHaveText(`${total}개 중 ${index}번째`);
}

test('360px 공유 목록에서 업무 상태와 초안을 보호하면서 표시 순서로 검토를 이어 간다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  try {
    const candidates: Issue[] = [];
    for (const label of ['하나', '둘', '셋', '넷']) candidates.push(await f.issue(f.first, label));
    const outside = await f.issue(f.first, '다른 상태', { status: 'review' });
    const view = await f.view({ layout: 'list', filters: { query: f.prefix, status: 'todo', assigneeId: f.actor.id, type: 'all' } });
    const source = `#/${f.first.id}/issues?savedView=${view.id}`;
    await page.setViewportSize(viewport);
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), f.actor.id);
    await page.goto(`/${source}`);
    const rows = page.locator('.issue-table tbody tr[data-issue-id]');
    await expect(rows).toHaveCount(4, { timeout: 25_000 });
    const ordered = (await elementIds(rows)).map(id => candidates.find(issue => issue.id === id)!);
    expect(ordered).toEqual(expect.arrayContaining(candidates));
    const [first, second, removed, last] = ordered;
    const open = (issue: Issue) => page.locator(`tr[data-issue-id="${issue.id}"] .issue-title-button`);
    await expect(open(outside)).toHaveCount(0);
    const mutations: string[] = [];
    page.on('request', value => {
      const path = new URL(value.url()).pathname;
      if ((value.method() === 'PATCH' && path.startsWith('/api/issues/')) || (value.method() === 'POST' && path === '/api/comments')) {
        mutations.push(path);
      }
    });

    await open(first).click();
    const firstPanel = drawer(page, first);
    await expectPosition(firstPanel, 4, 1);
    await expect(previous(firstPanel)).toBeDisabled();
    await expect(next(firstPanel)).toHaveAttribute('title', second.key);
    await f.discard(removed.id);
    await firstPanel.getByLabel('상태', { exact: true }).selectOption('in_progress');
    const patchPath = `/api/issues/${first.id}`;
    const saved = waitForMutation(page, 'PATCH', patchPath);
    await button(firstPanel, '변경사항 저장').click();
    expect(await json<Issue>(await saved)).toMatchObject({ status: 'in_progress', version: first.version + 1 });
    await expect(button(firstPanel, '변경사항 저장')).toBeDisabled();
    await expect(open(first)).toHaveCount(0);
    await expectPosition(firstPanel, 3, 1);

    const firstHash = hash(page);
    const title = firstPanel.getByLabel('제목', { exact: true });
    const comment = firstPanel.getByLabel('댓글 내용', { exact: true });
    await title.fill('작성 중인 업무 제목');
    await comment.fill('작성 중인 업무 댓글');
    const cancelled = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.message()).toMatch(/저장하지 않은/);
      await dialog.dismiss();
    });
    await next(firstPanel).click();
    await cancelled;
    await expect(title).toHaveValue('작성 중인 업무 제목');
    await expect(comment).toHaveValue('작성 중인 업무 댓글');
    await expect.poll(() => hash(page)).toBe(firstHash);

    const discarded = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await next(firstPanel).click();
    await discarded;
    const secondPanel = drawer(page, second);
    await expectPosition(secondPanel, 3, 2);
    await expect(next(secondPanel)).toBeFocused();
    await expect(next(secondPanel)).toHaveAttribute('title', last.key);

    let releaseComment!: () => void;
    const commentRelease = new Promise<void>(resolve => { releaseComment = resolve; });
    await page.route('**/api/comments', async route => {
      if (route.request().method() === 'POST') await commentRelease;
      await route.continue();
    });
    const postedComment = '검토하는 동안 서버에 저장할 댓글';
    const reply = waitForMutation(page, 'POST', '/api/comments');
    await secondPanel.getByLabel('댓글 내용', { exact: true }).fill(postedComment);
    await button(secondPanel, '댓글 등록').click();
    await expect(next(secondPanel)).toBeDisabled();
    const secondHash = hash(page);
    const prompts: string[] = [];
    const rememberPrompt = (dialog: Dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    };
    page.on('dialog', rememberPrompt);
    try {
      await page.goBack();
      await expect(page.getByText('저장이 끝난 후 이동해주세요.', { exact: true })).toBeVisible();
      await expect.poll(() => hash(page)).toBe(secondHash);
      expect(prompts).toEqual([]);
    } finally {
      releaseComment();
      page.off('dialog', rememberPrompt);
    }
    const posted = await reply;
    expect(posted.status(), await posted.text()).toBe(201);
    await expect(secondPanel.getByText(postedComment, { exact: true })).toBeVisible();
    await expect(next(secondPanel)).toBeEnabled();

    await next(secondPanel).click();
    const lastPanel = drawer(page, last);
    await expectPosition(lastPanel, 3, 3);
    await expect(next(lastPanel)).toBeDisabled();
    await expect(previous(lastPanel)).toHaveAttribute('title', second.key);
    const detailHash = hash(page);
    expect(new URLSearchParams(detailHash.split('?')[1]).get('savedView')).toBe(view.id);
    expect(new URLSearchParams(detailHash.split('?')[1]).get('issue')).toBe(last.id);

    await page.goBack();
    await expect(lastPanel).toHaveCount(0);
    await expect.poll(() => hash(page)).toBe(source);
    await expect(page.getByRole('combobox', { name: '저장된 업무 보기', exact: true })).toHaveValue(view.id);
    expect(await elementIds(rows)).toEqual([second.id, last.id]);
    await expect(page.getByRole('heading', { name: '업무', exact: true })).toBeFocused();
    expect(mutations).toEqual([patchPath, '/api/comments']);

    await page.goto(`/${detailHash}`);
    await page.reload();
    await expect(lastPanel).toBeVisible();
    await expect(review(lastPanel)).toHaveCount(0);
  } finally { await f.close(); }
});

test('360px에서 보드 열과 전체 프로젝트 간트의 표시 순서 및 닫을 때의 초점을 유지한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const f = await fixture(request);
  try {
    const inProgress = await f.issue(f.first, '진행 업무', { status: 'in_progress' });
    const reviewInFirst = await f.issue(f.first, '검토 업무', { status: 'review' });
    const todoInSecond = await f.issue(f.second, '할 일 업무');
    const hidden = await f.issue(f.second, '다른 담당자의 업무', { assigneeId: f.peer.id });
    const boardView = await f.view({ layout: 'board', filters: {
      query: f.prefix, status: 'all', assigneeId: f.actor.id, type: 'all',
    } });
    await page.setViewportSize(viewport);
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), f.actor.id);
    const projectBoard = `#/${f.first.id}/issues?savedView=${boardView.id}`;
    await page.goto(`/${projectBoard}`);
    const projectCards = page.locator('.issue-board-card[data-issue-id]');
    await expect(projectCards).toHaveCount(2, { timeout: 25_000 });
    expect(await elementIds(projectCards)).toEqual([inProgress.id, reviewInFirst.id]);
    const projectOpener = page.locator(`.issue-board-card[data-issue-id="${inProgress.id}"]`);
    await projectOpener.click();
    await expectPosition(drawer(page, inProgress), 2, 1);
    await next(drawer(page, inProgress)).click();
    await expectPosition(drawer(page, reviewInFirst), 2, 2);
    await page.goBack();
    await expect(projectOpener).toBeFocused();
    await expect.poll(() => hash(page)).toBe(projectBoard);

    const teamBoard = `#/${f.first.id}/teamboard?${new URLSearchParams({ boardMember: f.actor.id, boardQuery: f.prefix })}`;
    await page.goto(`/${teamBoard}`);
    const cards = page.locator('.team-board-card[data-issue-id]');
    await expect(cards).toHaveCount(3, { timeout: 25_000 });
    expect(await elementIds(cards)).toEqual([todoInSecond.id, inProgress.id, reviewInFirst.id]);
    await expect(page.locator(`.team-board-card[data-issue-id="${hidden.id}"]`)).toHaveCount(0);
    const boardOpener = button(page, `${inProgress.key} 업무 열기`);
    await boardOpener.click();
    await expectPosition(drawer(page, inProgress), 3, 2);
    await previous(drawer(page, inProgress)).click();
    await expectPosition(drawer(page, todoInSecond), 3, 1);
    await expect(previous(drawer(page, todoInSecond))).toBeDisabled();
    await page.goBack();
    await expect(boardOpener).toBeFocused();
    await expect.poll(() => hash(page)).toBe(teamBoard);
    await expect(page.getByLabel('보드 업무 검색', { exact: true })).toHaveValue(f.prefix);

    const gantt = `#/${f.first.id}/gantt?${new URLSearchParams({ scope: 'team', ganttAssignee: f.actor.id })}`;
    await page.goto(`/${gantt}`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await search.fill(f.prefix);
    const ganttRows = page.locator('.gantt-row[data-issue-id]');
    await expect(ganttRows).toHaveCount(3);
    const rendered = (await elementIds(ganttRows)).map(id => [inProgress, reviewInFirst, todoInSecond].find(issue => issue.id === id)!);
    expect(rendered).toEqual(expect.arrayContaining([inProgress, reviewInFirst, todoInSecond]));
    const [first, second] = rendered;
    const ganttOpener = page.locator(`.gantt-row[data-issue-id="${first.id}"] .gantt-issue-name`);
    await ganttOpener.click();
    await expectPosition(drawer(page, first), 3, 1);
    await next(drawer(page, first)).click();
    await expectPosition(drawer(page, second), 3, 2);
    await button(drawer(page, second), '업무 상세 닫기').click();
    await expect(ganttOpener).toBeFocused();
    await expect.poll(() => hash(page)).toBe(`${gantt}&${new URLSearchParams({ ganttQ: f.prefix })}`);
    await expect(search).toHaveValue(f.prefix);
    expect(await elementIds(ganttRows)).toEqual(rendered.map(issue => issue.id));
  } finally { await f.close(); }
});
