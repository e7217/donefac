import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Dependency, Issue, Project, SchedulePastePreview, SchedulePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const friday = '2026-11-20';
const monday = '2026-11-23';
const tuesday = '2026-11-24';
const end = '2026-11-26';
const name = '전체 프로젝트 간트';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const calendarPath = (project: Project) => `/api/projects/${project.id}/calendar`;
const button = (within: Locator | Page, label: string) => within.getByRole('button', { name: label, exact: true });
const chart = (page: Page) => page.getByRole('region', { name: '간트 차트', exact: true });
const row = (page: Page, issue: Issue) => chart(page).locator(`[data-issue-id="${issue.id}"]`);
const projectOption = (project: Project) => `${project.key} · ${project.name}`;
const route = (project: Project) => `#/${project.id}/gantt`;

function location(page: Page) {
  const [path, query] = new URL(page.url()).hash.split('?');
  const params = new URLSearchParams(query);
  return { path, scope: params.get('scope'), project: params.get('ganttProject'), issue: params.get('issue') };
}

function waitPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `팀 일정 ${randomUUID().slice(0, 8)}`;
  const issueIds: string[] = [];
  let calendarBackup: WorkCalendar | undefined;
  const readCalendar = async (project: Project) => json<WorkCalendar>(await request.get(calendarPath(project), { headers }));
  return {
    first, second, actor, prefix, readCalendar,
    async mondayOff() {
      const before = await readCalendar(second);
      const changed = await json<WorkCalendar>(await request.patch(calendarPath(second), {
        headers, data: {
          ...before, workingWeekdays: [1, 2, 3, 4, 5], expectedVersion: before.version,
          exceptions: [...before.exceptions.filter(exception => exception.date !== monday && exception.date !== tuesday),
            { date: monday, isWorking: false, label: prefix }],
        },
      }));
      calendarBackup = before;
      return changed;
    },
    async issue(project: Project, title: string, startDate = friday, endDate = friday) {
      const created = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: project.id, title: `${prefix} ${title}`, startDate, endDate, assigneeId: actor.id, plannedEffortMinutes: 120 },
      }), 201);
      issueIds.push(created.id);
      return created;
    },
    async link(predecessor: Issue, successor: Issue) {
      return json<Dependency>(await request.post('/api/dependencies', {
        headers, data: { predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0 },
      }), 201);
    },
    async close() {
      try {
        for (const id of issueIds.reverse()) {
          const response = await request.delete(`/api/issues/${id}`, { headers });
          if (!response.ok()) continue;
          const { trashEntryId } = await response.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`, { headers });
        }
      } finally {
        if (calendarBackup) {
          const latest = await readCalendar(second);
          await json<WorkCalendar>(await request.patch(calendarPath(second), {
            headers, data: { ...calendarBackup, expectedVersion: latest.version },
          }));
        }
      }
    },
  };
}

async function narrow(page: Page, prefix: string) {
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(prefix);
  await page.getByLabel('간트 표시 시작일', { exact: true }).fill('2026-11-18');
}

test('전체 프로젝트 간트는 프로젝트 필터를 유지하고 각 달력으로 함께 일정을 이동한다', async ({ page, request }) => {
  const data = await fixture(request);
  try {
    await data.mondayOff();
    const first = await data.issue(data.first, '첫 프로젝트 업무');
    const second = await data.issue(data.second, '둘째 프로젝트 업무');
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), data.actor.id);
    await page.goto(`/#/${data.first.id}/overview`);
    await button(page, name).click();
    await narrow(page, data.prefix);
    await expect.poll(() => location(page)).toEqual({ path: route(data.first), scope: 'team', project: null, issue: null });
    const filter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const all = await filter.inputValue();
    await expect(filter.getByRole('option', { name: projectOption(data.first), exact: true })).toHaveAttribute('value', data.first.id);
    await expect(filter.getByRole('option', { name: projectOption(data.second), exact: true })).toHaveAttribute('value', data.second.id);
    await expect(row(page, first).locator('.gantt-row-project')).toHaveText(data.first.key);
    await expect(row(page, second).locator('.gantt-row-project')).toHaveText(data.second.key);
    await expect(chart(page).locator('.gantt-weekend-band')).toHaveCount(0);

    await filter.selectOption(data.second.id);
    const filtered = { path: route(data.first), scope: 'team', project: data.second.id, issue: null };
    await expect.poll(() => location(page)).toEqual(filtered);
    await expect(row(page, first)).toHaveCount(0);
    const mondayHeader = chart(page).locator(`.gantt-days [data-date="${monday}"]`);
    await expect(mondayHeader).toHaveClass(/\bweekend\b/);
    await page.goBack();
    await expect(filter).toHaveValue(all);
    await expect(row(page, first)).toBeVisible();
    await page.goForward();
    await expect(filter).toHaveValue(data.second.id);
    await expect.poll(() => location(page)).toEqual(filtered);
    await row(page, second).locator('.gantt-issue-name').click();
    const detail = page.getByRole('dialog', { name: second.title, exact: true });
    await expect(detail).toBeVisible();
    await expect.poll(() => location(page)).toEqual({ ...filtered, issue: second.id });
    await page.reload();
    await expect(detail).toBeVisible();
    await expect.poll(() => location(page)).toEqual({ ...filtered, issue: second.id });
    await button(detail, '업무 상세 닫기').click();
    await expect(detail).toHaveCount(0);
    await expect.poll(() => location(page)).toEqual(filtered);
    await expect(filter).toHaveValue(data.second.id);
    await expect(row(page, first)).toHaveCount(0);
    await expect(row(page, second)).toBeVisible();

    await filter.selectOption(all);
    await narrow(page, data.prefix);
    await expect.poll(() => location(page)).toEqual({ ...filtered, project: null });
    await expect(chart(page).locator('.gantt-weekend-band')).toHaveCount(0);
    for (const issue of [first, second]) {
      await row(page, issue).getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }).check();
    }
    await button(page, '2개 일정 이동').click();
    await page.getByRole('spinbutton', { name: '이동 일수', exact: true }).fill('1');
    await page.getByRole('checkbox', { name: '근무일 기준', exact: true }).check();
    const preview = waitPost(page, '/api/schedule/manual-preview');
    await button(page, '변경 미리보기').click();
    const previewResponse = await preview;
    expect(previewResponse.request().postDataJSON()).toEqual({ issueIds: expect.arrayContaining([first.id, second.id]), days: 1, workingDays: true });
    const proposed = await json<SchedulePreview>(previewResponse);
    expect(proposed.previewId).toBeTruthy();
    expect(proposed.changes).toHaveLength(2);
    expect(proposed.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, fromStart: friday, fromEnd: friday, toStart: monday, toEnd: monday }),
      expect.objectContaining({ id: second.id, fromStart: friday, fromEnd: friday, toStart: tuesday, toEnd: tuesday }),
    ]));
    const review = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const comparison = review.getByRole('combobox', { name: '업무량 비교 프로젝트', exact: true });
    await expect(comparison.getByRole('option', { name: projectOption(data.first), exact: true })).toHaveAttribute('value', data.first.id);
    await comparison.selectOption(data.second.id);
    await expect(review.getByRole('region', { name: '일정 미리보기 업무량 비교', exact: true })).toBeVisible();
    const applied = waitPost(page, '/api/schedule/manual-apply');
    await button(review, '변경 적용').click();
    const saved = await applied;
    expect(saved.ok(), await saved.text()).toBeTruthy();
    expect(saved.request().postDataJSON()).toEqual({ previewId: proposed.previewId });
    await expect(review).toHaveCount(0);
    const current = (await workspace(request)).issues;
    expect(current.find(issue => issue.id === first.id)).toMatchObject({ startDate: monday, endDate: monday });
    expect(current.find(issue => issue.id === second.id)).toMatchObject({ startDate: tuesday, endDate: tuesday });

    const undo = waitPost(page, '/api/schedule/undo');
    await button(page, '되돌리기').click();
    const restored = await undo;
    expect(restored.ok(), await restored.text()).toBeTruthy();
    for (const issue of [first, second]) {
      await expect(page.getByLabel(`${issue.key} 시작일`, { exact: true })).toHaveValue(friday);
      await expect(page.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(friday);
    }

    await row(page, first).getByRole('checkbox', { name: `${first.key} 선택`, exact: true }).uncheck();
    await expect(row(page, second).getByRole('checkbox', { name: `${second.key} 선택`, exact: true })).toBeChecked();
    await button(page, '일정 일괄 편집').click();
    const bulk = page.getByRole('dialog', { name: '일정 일괄 편집', exact: true });
    await bulk.getByLabel('종료일 변경', { exact: true }).selectOption('set');
    await bulk.getByLabel('종료일 값', { exact: true }).fill(end);
    const bulkPreview = waitPost(page, '/api/schedule/bulk-dates/preview');
    await button(bulk, '날짜 변경 미리보기').click();
    const bulkResponse = await bulkPreview;
    expect(bulkResponse.request().postDataJSON()).toEqual({
      projectId: null, issues: [{ id: second.id, expectedVersion: expect.any(Number) }], changes: { endDate: end },
    });
    const bulkPlan = await json<SchedulePastePreview>(bulkResponse);
    expect(bulkPlan).toMatchObject({ projectId: null, projectIds: [data.second.id], errors: [], changes: [{ id: second.id, toEnd: end }] });
    const bulkApply = waitPost(page, '/api/schedule/bulk-dates/apply');
    await button(bulk, '검토한 일정 적용').click();
    const appliedBulk = await bulkApply;
    expect(appliedBulk.ok(), await appliedBulk.text()).toBeTruthy();
    await expect(bulk).toHaveCount(0);
    await expect(page.getByLabel(`${first.key} 종료일`, { exact: true })).toHaveValue(friday);
    await expect(page.getByLabel(`${second.key} 종료일`, { exact: true })).toHaveValue(end);
    await expect.poll(() => location(page)).toEqual({ ...filtered, project: null });
  } finally {
    await data.close();
  }
});

