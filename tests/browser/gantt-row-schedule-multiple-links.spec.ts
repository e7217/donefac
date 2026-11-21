import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/row-edit/preview';
const applyPath = '/api/schedule/row-edit/apply';
const undoPath = '/api/schedule/undo';
const date = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const version = ({ id, version }: Issue) => ({ id, expectedVersion: version });
const original = { startDate: date(23), endDate: date(26), dueDate: date(30) };
const revised = { startDate: date(24), endDate: date(27), dueDate: null };

async function fixture(request: APIRequestContext) {
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const ids: string[] = [];
  return {
    actor, peer,
    async issue(title: string, schedule: Partial<ReturnType<typeof dates>>) {
      const value = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: project.id, title: `${title} ${suffix}`, ...schedule },
      }), 201);
      ids.push(value.id);
      return value;
    },
    async link(predecessor: Issue, successor: Issue) {
      return json<Dependency>(await request.post('/api/dependencies', {
        headers, data: { predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0 },
      }), 201);
    },
    async close() {
      for (const id of ids.reverse()) {
        const response = await request.delete(`/api/issues/${id}`, { headers });
        if (!response.ok()) continue;
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

async function network(f: Awaited<ReturnType<typeof fixture>>) {
  const anchor = await f.issue('날짜와 세 연결 편집 업무', original);
  const first = await f.issue('가려진 새 선행 업무', { startDate: date(18), endDate: date(20) });
  const previous = await f.issue('가려진 수정 대상 선행 업무', { startDate: date(19), endDate: date(20) });
  const later = await f.issue('가려진 해제 대상 후행 업무', { startDate: date(30), endDate: date(30) });
  const update = await f.link(previous, anchor);
  const remove = await f.link(anchor, later);
  return { anchor, first, previous, later, update, remove };
}

function waitPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function state(request: APIRequestContext, issue: Issue) {
  const saved = await workspace(request);
  const current = saved.issues.find(value => value.id === issue.id)!;
  const links = saved.dependencies.filter(link => link.predecessorId === issue.id || link.successorId === issue.id);
  return { issue: current, links };
}

async function openRow(page: Page, anchor: Issue, actorId: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  await page.goto(`/#/${anchor.projectId}/gantt`);
  const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  await expect(search).toBeVisible({ timeout: 35_000 });
  await search.fill(anchor.title);
  const opener = page.getByRole('button', { name: `${anchor.key} 일정과 연결 편집`, exact: true });
  await opener.press('Enter');
  const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
  await expect(dialog).toBeVisible();
  return { search, opener, dialog };
}

const row = (dialog: Locator, number: number) => dialog.getByRole('group', { name: `연결 변경 ${number}`, exact: true });
const button = (within: Locator, name: string) => within.getByRole('button', { name, exact: true });
const action = (group: Locator) => group.getByLabel('선후행 연결 작업', { exact: true });
const target = (group: Locator) => group.getByLabel('편집할 연결', { exact: true });
const type = (group: Locator) => group.getByLabel('연결 유형', { exact: true });
const lag = (group: Locator) => group.getByRole('spinbutton', { name: '간격 (근무일)', exact: true });

async function edit(dialog: Locator, { first, update, remove }: Awaited<ReturnType<typeof network>>) {
  await dialog.getByLabel('시작일', { exact: true }).fill(revised.startDate);
  await dialog.getByLabel('종료일', { exact: true }).fill(revised.endDate);
  await button(dialog, '목표 마감일 비우기').click();

  const add = row(dialog, 1);
  await action(add).selectOption('add');
  const lookup = add.getByRole('textbox', { name: '연결할 업무 검색', exact: true });
  await lookup.fill(first.key);
  const candidate = button(add, `${first.key} · ${first.title}`);
  await lookup.press('ArrowDown');
  await expect(candidate).toBeFocused();
  await candidate.press('Enter');

  await button(dialog, '연결 변경 추가').click();
  const change = row(dialog, 2);
  await action(change).selectOption('update');
  await target(change).selectOption(update.id);
  await type(change).selectOption('SS');
  await lag(change).fill('1');

  await button(dialog, '연결 변경 추가').click();
  const drop = row(dialog, 3);
  await action(drop).selectOption('remove');
  await target(drop).selectOption(remove.id);
}

function expectedInput(f: Awaited<ReturnType<typeof network>>, changed = f.update) {
  const { anchor, first, previous, later, remove } = f;
  return {
    projectId: anchor.projectId, issue: version(anchor), changes: revised,
    dependencies: [
      { action: 'add', direction: 'predecessor', relatedIssue: version(first), type: 'FS', lagDays: 0 },
      { action: 'update', id: changed.id, expectedVersion: changed.version ?? 1, relatedIssue: version(previous), type: 'SS', lagDays: 1 },
      { action: 'remove', id: remove.id, expectedVersion: remove.version ?? 1, relatedIssue: version(later) },
    ],
  };
}

async function preview(page: Page, dialog: Locator) {
  const pending = waitPost(page, previewPath);
  await button(dialog, '변경 미리보기').click();
  const response = await pending;
  const result = await json<SchedulePastePreview>(response);
  expect(result.previewId).toBeTruthy();
  expect(result.errors).toEqual([]);
  return { result, input: response.request().postDataJSON() };
}

test('360px에서 날짜와 연결 추가·수정·해제를 함께 저장하고 응답 유실 뒤 한 번만 재확인하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  try {
    const n = await network(f);
    const { anchor, first, previous, later, update, remove } = n;
    const { dialog, search, opener } = await openRow(page, anchor, f.actor.id);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    for (const hidden of [first, previous, later]) await expect(page.locator(`[data-issue-id="${hidden.id}"]`)).toHaveCount(0);
    await edit(dialog, n);
    await button(dialog, '연결 변경 추가').click();
    const duplicate = row(dialog, 4);
    await expect(action(duplicate)).toBeFocused();
    await action(duplicate).selectOption('remove');
    await target(duplicate).selectOption(update.id);
    await expect(duplicate.getByText('같은 연결을 여러 번 변경할 수 없습니다.', { exact: true })).toBeVisible();
    await expect(button(dialog, '변경 미리보기')).toBeDisabled();
    await button(duplicate, '연결 변경 4 빼기').click();
    await expect(duplicate).toHaveCount(0);
    const before = await state(request, anchor);
    const { result, input } = await preview(page, dialog);
    expect(input).toEqual(expectedInput(n));
    expect(result.changes).toEqual([expect.objectContaining({ id: anchor.id, fromDue: original.dueDate, toDue: null,
      fromStart: original.startDate, toStart: revised.startDate, fromEnd: original.endDate, toEnd: revised.endDate })]);
    expect(result.dependencyChanges).toEqual([
      expect.objectContaining({ predecessorKey: first.key, successorKey: anchor.key, before: null, after: { type: 'FS', lagDays: 0 } }),
      expect.objectContaining({ predecessorKey: previous.key, successorKey: anchor.key, before: { type: 'FS', lagDays: 0 }, after: { type: 'SS', lagDays: 1 } }),
      expect.objectContaining({ predecessorKey: anchor.key, successorKey: later.key, before: { type: 'FS', lagDays: 0 }, after: null }),
    ]);
    const details = dialog.getByRole('region', { name: '일정과 연결 미리보기', exact: true });
    for (const [from, to] of [[first, anchor], [previous, anchor], [anchor, later]]) {
      await expect(details.getByRole('heading', { name: `${from.key} → ${to.key}`, exact: true })).toBeVisible();
    }
    expect(await state(request, anchor)).toEqual(before);

    const attempts: unknown[] = [];
    let saved: SchedulePasteApplyResult | undefined;
    await page.route(`**${applyPath}`, async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      saved = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.abort('failed');
    });
    await button(dialog, '일정과 연결 적용').click();
    const retry = button(dialog, '적용 결과 다시 확인');
    await expect(retry).toBeVisible();
    expect(saved).toMatchObject({ dependencyChanges: 3, updated: [expect.objectContaining({ id: anchor.id, ...revised })] });
    const replay = waitPost(page, applyPath);
    await retry.click();
    expect(await json<SchedulePasteApplyResult>(await replay)).toEqual(saved);
    expect(attempts).toEqual([{ previewId: result.previewId }, { previewId: result.previewId }]);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(search).toHaveValue(anchor.title);
    const committed = await state(request, anchor);
    expect(dates(committed.issue)).toEqual(revised);
    expect(committed.issue.version).toBe(anchor.version + 1);
    expect(committed.links).toHaveLength(2);
    expect(committed.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ predecessorId: first.id, successorId: anchor.id, type: 'FS', lagDays: 0 }),
      expect.objectContaining({ id: update.id, predecessorId: previous.id, successorId: anchor.id, type: 'SS', lagDays: 1 }),
    ]));
    expect(committed.links.some(link => link.id === remove.id)).toBe(false);
    await expect(page.getByLabel(`${anchor.key} 시작일`, { exact: true })).toHaveValue(revised.startDate);

    const pendingUndo = waitPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect(await json<SchedulePasteApplyResult>(await pendingUndo)).toMatchObject({ dependencyChanges: 3 });
    await expect(page.getByLabel(`${anchor.key} 시작일`, { exact: true })).toHaveValue(original.startDate);
    const undone = await state(request, anchor);
    expect(dates(undone.issue)).toEqual(original);
    const rule = ({ id, predecessorId, successorId, type, lagDays }: Dependency) => ({ id, predecessorId, successorId, type, lagDays });
    expect(undone.links.map(rule)).toHaveLength(2);
    expect(undone.links.map(rule)).toEqual(expect.arrayContaining([rule(update), rule(remove)]));
  } finally { await f.close(); }
});

