import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, request } from '@playwright/test';
import WebSocket from 'ws';
import browserConfig from '../playwright.config.ts';
import { startPilotTestProxy } from './pilot-test-proxy.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'teamspace-pilot-access-'));
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
      TEAMSPACE_PILOT_PORT: '0', TEAMSPACE_PILOT_DEMO: '1', TEAMSPACE_PILOT_OUTBOUND: '0',
      TEAMSPACE_PILOT_ORIGIN: origin, TEAMSPACE_PILOT_ACCESS_FILE: accessFile,
    },
  });
  backendExit = once(backend, 'close');
  backend.stderr.on('data', chunk => { backendLogs += chunk; });
  const ready = new Promise(resolve => {
    backend.stdout.on('data', chunk => {
      backendLogs += chunk;
      const match = /Teamspace pilot listening on http:\/\/127\.0\.0\.1:(\d+)\s/.exec(backendLogs);
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
  const beforeBoard = workspace.headers()['x-teamspace-board-revision'];
  const beforeGantt = workspace.headers()['x-teamspace-gantt-revision'];
  assert.match(beforeBoard, /^[a-f0-9]{32}$/u);
  assert.match(beforeGantt, /^[a-f0-9]{32}$/u);
  const boardCheck = `/api/workspace?teamBoardSince=${beforeBoard}`;
  const unchanged = await call(session, 'GET', boardCheck, 204);
  assert.equal(unchanged.headers()['cache-control'], 'no-store');
  assert.equal(unchanged.headers()['x-teamspace-board-revision'], beforeBoard);
  assert.equal((await unchanged.body()).length, 0);
  assert.equal((await call(anonymous, 'GET', boardCheck, 401)).headers()['x-teamspace-board-revision'], undefined);
  const ganttCheck = `/api/workspace?ganttSince=${beforeGantt}`;
  await call(session, 'GET', ganttCheck, 204);
  assert.equal((await call(anonymous, 'GET', ganttCheck, 401)).headers()['x-teamspace-gantt-revision'], undefined);
  const calendarPath = '/api/projects/project-neo/calendar';
  const calendar = await (await call(session, 'GET', calendarPath, 200)).json();
  const calendarName = 'HTTPS 파일럿 작업 달력';
  await call(session, 'PATCH', calendarPath, 200, {
    headers: { Origin: origin }, data: { expectedVersion: calendar.version, name: calendarName },
  });
  await call(session, 'GET', boardCheck, 204);
  const changedCalendar = await call(session, 'GET', ganttCheck, 200);
  const afterCalendar = changedCalendar.headers()['x-teamspace-gantt-revision'];
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
  const afterBoard = changedBoard.headers()['x-teamspace-board-revision'];
  assert.match(afterBoard, /^[a-f0-9]{32}$/u);
  assert.notEqual(afterBoard, beforeBoard);
  assert.notEqual(changedBoard.headers()['x-teamspace-gantt-revision'], afterCalendar);
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

  const writer = await (await call(session, 'POST', '/api/api-keys', 201, {
    headers: { Origin: origin, 'X-Actor-Id': 'user-seo' },
    data: { name: 'HTTPS 문서 후속 업무', access: 'write', projectIds: ['project-neo'], expiresAt: null },
  })).json();
  protectedValues.push(writer.token);
  const writerHeaders = { Authorization: `Bearer ${writer.token}`, 'X-Actor-Id': 'user-min' };
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

  const findings = '/source-imports/00000000-0000-4000-8000-000000000001/reconciliation/jira-status-findings?expectedVersion=1&finding=unavailable';
  await call(anonymous, 'GET', `/api${findings}`, 401);
  await call(anonymous, 'GET', `/api${findings}`, 401, { headers: bearer });
  await call(anonymous, 'GET', `/api/v1${findings}`, 403, { headers: bearer });
  await call(session, 'GET', `/api${findings}`, 404);
}

async function verifyBrowser(origin) {
  browser = await chromium.launch({ ...browserConfig.use.launchOptions, timeout: 15_000 });
  const session = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const colleagueSession = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const anonymous = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    session.setDefaultTimeout(socketTimeout);
    colleagueSession.setDefaultTimeout(socketTimeout);
    await colleagueSession.addInitScript(() => localStorage.setItem('teamspace.actor', 'user-seo'));
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
    console.log('Pilot HTTPS access, browser collaboration, board and Gantt refresh, the shared GitLab board filter, scoped decision follow-ups and integrations, logout and backup verified.');
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
