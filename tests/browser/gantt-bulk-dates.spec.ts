import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Dependency, Issue, ScheduleBulkDateInput, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';

const previewRoute = '/api/schedule/bulk-dates/preview';
const applyRoute = '/api/schedule/bulk-dates/apply';
const undoRoute = '/api/schedule/undo';
const dialogName = '일정 일괄 편집';
const previewName = '날짜 변경 미리보기';
const applyName = '검토한 일정 적용';

type Dates = Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>;

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

async function workspace(request: APIRequestContext) {
  return readJson<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
}

const date = (day: number) => `2026-06-${String(day).padStart(2, '0')}`;

const values = ({ id, version, startDate, endDate, dueDate }: Issue) => ({ id, version, startDate, endDate, dueDate });

async function makeFixture(request: APIRequestContext) {
  const [firstProject, secondProject] = (await workspace(request)).projects;
  const projectId = firstProject.id;
  const prefix = `한꺼번에 변경 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  const links: Dependency[] = [];
  return {
    projectId, firstProject, secondProject, prefix,
    async create(title: string, dates: Dates, targetProjectId = projectId) {
      const issue = await readJson<Issue>(await request.post('/api/issues', { data: { projectId: targetProjectId, title, ...dates } }), 201);
      issues.push(issue);
      return issue;
    },
    async link(predecessor: Issue, successor: Issue) {
      const link = await readJson<Dependency>(await request.post('/api/dependencies', { data: {
        predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0,
      } }), 201);
      links.push(link);
    },
    async stored() {
      const byId = new Map((await workspace(request)).issues.map(issue => [issue.id, issue]));
      return issues.map(issue => values(byId.get(issue.id)!));
    },
    async close() {
      for (const link of links) await request.delete(`/api/dependencies/${link.id}`);
      for (const issue of issues) {
        const response = await request.delete(`/api/issues/${issue.id}`);
        if (response.ok()) {
          const archived = await response.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${archived.trashEntryId}`);
        }
      }
    },
  };
}

