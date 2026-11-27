import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, request } from '@playwright/test';
import WebSocket from 'ws';
import browserConfig from '../playwright.config.ts';
import { startPilotTestProxy } from './pilot-test-proxy.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'donefac-pilot-access-'));
const dataDir = join(scratch, 'data');
const backupDir = join(scratch, 'backup');
const accessFile = join(scratch, 'access-key');
const accessCode = randomBytes(32).toString('hex');
const gitlabSecret = randomBytes(24).toString('hex');
const protectedValues = [accessCode, gitlabSecret];
const socketTimeout = 8000;
const expectSoon = expect.configure({ timeout: 8000 });
const interruption = new AbortController();

let proxy;
let backend;
let backendExit;
let backendLogs = '';
let browser;

function interrupt(signal, exitCode) {
  process.exitCode = exitCode;
  interruption.abort(new Error(`Pilot access test interrupted (${signal}).`));
  backend?.kill('SIGTERM');
  void browser?.close().catch(() => {});
}
const onInterrupt = () => interrupt('SIGINT', 130);
const onTerminate = () => interrupt('SIGTERM', 143);

async function deadline(work, message, milliseconds = socketTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); }
}

function checkCredentials(bytes, source) {
  for (const value of protectedValues) {
    assert.ok(!bytes.includes(value), `${source} exposed a credential.`);
  }
}

async function startBackend(origin) {
  interruption.signal.throwIfAborted();
  writeFileSync(accessFile, `${accessCode}\n`, { mode: 0o600 });
  backend = spawn('bash', ['scripts/pilot-lock.sh', dataDir, process.execPath, '--import', 'tsx', 'server/pilot.ts'], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env,
      DONEFAC_PILOT_PORT: '0', DONEFAC_PILOT_DEMO: '1', DONEFAC_PILOT_OUTBOUND: '0',
      DONEFAC_PILOT_ORIGIN: origin, DONEFAC_PILOT_ACCESS_FILE: accessFile,
    },
  });
  backendExit = once(backend, 'close');
  backend.stderr.on('data', chunk => { backendLogs += chunk; });
  const ready = new Promise(resolve => {
    backend.stdout.on('data', chunk => {
      backendLogs += chunk;
      const match = /Donefac pilot listening on http:\/\/127\.0\.0\.1:(\d+)\s/.exec(backendLogs);
      if (match) resolve(Number(match[1]));
    });
  });
  const port = await deadline(Promise.race([ready, backendExit.then(([code, signal]) => {
    throw new Error(`Pilot exited during startup (${code ?? signal}).\n${backendLogs}`);
  })]), 'Pilot startup timed out.', 25_000);
  proxy.setBackendPort(port);
}

async function stopBackend(verifyExit = true) {
  if (!backend) return;
  if (backend.exitCode === null && backend.signalCode === null) backend.kill('SIGTERM');
  try {
    const [code] = await deadline(backendExit, 'Pilot shutdown timed out.', 15_000);
    if (verifyExit) assert.equal(code, 0, `The isolated pilot did not exit cleanly.\n${backendLogs}`);
  } finally {
    if (backend.exitCode === null && backend.signalCode === null) backend.kill('SIGKILL');
    await backendExit.catch(() => {});
    backend = undefined;
    proxy.setBackendPort(null);
  }
}

async function call(client, method, path, status, options = {}) {
  const response = await client.fetch(path, { method, maxRedirects: 0, timeout: socketTimeout, ...options });
  assert.equal(response.status(), status, `${method} ${path}`);
  return response;
}

async function rejectSocket(url, headers, status) {
  const socket = new WebSocket(url, { headers, rejectUnauthorized: false, handshakeTimeout: socketTimeout });
  try {
    const outcome = await new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      socket.once('open', () => resolve(101));
      socket.on('error', reject);
    });
    assert.equal(outcome, status, 'Collaboration WebSocket handshake status.');
  } finally { socket.terminate(); }
}

