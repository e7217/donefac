import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Comment, CycleBoardMoveInput, CycleBoardMoveResult, Issue, IssueBulkEditPreview, IssueBulkEditResult, IssueStatusChangeRequest, IssueStatusChangeResult, PlanningItem, ProjectIssueOrder, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function fixture(request: APIRequestContext) {
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const issues: string[] = [], plans: string[] = [];
  const movePath = `/api/projects/${project.id}/cycle-board/move`;
  const createPath = `/api/projects/${project.id}/cycle-board/issues`;
  return {
    project, actor, peer, headers, suffix, movePath, createPath,
    order: async () => json<ProjectIssueOrder>(await request.get(`/api/projects/${project.id}/issue-order`)),
    trackIssue(issue: Issue) {
      if (!issues.includes(issue.id)) issues.push(issue.id);
    },
    async issue(title: string, fields: Partial<Issue> = {}) {
      const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
        projectId: project.id, title, priority: 'high', ...fields,
      } }), 201);
      issues.push(issue.id);
      return issue;
    },
    async plan(name: string, status: PlanningItem['status'] = 'planned') {
      const plan = await json<PlanningItem>(await request.post('/api/planning-items', { headers, data: {
        projectId: project.id, kind: 'cycle', name: `${name} ${suffix}`, status, startDate: '2026-11-23', endDate: '2026-11-27',
      } }), 201);
      plans.push(plan.id);
      return plan;
    },
    async close() {
      for (const id of issues.reverse()) {
        const removed = await request.delete(`/api/issues/${id}`, { headers });
        if (removed.ok()) {
          const { trashEntryId } = await removed.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`, { headers });
        }
      }
      for (const id of plans.reverse()) {
        const response = await request.get(`/api/planning-items/${id}`, { headers });
        if (!response.ok()) continue;
        const current = await response.json() as PlanningItem;
        await request.delete(`/api/planning-items/${id}?expectedVersion=${current.version}`, { headers });
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const rowSelector = (issue: Issue) => `[data-issue-id="${issue.id}"]`;

async function openBoard(page: Page, f: Fixture, from: 'issues' | 'backlog', cycle?: PlanningItem) {
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
  await page.goto(`/#/${f.project.id}/${from}${cycle ? `/${cycle.id}` : ''}`);
  if (from === 'issues') await page.locator('.issues-feature').getByRole('button', { name: '백로그 · 사이클', exact: true }).click();
  await expect(page.getByRole('heading', { name: '백로그 · 사이클', exact: true })).toBeVisible({ timeout: 30_000 });
  return {
    backlog: page.getByRole('region', { name: '백로그', exact: true }),
    lane: page.getByRole('region', { name: '선택한 사이클', exact: true }),
    search: page.getByRole('textbox', { name: '업무 검색', exact: true }),
    selectedCycle: page.getByRole('combobox', { name: '보고 있는 사이클', exact: true }),
  };
}

function waitMove(page: Page, f: Fixture) {
  return page.waitForResponse(response => new URL(response.url()).pathname === f.movePath && response.request().method() === 'POST');
}

function waitCreate(page: Page, f: Fixture) {
  return page.waitForResponse(response => new URL(response.url()).pathname === f.createPath && response.request().method() === 'POST');
}

async function openLaneCreation(page: Page, lane: Locator, target: '백로그' | '사이클') {
  await lane.getByRole('button', { name: `${target}에 업무 만들기`, exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: '새 업무 만들기', exact: true });
  const title = dialog.getByLabel('업무 제목', { exact: true });
  await expect(title).toBeFocused();
  return { dialog, title, submit: dialog.getByRole('button', { name: '업무 만들기', exact: true }) };
}

test('360px 백로그와 사이클에서 상태와 담당자를 함께 적용해 표시된 업무만 검토한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const cycle = await f.plan('업무 분류 사이클');
    const first = await f.issue(`분류할 첫 업무 ${f.suffix}`, { assigneeId: f.actor.id });
    const second = await f.issue(`분류할 둘째 업무 ${f.suffix}`, { assigneeId: f.actor.id, cycleId: cycle.id });
    const peerIssue = await f.issue(`동료의 업무 ${f.suffix}`, { assigneeId: f.peer.id });
    const unassigned = await f.issue(`담당자 미지정 업무 ${f.suffix}`, { cycleId: cycle.id });
    const hiddenBySearch = await f.issue('다른 제목으로 등록한 업무', { assigneeId: f.actor.id, cycleId: cycle.id });
    const workflow = (await workspace(request)).workflows?.find(item => item.projectId === f.project.id);
    const anotherStatus = workflow?.statuses.find(item => item.id !== first.status)?.id ?? (first.status === 'todo' ? 'in_progress' : 'todo');
    expect(anotherStatus).not.toBe(first.status);
    const another = await f.issue(`다른 상태의 업무 ${f.suffix}`, { assigneeId: f.actor.id, status: anotherStatus });
    const board = await openBoard(page, f, 'backlog', cycle);
    const status = page.getByRole('combobox', { name: '상태 필터', exact: true });
    const assignee = page.getByRole('combobox', { name: '담당자 필터', exact: true });
    await board.search.fill(f.suffix);
    await status.selectOption(first.status, { timeout: 8000 });
    await assignee.selectOption({ label: f.actor.name });
    const address = new URL(page.url()).hash;
    const row = (issue: Issue) => page.locator(rowSelector(issue));
    await expect(board.backlog.locator(rowSelector(first))).toBeVisible();
    await expect(board.lane.locator(rowSelector(second))).toBeVisible();
    for (const hidden of [peerIssue, unassigned, hiddenBySearch, another]) await expect(row(hidden)).toHaveCount(0);

    await row(first).getByRole('button', { name: `${first.key} · ${first.title}`, exact: true }).click();
    const review = page.getByRole('navigation', { name: '업무 검토 순서' });
    await expect(review.getByRole('status')).toHaveText('2개 중 1번째');
    await review.getByRole('button', { name: '다음 업무' }).click();
    await expect(page.getByRole('dialog', { name: second.title, exact: true })).toBeVisible();
    await page.goBack();
    await expect(row(first).getByRole('button', { name: `${first.key} · ${first.title}` })).toBeFocused();
    expect(new URL(page.url()).hash).toBe(address);
    await page.reload();
    await expect(status).toHaveValue(first.status);
    await expect(assignee.locator('option:checked')).toHaveText(f.actor.name);
    await expect(board.search).toHaveValue(f.suffix);

    const bulk = page.getByRole('button', { name: '일괄 편집', exact: true });
    await bulk.click();
    await page.getByRole('checkbox', { name: '표시된 업무 전체 선택', exact: true }).check();
    for (const issue of [first, second]) await expect(row(issue).getByRole('checkbox')).toBeChecked();
    await assignee.selectOption({ label: '담당자 미지정' });
    await expect(row(first)).toHaveCount(0);
    await expect(row(second)).toHaveCount(0);
    await expect(row(unassigned).getByRole('checkbox')).not.toBeChecked();
    await bulk.click();
    await page.getByRole('button', { name: '업무 필터 초기화', exact: true }).click();
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await expect(board.search).toHaveValue('');
    await expect(status).toHaveValue('');
    for (const issue of [peerIssue, another, hiddenBySearch]) await expect(row(issue)).toBeVisible();
  } finally {
    await f.close();
  }
});