async function openChart(page: Page, projectId: string, prefix: string, team = false) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${projectId}/gantt${team ? '?scope=team' : ''}`);
  const search = page.getByLabel('간트 업무 검색', { exact: true });
  await expect(search).toBeVisible({ timeout: 35_000 });
  await search.fill(prefix);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  return {
    search, chart,
    open: page.getByRole('button', { name: dialogName, exact: true }),
    dialog: page.getByRole('dialog', { name: dialogName, exact: true }),
    selected: (issue: Issue) => chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }),
  };
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

function selection(issues: Issue[]) {
  return issues.map(({ id, version }) => ({ id, expectedVersion: version })).sort((a, b) => a.id.localeCompare(b.id));
}

test('360px 간트에서 보이는 선택 업무의 날짜만 검토하고 응답 유실 뒤 한 번 적용한 뒤 되돌린다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const fixture = await makeFixture(request);
  try {
    const prefix = `${fixture.prefix} 선택`;
    const first = await fixture.create(`${prefix} 첫 업무`, { startDate: date(1), endDate: date(4), dueDate: date(15) });
    const second = await fixture.create(`${prefix} 둘째 업무`, { startDate: date(2), endDate: date(5), dueDate: date(16) });
    const excluded = await fixture.create(`${fixture.prefix} 필터 밖 후행 업무`, { startDate: date(8), endDate: date(9), dueDate: date(18) });
    await fixture.link(first, excluded);
    const original = [first, second, excluded].map(values);
    const { search, chart, selected, open, dialog } = await openChart(page, fixture.projectId, fixture.prefix);
    await expect(open).toBeDisabled();
    for (const issue of [first, second, excluded]) await selected(issue).check();
    await search.fill(prefix);
    await expect(selected(excluded)).toHaveCount(0);
    await expect(selected(first)).toBeChecked();
    await expect(selected(second)).toBeChecked();
    await open.click();
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const start = dialog.getByLabel('시작일 변경', { exact: true });
    const end = dialog.getByLabel('종료일 변경', { exact: true });
    const due = dialog.getByLabel('목표 마감일 변경', { exact: true });
    await expect(start).toHaveValue('keep');
    await end.selectOption('set');
    const endValue = dialog.getByLabel('종료일 값', { exact: true });
    await endValue.fill(date(12));
    await due.selectOption('clear');

    const nextPreview = nextPost(page, previewRoute);
    await dialog.getByRole('button', { name: previewName, exact: true }).click();
    const previewResponse = await nextPreview;
    const preview = await readJson<SchedulePastePreview>(previewResponse, 200);
    const input = previewResponse.request().postDataJSON() as ScheduleBulkDateInput;
    expect(input.projectId).toBe(fixture.projectId);
    expect(input.issues.sort((a, b) => a.id.localeCompare(b.id))).toEqual(selection([first, second]));
    expect(input.changes).toEqual({ endDate: date(12), dueDate: null });
    expect(preview.previewId).toBeTruthy();
    expect(preview.errors).toEqual([]);
    expect(preview.changes).toHaveLength(2);
    for (const issue of [first, second]) {
      expect(preview.changes.find(change => change.id === issue.id)).toMatchObject({
        fromStart: issue.startDate, toStart: issue.startDate, fromEnd: issue.endDate, toEnd: date(12), fromDue: issue.dueDate, toDue: null,
      });
    }
    expect(preview.warnings.some(warning => warning.includes(excluded.key))).toBe(true);
    const changes = dialog.getByRole('table', { name: '선택 업무 날짜 변경 목록', exact: true });
    await expect(changes.getByRole('columnheader', { name: '목표 마감일', exact: true })).toBeVisible();
    for (const issue of [first, second]) {
      const row = changes.getByRole('row').filter({ has: page.getByText(issue.key, { exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.getByRole('cell').nth(1)).toContainText(date(12));
      await expect(row.getByRole('cell').nth(2)).toContainText(issue.dueDate!);
      await expect(row.getByRole('cell').nth(2)).toContainText('삭제');
    }
    await expect(changes.getByText(excluded.key, { exact: true })).toHaveCount(0);
    expect(await fixture.stored()).toEqual(original);

    let lostResult: SchedulePasteApplyResult | undefined;
    const attempts: string[] = [];
    await page.route(`**${applyRoute}`, async route => {
      const body = route.request().postDataJSON() as { previewId: string };
      attempts.push(body.previewId);
      if (attempts.length === 1) {
        lostResult = await readJson<SchedulePasteApplyResult>(await route.fetch(), 200);
        await route.fulfill({ status: 408, json: { error: '합성 프록시 응답 시간 초과' } });
      } else if (attempts.length === 2) {
        await route.fulfill({ status: 401, json: { error: '합성 접속 확인 필요' } });
      } else {
        await route.continue();
      }
    });
    await dialog.getByRole('button', { name: applyName, exact: true }).click();
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recover).toBeEnabled();
    await expect(endValue).toHaveValue(date(12));
    await expect(due).toHaveValue('clear');
    const applied = [
      ...[first, second].map(issue => ({ ...values(issue), version: issue.version + 1, endDate: date(12), dueDate: null })),
      values(excluded),
    ];
    expect(await fixture.stored()).toEqual(applied);
    await recover.click();
    await expect(dialog.getByRole('alert')).toContainText('합성 접속 확인 필요');
    await expect(recover).toBeEnabled();
    await expect(endValue).toBeDisabled();
    const nextApply = nextPost(page, applyRoute);
    await recover.click();
    expect(await readJson<SchedulePasteApplyResult>(await nextApply, 200)).toEqual(lostResult);
    await expect(dialog).toHaveCount(0);
    expect(attempts).toEqual([preview.previewId, preview.previewId, preview.previewId]);
    expect(await fixture.stored()).toEqual(applied);
    for (const issue of [first, second]) {
      await expect(chart.getByLabel(`${issue.key} 시작일`, { exact: true })).toHaveValue(issue.startDate!);
      await expect(chart.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(date(12));
    }

    const nextUndo = nextPost(page, undoRoute);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undoResponse = await nextUndo;
    expect(undoResponse.request().postDataJSON()).toEqual({ undoId: lostResult?.undoId });
    await readJson<{ updated: Issue[] }>(undoResponse, 200);
    expect(await fixture.stored()).toEqual([
      ...[first, second].map(issue => ({ ...values(issue), version: issue.version + 2 })),
      values(excluded),
    ]);
    await expect(chart.getByLabel(`${first.key} 종료일`, { exact: true })).toHaveValue(first.endDate!);
  } finally { await fixture.close(); }
});

test('360px 팀 간트에서 날짜 초안과 공통 날짜로 프로젝트 간 후행 업무를 검토하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const fixture = await makeFixture(request);
  try {
    const visible = `${fixture.prefix} 선택`;
    const first = await fixture.create(`${visible} 개별 종료일`, { startDate: date(1), endDate: date(4), dueDate: null });
    const second = await fixture.create(`${visible} 공통 종료일`, { startDate: date(2), endDate: date(5), dueDate: null }, fixture.secondProject.id);
    const successor = await fixture.create(`${fixture.prefix} 필터 밖 후행 업무`, { startDate: date(8), endDate: date(9), dueDate: date(22) });
    const otherSuccessor = await fixture.create(`${fixture.prefix} 다른 프로젝트 후행 업무`,
      { startDate: date(10), endDate: date(11), dueDate: date(23) }, fixture.secondProject.id);
    await fixture.link(first, successor);
    expect((await request.post(`/api/issues/${successor.id}/relations`, {
      data: { type: 'blocks', direction: 'outgoing', otherIssueId: otherSuccessor.id },
    })).status()).toBe(201);
    const originals = [first, second, successor, otherSuccessor];
    const { chart, selected, open, dialog } = await openChart(page, fixture.projectId, visible, true);
    const firstEnd = chart.getByLabel(`${first.key} 종료일`, { exact: true });
    const secondEnd = chart.getByLabel(`${second.key} 종료일`, { exact: true });
    await firstEnd.fill(date(12));
    await secondEnd.fill(date(10));
    await selected(first).check();
    await selected(second).check();
    await expect(selected(successor)).toHaveCount(0);
    await open.click();
    await expect(dialog).toBeVisible();
    const drafts = dialog.getByRole('region', { name: '간트 날짜 초안', exact: true });
    await expect(drafts.getByRole('checkbox', { name: `${first.key} 날짜 초안 포함`, exact: true })).toBeChecked();
    await drafts.getByRole('checkbox', { name: `${second.key} 날짜 초안 포함`, exact: true }).uncheck();
    await dialog.getByLabel('종료일 변경', { exact: true }).selectOption('set');
    await dialog.getByLabel('종료일 값', { exact: true }).fill(date(8));
    await dialog.getByLabel('목표 마감일 변경', { exact: true }).selectOption('set');
    await dialog.getByLabel('목표 마감일 값', { exact: true }).fill(date(30));
    const successors = dialog.getByRole('checkbox', { name: '후행 일정 함께 검토', exact: true });
    const crossProject = dialog.getByRole('checkbox', { name: '프로젝트 간 차단 포함', exact: true });
    const apply = dialog.getByRole('button', { name: applyName, exact: true });
    async function review(includeTeamBlockers: boolean) {
      const next = nextPost(page, previewRoute);
      await dialog.getByRole('button', { name: previewName, exact: true }).click();
      const response = await next;
      const input = response.request().postDataJSON() as ScheduleBulkDateInput;
      expect(input).toMatchObject({
        projectId: null, changes: { endDate: date(8), dueDate: date(30) }, rescheduleSuccessors: true,
        dates: [{ issue: { id: first.id, expectedVersion: first.version }, changes: { endDate: date(12) } }],
      });
      expect(input.includeTeamBlockers).toBe(includeTeamBlockers ? true : undefined);
      return readJson<SchedulePastePreview>(response, 200);
    }
    await expect(crossProject).toHaveCount(0);
    await successors.check();
    await expect(crossProject).not.toBeChecked();
    const localPreview = await review(false);
    expect(localPreview.followUpIssueIds).toEqual([successor.id]);
    expect(localPreview.changes.some(change => change.id === otherSuccessor.id)).toBe(false);
    await crossProject.check();
    await expect(apply).toBeDisabled();
    const preview = await review(true);
    expect(preview.previewId).not.toBe(localPreview.previewId);
    expect(preview.errors).toEqual([]);
    expect(new Set(preview.followUpIssueIds)).toEqual(new Set([successor.id, otherSuccessor.id]));
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, toEnd: date(12), toDue: date(30) }),
      expect.objectContaining({ id: second.id, toEnd: date(8), toDue: date(30) }),
      expect.objectContaining({ id: successor.id, toStart: date(15), toEnd: date(16), fromDue: date(22), toDue: date(22) }),
      expect.objectContaining({ id: otherSuccessor.id, projectId: fixture.secondProject.id, toStart: date(17), toEnd: date(18),
        fromDue: date(23), toDue: date(23) }),
    ]));
    const table = dialog.getByRole('table', { name: '선택 업무와 후행 업무 날짜 변경 목록', exact: true });
    const followUp = table.getByRole('row').filter({ hasText: successor.key });
    await expect(followUp).toContainText('후행 조정');
    await expect(followUp).toContainText(fixture.firstProject.name);
    await expect(followUp).toContainText(date(22));
    const crossFollowUp = table.getByRole('row').filter({ hasText: otherSuccessor.key });
    await expect(crossFollowUp).toContainText('후행 조정');
    await expect(crossFollowUp).toContainText(fixture.secondProject.name);
    expect(await fixture.stored()).toEqual(originals.map(values));

    let savedResponse: SchedulePasteApplyResult | undefined;
    await page.route(`**${applyRoute}`, async route => {
      savedResponse = await readJson<SchedulePasteApplyResult>(await route.fetch(), 200);
      await route.fulfill({ status: 408, json: { error: '합성 프록시 응답 시간 초과' } });
    }, { times: 1 });
    const applying = nextPost(page, applyRoute);
    await apply.click();
    expect((await applying).status()).toBe(408);
    const recovery = nextPost(page, applyRoute);
    await dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true }).click();
    const recovered = await recovery;
    expect(recovered.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    expect(await readJson<SchedulePasteApplyResult>(recovered, 200)).toEqual(savedResponse);
    await expect(dialog).toHaveCount(0);
    expect(await fixture.stored()).toEqual([
      { ...values(first), version: first.version + 1, endDate: date(12), dueDate: date(30) },
      { ...values(second), version: second.version + 1, endDate: date(8), dueDate: date(30) },
      { ...values(successor), version: successor.version + 1, startDate: date(15), endDate: date(16) },
      { ...values(otherSuccessor), version: otherSuccessor.version + 1, startDate: date(17), endDate: date(18) },
    ]);
    await expect(firstEnd).toHaveValue(date(12));
    await expect(secondEnd).toHaveValue(date(10));
    const undoing = nextPost(page, undoRoute);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await readJson(await undoing, 200);
    for (const [index, stored] of (await fixture.stored()).entries()) {
      const original = originals[index];
      expect(stored).toEqual({ ...values(original), version: original.version + 2 });
    }
    await expect(firstEnd).toHaveValue(date(4));
    await expect(secondEnd).toHaveValue(date(10));
  } finally { await fixture.close(); }
});

test('선택 업무의 날짜 오류와 검토 이후 충돌은 적용을 막고 날짜 선택을 보존한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const fixture = await makeFixture(request);
  try {
    const first = await fixture.create(`${fixture.prefix} 첫 업무`, { startDate: date(1), endDate: date(6), dueDate: date(12) });
    const second = await fixture.create(`${fixture.prefix} 둘째 업무`, { startDate: date(2), endDate: date(3), dueDate: date(12) });
    const { selected, open, dialog } = await openChart(page, fixture.projectId, fixture.prefix);
    for (const issue of [first, second]) await selected(issue).check();
    await open.click();
    const start = dialog.getByLabel('시작일 변경', { exact: true });
    const startValue = dialog.getByLabel('시작일 값', { exact: true });
    await start.selectOption('set');
    await startValue.fill(date(5));
    const previewButton = dialog.getByRole('button', { name: previewName, exact: true });
    const rejectedPreview = nextPost(page, previewRoute);
    await previewButton.click();
    const rejected = await readJson<SchedulePastePreview>(await rejectedPreview, 200);
    expect(rejected.previewId).toBeNull();
    expect(rejected.errors).toEqual(expect.arrayContaining([expect.objectContaining({ key: second.key })]));
    await expect(dialog.getByLabel('선택 업무 날짜 오류', { exact: true })).toContainText(second.key);
    const applyButton = dialog.getByRole('button', { name: applyName, exact: true });
    await expect(applyButton).toBeDisabled();
    expect(await fixture.stored()).toEqual([first, second].map(values));

    const end = dialog.getByLabel('종료일 변경', { exact: true });
    const endValue = dialog.getByLabel('종료일 값', { exact: true });
    await end.selectOption('set');
    await endValue.fill(date(10));
    await dialog.getByLabel('목표 마감일 변경', { exact: true }).selectOption('set');
    const dueValue = dialog.getByLabel('목표 마감일 값', { exact: true });
    await dueValue.fill(date(20));
    const acceptedPreview = nextPost(page, previewRoute);
    await previewButton.click();
    const approved = await readJson<SchedulePastePreview>(await acceptedPreview, 200);
    expect(approved.previewId).toBeTruthy();
    expect(approved.errors).toEqual([]);
    const changed = await readJson<Issue>(await request.patch(`/api/issues/${second.id}`, { data: {
      expectedVersion: second.version, endDate: date(7), dueDate: date(14),
    } }), 200);

    const staleApply = nextPost(page, applyRoute);
    await applyButton.click();
    const collision = await staleApply;
    expect(collision.status(), await collision.text()).toBe(409);
    expect(collision.request().postDataJSON()).toEqual({ previewId: approved.previewId });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(applyButton).toBeDisabled();
    await expect(end).toHaveValue('set');
    await expect(endValue).toHaveValue(date(10));
    await expect(startValue).toHaveValue(date(5));
    await expect(dueValue).toHaveValue(date(20));
    expect(await fixture.stored()).toEqual([first, changed].map(values));

    await dialog.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(endValue).toHaveValue(date(10));
    const refreshedPreview = nextPost(page, previewRoute);
    await previewButton.click();
    const response = await refreshedPreview;
    const fresh = await readJson<SchedulePastePreview>(response, 200);
    expect(fresh.previewId).toBeTruthy();
    expect(fresh.previewId).not.toBe(approved.previewId);
    const input = response.request().postDataJSON() as ScheduleBulkDateInput;
    expect(input.issues.sort((a, b) => a.id.localeCompare(b.id))).toEqual(selection([first, changed]));
    const allDates = { startDate: date(5), endDate: date(10), dueDate: date(20) };
    expect(input.changes).toEqual(allDates);
    expect(fresh.changes.find(change => change.id === second.id)).toMatchObject({ fromEnd: date(7), toEnd: date(10) });
    expect(await fixture.stored()).toEqual([first, changed].map(values));

    const applied = nextPost(page, applyRoute);
    await applyButton.click();
    await readJson<SchedulePasteApplyResult>(await applied, 200);
    await expect(dialog).toHaveCount(0);
    expect(await fixture.stored()).toEqual([first, changed].map(issue => ({ ...values(issue), ...allDates, version: issue.version + 1 })));

    const undone = nextPost(page, undoRoute);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await readJson<{ updated: Issue[] }>(await undone, 200);
    expect(await fixture.stored()).toEqual([first, changed].map(issue => ({ ...values(issue), version: issue.version + 2 })));
  } finally { await fixture.close(); }
});

test('360px 전체 프로젝트 간트에서 두 프로젝트의 선택 날짜를 함께 적용하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const fixture = await makeFixture(request);
  const { firstProject, secondProject, prefix } = fixture;
  try {
    const first = await fixture.create(`${prefix} 첫 프로젝트`, { startDate: date(1), endDate: date(4), dueDate: date(15) });
    const second = await fixture.create(`${prefix} 다른 프로젝트`, { startDate: date(3), endDate: date(6), dueDate: date(18) }, secondProject.id);
    const unselected = await fixture.create(`${prefix} 선택하지 않은 업무`, { startDate: date(2), endDate: date(8), dueDate: date(16) }, secondProject.id);
    const original = [first, second, unselected].map(values);
    const teamFilters = { scope: 'team', ganttQ: prefix };
    const teamRoute = `#/${firstProject.id}/gantt`;
    const { chart, search, selected, open, dialog } = await openChart(page, firstProject.id, prefix, true);
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill(date(1));
    await expect(open).toBeDisabled();
    await selected(first).check();
    await selected(second).check();
    await expect(selected(unselected)).not.toBeChecked();
    await open.click();
    await expect(dialog.getByText('선택한 업무 2개 · 프로젝트 2개', { exact: true })).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await expect(dialog.getByLabel('시작일 변경', { exact: true })).toHaveValue('keep');
    await dialog.getByLabel('종료일 변경', { exact: true }).selectOption('set');
    const end = dialog.getByLabel('종료일 값', { exact: true });
    await end.fill(date(12));
    const due = dialog.getByLabel('목표 마감일 변경', { exact: true });
    await due.selectOption('clear');
    const previewRequest = nextPost(page, previewRoute);
    await dialog.getByRole('button', { name: previewName, exact: true }).click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toMatchObject({ projectId: null, changes: { endDate: date(12), dueDate: null } });
    const payload = previewResponse.request().postDataJSON() as ScheduleBulkDateInput;
    expect(payload.issues.sort((left, right) => left.id.localeCompare(right.id))).toEqual(selection([first, second]));
    const preview = await readJson<SchedulePastePreview>(previewResponse, 200);
    expect(preview).toMatchObject({ projectId: null, projectIds: [firstProject.id, secondProject.id].sort(), errors: [], unchanged: 0 });
    expect(preview.previewId).toBeTruthy();
    await expect(dialog.getByText('대상 프로젝트 2개', { exact: true })).toBeVisible();
    const table = dialog.getByRole('table', { name: '선택 업무 날짜 변경 목록', exact: true });
    for (const [issue, project] of [[first, firstProject], [second, secondProject]] as const) {
      const row = table.getByRole('row').filter({ has: page.getByText(issue.key, { exact: true }) });
      await expect(row.locator(`[data-schedule-project="${project.id}"]`)).toHaveText(project.name);
      await expect(row.getByRole('cell').nth(1)).toContainText(date(12));
      await expect(row.getByRole('cell').nth(2)).toContainText('삭제');
    }
    await expect(table.getByText(unselected.key, { exact: true })).toHaveCount(0);
    expect(await fixture.stored()).toEqual(original);

    let lostResult: SchedulePasteApplyResult | undefined;
    const attempts: unknown[] = [];
    page.on('request', sent => { if (new URL(sent.url()).pathname === applyRoute && sent.method() === 'POST') attempts.push(sent.postDataJSON()); });
    await page.route(url => url.pathname === applyRoute, async route => {
      lostResult = await readJson<SchedulePasteApplyResult>(await route.fetch(), 200);
      await route.abort('failed');
    }, { times: 1 });
    await dialog.getByRole('button', { name: applyName, exact: true }).click();
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recover).toBeEnabled();
    await expect(end).toHaveValue(date(12));
    await expect(due).toHaveValue('clear');
    const applied = [
      ...[first, second].map(issue => ({ ...values(issue), version: issue.version + 1, endDate: date(12), dueDate: null })),
      values(unselected),
    ];
    expect(await fixture.stored()).toEqual(applied);
    const retried = nextPost(page, applyRoute);
    await recover.click();
    expect(await readJson<SchedulePasteApplyResult>(await retried, 200)).toEqual(lostResult);
    expect(attempts).toEqual([{ previewId: preview.previewId }, { previewId: preview.previewId }]);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('프로젝트 2개에서 업무 2개의 날짜를 변경했습니다.', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === `${teamRoute}?${new URLSearchParams(teamFilters)}`);
    await expect(search).toHaveValue(prefix);
    expect(await fixture.stored()).toEqual(applied);
    for (const issue of [first, second]) {
      await expect(chart.getByLabel(`${issue.key} 시작일`, { exact: true })).toHaveValue(issue.startDate!);
      await expect(chart.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(date(12));
    }

    const undo = nextPost(page, undoRoute);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const restored = await undo;
    expect(restored.request().postDataJSON()).toEqual({ undoId: lostResult?.undoId });
    await readJson<{ updated: Issue[] }>(restored, 200);
    expect(await fixture.stored()).toEqual([
      ...[first, second].map(issue => ({ ...values(issue), version: issue.version + 2 })), values(unselected),
    ]);
    await page.getByRole('combobox', { name: '프로젝트 필터', exact: true }).selectOption(secondProject.id);
    await expect(page).toHaveURL(url => url.hash === `${teamRoute}?${new URLSearchParams({ scope: 'team', ganttProject: secondProject.id, ganttQ: prefix })}`);
    await expect(chart.getByLabel(`${first.key} 종료일`, { exact: true })).toHaveCount(0);
    await expect(chart.getByLabel(`${second.key} 종료일`, { exact: true })).toHaveValue(second.endDate!);
    await expect(search).toHaveValue(prefix);
  } finally { await fixture.close(); }
});
