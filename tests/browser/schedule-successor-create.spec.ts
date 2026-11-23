import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

function daysFrom(date: Date, amount: number) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + amount);
  return shifted.toISOString().slice(0, 10);
}

async function cleanupIssues(request: APIRequestContext, prefix: string) {
  const issues = (await workspace(request)).issues.filter(issue => issue.title.startsWith(prefix));
  for (const issue of issues.reverse()) {
    const response = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
    if (!response.ok()) continue;
    const { trashEntryId } = await response.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

function schedulingForm(page: Page, name: '후행 업무 만들기' | '선행 업무 만들기') {
  const dialog = page.getByRole('dialog', { name, exact: true });
  return {
    dialog,
    title: dialog.getByLabel('업무 제목', { exact: true }),
    start: dialog.getByLabel('시작일', { exact: true }),
    end: dialog.getByLabel('종료일', { exact: true }),
    type: dialog.getByLabel('연결 유형', { exact: true }),
    lag: dialog.getByLabel('근무일 간격', { exact: true }),
    save: dialog.getByRole('button', { name: '업무 만들고 일정 연결', exact: true }),
  };
}

test('360px 간트에서 근무일로 후행 업무를 만들고 저장 응답 유실을 재확인한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const [project] = (await workspace(request)).projects;
  const prefix = `간트 후행 생성 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 후행`;
  const now = new Date();
  const daysToFriday = (5 - now.getUTCDay() + 7) % 7 || 7;
  const priorStart = daysFrom(now, daysToFriday - 1);
  const priorEnd = daysFrom(now, daysToFriday);
  const monday = daysFrom(now, daysToFriday + 3);
  const tuesday = daysFrom(now, daysToFriday + 4);
  const calendarPath = `/api/projects/${project.id}/calendar`;
  const original = await json<WorkCalendar>(await request.get(calendarPath));
  let calendar: WorkCalendar | undefined;
  try {
    calendar = await json<WorkCalendar>(await request.patch(calendarPath, { data: {
      ...original, expectedVersion: original.version, workingWeekdays: [1, 2, 3, 4, 5],
      exceptions: [{ date: monday, isWorking: false, label: '합성 월요일 휴무' }],
    } }));
    const predecessor = await json<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} 선행`, startDate: priorStart, endDate: priorEnd,
    } }), 201);
    const routePath = `/api/issues/${predecessor.id}/schedule-successors`;
    const attempts: { status: number; payload: string | null; actorId: string | undefined }[] = [];
    await page.route(`**${routePath}`, async route => {
      const outgoing = route.request();
      const response = await route.fetch();
      attempts.push({ status: response.status(), payload: outgoing.postData(), actorId: outgoing.headers()['x-actor-id'] });
      if (attempts.length === 1) return route.abort('failed');
      await route.fulfill({ response });
    });

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const add = page.getByRole('button', { name: '새 후행 업무 추가', exact: true });
    await expect(add).toHaveCount(0);
    await chart.getByRole('checkbox', { name: `${predecessor.key} 선택`, exact: true }).check();
    await add.click();

    const form = schedulingForm(page, '후행 업무 만들기');
    await expect(form.title).toBeFocused();
    await expect(form.dialog).toContainText(predecessor.key);
    await expect(form.type).toHaveValue('FS');
    await expect(form.lag).toHaveValue('0');
    await expect(form.start).toHaveValue(tuesday);
    await expect(form.end).toHaveValue(tuesday);
    await form.title.fill(title);
    await form.save.click();

    const retry = form.dialog.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expect(form.title).toHaveValue(title);
    await expect(form.title).toBeDisabled();
    await expect(form.start).toHaveValue(tuesday);
    const committed = await workspace(request);
    const matches = committed.issues.filter(issue => issue.title === title);
    expect(matches).toHaveLength(1);
    const [successor] = matches;
    expect(successor).toMatchObject({ projectId: project.id, startDate: tuesday, endDate: tuesday });
    const outgoing = committed.dependencies.filter(link => link.predecessorId === predecessor.id);
    expect(outgoing).toEqual([expect.objectContaining({ successorId: successor.id, type: 'FS', lagDays: 0 })]);

    await retry.click();
    await expect(form.dialog).toHaveCount(0);
    const details = page.getByRole('dialog', { name: title, exact: true });
    await expect(details).toBeVisible();
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(chart.getByLabel(`${successor.key} 시작일`, { exact: true })).toHaveValue(tuesday);
    await expect(chart.getByLabel(`${successor.key} 종료일`, { exact: true })).toHaveValue(tuesday);
    await expect(chart.locator(`[data-dependency-id="${outgoing[0].id}"]`)).toHaveAttribute('data-dependency-type', 'FS');
    expect(attempts.map(attempt => attempt.status)).toEqual([201, 200]);
    expect(attempts[1]).toMatchObject({ payload: attempts[0].payload, actorId: attempts[0].actorId });
    expect(attempts[0].actorId).toBeTruthy();
    expect(JSON.parse(attempts[0].payload!)).toMatchObject({
      requestId: expect.stringMatching(/^[\da-f-]{36}$/u), expectedPredecessorVersion: predecessor.version,
      expectedCalendarVersion: calendar.version, type: 'FS', lagDays: 0, issue: { title, startDate: tuesday, endDate: tuesday },
    });
    const afterRetry = await workspace(request);
    expect(afterRetry.issues.filter(issue => issue.title === title)).toEqual([successor]);
    expect(afterRetry.dependencies.filter(link => link.predecessorId === predecessor.id)).toEqual(outgoing);
  } finally {
    await cleanupIssues(request, prefix);
    if (calendar) await json<WorkCalendar>(await request.patch(calendarPath, { data: { ...original, expectedVersion: calendar.version } }));
  }
});

test('티켓 상세에서 최신 선행 일정을 다시 확인할 때 양쪽 업무의 입력을 보존한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const [project] = (await workspace(request)).projects;
  const prefix = `티켓 후행 생성 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 후행`;
  const now = new Date();
  const startDate = daysFrom(now, 14);
  const endDate = daysFrom(now, 16);
  const parentDraft = '저장하지 않은 선행 업무의 제목';
  const commentDraft = '보내지 않은 선행 업무 댓글';
  try {
    const predecessor = await json<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title: `${prefix} 선행` } }), 201);
    await page.goto(`/#/${project.id}/issues?issue=${predecessor.id}`);
    const details = page.getByRole('dialog', { name: predecessor.title, exact: true });
    const detailTitle = details.getByRole('textbox', { name: '제목', exact: true });
    const detailComment = details.getByRole('textbox', { name: '댓글 내용', exact: true });
    const relationships = details.getByRole('region', { name: '업무 의존성', exact: true });
    const add = relationships.getByRole('button', { name: '새 후행 업무 추가', exact: true });
    await detailTitle.fill(parentDraft);
    await detailComment.fill(commentDraft);
    await add.click();

    const form = schedulingForm(page, '후행 업무 만들기');
    await expect(form.title).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(form.dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(detailTitle).toHaveValue(parentDraft);
    await expect(detailComment).toHaveValue(commentDraft);
    await add.click();

    await expect(form.dialog).toContainText('선행 업무의 종료일이 비어 있어 날짜를 제안할 수 없습니다.');
    await expect(form.start).toHaveValue('');
    await expect(form.end).toHaveValue('');
    await form.title.fill(title);
    await form.type.selectOption('SS');
    await form.lag.fill('2');
    await form.start.fill(startDate);
    await form.end.fill(endDate);

    const latest = await json<Issue>(await request.patch(`/api/issues/${predecessor.id}`, { data: {
      expectedVersion: predecessor.version, startDate: daysFrom(now, 1), endDate: daysFrom(now, 2),
    } }));
    const waitForCreate = () => page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/issues/${predecessor.id}/schedule-successors`);
    const conflict = waitForCreate();
    await form.save.click();
    expect((await conflict).status()).toBe(409);
    await expect(form.dialog.getByRole('alert')).toContainText(/선행 업무|선행 일정/u);
    expect((await workspace(request)).issues.some(issue => issue.title === title)).toBe(false);
    await form.dialog.getByRole('button', { name: '최신 선행 일정 사용', exact: true }).click();
    await expect(form.title).toHaveValue(title);
    await expect(form.type).toHaveValue('SS');
    await expect(form.lag).toHaveValue('2');
    await expect(form.start).toHaveValue(startDate);
    await expect(form.end).toHaveValue(endDate);

    const created = waitForCreate();
    await form.save.click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      expectedPredecessorVersion: latest.version, type: 'SS', lagDays: 2, issue: { title, startDate, endDate },
    });
    const successor = await response.json() as Issue;
    await expect(form.dialog).toHaveCount(0);
    await expect(relationships.getByRole('button', { name: `${successor.key} 연결 수정`, exact: true })).toBeVisible();
    await expect(detailTitle).toHaveValue(parentDraft);
    await expect(detailComment).toHaveValue(commentDraft);
    const saved = await workspace(request);
    expect(saved.issues.find(issue => issue.id === predecessor.id)).toMatchObject({ title: predecessor.title, version: latest.version });
    expect(saved.dependencies.filter(link => link.predecessorId === predecessor.id)).toEqual([
      expect.objectContaining({ successorId: successor.id, type: 'SS', lagDays: 2 }),
    ]);
  } finally {
    await cleanupIssues(request, prefix);
  }
});

test('360px 간트에서 기존 업무에 새 선행 업무를 연결하고 응답 유실 뒤 한 번만 생성한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const [project] = (await workspace(request)).projects;
  const prefix = `간트 선행 생성 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 선행`;
  const now = new Date();
  const daysToMonday = (1 - now.getUTCDay() + 7) % 7 || 7;
  const friday = daysFrom(now, daysToMonday - 3);
  const thursday = daysFrom(now, daysToMonday - 4);
  const startDate = daysFrom(now, daysToMonday);
  const endDate = daysFrom(now, daysToMonday + 1);
  const calendarPath = `/api/projects/${project.id}/calendar`;
  const original = await json<WorkCalendar>(await request.get(calendarPath));
  let calendar: WorkCalendar | undefined;
  try {
    calendar = await json<WorkCalendar>(await request.patch(calendarPath, { data: {
      ...original, expectedVersion: original.version, workingWeekdays: [1, 2, 3, 4, 5],
      exceptions: [{ date: friday, isWorking: false, label: '합성 금요일 휴무' }],
    } }));
    const successor = await json<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} 후행`, startDate, endDate,
    } }), 201);
    const path = `/api/issues/${successor.id}/schedule-predecessors`;
    const attempts: { status: number; payload: string | null; actorId: string | undefined }[] = [];
    await page.route(`**${path}`, async route => {
      const outgoing = route.request();
      const response = await route.fetch();
      attempts.push({ status: response.status(), payload: outgoing.postData(), actorId: outgoing.headers()['x-actor-id'] });
      if (attempts.length === 1) return route.abort('failed');
      await route.fulfill({ response });
    });

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const add = page.getByRole('button', { name: '새 선행 업무 추가', exact: true });
    await expect(add).toHaveCount(0);
    await chart.getByRole('checkbox', { name: `${successor.key} 선택`, exact: true }).check();
    await add.click();

    const form = schedulingForm(page, '선행 업무 만들기');
    await expect(form.title).toBeFocused();
    await expect(form.dialog).toContainText(successor.key);
    await expect(form.type).toHaveValue('FS');
    await expect(form.lag).toHaveValue('0');
    await expect(form.dialog).toContainText(`제안 종료일 ${thursday}`);
    await expect(form.start).toHaveValue(thursday);
    await expect(form.end).toHaveValue(thursday);
    await form.title.fill(title);
    await form.save.click();

    const retry = form.dialog.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expect(form.title).toHaveValue(title);
    await expect(form.title).toBeDisabled();
    await expect(form.end).toHaveValue(thursday);
    const committed = await workspace(request);
    const matches = committed.issues.filter(issue => issue.title === title);
    expect(matches).toHaveLength(1);
    const [prerequisite] = matches;
    expect(prerequisite).toMatchObject({ projectId: project.id, startDate: thursday, endDate: thursday });
    expect(committed.issues.find(issue => issue.id === successor.id)).toEqual(successor);
    const incoming = committed.dependencies.filter(link => link.successorId === successor.id);
    expect(incoming).toEqual([expect.objectContaining({ predecessorId: prerequisite.id, type: 'FS', lagDays: 0 })]);

    await retry.click();
    await expect(form.dialog).toHaveCount(0);
    const details = page.getByRole('dialog', { name: title, exact: true });
    await expect(details).toBeVisible();
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(chart.getByLabel(`${prerequisite.key} 시작일`, { exact: true })).toHaveValue(thursday);
    await expect(chart.getByLabel(`${successor.key} 시작일`, { exact: true })).toHaveValue(startDate);
    await expect(chart.locator(`[data-dependency-id="${incoming[0].id}"]`)).toHaveAttribute('data-dependency-type', 'FS');
    expect(attempts.map(attempt => attempt.status)).toEqual([201, 200]);
    expect(attempts[1]).toMatchObject({ payload: attempts[0].payload, actorId: attempts[0].actorId });
    expect(attempts[0].actorId).toBeTruthy();
    expect(JSON.parse(attempts[0].payload!)).toMatchObject({
      requestId: expect.stringMatching(/^[\da-f-]{36}$/u), expectedSuccessorVersion: successor.version,
      expectedCalendarVersion: calendar.version, type: 'FS', lagDays: 0, issue: { title, startDate: thursday, endDate: thursday },
    });
    const afterRetry = await workspace(request);
    expect(afterRetry.issues.filter(issue => issue.title === title)).toEqual([prerequisite]);
    expect(afterRetry.dependencies.filter(link => link.successorId === successor.id)).toEqual(incoming);
  } finally {
    await cleanupIssues(request, prefix);
    if (calendar) await json<WorkCalendar>(await request.patch(calendarPath, { data: { ...original, expectedVersion: calendar.version } }));
  }
});

