import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Dependency, DependencyType, Issue, IssueRelation, SchedulePasteApplyResult, SchedulePastePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/row-edit/preview';
const applyPath = '/api/schedule/row-edit/apply';
const day = (number: number) => `2026-11-${String(number).padStart(2, '0')}`;
const issueDates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const button = (parent: Page | Locator, name: string) => parent.getByRole('button', { name, exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

function waitPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function fixture(request: APIRequestContext, holiday = day(23)) {
  const { projects: [project, otherProject], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const ids: string[] = [];
  const calendarPath = `/api/projects/${project.id}/calendar`;
  const originalCalendar = await json<WorkCalendar>(await request.get(calendarPath));
  const calendar = await json<WorkCalendar>(await request.patch(calendarPath, { headers, data: {
    ...originalCalendar, expectedVersion: originalCalendar.version, workingWeekdays: [1, 2, 3, 4, 5],
    exceptions: [{ date: holiday, isWorking: false, label: '합성 월요일 휴무' }],
  } }));

  return {
    actor, peer, otherProject,
    async issue(title: string, dates: Partial<ReturnType<typeof issueDates>> = {}, projectId = project.id) {
      const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
        projectId, title: `${title} ${suffix}`, ...dates,
      } }), 201);
      ids.push(issue.id);
      return issue;
    },
    async link(predecessor: Issue, successor: Issue, type: DependencyType, lagDays: number) {
      return json<Dependency>(await request.post('/api/dependencies', { headers, data: {
        predecessorId: predecessor.id, successorId: successor.id, type, lagDays,
      } }), 201);
    },
    async current(issue: Issue) {
      const current = await workspace(request);
      return { issue: current.issues.find(value => value.id === issue.id)!, links: current.dependencies.filter(link =>
        link.predecessorId === issue.id || link.successorId === issue.id) };
    },
    async clean() {
      try {
        for (const id of ids.reverse()) {
          const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${id}`, { headers }));
          expect((await request.delete(`/api/trash/${trashEntryId}`, { headers })).ok()).toBeTruthy();
        }
      } finally {
        await json<WorkCalendar>(await request.patch(calendarPath, { headers, data: {
          ...originalCalendar, expectedVersion: calendar.version,
        } }));
      }
    },
  };
}

async function openProposal(page: Page, issue: Issue, actorId: string, team = false) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  const query = team ? `?${new URLSearchParams({ scope: 'team', ganttProject: issue.projectId })}` : '';
  await page.goto(`/#/${issue.projectId}/gantt${query}`);
  const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  await expect(search).toBeVisible({ timeout: 35_000 });
  await search.fill(issue.title);
  const row = page.locator('.gantt-unscheduled-row').filter({ hasText: issue.title });
  const opener = button(row, '연결 기준으로 일정 제안');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
  await expect(dialog.getByRole('heading', { name: '선후행 연결로 날짜 제안', exact: true })).toBeVisible();
  const proposal = dialog.getByLabel('제안 날짜 범위', { exact: true });
  const length = dialog.getByLabel('제안 근무일 수', { exact: true });
  return { search, row, dialog, proposal, length };
}

async function openTicketScheduleEditor(page: Page, issue: Issue) {
  const search = new URLSearchParams({ boardQuery: issue.title });
  await page.goto(`/#/${issue.projectId}/teamboard?${search}`);
  const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
  const opener = button(board, `${issue.key} 업무 열기`);
  await expect(opener).toBeVisible({ timeout: 35_000 });
  await opener.click();
  const detail = page.getByRole('dialog', { name: issue.title, exact: true });
  await button(detail, '일정과 연결 편집').click();
  return { detail, editor: page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true }) };
}

test('360px 팀 간트에서 다른 프로젝트의 숨은 차단 업무와 후행 달력에 맞춰 빈 날짜를 다시 계산한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request, '2027-11-22');
  try {
    const source = await f.issue('팀 간트 검색에서 가려질 다른 프로젝트 차단 업무', {
      startDate: '2027-11-18', endDate: '2027-11-19',
    }, f.otherProject.id);
    const target = await f.issue('종료일을 유지하는 프로젝트 간 차단 대상', { endDate: '2027-11-26', dueDate: '2027-11-29' });
    const relation = await json<IssueRelation>(await request.post(`/api/issues/${source.id}/relations`, {
      headers: { 'X-Actor-Id': f.actor.id }, data: { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' },
    }), 201);
    const { search, row, dialog, proposal, length } = await openProposal(page, target, f.actor.id, true);
    await expect(page.locator(`[data-issue-id="${source.id}"]`)).toHaveCount(0);
    const start = dialog.getByLabel('시작일', { exact: true });
    const end = dialog.getByLabel('종료일', { exact: true });
    const due = dialog.getByLabel('목표 마감일', { exact: true });
    const useDates = button(dialog, '제안 날짜 입력');
    const review = button(dialog, '변경 미리보기');
    const apply = button(dialog, '일정과 연결 적용');

    await length.fill('5');
    await expect(dialog.getByText(`${source.key} 선행 조건에 따라 시작일은 2027-11-23 이후여야 합니다.`, { exact: true })).toBeVisible();
    await expect(useDates).toBeDisabled();
    await length.fill('4');
    await expect(proposal).toHaveText('2027-11-23 ~ 2027-11-26');
    await useDates.click();
    await expect(start).toHaveValue('2027-11-23');
    await expect(end).toHaveValue('2027-11-26');
    await expect(due).toHaveValue('2027-11-29');
    await due.fill('2027-11-30');

    const pendingPreview = waitPost(page, previewPath);
    await review.click();
    const response = await pendingPreview;
    expect(response.request().postDataJSON()).toMatchObject({
      issue: { id: target.id, expectedVersion: target.version }, changes: { startDate: '2027-11-23', dueDate: '2027-11-30' },
      reviewIncomingTeamBlockers: true,
    });
    expect(await json<SchedulePastePreview>(response)).toMatchObject({ previewId: expect.any(String), errors: [] });
    expect(issueDates((await f.current(target)).issue)).toEqual(issueDates(target));

    const changedSource = await json<Issue>(await request.patch(`/api/issues/${source.id}`, {
      headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: source.version, endDate: '2027-11-24' },
    }));
    const pendingConflict = waitPost(page, applyPath);
    await apply.click();
    expect((await pendingConflict).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('날짜와 연결 입력을 유지했습니다.');
    await expect(start).toHaveValue('2027-11-23');
    await expect(end).toHaveValue('2027-11-26');
    await expect(due).toHaveValue('2027-11-30');
    expect(issueDates((await f.current(target)).issue)).toEqual(issueDates(target));

    await button(dialog, '최신 업무 불러오기').click();
    await button(dialog, '제안 날짜 다시 계산').click();
    await expect(start).toHaveValue('');
    await expect(end).toHaveValue('2027-11-26');
    await expect(length).toHaveValue('4');
    await expect(due).toHaveValue('2027-11-30');
    await length.fill('3');
    await expect(dialog.getByText(`${source.key} 선행 조건에 따라 시작일은 2027-11-25 이후여야 합니다.`, { exact: true })).toBeVisible();
    await expect(useDates).toBeDisabled();
    await length.fill('2');
    await expect(proposal).toHaveText('2027-11-25 ~ 2027-11-26');
    await useDates.click();

    const pendingNewPreview = waitPost(page, previewPath);
    await review.click();
    const latest = await pendingNewPreview;
    expect(latest.request().postDataJSON()).toMatchObject({
      changes: { startDate: '2027-11-25', dueDate: '2027-11-30' }, reviewIncomingTeamBlockers: true,
    });
    expect(await json<SchedulePastePreview>(latest)).toMatchObject({ previewId: expect.any(String), errors: [] });
    const pendingApply = waitPost(page, applyPath);
    await apply.click();
    expect((await json<SchedulePasteApplyResult>(await pendingApply)).updated.map(issue => issue.id)).toEqual([target.id]);
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(search).toHaveValue(target.title);
    expect(await f.current(target)).toMatchObject({ issue: { startDate: '2027-11-25', endDate: target.endDate, dueDate: '2027-11-30' }, links: [] });
    expect((await f.current(source)).issue).toEqual(changedSource);
    expect(await json<IssueRelation[]>(await request.get(`/api/issues/${target.id}/relations`))).toEqual(expect.arrayContaining([expect.objectContaining({ id: relation.id })]));

    const pendingUndo = waitPost(page, '/api/schedule/undo');
    await button(page, '되돌리기').click();
    await json<SchedulePasteApplyResult>(await pendingUndo);
    await expect(button(row, '연결 기준으로 일정 제안')).toBeVisible();
    expect(issueDates((await f.current(target)).issue)).toEqual(issueDates(target));

    const { editor } = await openTicketScheduleEditor(page, target);
    const suggestion = editor.getByRole('region', { name: '선후행 연결로 날짜 제안', exact: true });
    await expect(suggestion).toContainText(`${source.key} 선행 조건에 따라 시작일은 2027-11-25 이후여야 합니다.`);
    await suggestion.getByLabel('제안 근무일 수', { exact: true }).fill('2');
    await expect(suggestion.getByLabel('제안 날짜 범위', { exact: true })).toHaveText('2027-11-25 ~ 2027-11-26');
  } finally {
    await f.clean();
  }
});

test('360px에서 숨은 선행 업무와 휴무일을 반영해 빈 날짜만 제안하고 재검토와 되돌리기를 지원한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    const fs = await f.issue('검색에서 가려질 FS 선행 업무', { startDate: day(19), endDate: day(20) });
    const ff = await f.issue('검색에서 가려질 FF 선행 업무', { startDate: day(24), endDate: day(26) });
    const anchor = await f.issue('종료일을 유지하는 일정 제안', { endDate: day(27), dueDate: day(30) });
    const firstLink = await f.link(fs, anchor, 'FS', 0);
    const secondLink = await f.link(ff, anchor, 'FF', 1);
    const { search, row, dialog, proposal, length } = await openProposal(page, anchor, f.actor.id);
    for (const issue of [fs, ff]) await expect(page.locator(`[data-issue-id="${issue.id}"]`)).toHaveCount(0);
    const start = dialog.getByLabel('시작일', { exact: true });
    const end = dialog.getByLabel('종료일', { exact: true });
    const due = dialog.getByLabel('목표 마감일', { exact: true });
    const review = button(dialog, '변경 미리보기');
    const apply = button(dialog, '일정과 연결 적용');
    const useDates = button(dialog, '제안 날짜 입력');

    await expect(length).toHaveValue('3');
    await expect(proposal).toContainText(day(25));
    await expect(proposal).toContainText(day(27));
    await length.fill('5');
    await expect(dialog.getByText(`${fs.key} 선행 조건에 따라 시작일은 ${day(24)} 이후여야 합니다.`, { exact: true })).toBeVisible();
    await expect(useDates).toBeDisabled();
    await length.fill('4');
    await expect(proposal).toContainText(day(24));
    await expect(start).toHaveValue('');
    await expect(end).toHaveValue(day(27));
    await expect(apply).toBeDisabled();
    await useDates.click();
    await expect(start).toHaveValue(day(24));
    await expect(end).toHaveValue(day(27));
    await expect(due).toHaveValue(day(30));
    await expect(apply).toBeDisabled();
    expect(issueDates((await f.current(anchor)).issue)).toEqual(issueDates(anchor));

    const pendingFirst = waitPost(page, previewPath);
    await review.click();
    const firstResponse = await pendingFirst;
    expect(firstResponse.request().postDataJSON()).toEqual({
      projectId: anchor.projectId, issue: { id: anchor.id, expectedVersion: anchor.version }, changes: { startDate: day(24) },
      reviewIncomingTeamBlockers: true,
    });
    const first = await json<SchedulePastePreview>(firstResponse);
    expect(first).toMatchObject({ previewId: expect.any(String), warnings: [], errors: [] });
    expect(issueDates((await f.current(anchor)).issue)).toEqual(issueDates(anchor));

    const changedLink = await json<Dependency>(await request.patch(`/api/dependencies/${secondLink.id}`, {
      headers: { 'X-Actor-Id': f.peer.id }, data: { expectedVersion: secondLink.version ?? 1, lagDays: 0 },
    }));
    const pendingConflict = waitPost(page, applyPath);
    await apply.click();
    expect((await pendingConflict).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('날짜와 연결 입력을 유지했습니다.');
    await expect(start).toHaveValue(day(24));
    await expect(end).toHaveValue(day(27));
    expect(issueDates((await f.current(anchor)).issue)).toEqual(issueDates(anchor));

    await button(dialog, '최신 업무 불러오기').click();
    await expect(review).toBeEnabled();
    const pendingSecond = waitPost(page, previewPath);
    await review.click();
    const second = await json<SchedulePastePreview>(await pendingSecond);
    expect(second.previewId).toBeTruthy();
    expect(second.previewId).not.toBe(first.previewId);
    const pendingApply = waitPost(page, applyPath);
    await apply.click();
    const saved = await json<SchedulePasteApplyResult>(await pendingApply);
    expect(saved.updated.map(issue => issue.id)).toEqual([anchor.id]);
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(search).toHaveValue(anchor.title);
    await expect(page.getByLabel(`${anchor.key} 시작일`, { exact: true })).toHaveValue(day(24));
    const committed = await f.current(anchor);
    expect(issueDates(committed.issue)).toEqual({ startDate: day(24), endDate: day(27), dueDate: day(30) });
    expect(committed.links).toHaveLength(2);
    expect(committed.links).toEqual(expect.arrayContaining([firstLink, changedLink]));

    const pendingUndo = waitPost(page, '/api/schedule/undo');
    await button(page, '되돌리기').click();
    await json<SchedulePasteApplyResult>(await pendingUndo);
    await expect(button(row, '연결 기준으로 일정 제안')).toBeVisible();
    expect(issueDates((await f.current(anchor)).issue)).toEqual(issueDates(anchor));
  } finally {
    await f.clean();
  }
});