test('360px 전체 프로젝트 간트에서 자체 달력과 같은 프로젝트 연결로 둘째 프로젝트 일정을 편집한다', async ({ page, request }) => {
  const data = await fixture(request);
  try {
    await data.mondayOff();
    const foreign = await data.issue(data.first, '다른 프로젝트의 선행 후보');
    const predecessor = await data.issue(data.second, '같은 프로젝트의 선행 후보');
    const anchor = await data.issue(data.second, '둘째 프로젝트 연결 편집', monday, end);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), data.actor.id);
    await page.goto(`/${route(data.first)}?scope=team`);
    await narrow(page, data.prefix);
    await expect.poll(() => location(page)).toEqual({ path: route(data.first), scope: 'team', project: null, issue: null });
    await expect(row(page, foreign).locator('.gantt-row-project')).toHaveText(data.first.key);
    await expect(row(page, anchor).locator('.gantt-row-project')).toHaveText(data.second.key);

    const opener = button(row(page, anchor), `${anchor.key} 일정과 연결 편집`);
    await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const link = dialog.getByRole('group', { name: '연결 변경 1', exact: true });
    await link.getByLabel('선후행 연결 작업', { exact: true }).selectOption('add');
    const lookup = link.getByRole('textbox', { name: '연결할 업무 검색', exact: true });
    await lookup.fill(data.prefix);
    await expect(button(link, `${foreign.key} · ${foreign.title}`)).toHaveCount(0);
    const candidate = button(link, `${predecessor.key} · ${predecessor.title}`);
    await expect(candidate).toBeVisible();
    await lookup.press('ArrowDown');
    await expect(candidate).toBeFocused();
    await candidate.press('Enter');
    await expect(dialog.locator('.gantt-row-edit-suggestion')).toContainText(tuesday);
    await button(dialog, '가장 이른 날짜 사용').click();
    await expect(dialog.getByLabel('시작일', { exact: true })).toHaveValue(tuesday);

    const preview = waitPost(page, '/api/schedule/row-edit/preview');
    await button(dialog, '변경 미리보기').click();
    const response = await preview;
    expect(response.request().postDataJSON()).toMatchObject({
      projectId: data.second.id, issue: { id: anchor.id, expectedVersion: anchor.version }, changes: { startDate: tuesday },
      dependency: { action: 'add', direction: 'predecessor', relatedIssue: { id: predecessor.id, expectedVersion: predecessor.version } },
    });
    const proposed = await json<SchedulePastePreview>(response);
    expect(proposed.projectId).toBe(data.second.id);
    expect(proposed.errors).toEqual([]);
    const apply = waitPost(page, '/api/schedule/row-edit/apply');
    await button(dialog, '일정과 연결 적용').click();
    expect((await apply).ok()).toBeTruthy();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel(`${anchor.key} 시작일`, { exact: true })).toHaveValue(tuesday);

    const saved = await workspace(request);
    expect(saved.issues.find(issue => issue.id === anchor.id)).toMatchObject({ startDate: tuesday, endDate: end });
    expect(saved.issues.find(issue => issue.id === foreign.id)).toEqual(foreign);
    expect(saved.dependencies.filter(dependency => dependency.successorId === anchor.id || dependency.predecessorId === anchor.id)).toMatchObject([
      { predecessorId: predecessor.id, successorId: anchor.id, type: 'FS', lagDays: 0 },
    ]);
  } finally {
    await data.close();
  }
});

