import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import { createCalendarMath } from '../../shared/calendar';
import { reservationLocalDateTime } from '../../shared/time-reservations';
import type { Issue, ProjectWorkflow, SchedulePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 } });

const button = (within: Page | Locator, name: string) => within.getByRole('button', { name, exact: true });
const date = (within: Locator, name: string) => within.getByLabel(name, { exact: true });
const issuePath = (issue: Issue) => `/api/issues/${issue.id}`;
const reviewPath = (issue: Issue) => `${issuePath(issue)}/schedule-save-preview`;
const workspace = async (request: APIRequestContext) => read<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function read<T>(response: APIResponse | Response, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

function responseAt(page: Page, path: string, method: 'POST' | 'PATCH') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function removeIssue(request: APIRequestContext, issue: Issue) {
  const removed = await request.delete(issuePath(issue));
  if (removed.ok()) await request.delete(`/api/trash/${(await removed.json()).trashEntryId}`);
}

test('검토한 티켓 저장의 응답이 끊긴 뒤 같은 변경 결과를 다시 확인한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const issues: Issue[] = [];
  async function make(label: string, startDate: string, endDate: string) {
    const issue = await read<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${label} ${suffix}`, startDate, endDate,
    } }), 201);
    issues.push(issue);
    return issue;
  }
  try {
    const predecessor = await make('재확인 선행 업무', '2027-03-08', '2027-03-12');
    const ticket = await make('저장 결과 재확인 업무', '2027-03-18', '2027-03-23');
    await read(await request.post('/api/dependencies', { data: {
      predecessorId: predecessor.id, successorId: ticket.id, type: 'FS', lagDays: 0,
    } }), 201);
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/issues?issue=${ticket.id}`);
    const panel = page.getByRole('dialog', { name: new RegExp(suffix) });
    const comment = '등록하지 않은 인수인계 메모';
    const title = `${ticket.title} 저장`;
    await panel.getByRole('textbox', { name: '제목', exact: true }).fill(title);
    await panel.getByRole('textbox', { name: '댓글 내용', exact: true }).fill(comment);
    await date(panel, '시작일').fill('2027-03-09');
    await button(panel, '변경사항 저장').click();
    const review = page.getByRole('dialog', { name: '일정 변경 검토', exact: true });
    await expect(review).toContainText(predecessor.title);

    let firstInput: unknown;
    let saved: Issue | undefined;
    const patches: string[] = [];
    await page.route(`**${issuePath(ticket)}`, async route => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const input = route.request().postData()!;
      patches.push(input);
      if (patches.length !== 1) return route.fallback();
      firstInput = JSON.parse(input);
      saved = await read<Issue>(await route.fetch());
      await route.abort('failed');
    });
    await button(review, '검토한 날짜로 저장').click();
    const recovery = page.getByRole('dialog', { name: '업무 저장 결과 확인', exact: true });
    await expect(recovery).toBeVisible();
    expect(firstInput).toMatchObject({ requestId: expect.any(String), schedulePreviewId: expect.any(String), title });
    expect(saved).toMatchObject({ version: ticket.version + 1, startDate: '2027-03-09', title });

    const peerChange = await read<Issue>(await request.patch(issuePath(ticket), { headers: { 'X-Actor-Id': peer.id }, data: {
      expectedVersion: saved!.version, description: '같은 티켓에 남긴 팀원의 후속 변경',
    } }));
    const repeated = responseAt(page, issuePath(ticket), 'PATCH');
    await button(recovery, '저장 결과 다시 확인').click();
    expect(await read<Issue>(await repeated)).toEqual(peerChange);
    expect(patches).toHaveLength(2);
    expect(patches[1]).toBe(patches[0]);
    await expect(recovery).toHaveCount(0);
    await expect(panel.getByRole('textbox', { name: '제목', exact: true })).toHaveValue(title);
    await expect(panel.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue(comment);
    expect((await workspace(request)).issues.find(value => value.id === ticket.id)).toEqual(peerChange);
  } finally {
    for (const issue of issues.reverse()) await removeIssue(request, issue);
  }
});

