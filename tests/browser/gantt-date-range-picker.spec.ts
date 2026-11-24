import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Issue, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

test.use({ hasTouch: true });

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function datesNearToday() {
  const now = new Date();
  return (offset: number) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
}

async function createIssue(request: APIRequestContext, issues: Issue[], projectId: string, title: string, dates: Partial<Pick<Issue, 'startDate' | 'endDate'>> = {}) {
  const response = await request.post('/api/issues', { data: { projectId, title, ...dates } });
  expect(response.status(), await response.text()).toBe(201);
  const issue = await response.json() as Issue;
  issues.push(issue);
  return issue;
}

async function removeIssues(request: APIRequestContext, issues: Issue[]) {
  for (const issue of issues) {
    const removed = await request.delete(`/api/issues/${issue.id}`);
    if (!removed.ok()) continue;
    const { trashEntryId } = await removed.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

async function openChart(page: Page, projectId: string, search: string, rangeStart: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${projectId}/gantt`);
  const searchField = page.getByLabel('간트 업무 검색', { exact: true });
  await expect(searchField).toBeVisible({ timeout: 30_000 });
  await searchField.fill(search);
  await page.getByLabel('간트 표시 시작일', { exact: true }).fill(rangeStart);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  const row = (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`);
  return {
    chart,
    picker: (issue: Issue) => row(issue).getByRole('button', { name: `${issue.key} 차트에서 날짜 선택`, exact: true }),
    day: (issue: Issue, date: string) => row(issue).getByRole('button', { name: `${issue.key} ${date} 선택`, exact: true }),
    prompt: page.locator('[aria-label="차트 날짜 선택"]'),
    preview: page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true }),
    undo: page.getByRole('button', { name: '되돌리기', exact: true }),
  };
}

test('360px 간트에서 두 날짜를 역순으로 골라 검토한 뒤 저장하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [project] } = await workspace(request);
  const prefix = `차트 일정 선택 ${randomUUID()}`;
  const date = datesNearToday();
  const issues: Issue[] = [];
  try {
    const issue = await createIssue(request, issues, project.id, `${prefix} 일정 미정`);
    const predecessor = await createIssue(request, issues, project.id, '차트 일정 선택의 숨겨진 선행 업무', { startDate: date(4), endDate: date(6) });
    const link = await request.post('/api/dependencies', {
      data: { predecessorId: predecessor.id, successorId: issue.id, type: 'FS', lagDays: 0 },
    });
    expect(link.status(), await link.text()).toBe(201);
    const stored = async () => (await workspace(request)).issues.find(value => value.id === issue.id);
    const { chart, picker, day, prompt, preview, undo } = await openChart(page, project.id, prefix, date(-2));
    await expect(chart.locator(`[data-issue-id="${predecessor.id}"]`)).toHaveCount(0);
    await picker(issue).tap();
    await expect(prompt).toBeVisible();
    await day(issue, date(2)).tap();
    await expect(preview).toHaveCount(0);
    expect(await stored()).toMatchObject({ startDate: null, endDate: null, version: issue.version });
    const search = page.getByLabel('간트 업무 검색', { exact: true });
    page.once('dialog', async dialog => { await dialog.dismiss(); });
    await search.fill('첫 날짜를 선택한 업무를 숨기는 필터');
    await expect(search).toHaveValue(prefix);
    await expect(prompt.getByRole('status')).toContainText(date(2));
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await expect(picker(issue)).toBeFocused();

    await picker(issue).click();
    await day(issue, date(2)).click();
    await day(issue, date(0)).click();
    await expect(preview).toBeVisible();
    await expect(preview.locator('.gantt-new-dates')).toHaveText(new RegExp(`^${date(0)}\\s*${date(2)}$`));
    await expect(preview.getByText(`${predecessor.key} → ${issue.key}`, { exact: false })).toBeVisible();
    expect(await stored()).toMatchObject({ startDate: null, endDate: null, version: issue.version });
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(stored).toMatchObject({ startDate: date(0), endDate: date(2) });
    await expect(preview).toHaveCount(0);

    await undo.click();
    await expect.poll(stored).toMatchObject({ startDate: null, endDate: null });
    await picker(issue).click();
    await day(issue, date(1)).click();
    await day(issue, date(1)).click();
    await expect(preview.locator('.gantt-new-dates')).toHaveText(new RegExp(`^${date(1)}\\s*${date(1)}$`));
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await expect(preview).toHaveCount(0);
    expect(await stored()).toMatchObject({ startDate: null, endDate: null });
  } finally {
    await removeIssues(request, issues);
  }
});

