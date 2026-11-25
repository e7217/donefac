import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Issue, IssueStatusChangeRequest, IssueStatusChangeResult, Project, ProjectIssueOrder, ProjectWorkflow, WorkflowStatus, WorkspaceSnapshot } from '../../shared/types';

const name = '전체 프로젝트 보드';
const button = (within: Locator | Page, label: string) => within.getByRole('button', { name: label, exact: true });
const teamPath = (project: Project) => `#/${project.id}/teamboard`;
const issuePath = (issue: Issue) => `/api/issues/${issue.id}`;
const statusPath = (issue: Issue) => `${issuePath(issue)}/status-change`;
const workflowPath = (project: Project) => `/api/projects/${project.id}/workflow`;
const orderPath = (project: Project) => `/api/projects/${project.id}/issue-order`;
const board = (page: Page) => page.getByRole('region', { name, exact: true });
const column = (page: Page, category: string) => board(page).locator(`[data-status-category="${category}"]`);
const card = (page: Page, issue: Issue) => board(page).locator(`[data-issue-id="${issue.id}"]`);
const inside = (page: Page, category: string, issue: Issue) => column(page, category).locator(`[data-issue-id="${issue.id}"]`);
const search = (page: Page) => page.getByLabel('보드 업무 검색', { exact: true });
const chooser = (page: Page) => page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
const destination = (page: Page) => chooser(page).getByRole('combobox', { name: '변경할 상태', exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const waitPatch = (page: Page, path: string) => page.waitForResponse(response =>
  new URL(response.url()).pathname === path && response.request().method() === 'PATCH');
const waitStatusChange = (page: Page, issue: Issue) => page.waitForResponse(response =>
  new URL(response.url()).pathname === statusPath(issue) && response.request().method() === 'POST');
const statusChangeInput = (fields: Pick<IssueStatusChangeRequest, 'status' | 'assigneeId' | 'expectedVersion' | 'expectedWorkflowVersion'>) => ({
  ...fields, requestId: expect.any(String), restoreGeneration: expect.any(String),
});

function trackIssueWrites(page: Page) {
  const paths: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if ((method === 'PATCH' && (path.startsWith('/api/issues/') || path.endsWith('/issue-order'))) ||
        (method === 'POST' && path.startsWith('/api/issues/') && path.endsWith('/status-change'))) paths.push(path);
  });
  return paths;
}

function route(page: Page) {
  const [path, query] = new URL(page.url()).hash.split('?');
  const params = new URLSearchParams(query);
  return { path, project: params.get('boardProject'), member: params.get('boardMember'), query: params.get('boardQuery'), issue: params.get('issue') };
}

