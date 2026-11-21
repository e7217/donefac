import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type { Dependency, Issue, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const friday = '2026-11-20';
const monday = '2026-11-23';
const tuesday = '2026-11-24';
const wednesday = '2026-11-25';
const thursday = '2026-11-26';
const windowStart = '2026-11-18';
const chart = (page: Page) => page.getByRole('region', { name: '간트 차트', exact: true });
const row = (page: Page, issue: Issue) => chart(page).locator(`[data-issue-id="${issue.id}"]`);
const dateField = (page: Page, issue: Issue, edge: '시작일' | '종료일') => row(page, issue).getByLabel(`${issue.key} ${edge}`, { exact: true });
const refreshButton = (page: Page) => page.getByRole('button', { name: '간트 새로고침', exact: true });
const search = (page: Page) => page.getByLabel('간트 업무 검색', { exact: true });
const workspaceUrl = (url: URL) => url.pathname === '/api/workspace';
const pollUrl = (url: URL) => workspaceUrl(url) && url.searchParams.has('ganttSince');
const fullUrl = (url: URL) => workspaceUrl(url) && !pollUrl(url);
const revision = (response: Response) => response.headers()['x-teamspace-gantt-revision'];

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const snapshot = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const waitingForPoll = (page: Page, status: number) => page.waitForResponse(response => pollUrl(new URL(response.url())) && response.status() === status);

async function tick(page: Page, status: number) {
  const pending = waitingForPoll(page, status);
  await page.clock.runFor(15_100);
  return pending;
}

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor, peer] } = await snapshot(request);
  const headers = { 'X-Actor-Id': actor.id };
  const remote = { 'X-Actor-Id': peer.id };
  const prefix = `간트 갱신 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  return {
    first, second, actor, prefix, headers, remote,
    async issue(projectId: string, suffix: string, startDate: string, endDate = startDate) {
      const created = await json<Issue>(await request.post('/api/issues', { headers, data: {
        projectId, title: `${prefix} ${suffix}`, startDate, endDate,
      } }), 201);
      issues.push(created);
      return created;
    },
    async move(issue: Issue, startDate: string, endDate: string) {
      const { updated } = await json<{ updated: Issue[] }>(await request.post('/api/schedule/apply', { headers: remote, data: {
        changes: [{ id: issue.id, expectedVersion: issue.version, startDate, endDate }],
      } }));
      expect(updated).toHaveLength(1);
      return updated[0];
    },
    async read(issue: Issue) { return (await snapshot(request)).issues.find(value => value.id === issue.id); },
    async cleanup() {
      for (const issue of issues.reverse()) {
        const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${issue.id}`, { headers }));
        expect((await request.delete(`/api/trash/${trashEntryId}`, { headers })).ok()).toBeTruthy();
      }
    },
  };
}

async function openChart(page: Page, hash: string, query: string, actorId: string) {
  await page.clock.install();
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  await page.goto(`/${hash}`);
  await expect(chart(page)).toBeVisible();
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  await search(page).fill(query);
  await page.getByLabel('간트 표시 시작일', { exact: true }).fill(windowStart);
}

