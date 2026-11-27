import { access, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, request as apiRequest, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import type { Editor } from '@tiptap/core';
import type { CollaborationClientMessage, CollaborationServerMessage, CollaborationSession } from '../../shared/collaboration';
import { documentPlainText } from '../../shared/document-plain-text';
import type { DocPage, DocRevision, Issue, TeamNotificationPage } from '../../shared/types';
import { prepareGitlabTraffic } from './gitlab-traffic';
import { verifyIssueHandoff } from './issue-handoff';
import { verifyWorkspaceTraffic, type ScheduledSuccessorPlan } from './workspace-traffic';
import { verifyNativeKnowledge } from './native-knowledge';
import { verifyNativeCycle } from './native-cycle';

type Fixture = {
  actorIds: string[];
  projectId: string;
  issueId: string;
  issueKey: string;
  gitlabIssueId: string;
  documentId: string;
  title: string;
  initialText: string;
  editingParagraph: string;
  initialEpoch: string;
  seconds: number;
  evidencePath: string;
} & (
  { source: 'native'; intakeId: string; liveRestart: { requestPath: string; readyPath: string } } |
  { source: 'migrated'; originalJiraKey: string; gitlabOriginalJiraKey: string; gitlabJiraInstanceKey: string }
);

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
const SESSION_COOKIE = '__Host-donefac-pilot';
const state = (page: Page) => page.locator('.docs-collaboration-state');
const editor = (page: Page) => page.locator('.docs-live-prose');
const presence = (page: Page) => page.locator('.docs-collaboration-presence');
const marker = (round: number, peer: Peer) => `[team-edit-${round}-${peer.ordinal}]`;
const issueReference = (page: Page, issueId: string) => editor(page)
  .locator(`[data-donefac-node="issueReference"][data-reference-id="${issueId}"]`)
  .getByRole('button', { name: /^참조 업무 열기 / });

function loadFixture(): Fixture {
  const raw = process.env.DONEFAC_PILOT_TEAM_FIXTURE;
  if (!raw) throw new Error('Use a team pilot command to create an isolated HTTPS fixture.');
  const fixture = JSON.parse(raw) as Fixture;
  if (!Array.isArray(fixture.actorIds) || fixture.actorIds.length !== TEAM_SIZE || new Set(fixture.actorIds).size !== TEAM_SIZE ||
    fixture.actorIds.some(id => typeof id !== 'string' || !id) || !Number.isSafeInteger(fixture.seconds) || fixture.seconds < 1 ||
    !fixture.projectId || !fixture.issueId || !fixture.issueKey || !fixture.gitlabIssueId ||
    !(fixture.source === 'native' ? fixture.intakeId && fixture.liveRestart &&
      isAbsolute(fixture.liveRestart.requestPath) && isAbsolute(fixture.liveRestart.readyPath) : fixture.source === 'migrated' &&
      fixture.originalJiraKey && fixture.gitlabOriginalJiraKey && fixture.gitlabJiraInstanceKey) ||
    !fixture.documentId || !fixture.initialEpoch || !fixture.title || !fixture.initialText || !fixture.editingParagraph || !fixture.evidencePath) {
    throw new Error('The isolated team pilot fixture is invalid.');
  }
  return fixture;
}

async function loadAccessCode() {
  const filename = process.env.DONEFAC_PILOT_TEST_ACCESS_FILE;
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

async function signInBrowser(peer: Pick<Peer, 'page' | 'context' | 'ordinal'>, baseURL: string, location: string, accessCode: string, sessionTokens: Set<string>) {
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
    if (doc.lastChild?.type.name !== 'paragraph') throw new Error('The pilot document must end with the editing paragraph.');
    tiptap.view.dispatch(tr.insertText(` ${text}`, doc.content.size - 1));
  }, value, { timeout: SYNC_TIMEOUT });
}

async function matchesRendered(peers: Peer[], current: DocPage, epoch: string, fixture: Fixture) {
  const paragraph = current.content.content?.at(-1);
  if (paragraph?.type !== 'paragraph') throw new Error('The stored document lost its editing paragraph.');
  expect(current.content.content).toContainEqual(expect.objectContaining({
    type: 'issueReference', attrs: expect.objectContaining({ issueId: fixture.issueId }),
  }));
  const paragraphText = documentPlainText(paragraph);
  expect(paragraphText.startsWith(fixture.editingParagraph)).toBe(true);
  await Promise.all(peers.map(async peer => {
    await synchronized(peer, epoch, peers.length);
    const renderedParagraph = editor(peer.page).locator(':scope > p:last-child');
    await expect.poll(() => renderedParagraph.innerText({ timeout: SYNC_TIMEOUT }), {
      message: `player ${peer.ordinal} editing paragraph matches durable content`, timeout: SYNC_TIMEOUT,
    }).toBe(paragraphText);
    await expect(issueReference(peer.page, fixture.issueId), `player ${peer.ordinal} renders the issue reference`)
      .toBeVisible({ timeout: SYNC_TIMEOUT });
  }));
}

