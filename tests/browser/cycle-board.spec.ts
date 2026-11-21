import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { CycleBoardMoveInput, CycleBoardMoveResult, Issue, PlanningItem, ProjectIssueOrder, WorkspaceSnapshot } from '../../shared/types';

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
  return {
    project, actor, peer, headers, suffix, movePath,
    order: async () => json<ProjectIssueOrder>(await request.get(`/api/projects/${project.id}/issue-order`)),
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
      for (const id of plans.reverse()) await request.delete(`/api/planning-items/${id}`, { headers });
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
