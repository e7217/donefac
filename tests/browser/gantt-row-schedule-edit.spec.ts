import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePastePreview, ScheduleRowEditInput, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/row-edit/preview';
const applyPath = '/api/schedule/row-edit/apply';
const undoPath = '/api/schedule/undo';
const date = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

const load = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const pair = (state: WorkspaceSnapshot, before: Issue, after: Issue) => state.dependencies.filter(link =>
  link.predecessorId === before.id && link.successorId === after.id);

async function fixture(request: APIRequestContext) {
  const { projects: [project], users: [actor] } = await load(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const ids: string[] = [];
  return {
    actor, project, headers,
    async issue(title: string, schedule: Partial<ReturnType<typeof dates>>) {
      const issue = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: project.id, title: `${title} ${suffix}`, ...schedule },
      }), 201);
      ids.push(issue.id);
      return issue;
    },
    async close() {
      for (const id of ids.reverse()) {
        const result = await request.delete(`/api/issues/${id}`, { headers });
        if (!result.ok()) continue;
        const { trashEntryId } = await result.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

function waitPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function openRow(page: Page, issue: Issue, actorId: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  await page.goto(`/#/${issue.projectId}/gantt`);
  const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  await expect(search).toBeVisible({ timeout: 35_000 });
  await search.fill(issue.title);
  const opener = page.getByRole('button', { name: `${issue.key} 일정과 연결 편집`, exact: true });
  await opener.press('Enter');
  const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
  await expect(dialog).toBeVisible();
  return { search, opener, dialog };
}

test('360px 간트 업무 행에서 숨은 선행 업무와 날짜를 한 번에 저장하고 응답 유실 뒤 같은 결과를 읽으며 모두 되돌린다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  try {
    const predecessor = await f.issue('필터 밖 선행 업무', { startDate: date(19), endDate: date(20) });
    const anchor = await f.issue('날짜와 연결을 함께 입력하는 업무', { endDate: date(26), dueDate: date(30) });
    const { search, opener, dialog } = await openRow(page, anchor, f.actor.id);
    await expect(page.locator(`[data-issue-id="${predecessor.id}"]`)).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const start = dialog.getByLabel('시작일', { exact: true });
    await expect(start).toHaveValue('');
    await expect(dialog.getByLabel('종료일', { exact: true })).toHaveValue(date(26));
    await dialog.getByLabel('선후행 연결 작업', { exact: true }).selectOption('add');
    const lookup = dialog.getByRole('textbox', { name: '연결할 업무 검색', exact: true });
    const candidate = dialog.getByRole('button', { name: `${predecessor.key} · ${predecessor.title}`, exact: true });
    await lookup.fill(predecessor.key);
    await lookup.press('ArrowDown');
    await expect(candidate).toBeFocused();
    await candidate.press('Enter');
    await dialog.getByLabel('연결 방향', { exact: true }).selectOption('predecessor');
    await dialog.getByLabel('연결 유형', { exact: true }).selectOption('FS');
    await dialog.getByRole('button', { name: '가장 이른 날짜 사용', exact: true }).click();
    await expect(start).toHaveValue(date(23));
    await dialog.getByRole('button', { name: '목표 마감일 비우기', exact: true }).click();

    const pendingPreview = waitPost(page, previewPath);
    await dialog.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const response = await pendingPreview;
    const input = response.request().postDataJSON() as ScheduleRowEditInput;
    const preview = await json<SchedulePastePreview>(response);
    expect(input.issue).toEqual({ id: anchor.id, expectedVersion: anchor.version });
    expect(input.changes).toEqual({ startDate: date(23), dueDate: null });
    expect(input.dependency).toEqual({ action: 'add', direction: 'predecessor', type: 'FS', lagDays: 0,
      relatedIssue: { id: predecessor.id, expectedVersion: predecessor.version } });
    expect(preview.previewId).toBeTruthy();
    expect(preview.errors).toEqual([]);
    expect(preview.warnings).toEqual([]);
    expect(dates((await load(request)).issues.find(issue => issue.id === anchor.id)!)).toEqual(dates(anchor));

    const attempts: unknown[] = [];
    let applied: SchedulePasteApplyResult | undefined;
    await page.route(`**${applyPath}`, async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length !== 1) return route.continue();
      applied = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.abort('failed');
    });
    await dialog.getByRole('button', { name: '일정과 연결 적용', exact: true }).click();
    const retry = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const pendingReplay = waitPost(page, applyPath);
    await retry.click();
    expect(await json<SchedulePasteApplyResult>(await pendingReplay)).toEqual(applied);
    expect(attempts).toEqual([{ previewId: preview.previewId }, { previewId: preview.previewId }]);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(search).toHaveValue(anchor.title);
    const committed = await load(request);
    expect(pair(committed, predecessor, anchor)).toHaveLength(1);
    const changed = committed.issues.find(issue => issue.id === anchor.id)!;
    expect(changed.version).toBe(anchor.version + 1);
    expect(dates(changed)).toEqual({ startDate: date(23), endDate: date(26), dueDate: null });
    await expect(page.getByLabel(`${anchor.key} 시작일`, { exact: true })).toHaveValue(date(23));

    const pendingUndo = waitPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect(await json<{ dependencyChanges: number }>(await pendingUndo)).toMatchObject({ dependencyChanges: 1 });
    await expect(page.getByLabel(`${anchor.key} 시작일`, { exact: true })).toHaveValue('');
    const undone = await load(request);
    expect(pair(undone, predecessor, anchor)).toEqual([]);
    expect(dates(undone.issues.find(issue => issue.id === anchor.id)!)).toEqual(dates(anchor));
  } finally {
    await f.close();
  }
});

