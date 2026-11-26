import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, request as apiRequest, type BrowserContext } from '@playwright/test';
import type { GitlabProjectWebhookHistory, GitlabProjectWebhookReview } from '../../shared/gitlab-project-webhooks';
import type { GitlabLink, GitlabRepositorySearch, GitlabSettings, GitlabSyncPreview, GitlabSyncStatus, Issue, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const repositoryPath = 'team/fixtures/engine';
const apiRoot = '/forge/api/v4/projects';
const mergeRequestIid = 12;
const webhookId = 52;
const deliveredAttemptId = 701;
const proxyOnlyAttemptId = 702;

export async function verifyNativeGitlabRead(context: BrowserContext, origin: string, issue: Issue, repositoryId: number, signingToken: string) {
  const token = randomUUID();
  const managementToken = randomUUID();
  const deliveredMessage = randomUUID();
  const proxyOnlyMessage = randomUUID();
  const receiverUrl = `${origin}${integration}/webhook`;
  const hooksPath = `${apiRoot}/${repositoryId}/hooks`;
  const historyPath = `${hooksPath}/${webhookId}/events`;
  const privateError = `upstream-${randomUUID()}`;
  const title = `${issue.key} 합성 저장소의 병합 요청`;
  const time = new Date(Date.now() - 10_000).toISOString();
  let gitlabBase = '';
  let failNextPipelineRead = false;
  const calls: string[] = [];
  const mock = createServer((request, response) => {
    const path = new URL(request.url ?? '/', gitlabBase).pathname;
    const requestToken = request.headers['private-token'];
    if (request.method !== 'GET') {
      calls.push('unauthenticated-or-write');
      return response.writeHead(403).end();
    }
    const repositoryUrl = `${gitlabBase}/${repositoryPath}`;
    response.setHeader('Content-Type', 'application/json');
    if (path === hooksPath || path === historyPath) {
      const credential = requestToken === managementToken ? 'manager' : requestToken === token ? 'read-token' : 'unexpected-token';
      calls.push(`${path === hooksPath ? 'hooks' : 'history'}:${credential}`);
      if (requestToken !== managementToken) return response.writeHead(403).end(JSON.stringify({ error: privateError }));
      response.setHeader('X-Next-Page', '');
      if (path === hooksPath) return response.end(JSON.stringify([{ id: webhookId, project_id: repositoryId, url: receiverUrl,
        push_events: true, merge_requests_events: true, pipeline_events: true, deployment_events: true, enable_ssl_verification: true,
        push_events_branch_filter: '', custom_webhook_template: null, alert_status: 'executable' }]));
      return response.end(JSON.stringify([[proxyOnlyAttemptId, proxyOnlyMessage], [deliveredAttemptId, deliveredMessage]].map(([id, message]) => ({
        id, url: receiverUrl, trigger: 'push_hooks', response_status: '200', request_headers: { 'webhook-id': message },
      }))));
    }
    if (requestToken !== token) {
      calls.push('unauthenticated-or-write');
      return response.writeHead(403).end();
    }
    if (path === `${apiRoot}/${encodeURIComponent(repositoryPath)}`) {
      calls.push('repository');
      return response.end(JSON.stringify({ id: repositoryId, name: 'Pilot Engine', path_with_namespace: repositoryPath, web_url: repositoryUrl }));
    }
    if (path === `${apiRoot}/${repositoryId}/merge_requests`) {
      calls.push('merge_requests');
      response.setHeader('X-Next-Page', '');
      return response.end(JSON.stringify([{ id: 530, iid: mergeRequestIid, title, state: 'opened', target_project_id: repositoryId,
        source_branch: `feature/${issue.key}`, updated_at: time, web_url: `${repositoryUrl}/-/merge_requests/${mergeRequestIid}` }]));
    }
    if (path === `${apiRoot}/${repositoryId}/pipelines`) {
      calls.push('pipelines');
      if (failNextPipelineRead) {
        failNextPipelineRead = false;
        return response.writeHead(503).end(JSON.stringify({ error: `${privateError} ${token}` }));
      }
      response.setHeader('X-Next-Page', '');
      return response.end('[]');
    }
    calls.push('unexpected-path');
    return response.writeHead(404).end();
  });
  const page = await context.newPage();
  try {
    mock.listen(0, '127.0.0.1');
    await once(mock, 'listening');
    gitlabBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;
    const repositoryUrl = `${gitlabBase}/${repositoryPath}`;
    const mrUrl = `${repositoryUrl}/-/merge_requests/${mergeRequestIid}`;
    const readSettings = async () => await (await context.request.get(integration)).json() as GitlabSettings;
    async function persistedIssueAndLinks() {
      const response = await context.request.get('/api/workspace');
      expect(response.status()).toBe(200);
      const workspace = await response.json() as WorkspaceSnapshot;
      return { issue: workspace.issues.find(value => value.id === issue.id), links: workspace.gitlabLinks.filter(value => value.issueId === issue.id) };
    }
    const actionResponse = (suffix: string, method = 'POST') => page.waitForResponse(response =>
      response.url() === `${origin}${integration}${suffix}` && response.request().method() === method);

    const baseline = await readSettings();
    expect(baseline.baseUrl).toBe('');
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${issue.projectId}/development`);
    await page.getByLabel('GitLab 주소', { exact: true }).fill(gitlabBase);
    const readToken = page.getByLabel('읽기 API 토큰', { exact: true });
    try {
      await readToken.fill(token);
      await page.getByLabel(/^웹훅 Signing Token/).fill(signingToken);
    } catch {
      throw new Error('Could not fill the isolated GitLab test credentials.');
    }
    const picker = page.getByRole('region', { name: 'GitLab 저장소 찾기', exact: true });
    await picker.getByLabel('저장소 이름·전체 경로·주소', { exact: true }).fill(`${repositoryUrl}.git`);
    const [searched] = await Promise.all([actionResponse('/repository-search'), picker.getByRole('button', { name: '저장소 검색', exact: true }).click()]);
    expect(searched.status()).toBe(200);
    expect((await searched.json() as GitlabRepositorySearch).repositories).toEqual([
      { id: repositoryId, name: 'Pilot Engine', pathWithNamespace: repositoryPath, webUrl: repositoryUrl },
    ]);
    await picker.getByRole('button', { name: `${repositoryPath} 저장소 추가`, exact: true }).click();

    const [previewResponse] = await Promise.all([actionResponse('/sync-preview'), page.getByRole('button', { name: '연결 미리보기', exact: true }).click()]);
    expect(previewResponse.status()).toBe(200);
    const preview = await previewResponse.json() as GitlabSyncPreview;
    expect(preview.candidates).toMatchObject([{ issueId: issue.id, issueKey: issue.key, projectId: repositoryId, kind: 'merge_request', action: 'create' }]);
    expect(preview.candidates[0]).not.toHaveProperty('originalJiraKey');
    await expect(page.getByRole('region', { name: '티켓 연결 후보', exact: true })).toContainText(title);
    expect(await readSettings()).toEqual(baseline);
    expect(await persistedIssueAndLinks()).toEqual({ issue, links: [] });
    expect(calls).toEqual(['repository', 'merge_requests', 'pipelines']);

    const [saveResponse] = await Promise.all([actionResponse('', 'PATCH'), page.getByRole('button', { name: '연결 설정 저장', exact: true }).click()]);
    expect(saveResponse.status()).toBe(200);
    const saved = await saveResponse.json() as GitlabSettings;
    expect(saved).toMatchObject({ baseUrl: gitlabBase, projectIds: [repositoryId], tokenConfigured: true, signingTokenConfigured: true });
    expect(saved.jiraRoutes ?? []).toEqual([]);
    await expect(readToken).toHaveValue('');
    const report = page.getByRole('region', { name: 'GitLab 동기화 결과', exact: true });
    const repository = report.getByRole('region', { name: `저장소 ${repositoryId}`, exact: true });
    failNextPipelineRead = true;
    const [failed] = await Promise.all([actionResponse('/sync'), page.getByRole('button', { name: '지금 동기화', exact: true }).click()]);
    expect(failed.status()).toBe(502);
    await expect(repository).toContainText('GitLab HTTP 503 응답');
    expect((await repository.innerText()).includes(privateError)).toBe(false);
    expect(await persistedIssueAndLinks()).toEqual({ issue, links: [] });
    expect(calls.splice(0)).toEqual(['repository', 'merge_requests', 'pipelines', 'merge_requests', 'pipelines']);

    const [retried] = await Promise.all([actionResponse('/sync'), report.getByRole('button', { name: '실패한 저장소 다시 시도', exact: true }).click()]);
    expect(retried.status()).toBe(200);
    expect(retried.request().postDataJSON()).toEqual({ expectedVersion: saved.version, repositoryIds: [repositoryId] });
    await expect(repository).toContainText('신규 연결 1개');
    expect(calls).toEqual(['merge_requests', 'pipelines']);
    const after = await persistedIssueAndLinks();
    expect(after.issue).toEqual(issue);
    expect(after.links).toMatchObject([{ issueId: issue.id, projectId: repositoryId, iid: mergeRequestIid, kind: 'merge_request', webUrl: mrUrl, state: 'opened' }]);
    const link: GitlabLink = after.links[0];
    expect(link).not.toHaveProperty('originalJiraKey');
    const feed = page.getByRole('region', { name: '연결된 개발 활동', exact: true });
    await expect(feed.locator(`a[href="${mrUrl}"]`)).toBeVisible();
    await page.reload();
    await expect(repository).toContainText('신규 연결 1개');
    await expect(feed.locator(`a[href="${mrUrl}"]`)).toBeVisible();
    expect(calls).toEqual(['merge_requests', 'pipelines']);
    const statusResponse = await context.request.get(`${integration}/sync-status`);
    expect(statusResponse.status()).toBe(200);
    const status = await statusResponse.json() as GitlabSyncStatus;
    expect(status.repositories).toMatchObject([{ repositoryId, activity: { includeHistory: false, result: { status: 'ok' } } }]);
    expect(saved.webhookReceiverUrl).toBe(receiverUrl);
    const setup = page.getByRole('region', { name: 'GitLab 프로젝트 웹훅 설정', exact: true });
    await expect(setup.getByLabel('웹훅 수신 주소', { exact: true })).toHaveValue(receiverUrl);
    calls.length = 0;
    const [denied] = await Promise.all([actionResponse('/project-webhook-review'),
      setup.getByRole('button', { name: '웹훅 설정 점검', exact: true }).click()]);
    expect(denied.status()).toBe(403);
    expect(await denied.text()).not.toContain(privateError);
    await expect(setup.getByRole('alert')).toContainText('웹훅을 볼 수 있는 GitLab 토큰');
    await setup.getByLabel('GitLab 관리 API 토큰', { exact: true }).fill(managementToken);
    const [reviewed] = await Promise.all([actionResponse('/project-webhook-review'),
      setup.getByRole('button', { name: '다시 점검', exact: true }).click()]);
    expect(reviewed.status()).toBe(200);
    const hook = await reviewed.json() as GitlabProjectWebhookReview;
    expect(hook).toMatchObject({ settingsVersion: saved.version, repositoryId, receiverUrl, authMode: 'signature', state: 'configured', hooks: [{ id: webhookId }] });
    await expect(setup.getByRole('heading', { name: `웹훅 #${webhookId}`, exact: true })).toBeVisible();

    const payload = {
      object_kind: 'push', project_id: repositoryId, project: { id: repositoryId, web_url: repositoryUrl },
      ref: 'refs/heads/synthetic-receiver-check', before: '0'.repeat(40), after: 'd'.repeat(40), commits: [], total_commits_count: 0,
    };
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const key = Buffer.from(signingToken.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${deliveredMessage}.${timestamp}.`).update(bytes).digest('base64');
    const sender = await apiRequest.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    try {
      const sent = await sender.post(receiverUrl, { data: bytes, maxRedirects: 0, headers: {
        'Content-Type': 'application/json', 'X-Gitlab-Event': 'Push Hook', 'webhook-id': deliveredMessage,
        'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`,
      } });
      expect(sent.status()).toBe(200);
      expect(await sent.json()).toEqual({ ok: true, duplicate: false, linked: 0, runs: [] });
    } finally { await sender.dispose(); }

    const [inspected] = await Promise.all([actionResponse('/project-webhook-history'),
      setup.getByRole('button', { name: '최근 전송 확인', exact: true }).click()]);
    expect(inspected.status()).toBe(200);
    const history = await inspected.json() as GitlabProjectWebhookHistory;
    const delivered = history.attempts.find(attempt => attempt.id === deliveredAttemptId)?.messageReceipt;
    if (delivered?.status !== 'matched') throw new Error('The signed GitLab delivery did not match its exact setup history entry.');
    expect(history).toMatchObject({ settingsVersion: saved.version, repositoryId, hookId: webhookId, partial: false, localReceipt: delivered.delivery });
    expect(delivered.delivery).toMatchObject({ event: 'push', authentication: 'signing-token', duplicate: false, linked: 0, automationRuns: 0 });
    expect(history.attempts.map(attempt => [attempt.id, attempt.status, attempt.messageReceipt.status])).toEqual([
      [proxyOnlyAttemptId, 200, 'unconfirmed'], [deliveredAttemptId, 200, 'matched'],
    ]);
    const visibleHistory = setup.getByRole('region', { name: 'GitLab 최근 전송', exact: true });
    await expect(visibleHistory.getByRole('listitem', { name: `GitLab 전송 #${deliveredAttemptId}`, exact: true })).toContainText('같은 메시지 인증 수신 확인');
    await expect(visibleHistory.getByRole('listitem', { name: `GitLab 전송 #${proxyOnlyAttemptId}`, exact: true })).toContainText('같은 메시지 인증 수신 미확인');
    expect([deliveredMessage, proxyOnlyMessage, managementToken, token, signingToken].some(value => JSON.stringify(history).includes(value))).toBe(false);
    expect(calls).toEqual(['hooks:read-token', 'hooks:manager', 'hooks:manager', 'history:manager']);
    expect(await persistedIssueAndLinks()).toEqual(after);
    return { settings: await readSettings(), repositoryUrl, link, status, webhookReceipt: delivered.delivery };
  } finally {
    await page.close();
    if (mock.listening) {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
}