test('360px에서 간트 날짜를 키보드로 고르고 이미 저장한 날짜를 유지한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [project] } = await workspace(request);
  const prefix = `차트 빈 날짜 선택 ${randomUUID()}`;
  const date = datesNearToday();
  const issues: Issue[] = [];
  try {
    const withStart = await createIssue(request, issues, project.id, `${prefix} 시작일 있음`, { startDate: date(0) });
    const withEnd = await createIssue(request, issues, project.id, `${prefix} 종료일 있음`, { endDate: date(2) });
    const stored = async (issue: Issue) => (await workspace(request)).issues.find(value => value.id === issue.id);
    const { picker, day, prompt, preview } = await openChart(page, project.id, prefix, date(-2));

    await picker(withStart).press('Enter');
    await expect(prompt).toBeVisible();
    await expect(day(withStart, date(-1))).toBeDisabled();
    const startAnchor = day(withStart, date(0));
    const nextDay = day(withStart, date(1));
    await startAnchor.focus();
    await page.keyboard.press('ArrowRight');
    await expect(nextDay).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(preview.locator('.gantt-new-dates')).toHaveText(new RegExp(`^${date(0)}\\s*${date(1)}$`));
    expect(await stored(withStart)).toMatchObject({ startDate: date(0), endDate: null, version: withStart.version });
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(() => stored(withStart)).toMatchObject({ startDate: date(0), endDate: date(1) });

    await picker(withEnd).click();
    await expect(day(withEnd, date(3))).toBeDisabled();
    await prompt.getByRole('button', { name: '날짜 선택 취소', exact: true }).click();
    await expect(prompt).toHaveCount(0);
    expect(await stored(withEnd)).toMatchObject({ startDate: null, endDate: date(2), version: withEnd.version });

    await picker(withEnd).click();
    await day(withEnd, date(2)).click();
    await expect(preview.locator('.gantt-new-dates')).toHaveText(new RegExp(`^${date(2)}\\s*${date(2)}$`));
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(() => stored(withEnd)).toMatchObject({ startDate: date(2), endDate: date(2) });
  } finally {
    await removeIssues(request, issues);
  }
});

