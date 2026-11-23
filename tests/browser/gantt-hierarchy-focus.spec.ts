import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, SavedView, SchedulePasteApplyResult, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

function dateInNextWeek(offset: number): string {
  const date = new Date();
  const daysToNextMonday = (8 - date.getUTCDay()) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysToNextMonday + offset);
  return date.toISOString().slice(0, 10);
}

async function fixture(request: APIRequestContext) {
  const { projects: [project, otherProject], users: [actor] } = await workspace(request);
  const prefix = `하위 일정 ${randomUUID().slice(0, 8)}`;
  const headers = { 'X-Actor-Id': actor.id };
  const issues: Issue[] = [];
  const views: SavedView[] = [];
  return {
    project, otherProject, actor, prefix,
    async issue(name: string, fields: Partial<Pick<Issue, 'parentId' | 'projectId' | 'assigneeId' | 'status' | 'startDate' | 'endDate' | 'dueDate'>> = {}) {
      const issue = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: project.id, title: `${prefix} ${name}`, ...fields },
      }), 201);
      issues.push(issue);
      return issue;
    },
    async view(query: string) {
      const view = await json<SavedView>(await request.post('/api/views', {
        headers, data: { projectId: project.id, name: `${prefix} 공유 보기`, layout: 'list', filters: { query, status: 'all', type: 'all', assigneeId: 'all' } },
      }), 201);
      views.push(view);
      return view;
    },
    async link(predecessor: Issue, successor: Issue) {
      await json(await request.post('/api/dependencies', {
        headers, data: { predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0 },
      }), 201);
    },
    async stored(issue: Issue) {
      return (await workspace(request)).issues.find(value => value.id === issue.id);
    },
    async clear() {
      for (const view of views) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`, { headers });
      for (const issue of issues.reverse()) {
        const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

function gantt(page: Page) {
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  const panel = page.getByRole('region', { name: '하위 업무 일정', exact: true });
  const rows = chart.locator('.gantt-row[data-issue-id]');
  const row = (issue: Issue) => chart.locator(`.gantt-row[data-issue-id="${issue.id}"]`);
  return {
    chart, panel, rows, row,
    select: (issue: Issue) => row(issue).getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }),
    date: (issue: Issue, edge: '시작일' | '종료일') => row(issue).getByLabel(`${issue.key} ${edge}`, { exact: true }),
    span: (issue: Issue, start: string, end: string) => row(issue).getByRole('img', { name: `${issue.key} 하위 업무 일정 ${start} ~ ${end}`, exact: true }),
    search: page.getByRole('textbox', { name: '간트 업무 검색', exact: true }),
    windowStart: page.getByLabel('간트 표시 시작일', { exact: true }),
    open: page.getByRole('button', { name: '하위 업무 일정 보기', exact: true }),
    close: panel.getByRole('button', { name: '하위 업무 일정 닫기', exact: true }),
  };
}

async function dismissDiscard(page: Page, action: () => Promise<void>) {
  const dismissal = page.waitForEvent('dialog', { timeout: 8_000 }).then(async dialog => {
    const message = dialog.message();
    await dialog.dismiss();
    expect(dialog.type()).toBe('confirm');
    expect(message).toContain('저장하지 않은 간트 입력');
  });
  await Promise.all([dismissal, action()]);
}

test('360px 프로젝트 간트에서 검색 밖의 하위 일정을 고치고 상위 업무와 원래 보기를 유지한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const d = dateInNextWeek;
  try {
    const parent = await f.issue('원래 보기 상위 업무');
    const child = await f.issue('직접 하위 업무', { parentId: parent.id, startDate: d(2), endDate: d(4) });
    const missing = await f.issue('종료일 미정 하위 업무', { parentId: parent.id, startDate: d(1) });
    const nested = await f.issue('완료된 손자 업무', { parentId: child.id, status: 'done', startDate: d(0), endDate: d(1) });
    const canceled = await f.issue('취소된 손자 업무', { parentId: child.id, status: 'cancelled', startDate: d(1), endDate: d(2) });
    const unrelated = await f.issue('원래 보기 별도 업무');
    const view = await f.view(`${f.prefix} 원래 보기`);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    const hash = `#/${f.project.id}/gantt?savedView=${view.id}`;
    await page.goto(`/${hash}`);
    const g = gantt(page);
    const viewPicker = page.getByRole('combobox', { name: '간트 공유 보기', exact: true });
    const hideDone = page.getByRole('checkbox', { name: '완료 업무 숨기기', exact: true });
    const zoomWeek = page.getByRole('button', { name: '주', exact: true });
    await expect(viewPicker).toHaveValue(view.id);
    await g.search.fill('원래 보기');
    await hideDone.check();
    await g.windowStart.fill(d(-50));
    await zoomWeek.click();
    await expect(g.rows).toHaveCount(2);
    await g.select(parent).check();
    await g.open.press('Enter');

    await expect(g.panel).toBeVisible();
    const bounds = (await g.panel.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    await expect(g.panel).toContainText('전체 4개');
    await expect(g.panel).toContainText('완료 1개');
    await expect(g.panel).toContainText('취소 1개');
    await expect(g.panel).toContainText('미정 1개');
    await expect(g.panel).toContainText('기존 보기 밖 4개');
    await expect(g.panel).toContainText('하위 업무 범위');
    await expect(g.panel.getByText(d(0), { exact: true })).toBeVisible();
    await expect(g.panel.getByText(d(4), { exact: true })).toBeVisible();
    await expect(g.search).toBeDisabled();
    await expect(viewPicker).toBeDisabled();

    await expect(g.rows).toHaveCount(5);
    const rowOrder = [parent, child, nested, canceled, missing];
    for (const [index, issue] of rowOrder.entries()) await expect(g.rows.nth(index)).toHaveAttribute('data-issue-id', issue.id);
    for (const [issue, label] of [[parent, '상위 업무'], [child, '하위 1단계'], [nested, '하위 2단계']] as const) {
      await expect(g.row(issue).getByText(label, { exact: true })).toBeVisible();
    }
    await expect(g.row(unrelated)).toHaveCount(0);

    await g.panel.getByRole('button', { name: '상위 업무로 이동', exact: true }).click();
    await expect(g.chart).toBeFocused();
    await expect(g.row(parent)).toBeInViewport();
    await expect(g.span(parent, d(0), d(4))).toBeVisible();
    await expect(g.date(parent, '시작일')).toHaveValue('');
    await expect(g.date(parent, '종료일')).toHaveValue('');

    const end = g.date(missing, '종료일');
    await end.fill(d(7));
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/manual-apply' && response.request().method() === 'POST');
    await end.press('Enter');
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await expect(g.panel.getByText(d(7), { exact: true })).toBeVisible();
    await expect(g.panel).toContainText('미정 0개');
    await expect(g.span(parent, d(0), d(7))).toBeVisible();
    expect(await f.stored(missing)).toMatchObject({ startDate: d(1), endDate: d(7) });
    expect(await f.stored(parent)).toMatchObject({ version: parent.version, startDate: null, endDate: null });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click(),
    ]);
    const report = await readFile(await download.path(), 'utf8');
    expect(report).toContain(`하위 업무 일정 · ${parent.key} ${parent.title}`);
    expect(report).toContain(`하위 업무 범위 · ${d(0)} ~ ${d(7)}`);
    for (const issue of rowOrder) expect(report).toContain(issue.title);
    expect(report).not.toContain(unrelated.title);

    await g.windowStart.fill(d(-3));
    await g.close.click();
    await expect(g.panel).toHaveCount(0);
    await expect(g.open).toBeFocused();
    await expect(g.windowStart).toHaveValue(d(-50));
    await expect(g.rows).toHaveCount(2);
    await expect(g.select(parent)).toBeChecked();
    await expect(g.select(unrelated)).not.toBeChecked();
    await expect(viewPicker).toHaveValue(view.id);
    await expect(g.search).toHaveValue('원래 보기');
    await expect(hideDone).toBeChecked();
    await expect(zoomWeek).toHaveClass(/active/u);
    await expect(page).toHaveURL(url => url.hash === hash);
  } finally {
    await f.clear();
  }
});