test('360px 백로그와 사이클에서 상태·담당자·인수인계를 저장하고 원래 보드로 돌아온다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const cycle = await f.plan('인수인계 사이클');
    const filter = `상태 인수인계 ${f.suffix}`;
    const backlog = await f.issue(`${filter} 백로그`, { status: 'todo', assigneeId: f.actor.id });
    const assigned = await f.issue(`${filter} 사이클`, { status: 'todo', cycleId: cycle.id });
    const order = await f.order();
    const board = await openBoard(page, f, 'backlog', cycle);
    await board.search.fill(filter);
    const boardUrl = page.url();
    const action = (lane: Locator, issue: Issue) => lane.getByRole('button', { name: `${issue.key} 상태 변경`, exact: true });
    const opener = action(board.backlog, backlog);
    const bounds = await opener.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
    const status = dialog.getByRole('combobox', { name: '변경할 상태', exact: true });
    const assignee = dialog.getByRole('combobox', { name: '담당자', exact: true });
    const commentInput = dialog.getByRole('textbox', { name: '인수인계 댓글', exact: true });
    const apply = dialog.getByRole('button', { name: '상태 변경 적용', exact: true });
    await expect(status).toBeFocused();
    await status.selectOption('in_progress');
    await assignee.selectOption(`user:${f.peer.id}`);
    const handoff = '백로그 검토를 마쳤습니다. 새 담당자가 업무를 진행해 주세요.';
    await commentInput.fill(handoff);
    const declined = page.waitForEvent('dialog').then(async prompt => {
      expect(prompt.message()).toContain('인수인계 댓글');
      await prompt.dismiss();
    });
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await declined;
    await expect(commentInput).toHaveValue(handoff);

    const attempts: IssueStatusChangeRequest[] = [];
    const statusPath = `/api/issues/${backlog.id}/status-change`;
    await page.route(`**${statusPath}`, async route => {
      attempts.push(route.request().postDataJSON() as IssueStatusChangeRequest);
      if (attempts.length > 1) { await route.continue(); return; }
      const result = await json<IssueStatusChangeResult>(await route.fetch());
      expect(result.duplicate).toBe(false);
      await route.abort('failed');
    });
    await apply.click();
    const retry = dialog.getByRole('button', { name: '저장 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expect(commentInput).toHaveValue(handoff);
    const replay = page.waitForResponse(response => new URL(response.url()).pathname === statusPath && response.request().method() === 'POST');
    await retry.click();
    expect(await json<IssueStatusChangeResult>(await replay)).toMatchObject({
      issue: { id: backlog.id, status: 'in_progress', assigneeId: f.peer.id, version: backlog.version + 1 },
      duplicate: true,
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toHaveText('진행 중');
    await expect(opener).toBeFocused();
    const comments = await json<Comment[]>(await request.get(`/api/comments?resourceType=issue&resourceId=${backlog.id}`, { headers: f.headers }));
    expect(comments).toMatchObject([{ authorId: f.actor.id, body: handoff }]);

    const cycleOpener = action(board.lane, assigned);
    await cycleOpener.click();
    await status.selectOption('in_progress');
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(cycleOpener).toHaveText('진행 중');
    await expect(cycleOpener).toBeFocused();
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await expect(board.search).toHaveValue(filter);
    await expect(page).toHaveURL(boardUrl);
    expect((await f.order()).issueIds).toEqual(order.issueIds);
    const current = await workspace(request);
    expect(current.issues.find(issue => issue.id === assigned.id)).toMatchObject({ status: 'in_progress', cycleId: cycle.id });
    expect(current.issues.find(issue => issue.id === backlog.id)?.cycleId ?? null).toBeNull();
  } finally { await f.close(); }
});

test('사이클 카드가 동료 편집으로 보이지 않아도 상태와 인수인계 초안을 다시 확인한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  try {
    const cycle = await f.plan('현재 사이클');
    const other = await f.plan('이동할 사이클');
    const filter = `동시 인수인계 ${f.suffix}`;
    const issue = await f.issue(`${filter} 업무`, { status: 'todo', cycleId: cycle.id });
    const board = await openBoard(page, f, 'backlog', cycle);
    await board.search.fill(filter);
    const boardUrl = page.url();
    await board.lane.getByRole('button', { name: `${issue.key} 상태 변경`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
    const status = dialog.getByRole('combobox', { name: '변경할 상태', exact: true });
    const comment = dialog.getByRole('textbox', { name: '인수인계 댓글', exact: true });
    const apply = dialog.getByRole('button', { name: '상태 변경 적용', exact: true });
    await status.selectOption('in_progress');
    await comment.fill('새 사이클에서도 이어갈 인수인계입니다.');
    const issuePath = `/api/issues/${issue.id}`;
    const moved = await json<Issue>(await request.patch(issuePath, {
      headers: { 'X-Actor-Id': f.peer.id },
      data: { expectedVersion: issue.version, cycleId: other.id },
    }));
    expect(moved.cycleId).toBe(other.id);
    const conflict = page.waitForResponse(response => new URL(response.url()).pathname === `${issuePath}/status-change`);
    await apply.click();
    expect((await conflict).status()).toBe(409);
    await dialog.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(status).toBeEnabled();
    await expect(comment).toHaveValue('새 사이클에서도 이어갈 인수인계입니다.');
    await status.selectOption('in_progress');
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(board.search).toBeFocused();
    await expect(board.search).toHaveValue(filter);
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await expect(page).toHaveURL(boardUrl);
    await expect(board.lane.locator(rowSelector(issue))).toHaveCount(0);
    const current = await workspace(request);
    expect(current.issues.find(item => item.id === issue.id)).toMatchObject({
      status: 'in_progress', cycleId: other.id, version: moved.version + 1,
    });
    expect(await json<Comment[]>(await request.get(`/api/comments?resourceType=issue&resourceId=${issue.id}`, { headers: f.headers })))
      .toMatchObject([{ authorId: f.actor.id, body: '새 사이클에서도 이어갈 인수인계입니다.' }]);
  } finally { await f.close(); }
});

test('360px 백로그와 선택한 사이클의 업무를 표시 순서로 검토하고 원래 행으로 돌아온다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const cycle = await f.plan('검토할 사이클');
    const other = await f.plan('검토 범위 밖 사이클');
    const filter = `업무 검토 ${f.suffix}`;
    const backlog = await f.issue(`${filter} 백로그`);
    const assigned = await f.issue(`${filter} 사이클`, { cycleId: cycle.id });
    const outside = await f.issue(`${filter} 다른 사이클`, { cycleId: other.id });
    const hidden = await f.issue(`검색에서 숨긴 업무 ${f.suffix}`, { cycleId: cycle.id });
    const board = await openBoard(page, f, 'backlog', cycle);
    await board.search.fill(filter);
    const route = `#/${f.project.id}/backlog/${cycle.id}`;
    const matchesRoute = (url: URL, issueId?: string) => {
      const [path, query] = url.hash.split('?');
      const params = new URLSearchParams(query);
      return path === route && params.get('cycleQ') === filter && params.get('issue') === (issueId ?? null);
    };
    const opener = board.backlog.getByRole('button', { name: `${backlog.key} · ${backlog.title}`, exact: true });
    const panel = (issue: Issue) => page.getByRole('dialog', { name: issue.title, exact: true });
    const review = (issue: Issue) => panel(issue).getByRole('navigation', { name: '업무 검토 순서' });
    const next = (issue: Issue) => review(issue).getByRole('button', { name: '다음 업무', exact: true });
    const previous = (issue: Issue) => review(issue).getByRole('button', { name: '이전 업무', exact: true });
    const saveBacklogIssue = () => page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${backlog.id}` &&
      response.request().method() === 'PATCH');
    await expect(board.lane.locator(rowSelector(assigned))).toBeVisible();
    await expect(page.locator(rowSelector(outside))).toHaveCount(0);
    await expect(page.locator(rowSelector(hidden))).toHaveCount(0);

    await opener.click();
    await expect(review(backlog).getByRole('status')).toHaveText('2개 중 1번째');
    await expect(next(backlog)).toHaveAttribute('title', assigned.key);
    const title = panel(backlog).getByLabel('제목', { exact: true });
    await title.fill('작성 중인 업무 제목');
    const cancel = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.message()).toMatch(/저장하지 않은/);
      await dialog.dismiss();
    });
    await next(backlog).click();
    await cancel;
    await expect(title).toHaveValue('작성 중인 업무 제목');
    await expect(page).toHaveURL(url => matchesRoute(url, backlog.id));

    const discard = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await next(backlog).click();
    await discard;
    await expect(review(assigned).getByRole('status')).toHaveText('2개 중 2번째');
    await expect(previous(assigned)).toHaveAttribute('title', backlog.key);
    await expect(next(assigned)).toBeDisabled();
    await expect(page).toHaveURL(url => matchesRoute(url, assigned.id));

    await page.goBack();
    await expect(page).toHaveURL(url => matchesRoute(url));
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await expect(board.search).toHaveValue(filter);
    await expect(opener).toBeFocused();
    await page.goForward();
    await expect(review(assigned).getByRole('status')).toHaveText('2개 중 2번째');
    await panel(assigned).getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(opener).toBeFocused();
    await expect(page).toHaveURL(url => matchesRoute(url));

    await opener.click();
    await panel(backlog).getByRole('combobox', { name: '사이클', exact: true }).selectOption(cycle.id);
    const move = saveBacklogIssue();
    await panel(backlog).getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect(await json<Issue>(await move)).toMatchObject({ id: backlog.id, cycleId: cycle.id });
    await expect(board.backlog.locator(rowSelector(backlog))).toHaveCount(0);
    await expect(board.lane.locator(rowSelector(backlog))).toHaveCount(1);
    await expect(next(backlog)).toHaveAttribute('title', assigned.key);
    await panel(backlog).getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    const movedOpener = board.lane.getByRole('button', { name: `${backlog.key} · ${backlog.title}`, exact: true });
    await expect(movedOpener).toBeFocused();

    const renamed = { ...backlog, title: `검색 밖으로 옮긴 업무 ${f.suffix}` };
    await movedOpener.click();
    await panel(backlog).getByLabel('제목', { exact: true }).fill(renamed.title);
    const patch = saveBacklogIssue();
    await page.locator('.issue-detail-panel').getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect(await json<Issue>(await patch)).toMatchObject({ id: backlog.id, title: renamed.title });
    await expect(page.locator(rowSelector(backlog))).toHaveCount(0);
    await expect(review(renamed).getByRole('status')).toHaveText(/2개 중 [12]번째/);
    await panel(renamed).getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(board.search).toBeFocused();
    await expect(board.search).toHaveValue(filter);

    await page.goto(`/${route}?${new URLSearchParams({ cycleQ: filter, issue: assigned.id })}`);
    await page.reload();
    await expect(panel(assigned)).toBeVisible();
    await expect(review(assigned)).toHaveCount(0);
  } finally { await f.close(); }
});

test('360px 사이클과 백로그에서 비어 있는 간트 날짜로 이동하고 선택한 사이클과 검색으로 돌아온다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const other = await f.plan('다른 사이클');
    const cycle = await f.plan('날짜를 채울 사이클');
    const filter = `업무 일정 ${f.suffix}`;
    const startDate = '2026-11-24', endDate = '2026-11-27';
    const assigned = await f.issue(`${filter} 사이클 업무`, { cycleId: cycle.id, startDate: null, endDate });
    const backlog = await f.issue(`${filter} 백로그 업무`, { startDate: null, endDate: null });
    const outside = await f.issue(`${filter} 다른 사이클 업무`, { cycleId: other.id, startDate, endDate });
    const board = await openBoard(page, f, 'backlog');
    await board.selectedCycle.selectOption(cycle.id);
    await board.search.fill(filter);
    const boardPath = `#/${f.project.id}/backlog/${cycle.id}`;
    function matchesBoard(url: URL) {
      const [path, query] = url.hash.split('?');
      return path === boardPath && new URLSearchParams(query).get('cycleQ') === filter;
    }
    async function expectBoard() {
      await expect(page).toHaveURL(matchesBoard);
      await expect(board.selectedCycle).toHaveValue(cycle.id);
      await expect(board.search).toHaveValue(filter);
    }
    await expectBoard();
    const assignedCard = board.lane.locator(`[data-cycle-board-card="${assigned.id}"]`);
    const backlogCard = board.backlog.locator(`[data-cycle-board-card="${backlog.id}"]`);
    await expect(assignedCard.getByText('시작일 미정', { exact: true })).toBeVisible();
    await expect(assignedCard.locator(`time[datetime="${endDate}"]`)).toHaveText(endDate);
    await expect(backlogCard.getByText('종료일 미정', { exact: true })).toBeVisible();
    await expect(board.lane.locator(`[data-cycle-board-card="${outside.id}"]`)).toHaveCount(0);

    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = (value: Issue) => chart.locator(`[data-issue-id="${value.id}"]`);
    const start = (value: Issue) => row(value).getByLabel(`${value.key} 시작일`, { exact: true });
    const ganttPath = `#/${f.project.id}/gantt`;
    const linkedOnly = page.getByRole('checkbox', { name: '연결된 업무만', exact: true });
    const expectStartFocus = async (path: string, value: Issue) => {
      await expect(page).toHaveURL(url => {
        const [route, query] = url.hash.split('?');
        const params = new URLSearchParams(query);
        return route === path && params.get('focusIssue') === value.id && params.get('focusDate') === 'startDate';
      });
      await expect(start(value)).toBeFocused();
      await expect(start(value)).toHaveValue('');
    };
    await assignedCard.getByRole('button', { name: `${assigned.key} 간트에서 날짜 입력`, exact: true }).click();
    await expectStartFocus(`${ganttPath}/${cycle.id}`, assigned);
    await expect(linkedOnly).toBeChecked();
    await expect(row(outside)).toHaveCount(0);
    await expect(row(backlog)).toHaveCount(0);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/manual-apply' && response.request().method() === 'POST');
    await start(assigned).fill(startDate);
    await start(assigned).press('Enter');
    expect(await json<{ updated: Issue[] }>(await saving)).toMatchObject({ updated: [{ id: assigned.id, cycleId: cycle.id, startDate, endDate }] });
    await expect(row(assigned).getByRole('button', { name: `${assigned.key} 날짜 저장`, exact: true })).toHaveCount(0);
    await page.goBack();
    await expectBoard();
    await expect(assignedCard.locator(`time[datetime="${startDate}"]`)).toHaveText(startDate);
    await expect(assignedCard.locator(`time[datetime="${endDate}"]`)).toHaveText(endDate);
    await expect(assignedCard.getByRole('button', { name: `${assigned.key} 간트에서 일정 보기`, exact: true })).toBeVisible();

    await backlogCard.getByRole('button', { name: `${backlog.key} 간트에서 날짜 입력`, exact: true }).click();
    await expectStartFocus(ganttPath, backlog);
    await expect(row(outside)).toBeVisible();
    await page.goBack();
    await expectBoard();
    await expect(backlogCard.getByText('시작일 미정', { exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test('360px 백로그에서 업무를 만들고 검색에서 숨겨진 결과를 표시한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const cycle = await f.plan('백로그와 함께 보는 사이클');
    const board = await openBoard(page, f, 'backlog', cycle);
    const query = `검색 범위 밖 ${f.suffix}`;
    await board.search.fill(query);
    const { dialog, title, submit } = await openLaneCreation(page, board.backlog, '백로그');
    await expect(dialog.getByText('등록 위치 · 백로그', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: '프로젝트', exact: true })).toBeDisabled();
    const summary = `백로그에서 바로 만드는 업무 ${f.suffix}`;
    await title.fill(summary);
    const saved = waitCreate(page, f);
    await submit.click();
    const response = await saved;
    const issue = await json<Issue>(response, 201);
    f.trackIssue(issue);
    expect(response.request().postDataJSON()).toMatchObject({ targetCycle: null, issue: { title: summary } });
    expect(issue).toMatchObject({ projectId: f.project.id, title: summary, cycleId: null });
    await expect(dialog).toHaveCount(0);
    await expect(board.search).toHaveValue(query);
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await expect(board.backlog.locator(rowSelector(issue))).toHaveCount(0);
    await expect(board.lane.locator(rowSelector(issue))).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: issue.key })).toContainText('현재 검색 조건에서 숨겨져 있습니다.');

    const show = page.getByRole('button', { name: '만든 업무 보기', exact: true });
    await expect(show).toBeFocused();
    await show.press('Enter');
    await expect(board.search).toHaveValue('');
    const opened = board.backlog.locator(rowSelector(issue)).getByRole('button', { name: `${issue.key} · ${summary}`, exact: true });
    await expect(opened).toBeFocused();
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await expect(board.lane.locator(rowSelector(issue))).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe(`#/${f.project.id}/backlog/${cycle.id}`);
  } finally { await f.close(); }
});

