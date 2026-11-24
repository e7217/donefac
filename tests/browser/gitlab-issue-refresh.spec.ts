import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Response } from '@playwright/test';
import type { AutomationRule, GitlabIssueRefreshResult, GitlabLink, GitlabSettings, GitlabSyncResult, Issue, IssueAutomationRunPage, Project, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const rulesPath = '/api/automation-rules';

async function json<T>(response: APIResponse | Response, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(expected);
  return JSON.parse(body) as T;
}

test('360px 티켓에서 GitLab 상태 확인으로 누락된 병합을 읽고 한 항목의 조회 실패에서 복구한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const unique = randomUUID();
  const token = `synthetic-gitlab-read-${unique}`;
  const secret = `synthetic-gitlab-webhook-${unique}`;
  const upstreamError = `upstream-only-error-${unique}`;
  const repositoryId = 42;
  const repositoryPath = 'team/review/checkout';
  const apiPath = `/forge/api/v4/projects/${repositoryId}`;
  const mrPath = `${apiPath}/merge_requests/11`;
  const pipelinePath = `${apiPath}/pipelines/802`;
  const epoch = Date.now() - 60_000;
  const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settings = async () => json<GitlabSettings>(await request.get(settingsPath));
  const { projects: [project] } = await workspace();
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const createIssue = async (subject: string) => json<Issue>(await request.post('/api/issues', {
    data: { projectId: project.id, title: `${subject} ${unique.slice(0, 8)}` },
  }), 201);
  const issue = await createIssue('병합 상태 확인');
  const other = await createIssue('별도 개발 활동');
  const mergeTitle = `${issue.key} 변경 검토`;
  const stalePipeline = '실행 중';
  const branch = `feature/${issue.key}`;
  const runHistoryPath = `/api/automation-runs?projectId=${encodeURIComponent(project.id)}`;
  const refreshPath = `/api/issues/${issue.id}/gitlab-links/refresh`;
  const calls: { path: string; method?: string; token?: string | string[] }[] = [];
  let baseUrl = '';
  let pipelineUnavailable = true;
  let releaseMerge: () => void = () => {};
  const heldMerge = new Promise<void>(resolve => { releaseMerge = resolve; });
  const repoUrl = () => `${baseUrl}/${repositoryPath}`;
  const mrUrl = (iid: number) => `${repoUrl()}/-/merge_requests/${iid}`;
  const pipelineUrl = () => `${repoUrl()}/-/pipelines/802`;
  const mock = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', 'http://fixture.test').pathname;
    calls.push({ path, method: incoming.method, token: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (path === apiPath) {
      response.end(JSON.stringify({ id: repositoryId, path_with_namespace: repositoryPath, web_url: repoUrl() }));
    } else if (path === mrPath) {
      void heldMerge.then(() => {
        if (!response.destroyed) response.end(JSON.stringify({ id: 744, iid: 11, project_id: repositoryId,
          target_project_id: repositoryId, title: mergeTitle, state: 'merged', source_branch: branch,
          updated_at: at(20), web_url: mrUrl(11) }));
      });
    } else if (path === pipelinePath) {
      if (pipelineUnavailable) response.writeHead(503).end(JSON.stringify({ message: `${upstreamError} ${token}` }));
      else response.end(JSON.stringify({ id: 802, project_id: repositoryId, status: 'success', ref: branch,
        updated_at: at(21), web_url: pipelineUrl() }));
    } else {
      response.writeHead(404).end('{}');
    }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;
  let rule: AutomationRule | undefined;
  try {
    await json(await request.patch(settingsPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    rule = await json<AutomationRule>(await request.post(rulesPath, { data: {
      projectId: project.id, name: `병합 후 완료 ${unique.slice(0, 8)}`, enabled: true, trigger: 'merge_request.merged',
      gitlabProjectIds: [repositoryId], branchPattern: branch, issueTypes: [], fromStatuses: [issue.status], toStatusId: 'done',
    } }), 201);
    expect(rule.enabled).toBe(true);

    const webhook = async (kind: 'merge_request' | 'pipeline', attributes: object) =>
      json<{ linked: number }>(await request.post(`${settingsPath}/webhook`, {
        headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
        data: { object_kind: kind, project: { id: repositoryId, web_url: repoUrl() }, object_attributes: attributes },
      }));
    await expect(webhook('merge_request', {
      id: 744, iid: 11, target_project_id: repositoryId, title: mergeTitle, state: 'opened', action: 'open',
      source_branch: branch, url: mrUrl(11), updated_at: at(1),
    })).resolves.toMatchObject({ linked: 1 });
    await expect(webhook('pipeline', {
      id: 802, status: 'running', ref: branch, url: pipelineUrl(), updated_at: at(2),
    })).resolves.toMatchObject({ linked: 1 });
    await expect(webhook('merge_request', {
      id: 745, iid: 12, target_project_id: repositoryId, title: `${other.key} 별도 검토`, state: 'opened', action: 'open',
      source_branch: `feature/${other.key}`, url: mrUrl(12), updated_at: at(3),
    })).resolves.toMatchObject({ linked: 1 });

    const before = await workspace();
    const merge = before.gitlabLinks.find(link => link.issueId === issue.id && link.kind === 'merge_request')!;
    const pipeline = before.gitlabLinks.find(link => link.issueId === issue.id && link.kind === 'pipeline')!;
    const unrelated = before.gitlabLinks.find(link => link.issueId === other.id)!;
    expect(merge).toMatchObject({ state: 'opened' });
    expect(pipeline).toMatchObject({ state: 'running' });
    expect(unrelated).toMatchObject({ iid: 12, state: 'opened' });
    const runs = await json(await request.get(runHistoryPath));

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
    const refresh = gitlab.getByRole('button', { name: 'GitLab에서 상태 확인', exact: true });
    const issueTitle = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const mr = gitlab.getByRole('region', { name: 'MR', exact: true }).getByRole('listitem');
    const pipelineRow = gitlab.getByRole('region', { name: '파이프라인', exact: true }).getByRole('listitem');
    await expect(mr).toHaveAttribute('data-gitlab-state', 'opened');
    await expect(pipelineRow).toContainText(stalePipeline);
    await issueTitle.fill('저장하지 않은 티켓 제목');
    await comment.fill('전송하지 않은 댓글 본문');
    expect(calls).toEqual([]);

    const result = () => page.waitForResponse(response => new URL(response.url()).pathname === refreshPath &&
      response.request().method() === 'POST');
    const first = result();
    await refresh.press('Enter');
    await expect.poll(() => calls.some(call => call.path === mrPath)).toBe(true);
    await expect(refresh).toBeDisabled();
    await expect(gitlab.getByRole('button', { name: 'GitLab 링크 추가', exact: true })).toBeDisabled();
    releaseMerge();

    const partial = await first;
    expect(partial.request().postDataJSON()).toEqual({});
    const checked = await json<GitlabIssueRefreshResult>(partial);
    expect(checked.links).toMatchObject([{ id: merge.id, state: 'merged' }]);
    expect(checked.failures).toMatchObject([{ linkId: pipeline.id, message: expect.stringContaining('503') }]);
    expect(JSON.stringify(checked)).not.toContain(upstreamError);
    expect(JSON.stringify(checked)).not.toContain(token);
    await expect(mr).toHaveAttribute('data-gitlab-state', 'merged');
    await expect(pipelineRow).toHaveAttribute('data-gitlab-state', 'running');
    await expect(gitlab.getByRole('status').filter({ hasText: 'GitLab 활동' })).toContainText('1건은 확인하지 못했습니다.');
    const failures = gitlab.getByRole('list', { name: '확인하지 못한 활동', exact: true });
    await expect(failures.getByRole('listitem')).toHaveCount(1);
    await expect(failures).toContainText('503');
    await expect(failures).not.toContainText(upstreamError);
    await expect(failures).not.toContainText(token);
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
    await expect(issueTitle).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('전송하지 않은 댓글 본문');

    let failWorkspaceRead = false;
    let failedWorkspaceReads = 0;
    await page.route('**/api/workspace', async route => {
      if (failWorkspaceRead && route.request().method() === 'GET') {
        failWorkspaceRead = false;
        failedWorkspaceReads++;
        await route.fulfill({ status: 503, json: { error: '합성 작업 공간 조회 실패' } });
      } else await route.continue();
    });
    await page.route(`**${refreshPath}`, async route => {
      const response = await route.fetch();
      if (response.ok()) failWorkspaceRead = true;
      await route.fulfill({ response });
    });
    pipelineUnavailable = false;
    const retrying = result();
    await refresh.click();
    expect((await retrying).status()).toBe(200);
    await expect(pipelineRow).toHaveAttribute('data-gitlab-state', 'success');
    await expect(failures).toHaveCount(0);
    const workspaceError = gitlab.getByRole('alert').filter({ hasText: '작업 공간을 다시 불러오지 못했습니다.' });
    await expect(workspaceError).toContainText('확인한 GitLab 상태를 저장했습니다.');
    expect(failedWorkspaceReads).toBe(1);

    const checkedCalls = calls.length;
    await gitlab.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true }).click();
    await expect(workspaceError).toHaveCount(0);
    await expect(pipelineRow).toHaveAttribute('data-gitlab-state', 'success');
    expect(calls).toHaveLength(checkedCalls);
    await expect(panel.getByRole('combobox', { name: '상태', exact: true })).toHaveValue(issue.status);
    await expect(issueTitle).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('전송하지 않은 댓글 본문');

    const saved = await workspace();
    expect(saved.gitlabLinks.find(link => link.id === merge.id)).toMatchObject({ state: 'merged' });
    expect(saved.gitlabLinks.find(link => link.id === pipeline.id)).toMatchObject({ state: 'success' });
    expect(saved.gitlabLinks.find(link => link.id === unrelated.id)).toEqual(unrelated);
    expect(saved.issues.find(value => value.id === issue.id)).toMatchObject({ title: issue.title, status: issue.status, version: issue.version });
    expect(await json(await request.get(runHistoryPath))).toEqual(runs);
    expect(new Set(calls.map(call => call.path))).toEqual(new Set([apiPath, mrPath, pipelinePath]));
    expect(calls.every(call => call.method === 'GET' && call.token === token)).toBe(true);
  } finally {
    releaseMerge();
    try {
      if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`);
      for (const item of [issue, other]) {
        const deleted = await request.delete(`/api/issues/${item.id}`);
        if (deleted.ok()) {
          const { trashEntryId } = await deleted.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});

test('360px 티켓의 GitLab 상태 제안을 검토하고 초안과 워크플로 조건을 유지해 저장한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const unique = randomUUID();
  const repositoryId = 42;
  const pipelineId = 953;
  const token = `synthetic-pipeline-review-${unique}`;
  const secret = `synthetic-pipeline-suggestion-${unique}`;
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settings = async () => json<GitlabSettings>(await request.get(settingsPath));
  const { users: [editor, automationActor] } = await workspace();
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const projectKey = `GR${unique.slice(0, 7).toUpperCase()}`;
  const project = await json<Project>(await request.post('/api/projects', { data: { key: projectKey, name: `${projectKey} GitLab 상태 검토` } }), 201);
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const workflow = await json<ProjectWorkflow>(await request.get(workflowPath));
  await json<ProjectWorkflow>(await request.patch(workflowPath, { data: { ...workflow, expectedVersion: workflow.version,
    fieldRules: [{ issueType: '*', statusId: 'done', requiredFields: ['description'] }],
  } }));
  const issue = await json<Issue>(await request.post('/api/issues', {
    data: { projectId: project.id, title: `파이프라인 완료 검토 ${unique.slice(0, 8)}`, status: 'todo' },
  }), 201);
  const issuePath = `/api/issues/${issue.id}`;
  const linksPath = `${issuePath}/gitlab-links`;
  const refreshPath = `${linksPath}/refresh`;
  const history = async () => json<IssueAutomationRunPage>(await request.get(`${issuePath}/automation-runs`));
  const branch = `feature/${issue.key}-review`;
  const repositoryPath = 'team/review/pipeline-suggestion';
  const endpoint = `/forge/api/v4/projects/${repositoryId}`;
  const originalReadAt = new Date(Date.now() - 60_000).toISOString();
  const sha = 'b'.repeat(40);
  let finishedAt: string | undefined;
  let baseUrl = '';
  const repositoryUrl = () => `${baseUrl}/${repositoryPath}`;
  const pipelineUrl = () => `${repositoryUrl()}/-/pipelines/${pipelineId}`;
  const pipeline = () => ({ id: pipelineId, project_id: repositoryId, status: finishedAt ? 'success' : 'running',
    ref: branch, sha, source: 'push', tag: false, updated_at: finishedAt ?? originalReadAt,
    finished_at: finishedAt, web_url: pipelineUrl() });
  const mock = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    const path = url.pathname;
    response.setHeader('Content-Type', 'application/json');
    if (incoming.method !== 'GET' || incoming.headers['private-token'] !== token) {
      response.writeHead(401).end('{}');
    } else if (path === endpoint) {
      response.end(JSON.stringify({ id: repositoryId, path_with_namespace: repositoryPath, web_url: repositoryUrl() }));
    } else if (path === `${endpoint}/pipelines/${pipelineId}`) {
      response.end(JSON.stringify(pipeline()));
    } else if (path === `${endpoint}/pipelines` && url.searchParams.get('ref') === branch && url.searchParams.get('source') === 'push') {
      response.end(JSON.stringify([pipeline()]));
    } else response.writeHead(404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;
  let rule: AutomationRule | undefined;
  try {
    const connected = await json<GitlabSettings>(await request.patch(settingsPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    rule = await json<AutomationRule>(await request.post(rulesPath, { data: {
      projectId: project.id, name: `파이프라인 완료 확인 ${unique.slice(0, 8)}`, enabled: true, trigger: 'pipeline.succeeded',
      gitlabProjectIds: [repositoryId], branchPattern: branch, issueTypes: [], fromStatuses: ['todo'], toStatusId: 'done', actorId: automationActor.id,
    } }), 201);
    const attached = await json<GitlabLink>(await request.post(linksPath, { data: {
      repositoryId, url: pipelineUrl(), expectedSettingsVersion: connected.version,
    } }), 201);
    const runsBefore = await history();
    expect(runsBefore.items).toEqual([]);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), editor.id);
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
    const refresh = gitlab.getByRole('button', { name: 'GitLab에서 상태 확인', exact: true });
    const suggestion = gitlab.getByRole('region', { name: 'GitLab 상태 변경 제안', exact: true });
    const stage = suggestion.getByRole('button', { name: '목표 상태로 편집', exact: true });
    const issueForm = panel.locator('form.issue-detail-form');
    const save = issueForm.getByRole('button', { name: '변경사항 저장', exact: true });
    const status = issueForm.getByRole('combobox', { name: '상태', exact: true });
    const title = issueForm.getByRole('textbox', { name: '제목', exact: true });
    const description = issueForm.getByRole('textbox', { name: '설명', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const draftTitle = '검토 중인 새 티켓 제목';
    const draftComment = '아직 보내지 않은 댓글';
    const neededDescription = '파이프라인 결과 및 완료 조건을 확인했습니다.';
    await expect(refresh).toBeEnabled({ timeout: 25_000 });
    await expect(suggestion).toHaveCount(0);
    await title.fill(draftTitle);
    await comment.fill(draftComment);

    const checkStatus = async () => {
      finishedAt = new Date().toISOString();
      const response = page.waitForResponse(value => new URL(value.url()).pathname === refreshPath && value.request().method() === 'POST');
      await refresh.click();
      const result = await json<GitlabIssueRefreshResult>(await response);
      expect(result.links).toEqual(expect.arrayContaining([expect.objectContaining({ id: attached.id, state: 'success' })]));
      if (result.statusReview?.kind !== 'suggestion') throw new Error('확인된 파이프라인 상태 제안이 없습니다.');
      expect(result.statusReview.suggestion.blockReason).toContain('설명');
      expect(result.statusReview.suggestion.evidence.occurredAt).toBe(finishedAt);
      await expect(stage).toBeEnabled();
      return result.statusReview.suggestion.token;
    };
    const tokenForFirstReview = await checkStatus();
    await expect(suggestion).toContainText(rule.name);
    await expect(suggestion).toContainText('완료');
    await expect(suggestion).toContainText('설명');
    await expect(status).toHaveValue('todo');
    expect((await workspace()).issues.find(item => item.id === issue.id)).toEqual(issue);
    expect(await history()).toEqual(runsBefore);

    await status.selectOption('in_progress');
    await expect(stage).toHaveCount(0);
    await status.selectOption('todo');
    await stage.click();
    await expect(status).toHaveValue('done');
    await expect(status).toBeFocused();
    await expect(title).toHaveValue(draftTitle);
    await expect(comment).toHaveValue(draftComment);
    const saveTicket = async () => {
      const response = page.waitForResponse(value => new URL(value.url()).pathname === issuePath && value.request().method() === 'PATCH');
      await save.click();
      return response;
    };
    const blocked = await saveTicket();
    expect(blocked.status()).toBe(422);
    expect(blocked.request().postDataJSON()).toMatchObject({ status: 'done', gitlabStatusSuggestionToken: tokenForFirstReview });
    await expect(issueForm.getByRole('alert')).toContainText('설명');
    await description.fill(neededDescription);

    rule = await json<AutomationRule>(await request.patch(`${rulesPath}/${rule.id}`, { data: {
      expectedVersion: rule.version, name: '새로 저장한 파이프라인 완료 규칙',
    } }));
    await expect(status).toHaveValue('done');
    const expired = await saveTicket();
    expect(await json(expired, 409)).toMatchObject({ details: { reason: 'gitlab_status_suggestion_stale' } });
    await expect(issueForm.getByRole('alert')).toContainText('다시 확인');
    await expect(status).toHaveValue('todo');
    await expect(title).toHaveValue(draftTitle);
    await expect(description).toHaveValue(neededDescription);
    await expect(comment).toHaveValue(draftComment);
    expect((await workspace()).issues.find(item => item.id === issue.id)).toEqual(issue);

    const tokenForCurrentReview = await checkStatus();
    await expect(suggestion).toContainText(rule.name);
    await stage.click();
    const committed = await saveTicket();
    expect((await json<Issue>(committed)).status).toBe('done');
    expect(committed.request().postDataJSON()).toMatchObject({ gitlabStatusSuggestionToken: tokenForCurrentReview });
    const savedPanel = page.getByRole('dialog', { name: draftTitle, exact: true });
    await expect(savedPanel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
    await expect(savedPanel.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue(draftComment);
    const saved = await workspace();
    expect(saved.issues.find(item => item.id === issue.id)).toMatchObject({ title: draftTitle, description: neededDescription, status: 'done', version: issue.version + 1 });
    expect(saved.activities.filter(activity => activity.resourceId === issue.id).at(-1)?.actorId).toBe(editor.id);
    expect((await history()).items).toEqual(runsBefore.items);
  } finally {
    try {
      if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`);
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
      const removed = await request.delete(issuePath);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});

test('360px 티켓에서 동기화한 열린 MR로 상태를 검토하고 저장 직전에 다시 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 8);
  const token = `synthetic-open-review-${randomUUID()}`;
  const secret = `synthetic-open-review-hook-${randomUUID()}`;
  const repositoryId = 42;
  const repositoryPath = 'team/review/historical-open';
  const repoRead = `/forge/api/v4/projects/${repositoryId}`;
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settings = async () => json<GitlabSettings>(await request.get(settingsPath));
  const { projects: [project], users: [editor, automationActor] } = await workspace();
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const branchPrefix = `feature/open-review-${suffix}/`;
  const targetBranch = 'main';
  const cases: { issue: Issue; iid: number; sha: string }[] = [];
  let baseUrl = '';
  let createdAt = '';
  let updatedAt = '';
  let closedIid: number | null = null;
  const calls: string[] = [];
  const repoUrl = () => `${baseUrl}/${repositoryPath}`;
  const mrUrl = (iid: number) => `${repoUrl()}/-/merge_requests/${iid}`;
  const mrRead = (iid: number) => `${repoRead}/merge_requests/${iid}`;
  function mergeRequest({ issue, iid, sha }: typeof cases[number]) {
    const closed = iid === closedIid;
    return { id: 7000 + iid, iid, project_id: repositoryId, source_project_id: repositoryId, target_project_id: repositoryId,
      title: `${issue.key} 동기화된 MR`, state: closed ? 'closed' : 'opened', source_branch: branchPrefix + issue.key,
      target_branch: targetBranch, sha, created_at: createdAt, updated_at: updatedAt,
      ...(closed ? { closed_at: updatedAt } : {}), web_url: mrUrl(iid) };
  }
  const mock = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', 'http://fixture.test').pathname;
    calls.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (incoming.method !== 'GET' || incoming.headers['private-token'] !== token) return response.writeHead(401).end('{}');
    if (path === repoRead) return response.end(JSON.stringify({ id: repositoryId, path_with_namespace: repositoryPath, web_url: repoUrl() }));
    if (path === `${repoRead}/merge_requests`) return response.end(JSON.stringify(cases.map(mergeRequest)));
    if (path === `${repoRead}/pipelines`) return response.end('[]');
    const exact = cases.find(value => mrRead(value.iid) === path);
    return exact ? response.end(JSON.stringify(mergeRequest(exact))) : response.writeHead(404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;
  let rule: AutomationRule | undefined;
  try {
    const connected = await json<GitlabSettings>(await request.patch(settingsPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    for (const [iid, sha] of [[21, 'a'], [22, 'b']] as const) {
      const issue = await json<Issue>(await request.post('/api/issues', {
        data: { projectId: project.id, title: `열린 MR 검토 ${iid} ${suffix}`, status: 'todo' },
      }), 201);
      cases.push({ issue, iid, sha: sha.repeat(40) });
    }
    rule = await json<AutomationRule>(await request.post(rulesPath, { data: {
      projectId: project.id, name: `열린 MR 상태 검토 ${suffix}`, enabled: true, trigger: 'merge_request.opened',
      gitlabProjectIds: [repositoryId], branchPattern: `${branchPrefix}*`, targetBranchPattern: targetBranch,
      issueTypes: [], fromStatuses: ['todo'], toStatusId: 'review', actorId: automationActor.id,
    } }), 201);
    expect(rule.enabled).toBe(true);
    createdAt = new Date().toISOString();
    updatedAt = createdAt;
    const sync = await json<GitlabSyncResult>(await request.post(`${settingsPath}/sync`, { data: { expectedVersion: connected.version } }));
    expect(sync).toMatchObject({ linked: 2, partial: false });
    expect(calls.splice(0).sort()).toEqual([`${repoRead}/merge_requests`, `${repoRead}/pipelines`]);
    updatedAt = new Date().toISOString();
    const synchronized = await workspace();
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), editor.id);

    for (const { issue, iid } of cases) {
      const issuePath = `/api/issues/${issue.id}`;
      const historyPath = `${issuePath}/automation-runs`;
      const link = synchronized.gitlabLinks.find(row => row.issueId === issue.id && row.kind === 'merge_request' && row.iid === iid);
      if (!link) throw new Error(`동기화된 MR !${iid} 연결이 없습니다.`);
      expect(link).toMatchObject({ state: 'opened', webUrl: mrUrl(iid), targetBranch });
      expect(link.manualLinkId).toBeUndefined();
      expect(synchronized.issues.find(row => row.id === issue.id)).toEqual(issue);
      expect((await json<IssueAutomationRunPage>(await request.get(historyPath))).items).toEqual([]);

      await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
      const panel = page.getByRole('dialog', { name: issue.title, exact: true });
      const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
      const mr = gitlab.getByRole('region', { name: 'MR', exact: true }).getByRole('listitem');
      const form = panel.locator('form.issue-detail-form');
      const status = form.getByRole('combobox', { name: '상태', exact: true });
      const title = form.getByRole('textbox', { name: '제목', exact: true });
      const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
      const draftTitle = `열린 MR 검토 중인 제목 ${iid}`;
      const draftComment = `아직 보내지 않은 검토 댓글 ${iid}`;
      await expect(mr).toHaveAttribute('data-gitlab-state', 'opened');
      await title.fill(draftTitle);
      await comment.fill(draftComment);
      expect(calls).toEqual([]);

      const reviewPath = `${issuePath}/gitlab-links/${encodeURIComponent(link.id)}/status-review`;
      const reading = page.waitForResponse(response => new URL(response.url()).pathname === reviewPath && response.request().method() === 'POST');
      await mr.getByRole('button', { name: '이 활동으로 상태 검토', exact: true }).click();
      const checked = await json<GitlabIssueRefreshResult>(await reading);
      expect(calls.splice(0)).toEqual([repoRead, mrRead(iid)]);
      expect(checked).toMatchObject({ links: [{ id: link.id, state: 'opened' }], failures: [], skipped: 0 });
      if (checked.statusReview?.kind !== 'suggestion') throw new Error('열린 MR의 상태 변경 제안이 없습니다.');
      const { suggestion } = checked.statusReview;
      expect(suggestion).toMatchObject({ issueId: issue.id, issueVersion: issue.version, fromStatus: 'todo', toStatus: 'review',
        rule: { id: rule.id }, evidence: { trigger: 'merge_request.opened', occurredAt: createdAt, targetBranch, sourceProjectId: repositoryId,
          link: { id: link.id, iid, state: 'opened' } },
      });
      const proposal = gitlab.getByRole('region', { name: 'GitLab 상태 변경 제안', exact: true });
      await expect(proposal).toContainText('Merge Request 열림');
      await expect(proposal).toContainText(`MR !${iid}`);
      await expect(proposal.locator('time')).toHaveAttribute('datetime', createdAt);
      await expect(status).toHaveValue('todo');
      await expect(title).toHaveValue(draftTitle);
      await expect(comment).toHaveValue(draftComment);
      expect((await workspace()).issues.find(row => row.id === issue.id)).toEqual(issue);

      await proposal.getByRole('button', { name: '목표 상태로 편집', exact: true }).click();
      await expect(status).toHaveValue('review');
      await expect(status).toBeFocused();
      if (iid === cases[1].iid) {
        closedIid = iid;
        updatedAt = new Date().toISOString();
        expect((await workspace()).gitlabLinks.find(row => row.id === link.id)?.state).toBe('opened');
      }
      const saving = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
      await form.getByRole('button', { name: '변경사항 저장', exact: true }).click();
      const saved = await saving;
      expect(saved.request().postDataJSON()).toMatchObject({ status: 'review', title: draftTitle, gitlabStatusSuggestionToken: suggestion.token });
      expect(calls.splice(0)).toEqual([repoRead, mrRead(iid)]);
      if (closedIid === iid) {
        expect(await json(saved, 409)).toMatchObject({ details: { reason: 'gitlab_status_suggestion_stale' } });
        await expect(form.getByRole('alert')).toContainText('다시 확인');
        await expect(status).toHaveValue('todo');
        await expect(title).toHaveValue(draftTitle);
        await expect(comment).toHaveValue(draftComment);
        expect((await workspace()).issues.find(row => row.id === issue.id)).toEqual(issue);
      } else {
        expect(await json<Issue>(saved)).toMatchObject({ id: issue.id, status: 'review', title: draftTitle, version: issue.version + 1 });
        const savedPanel = page.getByRole('dialog', { name: draftTitle, exact: true });
        const unsent = savedPanel.getByRole('textbox', { name: '댓글 내용', exact: true });
        await expect(savedPanel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
        await expect(unsent).toHaveValue(draftComment);
        const current = await workspace();
        expect(current.activities.filter(activity => activity.resourceId === issue.id).at(-1)?.actorId).toBe(editor.id);
        await unsent.fill('');
      }
      expect((await json<IssueAutomationRunPage>(await request.get(historyPath))).items).toEqual([]);
    }
  } finally {
    try {
      if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`);
      for (const { issue } of cases) {
        const removed = await request.delete(`/api/issues/${issue.id}`);
        if (removed.ok()) {
          const { trashEntryId } = await removed.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});

test('360px 브랜치만 연결한 티켓에서 HEAD를 확인하고 조회 실패 시 저장한 상태와 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const unique = randomUUID();
  const token = `synthetic-branch-refresh-read-${unique}`;
  const secret = `synthetic-branch-refresh-webhook-${unique}`;
  const upstreamError = `upstream-branch-only-error-${unique}`;
  const repositoryId = 42;
  const repositoryPath = 'team/review/branch-status';
  const projectPath = `/forge/api/v4/projects/${repositoryId}`;
  const originalSha = 'a'.repeat(40), updatedSha = 'b'.repeat(40);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settings = async () => json<GitlabSettings>(await request.get(settingsPath));
  const { projects: [project] } = await workspace();
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const issue = await json<Issue>(await request.post('/api/issues', {
    data: { projectId: project.id, title: `브랜치 상태 확인 ${unique.slice(0, 8)}` },
  }), 201);
  const branch = `feature/${issue.key}`;
  const branchPath = `${projectPath}/repository/branches/${encodeURIComponent(branch)}`;
  const refreshPath = `/api/issues/${issue.id}/gitlab-links/refresh`;
  const calls: { path: string; method?: string; token?: string | string[] }[] = [];
  let baseUrl = '';
  let unavailable = false;
  let releaseRead = () => {};
  let heldRead: Promise<void> | undefined;
  const repoUrl = () => `${baseUrl}/${repositoryPath}`;
  const branchUrl = () => `${repoUrl()}/-/tree/${encodeURIComponent(branch)}`;
  const mock = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', 'http://fixture.test').pathname;
    calls.push({ path, method: incoming.method, token: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (path === projectPath) {
      response.end(JSON.stringify({ id: repositoryId, path_with_namespace: repositoryPath, web_url: repoUrl() }));
    } else if (path === branchPath && !unavailable) {
      const body = JSON.stringify({ name: branch, web_url: branchUrl(), commit: { id: updatedSha, committed_date: '2020-02-01T00:00:00Z' } });
      if (heldRead) void heldRead.then(() => response.end(body));
      else response.end(body);
    } else {
      response.writeHead(404).end(JSON.stringify({ message: `${upstreamError} ${token}` }));
    }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;

  try {
    await json(await request.patch(settingsPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    const push = async (before: string, after: string) => json<{ linked: number }>(await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Token': secret, 'X-Gitlab-Event': 'Push Hook', 'webhook-id': randomUUID() },
      data: { object_kind: 'push', project_id: repositoryId, ref: `refs/heads/${branch}`,
        before, after, checkout_sha: after, commits: [], total_commits_count: 0,
        project: { id: repositoryId, web_url: repoUrl(), path_with_namespace: repositoryPath } },
    }));
    expect((await push('0'.repeat(40), originalSha)).linked).toBe(1);
    const initialLinks = (await workspace()).gitlabLinks.filter(link => link.issueId === issue.id);
    expect(initialLinks).toMatchObject([{ kind: 'branch', state: 'active', sourceBranch: branch, sourceSha: originalSha }]);
    const [initial] = initialLinks;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
    const branchRow = gitlab.getByRole('region', { name: '브랜치', exact: true }).getByRole('listitem');
    const statusCheck = gitlab.getByRole('button', { name: 'GitLab에서 상태 확인', exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    await expect(branchRow.locator('code')).toHaveAttribute('title', originalSha);
    await expect(statusCheck).toBeEnabled();
    await title.fill('저장하지 않은 브랜치 확인 제목');
    await comment.fill('아직 저장하지 않은 브랜치 확인 댓글');
    expect(calls).toEqual([]);

    const nextCheck = () => page.waitForResponse(response => new URL(response.url()).pathname === refreshPath && response.request().method() === 'POST');
    const checking = nextCheck();
    await statusCheck.press('Enter');
    const result = await json<GitlabIssueRefreshResult>(await checking);
    expect(result).toMatchObject({ links: [{ id: initial.id, state: 'active', sourceSha: updatedSha, branchObservationSource: 'read' }], failures: [], skipped: 0 });
    await expect(branchRow.locator('code')).toHaveAttribute('title', updatedSha);
    await expect(branchRow).toContainText('GitLab에서 확인한 HEAD');
    await expect(gitlab.getByRole('status').filter({ hasText: 'GitLab 활동' })).toContainText('1건의 상태를 확인했습니다.');
    await expect(statusCheck).toBeFocused();

    unavailable = true;
    const retrying = nextCheck();
    await statusCheck.click();
    const failed = await json<GitlabIssueRefreshResult>(await retrying);
    expect(failed).toMatchObject({ links: [], failures: [{ linkId: initial.id }], skipped: 0 });
    expect(JSON.stringify(failed)).not.toContain(upstreamError);
    expect(JSON.stringify(failed)).not.toContain(token);
    const failures = gitlab.getByRole('list', { name: '확인하지 못한 활동', exact: true });
    await expect(failures.getByText(`브랜치 ${branch}`, { exact: true })).toBeVisible();
    await expect(failures).toContainText('기존 브랜치 상태를 유지합니다.');
    await expect(branchRow).toHaveAttribute('data-gitlab-state', 'active');
    await expect(branchRow.getByRole('link')).toHaveAttribute('href', `${branchUrl()}?ref_type=heads`);
    await expect(branchRow.locator('code')).toHaveAttribute('title', updatedSha);
    await expect(title).toHaveValue('저장하지 않은 브랜치 확인 제목');
    await expect(comment).toHaveValue('아직 저장하지 않은 브랜치 확인 댓글');

    const saved = await workspace();
    expect(saved.gitlabLinks.find(link => link.id === initial.id)).toEqual(result.links[0]);

    unavailable = false;
    heldRead = new Promise(resolve => { releaseRead = resolve; });
    const deferred = nextCheck();
    await statusCheck.click();
    await expect.poll(() => calls.filter(call => call.path === branchPath).length).toBe(3);
    const pushedSha = 'c'.repeat(40);
    expect((await push(updatedSha, pushedSha)).linked).toBe(1);
    releaseRead();
    const raced = await json<GitlabIssueRefreshResult>(await deferred);
    expect(raced).toMatchObject({ links: [], failures: [{ linkId: initial.id }], skipped: 0 });
    await expect(failures).toContainText('브랜치 상태가 변경되었습니다.');
    await expect(branchRow.locator('code')).toHaveAttribute('title', pushedSha);
    await expect(title).toHaveValue('저장하지 않은 브랜치 확인 제목');
    await expect(comment).toHaveValue('아직 저장하지 않은 브랜치 확인 댓글');
    expect((await workspace()).issues.find(item => item.id === issue.id)).toEqual(issue);
    expect(calls.map(call => call.path)).toEqual(Array.from({ length: 3 }, () => [projectPath, branchPath]).flat());
    expect(calls.every(call => call.method === 'GET' && call.token === token)).toBe(true);
  } finally {
    releaseRead();
    try {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});