test('전체 프로젝트 간트에서 원격 달력, 연결, 날짜를 갱신하고 현재 보기를 유지한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const f = await fixture(request);
  const calendarPath = `/api/projects/${f.second.id}/calendar`;
  const calendar = await json<WorkCalendar>(await request.get(calendarPath));
  let changedCalendar: WorkCalendar | undefined;
  try {
    const predecessor = await f.issue(f.second.id, '선행 업무', friday);
    const successor = await f.issue(f.second.id, '후행 업무', monday);
    const foreign = await f.issue(f.first.id, '다른 프로젝트 업무', monday);
    const dep = await json<Dependency>(await request.post('/api/dependencies', { headers: f.headers, data: {
      predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0,
    } }), 201);

    const hash = `#/${f.first.id}/gantt?${new URLSearchParams({ scope: 'team', ganttProject: f.second.id })}`;
    const unchanged = waitingForPoll(page, 204);
    await openChart(page, hash, f.prefix, f.actor.id);
    const week = page.getByRole('button', { name: '주', exact: true });
    await week.click();
    const selection = row(page, successor).getByRole('checkbox', { name: `${successor.key} 선택`, exact: true });
    await selection.check();
    await search(page).focus();
    const scroll = await chart(page).evaluate(element => { element.scrollLeft = 210; return element.scrollLeft; });
    expect(scroll).toBeGreaterThan(0);
    await page.clock.runFor(15_100);
    const initial = await unchanged;
    expect(revision(initial)).toMatch(/^[a-f0-9]{32}$/u);
    expect(new URL(initial.url()).searchParams.get('ganttSince')).toBe(revision(initial));
    expect(initial.headers()['content-length'] ?? '0').toBe('0');

    const day = chart(page).locator(`.gantt-days [data-date="${monday}"]`);
    const connector = chart(page).locator(`[data-dependency-id="${dep.id}"]`);
    await expect(day).not.toHaveClass(/\bweekend\b/);
    await expect(connector).toHaveAttribute('data-dependency-type', 'FS');
    await expect(connector).not.toHaveAttribute('data-dependency-conflict', 'true');
    await expect(dateField(page, successor, '시작일')).toHaveValue(monday);

    const assertView = async () => {
      await expect(page).toHaveURL(url => url.hash === hash);
      await expect(page.getByRole('combobox', { name: '프로젝트 필터', exact: true })).toHaveValue(f.second.id);
      await expect(page.getByLabel('간트 표시 시작일', { exact: true })).toHaveValue(windowStart);
      await expect(week).toHaveClass(/\bactive\b/);
      await expect(search(page)).toHaveValue(f.prefix);
      await expect(search(page)).toBeFocused();
      await expect(selection).toBeChecked();
      await expect(row(page, foreign)).toHaveCount(0);
      expect(await chart(page).evaluate(element => element.scrollLeft)).toBe(scroll);
    };

    changedCalendar = await json<WorkCalendar>(await request.patch(calendarPath, { headers: f.remote, data: {
      ...calendar, expectedVersion: calendar.version, exceptions: [
        ...calendar.exceptions.filter(value => value.date !== monday), { date: monday, isWorking: false, label: '갱신 테스트 휴일' },
      ],
    } }));
    const calendarReply = await tick(page, 200);
    expect(revision(calendarReply)).not.toBe(revision(initial));
    expect((await json<WorkspaceSnapshot>(calendarReply)).calendars?.find(value => value.id === calendar.id)).toEqual(changedCalendar);
    await expect(day).toHaveClass(/\bweekend\b/);
    await expect(connector).toHaveAttribute('data-dependency-conflict', 'true');
    await assertView();

    const changedDependency = await json<Dependency>(await request.patch(`/api/dependencies/${dep.id}`, {
      headers: f.remote, data: { expectedVersion: dep.version, type: 'SS' },
    }));
    const dependencyReply = await tick(page, 200);
    expect(revision(dependencyReply)).not.toBe(revision(calendarReply));
    expect((await json<WorkspaceSnapshot>(dependencyReply)).dependencies.find(value => value.id === dep.id)).toEqual(changedDependency);
    await expect(connector).toHaveAttribute('data-dependency-type', 'SS');
    await expect(connector).toHaveAttribute('data-predecessor-anchor', 'startDate');
    await expect(connector).not.toHaveAttribute('data-dependency-conflict', 'true');
    const oldPath = await connector.getAttribute('d');
    await assertView();

    const moved = await f.move(successor, wednesday, thursday);
    const dateReply = await tick(page, 200);
    expect(revision(dateReply)).not.toBe(revision(dependencyReply));
    expect((await json<WorkspaceSnapshot>(dateReply)).issues.find(value => value.id === successor.id)).toEqual(moved);
    await expect(dateField(page, successor, '시작일')).toHaveValue(wednesday);
    await expect(dateField(page, successor, '종료일')).toHaveValue(thursday);
    await expect(row(page, successor).getByRole('button', { name: `${successor.key} 일정 이동`, exact: true })).toHaveAttribute('title', new RegExp(`${wednesday} ~ ${thursday}`));
    await expect(connector).not.toHaveAttribute('d', oldPath!);
    await assertView();
  } finally {
    try { await f.cleanup(); }
    finally {
      if (changedCalendar) await json<WorkCalendar>(await request.patch(calendarPath, {
        headers: f.headers, data: { ...calendar, expectedVersion: changedCalendar.version },
      }));
    }
  }
});