test('360px 사이클 생성 중 바뀐 등록 위치를 다시 확인하고 응답 유실 뒤 업무를 한 번만 만든다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const planned = await f.plan('계획 상태로 열어 두는 사이클');
    const first = await f.issue(`먼저 등록한 업무 ${f.suffix}`, { cycleId: planned.id });
    const hidden = await f.issue('순위를 보존할 검색 밖 업무', { cycleId: planned.id });
    const originalOrder = await f.order();
    const board = await openBoard(page, f, 'backlog', planned);
    await board.search.fill(f.suffix);
    await expect(board.lane.locator(rowSelector(first))).toBeVisible();
    await expect(board.lane.locator(rowSelector(hidden))).toHaveCount(0);
    const { dialog, title, submit } = await openLaneCreation(page, board.lane, '사이클');
    await expect(dialog.getByText(planned.name, { exact: true })).toBeVisible();
    const summary = `사이클 열에서 만든 업무 ${f.suffix}`;
    const start = dialog.getByLabel('시작일', { exact: true });
    const end = dialog.getByLabel('종료일', { exact: true });
    const dates = { startDate: '2026-11-24', endDate: '2026-11-26' };
    await title.fill(summary);
    await start.fill(dates.startDate);
    await end.fill(dates.endDate);
    async function expectDraft() {
      await expect(title).toHaveValue(summary);
      await expect(start).toHaveValue(dates.startDate);
      await expect(end).toHaveValue(dates.endDate);
    }

    const attempts: { body: string; actorId?: string }[] = [];
    let active: PlanningItem | undefined, committed: Issue | undefined;
    const activeName = `진행 중으로 바뀐 사이클 ${f.suffix}`;
    await page.route(url => url.pathname === f.createPath, async route => {
      const sent = route.request();
      attempts.push({ body: sent.postData()!, actorId: sent.headers()['x-actor-id'] });
      if (attempts.length === 1) {
        active = await json<PlanningItem>(await request.patch(`/api/planning-items/${planned.id}`, {
          headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: planned.version, name: activeName, status: 'active' },
        }));
        return route.continue();
      }
      if (attempts.length === 2) {
        committed = await json<Issue>(await route.fetch(), 201);
        f.trackIssue(committed);
        return route.abort('failed');
      }
      return route.continue();
    });
    const stale = waitCreate(page, f);
    await submit.click();
    const conflict = await stale;
    expect(conflict.status(), await conflict.text()).toBe(409);
    expect(await conflict.json()).toMatchObject({ details: { reason: 'target_cycle_changed' } });
    expect(conflict.request().postDataJSON()).toMatchObject({ targetCycle: { id: planned.id, expectedVersion: planned.version },
      issue: { title: summary, ...dates } });
    await expect(dialog.getByRole('alert')).toContainText('사이클');
    await expectDraft();
    expect((await workspace(request)).issues.some(issue => issue.title === summary)).toBe(false);
    expect(await f.order()).toEqual(originalOrder);
    await dialog.getByRole('button', { name: '최신 사이클 사용', exact: true }).click();
    await expect(dialog.getByText(activeName, { exact: true })).toBeVisible();
    await expect(title).toBeFocused();
    await expectDraft();

    await submit.click();
    const retry = dialog.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expectDraft();
    await expect(title).toBeDisabled();
    expect(committed).toMatchObject({ title: summary, cycleId: planned.id, ...dates });
    const updatedInput = JSON.parse(attempts[1].body);
    expect(updatedInput).toMatchObject({ targetCycle: { id: planned.id, expectedVersion: active!.version },
      issue: { title: summary, ...dates } });
    expect(updatedInput.requestId).not.toBe(JSON.parse(attempts[0].body).requestId);
    expect(attempts[1].actorId).toBe(f.actor.id);

    const repeated = waitCreate(page, f);
    await retry.click();
    const replay = await json<Issue>(await repeated);
    expect(replay).toEqual(committed);
    expect(attempts).toEqual([attempts[0], attempts[1], attempts[1]]);
    const current = await workspace(request);
    expect(current.issues.filter(issue => issue.title === summary)).toEqual([replay]);
    expect(current.activities.filter(activity => activity.resourceId === replay.id && activity.action === '티켓 생성')).toHaveLength(1);
    const newOrder = await f.order();
    expect(newOrder.issueIds.filter(id => id !== replay.id)).toEqual(originalOrder.issueIds);
    expect(newOrder.issueIds.filter(id => [first.id, hidden.id, replay.id].includes(id))).toEqual([first.id, hidden.id, replay.id]);

    await expect(dialog).toHaveCount(0);
    await expect(board.selectedCycle).toHaveValue(planned.id);
    await expect(board.search).toHaveValue(f.suffix);
    await expect(board.lane.getByRole('heading', { name: activeName, exact: true })).toBeVisible();
    await expect(board.backlog.locator(rowSelector(replay))).toHaveCount(0);
    await expect(board.lane.getByRole('button', { name: `${replay.key} · ${summary}`, exact: true })).toBeFocused();
  } finally { await f.close(); }
});

