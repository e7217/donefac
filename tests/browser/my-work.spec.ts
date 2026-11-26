import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Comment, Issue, IssueBulkEditPreview, IssueStatusChangeRequest, ProjectWorkflow, TeamIssueBulkEditPreviewInput, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'Asia/Seoul' });

test('내 업무 검색은 전체 페이지를 검색하고 참여 조건과 검토 순서를 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const initial = await request.get('/api/workspace');
  expect(initial.ok(), await initial.text()).toBe(true);
  const { projects: [projectA, projectB], users } = await initial.json() as WorkspaceSnapshot;
  const [actor, peer] = users;
  const prefix = `개인 대기열 ${randomUUID().slice(0, 8)}`;
  const headers = { 'X-Actor-Id': actor.id };
  const created: Issue[] = [];
  const row = (issue: Issue) => page.locator(`[data-issue-review-id="${issue.id}"]`);

  async function create(label: string, projectId: string, dueDate: string, fields: Partial<Issue> = {}) {
    const response = await request.post('/api/issues', { headers, data: { projectId, title: `${prefix} ${label}`, dueDate,
      assigneeId: peer.id, collaboratorIds: [actor.id], reporterId: null, status: 'todo', ...fields } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  try {
    for (let count = 1; count <= 21; count++) await create(`일반 확인 ${count}`, projectA.id, '2026-07-10');
    const late = await create('장비 방송 검토', projectB.id, '2026-07-16');
    const today = await create('장비 현장 검토', projectA.id, '2026-07-17');
    const excluded = await create('장비 역할 외 검토', projectB.id, '2026-07-17', { assigneeId: actor.id, collaboratorIds: [] });
    const closed = await create('장비 완료 업무', projectB.id, '2026-07-17', { status: 'done' });

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.clock.setFixedTime(new Date('2026-07-16T16:00:00Z'));
    const queueHash = `#/${projectA.id}/mywork`;
    await page.goto(`/${queueHash}`);
    const role = page.getByRole('combobox', { name: '참여 범위', exact: true });
    const projectFilter = page.getByRole('combobox', { name: '프로젝트', exact: true });
    const closedFilter = page.getByRole('checkbox', { name: '완료·취소 포함', exact: true });
    const search = page.getByRole('searchbox', { name: '업무 검색', exact: true });
    await role.selectOption('collaborating');
    await expect(row(late)).toHaveCount(0);

    const pager = page.getByRole('navigation', { name: '마감 초과 페이지', exact: true });
    await pager.getByRole('button', { name: '다음', exact: true }).click();
    await expect(row(late)).toBeVisible();
    await search.fill(`${prefix} 일반 확인`);
    await expect(pager.getByText('1–20 / 21', { exact: true })).toBeVisible();
    await expect(row(created[0])).toBeVisible();
    await expect(row(late)).toHaveCount(0);
    await search.fill(late.key.toLowerCase());
    await expect(row(late)).toBeVisible();
    await expect(row(created[0])).toHaveCount(0);

    const query = `${prefix}　장비`;
    await search.fill(query);
    await projectFilter.selectOption(projectA.id);
    await expect(search).toHaveValue(query);
    await expect(row(today)).toBeVisible();
    await expect(row(late)).toHaveCount(0);
    await projectFilter.selectOption('');
    await expect(row(late)).toBeVisible();
    await expect(row(excluded)).toHaveCount(0);
    await expect(row(closed)).toHaveCount(0);
    await closedFilter.check();
    await expect(row(closed)).toBeVisible();
    await closedFilter.uncheck();
    await row(late).click();
    const review = page.getByRole('navigation', { name: '업무 검토 순서', exact: true });
    await expect(review.getByRole('status')).toHaveText('2개 중 1번째');
    const next = review.getByRole('button', { name: '다음 업무', exact: true });
    await expect(next).toHaveAttribute('title', today.key);
    await next.click();
    await expect(page.getByRole('dialog', { name: today.title, exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === queueHash);
    await expect(search).toHaveValue(query);
    await expect(role).toHaveValue('collaborating');
    await expect(row(late)).toBeFocused();

    await search.fill(`${prefix} 미등록 검색어`);
    await expect(page.getByText('검색 조건에 맞는 업무가 없습니다.', { exact: true })).toBeVisible();
    await search.fill('');
    await expect(row(created[0])).toBeVisible();
  } finally {
    for (const issue of created.reverse()) {
      const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});

test('내 업무에서 현재 페이지의 두 프로젝트 업무를 일괄 검토하고 응답 유실 뒤 같은 적용을 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const initial = await request.get('/api/workspace');
  expect(initial.ok(), await initial.text()).toBe(true);
  const { projects: [first, second], users, issues } = await initial.json() as WorkspaceSnapshot;
  const actor = users.find(user => !issues.some(issue => issue.assigneeId !== user.id && issue.collaboratorIds.includes(user.id)));
  const peer = users.find(user => user.id !== actor?.id);
  if (!actor || !peer || !second) throw new Error('일괄 검토에 필요한 두 작업자와 프로젝트를 찾을 수 없습니다.');
  const actorId = actor.id, peerId = peer.id;
  const headers = { 'X-Actor-Id': actorId };
  const suffix = randomUUID().slice(0, 8);
  const targetStatus = { id: `triage_${suffix}`, label: `처리 완료 ${suffix}`, category: 'done', color: '#418561' } as const;
  const workflowPath = `/api/projects/${first.id}/workflow`;
  const workflowResponse = await request.get(workflowPath);
  expect(workflowResponse.ok(), await workflowResponse.text()).toBe(true);
  const workflow = await workflowResponse.json() as ProjectWorkflow;
  const created: Issue[] = [];
  let configured: ProjectWorkflow | undefined;

  async function create(projectId: string, name: string, dueDate: string, collaboratorIds = [actorId]) {
    const response = await request.post('/api/issues', { headers, data: {
      projectId, title: `내 업무 일괄 ${suffix} ${name}`, dueDate, status: 'todo', priority: 'medium', reporterId: null,
      assigneeId: peerId, collaboratorIds,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  try {
    const change = await request.patch(workflowPath, { headers, data: {
      ...workflow, expectedVersion: workflow.version, statuses: [...workflow.statuses, targetStatus],
      transitions: [...workflow.transitions, { from: 'todo', to: targetStatus.id, issueTypes: [], requiredFields: [] }],
    } });
    expect(change.ok(), await change.text()).toBe(true);
    configured = await change.json() as ProjectWorkflow;
    const earlier: Issue[] = [];
    for (let index = 1; index <= 20; index++) earlier.push(await create(first.id, `첫 페이지 ${index}`, '2026-07-10'));
    const late = await create(first.id, '둘째 페이지', '2026-07-16');
    const today = await create(second.id, '오늘 마감', '2026-07-17');
    const excluded = await create(second.id, '참여 범위 밖', '2026-07-17', []);

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.clock.setFixedTime(new Date('2026-07-16T16:00:00Z'));
    const queueHash = `#/${first.id}/mywork`;
    await page.goto(`/${queueHash}`);
    const role = page.getByRole('combobox', { name: '참여 범위', exact: true });
    const toggle = page.getByRole('button', { name: '내 업무 일괄 편집', exact: true });
    const allVisible = page.getByRole('checkbox', { name: '표시된 업무 전체 선택', exact: true });
    const selection = (issue: Issue) => page.locator('.my-work-list').getByRole('checkbox', { name: `${issue.key} 업무 선택`, exact: true });
    const pagination = page.getByRole('navigation', { name: '마감 초과 페이지', exact: true });
    const next = pagination.getByRole('button', { name: '다음', exact: true });
    const previous = pagination.getByRole('button', { name: '이전', exact: true });
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    const previewRegion = editor.getByRole('region', { name: '일괄 변경 미리보기', exact: true });
    const status = (name: string) => editor.getByRole('combobox', { name: `일괄 상태 ${name}`, exact: true });
    const priority = editor.getByRole('combobox', { name: '일괄 변경 우선순위', exact: true });
    const posted = (action: string) => page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/team/issues/${action}` && response.request().method() === 'POST');

    await role.selectOption('collaborating');
    await toggle.click();
    await expect(allVisible).toBeFocused();
    await expect(page.getByRole('button', { name: `${today.key} 상태 변경`, exact: true })).toHaveCount(0);
    await expect(selection(late)).toHaveCount(0);
    await expect(selection(excluded)).toHaveCount(0);
    await selection(earlier[0]).check();
    await selection(today).check();
    await priority.selectOption('high');
    await status(first.name).selectOption(targetStatus.id);
    await next.click();
    await expect(selection(today)).toBeChecked();
    await expect(selection(late)).not.toBeChecked();
    await expect(status(first.name)).toHaveCount(0);
    await expect(priority).toHaveValue('high');
    await previous.click();
    await expect(selection(earlier[0])).not.toBeChecked();
    await next.click();
    await allVisible.check();
    await expect(selection(today)).toBeChecked();
    await expect(selection(late)).toBeChecked();
    await expect(status(first.name)).toHaveValue('');
    await status(first.name).selectOption(targetStatus.id);
    await status(second.name).selectOption('cancelled');

    const previewResponse = posted('bulk-preview');
    await editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const response = await previewResponse;
    expect(response.ok(), await response.text()).toBe(true);
    const input = response.request().postDataJSON() as TeamIssueBulkEditPreviewInput;
    expect(input.issues).toEqual([late, today].map(({ id, projectId, version }) => ({ id, projectId, expectedVersion: version })));
    expect(input.statuses).toEqual({ [first.id]: targetStatus.id, [second.id]: 'cancelled' });
    expect(input.workflowVersions?.[first.id]).toBe(configured.version);
    const preview = await response.json() as IssueBulkEditPreview;
    expect(preview).toMatchObject({ changed: 2, blocked: 0, previewId: expect.any(String) });
    await expect(previewRegion).toContainText(targetStatus.label);
    await expect(previewRegion).toContainText(today.title);

    const applyData: unknown[] = [];
    await page.route('**/api/team/issues/bulk-apply', async route => {
      applyData.push(route.request().postDataJSON());
      const committed = await route.fetch();
      await (applyData.length === 1 && committed.ok()
        ? route.fulfill({ status: 408, json: { error: '합성 응답 유실' } }) : route.fulfill({ response: committed }));
    });
    await editor.getByRole('button', { name: '일괄 적용', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('적용 결과를 확인하지 못했습니다');
    await expect(previous).toBeDisabled();
    await expect(role).toBeDisabled();
    await editor.getByRole('button', { name: '적용 결과 다시 확인', exact: true }).click();
    await expect(selection(late)).toHaveCount(0);
    await expect(selection(today)).toHaveCount(0);
    await expect(selection(earlier[0])).not.toBeChecked();
    await expect(role).toHaveValue('collaborating');
    expect(applyData).toEqual([{ previewId: preview.previewId }, { previewId: preview.previewId }]);
    await editor.getByRole('button', { name: '일괄 편집 닫기', exact: true }).click();
    await expect(toggle).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === queueHash);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const final = await request.get('/api/workspace');
    expect(final.ok(), await final.text()).toBe(true);
    const saved = (await final.json() as WorkspaceSnapshot).issues;
    expect(saved.find(issue => issue.id === late.id)).toMatchObject({ status: targetStatus.id, priority: 'high', version: late.version + 1 });
    expect(saved.find(issue => issue.id === today.id)).toMatchObject({ status: 'cancelled', priority: 'high', version: today.version + 1 });
    for (const untouched of [...earlier, excluded]) expect(saved.find(issue => issue.id === untouched.id)).toEqual(untouched);
  } finally {
    for (const issue of created) {
      const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
    if (configured) {
      const restored = await request.patch(workflowPath, { headers, data: {
        ...workflow, expectedVersion: configured.version,
        transitions: workflow.transitions.map(edge => ({ ...edge, requireResolvedBlockers: edge.requireResolvedBlockers === true })),
      } });
      expect(restored.ok(), await restored.text()).toBe(true);
    }
  }
});

test('구독한 업무는 현재 작업자별로 모아 보고 상세에서 해제하면 즉시 반영된다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const { projects: [projectA, projectB], users: [actor, peer] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const prefix = `구독한 내 업무 ${randomUUID().slice(0, 8)}`;
  const headers = (id: string) => ({ 'X-Actor-Id': id });
  const created: Issue[] = [];
  async function create(label: string, projectId: string, subscriberId: string, assigneeId: string | null = null) {
    const response = await request.post('/api/issues', { headers: headers(peer.id), data: {
      title: `${prefix} ${label}`, projectId, assigneeId, reporterId: null,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    const subscription = await request.put(`/api/notifications/subscriptions/issue/${issue.id}`, {
      headers: headers(subscriberId), data: { subscribed: true },
    });
    expect(subscription.ok()).toBe(true);
    return issue;
  }

  try {
    const watched = await create('구독만 하는 업무', projectB.id, actor.id, peer.id);
    const assigned = await create('담당하면서 구독한 업무', projectA.id, actor.id, actor.id);
    const other = await create('동료가 구독한 업무', projectB.id, peer.id);
    await page.addInitScript(id => window.localStorage.setItem('teamspace.actor', id), actor.id);
    let rejectReads = true;
    await page.route('**/api/notifications/subscriptions/issues', route => rejectReads
      ? route.fulfill({ status: 503, json: { error: '합성 구독 조회 오류' } }) : route.continue());
    await page.goto(`/#/${projectA.id}/mywork`);
    const participation = page.getByRole('combobox', { name: '참여 범위', exact: true });
    const selection = page.getByRole('combobox', { name: '프로젝트', exact: true });
    const row = (issue: Issue) => page.locator(`[data-issue-review-id="${issue.id}"]`);
    const badge = page.locator('.sidebar .nav-item').filter({ hasText: '내 업무' }).locator('.nav-count');
    await participation.selectOption('subscribed');
    const retry = page.getByRole('button', { name: '구독 업무 다시 불러오기', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByText('표시할 업무가 없습니다.', { exact: true })).toHaveCount(0);
    rejectReads = false;
    await retry.click();
    await expect(row(watched).locator('.my-work-item-project')).toContainText('구독');
    await expect(row(assigned).locator('.my-work-item-project')).toContainText('담당');
    await expect(row(assigned).locator('.my-work-item-project')).toContainText('구독');
    const beforeCount = Number(await badge.textContent());
    await expect(row(other)).toHaveCount(0);
    await participation.selectOption('all');
    await expect(row(assigned)).toHaveCount(1);
    await participation.selectOption('subscribed');
    await selection.selectOption(projectB.id);
    await expect(row(assigned)).toHaveCount(0);

    await row(watched).click();
    const detail = page.getByRole('dialog', { name: watched.title, exact: true });
    const refresh = page.waitForResponse(response => response.url().endsWith('/api/notifications/subscriptions/issues') && response.ok());
    await detail.getByRole('button', { name: '업무 구독 해제', exact: true }).click();
    const refreshed = await refresh;
    expect(await refreshed.json()).toEqual({ issueIds: [assigned.id] });
    await detail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(selection).toHaveValue(projectB.id);
    await expect(participation).toHaveValue('subscribed');
    await expect(row(watched)).toHaveCount(0);
    await expect(badge).toHaveText(String(beforeCount - 1));

    await page.getByLabel('작업자 선택', { exact: true }).selectOption(peer.id);
    await participation.selectOption('subscribed');
    await expect(row(other)).toBeVisible();
    await expect(row(assigned)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    for (const issue of created) {
      const response = await request.delete(`/api/issues/${issue.id}`, { headers: headers(actor.id) });
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`, { headers: headers(actor.id) });
      }
    }
  }
});

test('내 업무에서 프로젝트를 넘어 담당과 협력 업무의 기한을 확인하고 원래 티켓을 연다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const prefix = `내 업무 검사 ${randomUUID()}`;
  const response = await request.get('/api/workspace');
  expect(response.ok()).toBeTruthy();
  const { projects: [projectA, projectB], users: [actor, otherActor] } = await response.json() as WorkspaceSnapshot;
  expect(projectB).toBeDefined();
  expect(otherActor).toBeDefined();

  async function create(label: string, data: Partial<Issue>) {
    const created = await request.post('/api/issues', { data: { title: `${prefix} ${label}`, reporterId: null, ...data } });
    expect(created.status()).toBe(201);
    return created.json() as Promise<Issue>;
  }

  const section = (name: string) => page.getByRole('region', { name, exact: true });
  const row = (issue: Issue) => page.locator(`[data-issue-review-id="${issue.id}"]`);

  try {
    const priorityDate = await create('별도 목표 마감일', {
      projectId: projectA.id, assigneeId: actor.id, collaboratorIds: [actor.id],
      status: 'in_progress', dueDate: '2026-07-16', endDate: '2026-07-22',
    });
    const older = await create('먼저 초과한 업무', {
      projectId: projectB.id, assigneeId: actor.id, dueDate: '2026-07-15',
    });
    const today = await create('계획 종료일이 오늘인 협력 업무', {
      projectId: projectB.id, assigneeId: otherActor.id, collaboratorIds: [actor.id],
      status: 'review', endDate: '2026-07-17',
    });
    const soon = await create('곧 마감할 업무', {
      projectId: projectA.id, assigneeId: actor.id, dueDate: '2026-07-23',
    });
    const later = await create('나중에 마감할 업무', {
      projectId: projectB.id, assigneeId: actor.id, dueDate: '2026-07-26',
    });
    const noDate = await create('기한이 없는 업무', {
      projectId: projectB.id, collaboratorIds: [actor.id],
    });
    const done = await create('기한을 지난 완료 업무', {
      projectId: projectA.id, assigneeId: actor.id, status: 'done', dueDate: '2026-07-15',
    });
    const cancelled = await create('취소한 협력 업무', {
      projectId: projectB.id, collaboratorIds: [actor.id], status: 'cancelled', dueDate: '2026-07-17',
    });
    const other = await create('다른 작업자의 업무', {
      projectId: projectA.id, assigneeId: otherActor.id, dueDate: '2026-07-17',
    });

    // Seoul is already on July 17 while UTC is on July 16.
    await page.clock.setFixedTime(new Date('2026-07-16T16:00:00Z'));
    await page.goto(`/#/${projectA.id}/mywork`);
    await expect(page.getByRole('heading', { name: '내 업무', exact: true })).toBeVisible({ timeout: 20_000 });
    const actorPicker = page.getByLabel('작업자 선택', { exact: true });
    await actorPicker.selectOption(actor.id);
    const project = page.getByRole('combobox', { name: '프로젝트', exact: true });
    const scope = page.getByRole('combobox', { name: '참여 범위', exact: true });
    const grouping = page.getByRole('combobox', { name: '묶는 기준', exact: true });
    const includeTerminal = page.getByRole('checkbox', { name: '완료·취소 포함', exact: true });
    const allProjects = await project.inputValue();

    const overdue = section('마감 초과');
    const overdueRows = overdue.getByRole('button').filter({ hasText: prefix });
    await expect(overdueRows).toHaveCount(2);
    await expect(overdueRows.nth(0)).toContainText(older.title);
    await expect(overdueRows.nth(1)).toContainText(priorityDate.title);
    await expect(row(priorityDate)).toContainText('목표 마감일');
    const bounds = await row(priorityDate).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await expect(row(priorityDate)).toContainText(projectA.name);
    await expect(row(priorityDate)).toContainText('진행 중');
    await expect(row(priorityDate)).toContainText('담당');
    await expect(section('오늘 마감').getByRole('button').filter({ hasText: today.title })).toBeVisible();
    await expect(row(today)).toContainText('계획 종료일');
    await expect(row(today)).toContainText(projectB.name);
    await expect(row(today)).toContainText('협력');
    await expect(section('7일 이내').getByRole('button').filter({ hasText: soon.title })).toBeVisible();
    await expect(section('이후').getByRole('button').filter({ hasText: later.title })).toBeVisible();
    await expect(section('기한 없음').getByRole('button').filter({ hasText: noDate.title })).toBeVisible();
    for (const hidden of [done, cancelled, other]) await expect(row(hidden)).toHaveCount(0);

    await includeTerminal.check();
    await expect(section('완료·취소').getByRole('button').filter({ hasText: prefix })).toHaveCount(2);
    await grouping.selectOption({ label: '상태 기준' });
    await expect(section('검토').getByRole('button').filter({ hasText: today.title })).toBeVisible();
    await expect(section('취소').getByRole('button').filter({ hasText: cancelled.title })).toBeVisible();
    await grouping.selectOption({ label: '마감 기준' });
    await includeTerminal.uncheck();

    await scope.selectOption({ label: '담당 업무' });
    await expect(row(priorityDate)).toHaveCount(1);
    await expect(row(today)).toHaveCount(0);
    await scope.selectOption({ label: '협력 업무' });
    await expect(row(priorityDate)).toHaveCount(0);
    await expect(row(today)).toBeVisible();
    await project.selectOption(projectB.id);
    await row(today).click();
    const dialog = page.getByRole('dialog', { name: today.title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === `#/${projectA.id}/mywork?issue=${today.id}`);
    await dialog.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(project).toHaveValue(projectB.id);
    await expect(scope.locator('option:checked')).toHaveText('협력 업무');
    await expect(row(today)).toBeVisible();

    await actorPicker.selectOption(otherActor.id);
    await expect(project).toHaveValue(allProjects);
    await expect(scope.locator('option:checked')).toHaveText('전체 참여 업무');
    await expect(row(other)).toBeVisible();
    await expect(row(today)).toBeVisible();
    await expect(row(priorityDate)).toHaveCount(0);
  } finally {
    const latest = await request.get('/api/workspace');
    if (latest.ok()) {
      const { issues } = await latest.json() as WorkspaceSnapshot;
      for (const issue of issues.filter(issue => issue.title.startsWith(prefix))) {
        const removed = await request.delete(`/api/issues/${issue.id}`);
        expect(removed.ok()).toBeTruthy();
      }
    }
  }
});

test('360px 내 업무에서 상세를 열지 않고 상태와 인수인계를 저장하고 같은 대기열을 이어서 본다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const { projects: [contextProject, project], users: [actor, peer] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const headers = { 'X-Actor-Id': actor.id };
  const created = await request.post('/api/issues', { headers, data: {
    projectId: project.id, title: `내 업무 인수인계 ${randomUUID().slice(0, 8)}`, status: 'todo', assigneeId: actor.id, reporterId: null,
  } });
  expect(created.status(), await created.text()).toBe(201);
  const issue = await created.json() as Issue;
  const issuePath = `/api/issues/${issue.id}`;
  const changePath = `${issuePath}/status-change`;

  try {
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const address = `#/${contextProject.id}/mywork`;
    await page.goto(`/${address}`);
    const pageHeading = page.getByRole('heading', { name: '내 업무', exact: true });
    const projectFilter = page.getByRole('combobox', { name: '프로젝트', exact: true });
    const role = page.getByRole('combobox', { name: '참여 범위', exact: true });
    const grouping = page.getByRole('combobox', { name: '묶는 기준', exact: true });
    await projectFilter.selectOption(project.id);
    await role.selectOption('assigned');
    await grouping.selectOption('status');
    const action = page.getByRole('button', { name: `${issue.key} 상태 변경`, exact: true });
    await expect(action).toBeVisible();
    const bounds = await action.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const workRow = page.locator(`[data-issue-review-id="${issue.id}"]`);
    const details = page.getByRole('dialog', { name: issue.title, exact: true });
    const closeDetails = details.getByRole('button', { name: '업무 상세 닫기', exact: true });
    const detailComment = details.getByRole('textbox', { name: '댓글 내용', exact: true });
    const otherDraft = '티켓 상세에서 작성 중인 별도 댓글입니다.';
    await workRow.click();
    await detailComment.fill(otherDraft);
    await closeDetails.click();
    await expect(details).toHaveCount(0);
    await action.press('Enter');

    const dialog = page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
    const nextState = dialog.getByRole('combobox', { name: '변경할 상태', exact: true });
    const nextAssignee = dialog.getByRole('combobox', { name: '담당자', exact: true });
    const handoff = dialog.getByRole('textbox', { name: '인수인계 댓글', exact: true });
    const apply = dialog.getByRole('button', { name: '상태 변경 적용', exact: true });
    await expect(nextState).toBeFocused();
    await nextState.selectOption('in_progress');
    const comment = '이전 검토 내용을 확인한 뒤 작업을 이어갑니다.';
    await handoff.fill(comment);

    const submitted: IssueStatusChangeRequest[] = [];
    await page.route(`**${changePath}`, async route => {
      submitted.push(route.request().postDataJSON() as IssueStatusChangeRequest);
      const response = await route.fetch();
      if (submitted.length === 1) {
        expect(response.status(), await response.text()).toBe(200);
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await apply.click();
    const retry = dialog.getByRole('button', { name: '저장 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expect(handoff).toHaveValue(comment);
    await retry.click();
    await expect(dialog).toHaveCount(0);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    const liveComments = await request.get(`/api/comments?${new URLSearchParams({ resourceType: 'issue', resourceId: issue.id })}`);
    expect(liveComments.ok(), await liveComments.text()).toBeTruthy();
    expect(await liveComments.json() as Comment[]).toMatchObject([{ body: comment, authorId: actor.id }]);
    await expect(page.getByRole('region', { name: '진행 중', exact: true }).getByRole('button', { name: `${issue.key} 상태 변경`, exact: true })).toBeFocused();
    await expect(details).toHaveCount(0);
    await workRow.click();
    await expect(detailComment).toHaveValue(otherDraft);
    await closeDetails.click();

    await action.click();
    await nextState.selectOption('review');
    await nextAssignee.selectOption(`user:${peer.id}`);
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(action).toHaveCount(0);
    await expect(pageHeading).toBeFocused();
    await expect(projectFilter).toHaveValue(project.id);
    await expect(role).toHaveValue('assigned');
    await expect(grouping).toHaveValue('status');
    await expect(page).toHaveURL(url => url.hash === address);
    await expect(page.getByRole('dialog', { name: issue.title, exact: true })).toHaveCount(0);
    const saved = await request.get('/api/workspace');
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const { issues } = await saved.json() as WorkspaceSnapshot;
    expect(issues.find(value => value.id === issue.id)).toMatchObject({ status: 'review', assigneeId: peer.id, version: issue.version + 2 });
  } finally {
    const removed = await request.delete(issuePath, { headers });
    if (removed.ok()) await request.delete(`/api/trash/${(await removed.json()).trashEntryId}`, { headers });
  }
});

test('내 업무에서 보이는 페이지 순서로 두 프로젝트의 티켓을 이어 검토한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const prefix = `내 업무 연속 검토 ${randomUUID().slice(0, 8)}`;
  const initial = await request.get('/api/workspace');
  expect(initial.ok(), await initial.text()).toBe(true);
  const { projects: [projectA, projectB], users, issues } = await initial.json() as WorkspaceSnapshot;
  const actor = users.find(user => !issues.some(issue => issue.assigneeId !== user.id && issue.collaboratorIds.includes(user.id)));
  const peer = users.find(user => user.id !== actor?.id);
  if (!actor || !peer || !projectB) throw new Error('연속 검토에 필요한 두 작업자와 프로젝트를 찾을 수 없습니다.');
  const actorId = actor.id, peerId = peer.id;
  const headers = { 'X-Actor-Id': actorId };
  const created: Issue[] = [];
  async function create(label: string, projectId: string, dueDate: string, fields: Partial<Issue> = {}) {
    const response = await request.post('/api/issues', { headers, data: {
      projectId, title: `${prefix} ${label}`, dueDate, reporterId: null,
      assigneeId: peerId, collaboratorIds: [actorId], ...fields,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  try {
    const earlier: Issue[] = [];
    for (let index = 1; index <= 20; index++) earlier.push(await create(`이전 페이지 ${index}`, projectA.id, '2026-07-10'));
    const opener = await create('두 번째 페이지에서 검토 시작', projectB.id, '2026-07-16', { status: 'review' });
    const today = await create('오늘 마감하는 다른 프로젝트 업무', projectA.id, '2026-07-17');
    const excluded = await create('협력 역할 필터 밖 업무', projectB.id, '2026-07-17', { assigneeId: actor.id, collaboratorIds: [] });
    const queueHash = `#/${projectA.id}/mywork`;
    const issueHash = (issue: Issue) => `${queueHash}?issue=${issue.id}`;
    const row = (issue: Issue) => page.locator(`[data-issue-review-id="${issue.id}"]`);
    const panel = (issue: Issue) => page.getByRole('dialog', { name: issue.title, exact: true });
    const review = (issue: Issue) => panel(issue).getByRole('navigation', { name: '업무 검토 순서', exact: true });
    const previous = (issue: Issue) => review(issue).getByRole('button', { name: '이전 업무', exact: true });
    const next = (issue: Issue) => review(issue).getByRole('button', { name: '다음 업무', exact: true });
    const position = (issue: Issue) => review(issue).getByRole('status');
    const role = page.getByRole('combobox', { name: '참여 범위', exact: true });
    const grouping = page.getByRole('combobox', { name: '묶는 기준', exact: true });
    const projectFilter = page.getByRole('combobox', { name: '프로젝트', exact: true });
    const worker = page.getByLabel('작업자 선택', { exact: true });
    const includeClosed = page.getByRole('checkbox', { name: '완료·취소 포함', exact: true });

    await page.clock.setFixedTime(new Date('2026-07-16T16:00:00Z'));
    await page.goto(`/${queueHash}`);
    const heading = page.getByRole('heading', { name: '내 업무', exact: true });
    await expect(heading).toBeVisible({ timeout: 25_000 });
    await worker.selectOption(actor.id);
    await role.selectOption('collaborating');
    const overdue = page.getByRole('region', { name: '마감 초과', exact: true });
    const paging = overdue.getByRole('navigation', { name: '마감 초과 페이지', exact: true });
    await expect(overdue.locator('[data-issue-review-id]')).toHaveCount(20);
    await expect(row(earlier[0])).toBeVisible();
    await expect(row(opener)).toHaveCount(0);
    await paging.getByRole('button', { name: '다음', exact: true }).click();
    await expect(overdue.locator('[data-issue-review-id]')).toHaveCount(1);
    await expect(paging.getByText('21–21 / 21', { exact: true })).toBeVisible();
    await expect(row(earlier[0])).toHaveCount(0);
    await expect(row(today)).toBeVisible();
    await expect(row(excluded)).toHaveCount(0);

    await row(opener).click();
    await expect(page).toHaveURL(url => url.hash === issueHash(opener));
    await expect(position(opener)).toHaveText('2개 중 1번째');
    await expect(previous(opener)).toBeDisabled();
    await expect(next(opener)).toHaveAttribute('title', today.key);
    await panel(opener).getByLabel('상태', { exact: true }).selectOption('done');
    const patch = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${opener.id}` && response.request().method() === 'PATCH');
    const save = panel(opener).getByRole('button', { name: '변경사항 저장', exact: true });
    await save.click();
    const reply = await patch;
    expect(reply.ok(), await reply.text()).toBe(true);
    expect(await reply.json()).toMatchObject({ id: opener.id, status: 'done', version: opener.version + 1 });
    await expect(save).toBeDisabled();
    await expect(row(opener)).toHaveCount(0);
    // Completion clamps the underlying group back to page 1 without replacing the current review queue.
    await expect(row(earlier[0])).toHaveCount(1);
    await expect(position(opener)).toHaveText('2개 중 1번째');
    await expect(next(opener)).toHaveAttribute('title', today.key);

    const title = panel(opener).getByLabel('제목', { exact: true });
    await title.fill('저장하지 않은 개인 업무 제목');
    const stay = page.waitForEvent('dialog').then(async confirmation => {
      expect(confirmation.message()).toContain('저장하지 않은');
      await confirmation.dismiss();
    });
    await next(opener).click();
    await stay;
    await expect(page).toHaveURL(url => url.hash === issueHash(opener));
    await expect(title).toHaveValue('저장하지 않은 개인 업무 제목');
    await title.fill(opener.title);
    await expect(save).toBeDisabled();

    await next(opener).click();
    await expect(page).toHaveURL(url => url.hash === issueHash(today));
    await expect(position(today)).toHaveText('2개 중 2번째');
    await expect(previous(today)).toHaveAttribute('title', opener.key);
    await expect(next(today)).toBeDisabled();
    await previous(today).click();
    await expect(position(opener)).toHaveText('2개 중 1번째');
    await expect(panel(opener).getByLabel('상태', { exact: true })).toHaveValue('done');
    await next(opener).click();
    await expect(position(today)).toHaveText('2개 중 2번째');
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === queueHash);
    await expect(panel(today)).toHaveCount(0);
    await expect(heading).toBeFocused();
    await expect(worker).toHaveValue(actor.id);
    await expect(projectFilter).toHaveValue('');
    await expect(role).toHaveValue('collaborating');
    await expect(grouping).toHaveValue('deadline');
    await expect(includeClosed).not.toBeChecked();
    await expect(row(opener)).toHaveCount(0);
    await expect(row(today)).toBeVisible();

    await role.focus();
    await expect(role).toBeFocused();
    await page.goForward();
    await expect(page).toHaveURL(url => url.hash === issueHash(today));
    await expect(position(today)).toHaveText('2개 중 2번째');
    await expect(previous(today)).toHaveAttribute('title', opener.key);
    await expect(next(today)).toBeDisabled();
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === queueHash);
    await expect(panel(today)).toHaveCount(0);
    await expect(heading).toBeFocused();

    await row(today).click();
    await expect(position(today)).toHaveText('21개 중 21번째');
    await panel(today).getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(panel(today)).toHaveCount(0);
    await expect(row(today)).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === queueHash);

    await page.goto(`/${issueHash(today)}`);
    await expect(panel(today)).toBeVisible();
    await expect(review(today)).toHaveCount(0);
  } finally {
    for (const issue of created.reverse()) {
      const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
