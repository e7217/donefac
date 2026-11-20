import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, request as apiRequest, test, type APIRequestContext, type BrowserContext, type Dialog, type Page } from '@playwright/test';
import type { Editor } from '@tiptap/core';
import type { CollaborationClientMessage, CollaborationServerMessage, CollaborationSession } from '../../shared/collaboration';
import type { DocPage, DocRevision } from '../../shared/types';
import { verifyWorkspaceTraffic } from './workspace-traffic';

interface Fixture {
  actorIds: string[];
  projectId: string;
  issueId: string;
  documentId: string;
  title: string;
  initialText: string;
  initialEpoch: string;
  seconds: number;
  evidencePath: string;
}

interface Peer {
  actorId: string;
  ordinal: number;
  context: BrowserContext;
  page: Page;
  connections: number;
  closes: number;
  errors: string[];
  welcomedEpochs: string[];
  sentUpdates: Set<string>;
  acknowledgments: Set<string>;
}

const TEAM_SIZE = 20;
const OPEN_BATCH_SIZE = 4;
const SYNC_TIMEOUT = 25_000;
const SESSION_COOKIE = '__Host-teamspace-pilot';
const state = (page: Page) => page.locator('.docs-collaboration-state');
const editor = (page: Page) => page.locator('.docs-live-prose');
const presence = (page: Page) => page.locator('.docs-collaboration-presence');
const marker = (round: number, peer: Peer) => `[team-edit-${round}-${peer.ordinal}]`;

function loadFixture(): Fixture {
  const raw = process.env.TEAMSPACE_PILOT_TEAM_FIXTURE;
  if (!raw) throw new Error('Run npm run test:pilot:team to create an isolated team pilot.');
  const fixture = JSON.parse(raw) as Fixture;
  if (!Array.isArray(fixture.actorIds) || fixture.actorIds.length !== TEAM_SIZE || new Set(fixture.actorIds).size !== TEAM_SIZE ||
    fixture.actorIds.some(id => typeof id !== 'string' || !id) || !Number.isSafeInteger(fixture.seconds) || fixture.seconds < 1 ||
    !fixture.projectId || !fixture.issueId || !fixture.documentId || !fixture.initialEpoch || !fixture.title || !fixture.initialText || !fixture.evidencePath) {
    throw new Error('The isolated team pilot fixture is invalid.');
  }
  return fixture;
}

async function loadAccessCode() {
  const filename = process.env.TEAMSPACE_PILOT_TEST_ACCESS_FILE;
  if (!filename || !isAbsolute(filename)) throw new Error('An isolated pilot access file is required.');
  const accessCode = (await readFile(filename, 'utf8').catch(() => {
    throw new Error('The isolated pilot access file could not be read.');
  })).trim();
  if (!/^[0-9a-f]{64}$/.test(accessCode)) throw new Error('The isolated pilot access code is invalid.');
  return accessCode;
}

async function signInRequests(request: APIRequestContext, accessCode: string) {
  expect((await request.get('/api/workspace')).status(), 'Anonymous pilot API access').toBe(401);
  const status = await request.post('/pilot-access', { form: { accessCode }, maxRedirects: 0 })
    .then(response => response.status())
    .catch(() => { throw new Error('Could not submit the pilot API session login.'); });
  expect(status, 'Pilot API session login').toBe(303);
}

async function signInBrowser(peer: Peer, baseURL: string, location: string, accessCode: string, sessionTokens: Set<string>) {
  const password = peer.page.getByLabel('팀 접속 키', { exact: true });
  await expect(password).toHaveAttribute('type', 'password', { timeout: SYNC_TIMEOUT });
  try {
    await password.fill(accessCode, { timeout: SYNC_TIMEOUT });
    const [response] = await Promise.all([
      peer.page.waitForResponse(response => response.url() === `${baseURL}/pilot-access` && response.request().method() === 'POST', { timeout: SYNC_TIMEOUT }),
      peer.page.getByRole('button', { name: '접속', exact: true }).click({ timeout: SYNC_TIMEOUT }),
    ]);
    if (response.status() !== 303) throw new Error('Pilot access did not redirect.');
    await peer.page.waitForURL(`${baseURL}${location}`, { waitUntil: 'domcontentloaded', timeout: SYNC_TIMEOUT });
  } catch {
    throw new Error(`Player ${peer.ordinal} could not sign in and return to the document.`);
  }
  const cookie = (await peer.context.cookies(baseURL)).find(entry => entry.name === SESSION_COOKIE);
  if (!cookie?.secure || !cookie.httpOnly || cookie.sameSite !== 'Lax' || cookie.path !== '/' ||
      !/^[A-Za-z0-9_-]{43}$/.test(cookie.value) || sessionTokens.has(cookie.value)) {
    throw new Error(`Player ${peer.ordinal} did not receive a unique protected session cookie.`);
  }
  sessionTokens.add(cookie.value);
}