test('검토 뒤 연결이 바뀌면 날짜 입력을 유지하고 최신 연결에서 다시 검토해 한 번만 적용한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  try {
    const predecessor = await f.issue('기존 선행 업무', { startDate: date(19), endDate: date(20) });
    const anchor = await f.issue('동시 연결 편집 검토 업무', { startDate: date(23), endDate: date(26) });
    const original = await json<Dependency>(await request.post('/api/dependencies', { headers: f.headers, data: {
      predecessorId: predecessor.id, successorId: anchor.id, type: 'FS', lagDays: 0,
    } }), 201);
    const { dialog, opener } = await openRow(page, anchor, f.actor.id);
    const end = dialog.getByLabel('종료일', { exact: true });
    const type = dialog.getByLabel('연결 유형', { exact: true });
    const lag = dialog.getByRole('spinbutton', { name: '간격 (근무일)', exact: true });
    const review = dialog.getByRole('button', { name: '변경 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '일정과 연결 적용', exact: true });
    await end.fill(date(27));
    await dialog.getByLabel('선후행 연결 작업', { exact: true }).selectOption('update');
    await dialog.getByLabel('편집할 연결', { exact: true }).selectOption(original.id);
    await type.selectOption('FF');
    await lag.fill('1');
    const pendingFirst = waitPost(page, previewPath);
    await review.click();
    const first = await json<SchedulePastePreview>(await pendingFirst);
    expect(first.previewId).toBeTruthy();
    const { users: [, peer] } = await load(request);
    const newer = await json<Dependency>(await request.patch(`/api/dependencies/${original.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: original.version ?? 1, type: 'SS' },
    }));
    const pendingConflict = waitPost(page, applyPath);
    await apply.click();
    expect((await pendingConflict).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('날짜와 연결 입력을 유지했습니다.');
    await expect(end).toHaveValue(date(27));
    await expect(type).toHaveValue('FF');
    await expect(lag).toHaveValue('1');
    await expect(review).toBeDisabled();
    const rejected = await load(request);
    expect(pair(rejected, predecessor, anchor)).toEqual([newer]);
    expect(dates(rejected.issues.find(issue => issue.id === anchor.id)!)).toEqual(dates(anchor));

    await dialog.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(review).toBeEnabled();
    const pendingSecond = waitPost(page, previewPath);
    await review.click();
    const second = await json<SchedulePastePreview>(await pendingSecond);
    expect(second.previewId).toBeTruthy();
    expect(second.previewId).not.toBe(first.previewId);
    expect(second.dependencyChanges).toEqual([expect.objectContaining({ before: { type: 'SS', lagDays: 0 }, after: { type: 'FF', lagDays: 1 } })]);

    let blockedReads = 0;
    let finalApplies = 0;
    await page.route(`**${applyPath}`, async route => { finalApplies++; await route.continue(); });
    await page.route('**/api/workspace', async route => {
      if (blockedReads++) return route.continue();
      await route.abort('failed');
    });
    const pendingApply = waitPost(page, applyPath);
    await apply.click();
    const saved = await json<SchedulePasteApplyResult>(await pendingApply);
    expect(saved.dependencyChanges).toBe(1);
    await expect(dialog.getByRole('alert')).toContainText('일정과 연결은 적용되었습니다.');
    await dialog.getByRole('button', { name: '화면에 다시 반영', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(finalApplies).toBe(1);
    await expect(page.getByLabel(`${anchor.key} 종료일`, { exact: true })).toHaveValue(date(27));
    const committed = await load(request);
    expect(pair(committed, predecessor, anchor)).toEqual([expect.objectContaining({ id: original.id, type: 'FF', lagDays: 1 })]);
    expect(committed.issues.find(issue => issue.id === anchor.id)?.version).toBe(anchor.version + 1);
  } finally {
    await f.close();
  }
});
