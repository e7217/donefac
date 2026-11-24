import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type APIResponse, type Dialog, type Page } from '@playwright/test';
import type { Issue, Project, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function workspace(request: APIRequestContext) {
  return json<WorkspaceSnapshot>(await request.get('/api/workspace'));
}

function location(page: Page) {
  const [path, query] = new URL(page.url()).hash.split('?');
  const params = new URLSearchParams(query);
  return {
    path,
    scope: params.get('scope'),
    project: params.get('ganttProject'),
    assignee: params.get('ganttAssignee'),
    unscheduled: params.get('ganttUnscheduled'),
    issue: params.get('issue'),
  };
}

test('360px 전체 프로젝트 간트에서 담당자의 미정 일정을 찾아 마지막 날짜를 채운다', async ({ page, request }) => {
  const { projects: [first, second], users: [owner, alternate] } = await workspace(request);
  const headers = { 'X-Actor-Id': owner.id };
  const prefix = `미정 일정 ${randomUUID().slice(0, 8)}`;
  const startDate = '2026-11-23';
  const endDate = '2026-11-27';
  const dueDate = '2026-11-30';
  const created: Issue[] = [];
  const scheduleRequests: unknown[] = [];

  async function createIssue(project: Project, name: string, assigneeId: string | null,
    dates: Partial<Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>> = {}) {
    const result = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId: project.id, title: name, assigneeId, ...dates },
    }), 201);
    created.push(result);
    return result;
  }

  try {
    const firstPartial = await createIssue(first, `${prefix} 첫 프로젝트`, owner.id, { startDate });
    const firstUnassigned = await createIssue(first, `${prefix} 첫 미배정`, null);
    const anchor = await createIssue(second, `${prefix} 종료일 필요`, owner.id, { startDate, dueDate });
    const next = await createIssue(second, `${prefix} 시작일 필요`, owner.id, { endDate });
    const complete = await createIssue(second, `${prefix} 계획 완료`, owner.id, { startDate, endDate });
    const unassigned = await createIssue(second, `${prefix} 둘째 미배정`, null);
    const unassignedComplete = await createIssue(second, `${prefix} 미배정 계획 완료`, null, { startDate, endDate });
    const otherOwner = await createIssue(second, `${prefix} 다른 담당자`, alternate.id);
    const offQuery = await createIssue(second, `검색 제외 ${randomUUID()}`, owner.id);
    const stored = async (id: string) => (await workspace(request)).issues.find(issue => issue.id === id);

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), owner.id);
    await page.setViewportSize({ width: 360, height: 820 });
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if ((path === '/api/schedule/manual-apply' || path === '/api/schedule/apply') && sent.method() === 'POST') {
        scheduleRequests.push(sent.postDataJSON());
      }
    });
    const path = `#/${first.id}/gantt`;
    await page.goto(`/${path}?scope=team`);
    await expect(page.getByRole('heading', { name: '전체 프로젝트 간트', exact: true })).toBeVisible();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    const projects = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const owners = page.getByRole('combobox', { name: '담당자 필터', exact: true });
    const missing = page.getByRole('checkbox', { name: '일정 미정만', exact: true });
    const memberValue = `member:${owner.id}`;

    await search.fill(prefix);
    await owners.selectOption(memberValue);
    await missing.check();
    const memberScope = { path, scope: 'team', project: null, assignee: owner.id, unscheduled: '1', issue: null };
    await expect.poll(() => location(page)).toEqual(memberScope);
    for (const issue of [firstPartial, anchor, next]) await expect(row(issue)).toBeVisible();
    for (const issue of [firstUnassigned, complete, unassigned, unassignedComplete, otherOwner, offQuery]) {
      await expect(row(issue)).toHaveCount(0);
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click(),
    ]);
    const html = await readFile(await download.path(), 'utf8');
    expect(html).toContain(`담당자 · ${owner.name}`);
    expect(html).toContain('일정 미정만');
    for (const issue of [firstPartial, anchor, next]) expect(html).toContain(issue.title);
    for (const issue of [complete, unassigned, otherOwner]) expect(html).not.toContain(issue.title);

    await projects.selectOption(second.id);
    const secondScope = { ...memberScope, project: second.id };
    await expect.poll(() => location(page)).toEqual(secondScope);
    await expect(row(firstPartial)).toHaveCount(0);
    await expect(search).toHaveValue(prefix);
    await page.goBack();
    await expect.poll(() => location(page)).toEqual(memberScope);
    await expect(row(firstPartial)).toBeVisible();
    await page.goForward();
    await expect.poll(() => location(page)).toEqual(secondScope);
    await expect(row(firstPartial)).toHaveCount(0);

    await row(anchor).locator('.gantt-issue-name').click();
    const drawer = page.getByRole('dialog', { name: anchor.title, exact: true });
    await expect(drawer).toBeVisible();
    await expect.poll(() => location(page)).toEqual({ ...secondScope, issue: anchor.id });
    await page.reload();
    await expect(drawer).toBeVisible();
    await expect.poll(() => location(page)).toEqual({ ...secondScope, issue: anchor.id });
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => location(page)).toEqual(secondScope);
    await expect(projects).toHaveValue(second.id);
    await expect(owners).toHaveValue(memberValue);
    await expect(missing).toBeChecked();
    await search.fill(prefix);

    const anchorEnd = row(anchor).getByLabel(`${anchor.key} 종료일`, { exact: true });
    const nextStart = row(next).getByLabel(`${next.key} 시작일`, { exact: true });
    await row(anchor).getByRole('button', { name: `${anchor.key} 날짜 입력`, exact: true }).click();
    await expect(anchorEnd).toBeFocused();
    await expect(anchorEnd).toBeInViewport({ ratio: 0.95 });
    await expect(anchorEnd).toHaveValue('');
    await anchorEnd.fill(endDate);
    await owners.focus();
    const dialogs: string[] = [];
    const dismissUnexpected = (dialog: Dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); };
    const retained = row(anchor).getByText('현재 보기 조건 밖 · 날짜 입력 유지', { exact: true });
    page.on('dialog', dismissUnexpected);
    try {
      await owners.selectOption(`member:${alternate.id}`);
      await expect.poll(() => location(page)).toEqual({ ...secondScope, assignee: alternate.id });
      await expect(row(otherOwner)).toBeVisible();
      await expect(row(next)).toHaveCount(0);
      await expect(retained).toBeVisible();
      await expect(anchorEnd).toHaveValue(endDate);
      await owners.selectOption(memberValue);
    } finally { page.off('dialog', dismissUnexpected); }
    await expect.poll(() => location(page)).toEqual(secondScope);
    await expect(owners).toHaveValue(memberValue);
    await expect(retained).toHaveCount(0);
    await expect(anchorEnd).toHaveValue(endDate);
    expect(dialogs).toEqual([]);
    expect(await stored(anchor.id)).toMatchObject({ version: anchor.version, endDate: null });
    expect(scheduleRequests).toHaveLength(0);

    const review = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/manual-preview'
      && response.request().method() === 'POST');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/manual-apply'
      && response.request().method() === 'POST');
    await anchorEnd.press('Enter');
    const previewResponse = await review;
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    expect(previewResponse.request().postDataJSON()).toEqual({ changes: [{ id: anchor.id, expectedVersion: anchor.version, startDate, endDate }] });
    const preview = await previewResponse.json() as SchedulePreview;
    expect(preview.previewId).toBeTruthy();
    const response = await saved;
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(await response.json()).toMatchObject({ updated: [{ id: anchor.id, projectId: second.id, startDate, endDate, dueDate }] });
    expect(scheduleRequests).toEqual([{ previewId: preview.previewId }]);
    await expect(row(anchor)).toHaveCount(0);
    await expect(nextStart).toBeFocused();
    await expect(nextStart).toBeInViewport({ ratio: 0.95 });
    await expect(nextStart).toHaveValue('');
    expect(await stored(anchor.id)).toMatchObject({ projectId: second.id, startDate, endDate, dueDate });
    expect(await stored(next.id)).toMatchObject({ version: next.version, startDate: null, endDate });
    expect(await stored(firstPartial.id)).toMatchObject({ version: firstPartial.version, startDate, endDate: null });

    await nextStart.fill(startDate);
    await nextStart.press('Enter');
    await expect(row(next)).toHaveCount(0);
    await expect(missing).toBeFocused();
    await expect.poll(() => location(page)).toEqual(secondScope);
    expect(await stored(next.id)).toMatchObject({ projectId: second.id, startDate, endDate });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(row(next)).toBeVisible();
    await expect(nextStart).toHaveValue('');
    await expect.poll(() => location(page)).toEqual(secondScope);
    expect(await stored(next.id)).toMatchObject({ startDate: null, endDate });
    expect(await stored(anchor.id)).toMatchObject({ startDate, endDate, dueDate });

    await owners.selectOption({ label: '미배정' });
    const unassignedScope = { ...secondScope, assignee: '' };
    await expect.poll(() => location(page)).toEqual(unassignedScope);
    await expect(row(unassigned)).toBeVisible();
    for (const issue of [firstUnassigned, unassignedComplete, next, otherOwner]) await expect(row(issue)).toHaveCount(0);
    await page.goBack();
    await expect.poll(() => location(page)).toEqual(secondScope);
    await expect(owners).toHaveValue(memberValue);
    await expect(row(next)).toBeVisible();
    await page.goForward();
    await expect.poll(() => location(page)).toEqual(unassignedScope);
    await expect(owners).toHaveValue('unassigned');
    await row(unassigned).getByRole('button', { name: `${unassigned.key} 날짜 입력`, exact: true }).click();
    await expect(row(unassigned).getByLabel(`${unassigned.key} 시작일`, { exact: true })).toBeFocused();
    await missing.uncheck();
    await expect.poll(() => location(page)).toEqual({ ...unassignedScope, unscheduled: null });
    await expect(row(unassignedComplete)).toBeVisible();
    await owners.selectOption('');
    await expect.poll(() => location(page)).toEqual({ ...secondScope, assignee: null, unscheduled: null });
    await expect(row(anchor)).toBeVisible();
    await expect(row(otherOwner)).toBeVisible();
  } finally {
    for (const issue of created.reverse()) {
      const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
});
