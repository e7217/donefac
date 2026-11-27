import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, Milestone, Project, ScheduleRowEditInput, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/row-edit/preview';
const applyPath = '/api/schedule/row-edit/apply';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function fixture(request: APIRequestContext) {
  const read = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [project, otherProject], users: [actor] } = await read();
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `월간 계획 ${randomUUID().slice(0, 8)}`;
  const issueIds: string[] = [], milestones: Milestone[] = [];
  return {
    project, otherProject, actor, prefix,
    async issue(name: string, dates: Partial<Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>>, owner: Project = project, matches = true) {
      const issue = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: owner.id, title: matches ? `${prefix} ${name}` : name, ...dates },
      }), 201);
      issueIds.push(issue.id);
      return issue;
    },
    async milestone(name: string, date: string, issueIds: string[] = [], owner: Project = project) {
      const milestone = await json<Milestone>(await request.post('/api/milestones', {
        headers, data: { projectId: owner.id, title: `${prefix} ${name}`, date, issueIds },
      }), 201);
      milestones.push(milestone);
      return milestone;
    },
    stored: async (issue: Issue) => (await read()).issues.find(item => item.id === issue.id),
    keepForCleanup(id: string) { issueIds.push(id); },
    async close() {
      for (const milestone of milestones) await request.delete(`/api/milestones/${milestone.id}?expectedVersion=${milestone.version}`, { headers });
      for (const id of issueIds.reverse()) {
        const removed = await request.delete(`/api/issues/${id}`, { headers });
        if (removed.ok()) await request.delete(`/api/trash/${(await removed.json()).trashEntryId}`, { headers });
      }
    },
  };
}

async function openGantt(page: Page, f: Awaited<ReturnType<typeof fixture>>, date: string, team = false) {
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), f.actor.id);
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${f.project.id}/gantt?ganttDate=${date}&ganttScale=day${team ? '&scope=team' : ''}`);
  const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  await expect(search).toBeVisible({ timeout: 35_000 });
  await search.fill(f.prefix);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  const toggle = page.getByRole('button', { name: '월간 일정', exact: true });
  const calendar = page.getByRole('region', { name: '월간 일정', exact: true });
  const agenda = calendar.getByRole('list', { name: '선택한 날의 일정', exact: true });
  return {
    chart, search, toggle, calendar, agenda,
    date: (value: string) => calendar.locator(`[data-calendar-date="${value}"]`),
    row: (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`),
    agendaIssue: (issue: Issue) => agenda.getByRole('button', { name: `${issue.key} ${issue.title}`, exact: true }),
  };
}