async function wave(request: APIRequestContext, prior: DocPage, epoch: string, peers: Peer[], edits: { peer: Peer; value: string }[], fixture: Fixture) {
  const ackBefore = edits.map(({peer}) => peer.acknowledgments.size);
  await Promise.all(edits.map(({peer, value}) => append(peer, value)));
  await Promise.all(edits.map(({peer}, index) => expect.poll(() => peer.acknowledgments.size, {
    message: `player ${peer.ordinal} received a durable acknowledgment`, timeout: SYNC_TIMEOUT,
  }).toBeGreaterThan(ackBefore[index])));
  const after = await session(request, prior.id);
  expect(after.epoch).toBe(epoch);
  expect(after.document.version).toBe(prior.version + edits.length);
  await matchesRendered(peers, after.document, epoch, fixture);
  return after.document;
}

function expectEdits(document: DocPage, original: string, edits: string[]) {
  expect(document.plainText.startsWith(original)).toBe(true);
  expect(document.plainText.split(original)).toHaveLength(2);
  expect((document.plainText.match(/\[team-edit-\d+-\d+\]/g) ?? []).sort()).toEqual([...edits].sort());
}

async function renewBrowserSession(peer: Peer, opener: Page, baseURL: string, accessCode: string, sessionTokens: Set<string>) {
  const expired = await peer.context.request.get(`${baseURL}/api/workspace`);
  expect(expired.status(), 'Old browser cookie after the backend restart').toBe(401);
  const [login] = await Promise.all([
    peer.context.waitForEvent('page'),
    opener.getByRole('link', { name: '팀 접속', exact: true }).click(),
  ]);
  try { await signInBrowser({ ...peer, page: login }, baseURL, '/', accessCode, sessionTokens); }
  finally { await login.close(); }
}