test('작성 중 사이클이 보관되면 초안을 유지하고 직접 선택한 백로그에 저장한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    const selected = await f.plan('열어 둔 계획 사이클');
    const other = await f.plan('다른 진행 중인 사이클', 'active');
    const board = await openBoard(page, f, 'backlog', selected);
    await board.search.fill(f.suffix);
    await expect(board.selectedCycle).toHaveValue(selected.id);
    const { dialog, title, submit } = await openLaneCreation(page, board.lane, '사이클');
    const summary = `보관된 사이클의 업무 초안 ${f.suffix}`;
    await title.fill(summary);
    await dialog.getByText('추가 속성', { exact: true }).click();
    const due = dialog.getByLabel('목표 마감일', { exact: true });
    await due.fill('2026-11-30');
    await page.route(url => url.pathname === f.createPath, async route => {
      await json<PlanningItem>(await request.patch(`/api/planning-items/${selected.id}`, {
        headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: selected.version, status: 'archived' },
      }));
      await route.continue();
    }, { times: 1 });
    const stale = waitCreate(page, f);
    await submit.click();
    const rejection = await stale;
    expect(rejection.status(), await rejection.text()).toBe(409);
    expect(rejection.request().postDataJSON()).toMatchObject({ targetCycle: { id: selected.id, expectedVersion: selected.version } });
    const switchToBacklog = dialog.getByRole('button', { name: '백로그로 등록 위치 변경', exact: true });
    await expect(switchToBacklog).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(title).toHaveValue(summary);
    await expect(due).toHaveValue('2026-11-30');
    expect(new URL(page.url()).hash).not.toContain(other.id);
    expect((await workspace(request)).issues.some(issue => issue.title === summary)).toBe(false);

    await switchToBacklog.click();
    await expect(dialog.getByText('등록 위치 · 백로그', { exact: true })).toBeVisible();
    await expect(title).toBeFocused();
    await expect(title).toHaveValue(summary);
    await expect(due).toHaveValue('2026-11-30');
    const saving = waitCreate(page, f);
    await submit.click();
    const response = await saving;
    const issue = await json<Issue>(response, 201);
    f.trackIssue(issue);
    expect(response.request().postDataJSON()).toMatchObject({ targetCycle: null, issue: { title: summary, dueDate: '2026-11-30' } });
    expect(issue).toMatchObject({ projectId: f.project.id, title: summary, cycleId: null, dueDate: '2026-11-30' });
    await expect(dialog).toHaveCount(0);
    await expect(board.search).toHaveValue(f.suffix);
    await expect(board.selectedCycle).toHaveValue('');
    await expect(board.backlog.getByRole('button', { name: `${issue.key} · ${summary}`, exact: true })).toBeFocused();
    await expect(board.lane.locator(rowSelector(issue))).toHaveCount(0);
    expect(new URL(page.url()).hash).not.toContain(other.id);
  } finally { await f.close(); }
});