test('360px 프로젝트 간트는 진행 중인 새로고침으로 날짜 초안을 잃거나 저장하지 않는다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  const capture = Promise.withResolvers<WorkspaceSnapshot>();
  const release = Promise.withResolvers<void>();
  const polls: string[] = [];
  const writes: string[] = [];
  page.on('request', sent => {
    const url = new URL(sent.url());
    if (pollUrl(url)) polls.push(url.href);
    if (sent.method() !== 'GET' && /^(?:\/api\/schedule\/|\/api\/issues\/)/u.test(url.pathname)) writes.push(url.pathname);
  });
  try {
    const issue = await f.issue(f.first.id, '날짜 입력', friday, monday);
    const hash = `#/${f.first.id}/gantt`;
    await page.setViewportSize({ width: 360, height: 820 });
    const unchanged = waitingForPoll(page, 204);
    await openChart(page, hash, f.prefix, f.actor.id);
    await page.clock.runFor(15_100);
    await unchanged;

    const updated = await f.move(issue, friday, tuesday);
    await page.route(fullUrl, async intercepted => {
      try {
        const response = await intercepted.fetch();
        capture.resolve(await json<WorkspaceSnapshot>(response));
        await release.promise;
        await intercepted.fulfill({ response }).catch(() => undefined);
      } catch (cause) { capture.reject(cause); }
    }, { times: 1 });
    await refreshButton(page).click();
    expect((await capture.promise).issues.find(value => value.id === issue.id)).toEqual(updated);
    const aborted = page.waitForEvent('requestfailed', sent => fullUrl(new URL(sent.url())));
    const draft = dateField(page, issue, '시작일');
    await draft.fill('2026-11-19');
    release.resolve();
    expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
    await expect(refreshButton(page)).toBeDisabled();
    const draftPollCount = polls.length;
    await page.clock.runFor(31_000);
    expect(polls).toHaveLength(draftPollCount);
    await expect(draft).toHaveValue('2026-11-19');
    await expect(draft).toBeFocused();
    await expect(dateField(page, issue, '종료일')).toHaveValue(monday);
    expect(writes).toEqual([]);
    expect(await f.read(issue)).toEqual(updated);

    // The pointer still reaches an aria-disabled button. It must never blur into a save.
    await refreshButton(page).click({ force: true });
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue('2026-11-19');
    expect(writes).toEqual([]);
    await draft.press('Escape');
    await expect(draft).toHaveValue(friday);
    await page.clock.runFor(15_100);
    expect(polls).toHaveLength(draftPollCount);
    const resumed = waitingForPoll(page, 200);
    await chart(page).focus();
    await resumed;
    await expect(draft).toHaveValue(friday);
    await expect(dateField(page, issue, '종료일')).toHaveValue(tuesday);
    await expect(page).toHaveURL(url => url.hash === hash);
    expect(writes).toEqual([]);

    const latest = await f.move(updated, monday, thursday);
    const manual = page.waitForResponse(response => fullUrl(new URL(response.url())) && response.status() === 200);
    await refreshButton(page).click();
    expect((await json<WorkspaceSnapshot>(await manual)).issues.find(value => value.id === issue.id)).toEqual(latest);
    await expect(page.getByRole('status').filter({ hasText: '간트를 새로고침했습니다.' })).toBeVisible();
    await expect(draft).toHaveValue(monday);
    await expect(dateField(page, issue, '종료일')).toHaveValue(thursday);
    await expect(search(page)).toHaveValue(f.prefix);
    await expect(page.getByLabel('간트 표시 시작일', { exact: true })).toHaveValue(windowStart);
    await expect(page).toHaveURL(url => url.hash === hash);
    expect(writes).toEqual([]);
  } finally {
    release.resolve();
    await f.cleanup();
  }
});