test('360px 티켓 일반 저장에서 숨은 선행과 프로젝트 간 차단을 검토하고 최신 결과로 함께 저장한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { projects: [project, other], users: [actor, peer] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const created: Issue[] = [];
  const calendarPath = `/api/projects/${project.id}/calendar`;
  const priorCalendar = await read<WorkCalendar>(await request.get(calendarPath));
  let calendar: WorkCalendar | undefined;
  async function make(projectId: string, label: string, startDate: string, endDate: string) {
    const issue = await read<Issue>(await request.post('/api/issues', { data: {
      projectId, title: `${label} ${suffix}`, startDate, endDate, status: 'todo',
    } }), 201);
    created.push(issue);
    return issue;
  }
  async function live(issue: Issue) {
    return (await workspace(request)).issues.find(row => row.id === issue.id);
  }
  try {
    calendar = await read<WorkCalendar>(await request.patch(calendarPath, { data: {
      expectedVersion: priorCalendar.version, workingWeekdays: [1, 2, 3, 4, 5],
      exceptions: [{ date: '2027-03-15', isWorking: false, label: '후행 프로젝트 휴무' }],
    } }));
    const predecessor = await make(project.id, '검색 밖 선행 업무', '2027-03-08', '2027-03-10');
    const blocker = await make(other.id, '다른 프로젝트 차단 업무', '2027-03-08', '2027-03-12');
    const anchor = await make(project.id, '일반 저장 검토 업무', '2027-03-19', '2027-03-24');
    await read(await request.post('/api/dependencies', { data: {
      predecessorId: predecessor.id, successorId: anchor.id, type: 'FS', lagDays: 0,
    } }), 201);
    await read(await request.post(`${issuePath(blocker)}/relations`, { data: {
      otherIssueId: anchor.id, type: 'blocks', direction: 'outgoing',
    } }), 201);

    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/teamboard?${new URLSearchParams({ boardQuery: anchor.title })}`);
    const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
    const open = button(board, `${anchor.key} 업무 열기`);
    await expect(open).toBeVisible();
    await expect(button(board, `${predecessor.key} 업무 열기`)).toHaveCount(0);
    await expect(button(board, `${blocker.key} 업무 열기`)).toHaveCount(0);
    await open.click();
    const details = page.getByRole('dialog', { name: anchor.title, exact: true });
    const review = page.getByRole('dialog', { name: '일정 변경 검토', exact: true });
    const save = button(details, '변경사항 저장');
    const confirm = button(review, '검토한 날짜로 저장');
    const title = `${anchor.title} 수정`;
    const comment = '검토하는 동안 작성 중인 댓글';
    const startDate = '2027-03-10';
    await details.getByRole('textbox', { name: '제목', exact: true }).fill(title);
    await details.getByRole('textbox', { name: '댓글 내용', exact: true }).fill(comment);
    await date(details, '시작일').fill(startDate);

    const firstResponse = responseAt(page, reviewPath(anchor), 'POST');
    await save.click();
    const first = await read<SchedulePreview>(await firstResponse);
    expect(first.changes).toMatchObject([{ id: anchor.id, fromStart: anchor.startDate, toStart: startDate }]);
    expect(first.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(`${predecessor.key} → ${anchor.key}`), expect.stringContaining(`${blocker.key} → ${anchor.key}`),
    ]));
    await expect(review).toBeVisible();
    await expect(review).toContainText(predecessor.title);
    await expect(review).toContainText(blocker.title);
    await expect(review).toContainText('2027-03-16');
    expect(await review.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await live(anchor)).toEqual(anchor);
    await button(review, '날짜 다시 편집').click();
    await expect(review).toHaveCount(0);
    await expect(save).toBeFocused();
    await expect(date(details, '시작일')).toHaveValue(startDate);
    await expect(details.getByRole('textbox', { name: '제목', exact: true })).toHaveValue(title);
    await expect(details.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue(comment);

    const secondResponse = responseAt(page, reviewPath(anchor), 'POST');
    await save.click();
    const second = await read<SchedulePreview>(await secondResponse);
    await expect(review).toBeVisible();
    const changedBlocker = await read<Issue>(await request.patch(issuePath(blocker), { headers: { 'X-Actor-Id': peer.id }, data: {
      expectedVersion: blocker.version, endDate: '2027-03-17',
    } }));
    const rejectedResponse = responseAt(page, issuePath(anchor), 'PATCH');
    await confirm.click();
    const rejected = await rejectedResponse;
    expect(rejected.request().postDataJSON()).toMatchObject({ schedulePreviewId: second.previewId, startDate, title });
    await read(rejected, 409);
    expect(await live(anchor)).toEqual(anchor);

    const freshResponse = responseAt(page, reviewPath(anchor), 'POST');
    await button(review, '다시 검토').click();
    const fresh = await read<SchedulePreview>(await freshResponse);
    expect(fresh.previewId).not.toBe(second.previewId);
    await expect(review).toContainText('2027-03-18');
    const acceptedResponse = responseAt(page, issuePath(anchor), 'PATCH');
    await confirm.click();
    const accepted = await acceptedResponse;
    expect(accepted.request().postDataJSON()).toMatchObject({ schedulePreviewId: fresh.previewId, startDate, title });
    expect(await read<Issue>(accepted)).toMatchObject({ title, startDate, endDate: anchor.endDate, version: anchor.version + 1 });
    await expect(review).toHaveCount(0);
    const updatedDetails = page.getByRole('dialog', { name: title, exact: true });
    await expect(updatedDetails.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue(comment);
    expect(await live(predecessor)).toEqual(predecessor);
    expect(await live(blocker)).toEqual(changedBlocker);
  } finally {
    for (const issue of created.reverse()) await removeIssue(request, issue);
    if (calendar) await request.patch(calendarPath, { data: { ...priorCalendar, expectedVersion: calendar.version } });
  }
});

test('일반 저장은 제목만 편집하면 바로 저장하고 날짜와 상태를 바꿀 때 자동 목표 마감일을 함께 저장한다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const original = await read<ProjectWorkflow>(await request.get(workflowPath));
  const calendar = await read<WorkCalendar>(await request.get(`/api/projects/${project.id}/calendar`));
  const days = 3;
  let workflow: ProjectWorkflow | undefined;
  let created: Issue | undefined;
  try {
    workflow = await read<ProjectWorkflow>(await request.patch(workflowPath, { data: {
      ...original, expectedVersion: original.version,
      statuses: original.statuses.map(status => ({ ...status, ...(status.id === 'in_progress' ? { defaultDueWorkdays: days } : {}) })),
    } }));
    const title = `날짜와 상태 함께 저장 ${randomUUID().slice(0, 8)}`;
    const changedTitle = `${title} 수정`;
    created = await read<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title, status: 'todo' } }), 201);
    const sentReviews: unknown[] = [];
    const issue = created;
    page.on('request', sent => { if (new URL(sent.url()).pathname === reviewPath(issue)) sentReviews.push(sent.postDataJSON()); });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const details = page.getByRole('dialog', { name: new RegExp(`^${title}`) });
    const save = button(details, '변경사항 저장');
    await details.getByRole('textbox', { name: '제목', exact: true }).fill(changedTitle);
    const renamedResponse = responseAt(page, issuePath(issue), 'PATCH');
    await save.click();
    const renamed = await renamedResponse;
    expect(renamed.request().postDataJSON()).not.toHaveProperty('schedulePreviewId');
    const renamedIssue = await read<Issue>(renamed);
    expect(sentReviews).toHaveLength(0);

    const startDate = '2027-03-10';
    await date(details, '시작일').fill(startDate);
    await details.getByLabel('상태', { exact: true }).selectOption('in_progress');
    const previewResponse = responseAt(page, reviewPath(issue), 'POST');
    const savedResponse = responseAt(page, issuePath(issue), 'PATCH');
    await save.click();
    const preview = await read<SchedulePreview>(await previewResponse);
    expect(preview.warnings).toEqual([]);
    const saved = await savedResponse;
    expect(saved.request().postDataJSON()).toHaveProperty('schedulePreviewId', preview.previewId);
    expect(saved.request().postDataJSON()).not.toHaveProperty('dueDate');
    const updated = await read<Issue>(saved);
    const expectedDue = createCalendarMath(calendar).shift(reservationLocalDateTime(updated.updatedAt).slice(0, 10), days);
    expect(updated).toMatchObject({ title: changedTitle, startDate, status: 'in_progress', dueDate: expectedDue, version: renamedIssue.version + 1 });
    expect(preview.changes).toMatchObject([{ id: issue.id, toStart: startDate, toDue: expectedDue }]);
    await expect(page.getByRole('dialog', { name: '일정 변경 검토', exact: true })).toHaveCount(0);
  } finally {
    if (created) await removeIssue(request, created);
    if (workflow) await request.patch(workflowPath, { data: { ...original, expectedVersion: workflow.version,
      statuses: original.statuses.map(status => ({ ...status, defaultDueWorkdays: status.defaultDueWorkdays ?? null })),
    } });
  }
});
