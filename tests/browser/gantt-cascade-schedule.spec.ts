import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import type { AutomaticSchedulePreview, Issue, ScheduleChange, WorkspaceSnapshot } from '../../shared/types';

type Dates = readonly [string, string];
type ApplyResult = { undoId: string; updated: Issue[] };

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function nextWorkweek() {
  const today = new Date();
  return (offset: number) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + (1 - today.getUTCDay() + 7) % 7 + 7 + offset);
    return date.toISOString().slice(0, 10);
  };
}

async function makeCascade(request: APIRequestContext, created: Issue[]) {
  const { projects: [project] } = await workspace(request);
  const date = nextWorkweek();
  const prefix = `간트 후행 ${randomUUID()}`;
  async function issue(title: string, [startDate, endDate]: Dates): Promise<Issue> {
    const response = await request.post('/api/issues', { data: { projectId: project.id, title: `${prefix} ${title}`, startDate, endDate } });
    expect(response.status(), await response.text()).toBe(201);
    const saved = await response.json() as Issue;
    created.push(saved);
    return saved;
  }
  const anchor = await issue('기준 업무', [date(0), date(1)]);
  const successor = await issue('직접 후행 업무', [date(2), date(3)]);
  const last = await issue('두 번째 후행 업무', [date(4), date(4)]);
  const unrelated = await issue('연결 없는 업무', [date(1), date(2)]);
  for (const [from, to] of [[anchor, successor], [successor, last]]) {
    const link = await request.post('/api/dependencies', {
      data: { predecessorId: from.id, successorId: to.id, type: 'FS', lagDays: 0 },
    });
    expect(link.status(), await link.text()).toBe(201);
  }
  return { project, date, anchor, successor, last, unrelated };
}

