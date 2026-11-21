import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { calendarDate, calendarDay } from '../../shared/calendar';
import { reservationLocalDateTime } from '../../shared/time-reservations';
import type { DeadlineReminderPreferences, Issue, TeamNotificationPage, TeamOverviewResult, User, WorkspaceSnapshot } from '../../shared/types';
import { projectWorkflow } from '../../shared/workflow-helpers';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'America/Los_Angeles' });

const preferencePath = '/api/notifications/deadline-reminders';
const reminderLabels = {
  'issue-deadline-upcoming': '업무 마감 임박',
  'issue-deadline-today': '업무 마감 당일',
  'issue-deadline-overdue': '업무 마감 초과',
} as const;
const defaultPreferences = { daysBefore: 0, onDueDate: false, overdue: false, version: null };

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function makeRecipient(request: APIRequestContext, name: string) {
  return readJson<User>(await request.post('/api/users', { data: {
    name, email: `reminders-${randomUUID()}@example.test`,
  } }), 201);
}

async function openSettings(page: Page, projectId: string, recipient: User) {
  await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), recipient.id);
  await page.goto(`/#/${projectId}/settings`);
  const actor = page.getByLabel('작업자 선택', { exact: true });
  await expect(actor).toHaveValue(recipient.id, { timeout: 35_000 });
  const settings = page.getByRole('region', { name: '업무 마감 알림', exact: true });
  return {
    actor,
    settings,
    days: settings.getByRole('combobox', { name: '마감 전 알림', exact: true }),
    todayToggle: settings.getByRole('checkbox', { name: '마감 당일', exact: true }),
    overdueToggle: settings.getByRole('checkbox', { name: '마감 초과', exact: true }),
    save: settings.getByRole('button', { name: '마감 알림 설정 저장', exact: true }),
  };
}

test('360px에서 담당 업무의 서울 기준 마감 알림을 설정하고 알림에서 업무를 연다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const workspace = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const project = workspace.projects[0];
  const editor = workspace.users[0];
  const editorHeaders = { 'X-Actor-Id': editor.id };
  const prefix = `마감 알림 ${randomUUID().slice(0, 8)}`;
  const recipient = await makeRecipient(request, `${prefix} 담당자`);
  const recipientHeaders = { 'X-Actor-Id': recipient.id };
  const workflow = projectWorkflow(workspace, project.id);
  const closed = (category: 'done' | 'cancelled') => workflow.statuses.find(status => status.category === category)!.id;
  const issues: Issue[] = [];
  let enabled = false;

  async function makeIssue(suffix: string, fields: Partial<Issue>) {
    const issue = await readJson<Issue>(await request.post('/api/issues', {
      headers: editorHeaders,
      data: { projectId: project.id, title: `${prefix} ${suffix}`, assigneeId: recipient.id, ...fields },
    }), 201);
    issues.push(issue);
    return issue;
  }

  async function preferences(headers = recipientHeaders) {
    return readJson<DeadlineReminderPreferences>(await request.get(preferencePath, { headers }));
  }

  async function reminders() {
    const result = await readJson<TeamNotificationPage>(await request.get('/api/notifications', { headers: recipientHeaders }));
    return result.items.filter(item => Object.hasOwn(reminderLabels, item.kind));
  }

  try {
    const editorPreferences = await preferences(editorHeaders);
    expect(await preferences()).toEqual(defaultPreferences);
    const { actor, days, todayToggle, overdueToggle, save } = await openSettings(page, project.id, recipient);
    await expect(days).toHaveValue('0');
    await expect(todayToggle).not.toBeChecked();
    await expect(overdueToggle).not.toBeChecked();
    await expect(save).toBeDisabled();
    await days.selectOption('2');
    await todayToggle.check();
    await overdueToggle.check();

    const { date, timeZone } = await readJson<TeamOverviewResult>(await request.get('/api/team-overview'));
    expect(timeZone).toBe('Asia/Seoul');
    const day = (offset: number) => calendarDate(calendarDay(date) + offset);
    // Include consecutive dates so all three states are present even at the Seoul day rollover.
    const due = await makeIssue('종료일 기준 첫 업무', { endDate: day(0) });
    const next = await makeIssue('종료일 기준 둘째 업무', { endDate: day(1) });
    const upcoming = await makeIssue('목표 마감일 우선 업무', { dueDate: day(2), endDate: day(-4) });
    const overdue = await makeIssue('이미 기한을 넘긴 업무', { dueDate: day(-4) });
    await makeIssue('알림 범위 밖 업무', { dueDate: day(10), endDate: day(0) });
    await makeIssue('완료 업무', { status: closed('done'), dueDate: day(0) });
    await makeIssue('취소 업무', { status: closed('cancelled'), dueDate: day(-4) });
    await makeIssue('협력 중인 업무', { assigneeId: editor.id, collaboratorIds: [recipient.id], dueDate: day(0) });
    await makeIssue('마감 미정 업무', {});
    expect(await reminders()).toEqual([]);

    const saved = page.waitForResponse(response => new URL(response.url()).pathname === preferencePath && response.request().method() === 'PUT');
    await save.click();
    const response = await saved;
    const stored = await readJson<DeadlineReminderPreferences>(response);
    enabled = true;
    expect(response.request().postDataJSON()).toEqual({ daysBefore: 2, onDueDate: true, overdue: true, expectedVersion: null });
    expect(stored).toMatchObject({ daysBefore: 2, onDueDate: true, overdue: true, version: expect.any(String) });
    await expect(save).toBeDisabled();

    const notices = await reminders();
    const targets = [
      { issue: due, deadline: day(0) },
      { issue: next, deadline: day(1) },
      { issue: upcoming, deadline: day(2) },
      { issue: overdue, deadline: day(-4) },
    ];
    const deadlines = new Map(targets.map(({ issue, deadline }) => [issue.id, deadline]));
    expect(new Set(notices.map(item => item.targetId))).toEqual(new Set(deadlines.keys()));
    for (const notice of notices) {
      const deadline = deadlines.get(notice.targetId)!;
      const generatedDay = reservationLocalDateTime(notice.createdAt).slice(0, 10);
      const kind = deadline < generatedDay ? 'issue-deadline-overdue'
        : deadline === generatedDay ? 'issue-deadline-today' : 'issue-deadline-upcoming';
      expect(notice).toMatchObject({
        recipientId: recipient.id, actorId: null, kind, projectId: project.id, detail: expect.stringContaining(deadline), readAt: null,
      });
    }
    expect(new Set(notices.map(item => item.kind))).toEqual(new Set(Object.keys(reminderLabels)));

    await page.reload();
    await expect(days).toHaveValue('2');
    await expect(todayToggle).toBeChecked();
    await expect(overdueToggle).toBeChecked();
    await actor.selectOption(editor.id);
    await expect(days).toHaveValue(String(editorPreferences.daysBefore));
    await actor.selectOption(recipient.id);
    await expect(days).toHaveValue('2');
    expect(await preferences(editorHeaders)).toEqual(editorPreferences);

    const trigger = page.getByRole('button', { name: '알림', exact: true });
    const inbox = page.getByRole('dialog', { name: '팀 알림', exact: true });
    await trigger.click();
    await expect(inbox).toBeVisible();
    const position = await inbox.boundingBox();
    expect(position).not.toBeNull();
    expect(position!.x).toBeGreaterThanOrEqual(0);
    expect(position!.x + position!.width).toBeLessThanOrEqual(360);
    const today = notices.find(item => item.kind === 'issue-deadline-today')!;
    const target = targets.find(({ issue }) => issue.id === today.targetId)!;
    const action = inbox.getByRole('button').filter({ hasText: target.issue.title }).filter({ hasText: reminderLabels['issue-deadline-today'] });
    await expect(action).toContainText('자동 알림');
    await expect(action).toContainText(target.deadline);
    await action.click();
    await expect(page.getByRole('dialog', { name: target.issue.title, exact: true })).toBeVisible();
    await expect(page).toHaveURL(`/#/${project.id}/issues?issue=${target.issue.id}`);
    await expect.poll(async () => (await reminders()).find(item => item.id === today.id)?.readAt).toEqual(expect.any(String));
    const repeated = await reminders();
    for (const notice of notices) {
      expect(repeated.filter(item => item.targetId === notice.targetId && item.kind === notice.kind).map(item => item.id)).toEqual([notice.id]);
    }
  } finally {
    if (enabled) {
      const current = await preferences();
      await request.put(preferencePath, { headers: recipientHeaders, data: {
        daysBefore: 0, onDueDate: false, overdue: false, expectedVersion: current.version,
      } });
    }
    for (const issue of issues.reverse()) {
      const deleted = await request.delete(`/api/issues/${issue.id}`, { headers: editorHeaders });
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers: editorHeaders });
      }
    }
  }
});