async function verifyLiveRestart({ documentPeer, schedulePeer, fixture, baseURL, accessCode, sessionTokens, before }: {
  documentPeer: Peer; schedulePeer: Peer; fixture: Extract<Fixture, { source: 'native' }>; baseURL: string;
  accessCode: string; sessionTokens: Set<string>; before: CollaborationSession;
}) {
  const startDate = '2031-05-06';
  const draftEnd = '2031-05-08';
  const requests = schedulePeer.context.request;
  const created = await requests.post(`${baseURL}/api/issues`, {
    headers: { Origin: baseURL, 'X-Actor-Id': schedulePeer.actorId },
    data: { projectId: fixture.projectId, title: '재시작 중 일정 입력', startDate, endDate: startDate },
  });
  expect(created.status()).toBe(201);
  const issue = await created.json() as Issue;
  const gantt = await schedulePeer.context.newPage();
  try {
    const chartUrl = `${baseURL}/#/${fixture.projectId}/gantt`;
    await gantt.goto(chartUrl, { waitUntil: 'domcontentloaded' });
    const date = gantt.getByLabel(`${issue.key} 종료일`, { exact: true });
    const save = gantt.getByRole('button', { name: `${issue.key} 날짜 저장`, exact: true });
    await expect(date).toHaveValue(startDate);
    await date.fill(draftEnd);
    await expect(save).toBeEnabled();

    const pending = '[team-restart-pending-edit]';
    const priorAcks = documentPeer.acknowledgments.size;
    await documentPeer.context.setOffline(true);
    await expect(state(documentPeer.page)).toContainText('연결 끊김');
    await append(documentPeer, pending);
    await expect(state(documentPeer.page)).toHaveText('연결 끊김 · 편집 보관 중');
    expect(documentPeer.acknowledgments.size).toBe(priorAcks);
    await writeFile(fixture.liveRestart.requestPath, '', { flag: 'wx', mode: 0o600 });
    await expect.poll(() => access(fixture.liveRestart.readyPath).then(() => true, () => false), { timeout: SYNC_TIMEOUT }).toBe(true);
    await documentPeer.context.setOffline(false);
    await Promise.all([
      renewBrowserSession(documentPeer, documentPeer.page, baseURL, accessCode, sessionTokens),
      renewBrowserSession(schedulePeer, gantt, baseURL, accessCode, sessionTokens),
    ]);

    await expect.poll(() => documentPeer.acknowledgments.size, { timeout: SYNC_TIMEOUT }).toBe(priorAcks + 1);
    const recovered = await session(documentPeer.context.request, fixture.documentId);
    expect(recovered.epoch).toBe(before.epoch);
    expect(recovered.document.version).toBe(before.document.version + 1);
    expect(recovered.document.plainText).toBe(`${before.document.plainText} ${pending}`);
    await expect(editor(documentPeer.page)).toContainText(pending);
    await expect(state(documentPeer.page)).toHaveText('서버에 동기화됨');
    await expect(gantt).toHaveURL(chartUrl);
    await expect(date).toHaveValue(draftEnd);

    const title = '다른 팀원이 저장한 재시작 업무 제목';
    const peerChange = await documentPeer.context.request.patch(`${baseURL}/api/issues/${issue.id}`, {
      headers: { Origin: baseURL, 'X-Actor-Id': documentPeer.actorId }, data: { expectedVersion: issue.version, title },
    });
    expect(peerChange.status()).toBe(200);
    const latest = await peerChange.json() as Issue;
    expect(latest.endDate).toBe(startDate);
    const scheduleResponse = (path: string) => gantt.waitForResponse(response => new URL(response.url()).pathname === `/api/schedule/${path}` &&
      response.request().method() === 'POST');
    const [conflict] = await Promise.all([scheduleResponse('manual-preview'), save.click()]);
    expect(conflict.status(), 'The earlier version must not overwrite a peer change').toBe(409);
    const review = gantt.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    await expect(date).toHaveValue(draftEnd);
    const [preview] = await Promise.all([scheduleResponse('manual-preview'), review.getByRole('button', { name: '다시 미리보기', exact: true }).click()]);
    expect(preview.status()).toBe(200);
    expect(preview.request().postDataJSON()).toMatchObject({ changes: [{ id: issue.id, expectedVersion: latest.version, endDate: draftEnd }] });
    const [applied] = await Promise.all([scheduleResponse('manual-apply'), review.getByRole('button', { name: '변경 적용', exact: true }).click()]);
    expect(applied.status()).toBe(200);
    const { updated } = await applied.json() as { updated: Issue[] };
    expect(updated).toMatchObject([{ id: issue.id, title, startDate, endDate: draftEnd, version: latest.version + 1 }]);
    await expect(review).toHaveCount(0);
    await expect(date).toHaveValue(draftEnd);
    console.log('Open browser tabs re-authenticated after a real backend restart, merged a queued edit once, and guarded a preserved Gantt draft.');
    return { document: recovered.document, evidence: { pending, issue: updated[0] } };
  } finally { await gantt.close(); }
}

async function verifyDocumentIssueReference(page: Page, fixture: Fixture) {
  const originalJiraKey = fixture.source === 'migrated' ? fixture.originalJiraKey : null;
  const currentRoute = () => {
    const [path, query] = new URL(page.url()).hash.split('?');
    return { path, issueId: new URLSearchParams(query).get('issue') };
  };
  const documentPath = `#/${fixture.projectId}/documents/${fixture.documentId}`;
  const reference = issueReference(page, fixture.issueId);
  await expect(reference.getByText(fixture.issueKey, { exact: true })).toBeVisible();
  await reference.click();
  const ticket = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '업무 상세 닫기', exact: true }) });
  const aliases = ticket.getByRole('list', { name: '이전 티켓 번호', exact: true });
  if (originalJiraKey) {
    expect(fixture.issueKey).not.toBe(originalJiraKey);
    await expect(aliases).toHaveText(`Jira 원래 키 ${originalJiraKey}`);
  } else await expect(aliases).toHaveCount(0);
  await expect.poll(currentRoute).toEqual({ path: documentPath, issueId: fixture.issueId });
  await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  await expect.poll(currentRoute).toEqual({ path: documentPath, issueId: null });

  await page.getByRole('button', { name: '통합 검색', exact: true }).click();
  const quickSearch = page.getByRole('dialog', { name: '통합 검색', exact: true });
  await quickSearch.getByRole('textbox', { name: '통합 검색어', exact: true }).fill(originalJiraKey ?? fixture.issueKey);
  const result = quickSearch.locator('button.search-result-issue').filter({
    has: page.getByText(fixture.issueKey, { exact: true }),
  });
  if (originalJiraKey) await expect(result).toContainText(`Jira 원래 키 ${originalJiraKey}`);
  else await expect(result).toHaveCount(1);
  await result.click();
  await expect.poll(currentRoute).toEqual({ path: documentPath, issueId: fixture.issueId });
  await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  await expect.poll(currentRoute).toEqual({ path: documentPath, issueId: null });
  return {
    projectId: fixture.projectId, issueId: fixture.issueId, documentId: fixture.documentId,
    currentIssueKey: fixture.issueKey, ...(originalJiraKey ? { originalJiraKey } : {}),
  };
}