function observeWire(peer: Peer, baseURL: string, documentId: string) {
  const expectedOrigin = new URL(baseURL);
  expectedOrigin.protocol = 'wss:';
  peer.page.on('websocket', socket => {
    const url = new URL(socket.url());
    const queryFields = [...url.searchParams.keys()].sort();
    if (url.origin !== expectedOrigin.origin || url.pathname !== '/api/collaboration' || url.username || url.password || url.hash ||
      queryFields.length !== 2 || queryFields[0] !== 'actorId' || queryFields[1] !== 'documentId' ||
      url.searchParams.get('actorId') !== peer.actorId || url.searchParams.get('documentId') !== documentId) {
      peer.errors.push(`Unexpected WebSocket for player ${peer.ordinal}.`);
      return;
    }
    peer.connections++;
    socket.on('close', () => { peer.closes++; });
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload)) as CollaborationClientMessage;
      if (message.type === 'update') peer.sentUpdates.add(message.requestId);
    });
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload)) as CollaborationServerMessage;
      if (message.type === 'welcome') peer.welcomedEpochs.push(message.epoch);
      if (message.type === 'ack' && peer.sentUpdates.has(message.requestId)) peer.acknowledgments.add(message.requestId);
      if (message.type === 'error') peer.errors.push(message.code);
    });
  });
}