test('여러 연결 중 하나가 바뀌면 전체 적용을 멈추고 날짜와 모든 연결 입력에서 다시 검토한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  try {
    const n = await network(f);
    const { anchor, first, update, remove } = n;
    const { dialog, opener } = await openRow(page, anchor, f.actor.id);
    await edit(dialog, n);
    const pending = await preview(page, dialog);
    const newer = await json<Dependency>(await request.patch(`/api/dependencies/${update.id}`, {
      headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: update.version ?? 1, type: 'FF', lagDays: 0 },
    }));
    const before = await state(request, anchor);
    const applying = waitPost(page, applyPath);
    await button(dialog, '일정과 연결 적용').click();
    expect((await applying).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('날짜와 연결 입력을 유지했습니다.');
    expect(await state(request, anchor)).toEqual(before);
    await expect(dialog.getByLabel('시작일', { exact: true })).toHaveValue(revised.startDate);
    await expect(dialog.getByLabel('종료일', { exact: true })).toHaveValue(revised.endDate);
    await expect(dialog.getByLabel('목표 마감일', { exact: true })).toHaveValue('');
    await expect(row(dialog, 1).getByText(`${first.key} · ${first.title}`, { exact: true })).toBeVisible();
    await expect(target(row(dialog, 2))).toHaveValue(update.id);
    await expect(type(row(dialog, 2))).toHaveValue('SS');
    await expect(lag(row(dialog, 2))).toHaveValue('1');
    await expect(action(row(dialog, 3))).toHaveValue('remove');
    await expect(target(row(dialog, 3))).toHaveValue(remove.id);
    await expect(button(dialog, '변경 미리보기')).toBeDisabled();

    await button(dialog, '최신 업무 불러오기').click();
    const refreshed = await preview(page, dialog);
    expect(refreshed.input).toEqual(expectedInput(n, newer));
    expect(refreshed.result.previewId).not.toBe(pending.result.previewId);
    expect(refreshed.result.dependencyChanges?.[1]?.before).toEqual({ type: 'FF', lagDays: 0 });
    const saving = waitPost(page, applyPath);
    await button(dialog, '일정과 연결 적용').click();
    expect(await json<SchedulePasteApplyResult>(await saving)).toMatchObject({ dependencyChanges: 3 });
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    const after = await state(request, anchor);
    expect(after.issue.version).toBe(anchor.version + 1);
    expect(dates(after.issue)).toEqual(revised);
    expect(after.links).toHaveLength(2);
    expect(after.links.some(link => link.id === remove.id)).toBe(false);
  } finally { await f.close(); }
});

