import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { AutomationRule, AutomationRun, Dependency, DocPage, GitlabSettings, Issue, IssueViewGitlabFilter, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types';
import { projectWorkflow } from '../../shared/workflow-helpers';

const settingsPath = '/api/integrations/gitlab';
const board = (page: Page) => page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
const card = (page: Page, issue: Issue, category?: string) => (category ? board(page).locator(`[data-status-category="${category}"]`) : board(page))
  .locator(`[data-issue-id="${issue.id}"]`);
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });
const search = (page: Page) => page.getByLabel('보드 업무 검색', { exact: true });
const closeDetails = (details: Locator) => button(details, '업무 상세 닫기');
const boardRefresh = (page: Page) => button(page, '팀 보드 새로고침');
const workspaceUrl = (url: URL) => url.pathname === '/api/workspace';
const conditionalUrl = (url: URL) => workspaceUrl(url) && url.searchParams.has('teamBoardSince');
const fullWorkspaceUrl = (url: URL) => workspaceUrl(url) && !conditionalUrl(url);
const condition = (response: Response, status: number) => conditionalUrl(new URL(response.url())) && response.status() === status;

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const snapshot = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function purge(request: APIRequestContext, path: string, headers: Record<string, string>) {
  const deleted = await json<{ trashEntryId: string }>(await request.delete(path, { headers }));
  expect((await request.delete(`/api/trash/${deleted.trashEntryId}`, { headers })).ok()).toBeTruthy();
}

async function openBoard(page: Page, route: string, actorId: string) {
  await page.clock.install();
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  await page.goto(`/${route}`);
  await expect(board(page)).toBeVisible();
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
}

