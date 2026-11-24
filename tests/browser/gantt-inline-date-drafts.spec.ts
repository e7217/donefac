import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Dialog, type Locator, type Page } from '@playwright/test';
import type { Dependency, Issue, Project, SchedulePasteApplyResult, SchedulePastePreview, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

const manualPreview = '/api/schedule/manual-preview';
const manualApply = '/api/schedule/manual-apply';
const undoPath = '/api/schedule/undo';
const rowPreview = '/api/schedule/row-edit/preview';
const rowApply = '/api/schedule/row-edit/apply';
const date = (day: number) => `2026-11-${day}`;
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `간트 날짜 초안 ${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  return {
    first, second, actor, prefix,
    async issue(project: Project, label: string, startDate: string, endDate: string) {
      const created = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: project.id, title: `${prefix} ${label}`, startDate, endDate },
      }), 201);
      ids.push(created.id);
      return created;
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

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

function scheduleWrites(page: Page) {
  const paths: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/api/schedule/')) paths.push(path);
  });
  return paths;
}

async function openChart(page: Page, project: Project, actorId: string, prefix: string, scope: '' | '?scope=team') {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  await page.goto(`/#/${project.id}/gantt${scope}`);
  await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(prefix);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  return {
    row: (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`),
    start: (issue: Issue) => chart.getByLabel(`${issue.key} 시작일`, { exact: true }),
    end: (issue: Issue) => chart.getByLabel(`${issue.key} 종료일`, { exact: true }),
  };
}

async function reloadChart(page: Page, prefix: string) {
  const allowReload = (dialog: Dialog) => { void dialog.accept(); };
  page.on('dialog', allowReload);
  try { await page.reload(); }
  finally { page.off('dialog', allowReload); }
  await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(prefix);
}

test('프로젝트 간트에서 다른 날짜 칸으로 이동해도 두 행의 입력을 유지하고 고른 행만 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const first = await data.issue(data.first, '첫 날짜 변경', date(23), date(26));
    const second = await data.issue(data.first, '두 번째 날짜 변경', date(24), date(27));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '');
    const writes = scheduleWrites(page);
    const firstStart = chart.start(first), secondEnd = chart.end(second);
    await firstStart.fill(date(24));
    await firstStart.press('Tab');
    await secondEnd.fill(date(30));
    await chart.start(second).focus();
    await expect(firstStart).toHaveValue(date(24));
    await expect(secondEnd).toHaveValue(date(30));

    const safeRoute = page.url();
    const discarded = page.waitForEvent('dialog', { timeout: 5_000 }).then(async confirmation => {
      const message = confirmation.message();
      await confirmation.dismiss();
      expect(message).toContain('저장하지 않은 간트 입력');
    });
    await Promise.all([discarded, page.evaluate(hash => { location.hash = hash; }, `#/${data.first.id}/teamboard`)]);
    await expect(page).toHaveURL(safeRoute);
    await expect(page.locator('.issue-detail-panel')).toHaveCount(0);
    await expect(firstStart).toHaveValue(date(24));
    await expect(secondEnd).toHaveValue(date(30));
    const before = await workspace(request);
    expect(before.issues.find(issue => issue.id === first.id)).toEqual(first);
    expect(before.issues.find(issue => issue.id === second.id)).toEqual(second);
    expect(writes).toEqual([]);

    const previewRequest = nextPost(page, manualPreview), applyRequest = nextPost(page, manualApply);
    const save = button(chart.row(first), `${first.key} 날짜 저장`);
    await save.click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toEqual({ changes: [{
      id: first.id, expectedVersion: first.version, startDate: date(24), endDate: date(26),
    }] });
    const preview = await json<SchedulePreview>(previewResponse);
    const applyResponse = await applyRequest;
    expect(applyResponse.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    const applied = await json<SchedulePasteApplyResult>(applyResponse);
    expect(applied.updated).toMatchObject([{ id: first.id, version: first.version + 1, startDate: date(24), endDate: date(26) }]);
    await expect(save).toHaveCount(0);
    await expect(secondEnd).toHaveValue(date(30));

    const cancel = button(chart.row(second), `${second.key} 날짜 변경 취소`);
    await cancel.click();
    await expect(cancel).toHaveCount(0);
    await expect(secondEnd).toHaveValue(date(27));
    expect(writes).toEqual([manualPreview, manualApply]);
    const after = await workspace(request);
    expect(after.issues.find(issue => issue.id === first.id)).toEqual(applied.updated[0]);
    expect(after.issues.find(issue => issue.id === second.id)).toEqual(second);
  } finally { await data.close(); }
});

test('360px 프로젝트 간트의 날짜 초안을 티켓 일정 편집에서 연결과 함께 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const first = await data.issue(data.first, '검토 대상 첫 업무', date(23), date(26));
    const second = await data.issue(data.first, '검토 대상 두 번째 업무', date(24), date(27));
    const predecessor = await data.issue(data.first, '간트 검색 밖 선행 업무', date(18), date(20));
    const chart = await openChart(page, data.first, data.actor.id, `${data.prefix} 검토 대상`, '');
    const writes = scheduleWrites(page);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    const firstDraft = { startDate: date(24), endDate: date(29) };
    const secondEnd = date(30);
    const firstOpener = chart.row(first).locator('.gantt-issue-name');
    const firstTicket = page.getByRole('dialog', { name: first.title, exact: true });
    const secondTicket = page.getByRole('dialog', { name: second.title, exact: true });
    const schedule = button(firstTicket, '일정과 연결 편집');
    const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const inherited = editor.getByText('간트에 입력한 날짜 초안을 불러왔습니다.', { exact: true });
    const editorStart = editor.getByLabel('시작일', { exact: true });
    const editorEnd = editor.getByLabel('종료일', { exact: true });
    const closeEditor = button(editor, '닫기');
    const openSibling = (ticket: Locator, next: Issue) =>
      ticket.locator(`button[title="${next.key}"]:is([aria-label="이전 업무"], [aria-label="다음 업무"])`);
    await expect(chart.row(predecessor)).toHaveCount(0);
    await chart.start(first).fill(firstDraft.startDate);
    await chart.end(first).fill(firstDraft.endDate);
    await chart.end(second).fill(secondEnd);

    await firstOpener.click();
    await expect(firstTicket).toBeVisible();
    await openSibling(firstTicket, second).click();
    await expect(secondTicket).toBeVisible();
    await openSibling(secondTicket, first).click();
    await expect(firstTicket).toBeVisible();
    await schedule.click();
    await expect(inherited).toBeVisible();
    await expect(editorStart).toHaveValue(firstDraft.startDate);
    await expect(editorEnd).toHaveValue(firstDraft.endDate);
    await editorEnd.fill(date(30));
    const discardEditor = page.waitForEvent('dialog', { timeout: 5000 }).then(async confirmation => {
      expect(confirmation.message()).toContain('버리고 닫을까요');
      await confirmation.accept();
    });
    await Promise.all([discardEditor, closeEditor.click()]);
    await expect(editor).toHaveCount(0);
    await expect(schedule).toBeFocused();

    const ticketEnd = firstTicket.getByLabel('종료일', { exact: true });
    await ticketEnd.fill(date(28));
    await schedule.click();
    await expect(editorEnd).toHaveValue(date(28));
    await expect(editorStart).toHaveValue(first.startDate!);
    await expect(inherited).toHaveCount(0);
    await closeEditor.click();
    await expect(editor).toHaveCount(0);
    await ticketEnd.fill(first.endDate!);
    await button(firstTicket, '업무 상세 닫기').click();
    await expect(firstTicket).toHaveCount(0);
    await expect(chart.start(first)).toHaveValue(firstDraft.startDate);
    await expect(chart.end(first)).toHaveValue(firstDraft.endDate);
    await expect(chart.end(second)).toHaveValue(secondEnd);
    expect(writes).toEqual([]);
    const before = await workspace(request);
    expect(before.issues.filter(issue => [first.id, second.id].includes(issue.id))).toEqual(expect.arrayContaining([first, second]));
    expect(before.dependencies.filter(edge => edge.successorId === first.id)).toEqual([]);

    await firstOpener.click();
    const title = firstTicket.getByLabel('제목', { exact: true });
    const comment = firstTicket.getByLabel('댓글 내용', { exact: true });
    const titleDraft = `${first.title} 제목 초안`;
    const commentDraft = '일정과 연결을 저장하는 동안 보존할 댓글';
    await title.fill(titleDraft);
    await comment.fill(commentDraft);
    await schedule.click();
    await expect(inherited).toBeVisible();
    await expect(editorStart).toHaveValue(firstDraft.startDate);
    await expect(editorEnd).toHaveValue(firstDraft.endDate);
    const change = editor.getByRole('group', { name: '연결 변경 1', exact: true });
    await change.getByLabel('선후행 연결 작업', { exact: true }).selectOption('add');
    await change.getByLabel('연결할 업무 검색', { exact: true }).fill(predecessor.key);
    await button(change, `${predecessor.key} · ${predecessor.title}`).click();
    await change.getByLabel('연결 방향', { exact: true }).selectOption('predecessor');
    await change.getByLabel('연결 유형', { exact: true }).selectOption('FS');
    const previewing = nextPost(page, rowPreview);
    await button(editor, '변경 미리보기').click();
    const planned = await previewing;
    expect(planned.request().postDataJSON()).toMatchObject({
      projectId: data.first.id, issue: { id: first.id, expectedVersion: first.version }, changes: firstDraft,
      dependency: { action: 'add', type: 'FS', direction: 'predecessor', relatedIssue: { id: predecessor.id, expectedVersion: predecessor.version } },
    });
    const preview = await json<SchedulePastePreview>(planned);
    expect(preview.changes).toEqual([expect.objectContaining({ id: first.id, toStart: firstDraft.startDate, toEnd: firstDraft.endDate })]);
    expect(preview.dependencyChanges).toMatchObject([{ predecessorKey: predecessor.key, successorKey: first.key, after: { type: 'FS', lagDays: 0 } }]);
    const applying = nextPost(page, rowApply);
    await button(editor, '일정과 연결 적용').click();
    const applied = await json<SchedulePasteApplyResult>(await applying);
    expect(applied).toMatchObject({ updated: [{ id: first.id, version: first.version + 1, title: first.title, ...firstDraft }], dependencyChanges: 1 });
    await expect(editor).toHaveCount(0);
    await expect(schedule).toBeFocused();
    await expect(firstTicket.getByLabel('시작일', { exact: true })).toHaveValue(firstDraft.startDate);
    await expect(ticketEnd).toHaveValue(firstDraft.endDate);
    await expect(title).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    const after = await workspace(request);
    expect(after.issues.find(issue => issue.id === second.id)).toEqual(second);
    expect(after.dependencies.filter(edge => edge.successorId === first.id)).toMatchObject([{ predecessorId: predecessor.id, successorId: first.id, type: 'FS', lagDays: 0 }]);

    const discardTicket = page.waitForEvent('dialog', { timeout: 5000 }).then(async confirmation => {
      expect(confirmation.message()).toContain('업무 변경사항');
      await confirmation.accept();
    });
    await Promise.all([discardTicket, button(firstTicket, '업무 상세 닫기').click()]);
    await expect(firstTicket).toHaveCount(0);
    await expect(search).toHaveValue(`${data.prefix} 검토 대상`);
    await expect(chart.start(first)).toHaveValue(firstDraft.startDate);
    await expect(chart.end(first)).toHaveValue(firstDraft.endDate);
    await expect(button(chart.row(first), `${first.key} 날짜 저장`)).toHaveCount(0);
    await expect(chart.end(second)).toHaveValue(secondEnd);
    await expect(button(chart.row(second), `${second.key} 날짜 저장`)).toBeVisible();
    expect(writes).toEqual([rowPreview, rowApply]);
  } finally { await data.close(); }
});