test('티켓 상세에서 최신 후행 일정을 검토할 때 원본과 새 선행 업무의 초안을 보존한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const [project] = (await workspace(request)).projects;
  const prefix = `티켓 선행 생성 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 선행`;
  const now = new Date();
  const startDate = daysFrom(now, 14);
  const endDate = daysFrom(now, 16);
  const detailDraft = '저장하지 않은 후행 업무의 제목';
  const commentDraft = '보내지 않은 후행 업무 댓글';
  try {
    const successor = await json<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title: `${prefix} 후행` } }), 201);
    await page.goto(`/#/${project.id}/issues?issue=${successor.id}`);
    const details = page.getByRole('dialog', { name: successor.title, exact: true });
    const detailTitle = details.getByRole('textbox', { name: '제목', exact: true });
    const detailComment = details.getByRole('textbox', { name: '댓글 내용', exact: true });
    const relationships = details.getByRole('region', { name: '업무 의존성', exact: true });
    const add = relationships.getByRole('button', { name: '새 선행 업무 추가', exact: true });
    await detailTitle.fill(detailDraft);
    await detailComment.fill(commentDraft);
    await add.click();

    const form = schedulingForm(page, '선행 업무 만들기');
    await expect(form.title).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(form.dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(detailTitle).toHaveValue(detailDraft);
    await expect(detailComment).toHaveValue(commentDraft);
    await add.click();

    await expect(form.dialog).toContainText('후행 업무의 시작일이 비어 있어 날짜를 제안할 수 없습니다.');
    await expect(form.start).toHaveValue('');
    await expect(form.end).toHaveValue('');
    await form.title.fill(title);
    await form.type.selectOption('SS');
    await form.lag.fill('-2');
    await form.start.fill(startDate);
    await form.end.fill(endDate);

    const latest = await json<Issue>(await request.patch(`/api/issues/${successor.id}`, { data: {
      expectedVersion: successor.version, startDate: daysFrom(now, 1), endDate: daysFrom(now, 2),
    } }));
    const waitForCreate = () => page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/issues/${successor.id}/schedule-predecessors`);
    const conflict = waitForCreate();
    await form.save.click();
    expect((await conflict).status()).toBe(409);
    await expect(form.dialog.getByRole('alert')).toContainText(/후행 업무|후행 일정/u);
    expect((await workspace(request)).issues.some(issue => issue.title === title)).toBe(false);
    await form.dialog.getByRole('button', { name: '최신 후행 일정 사용', exact: true }).click();
    await expect(form.title).toHaveValue(title);
    await expect(form.type).toHaveValue('SS');
    await expect(form.lag).toHaveValue('-2');
    await expect(form.start).toHaveValue(startDate);
    await expect(form.end).toHaveValue(endDate);

    const created = waitForCreate();
    await form.save.click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      expectedSuccessorVersion: latest.version, type: 'SS', lagDays: -2, issue: { title, startDate, endDate },
    });
    const prerequisite = await response.json() as Issue;
    await expect(form.dialog).toHaveCount(0);
    await expect(relationships.getByRole('button', { name: `${prerequisite.key} 연결 수정`, exact: true })).toBeVisible();
    await expect(detailTitle).toHaveValue(detailDraft);
    await expect(detailComment).toHaveValue(commentDraft);
    const saved = await workspace(request);
    expect(saved.issues.find(issue => issue.id === successor.id)).toEqual(latest);
    expect(saved.dependencies.filter(link => link.successorId === successor.id)).toEqual([
      expect.objectContaining({ predecessorId: prerequisite.id, type: 'SS', lagDays: -2 }),
    ]);
  } finally {
    await cleanupIssues(request, prefix);
  }
});
