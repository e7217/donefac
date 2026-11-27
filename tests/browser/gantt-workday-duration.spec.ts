import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePastePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const day = (number: number) => `2026-11-${String(number).padStart(2, '0')}`;
const previewPath = '/api/schedule/row-edit/preview';
const applyPath = '/api/schedule/row-edit/apply';
const undoPath = '/api/schedule/undo';
const readDates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const posted = (page: Page, path: string) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const issues: Issue[] = [];
  const calendars: [string, WorkCalendar, number][] = [];
  return {
    first, second, actor, headers, suffix,
    async create(projectId: string, title: string, dates: Partial<ReturnType<typeof readDates>>) {
      const issue = await json<Issue>(await request.post('/api/issues', { headers, data: { projectId, title: `${title} ${suffix}`, ...dates } }), 201);
      issues.push(issue);
      return issue;
    },
    track(issue: Issue) { issues.push(issue); },
    async calendar(projectId: string, exceptions: WorkCalendar['exceptions'] = []) {
      const path = `/api/projects/${projectId}/calendar`;
      const original = await json<WorkCalendar>(await request.get(path));
      const saved = await json<WorkCalendar>(await request.patch(path, { headers, data: {
        ...original, expectedVersion: original.version, workingWeekdays: [1, 2, 3, 4, 5], exceptions,
      } }));
      calendars.push([path, original, saved.version]);
    },
    async clean() {
      try {
        for (const issue of issues.reverse()) {
          const removal = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${issue.id}`, { headers }));
          expect((await request.delete(`/api/trash/${removal.trashEntryId}`, { headers })).ok()).toBeTruthy();
        }
      } finally {
        for (const [path, original, expectedVersion] of calendars.reverse()) {
          await json<WorkCalendar>(await request.patch(path, { headers, data: { ...original, expectedVersion } }));
        }
      }
    },
  };
}

const shiftedWorkdays: WorkCalendar['exceptions'] = [
  { date: day(20), isWorking: false, label: '합성 금요일 휴무' },
  { date: day(21), isWorking: true, label: '합성 토요일 근무' },
  { date: day(23), isWorking: false, label: '합성 월요일 휴무' },
];

async function openCalculator(within: Locator) {
  const picker = within.locator('details').filter({ hasText: '근무일 기간 계산' });
  await picker.getByText('근무일 기간 계산', { exact: true }).click();
  const basis = picker.getByRole('combobox', { name: '계산 기준', exact: true });
  const count = picker.getByRole('textbox', { name: '근무일 수', exact: true });
  return { picker, basis, count, reflect: button(picker, '날짜에 반영') };
}

async function mobileGantt(page: Page, hash: string, actorId: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actorId);
  await page.goto(`/${hash}`);
  const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  await expect(search).toBeVisible();
  return search;
}

test('360px 간트 업무 행에서 휴일과 토요일 근무를 적용해 양방향으로 날짜를 계산한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    await f.calendar(f.first.id, shiftedWorkdays);
    const predecessor = await f.create(f.first.id, '근무일 계산 선행 업무', { startDate: day(17), endDate: day(18) });
    const anchor = await f.create(f.first.id, '근무일 계산할 업무', { startDate: day(20), endDate: day(26), dueDate: day(30) });
    const link = await json<Dependency>(await request.post('/api/dependencies', { headers: f.headers, data: {
      predecessorId: predecessor.id, successorId: anchor.id, type: 'FS', lagDays: 0,
    } }), 201);
    const readAnchor = async () => (await workspace(request)).issues.find(issue => issue.id === anchor.id);
    const search = await mobileGantt(page, `#/${f.first.id}/gantt`, f.actor.id);
    await search.fill(anchor.title);
    const opener = button(page, `${anchor.key} 일정과 연결 편집`);
    await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const start = dialog.getByLabel('시작일', { exact: true });
    const end = dialog.getByLabel('종료일', { exact: true });
    const due = dialog.getByLabel('목표 마감일', { exact: true });
    const review = button(dialog, '변경 미리보기');
    const apply = button(dialog, '일정과 연결 적용');
    const outgoing: string[] = [];
    page.on('request', sent => {
      const { pathname } = new URL(sent.url());
      if (sent.method() !== 'GET' && (pathname.startsWith('/api/schedule/') || pathname.startsWith('/api/issues/'))) outgoing.push(pathname);
    });

    await end.fill(day(27));
    const previousReview = posted(page, previewPath);
    await review.click();
    const prior = await json<SchedulePastePreview>(await previousReview);
    expect(prior.previewId).toBeTruthy();
    await expect(apply).toBeEnabled();
    const { picker, basis, count, reflect } = await openCalculator(dialog);
    await basis.selectOption('startDate');
    await count.fill('0');
    await expect(reflect).toBeDisabled();
    await count.press('Enter');
    expect(outgoing).toEqual([previewPath]);
    await expect(end).toHaveValue(day(27));

    await count.fill('3');
    await expect(picker.getByText('기준 날짜는 비근무일입니다. 날짜는 유지하고 근무일 수에서 제외합니다.', { exact: true })).toBeVisible();
    await expect(picker.getByText(day(25), { exact: true })).toBeVisible();
    await reflect.click();
    await expect(start).toHaveValue(day(20));
    await expect(end).toHaveValue(day(25));
    await expect(due).toHaveValue(day(30));
    await expect(apply).toBeDisabled();
    expect(outgoing).toEqual([previewPath]);
    expect(await readAnchor()).toEqual(anchor);

    await end.fill(day(23));
    await basis.selectOption('endDate');
    await count.fill('2');
    await expect(picker.getByText(day(19), { exact: true })).toBeVisible();
    await reflect.click();
    await expect(start).toHaveValue(day(19));
    await expect(end).toHaveValue(day(23));
    await expect(due).toHaveValue(day(30));
    expect(outgoing).toEqual([previewPath]);
    expect(await readAnchor()).toEqual(anchor);

    const finalReview = posted(page, previewPath);
    await review.click();
    const response = await finalReview;
    expect(response.request().postDataJSON()).toEqual({
      projectId: f.first.id, issue: { id: anchor.id, expectedVersion: anchor.version }, changes: { startDate: day(19), endDate: day(23) },
    });
    const proposed = await json<SchedulePastePreview>(response);
    expect(proposed.errors).toEqual([]);
    expect(proposed.previewId).toBeTruthy();
    expect(proposed.previewId).not.toBe(prior.previewId);
    const applied = posted(page, applyPath);
    await apply.click();
    const saved = await json<SchedulePasteApplyResult>(await applied);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await readAnchor()).toMatchObject({ startDate: day(19), endDate: day(23), dueDate: day(30), version: anchor.version + 1 });
    expect((await workspace(request)).dependencies.find(dependency => dependency.id === link.id)).toEqual(link);
    const undone = posted(page, undoPath);
    await button(page, '되돌리기').click();
    const undoResponse = await undone;
    expect(undoResponse.request().postDataJSON()).toEqual({ undoId: saved.undoId });
    await json<{ updated: Issue[] }>(undoResponse);
    await expect(page.getByLabel(`${anchor.key} 시작일`, { exact: true })).toHaveValue(day(20));
    const restored = await workspace(request);
    expect(restored.issues.find(issue => issue.id === anchor.id)).toMatchObject({ ...readDates(anchor), version: anchor.version + 2 });
    expect(restored.dependencies.find(dependency => dependency.id === link.id)).toEqual(link);
    expect(restored.issues.find(issue => issue.id === predecessor.id)).toEqual(predecessor);
  } finally { await f.clean(); }
});

