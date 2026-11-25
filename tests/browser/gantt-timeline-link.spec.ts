import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type { Issue, PlanningItem, SavedView, WorkspaceSnapshot } from '../../shared/types';

const start = '2027-04-01';
const scheduledStart = '2027-04-08';
const scheduledEnd = '2027-04-10';
const chart = (page: Page) => page.getByRole('region', { name: '간트 차트', exact: true });
const rows = (page: Page) => chart(page).locator('.gantt-row[data-issue-id]');
const row = (page: Page, issue: Issue) => rows(page).filter({ has: page.getByText(issue.title, { exact: true }) });
const dateField = (page: Page) => page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
const startField = (page: Page) => page.getByLabel('간트 표시 시작일', { exact: true });
const hideDone = (page: Page) => page.getByRole('checkbox', { name: '완료 업무 숨기기', exact: true });
const copy = (page: Page) => page.getByRole('button', { name: '간트 위치 링크 복사', exact: true });
const pastedUrl = async (page: Page) => new URL(await page.evaluate(() => navigator.clipboard.readText()));
const urlParams = (hash: string) => new URLSearchParams(hash.split('?')[1]);

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('a project Gantt link restores the scrolled date, zoom, current plan and search after sharing', async ({ page, browser, request }) => {
  const { projects: [project] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `위치 공유 ${randomUUID().slice(0, 8)}`;
  const projectId = project.id;
  const plan = await json<PlanningItem>(await request.post('/api/planning-items', {
    data: { projectId, kind: 'cycle', status: 'planned', name: prefix, startDate: start, endDate: '2027-04-30' },
  }), 201);
  const view = await json<SavedView>(await request.post('/api/views', {
    data: { projectId, name: prefix, layout: 'list', filters: { query: prefix, status: 'all', assigneeId: 'all', type: 'all' } },
  }), 201);
  const fixtures: Issue[] = [];
  async function issue(title: string, cycleId: string | null, status: string) {
    const created = await json<Issue>(await request.post('/api/issues', {
      data: { projectId, cycleId, status, title: `${prefix} ${title}`, startDate: scheduledStart, endDate: scheduledEnd },
    }), 201);
    fixtures.push(created);
    return created;
  }
  const peer = await browser.newContext({ viewport: { width: 360, height: 820 } });
  try {
    const kept = await issue('인계할 업무', plan.id, 'todo');
    await issue('인계 완료한 업무', plan.id, 'done');
    await issue('기존 검토 업무', plan.id, 'todo');
    await issue('인계 계획 범위 밖', null, 'todo');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/#/${projectId}/gantt/${plan.id}?savedView=${view.id}`);
    await expect(rows(page)).toHaveCount(4);
    await startField(page).fill(start);
    await page.locator('.gantt-zoom').getByRole('button', { name: '주', exact: true }).click();
    await dateField(page).fill('인계');
    await hideDone(page).check();
    const linked = (p: Page) => p.getByRole('checkbox', { name: '연결된 업무만', exact: true });
    await linked(page).check();
    await expect(rows(page)).toHaveCount(1);
    const draftEnd = row(page, kept).getByLabel(`${kept.key} 종료일`, { exact: true });
    await draftEnd.fill('2027-04-12');
    await chart(page).evaluate(element => { element.scrollLeft = 90; });
    const originalHash = new URL(page.url()).hash;
    await copy(page).click();
    await expect(page.getByText('2027-04-07 간트 위치 링크를 복사했습니다.', { exact: true })).toBeVisible();
    const url = await pastedUrl(page);
    const params = urlParams(url.hash);
    expect(url.hash.split('?')[0]).toBe(`#/${projectId}/gantt/${plan.id}`);
    expect(params.get('savedView')).toBe(view.id);
    expect(params.get('ganttDate')).toBe('2027-04-07');
    expect(params.get('ganttScale')).toBe('week');
    expect(params.get('ganttSearch')).toBe('인계');
    expect(params.get('ganttHideDone')).toBe('1');
    expect(params.get('ganttLinked')).toBe('1');
    expect(params.has('issue')).toBe(false);
    expect(new URL(page.url()).hash).toBe(originalHash);
    await expect(draftEnd).toHaveValue('2027-04-12');
    const saved = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(saved.issues.find(value => value.id === kept.id)).toMatchObject({ endDate: scheduledEnd, version: kept.version });

    const reopened = await peer.newPage();
    await reopened.goto(url.href);
    await expect(startField(reopened)).toHaveValue('2027-04-07');
    await expect(reopened.locator('.gantt-zoom .active')).toHaveText('주');
    await expect(dateField(reopened)).toHaveValue('인계');
    await expect(hideDone(reopened)).toBeChecked();
    await expect(linked(reopened)).toBeChecked();
    await expect(rows(reopened)).toHaveCount(1);
    await expect(row(reopened, kept).getByLabel(`${kept.key} 종료일`, { exact: true })).toHaveValue(scheduledEnd);
    await expect.poll(() => chart(reopened).evaluate(element => element.scrollLeft)).toBeGreaterThan(400);
    await row(reopened, kept).locator('.gantt-issue-name').click();
    const details = reopened.getByRole('dialog', { name: kept.title, exact: true });
    await expect(details).toBeVisible();
    expect(urlParams(new URL(reopened.url()).hash).get('ganttDate')).toBe('2027-04-07');
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect.poll(() => new URL(reopened.url()).hash).toBe(url.hash);
    await reopened.reload();
    await expect(startField(reopened)).toHaveValue('2027-04-07');
    await expect(rows(reopened)).toHaveCount(1);
  } finally {
    await peer.close();
    for (const fixture of fixtures) await request.delete(`/api/issues/${fixture.id}?expectedVersion=${fixture.version}`);
    await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${plan.version}`);
  }
});

test('a team Gantt link keeps its project and triage conditions and ignores an invalid date', async ({ page, request }) => {
  const { projects: [first, second], users: [assignee] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `팀 일정 위치 ${randomUUID().slice(0, 8)}`;
  const open = await json<Issue>(await request.post('/api/issues', {
    data: { projectId: second.id, title: prefix, assigneeId: assignee.id },
  }), 201);
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const query = new URLSearchParams({ scope: 'team', ganttProject: second.id, ganttAssignee: assignee.id, ganttUnscheduled: '1', ganttQ: prefix });
    await page.goto(`/#/${first.id}/gantt?${query}`);
    await expect(rows(page)).toHaveCount(1);
    await startField(page).fill('2027-06-01');
    await page.locator('.gantt-zoom').getByRole('button', { name: '월', exact: true }).click();
    await hideDone(page).check();
    await copy(page).click();
    await expect(page.getByText('2027-06-01 간트 위치 링크를 복사했습니다.', { exact: true })).toBeVisible();
    const url = await pastedUrl(page);
    const params = urlParams(url.hash);
    for (const [key, value] of query) expect(params.get(key)).toBe(value);
    expect(params.get('ganttScale')).toBe('month');
    expect(params.has('ganttPlans')).toBe(false);
    await page.goto(url.href);
    await expect(startField(page)).toHaveValue('2027-06-01');
    await expect(page.locator('.gantt-zoom .active')).toHaveText('월');
    await expect(hideDone(page)).toBeChecked();
    await expect(dateField(page)).toHaveValue(prefix);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, open)).toBeVisible();
    params.set('ganttDate', '2027-02-31');
    url.hash = `#/${first.id}/gantt?${params}`;
    await page.goto(url.href);
    await expect(page.locator('.gantt-zoom .active')).toHaveText('일');
    await expect(dateField(page)).toHaveValue(prefix);
    await expect(rows(page)).toHaveCount(1);
    expect(urlParams(new URL(page.url()).hash).has('ganttDate')).toBe(false);
  } finally {
    await request.delete(`/api/issues/${open.id}?expectedVersion=${open.version}`);
  }
});