test('360px 간트에서 행에 입력한 날짜와 차트에서 고른 날짜를 함께 검토한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [project] } = await workspace(request);
  const prefix = `차트 날짜 초안 ${randomUUID()}`;
  const date = datesNearToday();
  const issues: Issue[] = [];
  try {
    const partial = await createIssue(request, issues, project.id, `${prefix} 시작일 입력`);
    const range = await createIssue(request, issues, project.id, `${prefix} 양쪽 입력`, { startDate: date(-1), endDate: date(1) });
    const cleared = await createIssue(request, issues, project.id, `${prefix} 저장한 날짜 비우기`, { startDate: date(2) });
    const stored = async (issue: Issue) => (await workspace(request)).issues.find(value => value.id === issue.id);
    const { chart, picker, day, prompt, preview, undo } = await openChart(page, project.id, prefix, date(-3));
    const start = (issue: Issue) => chart.getByLabel(`${issue.key} 시작일`, { exact: true });
    const end = (issue: Issue) => chart.getByLabel(`${issue.key} 종료일`, { exact: true });
    const confirmations: string[] = [];
    page.on('dialog', dialog => { confirmations.push(dialog.message()); void dialog.dismiss(); });
    const nextSchedulePost = (path: 'manual-preview' | 'manual-apply') => page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/schedule/${path}` && response.request().method() === 'POST');

    await start(partial).fill(date(0));
    await start(range).fill(date(2));
    await end(range).fill(date(4));
    await picker(range).click();
    await expect(prompt.getByText(`입력 중인 일정 ${date(2)} ~ ${date(4)}`, { exact: true })).toBeVisible();
    await day(range, date(5)).tap();
    await expect(prompt.getByRole('status')).toContainText(date(5));
    await expect(preview).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await expect(picker(range)).toBeFocused();
    await expect(start(partial)).toHaveValue(date(0));
    await expect(start(range)).toHaveValue(date(2));
    await expect(end(range)).toHaveValue(date(4));
    expect(await stored(range)).toMatchObject({ startDate: date(-1), endDate: date(1), version: range.version });

    await start(cleared).fill('');
    await picker(cleared).click();
    // Clearing the only saved endpoint makes it possible to choose both dates anew.
    await day(cleared, date(-2)).tap();
    await expect(prompt.getByRole('status')).toContainText(date(-2));
    await expect(preview).toHaveCount(0);
    const clearedPreview = nextSchedulePost('manual-preview');
    await day(cleared, date(-1)).tap();
    const clearedResponse = await clearedPreview;
    expect(clearedResponse.ok(), await clearedResponse.text()).toBeTruthy();
    expect(clearedResponse.request().postDataJSON()).toEqual({ changes: [
      { id: cleared.id, expectedVersion: cleared.version, startDate: date(-2), endDate: date(-1) },
    ] });
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await expect(start(cleared)).toHaveValue('');
    await expect(end(cleared)).toHaveValue('');
    expect(await stored(cleared)).toMatchObject({ startDate: date(2), endDate: null, version: cleared.version });

    await picker(partial).press('Enter');
    await expect(prompt.getByRole('status')).toContainText(`시작일 ${date(0)} 유지`);
    await expect(day(partial, date(-1))).toBeDisabled();
    const pending = nextSchedulePost('manual-preview');
    await day(partial, date(3)).press('Enter');
    const reviewed = await pending;
    expect(reviewed.ok(), await reviewed.text()).toBeTruthy();
    expect(reviewed.request().postDataJSON()).toEqual({ changes: [
      { id: partial.id, expectedVersion: partial.version, startDate: date(0), endDate: date(3) },
    ] });
    const proposal = await reviewed.json() as SchedulePreview;
    expect(proposal.changes).toMatchObject([{ fromStart: null, fromEnd: null, toStart: date(0), toEnd: date(3) }]);
    expect(await stored(partial)).toMatchObject({ startDate: null, endDate: null, version: partial.version });
    const applying = nextSchedulePost('manual-apply');
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    const saved = await applying;
    expect(saved.ok(), await saved.text()).toBeTruthy();
    expect(saved.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    await expect.poll(() => stored(partial)).toMatchObject({ startDate: date(0), endDate: date(3), version: partial.version + 1 });
    await expect(chart.getByRole('button', { name: `${partial.key} 날짜 저장`, exact: true })).toHaveCount(0);
    await expect(start(range)).toHaveValue(date(2));
    await expect(end(range)).toHaveValue(date(4));
    await expect(start(cleared)).toHaveValue('');
    expect(await stored(range)).toMatchObject({ startDate: date(-1), endDate: date(1), version: range.version });

    await undo.click();
    await expect.poll(() => stored(partial)).toMatchObject({ startDate: null, endDate: null, version: partial.version + 2 });
    await expect(start(partial)).toHaveValue('');
    await expect(end(partial)).toHaveValue('');
    await expect(start(range)).toHaveValue(date(2));
    await expect(end(range)).toHaveValue(date(4));
    await expect(start(cleared)).toHaveValue('');

    await picker(range).click();
    await day(range, date(-1)).tap();
    await day(range, date(1)).tap();
    await expect(page.getByText('현재 일정과 같은 날짜입니다. 행에 입력한 날짜를 유지했습니다.', { exact: true })).toBeVisible();
    await expect(preview).toHaveCount(0);
    await expect(start(range)).toHaveValue(date(2));
    await expect(end(range)).toHaveValue(date(4));

    await picker(range).click();
    await day(range, date(5)).tap();
    const rangePreview = nextSchedulePost('manual-preview');
    await day(range, date(7)).tap();
    expect((await rangePreview).request().postDataJSON()).toEqual({ changes: [
      { id: range.id, expectedVersion: range.version, startDate: date(5), endDate: date(7) },
    ] });
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(() => stored(range)).toMatchObject({ startDate: date(5), endDate: date(7), version: range.version + 1 });
    await expect(chart.getByRole('button', { name: `${range.key} 날짜 저장`, exact: true })).toHaveCount(0);
    await expect(start(cleared)).toHaveValue('');
    expect(confirmations).toEqual([]);
  } finally { await removeIssues(request, issues); }
});

test('360px에서 빈 날짜를 차트로 고른 뒤 최신 반대쪽 날짜를 유지하고 되돌리기 한다', async ({ page, request }) => {
  const { projects: [project], users: [, peer] } = await workspace(request);
  const title = `차트 빈 날짜 동시 변경 ${randomUUID()}`;
  const date = datesNearToday();
  const issues: Issue[] = [];
  const previewPath = '/api/schedule/manual-preview';
  const nextPreview = () => page.waitForResponse(response => response.url().endsWith(previewPath) && response.request().method() === 'POST');
  try {
    const issue = await createIssue(request, issues, project.id, title, { startDate: date(-1) });
    const stored = async () => (await workspace(request)).issues.find(value => value.id === issue.id);
    const { picker, day, preview, undo } = await openChart(page, project.id, title, date(-3));
    await picker(issue).tap();
    const changed = await request.patch(`/api/issues/${issue.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: issue.version, startDate: date(1) },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const latest = await changed.json() as Issue;
    const rejected = nextPreview();
    await day(issue, date(3)).tap();
    expect((await rejected).status()).toBe(409);
    await expect(preview.getByRole('button', { name: '변경 적용', exact: true })).toBeDisabled();
    expect(await stored()).toMatchObject({ startDate: date(1), endDate: null, version: latest.version });

    const renewed = nextPreview();
    await preview.getByRole('button', { name: '다시 미리보기', exact: true }).click();
    const response = await renewed;
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(response.request().postDataJSON()).toEqual({ changes: [
      { id: issue.id, expectedVersion: latest.version, startDate: date(1), endDate: date(3) },
    ] });
    const proposal = await response.json() as SchedulePreview;
    expect(proposal.changes[0]).toMatchObject({ fromStart: date(1), fromEnd: null, toStart: date(1), toEnd: date(3) });
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(stored).toMatchObject({ startDate: date(1), endDate: date(3) });
    await expect(preview).toHaveCount(0);
    await undo.click();
    await expect.poll(stored).toMatchObject({ startDate: date(1), endDate: null });
  } finally { await removeIssues(request, issues); }
});

