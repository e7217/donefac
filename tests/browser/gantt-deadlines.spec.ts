import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, Project, SchedulePasteApplyResult, ScheduleRowEditInput, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/row-edit/preview';
const applyPath = '/api/schedule/row-edit/apply';
const undoPath = '/api/schedule/undo';
const scheduleWritePaths = new Set(['/api/schedule/manual-apply', '/api/schedule/apply', applyPath, undoPath]);

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

function offsetDate(base: string, offset: number) {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function fixture(request: APIRequestContext) {
  const { projects: [project, otherProject], users: [actor] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `간트 마감일 ${randomUUID().slice(0, 8)}`;
  const today = new Date().toISOString().slice(0, 10);
  const issues: Issue[] = [];
  return {
    project, otherProject, actor, prefix, today,
    date: (offset: number) => offsetDate(today, offset),
    async issue(name: string, dates: Partial<Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>>, owner: Project = project) {
      const issue = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: owner.id, title: `${prefix} ${name}`, ...dates },
      }), 201);
      issues.push(issue);
      return issue;
    },
    async stored(issue: Issue) {
      return (await workspace(request)).issues.find(value => value.id === issue.id);
    },
    async close() {
      for (const issue of issues.reverse()) {
        const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

function waitPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

function trackedScheduleWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && scheduleWritePaths.has(path)) writes.push(path);
  });
  return writes;
}

async function openGantt(page: Page, f: Awaited<ReturnType<typeof fixture>>, scope?: 'team') {
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${f.project.id}/gantt${scope ? '?scope=team' : ''}`);
  const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  await expect(search).toBeVisible({ timeout: 35_000 });
  await search.fill(f.prefix);
  const windowStart = page.getByLabel('간트 표시 시작일', { exact: true });
  await windowStart.fill(f.today);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  const row = (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`);
  const panel = page.getByRole('region', { name: '목표 마감일 검토', exact: true });
  const list = panel.getByRole('list', { name: '목표 마감일이 있는 업무', exact: true });
  return {
    chart, row, panel, list, search, windowStart,
    panelRow: (issue: Issue) => list.getByRole('listitem').filter({ hasText: issue.title }),
    marker: (issue: Issue, dueDate = issue.dueDate) => row(issue).getByRole('img', { name: `${issue.key} 목표 마감일 ${dueDate}`, exact: true }),
    review: page.getByRole('button', { name: '목표 마감일 검토', exact: true }),
  };
}