test('마감 알림 설정 충돌 후 최신 설정을 불러와 편집 항목을 유지한다', async ({ page, request }) => {
  const workspace = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const recipient = await makeRecipient(request, `마감 설정 충돌 ${randomUUID().slice(0, 8)}`);
  const headers = { 'X-Actor-Id': recipient.id };
  const { settings, days, todayToggle, overdueToggle, save } = await openSettings(page, workspace.projects[0].id, recipient);
  await days.selectOption('3');

  const concurrent = await readJson<DeadlineReminderPreferences>(await request.put(preferencePath, { headers, data: {
    daysBefore: 0, onDueDate: false, overdue: true, expectedVersion: null,
  } }));
  try {
    await save.click();
    await expect(settings.getByRole('alert')).toContainText('다른 화면에서 설정이 바뀌었습니다.');
    await expect(days).toHaveValue('3');
    await expect(save).toBeDisabled();
    expect(await readJson<DeadlineReminderPreferences>(await request.get(preferencePath, { headers }))).toEqual(concurrent);

    await settings.getByRole('button', { name: '최신 마감 알림 설정 불러오기', exact: true }).click();
    await expect(settings.getByRole('alert')).toHaveCount(0);
    await expect(days).toHaveValue('3');
    await expect(todayToggle).not.toBeChecked();
    await expect(overdueToggle).toBeChecked();
    await save.click();
    await expect(page.getByText('마감 알림 설정을 저장했습니다.', { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    const updated = await readJson<DeadlineReminderPreferences>(await request.get(preferencePath, { headers }));
    expect(updated).toMatchObject({ daysBefore: 3, onDueDate: false, overdue: true });
    expect(updated.version).not.toBe(concurrent.version);
  } finally {
    const current = await readJson<DeadlineReminderPreferences>(await request.get(preferencePath, { headers }));
    await request.put(preferencePath, { headers, data: {
      daysBefore: 0, onDueDate: false, overdue: false, expectedVersion: current.version,
    } });
  }
});
