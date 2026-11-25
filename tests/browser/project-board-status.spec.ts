import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { Issue, IssueStatusChangeRequest, IssueStatusChangeResult, ProjectIssueOrder, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types';

test.use({ hasTouch: true, viewport: { width: 360, height: 820 } });

const button = (within: Page | Locator, name: string) => within.getByRole('button', { name, exact: true });
const chooser = (page: Page) => page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
const destination = (page: Page) => chooser(page).getByRole('combobox', { name: '변경할 상태', exact: true });
const assigneeChoice = (page: Page) => chooser(page).getByRole('combobox', { name: '담당자', exact: true });
const group = (page: Page) => page.getByRole('combobox', { name: '보드 그룹', exact: true });
const search = (page: Page) => page.getByRole('textbox', { name: '업무 검색', exact: true });
const card = (page: Page, issue: Issue) => page.locator(`.issue-board-card[data-issue-id="${issue.id}"]`);
const statusAction = (page: Page, issue: Issue) => button(page, `${issue.key} 상태 변경`);
const issuePath = (issue: Issue) => `/api/issues/${issue.id}`;
const statusPath = (issue: Issue) => `${issuePath(issue)}/status-change`;
const verifyAction = (page: Page) => button(chooser(page), '저장 결과 다시 확인');

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

function changes(page: Page) {
  const paths: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PATCH' && (path.startsWith('/api/issues/') || path.endsWith('/issue-order')) ||
        request.method() === 'POST' && path.startsWith('/api/issues/') && path.endsWith('/status-change')) paths.push(path);
  });
  return paths;
}

function nextStatusChange(page: Page, issue: Issue) {
  return page.waitForResponse(response => new URL(response.url()).pathname === statusPath(issue) && response.request().method() === 'POST');
}