async function verifyIntegrations(session, anonymous, origin) {
  const gitlabPath = '/api/integrations/gitlab';
  const repositorySearchPath = `${gitlabPath}/repository-search`;
  const webhookStatusPath = `${gitlabPath}/webhook-status`;
  const syncStatusPath = `${gitlabPath}/sync-status`;
  const settings = await (await call(session, 'GET', gitlabPath, 200)).json();
  const savedSettings = await (await call(session, 'PATCH', gitlabPath, 200, {
    headers: { Origin: origin },
    data: { expectedVersion: settings.version, baseUrl: 'https://gitlab.example.test', projectIds: [42], webhookSecret: gitlabSecret },
  })).json();
  const searchWithoutQuery = { expectedVersion: savedSettings.version, query: '' };
  await call(anonymous, 'POST', repositorySearchPath, 401, { headers: { Origin: origin }, data: searchWithoutQuery });
  await call(session, 'POST', repositorySearchPath, 403, { headers: { Origin: 'https://other.example.test' }, data: searchWithoutQuery });
  const invalidSearch = await call(session, 'POST', repositorySearchPath, 400, { headers: { Origin: origin }, data: searchWithoutQuery });
  assert.equal(invalidSearch.headers()['cache-control'], 'no-store');
  const webhook = { object_kind: 'merge_request', project: { id: 42 }, object_attributes: {
    id: 102, iid: 8, title: 'NEO-2 파일럿 웹훅', state: 'opened', url: 'https://gitlab.example.test/mr/8',
  } };
  const webhookPath = `${gitlabPath}/webhook`;
  const workspace = await call(session, 'GET', '/api/workspace', 200);
  const beforeBoard = workspace.headers()['x-donefac-board-revision'];
  const beforeGantt = workspace.headers()['x-donefac-gantt-revision'];
  assert.match(beforeBoard, /^[a-f0-9]{32}$/u);
  assert.match(beforeGantt, /^[a-f0-9]{32}$/u);
  const boardCheck = `/api/workspace?teamBoardSince=${beforeBoard}`;
  const unchanged = await call(session, 'GET', boardCheck, 204);
  assert.equal(unchanged.headers()['cache-control'], 'no-store');
  assert.equal(unchanged.headers()['x-donefac-board-revision'], beforeBoard);
  assert.equal((await unchanged.body()).length, 0);
  assert.equal((await call(anonymous, 'GET', boardCheck, 401)).headers()['x-donefac-board-revision'], undefined);
  const ganttCheck = `/api/workspace?ganttSince=${beforeGantt}`;
  await call(session, 'GET', ganttCheck, 204);
  assert.equal((await call(anonymous, 'GET', ganttCheck, 401)).headers()['x-donefac-gantt-revision'], undefined);
  const calendarPath = '/api/projects/project-neo/calendar';
  const calendar = await (await call(session, 'GET', calendarPath, 200)).json();
  const calendarName = 'HTTPS 파일럿 작업 달력';
  await call(session, 'PATCH', calendarPath, 200, {
    headers: { Origin: origin }, data: { expectedVersion: calendar.version, name: calendarName },
  });
  await call(session, 'GET', boardCheck, 204);
  const changedCalendar = await call(session, 'GET', ganttCheck, 200);
  const afterCalendar = changedCalendar.headers()['x-donefac-gantt-revision'];
  assert.match(afterCalendar, /^[a-f0-9]{32}$/u);
  assert.notEqual(afterCalendar, beforeGantt);
  assert.equal((await changedCalendar.json()).calendars.find(item => item.projectId === 'project-neo').name, calendarName);
  await call(anonymous, 'POST', webhookPath, 401, { data: webhook });
  await call(session, 'POST', webhookPath, 401, { headers: { Origin: origin }, data: webhook });
  const incoming = await call(anonymous, 'POST', webhookPath, 200, {
    headers: { 'X-Gitlab-Token': gitlabSecret }, data: webhook,
  });
  assert.equal((await incoming.json()).linked, 1);
  const changedBoard = await call(session, 'GET', boardCheck, 200);
  const afterBoard = changedBoard.headers()['x-donefac-board-revision'];
  assert.match(afterBoard, /^[a-f0-9]{32}$/u);
  assert.notEqual(afterBoard, beforeBoard);
  assert.notEqual(changedBoard.headers()['x-donefac-gantt-revision'], afterCalendar);
  assert.ok((await changedBoard.json()).gitlabLinks.some(link => link.issueId === 'issue-2' &&
    link.kind === 'merge_request' && link.title === webhook.object_attributes.title));
  await call(session, 'GET', `/api/workspace?teamBoardSince=${afterBoard}`, 204);
  await call(anonymous, 'GET', gitlabPath, 401);
  await call(anonymous, 'GET', webhookStatusPath, 401, { headers: { 'X-Gitlab-Token': gitlabSecret } });
  const inbound = await call(session, 'GET', webhookStatusPath, 200);
  assert.equal(inbound.headers()['cache-control'], 'no-store');
  const [repository] = (await inbound.json()).repositories;
  assert.equal(repository.repositoryId, 42);
  assert.equal(repository.lastDelivery.authentication, 'secret-token');
  assert.equal(repository.lastDelivery.linked, 1);
  await call(anonymous, 'GET', syncStatusPath, 401, { headers: { 'X-Gitlab-Token': gitlabSecret } });
  const syncStatus = await call(session, 'GET', syncStatusPath, 200);
  assert.equal(syncStatus.headers()['cache-control'], 'no-store');
  assert.deepEqual(await syncStatus.json(), {
    settingsVersion: savedSettings.version,
    repositories: [{ repositoryId: 42, activity: null, deployments: null }],
  });

  await call(session, 'GET', '/api/v1/issues/issue-1', 401);
  const key = await (await call(session, 'POST', '/api/api-keys', 201, {
    headers: { Origin: origin }, data: { name: '운영 접속 확인', access: 'read', projectIds: ['project-neo'], expiresAt: null },
  })).json();
  assert.ok(typeof key.token === 'string' && key.token.startsWith('ts_'), 'The scoped API key was not issued.');
  protectedValues.push(key.token);
  const bearer = { Authorization: `Bearer ${key.token}` };
  const issue = await call(anonymous, 'GET', '/api/v1/issues/issue-1', 200, { headers: bearer });
  assert.equal((await issue.json()).id, 'issue-1');
  await call(anonymous, 'GET', '/api/v1/issues/issue-9', 403, { headers: bearer });
  await call(anonymous, 'PATCH', '/api/v1/issues/issue-1', 403, { headers: bearer, data: { title: '입력이 거부되어야 함' } });
  await call(anonymous, 'GET', '/api/workspace', 401, { headers: bearer });
  await call(anonymous, 'GET', webhookStatusPath, 401, { headers: bearer });
  await call(anonymous, 'GET', '/api/v1/integrations/gitlab/webhook-status', 403, { headers: bearer });
  await call(anonymous, 'GET', syncStatusPath, 401, { headers: bearer });
  await call(anonymous, 'GET', '/api/v1/integrations/gitlab/sync-status', 403, { headers: bearer });
  await call(anonymous, 'POST', repositorySearchPath, 401, { headers: { ...bearer, Origin: origin }, data: searchWithoutQuery });
  await call(anonymous, 'POST', '/api/v1/integrations/gitlab/repository-search', 403, { headers: bearer, data: searchWithoutQuery });

  const schemaPath = '/api/projects/project-neo/issue-schema';
  const schema = await (await call(session, 'GET', schemaPath, 200)).json();
  const comparisonFieldId = 'pilot_area';
  await call(session, 'PATCH', schemaPath, 200, { headers: { Origin: origin }, data: {
    ...schema, expectedVersion: schema.version, fields: [...schema.fields, {
      id: comparisonFieldId, name: 'HTTPS 확인 범위', description: '', kind: 'multi_select', required: false, archived: false, issueTypes: [],
      options: [{ id: 'client', name: '클라이언트', archived: false }, { id: 'server', name: '서버', archived: false }],
    }],
  } });
  const matrixIssue = await (await call(session, 'POST', '/api/issues', 201, { headers: { Origin: origin }, data: {
    projectId: 'project-neo', title: 'HTTPS 교차 집계 업무', customFields: { [comparisonFieldId]: ['client', 'server'] },
  } })).json();
  const fieldBreakdownPath = '/api/v1/projects/project-neo/field-breakdown';
  const fieldBreakdownQuery = { groupBy: 'status', comparisonFieldId };
  const matrix = await (await call(anonymous, 'POST', fieldBreakdownPath, 200, { headers: bearer, data: fieldBreakdownQuery })).json();
  assert.equal(matrix.comparison.field.id, comparisonFieldId);
  const column = matrix.comparison.columns.find(item => item.label === '서버');
  const row = matrix.groups.find(item => matrix.comparison.counts[item.id]?.[column?.id] === 1);
  assert.ok(row && column);
  const cellQuery = { ...fieldBreakdownQuery, revision: matrix.revision, bucketId: row.id, comparisonBucketId: column.id };
  const cell = await (await call(anonymous, 'POST', `${fieldBreakdownPath}/issues`, 200, { headers: bearer, data: cellQuery })).json();
  assert.deepEqual(cell.issues.map(item => item.id), [matrixIssue.id]);
  await call(anonymous, 'POST', '/api/v1/projects/project-team/field-breakdown', 403, { headers: bearer, data: fieldBreakdownQuery });

  const title = 'HTTPS 팀 결정 조회 검증';
  const text = '외부 전송 없이 저장할 합성 결정 근거입니다.';
  const document = await (await call(session, 'POST', '/api/documents', 201, {
    headers: { Origin: origin }, data: { projectId: 'project-neo', title,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
  })).json();
  const linked = [];
  for (const issueId of ['issue-2', 'issue-9']) {
    const reply = await call(session, 'POST', `/api/documents/${document.id}/decision-links`, 201, {
      headers: { Origin: origin }, data: { requestId: randomUUID(), expectedDocumentVersion: document.version, issueId,
        sourceSelection: { from: 1, to: text.length + 1, text } },
    });
    linked.push((await reply.json()).link);
  }
  const decisionQuery = new URLSearchParams({ status: 'all', q: title });
  const teamDecisions = `/decision-follow-ups?${decisionQuery}`;
  await call(anonymous, 'GET', `/api${teamDecisions}`, 401);
  const decisionResponse = await call(session, 'GET', `/api${teamDecisions}`, 200);
  assert.equal(decisionResponse.headers()['cache-control'], 'no-store');
  const teamResult = await decisionResponse.json();
  assert.equal(teamResult.projectId, null);
  assert.equal(teamResult.total, 2);
  assert.deepEqual(new Set(teamResult.items.map(item => item.linkId)), new Set(linked.map(link => link.id)));
  const restricted = await (await call(anonymous, 'GET', `/api/v1${teamDecisions}`, 200, { headers: bearer })).json();
  assert.equal(restricted.total, 1);
  assert.equal(restricted.items[0].linkId, linked[0].id);
  assert.equal(restricted.items[0].source.text, undefined);
  await call(anonymous, 'GET', `/api/v1${teamDecisions}&projectId=project-team`, 403, { headers: bearer });

  const decisionDraftPath = '/api/decision-follow-ups/meeting-draft';
  const decisionDraftInput = { requestId: randomUUID(), title: 'HTTPS 팀 결정 회의 초안', revision: teamResult.revision,
    status: 'all', q: title, destinationProjectId: null };
  await call(anonymous, 'POST', decisionDraftPath, 401, { headers: { Origin: origin }, data: decisionDraftInput });
  const draft = await (await call(session, 'POST', decisionDraftPath, 201, { headers: { Origin: origin }, data: decisionDraftInput })).json();
  assert.equal(draft.document.projectId, null);
  assert.ok(draft.document.plainText.includes(text));
  assert.deepEqual(new Set(draft.document.content.content.filter(node => node.type === 'issueReference').map(node => node.attrs.issueId)),
    new Set(['issue-2', 'issue-9']));
  const duplicateDraft = await (await call(session, 'POST', decisionDraftPath, 200, { headers: { Origin: origin }, data: decisionDraftInput })).json();
  assert.deepEqual(duplicateDraft, { ...draft, duplicate: true });

  const writer = await (await call(session, 'POST', '/api/api-keys', 201, {
    headers: { Origin: origin, 'X-Actor-Id': 'user-seo' },
    data: { name: 'HTTPS 문서 후속 업무', access: 'write', projectIds: ['project-neo'], expiresAt: null },
  })).json();
  protectedValues.push(writer.token);
  const writerHeaders = { Authorization: `Bearer ${writer.token}`, 'X-Actor-Id': 'user-min' };
  await call(anonymous, 'POST', '/api/v1/decision-follow-ups/meeting-draft', 403, { headers: writerHeaders, data: decisionDraftInput });
  const decisionInput = {
    expectedDocumentVersion: document.version, actorId: 'user-min', sourceSelection: { from: 1, to: text.length + 1, text },
  };
  const followUp = `/api/v1/documents/${document.id}/follow-up-issues`;
  const followUpInput = { ...decisionInput, requestId: randomUUID(), issue: { projectId: 'project-neo', title: 'HTTPS API 후속 업무' } };
  await call(anonymous, 'POST', followUp, 403, { headers: bearer, data: followUpInput });
  const created = await (await call(anonymous, 'POST', followUp, 201, { headers: writerHeaders, data: followUpInput })).json();
  assert.equal(created.issue.reporterId, 'user-seo');
  assert.equal(created.link.documentId, document.id);
  assert.equal(created.link.issueId, created.issue.id);
  assert.equal(created.link.documentSource.text, text);
  const replay = await (await call(anonymous, 'POST', followUp, 200, { headers: writerHeaders, data: followUpInput })).json();
  assert.deepEqual(replay, { ...created, duplicate: true });

  const decision = `/api/v1/documents/${document.id}/decision-links`;
  await call(anonymous, 'POST', decision, 403, { headers: writerHeaders, data: { ...decisionInput, requestId: randomUUID(), issueId: 'issue-9' } });
  const decisionResult = await (await call(anonymous, 'POST', decision, 201, {
    headers: writerHeaders, data: { ...decisionInput, requestId: randomUUID(), issueId: 'issue-1' },
  })).json();
  assert.equal(decisionResult.link.issueId, 'issue-1');
  assert.equal(decisionResult.link.documentSource.revisionId, created.link.documentSource.revisionId);

  const projectReport = '/api/v1/projects/project-neo/report';
  const reportDates = { startDate: '2026-01-01', endDate: '2026-01-07', timeZone: 'Asia/Seoul' };
  const reportSearch = new URLSearchParams(reportDates);
  const liveReport = await call(anonymous, 'GET', `${projectReport}?${reportSearch}`, 200, { headers: bearer });
  assert.equal(liveReport.headers()['cache-control'], 'no-store');
  assert.equal((await liveReport.json()).query.projectId, 'project-neo');
  await call(anonymous, 'GET', `/api/v1/projects/project-team/report?${reportSearch}`, 403, { headers: bearer });
  const snapshots = `${projectReport}-snapshots`;
  const snapshotInput = {
    requestId: randomUUID(), title: 'HTTPS 파일럿 주간 보고서', actorId: 'user-min',
    query: { projectId: 'project-neo', ...reportDates },
  };
  await call(anonymous, 'POST', snapshots, 403, { headers: bearer, data: snapshotInput });
  const snapshot = await (await call(anonymous, 'POST', snapshots, 201, { headers: writerHeaders, data: snapshotInput })).json();
  assert.equal(snapshot.actorId, 'user-seo');
  const snapshotRetry = await (await call(anonymous, 'POST', snapshots, 200, { headers: writerHeaders, data: snapshotInput })).json();
  assert.deepEqual(snapshotRetry, snapshot);
  assert.deepEqual(await (await call(anonymous, 'GET', `${snapshots}/${snapshot.id}`, 200, { headers: bearer })).json(), snapshot);
  const weeklyDocument = await (await call(anonymous, 'GET', `/api/v1/documents/${snapshot.documentId}`, 200, { headers: bearer })).json();
  assert.equal(weeklyDocument.projectId, 'project-neo');
  assert.equal(weeklyDocument.status, 'draft');
  assert.ok(JSON.stringify(weeklyDocument.content).includes(`#/project-neo/reports/${snapshot.id}`));

  const release = await (await call(session, 'POST', '/api/planning-items', 201, {
    headers: { Origin: origin }, data: { projectId: 'project-neo', kind: 'release', name: 'HTTPS 파일럿 릴리스', targetDate: '2026-11-20' },
  })).json();
  const scheduleRisk = await (await call(session, 'POST', '/api/issues', 201, {
    headers: { Origin: origin }, data: { projectId: 'project-neo', releaseId: release.id, title: 'HTTPS 릴리스 일정 점검' },
  })).json();
  const readinessQuery = new URLSearchParams({ releaseId: release.id, reason: 'missing_schedule' });
  const readinessPath = `/api/v1/projects/project-neo/delivery-blockers?${readinessQuery}`;
  await call(session, 'GET', readinessPath, 401);
  const readiness = await (await call(anonymous, 'GET', readinessPath, 200, { headers: bearer })).json();
  assert.deepEqual(readiness.release, { id: release.id, name: release.name, version: release.version, deadline: release.targetDate, deadlineSource: 'targetDate' });
  assert.equal(readiness.counts.reasons.missing_schedule, 1);
  assert.deepEqual(readiness.items.map(row => row.issue.id), [scheduleRisk.id]);
  await call(anonymous, 'GET', readinessPath.replace('project-neo', 'project-team'), 403, { headers: bearer });

  const findings = '/source-imports/00000000-0000-4000-8000-000000000001/reconciliation/jira-status-findings?expectedVersion=1&finding=unavailable';
  await call(anonymous, 'GET', `/api${findings}`, 401);
  await call(anonymous, 'GET', `/api${findings}`, 401, { headers: bearer });
  await call(anonymous, 'GET', `/api/v1${findings}`, 403, { headers: bearer });
  await call(session, 'GET', `/api${findings}`, 404);
}

async function verifySignedGitlabWebhooks(session, anonymous, origin) {
  const integration = '/api/integrations/gitlab';
  const webhook = `${integration}/webhook`;
  const readStatus = async () => (await call(session, 'GET', `${integration}/webhook-status`, 200)).json();
  const settings = await (await call(session, 'GET', integration, 200)).json();
  const key = randomBytes(32);
  const signingToken = `whsec_${key.toString('base64')}`;
  protectedValues.push(signingToken);
  const signedSettings = await (await call(session, 'PATCH', integration, 200, {
    headers: { Origin: origin }, data: { expectedVersion: settings.version, signingToken },
  })).json();
  assert.equal(signedSettings.signingTokenConfigured, true);
  assert.equal(signedSettings.webhookSecretConfigured, true);
  const before = await readStatus();
  assert.equal(before.settingsVersion, signedSettings.version);
  assert.equal(before.repositories[0].lastDelivery, null);
  assert.deepEqual(before.repositories[0].lastAcceptedByEvent ?? {}, {});

  const repositoryUrl = `${settings.baseUrl}/team/pilot`;
  const project = { id: 42, web_url: repositoryUrl, path_with_namespace: 'team/pilot' };
  const branch = 'feature/NEO-1-https-signed';
  const sha = 'a'.repeat(40);
  const happenedAt = new Date(Date.now() - 30_000).toISOString();
  const commitUrl = `${repositoryUrl}/-/commit/${sha}`;
  const mrUrl = `${repositoryUrl}/-/merge_requests/31`;
  const pipelineUrl = `${repositoryUrl}/-/pipelines/701`;
  const events = [
    { event: 'push', name: 'Push Hook', linked: 2, payload: {
      object_kind: 'push', project_id: project.id, project, ref: `refs/heads/${branch}`,
      before: '0'.repeat(40), after: sha, checkout_sha: sha, total_commits_count: 1,
      commits: [{ id: sha, title: 'NEO-1 HTTPS 서명 커밋', timestamp: happenedAt, url: commitUrl }],
    } },
    { event: 'merge_request', name: 'Merge Request Hook', linked: 1, trigger: 'merge_request.opened', payload: {
      object_kind: 'merge_request', project, object_attributes: {
        id: 731, iid: 31, source_branch: branch, target_project_id: project.id, title: 'NEO-1 HTTPS 서명 MR',
        sha, state: 'opened', action: 'open', updated_at: happenedAt, url: mrUrl,
      },
    } },
    { event: 'pipeline', name: 'Pipeline Hook', linked: 1, trigger: 'pipeline.succeeded', payload: {
      object_kind: 'pipeline', project, object_attributes: {
        id: 701, ref: branch, sha, status: 'success', finished_at: happenedAt, url: pipelineUrl,
      },
    } },
    { event: 'deployment', name: 'Deployment Hook', linked: 0, deploymentUpdated: true, trigger: 'deployment.succeeded', payload: {
      object_kind: 'deployment', project, deployment_id: 901, status: 'success', status_changed_at: happenedAt,
      environment: 'staging', environment_tier: 'staging', commit_url: commitUrl, short_sha: sha.slice(0, 8),
    } },
  ].map(event => {
    // The original whitespace and UTF-8 text must reach the Express verifier intact.
    const data = Buffer.from(`${JSON.stringify(event.payload, null, 2)}\n`, 'utf8');
    const id = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(data).digest('base64');
    protectedValues.push(signature);
    const headers = { 'Content-Type': 'application/json', 'X-Gitlab-Event': event.name, 'webhook-id': id,
      'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
    return { ...event, data, headers };
  });
  const [push] = events;
  await call(anonymous, 'POST', webhook, 401, {
    headers: { ...push.headers, 'X-Gitlab-Token': gitlabSecret }, data: Buffer.from(JSON.stringify(push.payload)),
  });
  await call(anonymous, 'POST', webhook, 401, {
    headers: { ...push.headers, 'X-Gitlab-Token': gitlabSecret, 'webhook-signature': `v1,${Buffer.alloc(32).toString('base64')}` },
    data: push.data,
  });
  assert.deepEqual(await readStatus(), before);

  for (const event of events) {
    const response = await call(anonymous, 'POST', webhook, 200, { headers: event.headers, data: event.data });
    assert.deepEqual(await response.json(), { ok: true, duplicate: false, linked: event.linked, runs: [],
      ...(event.deploymentUpdated ? { deploymentUpdated: true } : {}) });
  }
  const [after] = (await readStatus()).repositories;
  assert.equal(after.repositoryId, project.id);
  assert.deepEqual(Object.keys(after.lastAcceptedByEvent).sort(), events.map(({ event }) => event).sort());
  for (const { event, linked, deploymentUpdated, trigger } of events) {
    const accepted = after.lastAcceptedByEvent[event];
    assert.ok(Number.isFinite(Date.parse(accepted.receivedAt)));
    assert.deepEqual(accepted, { event, authentication: 'signing-token', receivedAt: accepted.receivedAt,
      duplicate: false, linked, automationRuns: 0, ...(deploymentUpdated ? { deploymentUpdated: true } : {}),
      ...(trigger ? { stateAutomation: { result: 'evaluated', trigger, occurredAt: happenedAt, candidateTickets: 1,
        outcomes: { changed: 0, no_op: 0, blocked: 0, ignored: 0 } } } : {}) });
  }
  assert.deepEqual(after.lastDelivery, after.lastAcceptedByEvent.deployment);

  const [, , pipeline] = events;
  const replay = await call(anonymous, 'POST', webhook, 200, { headers: pipeline.headers, data: pipeline.data });
  assert.deepEqual(await replay.json(), { ok: true, duplicate: true, linked: 0, runs: [] });
  const [afterReplay] = (await readStatus()).repositories;
  assert.deepEqual(afterReplay.lastAcceptedByEvent, after.lastAcceptedByEvent);
  assert.deepEqual(afterReplay.lastDelivery, { event: 'pipeline', authentication: 'signing-token',
    receivedAt: afterReplay.lastDelivery.receivedAt, duplicate: true, linked: 0, automationRuns: 0 });

  const workspace = await (await call(session, 'GET', '/api/workspace', 200)).json();
  const links = workspace.gitlabLinks.filter(link => link.projectId === project.id && link.sourceBranch === branch);
  assert.deepEqual(links.map(link => [link.kind, link.issueId, link.sourceSha]).sort(), [
    ['branch', 'issue-1', sha], ['commit', 'issue-1', sha], ['merge_request', 'issue-1', sha], ['pipeline', 'issue-1', sha],
  ]);
  assert.equal(links.find(link => link.kind === 'commit').webUrl, commitUrl);
  assert.equal(links.find(link => link.kind === 'merge_request').webUrl, mrUrl);
  assert.equal(links.find(link => link.kind === 'pipeline').webUrl, pipelineUrl);
  const repositoryDeployments = await (await call(session, 'GET', `${integration}/deployments?repositoryId=${project.id}`, 200)).json();
  const issueDeployments = await (await call(session, 'GET', '/api/issues/issue-1/gitlab-deployments', 200)).json();
  assert.equal(repositoryDeployments.total, 1);
  assert.equal(issueDeployments.total, 1);
  assert.deepEqual(issueDeployments.items, repositoryDeployments.items);
  assert.deepEqual(repositoryDeployments.items.map(item => [item.deploymentId, item.status, item.sha, item.environment]), [
    [901, 'success', sha, 'staging'],
  ]);
  checkCredentials(JSON.stringify(afterReplay), 'Signed GitLab webhook status');

  const restoredSettings = await (await call(session, 'PATCH', integration, 200, {
    headers: { Origin: origin }, data: { expectedVersion: signedSettings.version, signingToken: '' },
  })).json();
  assert.equal(restoredSettings.signingTokenConfigured, false);
  assert.equal(restoredSettings.webhookSecretConfigured, true);
  assert.equal((await readStatus()).repositories[0].lastDelivery, null);
}

async function verifyGitlabMessageCorrelation(session, anonymous, origin) {
  const integration = '/api/integrations/gitlab';
  const webhook = `${integration}/webhook`;
  const history = `${integration}/project-webhook-history`;
  const repository = '/api/v4/projects/42';
  const deploymentReads = [];
  const receiver = origin + webhook;
  const webhookId = randomUUID();
  const proxyOnly = randomUUID();
  const readToken = randomBytes(20).toString('hex');
  protectedValues.push(readToken, webhookId, proxyOnly);
  const source = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET' || request.headers['private-token'] !== readToken) {
      response.writeHead(403).end();
      return;
    }
    if (path === repository) {
      deploymentReads.push(path);
      response.setHeader('Content-Type', 'application/json').end(JSON.stringify({
        id: 42, path_with_namespace: 'team/pilot', web_url: `http://127.0.0.1:${source.address().port}/team/pilot`,
      }));
    } else if (path === `${repository}/deployments`) {
      deploymentReads.push(path);
      response.setHeader('Content-Type', 'application/json').end('[]');
    } else if (path === `${repository}/hooks`) {
      response.setHeader('Content-Type', 'application/json').end(JSON.stringify([{
        id: 17, project_id: 42, url: receiver, push_events: true, merge_requests_events: true,
        pipeline_events: true, deployment_events: true, enable_ssl_verification: true, alert_status: 'executable',
      }]));
    } else if (path === `${repository}/hooks/17/events`) {
      response.setHeader('Content-Type', 'application/json').end(JSON.stringify([
        { id: 10, url: receiver, trigger: 'push_hooks', response_status: 200, request_headers: { 'webhook-id': proxyOnly } },
        { id: 11, url: receiver, trigger: 'push_hooks', response_status: 502, request_headers: { 'webhook-id': webhookId } },
      ]));
    } else response.writeHead(404).end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  try {
    const settings = await (await call(session, 'GET', integration, 200)).json();
    const saved = await (await call(session, 'PATCH', integration, 200, { headers: { Origin: origin }, data: {
      expectedVersion: settings.version, baseUrl: `http://127.0.0.1:${source.address().port}`, projectIds: [42], token: readToken,
    } })).json();
    const input = { headers: { Origin: origin }, data: { expectedVersion: saved.version, repositoryId: 42, hookId: 17 } };
    await call(anonymous, 'POST', history, 401, input);
    await call(anonymous, 'POST', webhook, 200, { headers: { 'X-Gitlab-Token': gitlabSecret, 'Idempotency-Key': webhookId },
      data: { object_kind: 'push', project_id: 42 } });
    const response = await call(session, 'POST', history, 200, input);
    const raw = await response.text();
    checkCredentials(raw, 'GitLab message correlation');
    const { attempts, localReceipt } = JSON.parse(raw);
    assert.deepEqual(attempts.map(({ status, messageReceipt }) => [status, messageReceipt.status]), [[200, 'unconfirmed'], [502, 'matched']]);
    assert.deepEqual(attempts[1].messageReceipt.delivery, localReceipt);

    const preview = `${integration}/deployments/preview`;
    const previewData = { expectedVersion: saved.version, repositoryId: 42 };
    const savedDeployments = () => Promise.all([`${integration}/deployments?repositoryId=42`, `${integration}/sync-status`]
      .map(async path => (await call(session, 'GET', path, 200)).json()));
    const before = await savedDeployments();
    await call(anonymous, 'POST', preview, 401, { headers: { Origin: origin }, data: previewData });
    await call(session, 'POST', preview, 403, { data: previewData });
    assert.deepEqual(deploymentReads, []);

    const previewResponse = await call(session, 'POST', preview, 200, { headers: { Origin: origin }, data: previewData });
    assert.equal(previewResponse.headers()['cache-control'], 'no-store');
    const previewBody = await previewResponse.text();
    checkCredentials(previewBody, 'GitLab deployment preview');
    assert.deepEqual(JSON.parse(previewBody), { repositoryId: 42, settingsVersion: saved.version, status: 'empty', deploymentsRead: 0,
      successfulDeployments: 0, mergeRequestsRead: 0, deploymentLimitReached: false, associationUnavailable: 0, associationLimited: 0,
      associationDenied: 0, associationRateLimited: 0 });
    assert.deepEqual(deploymentReads, [repository, `${repository}/deployments`]);
    assert.deepEqual(await savedDeployments(), before);
  } finally {
    await new Promise((resolve, reject) => {
      source.close(error => error ? reject(error) : resolve());
      source.closeAllConnections();
    });
  }
}

async function verifyBrowser(origin) {
  browser = await chromium.launch({ ...browserConfig.use.launchOptions, timeout: 15_000 });
  const session = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const colleagueSession = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const anonymous = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    session.setDefaultTimeout(socketTimeout);
    colleagueSession.setDefaultTimeout(socketTimeout);
    await colleagueSession.addInitScript(() => localStorage.setItem('donefac.actor', 'user-seo'));
    const page = await session.newPage();
    const seenUrls = [];
    session.on('request', entry => seenUrls.push(entry.url()));
    colleagueSession.on('request', entry => seenUrls.push(entry.url()));
    const fragment = '#/project-neo/documents/doc-overview';
    const initial = await page.goto(`/${fragment}`);
    assert.equal(initial.status(), 200);
    checkCredentials(await initial.body(), 'Signed-out HTML');
    const secret = page.getByLabel('팀 접속 키', { exact: true });
    const login = page.getByRole('button', { name: '접속', exact: true });
    await expectSoon(secret).toHaveAttribute('type', 'password');
    const probe = await session.newPage();
    try {
      const blocked = await probe.goto('/api/workspace');
      assert.equal(blocked.status(), 401, 'A signed-out browser could retrieve workspace data.');
    } finally { await probe.close(); }

    await secret.fill('0'.repeat(64));
    const [wrongLogin] = await Promise.all([
      page.waitForResponse(response => response.url() === `${origin}/pilot-access` && response.request().method() === 'POST'),
      login.click(),
    ]);
    assert.equal(wrongLogin.status(), 401);
    await expectSoon(secret).toBeVisible();
    assert.equal((await session.cookies()).length, 0);
    await secret.fill(accessCode);
    await login.click();
    await expectSoon(page).toHaveURL(`${origin}/${fragment}`);
    await expectSoon(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue('엣지 플랫폼 개요');
    const [cookie] = await session.cookies(origin);
    assert.ok(cookie && cookie.name.startsWith('__Host-') && cookie.path === '/' && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Lax',
      'The pilot session must use an HttpOnly, Secure, SameSite=Lax host cookie.');
    assert.ok(cookie.value && cookie.value !== accessCode, 'The session cookie must carry an opaque token.');
    protectedValues.push(cookie.value);
    assert.equal(await page.evaluate(name => document.cookie.includes(name), cookie.name), false);
    const sessionCookie = `${cookie.name}=${cookie.value}`;
    const wrongOrigin = 'https://other.example.test';
    await call(session.request, 'GET', '/api/workspace', 421, { headers: { Host: 'other.example.test', 'X-Forwarded-Host': new URL(origin).host } });
    await call(session.request, 'PATCH', '/api/issues/issue-1', 403, { headers: { Origin: wrongOrigin }, data: {} });
    await call(anonymous, 'POST', '/pilot-access', 403, { headers: { Origin: wrongOrigin }, form: { accessCode } });

    const socketUrl = new URL('/api/collaboration?documentId=doc-overview&actorId=user-min', origin);
    socketUrl.protocol = 'wss:';
    const [socket] = await Promise.all([
      page.waitForEvent('websocket', value => new URL(value.url()).pathname === '/api/collaboration'),
      page.getByRole('button', { name: '공동 편집 시작', exact: true }).click(),
    ]);
    const editor = page.locator('.docs-live-prose');
    await expectSoon(editor).toBeVisible();
    await expectSoon(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

    const colleague = await colleagueSession.newPage();
    await colleague.goto(`/${fragment}`);
    await colleague.getByLabel('팀 접속 키', { exact: true }).fill(accessCode);
    await colleague.getByRole('button', { name: '접속', exact: true }).click();
    await expectSoon(colleague).toHaveURL(`${origin}/${fragment}`);
    await expectSoon(colleague.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expectSoon(colleague.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    await colleague.getByRole('button', { name: '문서 구독', exact: true }).click();
    await expectSoon(colleague.getByRole('button', { name: '문서 구독 해제', exact: true })).toBeEnabled();
    const [colleagueCookie] = await colleagueSession.cookies(origin);
    assert.ok(colleagueCookie && colleagueCookie.value !== cookie.value, 'Separate browser contexts must have separate sessions.');
    protectedValues.push(colleagueCookie.value);

    const edit = ' HTTPS 파일럿 공동 편집 검증';
    await editor.click();
    await editor.press('Control+End');
    await page.keyboard.insertText(edit);
    await expectSoon(colleague.locator('.docs-live-prose')).toContainText(edit.trim());
    await expectSoon.poll(async () => {
      const response = await call(session.request, 'GET', '/api/documents/doc-overview/collaboration', 200);
      return (await response.json()).document.plainText;
    }).toContain(edit.trim());
    await page.getByRole('button', { name: '버전 기록', exact: true }).click();
    await expectSoon.poll(async () => {
      const inbox = await call(colleagueSession.request, 'GET', '/api/notifications', 200, { headers: { 'X-Actor-Id': 'user-seo' } });
      return (await inbox.json()).items.map(item => item.kind);
    }).toEqual(['document-updated']);
    assert.equal(new URL(socket.url()).origin, socketUrl.origin);
    await rejectSocket(socketUrl, { Origin: origin }, 401);
    await rejectSocket(socketUrl, { Origin: wrongOrigin, Cookie: sessionCookie }, 403);
    await rejectSocket(socketUrl, { Origin: origin, Host: 'other.example.test', Cookie: sessionCookie }, 421);
    await rejectSocket(socketUrl, { Cookie: sessionCookie }, 403);

    await verifyIntegrations(session.request, anonymous, origin);
    const boardPage = await session.newPage();
    try {
      const boardUrl = `${origin}/#/project-neo/teamboard?boardGitlab=open_merge_request`;
      await boardPage.goto(boardUrl);
      const board = boardPage.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
      await expectSoon(boardPage.getByRole('combobox', { name: 'GitLab 조건', exact: true })).toHaveValue('open_merge_request');
      await expectSoon(board.getByRole('button', { name: 'NEO-2 업무 열기', exact: true })).toBeVisible();
      await expectSoon(board.getByRole('button', { name: 'NEO-1 업무 열기', exact: true })).toHaveCount(0);
      await expectSoon(boardPage).toHaveURL(boardUrl);
    } finally { await boardPage.close(); }
    await verifySignedGitlabWebhooks(session.request, anonymous, origin);
    await verifyGitlabMessageCorrelation(session.request, anonymous, origin);
    for (const path of ['/api/workspace', '/api/export', '/api/api-keys', '/api/integrations/gitlab',
      '/api/integrations/gitlab/webhook-status', '/api/integrations/gitlab/sync-status']) {
      const response = await call(session.request, 'GET', path, 200);
      checkCredentials(await response.body(), path);
    }
    checkCredentials(socket.url(), 'Collaboration WebSocket URL');

    const [logout] = await Promise.all([
      session.waitForEvent('page'),
      page.getByRole('link', { name: '팀 접속', exact: true }).click(),
    ]);
    await expectSoon(logout).toHaveURL(`${origin}/pilot-access`);
    assert.equal(socket.isClosed(), false, 'The collaboration socket must still be open before logout.');
    const closed = new Promise(resolve => socket.once('close', resolve));
    await logout.getByRole('button', { name: '접속 종료', exact: true }).click();
    await expectSoon(logout.getByLabel('팀 접속 키', { exact: true })).toBeVisible();
    await deadline(closed, 'Logout did not close the other tab’s collaboration socket.');
    assert.ok(!(await session.cookies(origin)).some(entry => entry.name === cookie.name), 'Logout did not clear the session cookie.');
    await call(anonymous, 'GET', '/api/workspace', 401, { headers: { Cookie: sessionCookie } });
    await rejectSocket(socketUrl, { Origin: origin, Cookie: sessionCookie }, 401);
    await call(colleagueSession.request, 'GET', '/api/workspace', 200);
    await expectSoon(colleague.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    checkCredentials(seenUrls.join('\n'), 'Browser request URLs');
  } finally {
    await Promise.all([session.close(), colleagueSession.close(), anonymous.dispose()]);
  }
}

async function run() {
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    proxy = await startPilotTestProxy(scratch);
    const { origin } = proxy;
    await startBackend(origin);
    await verifyBrowser(origin);
    await stopBackend();
    checkCredentials(backendLogs, 'Pilot process logs');
    interruption.signal.throwIfAborted();

    const backup = spawnSync(process.execPath, ['scripts/pilot-backup.mjs', 'backup', dataDir, backupDir], {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
    });
    if (backup.error) throw backup.error;
    assert.equal(backup.status, 0, backup.stderr);
    checkCredentials(backup.stdout + backup.stderr, 'Pilot backup logs');
    for (const entry of readdirSync(backupDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) checkCredentials(readFileSync(join(entry.parentPath, entry.name)), 'Pilot backup');
    }
    console.log('Pilot HTTPS access, browser collaboration, board and Gantt refresh, scoped field breakdowns and decision follow-ups, weekly reports and release readiness, signed GitLab delivery, logout and backup verified.');
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        try { await proxy?.close(); }
        finally { await stopBackend(false); }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
      }
    }
  }
}

try { await run(); }
catch (error) {
  let details = String(error?.stack ?? error);
  for (const value of protectedValues) details = details.replaceAll(value, '[redacted]');
  console.error(details);
  process.exitCode ||= 1;
}