test('GitLab 병합 후 열린 360px 팀 보드와 간트, 문서가 같은 업무 상태를 읽는다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const { projects: [base, project], users: [actor] } = await snapshot(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const query = `병합 인수 ${suffix}`;
  const doneStatus = { id: `merged_${suffix}`, label: `병합 확인 완료 ${suffix}`, category: 'done', color: '#478270' } as const;
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const originalWorkflow = await json<ProjectWorkflow>(await request.get(workflowPath));
  const originalSettings = await json<GitlabSettings>(await request.get(settingsPath));
  expect(originalSettings.baseUrl).toBe('');
  const baseUrl = 'https://gitlab.example.test';
  const webhookSecret = `synthetic-board-${randomUUID()}`;
  const repositoryId = 42;
  const dates = { startDate: '2031-11-03', endDate: '2031-11-04' };
  const created: Issue[] = [];
  let rule: AutomationRule | undefined;
  let view: SavedView | undefined;
  let document: DocPage | undefined;
  let reader: Page | undefined;

  try {
    await json<ProjectWorkflow>(await request.patch(workflowPath, { headers, data: {
      ...originalWorkflow, expectedVersion: originalWorkflow.version, statuses: [...originalWorkflow.statuses, doneStatus],
      transitions: [...originalWorkflow.transitions, { from: 'in_progress', to: doneStatus.id, issueTypes: [], requiredFields: [] }],
    } }));
    const create = async (title: string, status: string, schedule: typeof dates, projectId = project.id) => {
      const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
        projectId, title: `${query} ${title}`, status, assigneeId: actor.id, ...schedule,
      } }), 201);
      created.push(issue);
      return issue;
    };
    const ticket = await create('MR 검증', 'in_progress', dates);
    const successor = await create('다음 작업', 'todo', { startDate: '2031-11-05', endDate: '2031-11-07' });
    const foreign = await create('프로젝트 필터 비교', 'in_progress', dates, base.id);
    const link = await json<Dependency>(await request.post('/api/dependencies', { headers, data: {
      predecessorId: ticket.id, successorId: successor.id, type: 'FS', lagDays: 0,
    } }), 201);
    view = await json<SavedView>(await request.post('/api/views', { headers, data: {
      projectId: project.id, name: query, layout: 'list', filters: { query: ticket.title, status: 'all', assigneeId: 'all', type: 'all' },
    } }), 201);
    document = await json<DocPage>(await request.post('/api/documents', { headers, data: {
      projectId: project.id, title: `${query} 업무 문서`, content: { type: 'doc', content: [
        { type: 'issueList', attrs: { projectId: project.id, savedViewId: view.id, label: view.name } },
      ] },
    } }), 201);
    await json<GitlabSettings>(await request.patch(settingsPath, { headers, data: {
      expectedVersion: originalSettings.version, baseUrl, projectIds: [repositoryId], webhookSecret,
    } }));
    rule = await json<AutomationRule>(await request.post('/api/automation-rules', { headers, data: {
      projectId: project.id, name: query, trigger: 'merge_request.merged', enabled: false, gitlabProjectIds: [repositoryId],
      branchPattern: 'feature/*', issueTypes: [], fromStatuses: [ticket.status], toStatusId: doneStatus.id, actorId: actor.id, priority: 100,
    } }), 201);
    rule = await json<AutomationRule>(await request.patch(`/api/automation-rules/${rule.id}`, {
      headers, data: { expectedVersion: rule.version, enabled: true },
    }));
    expect(rule.enabled).toBe(true);

    reader = await page.context().newPage();
    await reader.goto(`/#/${project.id}/documents/${document.id}`);
    const list = reader.getByRole('region', { name: '업무 목록', exact: true });
    const referenced = button(list, `목록 업무 열기 ${ticket.key} ${ticket.title}`).locator('.doc-issue-list-status');
    const initialStatus = originalWorkflow.statuses.find(status => status.id === ticket.status)!;
    await expect(referenced).toHaveText(initialStatus.label);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.bringToFront();
    const route = `#/${base.id}/teamboard?${new URLSearchParams({ boardProject: project.id, boardMember: actor.id, boardQuery: query })}`;
    const unchanged = page.waitForResponse(response => condition(response, 204));
    await openBoard(page, route, actor.id);
    await expect(card(page, ticket, 'in_progress').locator('[data-board-status]')).toHaveText(initialStatus.label);
    await expect(card(page, foreign)).toHaveCount(0);
    await page.clock.runFor(15_100);
    const cheapReply = await unchanged;
    expect(cheapReply.headers()['content-length'] ?? '0').toBe('0');
    expect(new URL(cheapReply.url()).searchParams.get('teamBoardSince')).toMatch(/^[a-f0-9]{32}$/u);
    await search(page).focus();

    const branch = `feature/${ticket.key}`;
    const hook = await request.post(`${settingsPath}/webhook`, { headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() }, data: {
      object_kind: 'merge_request', project: { id: repositoryId }, object_attributes: {
        id: 773, iid: 773, action: 'merge', state: 'merged', title: `${ticket.key} synthetic MR`, source_branch: branch,
        url: `${baseUrl}/team/project/-/merge_requests/773`, updated_at: new Date().toISOString(),
      },
    } });
    expect(await json<{ linked: number }>(hook)).toMatchObject({ linked: 1 });
    const afterMerge = await snapshot(request);
    expect(afterMerge.issues.find(issue => issue.id === ticket.id)).toMatchObject({ ...dates, status: doneStatus.id, version: ticket.version + 1 });
    expect(afterMerge.dependencies.find(dependency => dependency.id === link.id)).toEqual(link);
    const runs = await json<AutomationRun[]>(await request.get(`/api/automation-runs?projectId=${project.id}`));
    expect(runs.filter(run => run.ruleId === rule!.id)).toEqual([expect.objectContaining({ issueId: ticket.id, outcome: 'changed', toStatus: doneStatus.id })]);

    const changed = page.waitForResponse(response => condition(response, 200));
    await page.clock.runFor(15_100);
    expect((await json<WorkspaceSnapshot>(await changed)).issues.find(issue => issue.id === ticket.id)?.status).toBe(doneStatus.id);
    await expect(card(page, ticket, 'done').locator('[data-board-status]')).toHaveText(doneStatus.label);
    await expect(card(page, ticket, 'in_progress')).toHaveCount(0);
    await expect(card(page, foreign)).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === route);
    await expect(search(page)).toHaveValue(query);
    await expect(search(page)).toBeFocused();

    await button(card(page, ticket), `${ticket.key} 업무 열기`).click();
    const detail = page.getByRole('dialog', { name: ticket.title, exact: true });
    const merge = detail.locator('.gitlab-activity-row[data-gitlab-kind="merge_request"][data-gitlab-state="merged"]');
    await expect(merge).toContainText(`${ticket.key} synthetic MR`);
    await button(detail, '간트에서 일정 보기').click();
    await expect(page).toHaveURL(url => {
      const [path, search] = url.hash.split('?');
      const params = new URLSearchParams(search);
      return path === `#/${base.id}/gantt` && params.get('scope') === 'team' && params.get('ganttProject') === project.id &&
        params.get('ganttAssignee') === actor.id && params.get('ganttQ') === query && params.get('focusIssue') === ticket.id;
    });
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await page.getByRole('checkbox', { name: '완료 업무 숨기기', exact: true }).uncheck();
    await expect(page.getByLabel('간트 업무 검색', { exact: true })).toHaveValue(query);
    const row = chart.locator(`[data-issue-id="${ticket.id}"]`);
    await expect(row.getByLabel(`${ticket.key} 시작일`, { exact: true })).toHaveValue(dates.startDate);
    await expect(row.getByLabel(`${ticket.key} 종료일`, { exact: true })).toHaveValue(dates.endDate);
    await expect(chart.locator(`[data-dependency-id="${link.id}"]`)).toHaveCount(1);

    await expect(referenced).toHaveText(initialStatus.label);
    await button(reader, '참조 새로고침').click();
    await expect(referenced).toHaveText(doneStatus.label);
    expect((await snapshot(request)).documents.find(item => item.id === document!.id)).toEqual(document);
  } finally {
    if (reader) await reader.close();
    if (rule) expect((await request.delete(`/api/automation-rules/${rule.id}?expectedVersion=${rule.version}`, { headers })).ok()).toBeTruthy();
    if (document) await purge(request, `/api/documents/${document.id}`, headers);
    if (view) expect((await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`, { headers })).ok()).toBeTruthy();
    for (const issue of created.reverse()) await purge(request, `/api/issues/${issue.id}`, headers);
    const currentWorkflow = await json<ProjectWorkflow>(await request.get(workflowPath));
    if (currentWorkflow.version !== originalWorkflow.version) await json<ProjectWorkflow>(await request.patch(workflowPath, {
      headers, data: { ...originalWorkflow, expectedVersion: currentWorkflow.version },
    }));
    const current = await json<GitlabSettings>(await request.get(settingsPath));
    if (current.baseUrl === baseUrl) await json<GitlabSettings>(await request.patch(settingsPath, { headers, data: {
      expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
    } }));
  }
});

test('팀 보드 갱신을 편집 동안 멈추고 다시 열어 낡은 쓰기를 막으며 수동 실패 후 재시도한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const workspace = await snapshot(request);
  const { projects: [base, project], users: [actor], restoreGeneration } = workspace;
  const workflowVersion = projectWorkflow(workspace, project.id).version;
  const headers = { 'X-Actor-Id': actor.id };
  const query = `갱신 충돌 ${randomUUID().slice(0, 8)}`;
  const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
    projectId: project.id, title: query, status: 'in_progress', assigneeId: actor.id,
  } }), 201);
  const path = `/api/issues/${issue.id}`;
  const route = `#/${base.id}/teamboard?${new URLSearchParams({ boardProject: project.id, boardMember: actor.id, boardQuery: query })}`;
  const polls: string[] = [];
  page.on('request', sent => { if (conditionalUrl(new URL(sent.url()))) polls.push(sent.url()); });
  try {
    const unchanged = page.waitForResponse(response => condition(response, 204));
    await openBoard(page, route, actor.id);
    await page.clock.runFor(15_100);
    await unchanged;

    const chooser = page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
    const destination = chooser.getByRole('combobox', { name: '변경할 상태', exact: true });
    await button(card(page, issue), `${issue.key} 상태 변경`).click();
    await destination.selectOption('review');
    const pausedAt = polls.length;
    const changed = await json<Issue>(await request.patch(path, { headers, data: {
      expectedVersion: issue.version, title: `${query} 최신 제목`,
    } }));
    await page.clock.runFor(31_000);
    expect(polls).toHaveLength(pausedAt);
    await expect(destination).toHaveValue('review');
    const stale = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/status-change` && response.request().method() === 'POST');
    await button(chooser, '상태 변경 적용').click();
    const rejected = await stale;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON()).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), restoreGeneration,
      expectedVersion: issue.version, expectedWorkflowVersion: workflowVersion, status: 'review' });
    await expect(chooser.getByRole('alert')).toBeVisible();
    await expect(destination).toHaveValue('review');
    const resume = page.waitForResponse(response => condition(response, 200));
    await button(chooser, '상태 변경 닫기').click();
    await resume;
    await expect(card(page, issue, 'in_progress')).toContainText(changed.title);
    await expect(page).toHaveURL(url => url.hash === route);

    await button(card(page, issue), `${issue.key} 업무 열기`).click();
    const detail = page.getByRole('dialog', { name: changed.title, exact: true });
    const description = detail.getByLabel('설명', { exact: true });
    await description.fill('아직 저장하지 않은 설명');
    const pausedWithDetail = polls.length;
    const reviewing = await json<Issue>(await request.patch(path, { headers, data: { expectedVersion: changed.version, status: 'review' } }));
    await page.clock.runFor(31_000);
    expect(polls).toHaveLength(pausedWithDetail);
    page.once('dialog', dialog => dialog.dismiss());
    await closeDetails(detail).click();
    await expect(description).toHaveValue('아직 저장하지 않은 설명');
    expect(polls).toHaveLength(pausedWithDetail);
    const resumeAfterDetail = page.waitForResponse(response => condition(response, 200));
    page.once('dialog', dialog => dialog.accept());
    await closeDetails(detail).click();
    await resumeAfterDetail;
    await expect(card(page, issue, 'review')).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === route);
    expect((await snapshot(request)).issues.find(item => item.id === issue.id)).toEqual(reviewing);

    const done = await json<Issue>(await request.patch(path, { headers, data: { expectedVersion: reviewing.version, status: 'done' } }));
    await page.route(fullWorkspaceUrl, route => route.fulfill({ status: 503, json: { error: 'synthetic workspace read failure' } }), { times: 1 });
    const failed = page.waitForResponse(response => fullWorkspaceUrl(new URL(response.url())) && response.status() === 503);
    await boardRefresh(page).click();
    await failed;
    const failure = page.getByRole('alert').filter({ hasText: '팀 보드를 새로고침하지 못했습니다.' });
    await expect(failure).toBeVisible();
    await expect(card(page, issue, 'review')).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === route);

    const retried = page.waitForResponse(response => fullWorkspaceUrl(new URL(response.url())) && response.status() === 200);
    await boardRefresh(page).click();
    expect((await json<WorkspaceSnapshot>(await retried)).issues.find(item => item.id === issue.id)).toEqual(done);
    await expect(failure).toHaveCount(0);
    await expect(card(page, issue, 'done')).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === route);
    await expect(search(page)).toHaveValue(query);
  } finally {
    await purge(request, path, headers);
  }
});

test('업무 상세를 여는 동안 도착한 이전 보드 응답이 저장 전 설명을 닫지 않는다', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { projects: [base, project], users: [actor] } = await snapshot(request);
  const headers = { 'X-Actor-Id': actor.id };
  const query = `보드 응답 지연 ${randomUUID().slice(0, 8)}`;
  const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
    projectId: project.id, title: query, status: 'in_progress', assigneeId: actor.id,
  } }), 201);
  const path = `/api/issues/${issue.id}`;
  const route = `#/${base.id}/teamboard?${new URLSearchParams({ boardProject: project.id, boardQuery: query })}`;
  const captured = Promise.withResolvers<WorkspaceSnapshot>();
  const release = Promise.withResolvers<void>();
  let archivedId: string | undefined;
  try {
    const unchanged = page.waitForResponse(response => condition(response, 204));
    await openBoard(page, route, actor.id);
    await page.clock.runFor(15_100);
    await unchanged;
    await expect(card(page, issue)).toBeVisible();

    ({ trashEntryId: archivedId } = await json<{ trashEntryId: string }>(await request.delete(path, { headers })));
    await page.route(fullWorkspaceUrl, async intercepted => {
      try {
        const response = await intercepted.fetch();
        captured.resolve(await json<WorkspaceSnapshot>(response));
        await release.promise;
        await intercepted.fulfill({ response }).catch(() => undefined);
      } catch (error) { captured.reject(error); }
    }, { times: 1 });

    await boardRefresh(page).click();
    expect((await captured.promise).issues.some(value => value.id === issue.id)).toBe(false);
    const aborted = page.waitForEvent('requestfailed', sent => fullWorkspaceUrl(new URL(sent.url())));
    await button(card(page, issue), `${issue.key} 업무 열기`).click();
    const detail = page.getByRole('dialog', { name: issue.title, exact: true });
    const description = detail.getByLabel('설명', { exact: true });
    await description.fill('원격 보관 전까지 입력한 설명');
    const detailRoute = new URL(page.url()).hash;
    expect(new URLSearchParams(detailRoute.split('?')[1]).get('issue')).toBe(issue.id);
    release.resolve();
    expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
    await expect(description).toHaveValue('원격 보관 전까지 입력한 설명');
    await expect(page).toHaveURL(url => url.hash === detailRoute);

    const resumed = page.waitForResponse(response => condition(response, 200));
    page.once('dialog', dialog => dialog.accept());
    await closeDetails(detail).click();
    await resumed;
    await expect(detail).toHaveCount(0);
    await expect(card(page, issue)).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === route);
    await expect(search(page)).toHaveValue(query);
  } finally {
    release.resolve();
    if (archivedId) expect((await request.delete(`/api/trash/${archivedId}`, { headers })).ok()).toBeTruthy();
    else await purge(request, path, headers);
  }
});

test('360px 팀 보드의 GitLab 조건은 프로젝트·담당자·검색과 함께 공유되고 최신 파이프라인으로 갱신된다', async ({ page, request, context }) => {
  test.setTimeout(95_000);
  const { projects: [base, other], users: [actor, peer] } = await snapshot(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const query = `팀 GitLab 검토 ${suffix}`;
  const url = 'https://gitlab.example.test';
  const secret = `synthetic-team-board-filter-${randomUUID()}`;
  const repositories = [42, 43] as const;
  const original = await json<GitlabSettings>(await request.get(settingsPath));
  expect(original.baseUrl).toBe('');
  const dates = { startDate: '2031-11-03', endDate: '2031-11-04' };
  const created: Issue[] = [];
  const create = async (projectId: string, title: string, assigneeId = actor.id) => {
    const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
      projectId, title, assigneeId, status: 'in_progress', ...dates,
    } }), 201);
    created.push(issue);
    return issue;
  };
  const branch = (issue: Issue) => `feature/${issue.key}`;
  const start = Date.now() - 60_000;
  const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const send = async (repository: number, object_kind: 'pipeline' | 'merge_request', object_attributes: object) => {
    const response = await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() }, data: {
        object_kind, project: { id: repository, web_url: `${url}/team/repository-${repository}` }, object_attributes,
      },
    });
    expect(await json<{ linked: number; duplicate: boolean }>(response)).toMatchObject({ linked: 1, duplicate: false });
  };
  const pipeline = (repository: number, issue: Issue, id: number, status: string, elapsed: number) =>
    send(repository, 'pipeline', { id, ref: branch(issue), status, updated_at: at(elapsed) });
  const mergeRequest = (repository: number, issue: Issue, id: number, detailed_merge_status: string) =>
    send(repository, 'merge_request', {
      id, iid: id, action: 'open', state: 'opened', title: `${issue.key} 합성 검토`, sha: 'a'.repeat(40),
      source_branch: branch(issue), detailed_merge_status, url: `${url}/team/repository-${repository}/-/merge_requests/${id}`, updated_at: at(8),
    });
  const boardPath = `#/${base.id}/teamboard`;
  const filters = () => Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split('?')[1]));
  const gitlab = page.getByRole('combobox', { name: 'GitLab 조건', exact: true });
  const project = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
  const member = page.getByRole('combobox', { name: '담당자 필터', exact: true });
  async function rows(expected: Issue[]) {
    await expect(board(page).locator('[data-issue-id]')).toHaveCount(expected.length);
    for (const issue of expected) await expect(card(page, issue)).toBeVisible();
  }

  try {
    await json<GitlabSettings>(await request.patch(settingsPath, { headers, data: {
      expectedVersion: original.version, baseUrl: url, projectIds: repositories, webhookSecret: secret,
    } }));
    const west = await create(base.id, `${query} 첫 프로젝트 병합과 실패`);
    const failed = await create(other.id, `${query} 선택한 파이프라인 실패`);
    const blocked = await create(other.id, `${query} 병합 충돌`);
    const running = await create(base.id, `${query} 실행 중`);
    const unlinked = await create(other.id, `${query} 개발 활동 없음`);
    const assignedElsewhere = await create(other.id, `${query} 다른 담당자 실패`, peer.id);
    const offQuery = await create(other.id, `검색 제외 ${suffix} 실패`);
    await mergeRequest(42, west, 601, 'mergeable');
    await mergeRequest(43, blocked, 602, 'conflict');
    await pipeline(42, west, 701, 'failed', 10);
    await pipeline(43, failed, 702, 'failed', 11);
    await pipeline(42, running, 703, 'running', 12);
    await pipeline(43, assignedElsewhere, 704, 'failed', 13);
    await pipeline(43, offQuery, 705, 'failed', 14);

    await page.setViewportSize({ width: 360, height: 820 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const queryString = new URLSearchParams({ boardQuery: query, boardGitlab: 'invalid-filter' });
    await openBoard(page, `${boardPath}?${queryString}`, actor.id);
    await expect.poll(filters).toEqual({ boardQuery: query });
    await expect(gitlab).toHaveValue('');
    await rows([west, failed, blocked, running, unlinked, assignedElsewhere]);
    const cases: [IssueViewGitlabFilter, Issue[]][] = [
      ['open_merge_request', [west, blocked]], ['merge_blocked', [blocked]], ['running_pipeline', [running]],
      ['no_activity', [unlinked]], ['failed_pipeline', [west, failed, assignedElsewhere]],
    ];
    for (const [filter, expected] of cases) {
      await gitlab.selectOption(filter);
      await expect.poll(filters).toEqual({ boardQuery: query, boardGitlab: filter });
      await rows(expected);
    }
    await project.selectOption(other.id);
    await rows([failed, assignedElsewhere]);
    await member.selectOption({ label: actor.name });
    await rows([failed]);
    const shared = { boardProject: other.id, boardMember: actor.id, boardQuery: query, boardGitlab: 'failed_pipeline' };
    await expect.poll(filters).toEqual(shared);

    await button(page, '보드 링크 복사').click();
    await expect(page.getByText('보드 링크를 복사했습니다.', { exact: true })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const clipboard = new URL(copied);
    expect(clipboard.hash.split('?')[0]).toBe(boardPath);
    expect(Object.fromEntries(new URLSearchParams(clipboard.hash.split('?')[1]))).toEqual(shared);
    await page.goto(`/#/${base.id}/overview`);
    await page.goto(copied);
    await page.reload();
    await expect.poll(filters).toEqual(shared);
    await expect(gitlab).toHaveValue('failed_pipeline');
    await expect(project).toHaveValue(other.id);
    await expect(member.locator('option:checked')).toHaveText(actor.name);
    await expect(search(page)).toHaveValue(query);
    await rows([failed]);

    const open = button(card(page, failed), `${failed.key} 업무 열기`);
    await open.click();
    const detail = page.getByRole('dialog', { name: failed.title, exact: true });
    await expect(detail.locator('.gitlab-activity-row[data-gitlab-kind="pipeline"][data-gitlab-state="failed"]')).toHaveCount(1);
    await expect.poll(filters).toEqual({ ...shared, issue: failed.id });
    await button(detail, '간트에서 일정 보기').click();
    await expect(page).toHaveURL(value => value.hash.startsWith(`#/${base.id}/gantt?`));
    await expect.poll(filters).toEqual({ scope: 'team', ganttProject: other.id, ganttAssignee: actor.id,
      ganttQ: query, ganttGitlab: 'failed_pipeline', focusIssue: failed.id });
    const gantt = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(gantt.getByLabel(`${failed.key} 시작일`, { exact: true })).toHaveValue(dates.startDate);
    await page.goBack();
    await expect(detail).toBeVisible();
    await expect.poll(filters).toEqual({ ...shared, issue: failed.id });
    const settled = page.waitForResponse(response => condition(response, 204));
    await closeDetails(detail).click();
    await settled;
    await expect.poll(filters).toEqual(shared);
    await open.focus();
    await expect(open).toBeFocused();

    const live = page.waitForResponse(response => condition(response, 200));
    // The newest pipeline by GitLab object ID may have an older update timestamp than a failed run.
    await pipeline(43, failed, 706, 'success', 9);
    await page.clock.runFor(15_100);
    await live;
    await rows([]);
    await expect(board(page)).toBeFocused();
    await expect.poll(filters).toEqual(shared);
    await expect(gitlab).toHaveValue('failed_pipeline');
    const current = await snapshot(request);
    expect(current.gitlabLinks.filter(link => link.issueId === failed.id && link.kind === 'pipeline')
      .map(link => [link.iid, link.state]).sort()).toEqual([[702, 'failed'], [706, 'success']]);
    expect(current.issues.find(issue => issue.id === failed.id)).toEqual(failed);
  } finally {
    for (const issue of created) await purge(request, `/api/issues/${issue.id}`, headers);
    const active = await json<GitlabSettings>(await request.get(settingsPath));
    if (active.baseUrl === url) await json<GitlabSettings>(await request.patch(settingsPath, { headers, data: {
      expectedVersion: active.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
    } }));
  }
});

test('응답이 멈춘 팀 보드 새로고침을 중단하고 같은 필터에서 다시 조회한다', async ({ page, request }) => {
  const { projects: [project], users: [actor] } = await snapshot(request);
  const headers = { 'X-Actor-Id': actor.id };
  const query = `보드 요청 시간 초과 ${randomUUID().slice(0, 8)}`;
  const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
    projectId: project.id, title: query, status: 'in_progress', assigneeId: actor.id,
  } }), 201);
  const path = `/api/issues/${issue.id}`;
  const route = `#/${project.id}/teamboard?${new URLSearchParams({ boardQuery: query })}`;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const unchanged = page.waitForResponse(response => condition(response, 204));
    await openBoard(page, route, actor.id);
    await page.clock.runFor(15_100);
    await unchanged;
    await expect(card(page, issue, 'in_progress')).toBeVisible();
    await json<Issue>(await request.patch(path, { headers, data: { expectedVersion: issue.version, status: 'review' } }));
    await page.route(fullWorkspaceUrl, async intercepted => {
      try {
        const response = await intercepted.fetch();
        held.resolve();
        await release.promise;
        await intercepted.fulfill({ response }).catch(() => undefined);
      } catch (error) { held.reject(error); }
    }, { times: 1 });

    const aborted = page.waitForEvent('requestfailed', sent => fullWorkspaceUrl(new URL(sent.url())));
    await boardRefresh(page).click();
    await held.promise;
    await page.clock.runFor(12_100);
    expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
    release.resolve();
    await expect(page.getByRole('alert')).toContainText('팀 보드를 새로고침하지 못했습니다.');
    await expect(card(page, issue, 'in_progress')).toBeVisible();
    await expect(boardRefresh(page)).toBeEnabled();

    await boardRefresh(page).click();
    await expect(card(page, issue, 'review')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === route);
    await expect(search(page)).toHaveValue(query);
    await expect(boardRefresh(page)).toBeFocused();
  } finally {
    release.resolve();
    await purge(request, path, headers);
  }
});