test('360px 월간 일정은 윤일에 저장된 날짜와 마일스톤을 모으고 기존 편집기로 초안을 이어서 저장한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const f = await fixture(request);
  try {
    const delivery = await f.issue('윤일 종료와 마감', { startDate: '2028-01-31', endDate: '2028-02-29', dueDate: '2028-02-29' });
    const review = await f.issue('윤일 시작', { startDate: '2028-02-29', endDate: '2028-03-03' });
    const outside = await f.issue('검색 밖 업무', { dueDate: '2028-02-29' }, f.project, false);
    const milestone = await f.milestone('공개 준비', '2028-02-29', [delivery.id]);
    const g = await openGantt(page, f, '2028-01-31');

    const inlineStart = g.row(delivery).getByLabel(`${delivery.key} 시작일`, { exact: true });
    const otherEnd = g.row(review).getByLabel(`${review.key} 종료일`, { exact: true });
    await inlineStart.fill('2028-02-01');
    await otherEnd.fill('2028-03-06');
    await g.toggle.click();
    await expect(g.calendar).toBeVisible();
    await expect(g.toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(g.date('2028-01-31')).toHaveAttribute('aria-pressed', 'true');
    await expect(g.date('2028-01-31')).toHaveAccessibleName('2028년 1월 31일 월요일 일정 1건');
    await g.date('2028-01-31').press('PageDown');
    const febEnd = g.date('2028-02-29');
    await expect(febEnd).toBeFocused();
    await expect(febEnd).toHaveAccessibleName('2028년 2월 29일 화요일 일정 3건');
    await expect(g.calendar.locator('[data-calendar-date]')).toHaveCount(29);
    await expect(g.agenda.getByRole('listitem')).toHaveCount(3);
    await expect(g.agenda.getByRole('button', { name: `${delivery.key} 종료일 수정`, exact: true })).toBeVisible();
    await expect(g.agenda.getByRole('button', { name: `${delivery.key} 목표 마감일 수정`, exact: true })).toBeVisible();
    await expect(g.agenda.getByRole('button', { name: `${review.key} 시작일 수정`, exact: true })).toBeVisible();
    await expect(g.agendaIssue(outside)).toHaveCount(0);
    await expect(g.agenda.getByRole('button', { name: milestone.title, exact: true })).toBeVisible();
    const bounds = await g.calendar.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const openIssue = g.agendaIssue(delivery);
    await openIssue.click();
    const drawer = page.getByRole('dialog', { name: delivery.title, exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(openIssue).toBeFocused();
    await expect(inlineStart).toHaveValue('2028-02-01');

    const edit = g.agenda.getByRole('button', { name: `${delivery.key} 종료일 수정`, exact: true });
    await edit.click();
    const modal = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const end = modal.getByLabel('종료일', { exact: true });
    await expect(end).toBeFocused();
    await expect(end).toHaveValue(delivery.endDate!);
    await expect(modal.getByLabel('시작일', { exact: true })).toHaveValue('2028-02-01');
    expect(await f.stored(delivery)).toMatchObject({ version: delivery.version, startDate: delivery.startDate, endDate: delivery.endDate });
    await end.fill('2028-02-28');
    const preview = page.waitForResponse(response => new URL(response.url()).pathname === previewPath);
    await modal.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const previewed = await preview;
    expect(previewed.ok(), await previewed.text()).toBeTruthy();
    expect((previewed.request().postDataJSON() as ScheduleRowEditInput).changes).toEqual({ startDate: '2028-02-01', endDate: '2028-02-28' });
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === applyPath);
    await modal.getByRole('button', { name: '일정과 연결 적용', exact: true }).click();
    const applied = await saved;
    expect(applied.ok(), await applied.text()).toBeTruthy();
    await expect(modal).toHaveCount(0);
    await expect(g.toggle).toBeFocused();
    await expect(g.agenda.getByRole('button', { name: `${delivery.key} 종료일 수정`, exact: true })).toHaveCount(0);
    await expect(g.agenda.getByRole('button', { name: `${delivery.key} 목표 마감일 수정`, exact: true })).toBeVisible();
    await expect(otherEnd).toHaveValue('2028-03-06');
    expect(await f.stored(review)).toMatchObject({ version: review.version, endDate: review.endDate });

    const openMilestone = g.agenda.getByRole('button', { name: milestone.title, exact: true });
    await openMilestone.click();
    const milestoneReview = page.getByRole('region', { name: '이정표 연결 업무', exact: true });
    await expect(milestoneReview).toBeVisible();
    await expect(milestoneReview.getByRole('heading', { name: milestone.title, exact: true })).toBeFocused();
    await milestoneReview.getByRole('button', { name: '연결 업무 닫기', exact: true }).click();
    await expect(openMilestone).toBeFocused();
    await expect(otherEnd).toHaveValue('2028-03-06');

    await febEnd.press('ArrowRight');
    await expect(g.date('2028-03-01')).toBeFocused();
    await expect(g.calendar.getByText('선택한 날에 표시할 일정이 없습니다.', { exact: true })).toBeVisible();
    await g.date('2028-03-01').press('Escape');
    await expect(g.calendar).toHaveCount(0);
    await expect(g.toggle).toBeFocused();
    await expect(g.search).toHaveValue(f.prefix);
    await expect(otherEnd).toHaveValue('2028-03-06');
  } finally {
    await f.close();
  }
});

test('팀 간트와 월간 일정에서 프로젝트별 이정표를 구분하고 연결 업무를 검토한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const selectedDay = '2031-02-14';
  try {
    const local = await f.issue('유지할 날짜 입력', { startDate: '2031-02-17', endDate: '2031-02-18' });
    const late = await f.issue('검색에 숨은 다른 프로젝트 후행 업무', { startDate: '2031-02-13', endDate: '2031-02-28' }, f.otherProject, false);
    const first = await f.milestone('출시 판단', selectedDay, [local.id]);
    const second = await f.milestone('출시 판단', selectedDay, [late.id], f.otherProject);
    const g = await openGantt(page, f, selectedDay, true);
    const firstChart = g.chart.getByRole('button', { name: `${f.project.key} ${first.title} 연결 업무 확인`, exact: true });
    const secondChart = g.chart.getByRole('button', { name: `${f.otherProject.key} ${second.title} 연결 업무 확인`, exact: true });
    await expect(firstChart).toBeVisible();
    await expect(secondChart).toBeVisible();
    const draft = g.row(local).getByLabel(`${local.key} 종료일`, { exact: true });
    await draft.fill('2031-02-19');
    await g.toggle.click();
    await expect(g.date(selectedDay)).toHaveAccessibleName(/일정 2건$/u);
    const firstAgenda = g.agenda.getByRole('button', { name: `${f.project.key} ${first.title}`, exact: true });
    const secondAgenda = g.agenda.getByRole('button', { name: `${f.otherProject.key} ${second.title}`, exact: true });
    await expect(firstAgenda).toBeVisible();
    await secondAgenda.click();
    const review = page.getByRole('region', { name: '이정표 연결 업무', exact: true });
    await expect(review.getByRole('heading', { name: second.title, exact: true })).toBeFocused();
    await expect(review).toContainText(f.otherProject.name);
    await expect(review).toContainText('이정표 이후');
    const sharedLink = page.url();
    expect(new URLSearchParams(new URL(sharedLink).hash.split('?')[1]).get('milestone')).toBe(second.id);
    const detail = review.getByRole('button', { name: `${late.key} 상세 열기`, exact: true });
    await detail.click();
    const drawer = page.getByRole('dialog', { name: late.title, exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(detail).toBeFocused();
    await expect(draft).toHaveValue('2031-02-19');
    await review.getByRole('button', { name: `${late.key} 간트 위치`, exact: true }).click();
    await expect(g.row(late).getByLabel(`${late.key} 종료일`, { exact: true })).toBeFocused();
    await expect(review).toBeVisible();
    await expect(draft).toHaveValue('2031-02-19');

    const linkedPage = await page.context().newPage();
    try {
      await linkedPage.goto(sharedLink);
      const linkedReview = linkedPage.getByRole('region', { name: '이정표 연결 업무', exact: true });
      await expect(linkedReview).toContainText(f.otherProject.name);
      await expect(linkedReview).toContainText(late.title);
    } finally { await linkedPage.close(); }

    const filter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await filter.selectOption(f.project.id);
    await expect(review).toHaveCount(0);
    await expect(firstChart).toBeVisible();
    await expect(secondChart).toHaveCount(0);
    await expect(firstAgenda).toBeVisible();
    await expect(secondAgenda).toHaveCount(0);
    await expect(draft).toHaveValue('2031-02-19');
  } finally { await f.close(); }
});

test('팀 간트의 티켓에서 연결된 이정표를 열고 날짜 초안과 보기 이력을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const selectedDay = '2031-03-03';
  try {
    const owner = f.otherProject;
    const linked = await f.issue('이정표에 연결된 업무', { startDate: selectedDay, endDate: '2031-03-06' }, owner);
    const other = await f.issue('날짜 초안을 유지할 업무', { startDate: selectedDay, endDate: '2031-03-07' }, owner);
    const milestone = await f.milestone('연결된 이정표', '2031-03-05', [linked.id], owner);
    const g = await openGantt(page, f, selectedDay, true);
    const filter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await filter.selectOption(owner.id);
    const draft = g.row(other).getByLabel(`${other.key} 종료일`, { exact: true });
    await draft.fill('2031-03-10');
    await g.row(linked).getByRole('button', { name: new RegExp(linked.title) }).first().click();
    const drawer = page.getByRole('dialog', { name: linked.title, exact: true });
    await expect(drawer).toBeVisible();
    const ticketUrl = page.url();
    const milestoneLink = drawer.getByRole('link', { name: `${milestone.title} 간트에서 보기`, exact: true });
    const title = drawer.getByLabel('제목', { exact: true });
    await title.fill('저장하지 않은 제목');
    const declined = page.waitForEvent('dialog').then(async confirmation => {
      const message = confirmation.message();
      await confirmation.dismiss();
      return message;
    });
    await milestoneLink.click();
    expect(await declined).toContain('저장하지 않은 업무');
    await expect(page).toHaveURL(ticketUrl);
    await expect(title).toHaveValue('저장하지 않은 제목');

    await title.fill(linked.title);
    await milestoneLink.click();
    await expect(drawer).toHaveCount(0);
    const milestoneUrl = new URL(page.url());
    const [path, parameters] = milestoneUrl.hash.split('?');
    expect(path).toBe(`#/${f.project.id}/gantt`);
    expect(Object.fromEntries(new URLSearchParams(parameters))).toEqual({ scope: 'team', ganttProject: owner.id,
      ganttQ: f.prefix, ganttDate: selectedDay, ganttScale: 'day', milestone: milestone.id });
    const review = page.getByRole('region', { name: '이정표 연결 업무', exact: true });
    const heading = review.getByRole('heading', { name: milestone.title, exact: true });
    await expect(heading).toBeFocused();
    await expect(draft).toHaveValue('2031-03-10');

    await page.goBack();
    await expect(page).toHaveURL(ticketUrl);
    await expect(drawer).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(milestoneUrl.href);
    await expect(heading).toBeFocused();
    await expect(filter).toHaveValue(owner.id);
    await expect(g.search).toHaveValue(f.prefix);
    await expect(draft).toHaveValue('2031-03-10');
    expect(await f.stored(other)).toMatchObject({ endDate: '2031-03-07', version: other.version });

    const excluded = await page.context().newPage();
    try {
      await excluded.goto(`/#/${f.project.id}/gantt?${new URLSearchParams({ scope: 'team', ganttProject: f.project.id, issue: linked.id })}`);
      const excludedDrawer = excluded.getByRole('dialog', { name: linked.title, exact: true });
      await excludedDrawer.getByRole('link', { name: `${milestone.title} 간트에서 보기`, exact: true }).click();
      await expect(excluded).toHaveURL(url => url.hash === `#/${owner.id}/gantt?${new URLSearchParams({ milestone: milestone.id })}`);
      await expect(excluded.getByRole('heading', { name: milestone.title, exact: true })).toBeFocused();
    } finally { await excluded.close(); }
  } finally { await f.close(); }
});

test('전체 프로젝트 월간 일정은 프로젝트 필터를 적용하고 10건이 넘는 날의 나머지 업무도 보여 준다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const f = await fixture(request);
  const denseDate = '2028-06-15';
  try {
    const local = await f.issue('제외할 첫 프로젝트 마감일', { dueDate: denseDate });
    const external: Issue[] = [];
    for (let index = 1; index <= 11; index++) {
      external.push(await f.issue(`다른 프로젝트 마감 ${index}`, { dueDate: denseDate }, f.otherProject));
    }
    const g = await openGantt(page, f, denseDate, true);
    await g.toggle.click();
    const filter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await filter.selectOption(f.otherProject.id);
    await expect(g.date(denseDate)).toHaveAccessibleName('2028년 6월 15일 목요일 일정 11건');
    await expect(g.agenda.getByRole('listitem')).toHaveCount(10);
    await expect(g.agendaIssue(local)).toHaveCount(0);
    await expect(g.agendaIssue(external.at(-1)!)).toHaveCount(0);
    await g.calendar.getByRole('button', { name: '다음 일정 페이지', exact: true }).click();
    await expect(g.agenda.getByRole('listitem')).toHaveCount(1);
    await expect(g.agendaIssue(external.at(-1)!)).toBeVisible();
    await expect(g.agenda.getByText(f.otherProject.key, { exact: true })).toBeVisible();
    await g.date('2028-06-16').click();
    await expect(g.calendar.getByText('선택한 날에 표시할 일정이 없습니다.', { exact: true })).toBeVisible();
    await g.date(denseDate).click();
    await expect(g.agenda.getByRole('listitem')).toHaveCount(10);
    await expect(g.search).toHaveValue(f.prefix);
    await expect(filter).toHaveValue(f.otherProject.id);
  } finally {
    await f.close();
  }
});