test('360px 전체 프로젝트 간트에서 초안을 유지하며 두 티켓을 검토하고 다른 화면 이동을 막는다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const data = await fixture(request);
  try {
    const first = await data.issue(data.first, '첫 프로젝트 업무', date(20), date(24));
    const second = await data.issue(data.second, '다른 프로젝트 업무', date(23), date(27));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '?scope=team');
    const writes = scheduleWrites(page);
    await chart.start(first).fill(date(21));
    await chart.end(second).fill(date(29));
    const firstOpener = chart.row(first).locator('.gantt-issue-name');
    await firstOpener.click();
    const firstTicket = page.getByRole('dialog', { name: first.title, exact: true });
    await expect(firstTicket).toBeVisible();
    await firstTicket.locator(`button[title="${second.key}"]:is([aria-label="이전 업무"], [aria-label="다음 업무"])`).click();
    const otherTicket = page.getByRole('dialog', { name: second.title, exact: true });
    await expect(otherTicket).toBeVisible();
    await button(otherTicket, '업무 상세 닫기').click();
    await expect(otherTicket).toHaveCount(0);
    await expect(firstOpener).toBeFocused();
    await expect(chart.start(first)).toHaveValue(date(21));
    await expect(chart.end(second)).toHaveValue(date(29));
    const safeRoute = page.url();
    const leaving = page.waitForEvent('dialog', { timeout: 5000 }).then(async confirmation => {
      expect(confirmation.message()).toContain('저장하지 않은 간트 입력');
      await confirmation.dismiss();
    });
    await Promise.all([leaving, page.evaluate(hash => { location.hash = hash; }, `#/${data.first.id}/teamboard`)]);
    await expect(page).toHaveURL(safeRoute);
    await expect(chart.start(first)).toHaveValue(date(21));
    await expect(chart.end(second)).toHaveValue(date(29));
    expect((await workspace(request)).issues.filter(issue => [first.id, second.id].includes(issue.id))).toEqual(expect.arrayContaining([first, second]));
    expect(writes).toEqual([]);
  } finally { await data.close(); }
});

