import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Route } from '@playwright/test';
import type { AutomaticSchedulePreview, Dependency, Issue, IssueRelation, Project, SchedulePasteApplyResult, TeamScheduleBlocker, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const title = '프로젝트 간 차단';
const blockersPath = '/api/schedule/team-blockers';
const relationsPath = (issue: Issue) => `/api/issues/${issue.id}/relations`;
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });
const blockerPanel = (page: Page) => page.getByRole('region', { name: title, exact: true });
const issueButton = (panel: Locator, issue: Issue) => button(panel, `${issue.key} 업무 열기`);
const gantt = (project: Project) => `#/${project.id}/gantt?scope=team`;
const ganttSearch = (hash: string, query: string) => `${hash}&${new URLSearchParams({ ganttQ: query })}`;
const row = (page: Page, issue: Issue) => page.getByRole('region', { name: '간트 차트', exact: true }).locator(`[data-issue-id="${issue.id}"]`);

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const teamBlockers = async (request: APIRequestContext) => json<TeamScheduleBlocker[]>(await request.get(blockersPath));

function waitMutation(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `교차 차단 ${randomUUID().slice(0, 8)}`;
  const issueIds = new Set<string>();
  return {
    first, second, actor, prefix,
    async issue(project: Project, label: string, fields: Partial<Pick<Issue, 'startDate' | 'endDate' | 'dueDate' | 'status'>> = {}) {
      const issue = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: project.id, title: `${prefix} ${label}`, startDate: '2026-11-23', endDate: '2026-11-26', ...fields },
      }), 201);
      issueIds.add(issue.id);
      return issue;
    },
    async relation(source: Issue, target: Issue, type = 'blocks') {
      return json<IssueRelation>(await request.post(relationsPath(source), {
        headers, data: { otherIssueId: target.id, type, direction: 'outgoing' },
      }), 201);
    },
    async dependency(source: Issue, target: Issue) {
      return json<Dependency>(await request.post('/api/dependencies', {
        headers, data: { predecessorId: source.id, successorId: target.id, type: 'FS', lagDays: 0 },
      }), 201);
    },
    async schedule() {
      const snapshot = await workspace(request);
      return {
        dates: Object.fromEntries(snapshot.issues.filter(issue => issueIds.has(issue.id))
          .map(({ id, startDate, endDate, dueDate }) => [id, { startDate, endDate, dueDate }])),
        dependencies: snapshot.dependencies.filter(link => issueIds.has(link.predecessorId) || issueIds.has(link.successorId)),
      };
    },
    async close() {
      for (const id of [...issueIds].reverse()) {
        const removed = await request.delete(`/api/issues/${id}`, { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

async function openBlockers(page: Page) {
  const panel = blockerPanel(page);
  if (!await panel.isVisible()) await button(page, title).click();
  await expect(panel.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return panel;
}

test('360px 전체 간트에서 두 프로젝트의 보이는 행을 골라 차단 관계를 검토하고 저장한다', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const source = await f.issue(f.first, '교차 연결 원인', { startDate: '2026-11-19', endDate: '2026-11-20' });
    const target = await f.issue(f.second, '교차 연결 대상', { startDate: null, endDate: null });
    const local = await f.issue(f.first, '같은 프로젝트 후행', { startDate: '2026-11-24', endDate: '2026-11-26' });
    const before = await f.schedule();
    const crossProjectQuery = `${f.prefix} 교차 연결`;
    const hash = gantt(f.first);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${ganttSearch(hash, crossProjectQuery)}`);
    await expect(row(page, source)).toBeVisible();
    await expect(row(page, target)).toBeVisible();
    await expect(row(page, local)).toHaveCount(0);
    const picker = button(page, '차트에서 연결');
    const dependencyWrites: string[] = [];
    page.on('request', outgoing => {
      if (new URL(outgoing.url()).pathname === '/api/dependencies' && outgoing.method() !== 'GET') dependencyWrites.push(outgoing.method());
    });
    const pickRows = async (successor: Issue) => {
      await picker.click();
      await button(row(page, source), `${source.key} 선행 업무 선택`).click();
      await button(row(page, successor), `${successor.key} 후행 업무 선택`).click();
    };
    const panel = blockerPanel(page);
    const form = panel.getByRole('form', { name: '프로젝트 간 차단 관계 추가', exact: true });
    const sourceField = form.getByRole('combobox', { name: '차단하는 업무', exact: true });
    const targetField = form.getByRole('combobox', { name: '차단되는 업무', exact: true });
    await pickRows(target);
    await expect(form).toBeVisible();
    await expect(sourceField).toHaveValue(source.id);
    await expect(targetField).toHaveValue(target.id);
    await expect(form.getByRole('heading', { name: '프로젝트 간 차단 관계 추가', exact: true })).toBeFocused();
    await expect(picker).toHaveAttribute('aria-pressed', 'false');
    expect(await f.schedule()).toEqual(before);
    expect((await teamBlockers(request)).filter(item => item.sourceIssueId === source.id)).toEqual([]);

    await button(form, '차단 관계 입력 취소').click();
    await expect(form).toHaveCount(0);
    await expect(picker).toBeFocused();
    expect((await teamBlockers(request)).filter(item => item.sourceIssueId === source.id)).toEqual([]);

    await pickRows(target);
    await expect(sourceField).toHaveValue(source.id);
    await expect(targetField).toHaveValue(target.id);
    const updatedTitle = `${source.title} 갱신`;
    const updateBeforePost = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await json<Issue>(await request.patch(`/api/issues/${source.id}`, {
        headers: { 'X-Actor-Id': f.actor.id }, data: { expectedVersion: source.version, title: updatedTitle },
      }));
      await route.continue();
    };
    await page.route(`**${blockersPath}`, updateBeforePost);
    const stale = waitMutation(page, blockersPath);
    await button(form, '차단 관계 저장').click();
    expect((await stale).status()).toBe(409);
    await page.unroute(`**${blockersPath}`, updateBeforePost);
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(sourceField.locator('option:checked')).toContainText(updatedTitle);
    await expect(targetField).toHaveValue(target.id);
    expect((await teamBlockers(request)).filter(item => item.sourceIssueId === source.id)).toEqual([]);

    const saving = waitMutation(page, blockersPath);
    await button(form, '차단 관계 저장').click();
    const savedResponse = await saving;
    expect(savedResponse.request().postDataJSON()).toEqual({ sourceIssueId: source.id, targetIssueId: target.id,
      expectedSourceVersion: source.version + 1, expectedTargetVersion: target.version });
    const relation = await json<IssueRelation>(savedResponse, 201);
    expect(relation).toMatchObject({ origin: 'teamspace', type: 'blocks', sourceIssueId: source.id, targetIssueId: target.id });
    await expect(form).toHaveCount(0);
    const relationRow = panel.locator(`[data-team-blocker-id="${relation.id}"]`);
    await expect(issueButton(relationRow, source)).toBeVisible();
    await expect(issueButton(relationRow, target)).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === ganttSearch(hash, crossProjectQuery));
    expect((await teamBlockers(request)).filter(item => item.sourceIssueId === source.id || item.targetIssueId === target.id)
      .map(item => item.id)).toEqual([relation.id]);
    expect(await f.schedule()).toEqual(before);
    expect(dependencyWrites).toEqual([]);

    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(f.prefix);
    await expect(row(page, local)).toBeVisible();
    await pickRows(local);
    const localLink = page.getByRole('dialog', { name: '선행·후행 업무 연결', exact: true });
    await expect(localLink.getByLabel('선행 업무', { exact: true })).toHaveValue(source.id);
    await expect(localLink.getByLabel('후행 업무', { exact: true })).toHaveValue(local.id);
    await expect(localLink.getByLabel('연결 유형', { exact: true })).toHaveValue('FS');
    const creating = waitMutation(page, '/api/dependencies');
    await button(localLink, '업무 연결').click();
    const dependency = await json<Dependency>(await creating, 201);
    expect(dependency).toMatchObject({ predecessorId: source.id, successorId: local.id, type: 'FS', lagDays: 0 });
    await expect(localLink).toHaveCount(0);
    expect(await f.schedule()).toEqual({ ...before, dependencies: [dependency] });
    expect(dependencyWrites).toEqual(['POST']);
  } finally {
    await f.close();
  }
});

test('전체 프로젝트 간트에서 차단 관계 저장 응답이 유실되어도 실제 결과를 확인한다', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const source = await f.issue(f.first, '다른 프로젝트 승인', { startDate: '2026-11-26', endDate: '2026-11-27' });
    const target = await f.issue(f.second, '선택한 차단 대상');
    const sameProject = await f.issue(f.second, '같은 프로젝트 승인');
    const closed = await f.issue(f.first, '완료된 다른 프로젝트 승인', { status: 'done' });
    const before = await f.schedule();
    const hash = gantt(f.second);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${hash}`);
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(f.prefix);
    await row(page, target).getByRole('checkbox', { name: `${target.key} 선택`, exact: true }).check();
    const panel = await openBlockers(page);
    await button(panel, '차단 관계 추가').click();
    const form = panel.getByRole('form', { name: '프로젝트 간 차단 관계 추가', exact: true });
    const blocked = form.getByRole('combobox', { name: '차단되는 업무', exact: true });
    const blocker = form.getByRole('combobox', { name: '차단하는 업무', exact: true });
    await expect(blocked).toHaveValue(target.id);
    await form.getByLabel('원인 업무 검색', { exact: true }).fill(f.prefix);
    await expect(blocker.locator(`option[value="${sameProject.id}"]`)).toHaveCount(0);
    await expect(blocker.locator(`option[value="${closed.id}"]`)).toHaveCount(0);
    await expect(blocker.locator(`option[value="${source.id}"]`)).toContainText(source.key);
    await blocker.selectOption(source.id);

    const writes: unknown[] = [];
    let committed: IssueRelation | undefined;
    await page.route(`**${blockersPath}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push(route.request().postDataJSON());
      committed = await json<IssueRelation>(await route.fetch(), 201);
      await route.abort('failed');
    });
    await button(form, '차단 관계 저장').click();
    await expect(form).toHaveCount(0);
    await expect(issueButton(panel, source)).toBeVisible();
    await expect(issueButton(panel, target)).toBeVisible();
    expect(writes).toEqual([{ sourceIssueId: source.id, targetIssueId: target.id,
      expectedSourceVersion: source.version, expectedTargetVersion: target.version }]);
    expect(committed).toMatchObject({ origin: 'teamspace', type: 'blocks', sourceIssueId: source.id, targetIssueId: target.id });
    await expect(panel).toContainText(f.first.name);
    await expect(panel).toContainText(f.second.name);
    await expect(page).toHaveURL(url => url.hash === ganttSearch(hash, f.prefix));
    const saved = (await teamBlockers(request)).filter(item => item.sourceIssueId === source.id && item.targetIssueId === target.id);
    expect(saved.map(item => item.id)).toEqual([committed!.id]);
    expect(await f.schedule()).toEqual(before);
  } finally {
    await f.close();
  }
});

test('360px 팀 간트에서 필터 밖 차단 업무를 열고 관계 변경을 즉시 반영한다', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const source = await f.issue(f.first, '필터 밖 승인', { startDate: null, endDate: null });
    const target = await f.issue(f.second, '차단된 통합');
    const related = await f.issue(f.first, '참고 관계');
    const closed = await f.issue(f.first, '완료된 승인', { status: 'done' });
    const local = await f.issue(f.second, '같은 프로젝트 선행', { startDate: '2026-11-20', endDate: '2026-11-20' });
    const activeRelation = await f.relation(source, target);
    const reference = await f.relation(related, target, 'related');
    const finished = await f.relation(closed, target);
    const internal = await f.relation(local, target);
    const dependency = await f.dependency(local, target);
    const before = await f.schedule();
    const hash = `${gantt(f.second)}&ganttProject=${f.second.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${hash}`);
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(f.prefix);
    await expect(row(page, source)).toHaveCount(0);
    await expect(row(page, target)).toBeVisible();
    const project = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await expect(project).toHaveValue(f.second.id);

    const panel = await openBlockers(page);
    await expect(issueButton(panel, target)).toBeVisible();
    await expect(issueButton(panel, source)).toBeVisible();
    for (const ignored of [related, closed, local]) await expect(issueButton(panel, ignored)).toHaveCount(0);
    const scoped = (await teamBlockers(request)).filter(item => item.sourceIssueId === target.id || item.targetIssueId === target.id);
    expect(scoped).toHaveLength(2);
    expect(scoped.map(item => item.id)).toEqual(expect.arrayContaining([activeRelation.id, finished.id]));
    expect(before.dependencies).toEqual([dependency]);
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    for (const issue of [target, source]) {
      await button(panel, `${issue.key} 간트 날짜로 이동`).click();
      await expect(page).toHaveURL(url => {
        const [path, query] = url.hash.split('?');
        const params = new URLSearchParams(query);
        return path === `#/${f.second.id}/gantt` && params.get('scope') === 'team' && params.get('ganttProject') === f.second.id &&
          params.get('ganttQ') === f.prefix && params.get('focusIssue') === issue.id && params.get('focusDate') === 'startDate';
      });
      const start = row(page, issue).getByLabel(`${issue.key} 시작일`, { exact: true });
      await expect(start).toBeFocused();
      await expect(start).toHaveValue(issue.startDate ?? '');
      if (issue.id === source.id) {
        const draft = '2026-11-20';
        const confirmation: string[] = [];
        await start.fill(draft);
        page.once('dialog', async dialog => { confirmation.push(dialog.message()); await dialog.dismiss(); });
        await button(panel, `${target.key} 간트 날짜로 이동`).click();
        expect(confirmation).toEqual([expect.stringContaining('저장하지 않은 간트 입력')]);
        await expect(start).toBeFocused();
        await expect(start).toHaveValue(draft);
        expect((await workspace(request)).issues.find(item => item.id === source.id)?.startDate).toBeNull();
        await start.press('Escape');
        await expect(start).toHaveValue('');
      }
      await button(page, '업무 위치 해제').click();
      await expect(page).toHaveURL(url => url.hash === ganttSearch(hash, f.prefix));
    }
    await expect(row(page, source)).toHaveCount(0);

    await issueButton(panel, source).click();
    const details = page.getByRole('dialog', { name: source.title, exact: true });
    const relations = details.getByRole('region', { name: '업무 관계', exact: true });
    await expect(details).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === `${ganttSearch(hash, f.prefix)}&issue=${source.id}`);
    await expect(relations.getByText('이 업무가 차단함', { exact: true })).toBeVisible();
    await expect(button(relations, `${target.key} 일정 연결 검토`)).toHaveCount(0);
    const relationUrl = `${relationsPath(source)}/${activeRelation.id}`;
    await button(relations, `${target.key} 관계 수정`).click();
    const edit = relations.getByRole('form', { name: '업무 관계 수정', exact: true });
    await edit.getByRole('combobox', { name: '업무 관계 유형', exact: true }).selectOption('related');
    const editing = waitMutation(page, relationUrl, 'PATCH');
    await button(edit, '관계 저장').click();
    const edited = await json<IssueRelation>(await editing);
    expect(edited).toMatchObject({ id: activeRelation.id, type: 'related' });
    await expect(relations.getByText('관련 업무', { exact: true })).toBeVisible();
    await button(details, '업무 상세 닫기').click();
    await expect(details).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === ganttSearch(hash, f.prefix));
    await expect(panel.getByText('현재 보기에 활성 차단 관계가 없습니다.', { exact: true })).toBeVisible();
    await expect(issueButton(panel, source)).toHaveCount(0);
    await expect(issueButton(panel, target)).toHaveCount(0);
    await expect(project).toHaveValue(f.second.id);

    await page.reload();
    await expect(project).toHaveValue(f.second.id);
    await openBlockers(page);
    await expect(issueButton(panel, source)).toHaveCount(0);
    const relationRows = await json<IssueRelation[]>(await request.get(relationsPath(target)));
    expect(relationRows.map(item => item.id)).toEqual(expect.arrayContaining([activeRelation.id, reference.id, finished.id, internal.id]));
    expect((await teamBlockers(request)).some(item => item.id === activeRelation.id)).toBe(false);
    expect(await f.schedule()).toEqual(before);
  } finally {
    await f.close();
  }
});

