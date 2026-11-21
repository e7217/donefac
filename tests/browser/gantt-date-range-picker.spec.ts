import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

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
    await openProposal();
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

    const conflict = page.waitForResponse(response => response.url().endsWith('/api/schedule/apply') && response.request().method() === 'POST');
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    const result = await conflict;
    expect(result.status()).toBe(409);
    expect(result.request().postDataJSON()).toMatchObject({ changes: [{ id: issue.id, expectedVersion: issue.version, ...proposed }] });
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