test('360px 주·월 간트에서 저장한 양끝을 차트로 다시 선택하고 취소·적용·되돌리기 한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [project] } = await workspace(request);
  const prefix = `차트 일정 다시 선택 ${randomUUID()}`;
  const date = datesNearToday();
  const original = { startDate: date(-1), endDate: date(1) };
  const replacement = { startDate: date(3), endDate: date(6) };
  const issues: Issue[] = [];
  try {
    const issue = await createIssue(request, issues, project.id, prefix, original);
    const stored = async () => (await workspace(request)).issues.find(value => value.id === issue.id);
    const { chart, picker, day, prompt, preview, undo } = await openChart(page, project.id, prefix, date(-3));
    const opener = picker(issue);
    const scale = (label: string) => page.locator('.gantt-zoom').getByRole('button', { name: label, exact: true });
    const weekday = chart.locator(`.gantt-days > span[data-date="${original.startDate}"] > small`);
    const originalWeekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(original.startDate).getUTCDay()];
    const status = prompt.getByRole('status');
    const originalIssue = { ...original, version: issue.version };

    await scale('월').click();
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill(date(20));
    await expect(chart.locator(`.gantt-days > span[data-date="${original.startDate}"]`)).toHaveCount(0);
    await chart.scrollIntoViewIfNeeded();
    await expect(opener).toBeInViewport();
    await expect(weekday).toHaveCount(0);
    await opener.press('Enter');
    await expect(prompt).toBeVisible();
    await expect(weekday).toHaveText(originalWeekday);
    await expect(day(issue, original.startDate)).toBeFocused();
    await expect(day(issue, date(-2))).toBeEnabled();
    await day(issue, replacement.endDate).tap();
    await expect(status).toContainText(`첫 날짜 ${replacement.endDate}`);
    await expect(preview).toHaveCount(0);
    expect(await stored()).toMatchObject(originalIssue);
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(scale('월')).toHaveClass(/active/);
    await expect(weekday).toHaveCount(0);

    await opener.click();
    await day(issue, replacement.endDate).tap();
    await day(issue, replacement.startDate).tap();
    await expect(preview).toBeVisible();
    await expect(preview).toBeFocused();
    const reviewRow = preview.getByRole('row').filter({ hasText: issue.key });
    await expect(reviewRow.getByRole('cell').nth(1)).toHaveText(new RegExp(`^${original.startDate}\\s*${original.endDate}$`));
    await expect(reviewRow.locator('.gantt-new-dates')).toHaveText(new RegExp(`^${replacement.startDate}\\s*${replacement.endDate}$`));
    expect(await stored()).toMatchObject(originalIssue);
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(scale('월')).toHaveClass(/active/);
    await expect(weekday).toHaveCount(0);
    expect(await stored()).toMatchObject(originalIssue);

    await scale('주').click();
    await opener.tap();
    await expect(weekday).toHaveText(originalWeekday);
    await day(issue, replacement.startDate).tap();
    await expect(preview).toHaveCount(0);
    await day(issue, replacement.endDate).tap();
    await expect(reviewRow.locator('.gantt-new-dates')).toHaveText(new RegExp(`^${replacement.startDate}\\s*${replacement.endDate}$`));
    expect(await stored()).toMatchObject(originalIssue);
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(stored).toMatchObject({ ...replacement, version: issue.version + 1 });
    await expect(preview).toHaveCount(0);
    await expect(scale('주')).toHaveClass(/active/);
    await expect(weekday).toHaveCount(0);
    await undo.click();
    await expect.poll(stored).toMatchObject({ ...original, version: issue.version + 2 });

    const afterUndo = await stored();
    await opener.click();
    await day(issue, original.startDate).tap();
    await day(issue, original.endDate).tap();
    await expect(page.getByText('현재 일정과 같은 날짜입니다.', { exact: true })).toBeVisible();
    await expect(prompt).toHaveCount(0);
    await expect(preview).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await stored()).toEqual(afterUndo);
  } finally {
    await removeIssues(request, issues);
  }
});

