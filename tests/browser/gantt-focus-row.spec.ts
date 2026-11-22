import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function createIssue(request: APIRequestContext, projectId: string, dates: Record<string, string>) {
  const response = await request.post('/api/issues', { data: { projectId, title: `간트 위치 확인 ${randomUUID().slice(0, 8)}`, ...dates } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as Issue;
}

async function cleanIssue(request: APIRequestContext, issue: Issue) {
  const deleted = await request.delete(`/api/issues/${issue.id}`);
  if (deleted.ok()) {
    const { trashEntryId } = await deleted.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

const detail = (issue: Issue) => `/#/${issue.projectId}/issues?issue=${issue.id}`;
const focused = (issue: Issue) => `/#/${issue.projectId}/gantt?focusIssue=${issue.id}`;

async function expectVisibleFocus(field: Locator) {
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport({ ratio: 0.9 });
  expect(await field.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}

test('360px 티켓 상세에서 멀리 떨어진 간트 날짜로 이동하고 같은 주소를 다시 연다', async ({ page, request }) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const startDate = '2042-08-08', endDate = '2042-08-11';
  const issue = await createIssue(request, project.id, { startDate, endDate });
  try {
    await page.goto(detail(issue));
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    await panel.getByRole('button', { name: '간트에서 일정 보기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === focused(issue).slice(1));
    await expect(panel).toHaveCount(0);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = chart.locator(`[data-issue-id="${issue.id}"]`);
    const bar = row.getByRole('button', { name: `${issue.key} 일정 이동`, exact: true });
    const date = chart.locator(`[data-date="${startDate}"]`);
    await expect(row).toHaveAttribute('data-focused-issue', 'true');
    await expect(row).toBeInViewport();
    await expectVisibleFocus(bar);
    await expect(bar).toHaveAttribute('title', new RegExp(`${startDate} ~ ${endDate}`));
    await expect(date).toBeInViewport({ ratio: 0.5 });

    await page.reload();
    await expect(page).toHaveURL(url => url.hash === focused(issue).slice(1));
    await expectVisibleFocus(bar);
    await expect(date).toBeInViewport({ ratio: 0.5 });
  } finally {
    await cleanIssue(request, issue);
  }
});

test('360px 선택 업무에 날짜가 없으면 첫 빈 칸에 포커스하고 같은 티켓에서 저장·되돌리기 한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const endDate = '2038-12-09', savedStart = '2038-12-07';
  const partial = await createIssue(request, project.id, { endDate });
  const empty = await createIssue(request, project.id, {});
  const withStart = await createIssue(request, project.id, { startDate: savedStart });
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  const start = (issue: Issue) => chart.getByLabel(`${issue.key} 시작일`, { exact: true });
  const end = (issue: Issue) => chart.getByLabel(`${issue.key} 종료일`, { exact: true });
  try {
    await page.goto(detail(partial));
    await page.getByRole('dialog', { name: partial.title, exact: true }).getByRole('button', { name: '간트에서 일정 보기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === focused(partial).slice(1));
    await expectVisibleFocus(start(partial));
    await expect(start(partial)).toHaveValue('');
    await expect(end(partial)).toHaveValue(endDate);
    const applying = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/schedule/manual-apply' && reply.request().method() === 'POST');
    await start(partial).fill(savedStart);
    await start(partial).press('Enter');
    const applied = await applying;
    expect(applied.ok(), await applied.text()).toBeTruthy();
    const stored = async () => (await workspace(request)).issues.find(value => value.id === partial.id);
    await expect.poll(stored).toMatchObject({ startDate: savedStart, endDate });
    const undo = page.getByRole('button', { name: '되돌리기', exact: true });
    await expect(undo).toBeEnabled();
    await expect(start(partial)).not.toBeFocused();
    await undo.click();
    await expect.poll(stored).toMatchObject({ startDate: null, endDate });
    await expect(start(partial)).toHaveValue('');
    await expect(start(partial)).not.toBeFocused();
    await expect(page).toHaveURL(url => url.hash === focused(partial).slice(1));

    await page.goto(focused(empty));
    await expectVisibleFocus(start(empty));
    await expect(start(empty)).toHaveValue('');
    await expect(end(empty)).toHaveValue('');
    await page.goto(focused(withStart));
    await expectVisibleFocus(end(withStart));
    await expect(start(withStart)).toHaveValue(savedStart);
    await expect(end(withStart)).toHaveValue('');
  } finally {
    for (const issue of [partial, empty, withStart]) await cleanIssue(request, issue);
  }
});