test('360px 간트에서 목표 마감과 계획을 구분하고 초안을 보호하며 마감일만 수정하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const writes = trackedScheduleWrites(page);
  try {
    const late = await f.issue('계획 종료일 초과', { startDate: f.date(2), endDate: f.date(6), dueDate: f.date(4) });
    const equal = await f.issue('같은 날 종료', { startDate: f.date(1), endDate: f.date(5), dueDate: f.date(5) });
    const dueOnly = await f.issue('목표 마감일만 입력', { dueDate: f.date(7) });
    const noDue = await f.issue('계획만 입력', { startDate: f.date(1), endDate: f.date(8) });
    const g = await openGantt(page, f);
    await expect(g.marker(late)).toHaveAttribute('data-gantt-deadline', 'late');
    await expect(g.marker(late)).toHaveAccessibleDescription('계획 종료일 초과');
    await expect(g.marker(equal)).toHaveAttribute('data-gantt-deadline', 'within');
    await expect(g.marker(dueOnly)).toHaveAttribute('data-gantt-deadline', 'missing');
    await expect(g.row(dueOnly).getByRole('button', { name: `${dueOnly.key} 날짜 입력`, exact: true })).toBeVisible();
    await expect(g.row(noDue).getByRole('img', { name: new RegExp(`${noDue.key} 목표 마감일`, 'u') })).toHaveCount(0);

    await g.review.click();
    await expect(g.panel).toBeVisible();
    await expect(g.list.getByRole('listitem')).toHaveCount(3);
    await expect(g.panelRow(noDue)).toHaveCount(0);
    const filters = g.panel.getByRole('group', { name: '목표 마감일 상태', exact: true });
    const missing = filters.getByRole('button', { name: /^계획 종료일 미정\s*1건$/u });
    const past = filters.getByRole('button', { name: /^계획 종료일 초과\s*1건$/u });
    await missing.click();
    await expect(missing).toHaveAttribute('aria-pressed', 'true');
    await expect(g.panelRow(dueOnly)).toBeVisible();
    await expect(g.panelRow(late)).toHaveCount(0);
    await past.click();
    await expect(past).toHaveAttribute('aria-pressed', 'true');
    await expect(g.panelRow(late)).toBeVisible();
    await expect(g.panelRow(late)).toContainText(f.date(4));
    await expect(g.panelRow(late)).toContainText(f.date(6));
    await expect(g.panelRow(late)).toContainText('2일 초과');
    await expect(g.panelRow(equal)).toHaveCount(0);
    await expect(g.row(equal)).toBeVisible();

    const edit = g.panelRow(late).getByRole('button', { name: `${late.key} 목표 마감일 수정`, exact: true });
    const inlineEnd = g.row(late).getByLabel(`${late.key} 종료일`, { exact: true });
    await inlineEnd.fill(f.date(8));
    const dismissal = page.waitForEvent('dialog', { timeout: 5_000 }).then(async confirmation => {
      const message = confirmation.message();
      await confirmation.dismiss();
      expect(message).toContain('저장하지 않은 간트 입력');
    });
    await Promise.all([dismissal, edit.click()]);
    const modal = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    await expect(modal).toHaveCount(0);
    await expect(inlineEnd).toHaveValue(f.date(8));
    expect(await f.stored(late)).toMatchObject({ version: late.version, endDate: late.endDate, dueDate: late.dueDate });
    expect(writes).toEqual([]);
    await inlineEnd.press('Escape');
    await expect(inlineEnd).toHaveValue(f.date(6));

    await edit.click();
    const due = modal.getByLabel('목표 마감일', { exact: true });
    await expect(due).toBeFocused();
    await expect(due).toBeInViewport({ ratio: 0.95 });
    await expect(due).toHaveValue(f.date(4));
    const revised = f.date(9);
    await due.fill(revised);
    const waitingPreview = waitPost(page, previewPath);
    await modal.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const previewResponse = await waitingPreview;
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    const input = previewResponse.request().postDataJSON() as ScheduleRowEditInput;
    expect(input).toMatchObject({ issue: { id: late.id, expectedVersion: late.version }, changes: { dueDate: revised } });
    expect(input.changes).toEqual({ dueDate: revised });
    await expect(modal.getByRole('region', { name: '일정과 연결 미리보기', exact: true })).toContainText(revised);
    const waitingApply = waitPost(page, applyPath);
    await modal.getByRole('button', { name: '일정과 연결 적용', exact: true }).click();
    expect(await json<SchedulePasteApplyResult>(await waitingApply)).toMatchObject({
      updated: [{ id: late.id, startDate: late.startDate, endDate: late.endDate, dueDate: revised }],
    });
    await expect(modal).toHaveCount(0);
    await expect(g.marker(late, revised)).toHaveAttribute('data-gantt-deadline', 'within');
    await expect(g.panelRow(late)).toHaveCount(0);
    await expect(g.search).toHaveValue(f.prefix);

    const waitingUndo = waitPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect((await waitingUndo).ok()).toBeTruthy();
    await expect(g.marker(late)).toHaveAttribute('data-gantt-deadline', 'late');
    await expect(g.panelRow(late)).toBeVisible();
    expect(await f.stored(late)).toMatchObject({ startDate: late.startDate, endDate: late.endDate, dueDate: late.dueDate });

    const directEdit = g.row(dueOnly).getByRole('button', { name: `${dueOnly.key} 목표 마감일 수정`, exact: true });
    await directEdit.press('Enter');
    await expect(due).toBeFocused();
    await expect(due).toHaveValue(f.date(7));
    await modal.getByRole('button', { name: '일정과 연결 편집 닫기', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(directEdit).toBeFocused();
    expect(writes).toEqual([applyPath, undoPath]);
  } finally {
    await f.close();
  }
});

test('360px 전체 프로젝트 간트에서 필터를 유지하고 범위 밖 목표 마감일로 이동한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  const writes = trackedScheduleWrites(page);
  try {
    const local = await f.issue('첫 프로젝트 마감', { dueDate: f.date(6) });
    const distant = await f.issue('다른 프로젝트의 먼 목표 마감', { dueDate: f.date(250) }, f.otherProject);
    const g = await openGantt(page, f, 'team');
    await expect(g.row(local)).toBeVisible();
    await expect(g.row(distant)).toBeVisible();
    await expect(g.marker(distant)).toHaveCount(0);
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await projectFilter.selectOption(f.otherProject.id);
    await expect(g.row(local)).toHaveCount(0);

    await g.review.click();
    await expect(g.panelRow(local)).toHaveCount(0);
    const jump = g.panelRow(distant).getByRole('button', { name: `${distant.key} 목표 마감일로 이동`, exact: true });
    const startDraft = g.row(distant).getByLabel(`${distant.key} 시작일`, { exact: true });
    await startDraft.fill(f.date(249));
    await jump.click();
    await expect(g.windowStart).toHaveValue(f.date(243));
    await expect(g.marker(distant)).toHaveAttribute('data-gantt-deadline', 'missing');
    await expect(g.marker(distant)).toBeInViewport();
    await expect(g.marker(distant)).toBeFocused();
    await expect(startDraft).toHaveValue(f.date(249));
    await expect(g.row(distant).getByRole('button', { name: `${distant.key} 날짜 입력`, exact: true })).toBeVisible();
    await expect(projectFilter).toHaveValue(f.otherProject.id);
    await expect(g.search).toHaveValue(f.prefix);
    expect(await f.stored(distant)).toMatchObject({ version: distant.version, startDate: null, endDate: null, dueDate: distant.dueDate });
    expect(writes).toEqual([]);
    await startDraft.press('Escape');
  } finally {
    await f.close();
  }
});