test('전체 프로젝트 간트는 연결마다 프로젝트 달력으로 충돌을 검사하고 날짜로 이동한다', async ({ page, request }) => {
  const data = await fixture(request);
  try {
    await data.mondayOff();
    const firstPredecessor = await data.issue(data.first, '첫 프로젝트 선행');
    const firstSuccessor = await data.issue(data.first, '첫 프로젝트 후행', monday, end);
    const secondPredecessor = await data.issue(data.second, '둘째 프로젝트 선행');
    const secondSuccessor = await data.issue(data.second, '둘째 프로젝트 후행', monday, end);
    const valid = await data.link(firstPredecessor, firstSuccessor);
    const conflict = await data.link(secondPredecessor, secondSuccessor);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), data.actor.id);
    await page.goto(`/${route(data.first)}?scope=team`);
    await narrow(page, data.prefix);

    const connector = (dependency: Dependency) => chart(page).locator(`[data-dependency-id="${dependency.id}"]`);
    await expect(connector(valid)).toHaveCount(1);
    await expect(connector(valid)).not.toHaveAttribute('data-dependency-conflict', 'true');
    await expect(connector(conflict)).toHaveAttribute('data-dependency-conflict', 'true');

    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await search.fill(secondPredecessor.title);
    await expect(row(page, secondSuccessor)).toHaveCount(0);
    await button(page, '일정 충돌').click();
    const panel = page.getByRole('region', { name: '일정 충돌', exact: true });
    const list = panel.getByRole('list', { name: '일정 점검 항목', exact: true });
    const label = `${secondSuccessor.key} 시작일 수정`;
    const finding = list.getByRole('listitem').filter({ has: button(page, label) });
    await expect(button(list, `${firstSuccessor.key} 시작일 수정`)).toHaveCount(0);
    await expect(finding.getByText(monday, { exact: true })).toBeVisible();
    await expect(finding.getByText(tuesday, { exact: true })).toBeVisible();
    await button(finding, label).click();

    const focusedRoute = `${route(data.first)}?scope=team&focusIssue=${secondSuccessor.id}&focusDate=startDate`;
    await expect(page).toHaveURL(url => url.hash === focusedRoute);
    const start = row(page, secondSuccessor).getByLabel(`${secondSuccessor.key} 시작일`, { exact: true });
    await expect(start).toBeFocused();
    await expect(start).toHaveValue(monday);
    await button(page, '업무 위치 해제').click();
    await expect(page).toHaveURL(url => url.hash === `${route(data.first)}?scope=team`);
    await expect(search).toHaveValue(secondPredecessor.title);
    await expect(row(page, secondSuccessor)).toHaveCount(0);
  } finally {
    await data.close();
  }
});