test('간트 막대 끌기와 일정 미리보기가 끝날 때까지 원격 변경의 반영을 멈춘다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const f = await fixture(request);
  const hash = `#/${f.first.id}/gantt`;
  const polls: string[] = [];
  page.on('request', sent => { if (pollUrl(new URL(sent.url()))) polls.push(sent.url()); });
  try {
    const local = await f.issue(f.first.id, '끌어 볼 업무', friday, monday);
    const remote = await f.issue(f.first.id, '다른 작업자 업무', monday, tuesday);
    const unchanged = waitingForPoll(page, 204);
    await openChart(page, hash, f.prefix, f.actor.id);
    await page.clock.runFor(15_100);
    await unchanged;
    const bar = row(page, local).getByRole('button', { name: `${local.key} 일정 이동`, exact: true });
    await bar.scrollIntoViewIfNeeded();
    const bounds = await bar.boundingBox();
    expect(bounds).not.toBeNull();
    const x = bounds!.x + bounds!.width / 2, y = bounds!.y + bounds!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(refreshButton(page)).toBeDisabled();
    await page.mouse.move(x + 32, y);
    const paused = polls.length;
    const saved = await f.move(remote, tuesday, wednesday);
    await page.clock.runFor(31_000);
    expect(polls).toHaveLength(paused);
    await expect(dateField(page, remote, '시작일')).toHaveValue(monday);

    await page.mouse.up();
    const preview = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.locator('.gantt-new-dates')).toContainText('2026-11-21');
    await page.clock.runFor(31_000);
    expect(polls).toHaveLength(paused);
    expect(await f.read(local)).toEqual(local);

    const resumed = waitingForPoll(page, 200);
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await resumed;
    await expect(preview).toHaveCount(0);
    await expect(dateField(page, remote, '시작일')).toHaveValue(tuesday);
    await expect(dateField(page, remote, '종료일')).toHaveValue(wednesday);
    await expect(dateField(page, local, '시작일')).toHaveValue(friday);
    await expect(bar).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === hash);
    expect(await f.read(local)).toEqual(local);
    expect(await f.read(remote)).toEqual(saved);
  } finally { await f.cleanup(); }
});

test('기본 간트 범위가 앞당겨져도 보고 있던 날짜는 화면의 같은 위치에 남는다', async ({ page, request }) => {
  const f = await fixture(request);
  const hash = `#/${f.first.id}/gantt`;
  const shift = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const remote = await f.issue(f.first.id, '기본 범위 앞당기기', today);
    await page.clock.install();
    const unchanged = waitingForPoll(page, 204);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${hash}`);
    await search(page).fill(f.prefix);
    await page.clock.runFor(15_100);
    await unchanged;
    const period = page.getByLabel('간트 표시 시작일', { exact: true });
    const oldStart = await period.inputValue();
    const visibleDate = shift(oldStart, 16);
    const visibleTick = chart(page).locator(`.gantt-days [data-date="${visibleDate}"]`);
    await chart(page).scrollIntoViewIfNeeded();
    const oldScroll = await chart(page).evaluate(element => { element.scrollLeft = 260; return element.scrollLeft; });
    expect(oldScroll).toBeGreaterThan(0);
    await expect(visibleTick).toBeInViewport({ ratio: 0.95 });
    const oldX = (await visibleTick.boundingBox())!.x;

    const earlier = shift(oldStart, -12);
    await f.move(remote, earlier, earlier);
    await tick(page, 200);
    await expect(period).toHaveValue(shift(earlier, -2));
    await expect(dateField(page, remote, '시작일')).toHaveValue(earlier);
    await expect(visibleTick).toBeInViewport({ ratio: 0.95 });
    await expect.poll(async () => (await visibleTick.boundingBox())!.x).toBeCloseTo(oldX, 0);
    expect(await chart(page).evaluate(element => element.scrollLeft)).toBeGreaterThan(oldScroll);
    await expect(page).toHaveURL(url => url.hash === hash);
    await expect(search(page)).toHaveValue(f.prefix);
  } finally { await f.cleanup(); }
});