async function statusOptions(page: Page) {
  return destination(page).locator('option').evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
}

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const prefix = `팀 보드 ${suffix}`;
  const sharedId = `shared_${suffix}`;
  const firstLabel = `첫 프로젝트 검토 ${suffix}`;
  const secondLabel = `둘째 프로젝트 작업 ${suffix}`;
  const secondReview = { id: `peer_review_${suffix}`, label: `둘째 프로젝트 상세 검토 ${suffix}`, category: 'review', color: '#5478af' } as const;
  const firstOnly = { id: `first_review_${suffix}`, label: `첫 프로젝트 전용 검토 ${suffix}`, category: 'review', color: '#6188a7' } as const;
  const readWorkflow = async (project: Project) => json<ProjectWorkflow>(await request.get(workflowPath(project)));
  const original = await Promise.all([readWorkflow(first), readWorkflow(second)]);
  const created: Issue[] = [];

  async function issue(project: Project, title: string, assigneeId: string, status = sharedId) {
    const result = await json<Issue>(await request.post('/api/issues', {
      headers, data: { title: `${prefix} ${title}`, projectId: project.id, status, assigneeId },
    }), 201);
    created.push(result);
    return result;
  }

  return {
    first, second, actor, prefix, firstLabel, secondLabel, secondReview,
    async configure() {
      const [left, right] = original;
      const transitions = (to: string, requiredFields: ProjectWorkflow['transitions'][number]['requiredFields'] = []) =>
        ({ from: sharedId, to, issueTypes: [], requiredFields });
      const common = { id: sharedId, color: '#418274' };
      const configure = async (project: Project, before: ProjectWorkflow, statuses: WorkflowStatus[], edges: ProjectWorkflow['transitions']) =>
        json<ProjectWorkflow>(await request.patch(workflowPath(project), { headers, data: {
          ...before, expectedVersion: before.version, statuses: [...before.statuses, ...statuses], transitions: [...before.transitions, ...edges],
        } }));
      await configure(first, left, [{ ...common, label: firstLabel, category: 'review' }, firstOnly], [transitions(firstOnly.id)]);
      const workflow = await configure(second, right, [{ ...common, label: secondLabel, category: 'in_progress' }, secondReview],
        [transitions('review'), transitions(secondReview.id, ['description']), transitions('in_progress')]);
      const west = await issue(first, '첫째 업무', actor.id);
      const east = await issue(second, '둘째 업무', actor.id);
      const someoneElse = await issue(second, '다른 담당자', peer.id, 'todo');
      return { west, east, someoneElse, workflow };
    },
    async ranks() {
      return Promise.all([first, second].map(async project => json<ProjectIssueOrder>(await request.get(orderPath(project)))));
    },
    async read(issue: Issue) {
      return (await workspace(request)).issues.find(value => value.id === issue.id);
    },
    async close() {
      try {
        for (const issue of created.reverse()) {
          const removed = await request.delete(issuePath(issue), { headers });
          if (!removed.ok()) continue;
          const { trashEntryId } = await removed.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`, { headers });
        }
      } finally {
        // Remove the synthetic issues before restoring workflows that lack their custom states.
        for (const [index, project] of [first, second].entries()) {
          const baseline = original[index];
          const current = await readWorkflow(project);
          if (current.version === baseline.version) continue;
          await json<ProjectWorkflow>(await request.patch(workflowPath(project), { headers, data: {
            ...baseline, expectedVersion: current.version,
            transitions: baseline.transitions.map(edge => ({ ...edge, requireResolvedBlockers: edge.requireResolvedBlockers === true })),
          } }));
        }
      }
    },
  };
}

test('360px 전체 프로젝트 보드에서 실제 상태를 선택하고 티켓과 필터를 다시 연다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const f = await fixture(request);
  try {
    const { west, east, someoneElse, workflow } = await f.configure();
    const ranks = await f.ranks();
    const writes = trackIssueWrites(page);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/#/${f.first.id}/overview`);
    await button(page, '메뉴 열기').click();
    await button(page, name).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await search(page).fill(f.prefix);
    await expect(inside(page, 'review', west)).toBeVisible();
    await expect(inside(page, 'in_progress', east)).toBeVisible();
    await expect(card(page, west).locator('[data-board-status]')).toHaveText(f.firstLabel);
    await expect(card(page, east).locator('[data-board-status]')).toHaveText(f.secondLabel);
    await expect(card(page, east).locator('[data-board-project]')).toHaveText(`${f.second.key} · ${f.second.name}`);
    await expect(inside(page, 'todo', someoneElse)).toBeVisible();

    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const memberFilter = page.getByRole('combobox', { name: '담당자 필터', exact: true });
    await projectFilter.selectOption(f.second.id);
    await memberFilter.selectOption({ label: f.actor.name });
    const filtered = { path: teamPath(f.first), project: f.second.id, member: f.actor.id, query: f.prefix, issue: null };
    await expect.poll(() => route(page)).toEqual(filtered);
    await expect(card(page, west)).toHaveCount(0);
    await expect(card(page, someoneElse)).toHaveCount(0);
    await expect(card(page, east)).toBeVisible();

    async function openTransitions() {
      await button(card(page, east), `${east.key} 상태 변경`).click();
      await expect(chooser(page)).toBeVisible();
      const bounds = await chooser(page).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
      expect((await statusOptions(page)).sort()).toEqual(['in_progress', 'review', f.secondReview.id].sort());
      await expect(destination(page)).toHaveValue('');
      await expect(button(chooser(page), '상태 변경 적용')).toBeDisabled();
      await destination(page).selectOption(f.secondReview.id);
    }

    await openTransitions();
    await destination(page).press('Control+k');
    await expect(page.getByRole('dialog', { name: '통합 검색', exact: true, includeHidden: true })).toHaveCount(0);
    await expect(destination(page)).toBeFocused();
    await expect(destination(page)).toHaveValue(f.secondReview.id);
    const blocked = waitStatusChange(page, east);
    await button(chooser(page), '상태 변경 적용').click();
    expect(await json<{ details: unknown }>(await blocked, 422)).toMatchObject({ details: { requiredFields: ['description'] } });
    await expect(chooser(page).getByRole('alert')).toContainText('설명');
    await expect(destination(page)).toHaveValue(f.secondReview.id);
    expect(await f.read(east)).toEqual(east);
    expect(await f.ranks()).toEqual(ranks);

    await button(chooser(page), '업무 상세에서 확인').click();
    const drawer = page.getByRole('dialog', { name: east.title, exact: true });
    await expect(chooser(page)).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ ...filtered, issue: east.id });
    await page.reload();
    await expect(drawer).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ ...filtered, issue: east.id });
    const description = '검토 전 필수 설명을 업무 상세에서 작성했습니다.';
    await drawer.getByLabel('설명', { exact: true }).fill(description);
    const changingDetails = waitPatch(page, issuePath(east));
    await button(drawer, '변경사항 저장').click();
    const detailed = await json<Issue>(await changingDetails);
    expect(detailed).toMatchObject({ id: east.id, projectId: f.second.id, status: east.status, description });
    await expect(button(drawer, '변경사항 저장')).toBeDisabled();
    await button(drawer, '업무 상세 닫기').click();
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => route(page)).toEqual(filtered);
    await expect(projectFilter).toHaveValue(f.second.id);
    await expect(memberFilter.locator('option:checked')).toHaveText(f.actor.name);
    await expect(search(page)).toHaveValue(f.prefix);
    await expect(card(page, west)).toHaveCount(0);
    await expect(card(page, someoneElse)).toHaveCount(0);
    await expect(inside(page, 'in_progress', east)).toBeVisible();

    await openTransitions();
    const changing = waitStatusChange(page, east);
    await button(chooser(page), '상태 변경 적용').click();
    const accepted = await changing;
    expect(accepted.request().postDataJSON()).toEqual(statusChangeInput({
      expectedVersion: detailed.version, expectedWorkflowVersion: workflow.version, status: f.secondReview.id,
    }));
    const { issue: moved } = await json<IssueStatusChangeResult>(accepted);
    expect(moved).toMatchObject({ id: east.id, projectId: f.second.id, status: f.secondReview.id, version: detailed.version + 1 });
    await expect(chooser(page)).toHaveCount(0);
    await expect(inside(page, 'review', east).locator('[data-board-status]')).toHaveText(f.secondReview.label);
    await expect(inside(page, 'in_progress', east)).toHaveCount(0);
    await expect(button(card(page, east), `${east.key} 상태 변경`)).toBeDisabled();
    await expect(button(card(page, east), `${east.key} 업무 열기`)).toBeFocused();
    await page.reload();
    await expect.poll(() => route(page)).toEqual(filtered);
    await expect(inside(page, 'review', east)).toBeVisible();
    expect(writes).toEqual([statusPath(east), issuePath(east), statusPath(east)]);
    expect(await f.read(west)).toEqual(west);
    expect(await f.read(east)).toEqual(moved);
    const updatedRanks = await f.ranks();
    expect(updatedRanks[0]).toEqual(ranks[0]);
    expect(updatedRanks[1].issueIds).toEqual(ranks[1].issueIds);
    expect(updatedRanks[1].version).not.toBe(ranks[1].version);

    const onlyPeer = { ...filtered, member: someoneElse.assigneeId };
    await memberFilter.selectOption(`member:${someoneElse.assigneeId}`);
    await expect.poll(() => route(page)).toEqual(onlyPeer);
    await button(card(page, someoneElse), `${someoneElse.key} 상태 변경`).click();
    await destination(page).selectOption('in_progress');
    await chooser(page).getByRole('combobox', { name: '담당자', exact: true }).selectOption(`user:${f.actor.id}`);
    const assigning = waitStatusChange(page, someoneElse);
    await button(chooser(page), '상태 변경 적용').click();
    const assignedResponse = await assigning;
    expect(assignedResponse.request().postDataJSON()).toEqual(statusChangeInput({ expectedVersion: someoneElse.version,
      expectedWorkflowVersion: workflow.version, status: 'in_progress', assigneeId: f.actor.id }));
    const { issue: assigned } = await json<IssueStatusChangeResult>(assignedResponse);
    expect(assigned).toMatchObject({ status: 'in_progress', assigneeId: f.actor.id, version: someoneElse.version + 1 });
    await expect(chooser(page)).toHaveCount(0);
    await expect(card(page, someoneElse)).toHaveCount(0);
    await expect(board(page)).toBeFocused();
    await expect.poll(() => route(page)).toEqual(onlyPeer);
    expect(await f.read(someoneElse)).toEqual(assigned);
    expect(writes).toEqual([statusPath(east), issuePath(east), statusPath(east), statusPath(someoneElse)]);
  } finally {
    await f.close();
  }
});

