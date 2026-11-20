import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, IssueTimeReservationEntry, WorkspaceSnapshot } from '../../shared/types';

test.use({ timezoneId: 'America/Los_Angeles', viewport: { width: 360, height: 820 } });

const date = '2026-11-23';
const utc = (time: string) => `${date}T${time}:00.000Z`;
const seoul = (time: string) => `${date}T${time}`;
const path = (issueId: string, reservationId?: string) => `/api/issues/${issueId}/time-reservations${reservationId ? `/${reservationId}` : ''}`;

async function createIssue(request: APIRequestContext, projectId: string, title: string) {
  const response = await request.post('/api/issues', { data: {
    projectId, title: `${title} ${randomUUID()}`, startDate: date, endDate: date, plannedEffortMinutes: 120,
  } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<Issue>;
}

async function removeIssue(request: APIRequestContext, issue: Issue) {
  const response = await request.delete(`/api/issues/${issue.id}`);
  expect([200, 404]).toContain(response.status());
  if (response.ok()) {
    const { trashEntryId } = await response.json() as { trashEntryId: string };
    const purged = await request.delete(`/api/trash/${trashEntryId}`);
    expect(purged.ok(), await purged.text()).toBeTruthy();
  }
}

async function timeSlots(request: APIRequestContext, issue: Issue) {
  const response = await request.get(path(issue.id));
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<IssueTimeReservationEntry[]>;
}

async function addBooking(request: APIRequestContext, issue: Issue, userId: string, start: string, end: string) {
  const response = await request.post(path(issue.id), { data: { userId, startAt: utc(start), endAt: utc(end), requestId: randomUUID() } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<IssueTimeReservationEntry>;
}

test('360px 간트에서 프로젝트 간 시간 겹침을 확인하고 이중 저장 없이 이어서 배정한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [project, otherProject] = workspace.projects;
  const [member] = workspace.users;
  const issues: Issue[] = [];
  try {
    const first = await createIssue(request, project.id, '시간 배정을 추가할 합성 업무');
    issues.push(first);
    const blocker = await createIssue(request, otherProject.id, '다른 프로젝트의 겹친 합성 업무');
    issues.push(blocker);
    await addBooking(request, blocker, member.id, '00:00', '01:00');

    await page.goto(`/#/${project.id}/gantt`);
    const toggle = page.getByRole('button', { name: '시간 배정', exact: true });
    await toggle.click();
    const planner = page.getByRole('region', { name: '팀원 시간 배정', exact: true });
    await expect(planner).toContainText('Asia/Seoul');
    await planner.getByLabel('배정 조회 날짜', { exact: true }).fill(date);
    await planner.getByRole('combobox', { name: '팀원 필터', exact: true }).selectOption(member.id);
    const existing = planner.getByRole('listitem').filter({ hasText: blocker.title });
    await expect(existing).toContainText('09:00 ~ 10:00');
    await expect(existing.getByRole('button', { name: '배정 수정', exact: true })).toHaveCount(0);

    await planner.getByRole('button', { name: '시간 배정 추가', exact: true }).click();
    const form = planner.getByRole('form', { name: '시간 배정 편집' });
    await form.getByRole('combobox', { name: '예약 업무', exact: true }).selectOption(first.id);
    await form.getByRole('combobox', { name: '배정 팀원', exact: true }).selectOption(member.id);
    const start = form.getByLabel('시작 시각', { exact: true });
    const end = form.getByLabel('종료 시각', { exact: true });
    await start.fill(seoul('09:30'));
    await end.fill(seoul('10:30'));

    page.once('dialog', dialog => void dialog.dismiss());
    await toggle.click();
    await expect(form).toBeVisible();
    await expect(start).toHaveValue(seoul('09:30'));

    const save = form.getByRole('button', { name: '배정 저장', exact: true });
    await save.click();
    await expect(form.getByRole('alert')).toContainText(blocker.key);
    await expect(start).toHaveValue(seoul('09:30'));
    await expect(end).toHaveValue(seoul('10:30'));
    expect(await timeSlots(request, first)).toEqual([]);

    const attempts: string[] = [];
    await page.route(`**${path(first.id)}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const posted = route.request().postDataJSON() as { requestId: string; startAt: string; endAt: string };
      expect(posted).toMatchObject({ startAt: utc('01:00'), endAt: utc('01:30') });
      attempts.push(posted.requestId);
      if (attempts.length === 1) {
        expect((await route.fetch()).status()).toBe(201);
        await route.abort('failed');
      } else await route.continue();
    });
    await start.fill(seoul('10:00'));
    await save.click();
    await form.getByRole('button', { name: '배정 저장 결과 확인', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    const recorded = await timeSlots(request, first);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ id: attempts[0], userId: member.id, startAt: utc('01:00'), endAt: utc('01:30') });
    const issueButton = planner.getByRole('button', { name: `${first.key} ${first.title}`, exact: true });
    await issueButton.click();
    const drawer = page.getByRole('dialog', { name: first.title, exact: true });
    await drawer.getByRole('button', { name: '시간 배정', exact: true }).click();
    const ticketReservations = drawer.getByRole('region', { name: '업무 시간 배정', exact: true });
    await expect(ticketReservations).toContainText('10:00 ~ 10:30');
    await ticketReservations.getByRole('button', { name: '배정 수정', exact: true }).click();
    const ticketEdit = ticketReservations.getByRole('form', { name: '시간 배정 편집' });
    await ticketEdit.getByLabel('종료 시각', { exact: true }).fill(seoul('10:45'));
    await ticketEdit.getByRole('button', { name: '배정 저장', exact: true }).click();
    await expect(ticketEdit).toHaveCount(0);
    await drawer.getByRole('button', { name: /변경 이력/ }).click();
    await expect(drawer.getByText(`${utc('01:00')} ~ ${utc('01:45')}`, { exact: false })).toBeVisible();
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(planner.getByRole('listitem').filter({ hasText: first.title })).toContainText('10:00 ~ 10:45');
    const current = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.find(issue => issue.id === first.id);
    expect(current).toMatchObject({ startDate: date, endDate: date, plannedEffortMinutes: 120, version: first.version });
  } finally {
    for (const issue of issues) await removeIssue(request, issue);
  }
});

test('360px 업무 상세에서 다른 작업자의 수정과 비교하고 사용자 입력을 유지해 시간 배정을 편집한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [project] = workspace.projects;
  const [member, editor] = workspace.users;
  const issue = await createIssue(request, project.id, '시간 배정 수정 검증 합성 업무');
  try {
    const first = await addBooking(request, issue, member.id, '02:00', '03:00');
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const drawer = page.getByRole('dialog', { name: issue.title, exact: true });
    await drawer.getByRole('button', { name: '시간 배정', exact: true }).click();
    const bookings = drawer.getByRole('region', { name: '업무 시간 배정', exact: true });
    await bookings.getByRole('button', { name: '배정 수정', exact: true }).click();
    const form = bookings.getByRole('form', { name: '시간 배정 편집' });
    const end = form.getByLabel('종료 시각', { exact: true });
    await end.fill(seoul('12:45'));
    page.once('dialog', dialog => void dialog.dismiss());
    await drawer.getByRole('button', { name: '상세 정보', exact: true }).click();
    await expect(end).toHaveValue(seoul('12:45'));

    const update = await request.patch(path(issue.id, first.id), {
      headers: { 'X-Actor-Id': editor.id },
      data: { userId: member.id, startAt: utc('02:00'), endAt: utc('03:15'), expectedVersion: first.version },
    });
    expect(update.ok(), await update.text()).toBeTruthy();
    const save = form.getByRole('button', { name: '배정 저장', exact: true });
    await save.click();
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(form).toContainText('11:00 ~ 12:15');
    await expect(end).toHaveValue(seoul('12:45'));
    await expect(save).toBeDisabled();
    await form.getByRole('button', { name: '최신 버전으로 계속 편집', exact: true }).click();
    await expect(end).toHaveValue(seoul('12:45'));
    await save.click();
    await expect(form).toHaveCount(0);
    await expect(bookings.getByRole('listitem')).toContainText('11:00 ~ 12:45');
    const rows = await timeSlots(request, issue);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, endAt: utc('03:45'), version: first.version + 2 });

    await bookings.getByRole('button', { name: '배정 삭제', exact: true }).click();
    const confirmation = bookings.getByRole('group', { name: '배정 삭제 확인', exact: true });
    await confirmation.getByRole('button', { name: '삭제 확인', exact: true }).click();
    await expect(bookings.getByRole('listitem')).toHaveCount(0);
    expect(await timeSlots(request, issue)).toEqual([]);
  } finally { await removeIssue(request, issue); }
});