async function removeIssues(request: APIRequestContext, created: Issue[]) {
  for (const issue of [...created].reverse()) {
    const response = await request.delete(`/api/issues/${issue.id}`);
    if (!response.ok()) continue;
    const { trashEntryId } = await response.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

function storedDates(request: APIRequestContext, issues: Issue[]) {
  return async () => {
    const stored = new Map((await workspace(request)).issues.map(issue => [issue.id, issue]));
    return issues.map(issue => {
      const value = stored.get(issue.id);
      expect(value, issue.key).toBeDefined();
      return { id: issue.id, startDate: value!.startDate, endDate: value!.endDate, version: value!.version };
    });
  };
}

function expectedDates(issues: Issue[], dates: Dates[], versionStep: number) {
  return issues.map((issue, index) => dates[index] ? {
    id: issue.id, startDate: dates[index][0], endDate: dates[index][1], version: issue.version + versionStep,
  } : { id: issue.id, startDate: issue.startDate, endDate: issue.endDate, version: issue.version });
}

function changesOf(changes: ScheduleChange[]) {
  return changes.map(({ id, fromStart, fromEnd, toStart, toEnd }) => ({ id, fromStart, fromEnd, toStart, toEnd }));
}

function expectedChanges(issues: Issue[], dates: Dates[]) {
  return issues.slice(0, dates.length).map((issue, index) => ({
    id: issue.id, fromStart: issue.startDate, fromEnd: issue.endDate, toStart: dates[index][0], toEnd: dates[index][1],
  }));
}

function responseAt(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(value => new URL(value.url()).pathname === `/api/schedule/${path}` && value.request().method() === method);
}

async function payload<T>(response: Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function openChart(page: Page, anchor: Issue, hidden: Issue[], date: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${anchor.projectId}/gantt`);
  await page.getByLabel('간트 업무 검색', { exact: true }).fill(anchor.title);
  await page.getByLabel('간트 표시 시작일', { exact: true }).fill(date);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  for (const issue of hidden) await expect(chart.locator(`[data-issue-id="${issue.id}"]`)).toHaveCount(0);
  return {
    chart,
    dateInput: chart.getByLabel(`${anchor.key} 종료일`, { exact: true }),
    inlineReview: chart.getByRole('button', { name: `${anchor.key} 후행 일정 검토`, exact: true }),
    modal: page.getByRole('dialog', { name: '후행 일정 미리보기', exact: true }),
    undo: page.getByRole('button', { name: '되돌리기', exact: true }),
  };
}

function trackScheduleRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/api/schedule/')) requests.push(path);
  });
  return requests;
}

test('360px에서 날짜 초안을 보존하며 숨겨진 두 단계의 후행 일정을 함께 적용하고 한 번에 되돌린다', async ({ page, request }) => {
  test.setTimeout(60_000);
  const created: Issue[] = [];
  try {
    const { date, anchor, successor, last, unrelated } = await makeCascade(request, created);
    const proposed: Dates[] = [[date(0), date(3)], [date(4), date(7)], [date(8), date(8)]];
    const original: Dates[] = [[date(0), date(1)], [date(2), date(3)], [date(4), date(4)]];
    const stored = storedDates(request, created);
    const { dateInput, inlineReview, modal, undo } = await openChart(page, anchor, [successor, last, unrelated], date(-1));
    const scheduleRequests = trackScheduleRequests(page);
    await dateInput.fill(date(3));
    const firstPreview = responseAt(page, 'auto-preview');
    await inlineReview.click();
    const first = await payload<AutomaticSchedulePreview>(await firstPreview);
    expect(first.blocking).toEqual([]);
    expect(changesOf(first.changes)).toEqual(expectedChanges(created, proposed));
    await expect(modal).toBeVisible();
    for (const issue of [anchor, successor, last]) await expect(modal.getByText(issue.title, { exact: true })).toBeVisible();
    expect(scheduleRequests).toEqual(['/api/schedule/auto-preview']);
    expect(await stored()).toEqual(expectedDates(created, [], 0));

    await modal.getByRole('button', { name: '돌아가기', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(dateInput).toHaveValue(date(3));
    await expect(inlineReview).toBeFocused();
    expect(await stored()).toEqual(expectedDates(created, [], 0));
    const recheck = responseAt(page, 'auto-preview');
    await inlineReview.press('Enter');
    const proposal = await payload<AutomaticSchedulePreview>(await recheck);
    expect(proposal.previewId).not.toBe(first.previewId);
    expect(changesOf(proposal.changes)).toEqual(expectedChanges(created, proposed));

    const appliedResponse = responseAt(page, 'auto-apply');
    await modal.getByRole('button', { name: '함께 적용', exact: true }).click();
    const applied = await payload<ApplyResult>(await appliedResponse);
    expect(applied.updated.map(issue => issue.id)).toEqual([anchor.id, successor.id, last.id]);
    expect(await stored()).toEqual(expectedDates(created, proposed, 1));
    await expect(modal).toHaveCount(0);
    await expect(dateInput).toHaveValue(date(3));

    const undoResponse = responseAt(page, 'undo');
    await undo.click();
    const undone = await undoResponse;
    expect(undone.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    await payload(undone);
    expect(await stored()).toEqual(expectedDates(created, original, 2));
    await expect(dateInput).toHaveValue(date(1));
    expect(scheduleRequests).toEqual(['/api/schedule/auto-preview', '/api/schedule/auto-preview', '/api/schedule/auto-apply', '/api/schedule/undo']);
  } finally { await removeIssues(request, created); }
});

test('360px 막대 조정에서 잃어버린 적용 응답을 확인하고 중복 변경 없이 한 번에 되돌린다', async ({ page, request }) => {
  test.setTimeout(60_000);
  const created: Issue[] = [];
  try {
    const { date, anchor, successor, last, unrelated } = await makeCascade(request, created);
    const proposed: Dates[] = [[date(0), date(2)], [date(3), date(4)], [date(7), date(7)]];
    const original: Dates[] = [[date(0), date(1)], [date(2), date(3)], [date(4), date(4)]];
    const stored = storedDates(request, created);
    const { chart, modal, undo } = await openChart(page, anchor, [successor, last, unrelated], date(-1));
    const scheduleRequests = trackScheduleRequests(page);
    const resize = chart.getByRole('button', { name: `${anchor.key} 종료일 조정`, exact: true });
    await resize.press('ArrowRight');
    const preview = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    await expect(preview.locator('.gantt-new-dates')).toContainText(date(2));
    const calculation = responseAt(page, 'auto-preview');
    await preview.getByRole('button', { name: '후행 일정 검토', exact: true }).click();
    const proposal = await payload<AutomaticSchedulePreview>(await calculation);
    expect(proposal.blocking).toEqual([]);
    expect(changesOf(proposal.changes)).toEqual(expectedChanges(created, proposed));
    expect(await stored()).toEqual(expectedDates(created, [], 0));

    let lostResult: ApplyResult | null = null;
    await page.route('**/api/schedule/auto-apply', async route => {
      const applied = await route.fetch();
      expect(applied.status(), await applied.text()).toBe(200);
      lostResult = await applied.json() as ApplyResult;
      await route.abort('failed');
    }, { times: 1 });
    await modal.getByRole('button', { name: '함께 적용', exact: true }).click();
    const recovery = modal.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recovery).toBeVisible();
    expect(await stored()).toEqual(expectedDates(created, proposed, 1));
    const confirmation = responseAt(page, `auto-result/${proposal.previewId}`, 'GET');
    await recovery.click();
    const recovered = await payload<ApplyResult>(await confirmation);
    expect(recovered).toEqual(lostResult);
    expect(await stored()).toEqual(expectedDates(created, proposed, 1));
    await expect(modal).toHaveCount(0);
    await expect(preview).toHaveCount(0);

    const undoResponse = responseAt(page, 'undo');
    await undo.click();
    const undone = await undoResponse;
    expect(undone.request().postDataJSON()).toEqual({ undoId: recovered.undoId });
    await payload(undone);
    expect(await stored()).toEqual(expectedDates(created, original, 2));
    expect(scheduleRequests).toEqual(['/api/schedule/auto-preview', '/api/schedule/auto-apply', '/api/schedule/undo']);
  } finally { await removeIssues(request, created); }
});

test('후행 업무가 다른 곳에서 수정되면 전체 적용을 거절하고 날짜 초안으로 돌아간다', async ({ page, request }) => {
  test.setTimeout(60_000);
  const created: Issue[] = [];
  try {
    const { date, anchor, successor, last, unrelated } = await makeCascade(request, created);
    const stored = storedDates(request, created);
    const { dateInput, inlineReview, modal } = await openChart(page, anchor, [successor, last, unrelated], date(-1));
    const scheduleRequests = trackScheduleRequests(page);
    await dateInput.fill(date(3));
    const calculation = responseAt(page, 'auto-preview');
    await inlineReview.click();
    const proposal = await payload<AutomaticSchedulePreview>(await calculation);
    expect(proposal.blocking).toEqual([]);

    const remoteChange = await request.patch(`/api/issues/${last.id}`, {
      data: { expectedVersion: last.version, title: `${last.title} 동시 수정` },
    });
    expect(remoteChange.ok(), await remoteChange.text()).toBeTruthy();
    const beforeApply = await stored();
    const application = responseAt(page, 'auto-apply');
    await modal.getByRole('button', { name: '함께 적용', exact: true }).click();
    const rejected = await application;
    expect(rejected.status(), await rejected.text()).toBe(409);
    expect(rejected.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    await expect(modal.getByRole('alert')).toBeVisible();
    await expect(modal.getByText(last.title, { exact: true })).toBeVisible();
    expect(await stored()).toEqual(beforeApply);

    await modal.getByRole('button', { name: '돌아가기', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(dateInput).toHaveValue(date(3));
    await expect(inlineReview).toBeFocused();
    expect(await stored()).toEqual(beforeApply);
    expect(scheduleRequests).toEqual(['/api/schedule/auto-preview', '/api/schedule/auto-apply']);
  } finally { await removeIssues(request, created); }
});