async function verifyNativeIntake(peer: Peer, fixture: Extract<Fixture, { source: 'native' }>) {
  const page = await peer.context.newPage();
  try {
    await page.goto(`/#/${fixture.projectId}/overview`, { waitUntil: 'domcontentloaded', timeout: SYNC_TIMEOUT });
    await page.getByRole('button', { name: '알림', exact: true }).click();
    const inbox = page.getByRole('dialog', { name: '팀 알림', exact: true });
    await inbox.getByRole('button', { name: /접수 업무 등록/ }).click();
    await expect(page).toHaveURL(url => url.hash === `#/${fixture.projectId}/intake?request=${fixture.intakeId}`);
    const review = page.getByRole('dialog', { name: '접수 요청 검토', exact: true });
    await expect(review.getByRole('region', { name: '처리 결과', exact: true })).toContainText(fixture.issueKey);
    await expect.poll(async () => {
      const response = await peer.context.request.get('/api/notifications', { headers: { 'X-Actor-Id': peer.actorId } });
      expect(response.status()).toBe(200);
      const inbox = await response.json() as TeamNotificationPage;
      return inbox.items.find(item => item.targetId === fixture.intakeId)?.readAt;
    }).toEqual(expect.any(String));
  } finally {
    await page.close();
  }
}