test('360px 팀 간트에서 다른 프로젝트의 차단 일정과 후행 업무를 검토하고 한 번에 되돌린다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const headers = { 'X-Actor-Id': f.actor.id };
  const calendarPath = `/api/projects/${f.second.id}/calendar`;
  const originalCalendar = await json<WorkCalendar>(await request.get(calendarPath));
  let calendar: WorkCalendar | undefined;
  try {
    calendar = await json<WorkCalendar>(await request.patch(calendarPath, { headers, data: {
      ...originalCalendar, expectedVersion: originalCalendar.version, workingWeekdays: [1, 2, 3, 4, 5], exceptions: [
        { date: '2026-11-21', isWorking: true, label: '토요일 작업' },
        { date: '2026-11-23', isWorking: false, label: '월요일 휴무' },
      ],
    } }));
    const source = await f.issue(f.first, '고정 승인 업무', { startDate: '2026-11-19', endDate: '2026-11-20', dueDate: '2026-11-26' });
    const target = await f.issue(f.second, '다른 프로젝트가 차단한 업무', { startDate: '2026-11-16', endDate: '2026-11-17', dueDate: '2026-11-30' });
    const downstream = await f.issue(f.second, '같은 프로젝트 후행 업무', { startDate: '2026-11-16', endDate: '2026-11-16', dueDate: '2026-11-27' });
    const handoff = await f.relation(source, target);
    const native = await f.dependency(target, downstream);
    const before = await f.schedule();
    const hash = `${gantt(f.first)}&ganttProject=${f.second.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${hash}`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await search.fill(f.prefix);
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill('2026-11-16');
    await expect(row(page, source)).toHaveCount(0);
    const panel = await openBlockers(page);
    const pair = panel.locator(`[data-team-blocker-id="${handoff.id}"]`);
    await expect(pair).toContainText(f.first.name);
    await expect(pair).toContainText(f.second.name);
    const reviewAction = button(pair, `${source.key} → ${target.key} 프로젝트 간 일정 검토`);
    const dialog = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    const previewPath = '/api/schedule/team-follow-up-preview';
    const applyPath = '/api/schedule/team-follow-up-apply';
    const issued: string[] = [];
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if (sent.method() === 'POST' && path.startsWith('/api/schedule/')) issued.push(path);
    });

    const initialStart = row(page, target).getByLabel(`${target.key} 시작일`, { exact: true });
    await initialStart.fill('2026-11-13');
    await reviewAction.click();
    await expect(page.getByText('작성 중인 간트 변경을 저장하거나 닫은 뒤 프로젝트 간 일정을 검토해 주세요.', { exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(initialStart).toBeFocused();
    await expect(initialStart).toHaveValue('2026-11-13');
    expect(issued).toEqual([]);
    expect(await f.schedule()).toEqual(before);
    await initialStart.press('Escape');
    await expect(initialStart).toHaveValue(target.startDate!);

    const started = waitMutation(page, previewPath);
    await reviewAction.click();
    const response = await started;
    expect(response.request().postDataJSON()).toEqual({ relationId: handoff.id, expectedVersion: handoff.version });
    const proposed = await json<AutomaticSchedulePreview>(response);
    expect(proposed.blocking).toEqual([]);
    expect(proposed.teamFollowUp).toEqual({ relationId: handoff.id, expectedVersion: handoff.version, sourceIssueId: source.id, targetIssueId: target.id,
      sourceEndDate: source.endDate, sourceSchedule: { version: source.version, startDate: source.startDate, endDate: source.endDate } });
    expect(proposed.calendarVersions?.[f.second.id]).toBe(calendar.version);
    expect(proposed.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual([
      [target.id, '2026-11-21', '2026-11-24'], [downstream.id, '2026-11-25', '2026-11-25'],
    ]);
    const dates = dialog.getByRole('table', { name: '검토할 업무 일정', exact: true });
    for (const issue of [target, downstream]) {
      const planned = dates.getByRole('row').filter({ hasText: issue.title });
      await expect(planned.locator(`[data-schedule-project="${f.second.id}"]`)).toHaveText(f.second.name);
    }
    await expect(dates.getByText(source.title, { exact: true })).toHaveCount(0);
    await expect(dialog).toContainText(`${source.key} → ${target.key}`);
    await expect(dialog).toContainText('기준 업무 종료일');
    await expect(dialog).toContainText(source.endDate!);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    expect(await f.schedule()).toEqual(before);

    let result: SchedulePasteApplyResult | undefined;
    await page.route(url => url.pathname === applyPath, async intercepted => {
      expect(intercepted.request().postDataJSON()).toEqual({ previewId: proposed.previewId });
      result = await json<SchedulePasteApplyResult>(await intercepted.fetch());
      await intercepted.abort('failed');
    }, { times: 1 });
    await button(dialog, '함께 적용').click();
    const retry = button(dialog, '적용 결과 다시 확인');
    await expect(retry).toBeVisible();
    const verified = waitMutation(page, `/api/schedule/team-follow-up-result/${proposed.previewId}`, 'GET');
    await retry.click();
    expect(await json<SchedulePasteApplyResult>(await verified)).toEqual(result);
    expect(issued).toEqual([previewPath, applyPath]);
    await expect(dialog).toHaveCount(0);
    await expect(reviewAction).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === ganttSearch(hash, f.prefix));
    await expect(search).toHaveValue(f.prefix);
    const committed = await f.schedule();
    expect(committed).toEqual({ dates: { ...before.dates,
      [target.id]: { startDate: '2026-11-21', endDate: '2026-11-24', dueDate: target.dueDate },
      [downstream.id]: { startDate: '2026-11-25', endDate: '2026-11-25', dueDate: downstream.dueDate },
    }, dependencies: [native] });
    await expect(row(page, target).getByLabel(`${target.key} 종료일`, { exact: true })).toHaveValue('2026-11-24');
    await expect(row(page, downstream).getByLabel(`${downstream.key} 시작일`, { exact: true })).toHaveValue('2026-11-25');

    const undo = waitMutation(page, '/api/schedule/undo');
    await button(page, '되돌리기').click();
    const restored = await undo;
    expect(restored.request().postDataJSON()).toEqual({ undoId: result?.undoId });
    await json<{ updated: Issue[] }>(restored);
    expect(await f.schedule()).toEqual(before);
    expect((await teamBlockers(request)).find(value => value.id === handoff.id)).toMatchObject({ sourceIssueId: source.id, targetIssueId: target.id });
    await expect(page.getByRole('combobox', { name: '프로젝트 필터', exact: true })).toHaveValue(f.second.id);
    await expect(initialStart).toHaveValue(target.startDate!);
  } finally {
    try { await f.close(); }
    finally {
      if (calendar) await json<WorkCalendar>(await request.patch(calendarPath, { headers, data: { ...originalCalendar, expectedVersion: calendar.version } }));
    }
  }
});