test('360px 백로그에서 사이클로 보내고 응답 유실 뒤 같은 결과를 확인해 순위를 조정한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const cycle = await f.plan('다음 사이클');
    const completed = await f.plan('완료한 과거 사이클', 'completed');
    const source = await f.issue(`먼저 정할 업무 ${f.suffix}`, { startDate: '2026-11-24', endDate: '2026-11-25', assigneeId: f.peer.id });
    const visible = await f.issue(`보이는 배정 업무 ${f.suffix}`, { cycleId: cycle.id });
    const hidden = await f.issue('검색 밖 배정 업무', { cycleId: cycle.id });
    const board = await openBoard(page, f, 'issues');
    await board.selectedCycle.selectOption(cycle.id);
    await expect(board.lane.getByRole('heading', { name: cycle.name, exact: true })).toBeVisible();
    await expect(board.selectedCycle.locator(`option[value="${completed.id}"]`)).toHaveCount(0);
    await board.search.fill(f.suffix);
    await expect(board.lane.locator(rowSelector(hidden))).toHaveCount(0);
    const backlogRow = board.backlog.locator(rowSelector(source));
    await expect(backlogRow).toContainText(f.peer.name);
    const selectMove = backlogRow.getByRole('button', { name: `${source.key} 사이클 이동`, exact: true });
    await selectMove.press('Enter');
    const dialog = page.getByRole('dialog', { name: '사이클 이동', exact: true });
    const destination = dialog.getByRole('combobox', { name: '이동할 사이클', exact: true });
    await expect(destination).toBeFocused();
    await expect(destination.getByRole('option', { name: completed.name, exact: true })).toHaveCount(0);
    await destination.selectOption({ label: cycle.name });

    const attempts: CycleBoardMoveInput[] = [];
    let saved: CycleBoardMoveResult | undefined;
    await page.route(`**${f.movePath}`, async route => {
      attempts.push(route.request().postDataJSON() as CycleBoardMoveInput);
      if (attempts.length > 1) return route.continue();
      saved = await json<CycleBoardMoveResult>(await route.fetch());
      await route.abort('failed');
    });
    await dialog.getByRole('button', { name: '이동 적용', exact: true }).click();
    const retry = page.getByRole('button', { name: '이동 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    expect(saved?.issue.cycleId).toBe(cycle.id);
    expect(attempts[0]).toMatchObject({ issueId: source.id, sourceCycle: null, targetCycle: { id: cycle.id, expectedVersion: cycle.version },
      anchorId: null, position: 'after' });
    const pendingReplay = waitMove(page, f);
    await retry.click();
    const replay = await json<CycleBoardMoveResult>(await pendingReplay);
    expect(replay).toEqual({ ...saved, duplicate: true });
    expect(attempts[1]).toEqual(attempts[0]);
    await page.unroute(`**${f.movePath}`);
    await expect(board.backlog.locator(rowSelector(source))).toHaveCount(0);
    const moved = board.lane.locator(rowSelector(source));
    await expect(moved.getByRole('button', { name: `${source.key} · ${source.title}`, exact: true })).toBeFocused();
    expect(replay.issue).toMatchObject({ status: source.status, assigneeId: source.assigneeId, startDate: source.startDate, endDate: source.endDate });
    expect(replay.order.issueIds.filter(id => [visible.id, hidden.id, source.id].includes(id))).toEqual([visible.id, hidden.id, source.id]);

    const pendingRank = waitMove(page, f);
    await moved.getByRole('button', { name: `${source.key} 위로 이동`, exact: true }).press('Enter');
    const rank = await json<CycleBoardMoveResult>(await pendingRank);
    expect(rank.order.issueIds.filter(id => [visible.id, hidden.id, source.id].includes(id))).toEqual([source.id, visible.id, hidden.id]);
    expect(rank.issue.version).toBe(replay.issue.version);
    await expect(board.lane.locator('[data-issue-id]').first()).toHaveAttribute('data-issue-id', source.id);
    await expect(board.search).toHaveValue(f.suffix);
    expect(await page.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);
    await page.reload();
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await board.search.fill(f.suffix);
    await expect(board.lane.locator('[data-issue-id]').first()).toHaveAttribute('data-issue-id', source.id);
  } finally { await f.close(); }
});