async function createGanttSuccessor(peer: Peer, origin: string, lookupKey: string, plan: ScheduledSuccessorPlan): Promise<Issue> {
  const { predecessor, calendarVersion, lagDays, startDate, endDate } = plan;
  const title = `${predecessor.key} 후속 일정`;
  const page = await peer.context.newPage();
  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${predecessor.projectId}/gantt`, { waitUntil: 'domcontentloaded', timeout: SYNC_TIMEOUT });
    await expect(page.getByLabel('작업자 선택', { exact: true })).toHaveValue(peer.actorId, { timeout: SYNC_TIMEOUT });
    const search = page.getByLabel('간트 업무 검색', { exact: true });
    await search.fill(lookupKey, { timeout: SYNC_TIMEOUT });
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const source = chart.locator(`[data-issue-id="${predecessor.id}"]`);
    await expect(source.getByLabel(`${predecessor.key} 종료일`, { exact: true })).toHaveValue(predecessor.endDate!, { timeout: SYNC_TIMEOUT });
    await source.getByRole('checkbox', { name: `${predecessor.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '새 후행 업무 추가', exact: true }).click();

    const form = page.getByRole('dialog', { name: '후행 업무 만들기', exact: true });
    const titleField = form.getByLabel('업무 제목', { exact: true });
    await expect(form).toContainText(predecessor.key);
    await titleField.fill(title);
    await expect(form.getByLabel('연결 유형', { exact: true })).toHaveValue('FS');
    await form.getByLabel('근무일 간격', { exact: true }).fill(String(lagDays));
    const relation = form.getByRole('region', { name: '선행 일정 연결', exact: true });
    await expect(relation).toContainText(`제안 시작일 ${startDate}`);
    await relation.getByRole('button', { name: '제안 날짜 적용', exact: true }).click();
    await expect(titleField).toHaveValue(title);
    await expect(form.getByLabel('시작일', { exact: true })).toHaveValue(startDate);
    await form.getByLabel('종료일', { exact: true }).fill(endDate);

    const path = `/api/issues/${encodeURIComponent(predecessor.id)}/schedule-successors`;
    const [response] = await Promise.all([
      page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === 'POST', { timeout: SYNC_TIMEOUT }),
      form.getByRole('button', { name: '업무 만들고 일정 연결', exact: true }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(201);
    const write = response.request();
    expect(await write.headerValue('origin')).toBe(origin);
    expect(await write.headerValue('x-actor-id')).toBe(peer.actorId);
    expect(write.postDataJSON()).toMatchObject({ expectedPredecessorVersion: predecessor.version, expectedCalendarVersion: calendarVersion,
      type: 'FS', lagDays, issue: { title, startDate, endDate } });
    const successor = await response.json() as Issue;
    const details = page.getByRole('dialog', { name: title, exact: true });
    await expect(details).toBeVisible({ timeout: SYNC_TIMEOUT });
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await search.fill('');
    await expect(chart.getByLabel(`${successor.key} 시작일`, { exact: true })).toHaveValue(startDate, { timeout: SYNC_TIMEOUT });
    await expect(chart.getByLabel(`${successor.key} 종료일`, { exact: true })).toHaveValue(endDate);
    return successor;
  } finally {
    await page.close();
  }
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
  if (!baseURL || !/^https:\/\/127\.0\.0\.1:\d+$/.test(baseURL) || baseURL !== new URL(process.env.DONEFAC_PILOT_TEST_URL!).origin) {
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
        await context.addInitScript(value => localStorage.setItem('donefac.actor', value), actorId);
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
    const initialSessionCount = sessionTokens.size;
    await matchesRendered(peers, initial.document, originalEpoch, fixture);
    const issueReferenceEvidence = await verifyDocumentIssueReference(peers[0].page, fixture);
    let knowledge: Awaited<ReturnType<typeof verifyNativeKnowledge>> | undefined;
    if (fixture.source === 'native') {
      await verifyNativeIntake(peers[1], fixture);
      knowledge = await verifyNativeKnowledge(peers[0].context, peers[1].context, baseURL, {
        projectId: fixture.projectId, issueId: fixture.issueId, issueKey: fixture.issueKey, authorId: peers[0].actorId, reviewerId: peers[1].actorId,
      });
    }
    const lookupKey = fixture.source === 'migrated' ? fixture.originalJiraKey : fixture.issueKey;
    const verifyGitlabTraffic = await prepareGitlabTraffic(peers[1].context, {
      origin: baseURL, projectId: fixture.projectId, actorId: peers[1].actorId,
      issueId: fixture.gitlabIssueId, ...(fixture.source === 'migrated'
        ? { jiraIssueKey: fixture.gitlabOriginalJiraKey, jiraInstanceKey: fixture.gitlabJiraInstanceKey } : {}),
    });
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
    let gitlabTraffic: Awaited<ReturnType<typeof verifyGitlabTraffic>> | undefined;

    for (let round = 1; round <= rounds; round++) {
      const nextRoundAt = startedAt + fixture.seconds * 1000 * (round - 1) / (rounds - 1);
      while (performance.now() < nextRoundAt) {
        keepConnected();
        await delay(Math.max(0, Math.min(5_000, nextRoundAt - performance.now())));
      }
      const edits = peers.map(peer => ({ peer, value: marker(round, peer) }));
      if (round === 1) {
        [current, workspaceTraffic, gitlabTraffic] = await Promise.all([
          wave(request, current, originalEpoch, peers, edits, fixture),
          verifyWorkspaceTraffic(peers[0].context.request, {
            projectId: fixture.projectId, issueId: fixture.issueId, actorId: peers[0].actorId, observerId: peers[1].actorId, origin: baseURL,
            concurrentActor: { requests: peers[2].context.request, actorId: peers[2].actorId },
            handOffIssue: plan => verifyIssueHandoff(peers[0].context, peers[1].context, baseURL, lookupKey, plan),
            createScheduledSuccessor: plan => createGanttSuccessor(peers[0], baseURL, lookupKey, plan),
          }),
          verifyGitlabTraffic(),
        ]);
      } else current = await wave(request, current, originalEpoch, peers, edits, fixture);
      storedEdits.push(...edits.map(edit => edit.value));
      expectEdits(current, fixture.initialText, storedEdits);
      keepConnected();
      console.log(`Team pilot round ${round}/${rounds} saved, acknowledged, and rendered to all ${peers.length} actors.`);
    }
    const elapsedMs = Math.floor(performance.now() - startedAt);
    expect(elapsedMs).toBeGreaterThanOrEqual(fixture.seconds * 1000);
    if (!workspaceTraffic) throw new Error('The team pilot did not run project traffic.');
    if (!gitlabTraffic) throw new Error('The team pilot did not verify signed GitLab activity.');
    await verifyGantt(peers[0].context, fixture.projectId, workspaceTraffic);
    const cycle = fixture.source === 'native' ? await verifyNativeCycle(peers[0].context, peers[1].context, baseURL, {
      projectId: fixture.projectId, ownerId: peers[0].actorId, observerId: peers[1].actorId, workingDate: workspaceTraffic.workingDate,
    }) : undefined;
    keepConnected();
    console.log(`Independent HTTPS sessions handed off a ${fixture.source} issue and verified the board, assignee and change history.`);
    console.log('The protected Gantt saved a successor with reviewed dates and rendered the resolved dependency. Signed GitLab pipeline events applied one workflow transition.');
    if (cycle) console.log('The next cycle retained the carried assignment and dates. A second actor opened its retrospective, exact ticket and Gantt schedule.');

    const delayed = peers.at(-1)!;
    const onlinePeers = peers.slice(0, -1);
    const reconnectMarker = marker(rounds + 1, delayed);
    const onlineEdits = onlinePeers.map(peer => ({ peer, value: marker(rounds + 1, peer) }));
    const reconnectAcks = delayed.acknowledgments.size;
    await delayed.context.setOffline(true);
    await expect(state(delayed.page)).toContainText('연결 끊김');
    await append(delayed, reconnectMarker);
    await expect(state(delayed.page)).toHaveText('연결 끊김 · 편집 보관 중');
    current = await wave(request, current, originalEpoch, onlinePeers, onlineEdits, fixture);
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
    await matchesRendered(peers, current, originalEpoch, fixture);
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
    current = await wave(request, current, originalEpoch, peers, [{ peer: peers[0], value: replacedMarker }], fixture);
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
    await matchesRendered(onlinePeers, restored.document, finalEpoch, fixture);
    await Promise.all(onlinePeers.map(peer => expect(peer.page.locator('.docs-collaboration-recovery')).toHaveCount(0)));
    await expect(delayed.page.locator('.docs-collaboration-recovery')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(editor(delayed.page)).toHaveAttribute('contenteditable', 'false');
    await expect(editor(delayed.page)).toContainText(staleMarker);
    const copyResponse = delayed.page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/documents/${fixture.documentId}/recovery-copy`);
    await delayed.page.getByRole('button', { name: '사본으로 보관', exact: true }).click();
    const savedCopy = await copyResponse;
    expect(savedCopy.status()).toBe(201);
    const copied = await savedCopy.json() as DocPage;
    expect(copied.id).not.toBe(fixture.documentId);
    expect(copied.plainText).toBe(`${current.plainText} ${staleMarker}`);
    await expect(delayed.page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(copied.title, { timeout: SYNC_TIMEOUT });
    await delayed.page.goto(location, { waitUntil: 'domcontentloaded' });
    await matchesRendered(peers, restored.document, finalEpoch, fixture);

    const finalEdits = peers.map(peer => ({ peer, value: marker(rounds + 2, peer) }));
    const final = await wave(request, restored.document, finalEpoch, peers, finalEdits, fixture);
    storedEdits.push(...finalEdits.map(edit => edit.value));
    expectEdits(final, fixture.initialText, storedEdits);
    expect(final.plainText).not.toContain(staleMarker);
    expect(final.plainText).not.toContain(replacedMarker);
    expect(peers.flatMap(peer => peer.errors)).toEqual([]);
    console.log('Team pilot restored its checkpoint, saved the stale edit as a separate copy, and synchronized twenty fresh edits.');
    const restart = fixture.source === 'native' ? await verifyLiveRestart({
      documentPeer: delayed, schedulePeer: peers[0], fixture, baseURL, accessCode, sessionTokens,
      before: { ...restored, document: final },
    }) : undefined;
    const saved = restart?.document ?? final;
    await writeFile(fixture.evidencePath, JSON.stringify({
      documentId: fixture.documentId, originalEpoch, finalEpoch, documentVersion: saved.version,
      plainText: saved.plainText, staleMarker, recoveryDocumentId: copied.id, recoveryText: copied.plainText,
      rounds, peerCount: peers.length, elapsedMs, editCount: storedEdits.length, issueReference: issueReferenceEvidence, knowledge, cycle, workspaceTraffic, gitlabTraffic,
      authentication: { transport: 'https', browserSessions: initialSessionCount }, liveRestart: restart?.evidence,
    }), { flag: 'wx', mode: 0o600 });
  } finally {
    await Promise.allSettled([request.dispose(), ...contexts.map(context => context.close())]);
  }
});
