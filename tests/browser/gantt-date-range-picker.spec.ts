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