test('360px에서 새 연결을 기준으로 숨겨진 후행 일정까지 검토하고 날짜와 연결을 한 번에 되돌린다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  try {
    const anchor = await f.issue('연결과 후행 일정의 기준 업무', { startDate: date(23), endDate: date(24) });
    const successor = await f.issue('가려진 직접 후행 업무', { startDate: date(25), endDate: date(26) });
    const last = await f.issue('가려진 간접 후행 업무', { startDate: date(27), endDate: date(27) });
    const originalLink = await f.link(successor, last);
    const { dialog, opener } = await openRow(page, anchor, f.actor.id);
    for (const hidden of [successor, last]) await expect(page.locator(`[data-issue-id="${hidden.id}"]`)).toHaveCount(0);
    const cascade = dialog.getByRole('checkbox', { name: '후행 일정 함께 검토', exact: true });
    await expect(cascade).not.toBeChecked();
    await dialog.getByLabel('종료일', { exact: true }).fill(date(25));
    const add = row(dialog, 1);
    await action(add).selectOption('add');
    await add.getByRole('textbox', { name: '연결할 업무 검색', exact: true }).fill(successor.key);
    await button(add, `${successor.key} · ${successor.title}`).click();
    await add.getByLabel('연결 방향', { exact: true }).selectOption('successor');

    const before = await workspace(request);
    const manual = await preview(page, dialog);
    expect(manual.input).not.toHaveProperty('rescheduleSuccessors');
    expect(manual.result.changes.map(change => change.id)).toEqual([anchor.id]);
    await cascade.check();
    const apply = button(dialog, '일정과 연결 적용');
    await expect(apply).toBeDisabled();
    const planned = await preview(page, dialog);
    expect(planned.input).toMatchObject({ rescheduleSuccessors: true, changes: { endDate: date(25) },
      dependency: { action: 'add', direction: 'successor', relatedIssue: version(successor) } });
    expect(planned.result.previewId).not.toBe(manual.result.previewId);
    expect(planned.result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: anchor.id, toStart: date(23), toEnd: date(25) }),
      expect.objectContaining({ id: successor.id, toStart: date(26), toEnd: date(27) }),
      expect.objectContaining({ id: last.id, toStart: date(30), toEnd: date(30) }),
    ]));
    expect(planned.result.changes).toHaveLength(3);
    const details = dialog.getByRole('region', { name: '일정과 연결 미리보기', exact: true });
    for (const issue of [anchor, successor, last]) {
      await expect(details.getByRole('heading', { name: `${issue.key} · ${issue.title}`, exact: true })).toBeVisible();
    }
    await expect(details.getByRole('heading', { name: `${anchor.key} → ${successor.key}`, exact: true })).toBeVisible();
    expect(await workspace(request)).toEqual(before);

    const applying = waitPost(page, applyPath);
    await apply.click();
    const applied = await json<SchedulePasteApplyResult>(await applying);
    expect(applied.dependencyChanges).toBe(1);
    expect(applied.updated).toHaveLength(3);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.getByLabel(`${anchor.key} 종료일`, { exact: true })).toHaveValue(date(25));
    const committed = await workspace(request);
    expect(committed.issues.filter(value => value.id === last.id)).toEqual([expect.objectContaining({ startDate: date(30), endDate: date(30) })]);
    expect(committed.dependencies).toContainEqual(expect.objectContaining({ predecessorId: anchor.id, successorId: successor.id }));

    const undoing = waitPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await json<SchedulePasteApplyResult>(await undoing);
    expect(undone.dependencyChanges).toBe(1);
    expect(new Map(undone.updated.map(issue => [issue.id, dates(issue)])))
      .toEqual(new Map([anchor, successor, last].map(issue => [issue.id, dates(issue)])));
    const restored = await workspace(request);
    expect(restored.dependencies.some(link => link.predecessorId === anchor.id && link.successorId === successor.id)).toBe(false);
    expect(restored.dependencies).toContainEqual(originalLink);
  } finally { await f.close(); }
});