test('360px 전체 프로젝트 간트에서 선택한 프로젝트의 달력으로 새 업무 날짜를 저장한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const f = await fixture(request);
  try {
    await f.calendar(f.first.id);
    await f.calendar(f.second.id, shiftedWorkdays);
    const title = `프로젝트별 근무일 계산 ${f.suffix}`;
    const hash = `#/${f.first.id}/gantt?scope=team`;
    const search = await mobileGantt(page, hash, f.actor.id);
    await button(page, '업무 추가').click();
    const form = page.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
    await form.getByLabel('추가할 업무 제목', { exact: true }).fill(title);
    const project = form.getByLabel('추가할 업무 프로젝트', { exact: true });
    await project.selectOption(f.first.id);
    const start = form.getByLabel('추가할 업무 시작일', { exact: true });
    const end = form.getByLabel('추가할 업무 종료일', { exact: true });
    await start.fill(day(20));
    const { picker, basis, count, reflect } = await openCalculator(form);
    await basis.selectOption('startDate');
    await count.fill('3');
    await expect(picker.getByText(day(24), { exact: true })).toBeVisible();
    const writes: unknown[] = [];
    page.on('request', sent => { if (new URL(sent.url()).pathname === '/api/issues' && sent.method() === 'POST') writes.push(sent.postDataJSON()); });
    await count.press('Enter');
    await project.selectOption(f.second.id);
    await expect(picker.getByText(day(25), { exact: true })).toBeVisible();
    await expect(count).toHaveValue('3');
    await expect(end).toHaveValue('');
    await reflect.click();
    await expect(start).toHaveValue(day(20));
    await expect(end).toHaveValue(day(25));
    expect(writes).toEqual([]);
    expect((await workspace(request)).issues.filter(issue => issue.title === title)).toHaveLength(0);

    const result = posted(page, '/api/issues');
    await button(form, '간트에 추가').click();
    const created = await result;
    expect(created.request().postDataJSON()).toMatchObject({ projectId: f.second.id, title, startDate: day(20), endDate: day(25) });
    const saved = await json<Issue>(created, 201);
    f.track(saved);
    expect(saved).toMatchObject({ projectId: f.second.id, startDate: day(20), endDate: day(25) });
    await expect(form).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === hash);
    await search.fill(title);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = chart.locator(`[data-issue-id="${saved.id}"]`);
    await expect(row.locator('.gantt-row-project')).toHaveText(f.second.key);
    await expect(row.getByLabel(`${saved.key} 시작일`, { exact: true })).toHaveValue(day(20));
    await expect(row.getByLabel(`${saved.key} 종료일`, { exact: true })).toHaveValue(day(25));
    expect(writes).toHaveLength(1);
    expect((await workspace(request)).issues.filter(issue => issue.title === title)).toEqual([saved]);
  } finally { await f.clean(); }
});
