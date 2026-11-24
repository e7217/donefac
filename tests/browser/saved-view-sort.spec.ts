import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Issue, IssueViewSortRule, ProjectIssueOrder, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const ids = (locator: Locator) => locator.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-issue-id')));
const button = (page: Page | Locator, name: string) => page.getByRole('button', { name, exact: true });

async function exportedKeys(page: Page, name: string, separator: ',' | '\t') {
  const requested = page.waitForEvent('download');
  await button(page, name).click();
  const path = await (await requested).path();
  expect(path).toBeTruthy();
  return (await readFile(path!, 'utf8')).trimEnd().split(/\r?\n/).slice(1)
    .map(line => line.split(separator)[0].replace(/^"|"$/gu, ''));
}

test('360px에서 여러 정렬 기준을 저장하고 업무 목록, 간트, 내보내기에서 같은 순서를 사용한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const { projects: [project], users: [firstAssignee, nextAssignee] } =
    await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const orderPath = `/api/projects/${project.id}/issue-order`;
  const prefix = `보기 정렬 ${randomUUID().slice(0, 8)}`;
  const created: Issue[] = [];
  let saved: SavedView | undefined;
  async function issue(title: string, priority: Issue['priority'], dueDate: string | null) {
    const result = await json<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} ${title}`, priority, dueDate, status: 'todo',
      assigneeId: firstAssignee.id, startDate: '2030-02-01', endDate: '2030-02-03',
    } }), 201);
    created.push(result);
    return result;
  }

  try {
    const late = await issue('나중 마감', 'high', '2030-02-08');
    const early = await issue('이른 마감', 'medium', '2030-02-05');
    const urgent = await issue('같은 마감의 긴급 업무', 'urgent', '2030-02-05');
    const unscheduled = await issue('마감 없음', 'low', null);
    const initial = await json<ProjectIssueOrder>(await request.get(orderPath));
    const manual = await json<{ order: ProjectIssueOrder }>(await request.patch(orderPath, { data: {
      issueId: unscheduled.id, expectedVersion: initial.version, expectedIssueVersion: unscheduled.version,
      anchorId: late.id, position: 'before',
    } }));
    const manualRows = [unscheduled.id, late.id, early.id, urgent.id];
    const sortedRows = [urgent.id, early.id, late.id, unscheduled.id];
    const sortedKeys = [urgent.key, early.key, late.key, unscheduled.key];
    const rules: IssueViewSortRule[] = [{ field: 'dueDate', direction: 'asc' }, { field: 'priority', direction: 'desc' }];

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues`);
    await page.getByRole('textbox', { name: '업무 검색', exact: true }).fill(prefix);
    const list = page.getByRole('region', { name: '업무 목록', exact: true });
    const rows = list.locator('tbody tr[data-issue-id]');
    await expect.poll(() => ids(rows)).toEqual(manualRows);
    await button(page, '업무 정렬').click();
    const sortPanel = page.getByRole('region', { name: '업무 정렬 기준', exact: true });
    await button(sortPanel, '정렬 기준 추가').click();
    await sortPanel.getByRole('combobox', { name: '정렬 기준 1', exact: true }).selectOption('dueDate');
    await button(sortPanel, '정렬 기준 추가').click();
    await sortPanel.getByRole('combobox', { name: '정렬 기준 2', exact: true }).selectOption('priority');
    await sortPanel.getByRole('combobox', { name: '정렬 방향 2', exact: true }).selectOption('desc');
    await expect.poll(() => ids(rows)).toEqual(sortedRows);
    const panelBounds = await sortPanel.boundingBox();
    expect(panelBounds).toBeTruthy();
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(361);
    await expect(button(page, '순서 편집')).toHaveCount(0);
    await sortPanel.getByRole('combobox', { name: '정렬 방향 1', exact: true }).selectOption('desc');
    await expect.poll(() => ids(rows)).toEqual([late.id, urgent.id, early.id, unscheduled.id]);
    await sortPanel.getByRole('combobox', { name: '정렬 방향 1', exact: true }).selectOption('asc');
    await button(sortPanel, '2번째 정렬 기준 위로 이동').click();
    await expect.poll(() => ids(rows)).toEqual([urgent.id, late.id, early.id, unscheduled.id]);
    await button(sortPanel, '1번째 정렬 기준 아래로 이동').click();
    await expect.poll(() => ids(rows)).toEqual(sortedRows);

    await button(page, '현재 보기 저장').click();
    const create = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    await expect(create).toContainText('목표 마감일 오름차순 → 우선순위 내림차순');
    await create.getByLabel('보기 이름', { exact: true }).fill(prefix);
    const post = page.waitForResponse(response => new URL(response.url()).pathname === '/api/views' && response.request().method() === 'POST');
    await button(create, '저장').click();
    saved = await json<SavedView>(await post, 201);
    expect(saved.sort).toEqual(rules);
    await expect(page.getByLabel('저장된 업무 보기', { exact: true })).toHaveValue(saved.id);
    expect(await exportedKeys(page, '현재 목록 CSV', ',')).toEqual(sortedKeys);

    await rows.first().locator('.issue-title-button').click();
    const detail = page.getByRole('dialog', { name: urgent.title, exact: true });
    await expect(button(detail, '다음 업무')).toHaveAttribute('title', early.key);
    await button(detail, '업무 상세 닫기').click();
    await button(page, '간트에서 열기').click();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect.poll(() => ids(chart.locator('.gantt-row[data-issue-id]'))).toEqual(sortedRows);
    await expect(page.getByRole('list', { name: '간트에 적용된 업무 정렬', exact: true }).getByRole('listitem'))
      .toHaveText(['목표 마감일 오름차순', '우선순위 내림차순']);
    expect(await exportedKeys(page, '일정 편집용 TSV 내려받기', '\t')).toEqual(sortedKeys);

    await button(page, '업무 보기에서 열기').click();
    await expect.poll(() => ids(rows)).toEqual(sortedRows);
    await page.setViewportSize({ width: 1440, height: 1450 });
    await button(page, '보드').click();
    await page.getByLabel('보드 그룹', { exact: true }).selectOption('assignee');
    const board = page.getByRole('region', { name: '담당자별 보드', exact: true });
    const cell = (assigneeId: string, status: string) => board.locator(
      `[data-board-assignee-id="${assigneeId}"] [data-status-id="${status}"]`);
    const cards = cell(firstAssignee.id, 'todo').locator('.issue-board-card');
    await expect.poll(() => ids(cards)).toEqual(sortedRows);
    const card = (value: Issue) => board.locator(`.issue-board-card[data-issue-id="${value.id}"]`);
    const rankWrites: string[] = [];
    page.on('request', req => {
      if (req.method() === 'PATCH' && new URL(req.url()).pathname === orderPath) rankWrites.push(req.url());
    });
    await card(late).dragTo(card(urgent));
    await expect.poll(() => ids(cards)).toEqual(sortedRows);
    await page.getByRole('checkbox', { name: '빈 담당자 그룹 표시', exact: true }).check();
    const destination = cell(nextAssignee.id, 'in_progress');
    const empty = destination.locator('.issue-column-empty');
    await empty.scrollIntoViewIfNeeded();
    const sourceBounds = await card(late).boundingBox();
    const targetBounds = await empty.boundingBox();
    expect(sourceBounds).toBeTruthy();
    expect(targetBounds).toBeTruthy();
    const from = { x: sourceBounds!.x + 25, y: sourceBounds!.y + 15 };
    const to = { x: targetBounds!.x + targetBounds!.width / 2, y: targetBounds!.y + targetBounds!.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 14, from.y);
    await page.mouse.move(to.x, to.y, { steps: 16 });
    await page.mouse.move(to.x + 5, to.y);
    const statusChange = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${late.id}`
      && response.request().method() === 'PATCH');
    await page.mouse.up();
    const moved = await json<Issue>(await statusChange);
    expect(moved).toMatchObject({ status: 'in_progress', assigneeId: nextAssignee.id });
    await expect(destination.locator(`.issue-board-card[data-issue-id="${late.id}"]`)).toBeVisible();
    expect(rankWrites).toEqual([]);
    expect((await json<ProjectIssueOrder>(await request.get(orderPath))).issueIds).toEqual(manual.order.issueIds);

    await button(page, '목록').click();
    await button(page, '업무 정렬').click();
    await button(sortPanel, '프로젝트 순서 사용').click();
    await expect.poll(() => ids(rows)).toEqual(manualRows);
    await expect(button(page, '순서 편집')).toBeVisible();
    await button(page, '보기 수정').click();
    const edit = page.getByRole('dialog', { name: '저장된 보기 수정', exact: true });
    const patch = page.waitForResponse(response => new URL(response.url()).pathname === `/api/views/${saved?.id}`
      && response.request().method() === 'PATCH');
    await button(edit, '저장').click();
    const result = await patch;
    expect(result.request().postDataJSON().sort).toBeNull();
    saved = await json<SavedView>(result);
    expect(saved.sort).toBeUndefined();
    await expect(edit).toHaveCount(0);
    await page.reload();
    await expect.poll(() => ids(rows)).toEqual(manualRows);
  } finally {
    if (saved) await request.delete(`/api/views/${saved.id}?expectedVersion=${saved.version}`);
    for (const issue of created.reverse()) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json()).trashEntryId}`);
    }
  }
});