test('한 행의 첫 날짜 저장이 충돌하면 초안을 유지하고 동료가 바꾼 다른 날짜를 보존한다', async ({ page, request }) => {
  const data = await fixture(request);
  try {
    const issue = await data.issue(data.first, '동시 편집할 날짜', date(23), date(26));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '');
    const writes = scheduleWrites(page);
    const start = chart.start(issue);
    const save = button(chart.row(issue), `${issue.key} 날짜 저장`);
    const dialog = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const review = button(dialog, '다시 미리보기');
    const apply = button(dialog, '변경 적용');
    await start.fill(date(24));

    const { users: [, peer] } = await workspace(request);
    const latest = await json<Issue>(await request.patch(`/api/issues/${issue.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: issue.version, endDate: date(29) },
    }));
    const stale = nextPost(page, manualPreview);
    await start.press('Enter');
    expect((await stale).status()).toBe(409);
    await expect(dialog).toBeVisible();
    await expect(review).toBeFocused();
    await expect(apply).toBeDisabled();
    expect(writes).toEqual([manualPreview]);

    await review.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(start).toBeFocused();
    await expect(start).toHaveValue(date(24));
    expect((await workspace(request)).issues.find(candidate => candidate.id === issue.id)).toEqual(latest);

    const reopened = nextPost(page, manualPreview);
    await save.click();
    expect((await reopened).status()).toBe(409);
    const refreshed = nextPost(page, manualPreview);
    await review.click();
    const response = await refreshed;
    expect(response.request().postDataJSON()).toEqual({ changes: [{
      id: issue.id, expectedVersion: latest.version, startDate: date(24), endDate: date(29),
    }] });
    const preview = await json<SchedulePreview>(response);
    const row = dialog.getByRole('row').filter({ hasText: issue.key });
    await expect(row.getByRole('cell').nth(1)).toHaveText(`${date(23)}${date(29)}`);
    await expect(row.locator('.gantt-new-dates')).toHaveText(`${date(24)}${date(29)}`);
    expect((await workspace(request)).issues.find(candidate => candidate.id === issue.id)).toEqual(latest);
    expect(writes).toEqual([manualPreview, manualPreview, manualPreview]);

    const applied = nextPost(page, manualApply);
    await apply.click();
    const appliedResponse = await applied;
    expect(appliedResponse.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    expect((await json<SchedulePasteApplyResult>(appliedResponse)).updated).toMatchObject([{
      id: issue.id, version: latest.version + 1, startDate: date(24), endDate: date(29),
    }]);
    await expect(dialog).toHaveCount(0);
    await expect(save).toHaveCount(0);
    await expect(start).toHaveValue(date(24));
    await expect(chart.end(issue)).toHaveValue(date(29));
  } finally { await data.close(); }
});

test('360px 간트의 한 행 저장에서 가려진 같은 프로젝트 선행 조건을 검토하고 동료의 날짜를 보존한다', async ({ page, request }) => {
  const data = await fixture(request);
  const actor = { 'X-Actor-Id': data.actor.id };
  let dependency: Dependency | undefined;
  try {
    const predecessor = await data.issue(data.first, '검색에서 가려진 선행 업무', date(19), date(20));
    const target = await data.issue(data.first, '시작일을 검토할 후행 업무', date(24), date(26));
    dependency = await json<Dependency>(await request.post('/api/dependencies', { headers: actor, data: {
      predecessorId: predecessor.id, successorId: target.id, type: 'FS', lagDays: 0,
    } }), 201);

    const chart = await openChart(page, data.first, data.actor.id, target.title, '');
    const start = chart.start(target), save = button(chart.row(target), `${target.key} 날짜 저장`);
    const dialog = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const apply = button(dialog, '변경 적용');
    const writes = scheduleWrites(page);
    const proposedStart = date(20);
    const stored = async (issue: Issue) => (await workspace(request)).issues.find(value => value.id === issue.id);
    const warning = (required: string) => dialog.getByText(new RegExp(`${predecessor.key} → ${target.key}.*${required}`));
    await expect(chart.row(predecessor)).toHaveCount(0);
    await start.fill(proposedStart);

    const firstPreview = nextPost(page, manualPreview);
    await start.press('Enter');
    const initial = await json<SchedulePreview>(await firstPreview);
    expect(initial.warnings).toEqual([expect.stringContaining(`후행 업무 시작일은 ${date(23)} 이후여야 합니다.`)]);
    await expect(warning(date(23))).toBeVisible();
    expect(writes).toEqual([manualPreview]);
    expect(await stored(target)).toEqual(target);

    await button(dialog, '취소').click();
    await expect(dialog).toHaveCount(0);
    await expect(start).toBeFocused();
    await expect(start).toHaveValue(proposedStart);
    expect(await stored(target)).toEqual(target);
    const secondPreview = nextPost(page, manualPreview);
    await save.click();
    const beforePeerEdit = await json<SchedulePreview>(await secondPreview);
    await expect(warning(date(23))).toBeVisible();
    expect(writes).toEqual([manualPreview, manualPreview]);

    const { users: [, peer] } = await workspace(request);
    const headers = { 'X-Actor-Id': peer.id };
    const changedPredecessor = await json<Issue>(await request.patch(`/api/issues/${predecessor.id}`, { headers,
      data: { expectedVersion: predecessor.version, endDate: date(23) },
    }));
    const changedTarget = await json<Issue>(await request.patch(`/api/issues/${target.id}`, { headers,
      data: { expectedVersion: target.version, endDate: date(30) },
    }));
    const staleApply = nextPost(page, manualApply);
    await apply.click();
    const stale = await staleApply;
    expect(stale.status(), await stale.text()).toBe(409);
    expect(stale.request().postDataJSON()).toEqual({ previewId: beforePeerEdit.previewId });
    await expect(apply).toBeDisabled();
    expect(await stored(target)).toEqual(changedTarget);

    const newPreview = nextPost(page, manualPreview);
    await button(dialog, '다시 미리보기').click();
    const reviewed = await newPreview;
    expect(reviewed.request().postDataJSON()).toEqual({ changes: [{
      id: target.id, expectedVersion: changedTarget.version, startDate: proposedStart, endDate: changedTarget.endDate,
    }] });
    const latest = await json<SchedulePreview>(reviewed);
    await expect(warning(date(24))).toBeVisible();
    await expect(dialog.locator('.gantt-new-dates')).toHaveText(`${proposedStart}${changedTarget.endDate}`);
    expect(await stored(target)).toEqual(changedTarget);

    const applying = nextPost(page, manualApply);
    await apply.click();
    const confirmed = await applying;
    expect(confirmed.request().postDataJSON()).toEqual({ previewId: latest.previewId });
    const applied = await json<SchedulePasteApplyResult>(confirmed);
    expect(applied.updated).toMatchObject([{ id: target.id, startDate: proposedStart, endDate: changedTarget.endDate,
      version: changedTarget.version + 1 }]);
    await expect(chart.end(target)).toHaveValue(date(30));

    const undoing = nextPost(page, undoPath);
    await button(page, '되돌리기').click();
    await json(await undoing);
    await expect(start).toHaveValue(date(24));
    await expect(chart.end(target)).toHaveValue(date(30));
    expect(await stored(predecessor)).toEqual(changedPredecessor);
    expect(await stored(target)).toMatchObject({ startDate: changedTarget.startDate, endDate: changedTarget.endDate,
      version: changedTarget.version + 2 });
    expect((await workspace(request)).dependencies).toContainEqual(dependency);
  } finally {
    if (dependency) await request.delete(`/api/dependencies/${dependency.id}`, { headers: actor });
    await data.close();
  }
});

test('전체 프로젝트 간트의 날짜 초안을 함께 검토하고 동료 변경은 보존한 채 한 번에 적용·복원한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const first = await data.issue(data.first, '첫 프로젝트의 날짜 초안', date(23), date(26));
    const second = await data.issue(data.second, '두 번째 프로젝트의 날짜 초안', date(24), date(27));
    const unchanged = await data.issue(data.second, '날짜 미편집 업무', date(25), date(26));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '?scope=team');
    const writes = scheduleWrites(page);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    const firstStart = chart.start(first), secondEnd = chart.end(second);
    const review = button(page, '입력한 날짜 2건 검토');
    const dialog = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const apply = button(dialog, '변경 적용');
    const previewRow = (issue: Issue) => dialog.getByRole('row').filter({ hasText: issue.key });
    const initialChanges = [
      { id: first.id, expectedVersion: first.version, startDate: date(25), endDate: date(26) },
      { id: second.id, expectedVersion: second.version, startDate: date(24), endDate: date(30) },
    ];
    async function checkStored(expected: Issue[]) {
      const { issues } = await workspace(request);
      for (const issue of expected) expect(issues.find(value => value.id === issue.id)).toEqual(issue);
    }
    async function enterPreview() {
      const pending = nextPost(page, manualPreview);
      await review.click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({ changes: expect.arrayContaining(initialChanges) });
      expect(response.request().postDataJSON().changes).toHaveLength(2);
      const preview = await json<SchedulePreview>(response);
      expect(preview.previewId).toBeTruthy();
      return preview;
    }

    await firstStart.fill(date(25));
    await secondEnd.fill(date(30));
    await expect(review).toBeEnabled();
    expect(writes).toEqual([]);
    await enterPreview();
    await expect(dialog).toBeVisible();
    await expect(previewRow(first).locator('.gantt-new-dates')).toHaveText(`${date(25)}${date(26)}`);
    await expect(previewRow(second).locator('.gantt-new-dates')).toHaveText(`${date(24)}${date(30)}`);
    await checkStored([first, second, unchanged]);
    await button(dialog, '취소').click();
    await expect(dialog).toHaveCount(0);
    await expect(firstStart).toHaveValue(date(25));
    await expect(secondEnd).toHaveValue(date(30));
    expect(writes).toEqual([manualPreview]);

    const preview = await enterPreview();
    const { users: [, peer] } = await workspace(request);
    const peerTitle = `동료가 바꾼 업무 ${randomUUID()}`;
    const remote = await json<Issue>(await request.patch(`/api/issues/${first.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: first.version, title: peerTitle, endDate: date(30) },
    }));
    const staleAttempt = nextPost(page, manualApply);
    await apply.click();
    const staleResponse = await staleAttempt;
    expect(staleResponse.status()).toBe(409);
    expect(staleResponse.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    await expect(apply).toBeDisabled();
    await expect(firstStart).toHaveAttribute('aria-invalid', 'true');
    await expect(search).toHaveValue(data.prefix);
    await expect(chart.row(first)).toContainText(peerTitle);
    await expect(chart.row(first).getByText('현재 보기 조건 밖 · 날짜 입력 유지', { exact: true })).toBeVisible();
    await expect(firstStart).toHaveValue(date(25));
    await expect(secondEnd).toHaveValue(date(30));
    await checkStored([remote, second, unchanged]);

    const renewed = nextPost(page, manualPreview);
    await button(dialog, '다시 미리보기').click();
    const renewedResponse = await renewed;
    expect(renewedResponse.request().postDataJSON()).toEqual({ changes: expect.arrayContaining([
      { ...initialChanges[0], expectedVersion: remote.version, endDate: date(30) }, initialChanges[1],
    ]) });
    expect(renewedResponse.request().postDataJSON().changes).toHaveLength(2);
    const renewedPreview = await json<SchedulePreview>(renewedResponse);
    expect(renewedPreview.previewId).toBeTruthy();
    await expect(previewRow(first).locator('.gantt-new-dates')).toHaveText(`${date(25)}${date(30)}`);
    await expect(previewRow(second).locator('.gantt-new-dates')).toHaveText(`${date(24)}${date(30)}`);
    await checkStored([remote, second, unchanged]);

    let savedBeforeTimeout: SchedulePasteApplyResult | undefined;
    await page.route(`**${manualApply}`, async route => {
      savedBeforeTimeout = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.fulfill({ status: 408, json: { error: '합성 응답 시간 초과' } });
    }, { times: 1 });
    const uncertainAttempt = nextPost(page, manualApply);
    await apply.click();
    const timedOut = await uncertainAttempt;
    expect(timedOut.status()).toBe(408);
    expect(timedOut.request().postDataJSON()).toEqual({ previewId: renewedPreview.previewId });
    const recover = button(dialog, '적용 결과 다시 확인');
    await expect(recover).toBeEnabled();
    await expect(firstStart).toHaveValue(date(25));
    await expect(secondEnd).toHaveValue(date(30));
    await expect(button(chart.row(first), `${first.key} 날짜 저장`)).toHaveCount(1);
    await expect(button(chart.row(second), `${second.key} 날짜 저장`)).toHaveCount(1);
    expect(savedBeforeTimeout?.updated).toHaveLength(2);
    await checkStored([...savedBeforeTimeout!.updated, unchanged]);

    const confirmation = nextPost(page, manualApply);
    await recover.click();
    const appliedResponse = await confirmation;
    expect(appliedResponse.request().postDataJSON()).toEqual({ previewId: renewedPreview.previewId });
    const receipt = await json<SchedulePasteApplyResult>(appliedResponse);
    expect(receipt).toEqual(savedBeforeTimeout);
    expect(receipt.updated).toHaveLength(2);
    expect(receipt.updated).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, title: peerTitle, version: remote.version + 1, startDate: date(25), endDate: date(30) }),
      expect.objectContaining({ id: second.id, version: second.version + 1, startDate: date(24), endDate: date(30) }),
    ]));
    await expect(dialog).toHaveCount(0);
    await expect(review).toHaveCount(0);
    await expect(search).toHaveValue(data.prefix);
    await expect(chart.row(first)).toHaveCount(0);
    await expect(button(chart.row(second), `${second.key} 날짜 저장`)).toHaveCount(0);
    await expect(secondEnd).toHaveValue(date(30));
    await checkStored([...receipt.updated, unchanged]);

    const pendingUndo = nextPost(page, undoPath);
    await button(page, '되돌리기').click();
    const undo = await pendingUndo;
    expect(undo.request().postDataJSON()).toEqual({ undoId: receipt.undoId });
    const undone = await json<{ updated: Issue[] }>(undo);
    expect(undone.updated).toHaveLength(2);
    await expect(secondEnd).toHaveValue(date(27));
    await expect(chart.row(first)).toHaveCount(0);
    await search.fill(peerTitle);
    await expect(firstStart).toHaveValue(date(23));
    await expect(chart.end(first)).toHaveValue(date(30));
    const { issues } = await workspace(request);
    expect(issues.find(issue => issue.id === first.id)).toMatchObject({ title: peerTitle, startDate: date(23), endDate: date(30) });
    expect(issues.find(issue => issue.id === second.id)).toMatchObject({ startDate: date(24), endDate: date(27) });
    expect(issues.find(issue => issue.id === unchanged.id)).toEqual(unchanged);
    expect(writes).toEqual([manualPreview, manualPreview, manualApply, manualPreview, manualApply, manualApply, undoPath]);
  } finally { await data.close(); }
});