test('사이클로 실제 드래그할 때 동시 변경을 막고 최신 그룹의 기준 업무 앞에 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  try {
    const destination = await f.plan('드래그 대상');
    const source = await f.issue(`끌어 놓을 업무 ${f.suffix}`);
    const anchor = await f.issue(`순위 기준 업무 ${f.suffix}`, { cycleId: destination.id });
    const board = await openBoard(page, f, 'backlog', destination);
    await board.search.fill(f.suffix);
    const sourceRow = board.backlog.locator(rowSelector(source));
    const target = board.lane.locator(rowSelector(anchor));
    let updated: PlanningItem | undefined;
    await page.route(`**${f.movePath}`, async route => {
      if (!updated) updated = await json<PlanningItem>(await request.patch(`/api/planning-items/${destination.id}`, {
        headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: destination.version, name: `${destination.name} 수정` },
      }));
      await route.continue();
    });
    const pendingConflict = waitMove(page, f);
    await sourceRow.dragTo(target, { targetPosition: { x: 28, y: 6 } });
    expect((await pendingConflict).status()).toBe(409);
    await expect(page.getByRole('alert')).toContainText('최신 업무를 불러온 뒤');
    await expect(sourceRow).toBeVisible();
    await expect(board.lane.locator(rowSelector(source))).toHaveCount(0);
    const beforeRank = await f.order();
    const expected = { issueId: source.id, anchorId: anchor.id, position: 'before',
      targetCycle: { id: destination.id, expectedVersion: updated?.version } };
    await page.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(board.lane.getByRole('heading', { name: updated!.name, exact: true })).toBeVisible();
    await expect(sourceRow).toHaveAttribute('draggable', 'true');
    const pendingMove = waitMove(page, f);
    await sourceRow.dragTo(target, { targetPosition: { x: 28, y: 6 } });
    const response = await pendingMove;
    expect(response.request().postDataJSON()).toMatchObject(expected);
    const moved = await json<CycleBoardMoveResult>(response);
    expect(moved.issue.cycleId).toBe(destination.id);
    expect(moved.order.issueIds.filter(id => id !== source.id)).toEqual(beforeRank.issueIds.filter(id => id !== source.id));
    await expect(board.lane.locator('[data-issue-id]').first()).toHaveAttribute('data-issue-id', source.id);
    await expect(sourceRow).toHaveCount(0);
  } finally { await f.close(); }
});