function checkStatusRequest(response: Response, fields: Omit<IssueStatusChangeRequest, 'requestId'>) {
  const input = response.request().postDataJSON() as IssueStatusChangeRequest;
  expect(input).toEqual({ ...fields, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
  return input;
}

async function fixture(request: APIRequestContext) {
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [project], users: [actor, newAssignee], restoreGeneration } = await workspace();
  if (!restoreGeneration) throw new Error('업무 상태 변경에 필요한 복원 세대가 없습니다.');
  const headers = { 'X-Actor-Id': actor.id };
  const tag = randomUUID().slice(0, 8);
  const prefix = `이관 보드 ${tag}`;
  const path = `/api/projects/${project.id}/workflow`;
  const readWorkflow = async () => json<ProjectWorkflow>(await request.get(path));
  const baseline = await readWorkflow();
  const ready = { id: `imported_${tag}`, label: `원본 검토 대기 ${tag}`, category: 'in_progress', color: '#586b9d' };
  const review = { id: `review_${tag}`, label: `팀 검토 ${tag}`, category: 'review', color: '#458576' };
  const guarded = { id: `check_${tag}`, label: `추가 검토 ${tag}`, category: 'review', color: '#446f98' };
  const finished = { id: `closed_${tag}`, label: `검토 마감 ${tag}`, category: 'done', color: '#4d8760' };
  const created: Issue[] = [];
  let view: SavedView | undefined;

  async function make(title: string, status: string, assigneeId: string | null = actor.id) {
    const issue = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId: project.id, title, status, assigneeId, type: '작업' },
    }), 201);
    created.push(issue);
    return issue;
  }

  return {
    project, actor, newAssignee, prefix, ready, review, guarded, finished, restoreGeneration,
    async setup({ grouped = false, layout = 'board' }: { grouped?: boolean; layout?: 'board' | 'list' } = {}) {
      const needsAssignee = layout === 'list';
      const workflow = await json<ProjectWorkflow>(await request.patch(path, { headers, data: {
        ...baseline, expectedVersion: baseline.version, statuses: [...baseline.statuses, ready, review, guarded, finished],
        transitions: [...baseline.transitions,
          { from: ready.id, to: review.id, issueTypes: ['작업'], requiredFields: needsAssignee ? ['assigneeId'] : [] },
          { from: ready.id, to: guarded.id, issueTypes: ['작업'], requiredFields: ['description'] },
          { from: ready.id, to: 'done', issueTypes: ['버그'], requiredFields: [] },
          { from: review.id, to: finished.id, issueTypes: ['작업'], requiredFields: [] },
        ],
      } }));
      await make(`필터에서 가린 이전 카드 ${tag}`, review.id);
      const issue = await make(`${prefix} 원본에서 옮긴 상태`, ready.id, needsAssignee ? null : actor.id);
      await make(`${prefix} 팀에서 작성한 기존 카드`, review.id);
      view = await json<SavedView>(await request.post('/api/views', { headers, data: {
        projectId: project.id, name: prefix, layout, ...(grouped ? { boardGrouping: 'assignee' } : {}),
        filters: { query: prefix, status: 'all', assigneeId: 'all', type: 'all' },
      } }), 201);
      return { issue, workflow, location: `/#/${project.id}/issues?${new URLSearchParams({ savedView: view.id })}` };
    },
    async removeGuarded(workflow: ProjectWorkflow) {
      return json<ProjectWorkflow>(await request.patch(path, { headers, data: {
        ...workflow, expectedVersion: workflow.version,
        transitions: workflow.transitions.filter(edge => edge.to !== guarded.id),
      } }));
    },
    async read(issue: Issue) { return (await workspace()).issues.find(value => value.id === issue.id); },
    async rank() { return json<ProjectIssueOrder>(await request.get(`/api/projects/${project.id}/issue-order`)); },
    async close() {
      if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`, { headers });
      for (const issue of created.reverse()) {
        const removed = await request.delete(issuePath(issue), { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
      const current = await readWorkflow();
      if (current.version !== baseline.version) {
        await json<ProjectWorkflow>(await request.patch(path, { headers, data: { ...baseline, expectedVersion: current.version } }));
      }
    },
  };
}

test('360px 프로젝트 목록에서 필수 담당자와 상태를 함께 저장하고 목록 위치를 유지한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  try {
    const { issue, workflow, location } = await f.setup({ layout: 'list' });
    const rank = await f.rank();
    const writes = changes(page);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(location);
    const row = page.locator(`tr[data-issue-id="${issue.id}"]`);
    const action = statusAction(page, issue);
    await expect(action).toHaveAccessibleDescription(f.ready.label);
    await expect(row.getByText('미지정', { exact: true })).toBeVisible();
    await action.press('Enter');
    await expect(destination(page)).toBeFocused();
    await destination(page).selectOption(f.review.id);
    await expect(assigneeChoice(page)).toHaveValue('');
    const apply = button(chooser(page), '상태 변경 적용');

    const rejecting = nextStatusChange(page, issue);
    await apply.tap();
    const rejected = await rejecting;
    expect(await json<{ details: unknown }>(rejected, 422)).toMatchObject({ details: { requiredFields: ['assigneeId'] } });
    const rejectedInput = checkStatusRequest(rejected, { restoreGeneration: f.restoreGeneration, expectedVersion: issue.version,
      expectedWorkflowVersion: workflow.version, status: f.review.id });
    await expect(chooser(page).getByRole('alert')).toContainText('담당자');
    await expect(destination(page)).toHaveValue(f.review.id);
    await expect(assigneeChoice(page)).toBeFocused();
    expect(await f.read(issue)).toEqual(issue);

    await assigneeChoice(page).selectOption(`user:${f.newAssignee.id}`);
    const applying = nextStatusChange(page, issue);
    await apply.tap();
    const applied = await applying;
    const appliedInput = checkStatusRequest(applied, { restoreGeneration: f.restoreGeneration, expectedVersion: issue.version,
      expectedWorkflowVersion: workflow.version, status: f.review.id, assigneeId: f.newAssignee.id });
    expect(appliedInput.requestId).not.toBe(rejectedInput.requestId);
    expect(await json<IssueStatusChangeResult>(applied)).toMatchObject({
      issue: { status: f.review.id, assigneeId: f.newAssignee.id, version: issue.version + 1 },
      receipt: { requestId: appliedInput.requestId, appliedVersion: issue.version + 1, commentId: null }, duplicate: false,
    });
    await expect(chooser(page)).toHaveCount(0);
    await expect(action).toContainText(f.review.label);
    await expect(action).toHaveAccessibleDescription(f.review.label);
    await expect(row.locator('.issue-assignee')).toContainText(f.newAssignee.name);
    await expect(action).toBeFocused();
    await expect(search(page)).toHaveValue(f.prefix);
    expect(new URL(page.url()).hash).toBe(location.slice(1));
    expect(writes).toEqual([statusPath(issue), statusPath(issue)]);
    expect((await f.rank()).issueIds).toEqual(rank.issueIds);
  } finally { await f.close(); }
});

test('360px 프로젝트 보드에서 키보드와 터치로 허용한 상태만 변경한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const f = await fixture(request);
  try {
    const { issue, workflow, location } = await f.setup();
    const rank = await f.rank();
    const writes = changes(page);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(location);
    const before = page.getByRole('region', { name: '업무 보드', exact: true });
    const action = statusAction(page, issue);
    await expect(before.locator(`[data-status-id="${f.ready.id}"]`).locator(card(page, issue))).toBeVisible();
    const bounds = await action.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(destination(page)).toBeFocused();
    await expect(destination(page).getByRole('option', { name: f.review.label, exact: true })).toBeAttached();
    await expect(destination(page).getByRole('option', { name: f.guarded.label, exact: true })).toBeAttached();
    await expect(destination(page).getByRole('option')).toHaveCount(3);
    await destination(page).selectOption(f.guarded.id);
    const blocked = nextStatusChange(page, issue);
    await button(chooser(page), '상태 변경 적용').tap();
    expect(await json<{ details: unknown }>(await blocked, 422)).toMatchObject({ details: { requiredFields: ['description'] } });
    await expect(chooser(page).getByRole('alert')).toContainText('설명');
    await expect(button(chooser(page), '업무 상세에서 확인')).toBeVisible();
    expect(await f.read(issue)).toEqual(issue);
    await page.keyboard.press('Escape');
    await expect(action).toBeFocused();

    await action.tap();
    await destination(page).selectOption(f.review.id);
    const applying = nextStatusChange(page, issue);
    await button(chooser(page), '상태 변경 적용').tap();
    const applied = await applying;
    const input = checkStatusRequest(applied, { restoreGeneration: f.restoreGeneration, expectedVersion: issue.version,
      expectedWorkflowVersion: workflow.version, status: f.review.id });
    expect(await json<IssueStatusChangeResult>(applied)).toMatchObject({
      issue: { status: f.review.id, assigneeId: f.actor.id, version: issue.version + 1 },
      receipt: { requestId: input.requestId, commentId: null },
    });
    await expect(chooser(page)).toHaveCount(0);
    await expect(before.locator(`[data-status-id="${f.review.id}"]`).locator(card(page, issue))).toBeVisible();
    await expect(action).toBeFocused();

    await group(page).selectOption('assignee');
    const lane = page.getByRole('region', { name: '담당자별 보드', exact: true }).locator(`[data-board-assignee-id="${f.actor.id}"]`);
    await expect(lane.locator(`[data-status-id="${f.review.id}"]`).locator(card(page, issue))).toBeVisible();
    await action.tap();
    await expect(destination(page)).toHaveValue(f.finished.id);
    const finishing = nextStatusChange(page, issue);
    await button(chooser(page), '상태 변경 적용').tap();
    expect(await json<IssueStatusChangeResult>(await finishing)).toMatchObject({
      issue: { status: f.finished.id, assigneeId: f.actor.id, version: issue.version + 2 },
      receipt: { commentId: null }, duplicate: false,
    });
    await expect(chooser(page)).toHaveCount(0);
    await expect(lane.locator(`[data-status-id="${f.finished.id}"]`).locator(card(page, issue))).toBeVisible();
    await expect(action).toBeDisabled();
    await expect(card(page, issue)).toBeFocused();
    await expect(search(page)).toHaveValue(f.prefix);
    await expect(group(page)).toHaveValue('assignee');
    expect(new URL(page.url()).hash).toBe(location.slice(1));
    expect(writes).toEqual(Array<string>(3).fill(statusPath(issue)));
    expect((await f.rank()).issueIds).toEqual(rank.issueIds);
  } finally { await f.close(); }
});

test('프로젝트 보드 상태 변경은 워크플로 충돌과 응답 유실에서 복구한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  try {
    const { issue, workflow, location } = await f.setup({ grouped: true });
    const rank = await f.rank();
    const writes = changes(page);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(location);
    const action = statusAction(page, issue);
    await action.tap();
    await destination(page).selectOption(f.guarded.id);
    const newWorkflow = await f.removeGuarded(workflow);
    await expect(destination(page)).toHaveValue(f.guarded.id);
    const stale = nextStatusChange(page, issue);
    await button(chooser(page), '상태 변경 적용').tap();
    const rejected = await stale;
    checkStatusRequest(rejected, { restoreGeneration: f.restoreGeneration, expectedVersion: issue.version,
      expectedWorkflowVersion: workflow.version, status: f.guarded.id });
    expect(await json<{ details: unknown }>(rejected, 409)).toMatchObject({ details: { reason: 'workflow_changed', currentWorkflowVersion: newWorkflow.version } });
    await expect(chooser(page).getByRole('alert')).toContainText('워크플로');
    expect(await f.read(issue)).toEqual(issue);
    await button(chooser(page), '최신 업무 불러오기').tap();
    await expect(chooser(page)).toHaveCount(0);
    await expect(action).toBeFocused();
    await action.tap();
    await expect(destination(page)).toHaveValue(f.review.id);
    await assigneeChoice(page).selectOption(`user:${f.newAssignee.id}`);

    let originalInput: IssueStatusChangeRequest | undefined;
    let committed: IssueStatusChangeResult | undefined;
    await page.route(`**${statusPath(issue)}`, async route => {
      const input = route.request().postDataJSON() as IssueStatusChangeRequest;
      if (originalInput) {
        expect(input).toEqual(originalInput);
        return route.continue();
      }
      originalInput = input;
      const response = await route.fetch();
      expect(input).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), restoreGeneration: f.restoreGeneration,
        expectedVersion: issue.version, expectedWorkflowVersion: newWorkflow.version, status: f.review.id, assigneeId: f.newAssignee.id });
      committed = await json<IssueStatusChangeResult>(response);
      await route.abort('failed');
    });
    await button(chooser(page), '상태 변경 적용').tap();
    await expect(verifyAction(page)).toBeFocused();
    const verifying = nextStatusChange(page, issue);
    await verifyAction(page).tap();
    expect(await json<IssueStatusChangeResult>(await verifying)).toEqual({ ...committed, duplicate: true });
    await expect(chooser(page)).toHaveCount(0);
    const lane = page.getByRole('region', { name: '담당자별 보드', exact: true }).locator(`[data-board-assignee-id="${f.newAssignee.id}"]`);
    await expect(lane.locator(`[data-status-id="${f.review.id}"]`).locator(card(page, issue))).toBeVisible();
    await expect(action).toBeFocused();
    expect(committed).toMatchObject({ issue: { status: f.review.id, assigneeId: f.newAssignee.id, version: issue.version + 1 },
      receipt: { requestId: originalInput?.requestId, commentId: null }, duplicate: false });
    expect(await f.read(issue)).toEqual(committed?.issue);
    expect(writes).toEqual(Array<string>(3).fill(statusPath(issue)));

    await page.unroute(`**${statusPath(issue)}`);
    await action.tap();
    await expect(destination(page)).toHaveValue(f.finished.id);
    await assigneeChoice(page).selectOption(`user:${f.actor.id}`);
    let conflictingInput: IssueStatusChangeRequest | undefined;
    await page.route(`**${statusPath(issue)}`, async route => {
      const input = route.request().postDataJSON() as IssueStatusChangeRequest;
      if (conflictingInput) {
        expect(input).toEqual(conflictingInput);
        return route.continue();
      }
      conflictingInput = input;
      const pending = { expectedVersion: issue.version + 1, expectedWorkflowVersion: newWorkflow.version, status: f.finished.id };
      expect(input).toEqual({ ...pending, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), restoreGeneration: f.restoreGeneration,
        assigneeId: f.actor.id });
      expect(input.requestId).not.toBe(originalInput?.requestId);
      await json<Issue>(await request.patch(issuePath(issue), {
        headers: { 'X-Actor-Id': f.newAssignee.id }, data: { ...pending, assigneeId: f.newAssignee.id },
      }));
      await route.abort('failed');
    });
    await button(chooser(page), '상태 변경 적용').tap();
    await expect(verifyAction(page)).toBeEnabled();
    const verifyConflict = nextStatusChange(page, issue);
    await verifyAction(page).tap();
    expect(await json<{ details: unknown }>(await verifyConflict, 409)).toMatchObject({ details: { currentVersion: issue.version + 2 } });
    await expect(chooser(page).getByRole('alert')).toContainText('다른 작업자가 변경했습니다.');
    await expect(assigneeChoice(page)).toHaveValue(`user:${f.actor.id}`);
    await button(chooser(page), '최신 업무 불러오기').tap();
    await expect(chooser(page)).toHaveCount(0);
    await expect(lane.locator(`[data-status-id="${f.finished.id}"]`).locator(card(page, issue))).toBeVisible();
    expect(await f.read(issue)).toMatchObject({ status: f.finished.id, assigneeId: f.newAssignee.id, version: issue.version + 2 });
    expect(writes).toEqual(Array<string>(5).fill(statusPath(issue)));
    expect((await f.rank()).issueIds).toEqual(rank.issueIds);
    expect(new URL(page.url()).hash).toBe(location.slice(1));
  } finally { await f.close(); }
});

test('보드는 응답이 끊겼을 때 같은 작업자의 다른 요청과 저장한 요청을 구분한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  try {
    const { issue, location } = await f.setup();
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(location);
    const dialog = chooser(page);
    await statusAction(page, issue).tap();
    await destination(page).selectOption(f.review.id);
    await assigneeChoice(page).selectOption(`user:${f.newAssignee.id}`);
    let originalInput: IssueStatusChangeRequest | undefined;
    await page.route(`**${statusPath(issue)}`, async route => {
      const input = route.request().postDataJSON() as IssueStatusChangeRequest;
      if (originalInput) {
        expect(input).toEqual(originalInput);
        return route.continue();
      }
      originalInput = input;
      expect(route.request().headers()['x-actor-id']).toBe(f.actor.id);
      const competingRequestId = randomUUID();
      expect(competingRequestId).not.toBe(input.requestId);
      const competing = await json<IssueStatusChangeResult>(await request.post(statusPath(issue), {
        headers: { 'X-Actor-Id': f.actor.id }, data: { ...input, requestId: competingRequestId },
      }));
      expect(competing).toMatchObject({ receipt: { requestId: competingRequestId, appliedVersion: issue.version + 1,
        commentId: null }, duplicate: false });
      await route.abort('failed');
    });

    await button(dialog, '상태 변경 적용').tap();
    await expect(verifyAction(page)).toBeEnabled();
    const retryUnapplied = nextStatusChange(page, issue);
    await verifyAction(page).tap();
    expect(await json<{ details: unknown }>(await retryUnapplied, 409)).toMatchObject({ details: { currentVersion: issue.version + 1 } });
    await expect(dialog.getByRole('alert')).toContainText('다른 작업자가 변경했습니다.');
    await expect(destination(page)).toHaveValue(f.review.id);
    await expect(assigneeChoice(page)).toHaveValue(`user:${f.newAssignee.id}`);
    expect(await f.read(issue)).toMatchObject({ status: f.review.id, assigneeId: f.newAssignee.id, version: issue.version + 1 });

    await button(dialog, '최신 업무 불러오기').tap();
    await expect(dialog).toHaveCount(0);
    const board = page.getByRole('region', { name: '업무 보드', exact: true });
    await expect(board.locator(`[data-status-id="${f.review.id}"]`).locator(card(page, issue))).toBeVisible();

    await page.unroute(`**${statusPath(issue)}`);
    await statusAction(page, issue).tap();
    await expect(destination(page)).toHaveValue(f.finished.id);
    await assigneeChoice(page).selectOption(`user:${f.actor.id}`);
    let appliedInput: IssueStatusChangeRequest | undefined;
    let saved: IssueStatusChangeResult | undefined;
    await page.route(`**${statusPath(issue)}`, async route => {
      const input = route.request().postDataJSON() as IssueStatusChangeRequest;
      if (appliedInput) {
        expect(input).toEqual(appliedInput);
        return route.continue();
      }
      appliedInput = input;
      expect(input.requestId).not.toBe(originalInput?.requestId);
      saved = await json<IssueStatusChangeResult>(await route.fetch());
      expect(saved).toMatchObject({ issue: { status: f.finished.id, assigneeId: f.actor.id, version: issue.version + 2 },
        receipt: { requestId: input.requestId, appliedVersion: issue.version + 2, commentId: null }, duplicate: false });
      await json<Issue>(await request.patch(issuePath(issue), {
        headers: { 'X-Actor-Id': f.newAssignee.id }, data: { expectedVersion: saved.issue.version, assigneeId: f.newAssignee.id },
      }));
      await route.abort('failed');
    });
    await button(dialog, '상태 변경 적용').tap();
    await expect(verifyAction(page)).toBeEnabled();
    const retryApplied = nextStatusChange(page, issue);
    await verifyAction(page).tap();
    const duplicate = await json<IssueStatusChangeResult>(await retryApplied);
    expect(duplicate).toMatchObject({ issue: { status: f.finished.id, assigneeId: f.newAssignee.id, version: issue.version + 3 },
      receipt: saved?.receipt, duplicate: true });
    await expect(dialog).toHaveCount(0);
    await expect(board.locator(`[data-status-id="${f.finished.id}"]`).locator(card(page, issue))).toBeVisible();
    expect(await f.read(issue)).toMatchObject({ status: f.finished.id, assigneeId: f.newAssignee.id, version: issue.version + 3 });
  } finally { await f.close(); }
});