test('360px에서 선행 날짜를 편집하고 동시 수정 확인 후 모든 연결 일정을 함께 적용한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const previewPath = '/api/schedule/team-follow-up-preview';
  const applyPath = '/api/schedule/team-follow-up-apply';
  const headers = { 'X-Actor-Id': f.actor.id };
  try {
    const source = await f.issue(f.first, '날짜를 수정할 선행', { startDate: '2026-11-19', endDate: '2026-11-20' });
    const target = await f.issue(f.second, '프로젝트 간 후행', { startDate: '2026-11-16', endDate: '2026-11-17' });
    const local = await f.issue(f.first, '같은 프로젝트의 다른 갈래', { startDate: '2026-11-16', endDate: '2026-11-16' });
    const relation = await f.relation(source, target);
    await f.dependency(source, local);
    const hash = `${gantt(f.first)}&ganttProject=${f.second.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    const automaticRefresh = (url: URL) => url.pathname === '/api/workspace' && url.searchParams.has('ganttSince');
    await page.route(automaticRefresh, route => route.fulfill({ status: 204 }));
    await page.goto(`/${hash}`);
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(f.prefix);
    const panel = await openBlockers(page);
    const pair = panel.locator(`[data-team-blocker-id="${relation.id}"]`);
    const review = button(pair, `${source.key} → ${target.key} 프로젝트 간 일정 검토`);
    const dialog = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    const start = dialog.getByLabel('선행 업무 시작일', { exact: true });
    const end = dialog.getByLabel('선행 업무 종료일', { exact: true });
    const apply = button(dialog, '함께 적용');
    const recalculate = button(dialog, '미리보기 다시 계산');
    await expect(review).toBeVisible();
    const savedBeforeOpen = await json<Issue>(await request.patch(`/api/issues/${source.id}`, { headers,
      data: { expectedVersion: source.version, endDate: '2026-11-23' },
    }));
    const before = await f.schedule();
    const opening = waitMutation(page, previewPath);
    await review.click();
    const opened = await opening;
    expect(opened.request().postDataJSON()).toEqual({ relationId: relation.id, expectedVersion: relation.version });
    const originalPreview = await json<AutomaticSchedulePreview>(opened);
    expect(originalPreview.teamFollowUp?.sourceSchedule).toEqual({
      version: savedBeforeOpen.version, startDate: savedBeforeOpen.startDate, endDate: savedBeforeOpen.endDate,
    });
    expect(originalPreview.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual([[target.id, '2026-11-24', '2026-11-25']]);
    await expect(start).toHaveValue(savedBeforeOpen.startDate!);
    await expect(end).toHaveValue(savedBeforeOpen.endDate!);
    await page.unroute(automaticRefresh);
    await start.fill('2026-11-24');
    await end.fill('2026-11-25');
    await expect(apply).toBeDisabled();
    const dismissed = page.waitForEvent('dialog');
    const staying = button(dialog, '돌아가기').click();
    const confirm = await dismissed;
    expect(confirm.message()).toContain('수정한 선행 업무 일정');
    await confirm.dismiss();
    await staying;
    await expect(start).toHaveValue('2026-11-24');
    await expect(end).toHaveValue('2026-11-25');
    expect(await f.schedule()).toEqual(before);

    await button(dialog, '저장된 날짜로 되돌리기').click();
    await expect(start).toHaveValue(savedBeforeOpen.startDate!);
    await expect(end).toHaveValue(savedBeforeOpen.endDate!);
    await end.fill('2026-11-25');
    const firstReviewing = waitMutation(page, previewPath);
    await recalculate.click();
    const firstReview = await firstReviewing;
    expect(firstReview.request().postDataJSON().anchorChange).toEqual({
      id: source.id, expectedVersion: savedBeforeOpen.version, startDate: savedBeforeOpen.startDate, endDate: '2026-11-25',
    });
    const proposed = await json<AutomaticSchedulePreview>(firstReview);
    expect(proposed.changes.map(change => change.id)).toHaveLength(3);
    expect(proposed.changes.map(change => change.id)).toEqual(expect.arrayContaining([source.id, target.id, local.id]));
    await expect(apply).toBeEnabled();

    const updated = await json<Issue>(await request.patch(`/api/issues/${source.id}`, { headers,
      data: { expectedVersion: savedBeforeOpen.version, startDate: '2026-11-20' },
    }));
    const afterEdit = await f.schedule();
    const staleResponse = waitMutation(page, applyPath);
    await apply.click();
    expect((await staleResponse).status()).toBe(409);
    await expect(dialog.getByText(/^최신 선행 업무 일정.*2026-11-20/)).toBeVisible();
    await expect(apply).toBeDisabled();
    await button(dialog, '최신 일정 기준으로 다시 검토').click();
    await expect(start).toHaveValue(updated.startDate!);
    await expect(end).toHaveValue('2026-11-25');
    await expect(apply).toBeDisabled();
    expect(await f.schedule()).toEqual(afterEdit);

    const revising = waitMutation(page, previewPath);
    await recalculate.click();
    const reviewed = await revising;
    expect(reviewed.request().postDataJSON().anchorChange).toEqual({
      id: source.id, expectedVersion: updated.version, startDate: updated.startDate, endDate: '2026-11-25',
    });
    const latest = await json<AutomaticSchedulePreview>(reviewed);
    expect(latest.blocking).toEqual([]);
    const dates = dialog.getByRole('table', { name: '검토할 업무 일정', exact: true });
    for (const issue of [source, target, local]) {
      await expect(dates.getByRole('row').filter({ hasText: issue.title })
        .locator(`[data-schedule-project="${issue.projectId}"]`)).toBeVisible();
    }
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const writes: unknown[] = [];
    let result: SchedulePasteApplyResult | undefined;
    await page.route(url => url.pathname === applyPath, async intercepted => {
      writes.push(intercepted.request().postDataJSON());
      result = await json<SchedulePasteApplyResult>(await intercepted.fetch());
      await intercepted.abort('failed');
    });
    await apply.click();
    const retry = button(dialog, '적용 결과 다시 확인');
    await expect(retry).toBeVisible();
    const recovering = waitMutation(page, `/api/schedule/team-follow-up-result/${latest.previewId}`, 'GET');
    await retry.click();
    expect(await json<SchedulePasteApplyResult>(await recovering)).toEqual(result);
    expect(writes).toEqual([{ previewId: latest.previewId }]);
    await expect(dialog).toHaveCount(0);
    await expect(review).toBeFocused();
    expect((await f.schedule()).dates).toEqual({
      [source.id]: { startDate: updated.startDate, endDate: '2026-11-25', dueDate: source.dueDate },
      [target.id]: { startDate: '2026-11-26', endDate: '2026-11-27', dueDate: target.dueDate },
      [local.id]: { startDate: '2026-11-26', endDate: '2026-11-26', dueDate: local.dueDate },
    });
    const undo = waitMutation(page, '/api/schedule/undo');
    await button(page, '되돌리기').click();
    await json(await undo);
    expect(await f.schedule()).toEqual(afterEdit);
    await expect(page).toHaveURL(url => url.hash === ganttSearch(hash, f.prefix));
  } finally { await f.close(); }
});

test('360px 팀 간트에서 날짜 초안을 프로젝트 간 일정 검토에 넘기고 함께 저장한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const previewPath = '/api/schedule/team-follow-up-preview';
  const applyPath = '/api/schedule/team-follow-up-apply';
  const undoPath = '/api/schedule/undo';
  try {
    const source = await f.issue(f.first, '종료일 초안을 가진 선행 업무', { startDate: '2026-11-19', endDate: '2026-11-20', dueDate: '2026-11-26' });
    const target = await f.issue(f.second, '필터 밖 차단 대상', { startDate: '2026-11-16', endDate: '2026-11-17' });
    const downstream = await f.issue(f.second, '필터 밖 후행 업무', { startDate: '2026-11-16', endDate: '2026-11-16' });
    const handoff = await f.relation(source, target);
    await f.dependency(target, downstream);
    const before = await f.schedule();
    const hash = `${gantt(f.first)}&ganttProject=${f.first.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${hash}`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await search.fill(f.prefix);
    await expect(row(page, target)).toHaveCount(0);
    await expect(row(page, downstream)).toHaveCount(0);
    const paths: string[] = [];
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if (sent.method() === 'POST' && path.startsWith('/api/schedule/')) paths.push(path);
    });

    const sourceEnd = row(page, source).getByLabel(`${source.key} 종료일`, { exact: true });
    const review = button(row(page, source), `${source.key} 프로젝트 간 일정 검토`);
    const dialog = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    const apply = button(dialog, '함께 적용');
    const nextEnd = '2026-11-25';
    const anchorChange = { id: source.id, expectedVersion: source.version, startDate: source.startDate, endDate: nextEnd };
    await sourceEnd.fill(nextEnd);

    async function openReview() {
      await expect(review).toBeVisible();
      const [response] = await Promise.all([waitMutation(page, previewPath), review.click()]);
      expect(response.request().postDataJSON()).toEqual({ relationId: handoff.id, expectedVersion: handoff.version, anchorChange });
      const preview = await json<AutomaticSchedulePreview>(response);
      await expect(dialog.getByLabel('선행 업무 시작일', { exact: true })).toHaveValue(source.startDate!);
      await expect(dialog.getByLabel('선행 업무 종료일', { exact: true })).toHaveValue(nextEnd);
      await expect(apply).toBeEnabled();
      return preview;
    }

    await openReview();
    await button(dialog, '돌아가기').click();
    await expect(dialog).toHaveCount(0);
    await expect(review).toBeFocused();
    await expect(sourceEnd).toHaveValue(nextEnd);
    expect(await f.schedule()).toEqual(before);
    expect(paths).toEqual([previewPath]);

    const preview = await openReview();
    expect(preview.blocking).toEqual([]);
    expect(preview.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual([
      [source.id, source.startDate, nextEnd], [target.id, '2026-11-26', '2026-11-27'], [downstream.id, '2026-11-30', '2026-11-30'],
    ]);
    const [response] = await Promise.all([waitMutation(page, applyPath), apply.click()]);
    expect(response.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    const applied = await json<SchedulePasteApplyResult>(response);
    expect(applied.updated.map(({ id, version }) => [id, version])).toEqual(
      [source, target, downstream].map(issue => [issue.id, issue.version + 1]),
    );
    await expect(dialog).toHaveCount(0);
    await expect(review).toHaveCount(0);
    await expect(sourceEnd).toHaveValue(nextEnd);
    expect(await f.schedule()).toEqual({ dates: { ...before.dates,
      [source.id]: { ...before.dates[source.id], endDate: nextEnd },
      [target.id]: { ...before.dates[target.id], startDate: '2026-11-26', endDate: '2026-11-27' },
      [downstream.id]: { ...before.dates[downstream.id], startDate: '2026-11-30', endDate: '2026-11-30' },
    }, dependencies: before.dependencies });

    const [restored] = await Promise.all([waitMutation(page, undoPath), button(page, '되돌리기').click()]);
    expect(restored.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    await json(restored);
    expect(paths).toEqual([previewPath, previewPath, applyPath, undoPath]);
    expect(await f.schedule()).toEqual(before);
    expect((await teamBlockers(request)).find(item => item.id === handoff.id)).toMatchObject({ sourceIssueId: source.id, targetIssueId: target.id });
    await expect(sourceEnd).toHaveValue(source.endDate!);
    await expect(search).toHaveValue(f.prefix);
    await expect(page).toHaveURL(url => url.hash === ganttSearch(hash, f.prefix));

    const restoredSource = (await workspace(request)).issues.find(issue => issue.id === source.id)!;
    await sourceEnd.fill(nextEnd);
    const peer = await json<Issue>(await request.patch(`/api/issues/${source.id}`, { headers: { 'X-Actor-Id': f.actor.id },
      data: { expectedVersion: restoredSource.version, endDate: nextEnd },
    }));
    const [stale] = await Promise.all([waitMutation(page, previewPath), review.click()]);
    expect(stale.status()).toBe(409);
    await button(dialog, '최신 일정 기준으로 다시 검토').click();
    const [recalculated] = await Promise.all([waitMutation(page, previewPath), button(dialog, '미리보기 다시 계산').click()]);
    expect(recalculated.request().postDataJSON().anchorChange).toEqual({ ...anchorChange, expectedVersion: peer.version });
    const followerPreview = await json<AutomaticSchedulePreview>(recalculated);
    expect(followerPreview.changes.map(change => change.id)).toEqual([target.id, downstream.id]);
    const [onlyFollowers] = await Promise.all([waitMutation(page, applyPath), apply.click()]);
    expect((await json<SchedulePasteApplyResult>(onlyFollowers)).updated.map(issue => issue.id)).toEqual([target.id, downstream.id]);
    await expect(dialog).toHaveCount(0);
    await expect(review).toHaveCount(0);
    await expect(sourceEnd).toHaveValue(nextEnd);
    const [followersUndone] = await Promise.all([waitMutation(page, undoPath), button(page, '되돌리기').click()]);
    await json(followersUndone);
    expect(await f.schedule()).toEqual({ ...before, dates: { ...before.dates, [source.id]: { ...before.dates[source.id], endDate: nextEnd } } });
  } finally { await f.close(); }
});

test('360px 프로젝트 간트의 차트 날짜 미리보기에서 다른 프로젝트 후행 업무를 고를 수 있다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const manualPath = '/api/schedule/manual-preview';
  const teamPath = '/api/schedule/team-follow-up-preview';
  try {
    const source = await f.issue(f.first, '차트에서 날짜를 바꿀 선행', { startDate: '2026-11-19', endDate: '2026-11-20' });
    const first = await f.issue(f.second, '첫 번째 차단 대상', { startDate: '2026-11-16', endDate: '2026-11-16' });
    const second = await f.issue(f.second, '두 번째 차단 대상', { startDate: '2026-11-16', endDate: '2026-11-17' });
    await f.relation(source, first);
    const chosen = await f.relation(source, second);
    const before = await f.schedule();
    const hash = `#/${f.first.id}/gantt`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), f.actor.id);
    await page.goto(`/${hash}`);
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(f.prefix);
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill('2026-11-18');
    await expect(row(page, first)).toHaveCount(0);
    await expect(row(page, second)).toHaveCount(0);
    const paths: string[] = [];
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if (sent.method() === 'POST' && path.startsWith('/api/schedule/')) paths.push(path);
    });
    const picker = button(row(page, source), `${source.key} 차트에서 날짜 선택`);
    const startDate = '2026-11-23', endDate = '2026-11-25';
    await picker.click();
    await button(row(page, source), `${source.key} ${startDate} 선택`).click();
    const [manualResponse] = await Promise.all([waitMutation(page, manualPath),
      button(row(page, source), `${source.key} ${endDate} 선택`).click()]);
    await json(manualResponse);

    const manual = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const review = button(manual, '프로젝트 간 일정 검토');
    const chooser = page.getByRole('dialog', { name: '후행 업무 선택', exact: true });
    await review.click();
    await expect(button(chooser, `${first.key} 일정 검토`)).toBeVisible();
    await expect(button(chooser, `${second.key} 일정 검토`)).toBeVisible();
    await expect(chooser).toContainText(f.second.name);
    await button(chooser, '취소').click();
    await expect(chooser).toHaveCount(0);
    await expect(review).toBeFocused();
    expect(paths).toEqual([manualPath]);
    expect(await f.schedule()).toEqual(before);

    await review.click();
    const [response] = await Promise.all([waitMutation(page, teamPath), button(chooser, `${second.key} 일정 검토`).click()]);
    expect(response.request().postDataJSON()).toEqual({ relationId: chosen.id, expectedVersion: chosen.version,
      anchorChange: { id: source.id, expectedVersion: source.version, startDate, endDate } });
    const preview = await json<AutomaticSchedulePreview>(response);
    expect(preview.changes).toHaveLength(3);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: source.id, toStart: startDate, toEnd: endDate }),
      expect.objectContaining({ id: first.id, toStart: '2026-11-26', toEnd: '2026-11-26' }),
      expect.objectContaining({ id: second.id, toStart: '2026-11-26', toEnd: '2026-11-27' }),
    ]));
    const dialog = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    await expect(dialog).toContainText(`${source.key} → ${second.key}`);
    await expect(dialog.getByLabel('선행 업무 시작일', { exact: true })).toHaveValue(startDate);
    await expect(dialog.getByLabel('선행 업무 종료일', { exact: true })).toHaveValue(endDate);
    await expect(button(dialog, '함께 적용')).toBeEnabled();
    await button(dialog, '돌아가기').click();
    await expect(dialog).toHaveCount(0);
    await expect(review).toBeFocused();
    await expect(manual.locator('.gantt-new-dates')).toHaveText(new RegExp(`${startDate}\\s*${endDate}`));
    expect(paths).toEqual([manualPath, teamPath]);
    expect(await f.schedule()).toEqual(before);
    await button(manual, '취소').click();
    await expect(picker).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === hash);
  } finally { await f.close(); }
});