test('간트를 다시 불러와도 날짜 초안을 유지하고 확인한 변경과 취소한 변경을 정리한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const first = await data.issue(data.first, '시작일이 겹치는 업무', date(23), date(26));
    const second = await data.issue(data.second, '제목이 바뀌는 업무', date(24), date(27));
    const { users: [, peer] } = await workspace(request);
    const headers = { 'X-Actor-Id': peer.id };
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '?scope=team');
    const writes = scheduleWrites(page);
    const review = button(page, '입력한 날짜 2건 검토');
    const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const firstStart = chart.start(first), secondEnd = chart.end(second);

    async function checkStored(expected: Issue[]) {
      const { issues } = await workspace(request);
      for (const issue of expected) expect(issues.find(value => value.id === issue.id)).toEqual(issue);
    }

    await firstStart.fill(date(25));
    await secondEnd.fill(date(30));
    await expect(review).toBeEnabled();
    await checkStored([first, second]);
    expect(writes).toEqual([]);

    const peerTitle = `${data.prefix} 동료가 수정한 제목`;
    const peerUpdates: Issue[] = [];
    await page.route('**/api/workspace', async route => {
      try {
        peerUpdates.push(...await Promise.all([
          request.patch(`/api/issues/${first.id}`, { headers, data: { expectedVersion: first.version, startDate: date(24) } }).then(response => json<Issue>(response)),
          request.patch(`/api/issues/${second.id}`, { headers, data: { expectedVersion: second.version, title: peerTitle } }).then(response => json<Issue>(response)),
        ]));
      } finally { await route.continue(); }
    }, { times: 1 });
    await reloadChart(page, data.prefix);
    expect(peerUpdates).toHaveLength(2);
    const [peerFirst, peerSecond] = peerUpdates;
    await expect(firstStart).toHaveValue(date(25));
    await expect(secondEnd).toHaveValue(date(30));
    await expect(review).toBeEnabled();
    await expect(chart.row(second)).toContainText(peerTitle);
    expect(writes).toEqual([]);

    await button(chart.row(first), `${first.key} 일정과 연결 편집`).click();
    await expect(editor.getByLabel('시작일', { exact: true })).toHaveValue(date(25));
    await expect(editor.getByLabel('시작일', { exact: true })).toHaveAccessibleDescription(`현재 저장값 ${date(24)}`);
    await button(editor, '일정과 연결 편집 닫기').click();
    await button(chart.row(first), `${first.key} 날짜 변경 취소`).click();
    await expect(firstStart).toHaveValue(date(24));
    await reloadChart(page, data.prefix);
    await expect(firstStart).toHaveValue(date(24));
    await expect(button(chart.row(first), `${first.key} 날짜 저장`)).toHaveCount(0);
    await expect(secondEnd).toHaveValue(date(30));
    expect(writes).toEqual([]);

    await button(chart.row(second), `${second.key} 일정과 연결 편집`).click();
    await expect(editor).toContainText(peerTitle);
    await expect(editor.getByLabel('종료일', { exact: true })).toHaveValue(date(30));
    await expect(button(editor, '종료일 저장값 사용')).toHaveCount(0);
    const previewRequest = nextPost(page, rowPreview);
    await button(editor, '변경 미리보기').click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toEqual({
      projectId: second.projectId, issue: { id: second.id, expectedVersion: peerSecond.version }, changes: { endDate: date(30) },
    });
    const preview = await json<SchedulePastePreview>(previewResponse);
    await checkStored([peerFirst, peerSecond]);
    expect(writes).toEqual([rowPreview]);

    const applyRequest = nextPost(page, rowApply);
    await button(editor, '일정과 연결 적용').click();
    const response = await applyRequest;
    expect(response.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    const receipt = await json<SchedulePasteApplyResult>(response);
    expect(receipt.updated).toMatchObject([
      { id: second.id, version: peerSecond.version + 1, title: peerTitle, startDate: date(24), endDate: date(30) },
    ]);
    await expect(editor).toHaveCount(0);
    await reloadChart(page, data.prefix);
    await expect(firstStart).toHaveValue(date(24));
    await expect(secondEnd).toHaveValue(date(30));
    await expect(button(chart.row(second), `${second.key} 날짜 저장`)).toHaveCount(0);
    await checkStored([peerFirst, receipt.updated[0]]);
    expect(writes).toEqual([rowPreview, rowApply]);
  } finally { await data.close(); }
});