test('월간 일정에서 작업 날짜를 다시 열고 선택한 프로젝트와 날짜를 팀원에게 공유한다', async ({ browser, page, context, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const recipient = await browser.newContext({ viewport: { width: 360, height: 820 } });
  try {
    const selectedDate = '2028-02-29';
    const local = await f.issue('필터 밖의 마감', { dueDate: selectedDate });
    const shared = await f.issue('함께 확인할 마감', { dueDate: selectedDate }, f.otherProject);
    const g = await openGantt(page, f, '2028-01-31', true);
    await page.getByRole('combobox', { name: '프로젝트 필터', exact: true }).selectOption(f.otherProject.id);
    const start = g.row(shared).getByLabel(`${shared.key} 시작일`, { exact: true });
    await start.fill('2028-01-31');
    await g.toggle.click();
    await g.date('2028-01-31').press('PageDown');
    await expect(g.agendaIssue(shared)).toBeVisible();
    await g.calendar.getByRole('button', { name: '월간 일정 닫기', exact: true }).click();
    await expect(g.toggle).toBeFocused();
    await g.toggle.click();
    await expect(g.date(selectedDate)).toHaveAttribute('aria-pressed', 'true');
    await expect(g.agendaIssue(shared)).toBeVisible();

    const origin = new URL(page.url()).origin;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const addressBeforeCopy = page.url();
    await g.calendar.getByRole('button', { name: '선택 날짜 링크 복사', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`ganttCalendar=${selectedDate}`);
    const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.origin).toBe(origin);
    expect(page.url()).toBe(addressBeforeCopy);
    await expect(start).toHaveValue('2028-01-31');
    expect(await f.stored(shared)).toMatchObject({ startDate: null, version: shared.version });

    const otherPage = await recipient.newPage();
    await otherPage.goto(copied.href);
    const otherCalendar = otherPage.getByRole('region', { name: '월간 일정', exact: true });
    const agenda = otherCalendar.getByRole('list', { name: '선택한 날의 일정', exact: true });
    await expect(otherPage.getByRole('combobox', { name: '프로젝트 필터', exact: true })).toHaveValue(f.otherProject.id);
    await expect(otherCalendar.locator(`[data-calendar-date="${selectedDate}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(agenda.getByRole('button', { name: `${shared.key} ${shared.title}`, exact: true })).toBeVisible();
    await expect(agenda.getByRole('button', { name: `${local.key} ${local.title}`, exact: true })).toHaveCount(0);
    await otherPage.reload();
    await expect(otherCalendar.locator(`[data-calendar-date="${selectedDate}"]`)).toHaveAttribute('aria-pressed', 'true');

    const invalid = new URL(copied);
    const [path, search] = invalid.hash.split('?');
    const query = new URLSearchParams(search);
    query.set('ganttCalendar', '2028-02-30');
    invalid.hash = `${path}?${query}`;
    await otherPage.goto(invalid.href);
    await expect(otherCalendar).toHaveCount(0);
    await expect(otherPage.getByRole('combobox', { name: '프로젝트 필터', exact: true })).toHaveValue(f.otherProject.id);
  } finally {
    await recipient.close();
    await f.close();
  }
});

test('360px 월간 일정에서 고른 날짜에 업무를 만들고 다른 날짜 초안과 팀 필터를 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const date = '2028-06-15';
  const title = `${f.prefix} 선택한 날의 새 업무`;
  try {
    const existing = await f.issue('입력 중인 기존 업무', { startDate: '2028-06-13', endDate: '2028-06-16' }, f.otherProject);
    const g = await openGantt(page, f, date, true);
    const filter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await filter.selectOption(f.otherProject.id);
    const existingEnd = g.row(existing).getByLabel(`${existing.key} 종료일`, { exact: true });
    await existingEnd.fill('2028-06-18');
    await g.toggle.click();
    await g.date(date).click();
    const add = g.calendar.getByRole('button', { name: '이 날짜에 업무 추가', exact: true });
    const form = g.calendar.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
    await add.click();
    const titleInput = form.getByRole('textbox', { name: '추가할 업무 제목', exact: true });
    await expect(titleInput).toBeFocused();
    await expect(form.getByLabel('추가할 업무 시작일', { exact: true })).toHaveValue(date);
    await expect(form.getByLabel('추가할 업무 종료일', { exact: true })).toHaveValue(date);
    await expect(form.getByRole('combobox', { name: '추가할 업무 프로젝트', exact: true })).toHaveValue(f.otherProject.id);
    const box = await form.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);

    await titleInput.fill(title);
    const declined = page.waitForEvent('dialog').then(dialog => dialog.dismiss());
    await form.getByRole('button', { name: '취소', exact: true }).click();
    await declined;
    await expect(titleInput).toHaveValue(title);
    const approved = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await form.getByRole('button', { name: '취소', exact: true }).click();
    await approved;
    await expect(form).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(existingEnd).toHaveValue('2028-06-18');

    await add.click();
    await titleInput.fill(title);
    const attempts: string[] = [];
    await page.route(url => url.pathname === '/api/issues', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postData()!);
      if (attempts.length > 1) return route.continue();
      const result = await json<Issue>(await route.fetch(), 201);
      f.keepForCleanup(result.id);
      await route.abort('failed');
    });
    await form.getByRole('button', { name: '간트에 추가', exact: true }).click();
    const retry = form.getByRole('button', { name: '업무 추가 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(form).toHaveCount(0);
    await expect(add).toBeFocused();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(JSON.parse(attempts[0])).toMatchObject({ projectId: f.otherProject.id, title, startDate: date, endDate: date });
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const saved = workspace.issues.filter(item => item.title === title);
    expect(saved).toHaveLength(1);
    await expect(g.agendaIssue(saved[0])).toBeVisible();
    await expect(g.date(date)).toHaveAttribute('aria-pressed', 'true');
    await expect(g.search).toHaveValue(f.prefix);
    await expect(filter).toHaveValue(f.otherProject.id);
    await expect(existingEnd).toHaveValue('2028-06-18');
    expect((await f.stored(existing))?.endDate).toBe('2028-06-16');
  } finally {
    await f.close();
  }
});