test('응답을 잃은 뒤 업무가 다시 옮겨졌으면 재확인에서 현재 사이클을 표시한다', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const firstCycle = await f.plan('처음 계획');
    const laterCycle = await f.plan('그다음 계획');
    const source = await f.issue(`사이클을 다시 바꾼 업무 ${f.suffix}`);
    const board = await openBoard(page, f, 'backlog', firstCycle);
    await board.search.fill(f.suffix);
    const moves: CycleBoardMoveInput[] = [];
    let recorded: CycleBoardMoveResult | undefined;
    await page.route(`**${f.movePath}`, async route => {
      moves.push(route.request().postDataJSON() as CycleBoardMoveInput);
      if (moves.length > 1) return route.continue();
      recorded = await json<CycleBoardMoveResult>(await route.fetch());
      await route.abort('failed');
    });
    await board.backlog.getByRole('button', { name: `${source.key} 사이클 이동`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '사이클 이동', exact: true });
    await dialog.getByRole('combobox', { name: '이동할 사이클', exact: true }).selectOption({ label: firstCycle.name });
    await dialog.getByRole('button', { name: '이동 적용', exact: true }).click();
    const retry = page.getByRole('button', { name: '이동 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    expect(recorded?.issue.cycleId).toBe(firstCycle.id);
    const latest = await json<Issue>(await request.patch(`/api/issues/${source.id}`, {
      headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: recorded!.issue.version, cycleId: laterCycle.id },
    }));
    const pendingReplay = waitMove(page, f);
    await retry.click();
    const replay = await json<CycleBoardMoveResult>(await pendingReplay);
    expect(replay.duplicate).toBe(true);
    expect(replay.issue).toEqual(latest);
    expect(moves).toEqual([moves[0], moves[0]]);
    await expect(retry).toHaveCount(0);
    await expect(board.selectedCycle).toHaveValue(laterCycle.id);
    await expect(board.lane.getByRole('button', { name: `${source.key} · ${source.title}`, exact: true })).toBeFocused();
    await expect(board.search).toHaveValue(f.suffix);
  } finally { await f.close(); }
});