test('날짜가 모두 비어 있으면 숨은 FS와 FF의 날짜를 종합하고 날짜 미정 후행 업무를 표시한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    const fs = await f.issue('시작일 하한이 있는 선행 업무', { startDate: day(19), endDate: day(20) });
    const ff = await f.issue('종료일 하한이 있는 선행 업무', { startDate: day(24), endDate: day(26) });
    const anchor = await f.issue('시작일과 종료일을 같이 제안하는 업무');
    const successor = await f.issue('날짜 미정 후행 업무');
    await f.link(fs, anchor, 'FS', 0);
    await f.link(ff, anchor, 'FF', 1);
    await f.link(anchor, successor, 'FS', 0);
    await page.clock.setFixedTime(new Date('2026-11-19T12:00:00.000Z'));
    const { dialog, proposal, length } = await openProposal(page, anchor, f.actor.id);
    await expect(proposal).toContainText(day(25));
    await expect(proposal).toContainText(day(27));
    await expect(dialog.getByText(`날짜 확인이 필요한 연결 · ${successor.key}`, { exact: true })).toBeVisible();
    await length.fill('4');
    await expect(proposal).toContainText(day(24));
    await expect(proposal).toContainText(day(27));
    await button(dialog, '제안 날짜 입력').click();
    await expect(dialog.getByLabel('시작일', { exact: true })).toHaveValue(day(24));
    await expect(dialog.getByLabel('종료일', { exact: true })).toHaveValue(day(27));

    const pendingPreview = waitPost(page, previewPath);
    await button(dialog, '변경 미리보기').click();
    expect(await json<SchedulePastePreview>(await pendingPreview)).toMatchObject({ previewId: expect.any(String), errors: [] });
    expect(issueDates((await f.current(anchor)).issue)).toEqual(issueDates(anchor));
    const pendingApply = waitPost(page, applyPath);
    await button(dialog, '일정과 연결 적용').click();
    expect((await json<SchedulePasteApplyResult>(await pendingApply)).updated.map(issue => issue.id)).toEqual([anchor.id]);
    await expect(dialog).toHaveCount(0);
    expect(issueDates((await f.current(anchor)).issue)).toEqual({ startDate: day(24), endDate: day(27), dueDate: null });
    expect(issueDates((await f.current(successor)).issue)).toEqual(issueDates(successor));
  } finally {
    await f.clean();
  }
});