test('다른 탭에서 바꾼 일정은 덮어쓰지 않고 다시 선택할 때 최신 범위를 검토한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [project] } = await workspace(request);
  const title = `차트 일정 동시 변경 ${randomUUID()}`;
  const date = datesNearToday();
  const original = { startDate: date(-1), endDate: date(1) };
  const competing = { startDate: date(0), endDate: date(2) };
  const proposed = { startDate: date(3), endDate: date(6) };
  const issues: Issue[] = [];
  try {
    const issue = await createIssue(request, issues, project.id, title, original);
    const stored = async () => (await workspace(request)).issues.find(value => value.id === issue.id);
    const { picker, day, preview } = await openChart(page, project.id, title, date(-3));
    const openProposal = async () => {
      await picker(issue).click();
      await day(issue, proposed.startDate).click();
      await day(issue, proposed.endDate).click();
      await expect(preview).toBeVisible();
    };
    const row = preview.getByRole('row').filter({ hasText: issue.key });
    const calendarRange = (dates: typeof original) => new RegExp(`^${dates.startDate}\\s*${dates.endDate}$`);
    const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/schedule/manual-preview') && response.request().method() === 'POST');
    await openProposal();
    const reviewed = await previewResponse;
    expect(reviewed.ok(), await reviewed.text()).toBeTruthy();
    expect(reviewed.request().postDataJSON()).toEqual({ changes: [{ id: issue.id, expectedVersion: issue.version, ...proposed }] });
    const proposal = await reviewed.json() as SchedulePreview;
    expect(proposal.previewId).toBeTruthy();
    await expect(row.getByRole('cell').nth(1)).toHaveText(calendarRange(original));

    const otherTab = await page.context().newPage();
    try {
      await otherTab.goto(`/#/${project.id}/gantt`);
      await otherTab.getByLabel('간트 업무 검색', { exact: true }).fill(title);
      const start = otherTab.getByLabel(`${issue.key} 시작일`, { exact: true });
      const end = otherTab.getByLabel(`${issue.key} 종료일`, { exact: true });
      await start.fill(competing.startDate);
      await end.fill(competing.endDate);
      await end.press('Enter');
      await expect.poll(stored).toMatchObject(competing);
    } finally { await otherTab.close(); }

    const conflict = page.waitForResponse(response => response.url().endsWith('/api/schedule/manual-apply') && response.request().method() === 'POST');
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    const result = await conflict;
    expect(result.status()).toBe(409);
    expect(result.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    await expect(preview.getByRole('alert')).toBeVisible();
    await expect(row.getByRole('cell').nth(1)).toHaveText(calendarRange(original));
    await expect(row.locator('.gantt-new-dates')).toHaveText(calendarRange(proposed));
    expect(await stored()).toMatchObject(competing);
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await expect(picker(issue)).toBeFocused();
    await expect(page.getByLabel('간트 업무 검색', { exact: true })).toHaveValue(title);
    await openProposal();
    await expect(row.getByRole('cell').nth(1)).toHaveText(calendarRange(competing));
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(stored).toMatchObject(proposed);
  } finally {
    await removeIssues(request, issues);
  }
});

