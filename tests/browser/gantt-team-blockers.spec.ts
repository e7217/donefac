import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Dependency, Issue, IssueRelation, Project, TeamScheduleBlocker, WorkspaceSnapshot } from '../../shared/types';

const title = '프로젝트 간 차단';
const blockersPath = '/api/schedule/team-blockers';
const relationsPath = (issue: Issue) => `/api/issues/${issue.id}/relations`;
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });
const blockerPanel = (page: Page) => page.getByRole('region', { name: title, exact: true });
const issueButton = (panel: Locator, issue: Issue) => button(panel, `${issue.key} 업무 열기`);
const gantt = (project: Project) => `#/${project.id}/gantt?scope=team`;
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
    async issue(project: Project, label: string, fields: Partial<Pick<Issue, 'startDate' | 'endDate' | 'status'>> = {}) {
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
    await page.route(`**${relationsPath(source)}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push(route.request().postDataJSON());
      committed = await json<IssueRelation>(await route.fetch(), 201);
      await route.abort('failed');
    });
    await button(form, '차단 관계 저장').click();
    await expect(form).toHaveCount(0);
    await expect(issueButton(panel, source)).toBeVisible();
    await expect(issueButton(panel, target)).toBeVisible();
    expect(writes).toEqual([{ otherIssueId: target.id, type: 'blocks', direction: 'outgoing' }]);
    expect(committed).toMatchObject({ origin: 'teamspace', type: 'blocks', sourceIssueId: source.id, targetIssueId: target.id });
    await expect(panel).toContainText(f.first.name);
    await expect(panel).toContainText(f.second.name);
    await expect(page).toHaveURL(url => url.hash === hash);
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
          params.get('focusIssue') === issue.id && params.get('focusDate') === 'startDate';
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
      await expect(page).toHaveURL(url => url.hash === hash);
    }
    await expect(row(page, source)).toHaveCount(0);

    await issueButton(panel, source).click();
    const details = page.getByRole('dialog', { name: source.title, exact: true });
    const relations = details.getByRole('region', { name: '업무 관계', exact: true });
    await expect(details).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === `${hash}&issue=${source.id}`);
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
    await expect(page).toHaveURL(url => url.hash === hash);
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
