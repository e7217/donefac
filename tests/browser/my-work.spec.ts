import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'Asia/Seoul' });

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
  const row = (issue: Issue) => page.getByRole('button', { name: new RegExp(`\\b${issue.key}\\b`) });

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
    await expect(scope.locator('option:checked')).toHaveText('담당·협력·요청 업무');
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
