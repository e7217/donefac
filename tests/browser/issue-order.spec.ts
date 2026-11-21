import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { DocPage, Issue, Project, ProjectIssueOrder, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types';

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

test('담당자와 상태 사이에서 카드를 옮기고 360px에서 공유 보드와 전체 업무 한도를 확인한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 1440, height: 1400 });
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [firstAssignee, nextAssignee, emptyAssignee] = snapshot.users;
  const suffix = randomUUID().slice(0, 8);
  const projectResponse = await request.post('/api/projects', { data: { key: `BD${suffix.toUpperCase()}`, name: `담당자별 보드 ${suffix}` } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = await projectResponse.json() as Project;
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const filter = `묶음 보기 ${suffix}`;
  const created: Issue[] = [];
  let view: SavedView | undefined;

  async function issue(label: string, assigneeId: string | null, status = 'todo', visible = true) {
    const made = await request.post('/api/issues', { data: {
      title: `${visible ? filter : '현재 보기에서 가린 업무'} ${label}`, projectId: project.id, assigneeId, status,
    } });
    expect(made.status(), await made.text()).toBe(201);
    const value = await made.json() as Issue;
    created.push(value);
    return value;
  }

  try {
    const workflow = await (await request.get(workflowPath)).json() as ProjectWorkflow;
    const configured = await request.patch(workflowPath, { data: {
      ...workflow, expectedVersion: workflow.version,
      statuses: workflow.statuses.map(status => status.id === 'in_progress' ? { ...status, wipLimit: 1 } : status),
    } });
    expect(configured.ok(), await configured.text()).toBeTruthy();
    const moving = await issue('이동할 업무', firstAssignee.id);
    const anchor = await issue('도착 위치', nextAssignee.id, 'in_progress');
    const hidden = await issue('한도 계산 기준', nextAssignee.id, 'in_progress', false);
    const unassigned = await issue('미지정 업무', null);
    await page.goto(`/#/${project.id}/issues`);
    await page.getByLabel('업무 검색', { exact: true }).fill(filter);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    const grouping = page.getByRole('combobox', { name: '보드 그룹', exact: true });
    await grouping.selectOption('assignee');
    const board = page.getByRole('region', { name: '담당자별 보드', exact: true });
    const lane = (id: string) => board.locator(`[data-board-assignee-id="${id}"]`);
    const cell = (assigneeId: string, status: string) => lane(assigneeId).locator(`.issue-board-column[data-status-id="${status}"]`);
    const card = (id: string) => board.locator(`.issue-board-card[data-issue-id="${id}"]`);
    await expect(card(moving.id)).toBeVisible();
    await expect(cell(firstAssignee.id, 'todo').locator(`[data-issue-id="${moving.id}"]`)).toHaveCount(1);
    await expect(cell('', 'todo').locator(`[data-issue-id="${unassigned.id}"]`)).toHaveCount(1);
    await expect(lane(emptyAssignee.id)).toHaveCount(0);
    const showEmpty = page.getByRole('checkbox', { name: '빈 담당자 그룹 표시', exact: true });
    await showEmpty.check();
    await expect(lane(emptyAssignee.id)).toHaveCount(1);
    await showEmpty.uncheck();
    const capacity = page.getByRole('button', { name: '진행 중 한도 초과 업무 보기', exact: true });
    await expect(capacity).toContainText('1개 초과');
    await expect(card(hidden.id)).toHaveCount(0);

    const sourceBounds = await card(moving.id).boundingBox();
    const targetBounds = await card(anchor.id).boundingBox();
    expect(sourceBounds).not.toBeNull();
    expect(targetBounds).not.toBeNull();
    const from = { x: sourceBounds!.x + 32, y: sourceBounds!.y + 16 };
    const to = { x: targetBounds!.x + 25, y: targetBounds!.y + 6 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 14, from.y);
    await page.mouse.move(to.x, to.y, { steps: 16 });
    await page.mouse.move(to.x + 4, to.y);
    const dropping = expectMove(page, project.id);
    await page.mouse.up();
    const response = await dropping;
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(response.request().postDataJSON()).toMatchObject({ issueId: moving.id, anchorId: anchor.id, position: 'before',
      status: 'in_progress', targetAssigneeId: nextAssignee.id, assigneeId: nextAssignee.id });
    const moved = await response.json() as MoveResponse;
    expect(moved.issue).toMatchObject({ assigneeId: nextAssignee.id, status: 'in_progress', version: moving.version + 1 });
    await expect.poll(() => issueIds(cell(nextAssignee.id, 'in_progress').locator('.issue-board-card'))).toEqual([moving.id, anchor.id]);
    await expect(capacity).toContainText('2개 초과');

    await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    await dialog.getByLabel('보기 이름', { exact: true }).fill(filter);
    const saved = page.waitForResponse(value => value.url().endsWith('/api/views') && value.request().method() === 'POST');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    view = await (await saved).json() as SavedView;
    expect(view).toMatchObject({ layout: 'board', boardGrouping: 'assignee', filters: { query: filter } });
    await expect(page).toHaveURL(new RegExp(`savedView=${view.id}`));
    await page.setViewportSize({ width: 360, height: 820 });
    await page.reload();
    await expect(grouping).toHaveValue('assignee');
    await expect(cell(nextAssignee.id, 'in_progress').locator(`[data-issue-id="${moving.id}"]`)).toHaveCount(1);
    expect(await page.locator('body').evaluate(body => body.scrollWidth)).toBeLessThanOrEqual(362);
    await capacity.click();
    const wholeStatus = page.getByRole('region', { name: '진행 중 한도 업무', exact: true });
    await expect(wholeStatus).toContainText('프로젝트 전체 3개');
    await expect(wholeStatus).toContainText('현재 보드 필터 밖 1개');
    await expect(wholeStatus).toContainText(hidden.title);
    await wholeStatus.getByRole('button', { name: '한도 업무 닫기', exact: true }).click();

    await card(moving.id).focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('dialog', { name: moving.title, exact: true });
    await expect(details.getByRole('combobox', { name: '담당자', exact: true })).toHaveValue(nextAssignee.id);
    await expect(details.getByRole('combobox', { name: '상태', exact: true })).toHaveValue('in_progress');
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '간트 공유 보기', exact: true })).toHaveValue(view.id);
    await expect(page.getByRole('status', { name: '간트에 표시된 업무', exact: true })).toHaveText('4개 중 3개 업무');
    await page.goto(`/#/${project.id}/issues?savedView=${view.id}`);
    await expect(grouping).toHaveValue('assignee');
    await grouping.selectOption('');
    await page.getByRole('button', { name: '보기 수정', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '저장된 보기 수정', exact: true });
    const edited = page.waitForResponse(value => value.url().endsWith(`/api/views/${view?.id}`) && value.request().method() === 'PATCH');
    await edit.getByRole('button', { name: '저장', exact: true }).click();
    const editResponse = await edited;
    expect(editResponse.ok(), await editResponse.text()).toBeTruthy();
    expect(editResponse.request().postDataJSON()).toMatchObject({ boardGrouping: null });
    view = await editResponse.json() as SavedView;
    expect(view).not.toHaveProperty('boardGrouping');
    await page.reload();
    await expect(grouping).toHaveValue('');
    await expect(board).toHaveCount(0);
  } finally {
    if (view) {
      const views = await (await request.get(`/api/views?projectId=${project.id}`)).json() as SavedView[];
      const latest = views.find(item => item.id === view?.id);
      if (latest) await request.delete(`/api/views/${latest.id}?expectedVersion=${latest.version}`);
    }
    for (const value of created) {
      const deleted = await request.delete(`/api/issues/${value.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});