test('저장 응답을 받지 못한 간트 날짜는 새로고침 뒤 서버의 최신값으로 정리된다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const issue = await data.issue(data.first, '저장 결과 확인 업무', date(23), date(26));
    const { users: [, peer] } = await workspace(request);
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '');
    const writes = scheduleWrites(page);
    const start = chart.start(issue);
    const save = button(chart.row(issue), `${issue.key} 날짜 저장`);
    await start.fill(date(25));

    let serverReceipt: SchedulePasteApplyResult | undefined;
    await page.route(`**${manualApply}`, async route => {
      serverReceipt = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.fulfill({ status: 408, json: { error: '합성 응답 시간 초과' } });
    }, { times: 1 });
    const applyRequest = nextPost(page, manualApply);
    await save.click();
    expect((await applyRequest).status()).toBe(408);
    await expect(button(page, '적용 결과 다시 확인')).toBeVisible();
    await expect(start).toHaveValue(date(25));
    await expect(save).toHaveCount(1);
    expect(serverReceipt?.updated).toMatchObject([
      { id: issue.id, version: issue.version + 1, startDate: date(25), endDate: date(26) },
    ]);

    const peerIssue = await json<Issue>(await request.patch(`/api/issues/${issue.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: serverReceipt!.updated[0].version, endDate: date(30) },
    }));
    await reloadChart(page, data.prefix);
    await expect(start).toHaveValue(date(25));
    await expect(chart.end(issue)).toHaveValue(date(30));
    await expect(save).toHaveCount(0);
    await expect(button(page, '적용 결과 다시 확인')).toHaveCount(0);
    expect((await workspace(request)).issues.find(value => value.id === issue.id)).toEqual(peerIssue);
    expect(writes).toEqual([manualPreview, manualApply]);
  } finally { await data.close(); }
});

test('같은 작업자의 두 간트 탭은 같은 업무의 날짜 초안을 따로 유지한다', async ({ context, page, request }) => {
  const data = await fixture(request);
  const other = await context.newPage();
  try {
    const issue = await data.issue(data.first, '탭별 초안 업무', date(23), date(26));
    const firstChart = await openChart(page, data.first, data.actor.id, data.prefix, '');
    const secondChart = await openChart(other, data.first, data.actor.id, data.prefix, '');
    const firstStart = firstChart.start(issue);
    const secondStart = secondChart.start(issue);
    const firstWrites = scheduleWrites(page), secondWrites = scheduleWrites(other);
    await expect(firstStart).toHaveValue(date(23));
    await expect(secondStart).toHaveValue(date(23));
    await firstStart.fill(date(24));
    await secondStart.fill(date(25));

    await reloadChart(page, data.prefix);
    await expect(firstStart).toHaveValue(date(24));
    await button(firstChart.row(issue), `${issue.key} 날짜 변경 취소`).click();
    await reloadChart(page, data.prefix);
    await expect(firstStart).toHaveValue(date(23));
    await reloadChart(other, data.prefix);
    await expect(secondStart).toHaveValue(date(25));
    await expect(button(secondChart.row(issue), `${issue.key} 날짜 저장`)).toBeVisible();
    expect((await workspace(request)).issues.find(value => value.id === issue.id)).toEqual(issue);
    expect(firstWrites).toEqual([]);
    expect(secondWrites).toEqual([]);
  } finally {
    await other.close();
    await data.close();
  }
});

test('전체 프로젝트 간트에서 날짜 초안을 같은 행의 연결 편집에 이어 쓰고 적용할 때 함께 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const otherProject = await data.issue(data.first, '다른 프로젝트 업무', date(20), date(20));
    const predecessor = await data.issue(data.second, '선행 업무', date(19), date(20));
    const anchor = await data.issue(data.second, '날짜와 연결을 함께 검토할 업무', date(23), date(26));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '?scope=team');
    const writes = scheduleWrites(page);
    const start = chart.start(anchor), end = chart.end(anchor);
    await start.fill(date(24));
    await end.fill(date(27));
    const opener = button(chart.row(anchor), `${anchor.key} 일정과 연결 편집`);
    const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const editorStart = editor.getByLabel('시작일', { exact: true });
    const editorEnd = editor.getByLabel('종료일', { exact: true });
    await opener.click();
    await expect(editorStart).toHaveValue(date(24));
    await expect(editorEnd).toHaveValue(date(27));
    expect(writes).toEqual([]);
    expect((await workspace(request)).issues.find(issue => issue.id === anchor.id)).toEqual(anchor);

    await editorEnd.fill(date(30));
    const close = button(editor, '일정과 연결 편집 닫기');
    const discardEditor = page.waitForEvent('dialog', { timeout: 5_000 }).then(async confirmation => {
      const message = confirmation.message();
      await confirmation.accept();
      expect(message).toContain('버리고 닫을까요');
    });
    await Promise.all([discardEditor, close.click()]);
    await expect(editor).toHaveCount(0);
    await expect(start).toHaveValue(date(24));
    await expect(end).toHaveValue(date(27));
    expect(writes).toEqual([]);

    await opener.press('Enter');
    await expect(editorStart).toHaveValue(date(24));
    await expect(editorEnd).toHaveValue(date(27));
    const group = editor.getByRole('group', { name: '연결 변경 1', exact: true });
    await group.getByLabel('선후행 연결 작업', { exact: true }).selectOption('add');
    const lookup = group.getByRole('textbox', { name: '연결할 업무 검색', exact: true });
    await lookup.fill(data.prefix);
    await expect(button(group, `${otherProject.key} · ${otherProject.title}`)).toHaveCount(0);
    await button(group, `${predecessor.key} · ${predecessor.title}`).click();
    await group.getByLabel('연결 방향', { exact: true }).selectOption('predecessor');
    await group.getByLabel('연결 유형', { exact: true }).selectOption('FS');

    const previewRequest = nextPost(page, rowPreview);
    await button(editor, '변경 미리보기').click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toMatchObject({
      projectId: data.second.id, issue: { id: anchor.id, expectedVersion: anchor.version },
      changes: { startDate: date(24), endDate: date(27) }, dependency: {
        action: 'add', direction: 'predecessor', type: 'FS', relatedIssue: { id: predecessor.id, expectedVersion: predecessor.version },
      },
    });
    const preview = await json<SchedulePastePreview>(previewResponse);
    expect(preview.errors).toEqual([]);
    expect((await workspace(request)).issues.find(issue => issue.id === anchor.id)).toEqual(anchor);
    const applyRequest = nextPost(page, rowApply);
    await button(editor, '일정과 연결 적용').click();
    const applyResponse = await applyRequest;
    expect(applyResponse.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    const applied = await json<SchedulePasteApplyResult>(applyResponse);
    expect(applied.updated).toMatchObject([{ id: anchor.id, version: anchor.version + 1, startDate: date(24), endDate: date(27) }]);
    await expect(editor).toHaveCount(0);
    await expect(start).toHaveValue(date(24));
    await expect(end).toHaveValue(date(27));
    await expect(button(chart.row(anchor), `${anchor.key} 날짜 저장`)).toHaveCount(0);
    const teamFilters = new URLSearchParams({ scope: 'team', ganttQ: data.prefix });
    await expect(page).toHaveURL(url => url.hash === `#/${data.first.id}/gantt?${teamFilters}`);
    const after = await workspace(request);
    expect(after.issues.find(issue => issue.id === anchor.id)).toEqual(applied.updated[0]);
    expect(after.issues.find(issue => issue.id === otherProject.id)).toEqual(otherProject);
    expect(after.dependencies.filter(link => link.successorId === anchor.id)).toMatchObject([
      { predecessorId: predecessor.id, successorId: anchor.id, type: 'FS', lagDays: 0 },
    ]);
    expect(writes).toEqual([rowPreview, rowApply]);
  } finally { await data.close(); }
});