test('360px 백로그에서 표시된 업무를 한 번에 사이클에 배정하고 재시도에도 보드 문맥을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  try {
    const cycle = await f.plan('함께 배정할 사이클');
    const first = await f.issue(`계획 대상 첫 업무 ${f.suffix}`, { startDate: '2026-11-24', assigneeId: f.actor.id });
    const second = await f.issue(`계획 대상 둘째 업무 ${f.suffix}`, { endDate: '2026-11-27' });
    const hidden = await f.issue('검색 밖 백로그 업무');
    const existing = await f.issue('검색 밖 사이클 업무', { cycleId: cycle.id });
    const order = await f.order();
    const read = async (id: string) => (await workspace(request)).issues.find(issue => issue.id === id);
    const board = await openBoard(page, f, 'backlog', cycle);
    await board.search.fill(f.suffix);
    const boardAddress = new URL(page.url()).hash;
    const toggle = page.getByRole('button', { name: '일괄 편집', exact: true });
    await toggle.click();
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    const selectVisible = page.getByRole('checkbox', { name: '표시된 업무 전체 선택', exact: true });
    await expect(selectVisible).toBeFocused();
    await selectVisible.check();
    const selected = (issue: Issue) => board.backlog.getByRole('checkbox', { name: `${issue.key} 업무 선택`, exact: true });
    await expect(selected(first)).toBeChecked();
    await expect(selected(second)).toBeChecked();
    await expect(selected(hidden)).toHaveCount(0);
    await expect(board.backlog.getByRole('button', { name: '백로그에 업무 만들기', exact: true })).toBeDisabled();
    const target = editor.getByRole('combobox', { name: '일괄 변경 사이클', exact: true });
    await target.selectOption(`plan:${cycle.id}`);

    const bulkPath = `/api/projects/${f.project.id}/issues/bulk`;
    const applied = () => page.waitForResponse(response => new URL(response.url()).pathname === `${bulkPath}-apply`);
    const preview = editor.getByRole('region', { name: '일괄 변경 미리보기', exact: true });
    async function checkPreview() {
      const reviewing = page.waitForResponse(response => new URL(response.url()).pathname === `${bulkPath}-preview`);
      await editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
      const response = await reviewing;
      const { previewId, rows } = await json<IssueBulkEditPreview>(response);
      expect(previewId).toBeTruthy();
      expect(response.request().postDataJSON().changes).toEqual({ cycleId: cycle.id });
      expect(rows.map(row => row.id)).toEqual([first.id, second.id]);
      for (const issue of [first, second]) {
        const row = preview.getByRole('listitem').filter({ hasText: `${issue.key} ${issue.title}` });
        await expect(row).toContainText(`사이클 없음 → ${cycle.name}`);
      }
      return previewId;
    }

    const outdated = await checkPreview();
    const changed = await json<Issue>(await request.patch(`/api/issues/${second.id}`, {
      headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: second.version, assigneeId: f.peer.id },
    }));
    const rejected = applied();
    await preview.getByRole('button', { name: '일괄 적용', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    expect(await read(first.id)).toEqual(first);
    expect(await read(second.id)).toEqual(changed);
    await editor.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(selected(first)).toBeChecked();
    await expect(selected(second)).toBeChecked();
    await expect(target).toHaveValue(`plan:${cycle.id}`);
    const reviewed = await checkPreview();
    expect(reviewed).not.toBe(outdated);

    const requests: string[] = [];
    await page.route(`**${bulkPath}-apply`, async route => {
      requests.push(route.request().postDataJSON().previewId);
      if (requests.length > 1) return route.continue();
      const committed = await json<IssueBulkEditResult>(await route.fetch());
      expect(committed.updated.map(issue => issue.id)).toEqual([first.id, second.id]);
      await route.abort('failed');
    });
    await preview.getByRole('button', { name: '일괄 적용', exact: true }).click();
    const retry = preview.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    await expect(board.selectedCycle).toBeDisabled();
    await expect(board.search).toBeDisabled();
    const replay = applied();
    await retry.click();
    await json<IssueBulkEditResult>(await replay);
    expect(requests).toEqual([reviewed, reviewed]);
    await expect(board.lane.locator(rowSelector(first))).toBeVisible();
    await expect(board.lane.locator(rowSelector(second))).toBeVisible();
    await expect(board.backlog.locator(rowSelector(first))).toHaveCount(0);
    await expect(board.selectedCycle).toHaveValue(cycle.id);
    await expect(board.search).toHaveValue(f.suffix);
    expect(new URL(page.url()).hash).toBe(boardAddress);
    expect((await f.order()).issueIds).toEqual(order.issueIds);
    for (const issue of [first, changed]) expect(await read(issue.id)).toMatchObject({
      version: issue.version + 1, cycleId: cycle.id, status: issue.status, assigneeId: issue.assigneeId,
      startDate: issue.startDate, endDate: issue.endDate,
    });
    expect(await read(hidden.id)).toEqual(hidden);
    expect(await read(existing.id)).toEqual(existing);
    await editor.getByRole('button', { name: '일괄 편집 닫기', exact: true }).click();
    await expect(toggle).toBeFocused();
    expect(await page.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);
  } finally { await f.close(); }
});