test('티켓 상세에서 연결 해제와 변경 초안을 날짜 제안에 반영해 함께 적용한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  try {
    const anchor = await f.issue('티켓에서 날짜와 연결을 함께 수정하는 업무', { endDate: day(27) });
    const blocking = await f.issue('연결을 해제할 선행 업무', { startDate: day(24), endDate: day(25) });
    const revised = await f.issue('연결 유형을 수정할 선행 업무', { startDate: day(24), endDate: day(26) });
    const removed = await f.link(blocking, anchor, 'FS', 0);
    const updated = await f.link(revised, anchor, 'FF', 2);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    const { detail, editor } = await openTicketScheduleEditor(page, anchor);
    const suggestion = editor.getByRole('region', { name: '선후행 연결로 날짜 제안', exact: true });
    const range = suggestion.getByLabel('제안 날짜 범위', { exact: true });
    const count = suggestion.getByLabel('제안 근무일 수', { exact: true });
    const useDates = button(suggestion, '제안 날짜 입력');
    await expect(suggestion).toContainText(`${blocking.key} 선행 조건에 따라 시작일은 ${day(26)} 이후여야 합니다.`);
    await expect(suggestion).toContainText(`${revised.key} 선행 조건에 따라 종료일은 ${day(30)} 이후여야 합니다.`);
    await expect(useDates).toBeDisabled();

    const remove = editor.getByRole('group', { name: '연결 변경 1', exact: true });
    await remove.getByLabel('선후행 연결 작업', { exact: true }).selectOption('remove');
    await remove.getByLabel('편집할 연결', { exact: true }).selectOption(removed.id);
    await expect(suggestion).not.toContainText(blocking.key);
    await expect(suggestion).toContainText(revised.key);
    await button(editor, '연결 변경 추가').click();
    const update = editor.getByRole('group', { name: '연결 변경 2', exact: true });
    await update.getByLabel('선후행 연결 작업', { exact: true }).selectOption('update');
    await update.getByLabel('편집할 연결', { exact: true }).selectOption(updated.id);
    await update.getByLabel('연결 유형', { exact: true }).selectOption('SS');
    await update.getByLabel('간격 (근무일)', { exact: true }).fill('1');

    await count.fill('4');
    await expect(suggestion).toContainText(`${revised.key} 선행 조건에 따라 시작일은 ${day(25)} 이후여야 합니다.`);
    await expect(useDates).toBeDisabled();
    await count.fill('3');
    await expect(range).toContainText(day(25));
    await expect(range).toContainText(day(27));
    await useDates.click();
    await expect(editor.getByLabel('시작일', { exact: true })).toHaveValue(day(25));
    await expect(editor.getByLabel('종료일', { exact: true })).toHaveValue(day(27));

    const pendingPreview = waitPost(page, previewPath);
    await button(editor, '변경 미리보기').click();
    expect(await json<SchedulePastePreview>(await pendingPreview)).toMatchObject({
      errors: [], warnings: [], changes: [{ id: anchor.id, fromStart: null, toStart: day(25), toEnd: day(27) }],
      dependencyChanges: [
        { predecessorKey: blocking.key, before: { type: 'FS', lagDays: 0 }, after: null },
        { predecessorKey: revised.key, before: { type: 'FF', lagDays: 2 }, after: { type: 'SS', lagDays: 1 } },
      ],
    });
    expect(await f.current(anchor)).toMatchObject({ issue: { startDate: null }, links: expect.arrayContaining([removed, updated]) });
    const pendingApply = waitPost(page, applyPath);
    await button(editor, '일정과 연결 적용').click();
    expect(await json<SchedulePasteApplyResult>(await pendingApply)).toMatchObject({ dependencyChanges: 2,
      updated: [{ id: anchor.id, startDate: day(25), endDate: day(27) }] });
    await expect(editor).toHaveCount(0);
    await expect(detail.getByLabel('시작일', { exact: true })).toHaveValue(day(25));
    expect(await f.current(anchor)).toMatchObject({ issue: { startDate: day(25) }, links: [{ id: updated.id, type: 'SS', lagDays: 1 }] });

    const pendingUndo = waitPost(page, '/api/schedule/undo');
    await button(detail, '일정과 연결 되돌리기').click();
    expect(await json<SchedulePasteApplyResult>(await pendingUndo)).toMatchObject({ dependencyChanges: 2 });
    await expect(detail.getByLabel('시작일', { exact: true })).toHaveValue('');
    expect((await f.current(anchor)).links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: removed.id, type: 'FS', lagDays: 0 }),
      expect.objectContaining({ id: updated.id, type: 'FF', lagDays: 2 }),
    ]));
  } finally {
    await f.clean();
  }
});