test('날짜 초안을 연결 편집으로 넘길 때 다른 작업자가 저장한 필드도 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const anchor = await data.issue(data.second, '날짜 변경이 겹친 업무', date(23), date(26));
    const otherRow = await data.issue(data.first, '같이 보이는 업무', date(24), date(27));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '?scope=team');
    const start = chart.start(anchor);
    await start.fill(date(24));
    const { users: [, peer] } = await workspace(request);
    const remote = await json<Issue>(await request.patch(`/api/issues/${anchor.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: anchor.version, endDate: date(30) },
    }));

    await chart.end(otherRow).fill(date(30));
    const refreshRequest = nextPost(page, manualApply);
    await button(chart.row(otherRow), `${otherRow.key} 날짜 저장`).click();
    await json<SchedulePasteApplyResult>(await refreshRequest);
    await expect(start).toHaveAttribute('aria-invalid', 'true');
    await expect(start).toHaveValue(date(24));

    await button(chart.row(anchor), `${anchor.key} 일정과 연결 편집`).click();
    const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    await expect(editor.getByRole('status').filter({ hasText: '업무가 변경됐습니다' })).toBeVisible();
    await expect(editor.getByLabel('시작일', { exact: true })).toHaveValue(date(24));
    await expect(editor.getByLabel('종료일', { exact: true })).toHaveValue(date(30));

    const previewRequest = nextPost(page, rowPreview);
    await button(editor, '변경 미리보기').click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toEqual({
      projectId: anchor.projectId,
      issue: { id: anchor.id, expectedVersion: remote.version },
      changes: { startDate: date(24) },
    });
    const preview = await json<SchedulePastePreview>(previewResponse);
    expect(preview.errors).toEqual([]);
    const applyRequest = nextPost(page, rowApply);
    await button(editor, '일정과 연결 적용').click();
    const applied = await json<SchedulePasteApplyResult>(await applyRequest);
    expect(applied.updated).toMatchObject([{ id: anchor.id, version: remote.version + 1, startDate: date(24), endDate: date(30) }]);
    await expect(editor).toHaveCount(0);
    await expect(chart.end(anchor)).toHaveValue(date(30));
    expect((await workspace(request)).issues.find(issue => issue.id === anchor.id)).toEqual(applied.updated[0]);
  } finally { await data.close(); }
});