test('360px 하위 업무 전체 이동을 최신 구성으로 다시 검토하고 저장 결과를 확인한 뒤 함께 되돌린다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const d = dateInNextWeek;
  const previewPath = '/api/schedule/manual-preview';
  const applyPath = '/api/schedule/manual-apply';
  const nextPost = (path: string) => page.waitForResponse(response =>
    new URL(response.url()).pathname === path && response.request().method() === 'POST');
  const schedule = ({ id, version, startDate, endDate, dueDate }: Issue) => ({ id, version, startDate, endDate, dueDate });
  try {
    const parent = await f.issue('검색에 표시할 상위', { startDate: d(0), endDate: d(1), dueDate: d(7) });
    const child = await f.issue('직접 하위 업무', { parentId: parent.id, startDate: d(1), endDate: d(2) });
    const nested = await f.issue('간접 하위 업무', { parentId: child.id, startDate: d(3), endDate: d(3) });
    const closed = await f.issue('완료된 하위 업무', { parentId: parent.id, status: 'done', startDate: d(1), endDate: d(2) });
    const undated = await f.issue('일정 미정 하위 업무', { parentId: child.id });
    const unrelated = await f.issue('검색에 표시할 다른 업무', { startDate: d(1), endDate: d(2) });
    const stored = async (issues: Issue[]) => {
      const current = new Map((await workspace(request)).issues.map(issue => [issue.id, issue]));
      return issues.map(issue => schedule(current.get(issue.id)!));
    };
    const members = [parent, child, nested];

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/#/${f.project.id}/gantt`);
    const g = gantt(page);
    const openMove = g.panel.getByRole('button', { name: '상위·하위 일정 함께 이동', exact: true });
    const dialog = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '변경 적용', exact: true });
    const undo = page.getByRole('button', { name: '되돌리기', exact: true });
    const query = `${f.prefix} 검색에 표시할`;
    await expect(g.search).toBeVisible({ timeout: 35_000 });
    await g.search.fill(query);
    await expect(g.rows).toHaveCount(2);
    await expect(g.row(nested)).toHaveCount(0);
    await g.select(parent).check();
    await g.open.click();
    await expect(g.row(nested)).toBeVisible();
    await expect(g.select(child)).not.toBeChecked();
    const nestedEnd = g.date(nested, '종료일');
    await nestedEnd.fill(d(8));
    await dismissDiscard(page, () => openMove.click());
    await expect(nestedEnd).toBeFocused();
    await expect(nestedEnd).toHaveValue(d(8));
    await nestedEnd.press('Escape');
    await expect(nestedEnd).toHaveValue(d(3));
    await openMove.click();
    await page.getByLabel('이동 일수', { exact: true }).fill('2');
    await page.getByRole('checkbox', { name: '근무일 기준', exact: true }).uncheck();
    const inspected = nextPost(previewPath);
    await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const inspectedResponse = await inspected;
    expect(inspectedResponse.request().postDataJSON()).toEqual({ hierarchy: { id: parent.id, expectedVersion: parent.version }, days: 2, workingDays: false });
    const first = await json<SchedulePreview>(inspectedResponse);
    expect(first.previewId).toBeTruthy();
    expect(first.changes.map(change => change.id)).toEqual(members.map(issue => issue.id));
    expect(first.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: closed.id, reason: 'closed' }),
      expect.objectContaining({ id: undated.id, reason: 'unscheduled' }),
    ]));
    await expect(dialog.getByText(nested.title, { exact: true })).toBeVisible();
    await expect(dialog.getByText(closed.title, { exact: true })).toBeVisible();
    await expect(dialog.getByText(undated.title, { exact: true })).toBeVisible();
    expect(await stored([...members, closed, undated, unrelated])).toEqual([...members, closed, undated, unrelated].map(schedule));

    const added = await f.issue('검토 뒤 연결된 하위 업무', { parentId: nested.id, startDate: d(4), endDate: d(5) });
    const changedParent = await json<Issue>(await request.patch(`/api/issues/${parent.id}`, {
      headers: { 'X-Actor-Id': f.actor.id },
      data: { expectedVersion: parent.version, title: `${parent.title} 수정` },
    }));
    const rejected = nextPost(applyPath);
    await apply.click();
    expect((await rejected).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(apply).toBeDisabled();
    const expectedBefore = [changedParent, child, nested, added, closed, undated, unrelated];
    expect(await stored(expectedBefore)).toEqual(expectedBefore.map(schedule));

    const inspectedAgain = nextPost(previewPath);
    await dialog.getByRole('button', { name: '다시 미리보기', exact: true }).click();
    const updatedResponse = await inspectedAgain;
    expect(updatedResponse.request().postDataJSON()).toEqual({ hierarchy: { id: parent.id, expectedVersion: changedParent.version }, days: 2, workingDays: false });
    const fresh = await json<SchedulePreview>(updatedResponse);
    expect(fresh.previewId).toBeTruthy();
    expect(fresh.previewId).not.toBe(first.previewId);
    expect(fresh.changes.map(change => change.id)).toEqual([parent.id, child.id, nested.id, added.id]);
    await expect(dialog.getByText(added.title, { exact: true })).toBeVisible();

    let lostResult: SchedulePasteApplyResult | undefined;
    let lostBody: unknown;
    await page.route(`**${applyPath}`, async route => {
      lostBody = route.request().postDataJSON();
      lostResult = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.abort('failed');
    }, { times: 1 });
    await apply.click();
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recover).toBeFocused();
    expect(lostBody).toEqual({ previewId: fresh.previewId });
    expect(lostResult?.undoId).toBeTruthy();
    const moved = [
      { ...schedule(changedParent), version: changedParent.version + 1, startDate: d(2), endDate: d(3) },
      { ...schedule(child), version: child.version + 1, startDate: d(3), endDate: d(4) },
      { ...schedule(nested), version: nested.version + 1, startDate: d(5), endDate: d(5) },
      { ...schedule(added), version: added.version + 1, startDate: d(6), endDate: d(7) },
      ...[closed, undated, unrelated].map(schedule),
    ];
    expect(await stored(expectedBefore)).toEqual(moved);

    const replayed = nextPost(applyPath);
    await recover.click();
    const replayResponse = await replayed;
    expect(replayResponse.request().postDataJSON()).toEqual(lostBody);
    expect(await json<SchedulePasteApplyResult>(replayResponse)).toEqual(lostResult);
    await expect(dialog).toHaveCount(0);
    await expect(openMove).toBeFocused();
    await expect(g.date(added, '시작일')).toHaveValue(d(6));
    expect(await stored(expectedBefore)).toEqual(moved);

    const reverted = nextPost('/api/schedule/undo');
    await undo.click();
    const revertResponse = await reverted;
    expect(revertResponse.request().postDataJSON()).toEqual({ undoId: lostResult?.undoId });
    await json(revertResponse);
    await expect(g.date(added, '시작일')).toHaveValue(d(4));
    await expect(undo).toBeDisabled();
    expect(await stored(expectedBefore)).toEqual(expectedBefore.map((issue, index) => ({
      ...schedule(issue), version: issue.version + (index < 4 ? 2 : 0),
    })));
    await g.close.click();
    await expect(g.search).toHaveValue(query);
    await expect(g.rows).toHaveCount(2);
    await expect(g.open).toBeFocused();
    await expect(g.select(parent)).toBeChecked();
    await expect(g.select(unrelated)).not.toBeChecked();
  } finally {
    await f.clear();
  }
});