test('차트 날짜 검토를 새로 만들 때 직접 입력하고 고른 날짜를 함께 유지한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [project], users: [, peer] } = await workspace(request);
  const title = `차트 날짜 초안 동시 수정 ${randomUUID()}`;
  const date = datesNearToday();
  const original = { startDate: date(-2), endDate: date(2) };
  const competing = { startDate: date(1), endDate: date(3) };
  const proposed = { startDate: date(-1), endDate: date(5) };
  const issues: Issue[] = [];
  try {
    const issue = await createIssue(request, issues, project.id, title, original);
    const stored = async () => (await workspace(request)).issues.find(value => value.id === issue.id);
    const { chart, picker, day, prompt, preview, undo } = await openChart(page, project.id, title, date(-3));
    const start = chart.getByLabel(`${issue.key} 시작일`, { exact: true });
    const nextPreview = () => page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/schedule/manual-preview' && response.request().method() === 'POST');
    await start.fill(proposed.startDate);
    await picker(issue).press('Enter');
    await expect(prompt.getByRole('status')).toContainText(`시작일 ${proposed.startDate} 유지`);

    const changed = await request.patch(`/api/issues/${issue.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { ...competing, expectedVersion: issue.version },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const latest = await changed.json() as Issue;
    const stale = nextPreview();
    await day(issue, proposed.endDate).tap();
    expect((await stale).status()).toBe(409);
    await expect(preview.getByRole('alert')).toBeVisible();
    const apply = preview.getByRole('button', { name: '변경 적용', exact: true });
    await expect(apply).toBeDisabled();
    await expect(start).toHaveValue(proposed.startDate);
    expect(await stored()).toMatchObject({ ...competing, version: latest.version });

    const retry = nextPreview();
    await preview.getByRole('button', { name: '다시 미리보기', exact: true }).click();
    const reviewed = await retry;
    expect(reviewed.ok(), await reviewed.text()).toBeTruthy();
    expect(reviewed.request().postDataJSON()).toEqual({ changes: [{ id: issue.id, expectedVersion: latest.version, ...proposed }] });
    const proposal = await reviewed.json() as SchedulePreview;
    expect(proposal.changes).toMatchObject([{
      fromStart: competing.startDate, fromEnd: competing.endDate, toStart: proposed.startDate, toEnd: proposed.endDate,
    }]);
    await apply.click();
    await expect.poll(stored).toMatchObject({ ...proposed, version: latest.version + 1 });
    await expect(chart.getByRole('button', { name: `${issue.key} 날짜 저장`, exact: true })).toHaveCount(0);
    await undo.click();
    await expect.poll(stored).toMatchObject({ ...competing, version: latest.version + 2 });
    await expect(start).toHaveValue(competing.startDate);
  } finally { await removeIssues(request, issues); }
});