async function session(request: APIRequestContext, documentId: string): Promise<CollaborationSession> {
  const response = await request.get(`/api/documents/${documentId}/collaboration`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<CollaborationSession>;
}

async function synchronized(peer: Peer, epoch: string, count: number) {
  const label = `player ${peer.ordinal}`;
  await expect(state(peer.page), `${label} synchronized`).toHaveText('서버에 동기화됨', { timeout: SYNC_TIMEOUT });
  await expect(editor(peer.page), `${label} editable`).toHaveAttribute('contenteditable', 'true', { timeout: SYNC_TIMEOUT });
  await expect(presence(peer.page), `${label} presence`).toContainText(`${count}명 접속`, { timeout: SYNC_TIMEOUT });
  expect(peer.welcomedEpochs.at(-1), `${label} welcome epoch`).toBe(epoch);
}

async function append(peer: Peer, value: string) {
  // Use the same editor transaction path as local typing and leave the other pages' focus alone.
  await editor(peer.page).evaluate((element, text) => {
    const tiptap = (element as HTMLElement & { editor?: Editor }).editor;
    if (!tiptap?.isEditable) throw new Error('The collaborative editor is unavailable for local input.');
    const { doc, tr } = tiptap.state;
    if (doc.childCount !== 1 || doc.lastChild?.type.name !== 'paragraph') throw new Error('The pilot document needs one paragraph.');
    tiptap.view.dispatch(tr.insertText(` ${text}`, doc.content.size - 1));
  }, value, { timeout: SYNC_TIMEOUT });
}

async function matchesRendered(peers: Peer[], current: DocPage, epoch: string) {
  await Promise.all(peers.map(async peer => {
    await synchronized(peer, epoch, peers.length);
    await expect.poll(() => editor(peer.page).innerText({ timeout: SYNC_TIMEOUT }), {
      message: `player ${peer.ordinal} body matches durable content`, timeout: SYNC_TIMEOUT,
    }).toBe(current.plainText);
  }));
}

async function wave(request: APIRequestContext, prior: DocPage, epoch: string, peers: Peer[], edits: { peer: Peer; value: string }[]) {
  const ackBefore = edits.map(({peer}) => peer.acknowledgments.size);
  await Promise.all(edits.map(({peer, value}) => append(peer, value)));
  await Promise.all(edits.map(({peer}, index) => expect.poll(() => peer.acknowledgments.size, {
    message: `player ${peer.ordinal} received a durable acknowledgment`, timeout: SYNC_TIMEOUT,
  }).toBeGreaterThan(ackBefore[index])));
  const after = await session(request, prior.id);
  expect(after.epoch).toBe(epoch);
  expect(after.document.version).toBe(prior.version + edits.length);
  await matchesRendered(peers, after.document, epoch);
  return after.document;
}

function expectEdits(document: DocPage, original: string, edits: string[]) {
  expect(document.plainText.startsWith(original)).toBe(true);
  expect(document.plainText.split(original)).toHaveLength(2);
  expect((document.plainText.match(/\[team-edit-\d+-\d+\]/g) ?? []).sort()).toEqual([...edits].sort());
}

async function openLatest(peer: Peer) {
  const accept = (dialog: Dialog) => void dialog.accept();
  peer.page.on('dialog', accept);
  try { await peer.page.getByRole('button', { name: '최신 문서 열기', exact: true }).click({ timeout: SYNC_TIMEOUT }); }
  finally { peer.page.off('dialog', accept); }
}

async function verifyGantt(context: BrowserContext, projectId: string, traffic: Awaited<ReturnType<typeof verifyWorkspaceTraffic>>) {
  const page = await context.newPage();
  try {
    const successor = traffic.scheduledSuccessor;
    await page.goto(`/#/${projectId}/gantt?focusIssue=${successor.issueId}&focusDate=startDate`, { waitUntil: 'domcontentloaded' });
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    for (const [id, start, end] of [
      [traffic.issueId, traffic.workingDate, traffic.workingDate],
      [successor.issueId, successor.startDate, successor.endDate],
    ]) {
      const bar = chart.locator(`[data-issue-id="${id}"]`).getByRole('button', { name: / 일정 이동$/ });
      await expect(bar).toHaveAttribute('title', new RegExp(`${start} ~ ${end}`), { timeout: SYNC_TIMEOUT });
    }
    const connector = chart.locator(`[data-dependency-id="${successor.dependencyId}"]`);
    await expect(connector).toHaveAttribute('data-dependency-type', 'FS');
    await expect(connector).not.toHaveAttribute('data-dependency-conflict', 'true');
  } finally {
    await page.close();
  }
}

test('twenty individually signed-in HTTPS browser actors collaborate, reconnect, and recover a stale draft', async ({ browser, baseURL }) => {
  const fixture = loadFixture();
  if (!baseURL || !/^https:\/\/127\.0\.0\.1:\d+$/.test(baseURL) || baseURL !== new URL(process.env.TEAMSPACE_PILOT_TEST_URL!).origin) {
    throw new Error('The isolated HTTPS pilot origin is required.');
  }
  test.setTimeout((fixture.seconds + 240) * 1000);
  const accessCode = await loadAccessCode();
  const request = await apiRequest.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { Origin: baseURL } });
  const location = `/#/${fixture.projectId}/documents/${fixture.documentId}`;
  const peers: Peer[] = [];
  const contexts: BrowserContext[] = [];
  const sessionTokens = new Set<string>();
  try {
    await signInRequests(request, accessCode);
    const initial = await session(request, fixture.documentId);
    expect(initial).toMatchObject({ enabled: true, epoch: fixture.initialEpoch, document: { plainText: fixture.initialText } });
    const originalEpoch = fixture.initialEpoch;
    for (let first = 0; first < TEAM_SIZE; first += OPEN_BATCH_SIZE) {
      const opened = await Promise.allSettled(fixture.actorIds.slice(first, first + OPEN_BATCH_SIZE).map(async (actorId, index) => {
        const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, viewport: { width: 1024, height: 768 } });
        contexts.push(context);
        await context.addInitScript(value => localStorage.setItem('teamspace.actor', value), actorId);
        const page = await context.newPage();
        const peer: Peer = { actorId, ordinal: first + index + 1, context, page, connections: 0, closes: 0,
          errors: [], welcomedEpochs: [], sentUpdates: new Set(), acknowledgments: new Set() };
        observeWire(peer, baseURL, fixture.documentId);
        await page.goto(location, { waitUntil: 'domcontentloaded', timeout: SYNC_TIMEOUT });
        await signInBrowser(peer, baseURL, location, accessCode, sessionTokens);
        await expect(page.getByLabel('작업자 선택', { exact: true })).toHaveValue(actorId, { timeout: SYNC_TIMEOUT });
        await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(fixture.title, { timeout: SYNC_TIMEOUT });
        await expect(state(page)).toHaveText('서버에 동기화됨', { timeout: SYNC_TIMEOUT });
        return peer;
      }));
      for (const outcome of opened) {
        if (outcome.status === 'rejected') throw outcome.reason;
        peers.push(outcome.value);
      }
    }
    expect(sessionTokens.size, 'Distinct HTTPS browser sessions').toBe(TEAM_SIZE);
    await matchesRendered(peers, initial.document, originalEpoch);
    const startedAt = performance.now();
    const keepConnected = () => {
      for (const peer of peers) {
        expect(peer.connections, `player ${peer.ordinal} counted connections`).toBe(1);
        expect(peer.closes, `player ${peer.ordinal} disconnected unexpectedly`).toBe(0);
        expect(peer.errors, `player ${peer.ordinal} protocol errors`).toEqual([]);
      }
    };
    keepConnected();
    console.log(`Team pilot confirmed ${peers.length} signed-in Chromium actors synchronized over WSS.`);
    const rounds = Math.min(10, Math.max(3, Math.ceil(fixture.seconds / 15) + 1));
    const storedEdits: string[] = [];
    let current = initial.document;
    let workspaceTraffic: Awaited<ReturnType<typeof verifyWorkspaceTraffic>> | undefined;

    for (let round = 1; round <= rounds; round++) {
      const nextRoundAt = startedAt + fixture.seconds * 1000 * (round - 1) / (rounds - 1);
      while (performance.now() < nextRoundAt) {
        keepConnected();
        await delay(Math.max(0, Math.min(5_000, nextRoundAt - performance.now())));
      }
      const edits = peers.map(peer => ({ peer, value: marker(round, peer) }));
      if (round === 1) {
        [current, workspaceTraffic] = await Promise.all([
          wave(request, current, originalEpoch, peers, edits),
          verifyWorkspaceTraffic(peers[0].context.request, { projectId: fixture.projectId, issueId: fixture.issueId, actorId: peers[0].actorId, origin: baseURL }),
        ]);
      } else current = await wave(request, current, originalEpoch, peers, edits);
      storedEdits.push(...edits.map(edit => edit.value));
      expectEdits(current, fixture.initialText, storedEdits);
      keepConnected();
      console.log(`Team pilot round ${round}/${rounds} saved, acknowledged, and rendered to all ${peers.length} actors.`);
    }
    const elapsedMs = Math.floor(performance.now() - startedAt);
    expect(elapsedMs).toBeGreaterThanOrEqual(fixture.seconds * 1000);
    if (!workspaceTraffic) throw new Error('The team pilot did not run project traffic.');
    await verifyGantt(peers[0].context, fixture.projectId, workspaceTraffic);
    keepConnected();
    console.log('The protected Gantt rendered both moved dates and the resolved dependency.');

    const delayed = peers.at(-1)!;
    const onlinePeers = peers.slice(0, -1);
    const reconnectMarker = marker(rounds + 1, delayed);
    const onlineEdits = onlinePeers.map(peer => ({ peer, value: marker(rounds + 1, peer) }));
    const reconnectAcks = delayed.acknowledgments.size;
    await delayed.context.setOffline(true);
    await expect(state(delayed.page)).toContainText('연결 끊김');
    await append(delayed, reconnectMarker);
    await expect(state(delayed.page)).toHaveText('연결 끊김 · 편집 보관 중');
    current = await wave(request, current, originalEpoch, onlinePeers, onlineEdits);
    storedEdits.push(...onlineEdits.map(edit => edit.value));
    expectEdits(current, fixture.initialText, storedEdits);
    expect(delayed.acknowledgments.size).toBe(reconnectAcks);
    await delayed.context.setOffline(false);
    await expect.poll(() => delayed.acknowledgments.size, { timeout: SYNC_TIMEOUT }).toBeGreaterThan(reconnectAcks);
    const rejoined = await session(request, fixture.documentId);
    expect(rejoined.epoch).toBe(originalEpoch);
    expect(rejoined.document.version).toBe(current.version + 1);
    current = rejoined.document;
    storedEdits.push(reconnectMarker);
    expectEdits(current, fixture.initialText, storedEdits);
    await matchesRendered(peers, current, originalEpoch);
    console.log('Team pilot merged one cached offline edit exactly once after reconnecting in the same epoch.');

    const headers = { 'X-Actor-Id': peers[0].actorId };
    const checkpointResponse = await request.post(`/api/documents/${fixture.documentId}/checkpoint`, {
      headers, data: { expectedVersion: current.version, summary: '20명 파일럿 복구 지점' },
    });
    expect(checkpointResponse.status()).toBe(200);
    const checkpoint = await checkpointResponse.json() as DocRevision;
    expect(checkpoint.plainText).toBe(current.plainText);
    const replacedMarker = '[team-restore-replaced]';
    const staleMarker = '[team-stale-offline]';
    current = await wave(request, current, originalEpoch, peers, [{ peer: peers[0], value: replacedMarker }]);
    expect(current.plainText).toContain(replacedMarker);
    await delayed.context.setOffline(true);
    await expect(state(delayed.page)).toContainText('연결 끊김');
    await append(delayed, staleMarker);
    await expect(state(delayed.page)).toHaveText('연결 끊김 · 편집 보관 중');
    const restoredResponse = await request.post(`/api/documents/${fixture.documentId}/restore`, {
      headers, data: { expectedVersion: current.version, revisionId: checkpoint.id },
    });
    expect(restoredResponse.status()).toBe(200);
    const restored = await session(request, fixture.documentId);
    const finalEpoch = restored.epoch;
    if (!finalEpoch) throw new Error('Restoring the document must preserve collaboration.');
    expect(finalEpoch).not.toBe(originalEpoch);
    expect(restored.document.version).toBe(current.version + 1);
    expect(restored.document.plainText).toBe(checkpoint.plainText);
    await delayed.context.setOffline(false);
    await Promise.all(peers.map(peer => expect(peer.page.locator('.docs-collaboration-recovery')).toBeVisible({ timeout: SYNC_TIMEOUT })));
    await expect(editor(delayed.page)).toHaveAttribute('contenteditable', 'false');
    await expect(editor(delayed.page)).toContainText(staleMarker);
    const copyResponse = delayed.page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/documents');
    await delayed.page.getByRole('button', { name: '사본으로 보관', exact: true }).click();
    const savedCopy = await copyResponse;
    expect(savedCopy.status()).toBe(201);
    const copied = await savedCopy.json() as DocPage;
    expect(copied.id).not.toBe(fixture.documentId);
    expect(copied.plainText).toBe(`${current.plainText} ${staleMarker}`);
    await expect(delayed.page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(copied.title, { timeout: SYNC_TIMEOUT });
    for (let first = 0; first < onlinePeers.length; first += OPEN_BATCH_SIZE) {
      await Promise.all(onlinePeers.slice(first, first + OPEN_BATCH_SIZE).map(openLatest));
    }
    await delayed.page.goto(location, { waitUntil: 'domcontentloaded' });
    await matchesRendered(peers, restored.document, finalEpoch);

    const finalEdits = peers.map(peer => ({ peer, value: marker(rounds + 2, peer) }));
    const final = await wave(request, restored.document, finalEpoch, peers, finalEdits);
    storedEdits.push(...finalEdits.map(edit => edit.value));
    expectEdits(final, fixture.initialText, storedEdits);
    expect(final.plainText).not.toContain(staleMarker);
    expect(final.plainText).not.toContain(replacedMarker);
    expect(peers.flatMap(peer => peer.errors)).toEqual([]);
    await writeFile(fixture.evidencePath, JSON.stringify({
      documentId: fixture.documentId, originalEpoch, finalEpoch, documentVersion: final.version,
      plainText: final.plainText, staleMarker, recoveryDocumentId: copied.id, recoveryText: copied.plainText,
      rounds, peerCount: peers.length, elapsedMs, editCount: storedEdits.length, workspaceTraffic,
      authentication: { transport: 'https', browserSessions: sessionTokens.size },
    }), { flag: 'wx', mode: 0o600 });
    console.log('Team pilot restored its checkpoint, saved the stale edit as a separate copy, and synchronized twenty fresh edits.');
  } finally {
    await Promise.allSettled([request.dispose(), ...contexts.map(context => context.close())]);
  }
});
