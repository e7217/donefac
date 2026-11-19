import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type APIRequestContext, type BrowserContext, type Dialog, type Page } from '@playwright/test';
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

function observeWire(peer: Peer, baseURL: string, documentId: string) {
  const expectedOrigin = new URL(baseURL);
  expectedOrigin.protocol = 'ws:';
  peer.page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (url.origin !== expectedOrigin.origin || url.pathname !== '/api/collaboration' ||
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

test('twenty real browser actors keep collaborating, reconnect, and recover a stale draft into a separate copy', async ({ browser, baseURL, request }) => {
  const fixture = loadFixture();
  if (!baseURL || baseURL !== new URL(process.env.TEAMSPACE_PILOT_TEST_URL!).origin) throw new Error('The isolated pilot origin is required.');
  test.setTimeout((fixture.seconds + 240) * 1000);
  const location = `/#/${fixture.projectId}/documents/${fixture.documentId}`;
  const peers: Peer[] = [];
  const contexts: BrowserContext[] = [];
  try {
    const initial = await session(request, fixture.documentId);
    expect(initial).toMatchObject({ enabled: true, epoch: fixture.initialEpoch, document: { plainText: fixture.initialText } });
    const originalEpoch = fixture.initialEpoch;
    for (let first = 0; first < TEAM_SIZE; first += OPEN_BATCH_SIZE) {
      const opened = await Promise.allSettled(fixture.actorIds.slice(first, first + OPEN_BATCH_SIZE).map(async (actorId, index) => {
        const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 } });
        contexts.push(context);
        await context.addInitScript(value => localStorage.setItem('teamspace.actor', value), actorId);
        const page = await context.newPage();
        const peer: Peer = { actorId, ordinal: first + index + 1, context, page, connections: 0, closes: 0,
          errors: [], welcomedEpochs: [], sentUpdates: new Set(), acknowledgments: new Set() };
        observeWire(peer, baseURL, fixture.documentId);
        await page.goto(location, { waitUntil: 'domcontentloaded', timeout: SYNC_TIMEOUT });
        await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(fixture.title, { timeout: SYNC_TIMEOUT });
        await expect(state(page)).toHaveText('서버에 동기화됨', { timeout: SYNC_TIMEOUT });
        return peer;
      }));
      for (const outcome of opened) {
        if (outcome.status === 'rejected') throw outcome.reason;
        peers.push(outcome.value);
      }
    }
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
    console.log(`Team pilot confirmed ${peers.length} synchronized Chromium actors.`);
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
          verifyWorkspaceTraffic(request, { projectId: fixture.projectId, issueId: fixture.issueId, actorId: peers[0].actorId }),
        ]);
      } else current = await wave(request, current, originalEpoch, peers, edits);
      storedEdits.push(...edits.map(edit => edit.value));
      expectEdits(current, fixture.initialText, storedEdits);
      keepConnected();
      console.log(`Team pilot round ${round}/${rounds} saved, acknowledged, and rendered to all ${peers.length} actors.`);
    }
    const elapsedMs = Math.floor(performance.now() - startedAt);
    expect(elapsedMs).toBeGreaterThanOrEqual(fixture.seconds * 1000);

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
    }), { flag: 'wx', mode: 0o600 });
    console.log('Team pilot restored its checkpoint, saved the stale edit as a separate copy, and synchronized twenty fresh edits.');
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});