test('팀 보드에서 다른 프로젝트 카드가 있는 열에 끌어도 업무 상태만 적용한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const f = await fixture(request);
  try {
    const { west, east, workflow } = await f.configure();
    const ranks = await f.ranks();
    const writes = trackIssueWrites(page);
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${teamPath(f.first)}?${new URLSearchParams({ boardQuery: f.prefix })}`);
    await expect(inside(page, 'in_progress', east)).toBeVisible();
    await expect(inside(page, 'review', west)).toBeVisible();
    await card(page, east).dragTo(card(page, west), { targetPosition: { x: 34, y: 10 } });
    await expect(chooser(page)).toBeVisible();
    expect((await statusOptions(page)).sort()).toEqual(['review', f.secondReview.id].sort());
    await expect(destination(page)).toHaveValue('');
    await expect(button(chooser(page), '상태 변경 적용')).toBeDisabled();
    expect(writes).toEqual([]);
    expect(await f.read(east)).toEqual(east);
    expect(await f.ranks()).toEqual(ranks);

    await destination(page).selectOption('review');
    const applying = waitStatusChange(page, east);
    await button(chooser(page), '상태 변경 적용').click();
    const response = await applying;
    expect(response.request().postDataJSON()).toEqual(statusChangeInput({
      status: 'review', expectedVersion: east.version, expectedWorkflowVersion: workflow.version,
    }));
    const { issue: moved } = await json<IssueStatusChangeResult>(response);
    expect(moved).toMatchObject({ id: east.id, projectId: f.second.id, status: 'review' });
    await expect(chooser(page)).toHaveCount(0);
    await expect(inside(page, 'review', west)).toBeVisible();
    await expect(inside(page, 'review', east)).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ path: teamPath(f.first), project: null, member: null, query: f.prefix, issue: null });
    expect(writes).toEqual([statusPath(east)]);
    expect(await f.read(west)).toEqual(west);
    expect(await f.read(east)).toEqual(moved);
    const updatedRanks = await f.ranks();
    expect(updatedRanks[0]).toEqual(ranks[0]);
    expect(updatedRanks[1].issueIds).toEqual(ranks[1].issueIds);
  } finally {
    await f.close();
  }
});

test('팀 보드에서 워크플로 변경을 확인한 뒤 응답이 유실된 상태 변경을 한 번만 저장한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  try {
    const { west, east, workflow } = await f.configure();
    const ranks = await f.ranks();
    const writes = trackIssueWrites(page);
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${teamPath(f.first)}?${new URLSearchParams({ boardQuery: f.prefix })}`);
    const dropForReview = async () => {
      await card(page, east).dragTo(card(page, west), { targetPosition: { x: 34, y: 10 } });
      await expect(chooser(page)).toBeVisible();
    };
    const apply = button(chooser(page), '상태 변경 적용');
    await dropForReview();
    await destination(page).selectOption(f.secondReview.id);
    const changed = await json<ProjectWorkflow>(await request.patch(workflowPath(f.second), {
      headers: { 'X-Actor-Id': f.actor.id }, data: {
        ...workflow, expectedVersion: workflow.version,
        statuses: workflow.statuses.map(status => status.id === f.secondReview.id ? { ...status, category: 'done' } : status),
      },
    }));
    expect(changed.version).toBeGreaterThan(workflow.version);
    expect(await f.read(east)).toEqual(east);

    const stale = waitStatusChange(page, east);
    await apply.click();
    const rejected = await stale;
    expect(rejected.request().postDataJSON()).toEqual(statusChangeInput({
      status: f.secondReview.id, expectedVersion: east.version, expectedWorkflowVersion: workflow.version,
    }));
    expect(await json<{ details: unknown }>(rejected, 409)).toMatchObject({ details: { reason: 'workflow_changed', currentWorkflowVersion: changed.version } });
    await expect(chooser(page).getByRole('alert')).toContainText('워크플로');
    await expect(destination(page)).toHaveValue(f.secondReview.id);
    await expect(destination(page)).toBeDisabled();
    expect(await f.read(east)).toEqual(east);
    expect(await f.ranks()).toEqual(ranks);
    await button(chooser(page), '최신 업무 불러오기').click();
    await expect(chooser(page)).toHaveCount(0);
    await dropForReview();
    expect(await statusOptions(page)).toEqual(['review']);
    await expect(destination(page)).toHaveValue('review');

    const submitted: IssueStatusChangeRequest[] = [];
    let committed: IssueStatusChangeResult | undefined;
    await page.route(`**${statusPath(east)}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (submitted.length === 1) {
        committed = await json<IssueStatusChangeResult>(response);
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await apply.click();
    const confirm = button(chooser(page), '저장 결과 다시 확인');
    await expect(confirm).toBeVisible();
    expect(committed).toMatchObject({ duplicate: false,
      issue: { status: 'review', id: east.id, projectId: f.second.id, version: east.version + 1 },
      receipt: { requestId: submitted[0].requestId, appliedVersion: east.version + 1, commentId: null },
    });
    expect(await f.read(east)).toEqual(committed!.issue);
    const verifying = waitStatusChange(page, east);
    await confirm.click();
    const verified = await json<IssueStatusChangeResult>(await verifying);
    expect(verified).toEqual({ ...committed, duplicate: true });
    await expect(chooser(page)).toHaveCount(0);
    await expect(inside(page, 'review', east)).toBeVisible();
    await expect(inside(page, 'in_progress', east)).toHaveCount(0);
    await page.reload();
    await expect(inside(page, 'review', east)).toBeVisible();
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toEqual(statusChangeInput({ status: 'review', expectedVersion: east.version, expectedWorkflowVersion: changed.version }));
    expect(submitted[1]).toEqual(submitted[0]);
    expect(writes).toEqual([statusPath(east), statusPath(east), statusPath(east)]);
    expect(await f.read(east)).toEqual(verified.issue);
    const updatedRanks = await f.ranks();
    expect(updatedRanks[0]).toEqual(ranks[0]);
    expect(updatedRanks[1].issueIds).toEqual(ranks[1].issueIds);
  } finally {
    await f.close();
  }
});
