import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base, type APIRequestContext, type APIResponse } from '@playwright/test';
import { createApp } from '../../server/app.js';
import type { GitlabProjectWebhookHistory } from '../../shared/gitlab-project-webhooks';
import type { GitlabSettings, GitlabWebhookStatus, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const reviewPath = `${settingsPath}/project-webhook-review`;
const historyPath = `${settingsPath}/project-webhook-history`;
const receiverPath = `${settingsPath}/webhook`;
const statusPath = `${settingsPath}/webhook-status`;
const publicOrigin = 'https://donefac-webhook-history.test';
const receiverUrl = `${publicOrigin}${receiverPath}`;
const gitlabMount = '/forge/tools';
const repositoryId = 42;
const exactHookId = 142;
const hookPath = `${gitlabMount}/api/v4/projects/${repositoryId}/hooks`;
const eventsPath = `${hookPath}/${exactHookId}/events`;

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('격리 서버 주소를 확인하지 못했습니다.');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

type HistoryFixture = { origin: string; request: APIRequestContext };
const test = base.extend<{ fixture: HistoryFixture }>({
  fixture: async ({ playwright }, provide) => {
    const directory = await mkdtemp(join(tmpdir(), 'donefac-webhook-history-browser-'));
    const runtime = createApp({ dataDir: directory, outboundWorker: false, deadlineReminderWorker: false,
      recurringIssueWorker: false, gitlabWebhookPublicOrigin: publicOrigin });
    const server = createServer(runtime.app);
    const origin = await listen(server);
    const request = await playwright.request.newContext({ baseURL: origin });
    try {
      await provide({ origin, request });
    } finally {
      try {
        await request.dispose();
        await close(server);
      } finally {
        runtime.close();
        await rm(directory, { force: true, recursive: true });
      }
    }
  },
});

test.use({ viewport: { width: 360, height: 820 } });

test('360px에서 GitLab의 전송 실패와 Donefac 인증 수신을 대조하고 오래된 전송 응답을 버린다', async ({ fixture, page }) => {
  test.setTimeout(70_000);
  const readToken = 'synthetic-history-read-token';
  const managerToken = 'synthetic-history-management-token';
  const webhookSecret = 'synthetic-history-webhook-secret';
  const privateHeader = 'synthetic-private-request-header';
  const privatePayload = 'synthetic-private-webhook-payload';
  const privateResponse = 'synthetic-private-webhook-response';
  const acceptedMessage = randomUUID();
  const acceptedPipelineMessage = randomUUID();
  const proxyOnlyMessage = randomUUID();
  const eventUuid = randomUUID();
  const unrelatedMessage = randomUUID();
  const startedLateRead = Promise.withResolvers<void>();
  const finishLateRead = Promise.withResolvers<void>();
  const attemptedAt = new Date(Date.now() - 60_000).toISOString();
  const calls: { method: string | undefined; target: URL; token: string | string[] | undefined }[] = [];
  const browserCalls: unknown[] = [];
  let eventReads = 0;
  const hook = { project_id: repositoryId, url: receiverUrl, push_events: true, merge_requests_events: true,
    pipeline_events: true, deployment_events: true, enable_ssl_verification: true, push_events_branch_filter: '',
    custom_webhook_template: null, alert_status: 'executable' };
  const remote = createServer(async (request, response) => {
    const target = new URL(request.url ?? '/', 'http://localhost');
    const token = request.headers['private-token'];
    calls.push({ method: request.method, target, token });
    if (request.method !== 'GET' || token !== managerToken) {
      response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: privateResponse }));
      return;
    }
    if (target.pathname === hookPath) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Next-Page': '' }).end(JSON.stringify([
        { ...hook, id: exactHookId }, { ...hook, id: exactHookId + 1, url: `${receiverUrl}?route=legacy` },
      ]));
      return;
    }
    if (target.pathname !== eventsPath) {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: privateResponse }));
      return;
    }
    eventReads++;
    if (eventReads === 2) {
      startedLateRead.resolve();
      await finishLateRead.promise;
    }
    const payload = [
      { id: 603, url: receiverUrl, trigger: 'pipeline_hooks', response_status: '200', created_at: attemptedAt,
        request_headers: { 'webhook-id': acceptedPipelineMessage } },
      { id: 602, url: receiverUrl, trigger: 'push_hooks', response_status: '401', created_at: attemptedAt,
        execution_duration: 0.125, request_headers: { 'X-Gitlab-Token': privateHeader, 'Idempotency-Key': acceptedMessage }, request_data: { internal: privatePayload },
        response_headers: { 'X-Private': privateHeader }, response_body: privateResponse },
      { id: 601, url: receiverUrl, trigger: 'push_hooks', response_status: '200', execution_duration: 0.05,
        request_headers: { 'webhook-id': proxyOnlyMessage } },
      { id: 600, url: receiverUrl, trigger: 'pipeline_hooks', response_status: '0', internal_error_message: privateResponse,
        request_headers: { 'X-Gitlab-Event-UUID': eventUuid } },
      { id: 598, url: receiverUrl, trigger: 'push_hooks', response_status: '200', request_headers: { 'webhook-id': acceptedMessage } },
      { id: 599, url: `${receiverUrl}?route=legacy`, trigger: 'push_hooks', response_status: '503' },
    ];
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-Next-Page': '2' }).end(JSON.stringify(payload));
  });

  const source = `${await listen(remote)}${gitlabMount}`;
  try {
    const { request } = fixture;
    const { projects: [project], users: [actor] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const initial = await readJson<GitlabSettings>(await request.get(settingsPath));
    const saved = await readJson<GitlabSettings>(await request.patch(settingsPath, { data: {
      expectedVersion: initial.version, baseUrl: source, projectIds: [repositoryId, 99], token: readToken, webhookSecret,
    } }));
    const sendPush = (id: string) => request.post(receiverPath, {
      headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': id },
      data: { object_kind: 'push', project_id: repositoryId, project: { id: repositoryId, web_url: `${source}/team/history` },
        ref: 'refs/heads/synthetic-history', before: '0'.repeat(40), after: 'a'.repeat(40), commits: [], total_commits_count: 0 },
    }).then(response => readJson(response));
    await sendPush(acceptedMessage);
    const accepted = (await readJson<GitlabWebhookStatus>(await request.get(statusPath))).repositories[0].lastDelivery;
    const finishedAt = new Date(Date.now() - 1_000).toISOString();
    await readJson(await request.post(receiverPath, {
      headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': acceptedPipelineMessage },
      data: { object_kind: 'pipeline', project: { id: repositoryId, web_url: `${source}/team/history` },
        object_attributes: { id: 813, status: 'failed', ref: 'feature/no-ticket-key', sha: 'c'.repeat(40), finished_at: finishedAt } },
    }));
    const pipelineReceipt = (await readJson<GitlabWebhookStatus>(await request.get(statusPath))).repositories[0].lastDelivery;
    expect(pipelineReceipt?.stateAutomation).toMatchObject({ result: 'evaluated', trigger: 'pipeline.failed', occurredAt: finishedAt, candidateTickets: 0 });
    await sendPush(unrelatedMessage);
    const receiptsBefore = await readJson<GitlabWebhookStatus>(await request.get(statusPath));
    const latest = receiptsBefore.repositories.find(item => item.repositoryId === repositoryId)?.lastDelivery;
    expect(latest).toMatchObject({ event: 'push', authentication: 'secret-token', linked: 0 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.route('**/api/**', async route => {
      const destination = new URL(route.request().url());
      if (destination.pathname === historyPath) {
        expect(route.request().method()).toBe('POST');
        expect(destination.search).toBe('');
        browserCalls.push(route.request().postDataJSON());
      }
      const response = await route.fetch({ url: `${fixture.origin}${destination.pathname}${destination.search}` });
      await route.fulfill({ response });
    });
    await page.goto(`/#/${project.id}/development`);

    const setup = page.getByRole('region', { name: 'GitLab 프로젝트 웹훅 설정', exact: true });
    const history = setup.getByRole('region', { name: 'GitLab 최근 전송', exact: true });
    const loadHistory = setup.getByRole('button', { name: '최근 전송 확인', exact: true });
    const manager = setup.getByLabel('GitLab 관리 API 토큰', { exact: true });
    const draftAddress = page.getByLabel('GitLab 주소', { exact: true });
    const draftId = page.getByLabel(/^GitLab 프로젝트 ID/);
    const draftReadToken = page.getByLabel('읽기 API 토큰', { exact: true });
    const draftSecret = page.getByLabel('웹훅 Secret Token', { exact: true });
    await expect(draftAddress).toHaveValue(source);
    await draftAddress.fill('https://unsaved-history-draft.test');
    await draftId.fill('777');
    await draftReadToken.fill('unsaved-history-read-token');
    await draftSecret.fill('unsaved-history-webhook-secret');
    await manager.fill(managerToken);
    await expect(loadHistory).toHaveCount(0);
    expect(calls).toEqual([]);

    const reviewed = page.waitForResponse(response => new URL(response.url()).pathname === reviewPath);
    await setup.getByRole('button', { name: '웹훅 설정 점검', exact: true }).click();
    expect((await reviewed).ok()).toBe(true);
    await expect(setup.getByRole('heading', { name: '웹훅 #143', exact: true })).toBeVisible();
    await expect(loadHistory).toHaveCount(1);
    expect(calls.map(call => call.target.pathname)).toEqual([hookPath]);
    expect(browserCalls).toEqual([]);

    const inspected = page.waitForResponse(response => new URL(response.url()).pathname === historyPath);
    await loadHistory.click();
    const result = await readJson<GitlabProjectWebhookHistory>(await inspected);
    expect(result).toMatchObject({ settingsVersion: saved.version, repositoryId, hookId: exactHookId, partial: true, localReceipt: latest });
    expect(browserCalls).toEqual([{ expectedVersion: saved.version, repositoryId, hookId: exactHookId, managementToken: managerToken }]);
    expect(calls.map(call => call.target.pathname)).toEqual([hookPath, hookPath, eventsPath]);
    expect(Object.fromEntries(calls[2].target.searchParams)).toEqual({ page: '1', per_page: '20' });
    const attempt = (id: number) => history.getByRole('listitem', { name: `GitLab 전송 #${id}`, exact: true });
    await expect(attempt(603)).toContainText('상태 자동화 · 파이프라인 실패');
    await expect(attempt(603)).toContainText('대상 티켓 0건 · 확인된 자동화 대상 티켓이 없습니다.');
    await expect(attempt(602)).toContainText('HTTP 401');
    await expect(attempt(602)).toContainText('같은 메시지 인증 수신 확인');
    await expect(attempt(601)).toContainText('HTTP 200');
    await expect(attempt(601)).toContainText('같은 메시지 인증 수신 미확인');
    await expect(attempt(600)).toContainText('HTTP 응답 없음');
    await expect(attempt(600)).toContainText('같은 메시지 대조 불가');
    await expect(attempt(598)).toContainText('같은 메시지 인증 수신 확인');
    expect(result.attempts.map(({ id, messageReceipt }) => [id, messageReceipt])).toEqual([
      [603, { status: 'matched', delivery: pipelineReceipt }],
      [602, { status: 'matched', delivery: accepted }], [601, { status: 'unconfirmed' }],
      [600, { status: 'unavailable' }], [598, { status: 'matched', delivery: accepted }],
    ]);
    await expect(history.getByText('확인할 수 있는 전송만 표시합니다.', { exact: true })).toBeVisible();
    await expect(history.getByRole('heading', { name: 'Donefac 인증 수신', exact: true })).toBeVisible();
    await expect(history).toContainText('이 저장소의 마지막 인증 수신 · Push · Secret Token');
    await expect(history).not.toContainText('HTTP 503');
    for (const privateValue of [managerToken, webhookSecret, privateHeader, privatePayload, privateResponse, '?route=legacy',
      acceptedMessage, acceptedPipelineMessage, proxyOnlyMessage, eventUuid, unrelatedMessage, 'messageDigests', 'request_headers']) {
      expect(JSON.stringify(result)).not.toContain(privateValue);
      await expect(history).not.toContainText(privateValue);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    expect(await readJson<GitlabSettings>(await request.get(settingsPath))).toEqual(saved);
    expect(await readJson<GitlabWebhookStatus>(await request.get(statusPath))).toEqual(receiptsBefore);

    const stale = page.waitForResponse(response => new URL(response.url()).pathname === historyPath);
    await loadHistory.click();
    await startedLateRead.promise;
    try {
      await readJson<GitlabSettings>(await request.patch(settingsPath, { data: { expectedVersion: saved.version, token: 'synthetic-history-later-read-token' } }));
    } finally { finishLateRead.resolve(); }
    expect((await stale).status()).toBe(409);
    await expect(setup.getByRole('alert')).toHaveText('연결 설정이나 점검 결과가 변경되었습니다. 최신 설정을 확인하고 다시 점검해 주세요.');
    await expect(setup.getByText('HTTP 401', { exact: true })).toHaveCount(0);
    expect(browserCalls).toHaveLength(2);
    expect(calls.map(call => call.target.pathname)).toEqual([hookPath, hookPath, eventsPath, hookPath, eventsPath]);
    expect(calls.every(call => call.method === 'GET' && call.token === managerToken)).toBe(true);
    await expect(draftAddress).toHaveValue('https://unsaved-history-draft.test');
    await expect(draftId).toHaveValue('777');
    await expect(draftReadToken).toHaveValue('unsaved-history-read-token');
    await expect(draftSecret).toHaveValue('unsaved-history-webhook-secret');
  } finally {
    finishLateRead.resolve();
    await close(remote);
  }
});
