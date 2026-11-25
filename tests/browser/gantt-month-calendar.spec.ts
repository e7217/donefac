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
    async milestone(name: string, date: string, issueIds: string[] = []) {
      const milestone = await json<Milestone>(await request.post('/api/milestones', {
        headers, data: { projectId: project.id, title: `${prefix} ${name}`, date, issueIds },
      }), 201);
      milestones.push(milestone);
      return milestone;
    },
    stored: async (issue: Issue) => (await read()).issues.find(item => item.id === issue.id),
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
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
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
