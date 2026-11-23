import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Response } from '@playwright/test';
import type { AutomationRule, GitlabIssueRefreshResult, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

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