test('전체 프로젝트 간트에서 하위 업무 일정 전환을 취소하면 날짜 초안을 지키고 원래 필터로 돌아간다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const f = await fixture(request);
  const d = dateInNextWeek;
  try {
    const parent = await f.issue('선택한 팀 업무', { assigneeId: f.actor.id, startDate: d(-220) });
    const child = await f.issue('배정이 다른 하위 업무', { parentId: parent.id, assigneeId: null, startDate: d(2), endDate: d(3) });
    const predecessor = await f.issue('상위 업무의 직접 선행', { assigneeId: null, startDate: d(0), endDate: d(0) });
    const foreign = await f.issue('선택한 팀 업무 다른 프로젝트', { projectId: f.otherProject.id, assigneeId: f.actor.id });
    await f.link(predecessor, parent);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    const hash = `#/${f.project.id}/gantt?scope=team&ganttProject=${f.project.id}&ganttAssignee=${f.actor.id}&ganttUnscheduled=1`;
    await page.goto(`/${hash}`);
    await expect(page.getByRole('heading', { name: '전체 프로젝트 간트', exact: true })).toBeVisible();
    const g = gantt(page);
    const project = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const assignee = page.getByRole('combobox', { name: '담당자 필터', exact: true });
    const unscheduled = page.getByRole('checkbox', { name: '일정 미정만', exact: true });
    const dependency = page.getByRole('region', { name: '선후행 흐름', exact: true });
    const dependencyTrigger = page.getByRole('button', { name: '선후행 흐름 보기', exact: true });
    let scheduleWrites = 0;
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if ((path === '/api/schedule/manual-apply' || path === '/api/schedule/apply') && sent.method() === 'POST') scheduleWrites++;
    });
    await g.search.fill(`${f.prefix} 선택한 팀 업무`);
    await expect(g.rows).toHaveCount(1);
    await g.select(parent).check();

    const parentEnd = g.date(parent, '종료일');
    await parentEnd.fill(d(4));
    await dismissDiscard(page, () => g.open.click());
    await expect(g.panel).toHaveCount(0);
    await expect(parentEnd).toBeFocused();
    await expect(parentEnd).toHaveValue(d(4));
    expect((await f.stored(parent))?.endDate).toBeNull();
    await parentEnd.press('Escape');
    await expect(parentEnd).toHaveValue('');

    await g.select(parent).uncheck();
    const rowOpener = g.row(parent).getByRole('button', { name: `${parent.key} 하위 업무 일정 보기`, exact: true });
    await rowOpener.click();
    await expect(g.panel).toContainText('기존 보기 밖 1개');
    await expect(g.windowStart).toHaveValue(d(-5));
    await expect(g.rows).toHaveCount(2);
    await expect(g.row(child)).toBeVisible();
    await expect(g.row(predecessor)).toHaveCount(0);
    await expect(g.row(foreign)).toHaveCount(0);
    await expect(project).toBeDisabled();
    await expect(assignee).toBeDisabled();
    await expect(unscheduled).toBeDisabled();

    const childEnd = g.date(child, '종료일');
    await childEnd.fill(d(6));
    await dismissDiscard(page, () => g.close.click());
    await expect(g.panel).toBeVisible();
    await expect(childEnd).toBeFocused();
    await expect(childEnd).toHaveValue(d(6));
    await expect(g.span(parent, d(2), d(3))).toBeVisible();
    expect((await f.stored(child))?.endDate).toBe(d(3));
    await childEnd.press('Escape');
    await expect(childEnd).toHaveValue(d(3));
    await g.close.click();

    await expect(rowOpener).toBeFocused();
    await expect(g.rows).toHaveCount(1);
    await expect(g.select(parent)).not.toBeChecked();
    await expect(project).toHaveValue(f.project.id);
    await expect(assignee).toHaveValue(`member:${f.actor.id}`);
    await expect(unscheduled).toBeChecked();
    await expect(g.search).toHaveValue(`${f.prefix} 선택한 팀 업무`);
    await expect(page).toHaveURL(url => url.hash === `${hash}&${new URLSearchParams({ ganttQ: `${f.prefix} 선택한 팀 업무` })}`);
    await g.select(parent).check();
    await dependencyTrigger.click();
    await expect(dependency).toBeVisible();
    await expect(g.panel).toHaveCount(0);
    await expect(g.row(predecessor)).toBeVisible();
    await expect(g.row(child)).toHaveCount(0);
    await dependency.getByRole('button', { name: '선후행 흐름 닫기', exact: true }).click();
    await expect(g.rows).toHaveCount(1);
    expect(scheduleWrites).toBe(0);
  } finally {
    await f.clear();
  }
});
