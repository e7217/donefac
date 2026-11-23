import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import {
  COLLABORATION_CURSOR_PROTOCOL,
  COLLABORATION_SCHEMA,
  supportsCollaborationSchema,
  type CollaborationCursorSelection,
  type CollaborationPeer,
  type CollaborationSchemaVersion,
  type CollaborationServerMessage,
  type CollaborationSession,
} from '../../shared/collaboration';
import {
  DOCUMENT_TOC_DEFAULTS, documentNodeSchemaVersion, isDocumentTocLayout, isDocumentTocLevel, isIssueSummaryGroupBy, MAX_DOCUMENT_ISSUE_BLOCKS,
} from '../../shared/document-nodes';
import { isDocumentSectionId } from '../../shared/document-sections';
import { createEditorSchema } from '../../shared/editor-schema';
import type { DocPage } from '../../shared/types';
import { newRequestId } from './request-id';

export type CollaborationPhase = 'connecting' | 'connected' | 'offline' | 'recovery' | 'error';
export interface CollaborationView {
  phase: CollaborationPhase; ready: boolean; pending: boolean; peers: CollaborationPeer[];
  epoch: string; document: DocPage; error: string; storageError: boolean; otherRecoveries: number;
}
export interface RemoteCollaborationCursor {
  peer: CollaborationPeer;
  selection: CollaborationCursorSelection;
}
interface PendingCache { epoch: string; schemaVersion: number; update: string; pending: true; updatedAt: string }
interface PendingSnapshot { key: string; value: string }
interface PendingEntry { snapshot: PendingSnapshot; cache: PendingCache | null; update?: Uint8Array }
const REMOTE = Symbol('server-update');
const CACHE = Symbol('pending-cache');
const MAX_CACHE_STATE = 16 * 1024 * 1024;
const MAX_CACHE_DOCUMENT = 8 * 1024 * 1024;
const CURSOR_INTERVAL = 80;
const CURSOR_HEARTBEAT = 10_000;
const sameSelection = (a: CollaborationCursorSelection | null, b: CollaborationCursorSelection | null) =>
  a === b || (a !== null && b !== null && a.anchor === b.anchor && a.head === b.head);
/** A known old cache is rendered only after validation in a disposable document.
 * Its original bytes remain untouched until an explicit discard or saved copy. */
function validateLegacyPending(update: string, schemaVersion: Exclude<CollaborationSchemaVersion, typeof COLLABORATION_SCHEMA>): Uint8Array {
  if (typeof update !== 'string' || !update.length || update.length > Math.ceil(MAX_CACHE_STATE / 3) * 4) throw new Error('편집 보관 데이터 크기가 올바르지 않습니다.');
  const bytes = decodeBytes(update);
  if (bytes.length > MAX_CACHE_STATE || encodeBytes(bytes) !== update) throw new Error('편집 보관 데이터 형식이 올바르지 않습니다.');
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, bytes);
    for (const name of candidate.share.keys()) if (name !== 'default') throw new Error('지원하지 않는 공동 편집 루트입니다.');
    const root = candidate.getXmlFragment('default');
    if ((root as unknown as { _map: Map<unknown, unknown> })._map.size) throw new Error('지원하지 않는 공동 편집 루트 속성입니다.');
    const content: unknown = yDocToProsemirrorJSON(candidate, 'default');
    if (new TextEncoder().encode(JSON.stringify(content)).length > MAX_CACHE_DOCUMENT) throw new Error('보관한 문서가 너무 큽니다.');
    const schema = createEditorSchema();
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('문서 구조가 올바르지 않습니다.');
      return value as Record<string, unknown>;
    };
    const attributes = (value: unknown, spec: Record<string, unknown> | undefined) => {
      if (value === undefined) return {};
      const result = object(value);
      if (Object.keys(result).some(key => !Object.hasOwn(spec || {}, key))) throw new Error('지원하지 않는 문서 속성입니다.');
      return result;
    };
    const referenceId = (id: unknown): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);
    const referenceLabel = (label: unknown) => label === undefined || typeof label === 'string' && label.length <= 300;
    let count = 0, issueBlockCount = 0;
    const sectionIds = new Set<string>();
    const check = (value: unknown, depth: number) => {
      if (++count > 30000 || depth > 60) throw new Error('문서 중첩 한도를 초과했습니다.');
      const node = object(value);
      if (typeof node.type !== 'string' || !schema.nodes[node.type]) throw new Error('이전 문서 형식에 없는 블록입니다.');
      const attrs = attributes(node.attrs, schema.nodes[node.type].spec.attrs);
      if (documentNodeSchemaVersion(node.type, attrs) > schemaVersion) throw new Error('이전 문서 형식에 없는 블록입니다.');
      if (node.type === 'issueReference' || node.type === 'documentReference' || node.type === 'documentInclude') {
        const id = attrs[node.type === 'issueReference' ? 'issueId' : 'documentId'];
        if (!referenceId(id) || !referenceLabel(attrs.label)) {
          throw new Error('보관한 참조 블록의 대상 또는 이름이 올바르지 않습니다.');
        }
      }
      if (node.type === 'issueList' || node.type === 'issueSummary') {
        if (++issueBlockCount > MAX_DOCUMENT_ISSUE_BLOCKS || !referenceId(attrs.projectId)
          || (attrs.savedViewId != null && !referenceId(attrs.savedViewId)) || !referenceLabel(attrs.label)
          || (node.type === 'issueSummary' && attrs.groupBy !== undefined && !isIssueSummaryGroupBy(attrs.groupBy))) {
          throw new Error('보관한 업무 목록 또는 업무 현황의 대상·이름·집계 기준이 올바르지 않습니다.');
        }
      }
      if (node.type === 'documentToc') {
        const { minLevel = DOCUMENT_TOC_DEFAULTS.minLevel, maxLevel = DOCUMENT_TOC_DEFAULTS.maxLevel, layout = DOCUMENT_TOC_DEFAULTS.layout } = attrs;
        if (!isDocumentTocLevel(minLevel) || !isDocumentTocLevel(maxLevel) || minLevel > maxLevel || !isDocumentTocLayout(layout)) {
          throw new Error('보관한 본문 목차의 제목 단계나 표시 방식이 올바르지 않습니다.');
        }
      }
      if (node.marks !== undefined && !Array.isArray(node.marks)) throw new Error('문서 서식이 올바르지 않습니다.');
      for (const value of Array.isArray(node.marks) ? node.marks : []) {
        const mark = object(value);
        if (typeof mark.type !== 'string' || !schema.marks[mark.type]) throw new Error('지원하지 않는 문서 서식입니다.');
        const attrs = attributes(mark.attrs, schema.marks[mark.type].spec.attrs);
        if (mark.type === 'link' && typeof attrs.href === 'string' && /^(?:javascript|vbscript|data):/i.test(attrs.href.trim())) throw new Error('지원하지 않는 링크 형식입니다.');
      }
      if (node.type === 'image' && typeof attrs.src === 'string' && !/^(?:https?:\/\/|\/)/i.test(attrs.src)) throw new Error('지원하지 않는 이미지 형식입니다.');
      if (node.type === 'heading') {
        if (typeof attrs.level !== 'number' || ![1, 2, 3].includes(attrs.level)) throw new Error('지원하지 않는 제목 단계입니다.');
        if (attrs.sectionId !== undefined) {
          if (!isDocumentSectionId(attrs.sectionId) || sectionIds.has(attrs.sectionId)) throw new Error('보관한 문서의 절 ID가 올바르지 않습니다.');
          sectionIds.add(attrs.sectionId);
        }
      }
      if (node.content !== undefined) {
        if (!Array.isArray(node.content)) throw new Error('문서 블록 목록이 올바르지 않습니다.');
        for (const child of node.content) check(child, depth + 1);
      }
    };
    check(content, 0);
    const document = schema.nodeFromJSON(content);
    if (document.type !== schema.topNodeType) throw new Error('문서 루트가 올바르지 않습니다.');
    document.check();
    return bytes;
  } finally { candidate.destroy(); }
}
const prefix = (actorId: string, documentId: string) => `teamspace:collaboration-pending:${actorId}:${documentId}:`;
function pendingSnapshotKeys(actorId: string, documentId: string): string[] {
  const own = prefix(actorId, documentId);
  const keys = new Set<string>();
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(own)) keys.add(key);
  }
  return [...keys];
}

function pendingSnapshots(actorId: string, documentId: string): PendingSnapshot[] {
  return pendingSnapshotKeys(actorId, documentId).flatMap(key => {
    const value = localStorage.getItem(key);
    return value === null ? [] : [{ key, value }];
  });
}

export function hasPendingCollaboration(actorId: string, documentId: string): boolean {
  return pendingSnapshotKeys(actorId, documentId).length > 0;
}

export function encodeBytes(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(result);
}
export function decodeBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function readPendingEntry(snapshot: PendingSnapshot): PendingEntry {
  try {
    const cache = JSON.parse(snapshot.value) as PendingCache;
    if (!cache || cache.pending !== true || typeof cache.epoch !== 'string' || !cache.epoch || cache.epoch.length > 200 ||
        !Number.isSafeInteger(cache.schemaVersion) || typeof cache.updatedAt !== 'string' ||
        typeof cache.update !== 'string' || !cache.update || cache.update.length > MAX_CACHE_STATE) return { snapshot, cache: null };
    if (cache.schemaVersion !== COLLABORATION_SCHEMA) return { snapshot, cache };
    const update = decodeBytes(cache.update);
    // A damaged entry must stay separately recoverable alongside usable same-epoch snapshots.
    Y.decodeUpdate(update);
    return { snapshot, cache, update };
  } catch { return { snapshot, cache: null }; }
}

function removeObservedSnapshot(snapshot: PendingSnapshot) {
  // Current keys are immutable. Also preserve any changed value from an older browser's shared key.
  if (localStorage.getItem(snapshot.key) === snapshot.value) localStorage.removeItem(snapshot.key);
}

/** One actor/document/epoch session. Browser caches contain unacknowledged work,
 * never the canonical document. A server ACK is the only successful save signal. */
export class CollaborationClient {
  readonly doc = new Y.Doc();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorPeerId: string | null = null;
  private localCursor: CollaborationCursorSelection | null = null;
  private sentCursor: CollaborationCursorSelection | null = null;
  private lastCursorSentAt = -Infinity;
  private remoteCursors = new Map<string, CollaborationCursorSelection>();
  private remoteCursorSnapshot: readonly RemoteCollaborationCursor[] = [];
  private cursorListeners = new Set<() => void>();
  private cursorNotificationQueued = false;
  private disposed = false;
  private welcomed = false;
  private retryCount = 0;
  private localSequence = 0;
  private acknowledgedSequence = 0;
  private requestSequence = 0;
  private unreadableCache = false;
  private legacyRecovery = false;
  private restoredSnapshots: PendingSnapshot[] = [];
  private ownSnapshot: PendingSnapshot | null = null;
  private readonly snapshotWriter = newRequestId();
  private snapshotSequence = 0;
  private snapshotNeedsWrite = false;
  private inFlight = new Map<string, number>();
  private serverVector: Uint8Array = new Uint8Array();
  private state: CollaborationView;
  private readonly actorId: string;
  private readonly documentId: string;
  private readonly publish: (state: CollaborationView) => void;
  private readonly onDocument: (document: DocPage) => void;

  constructor(session: CollaborationSession, actorId: string, publish: (state: CollaborationView) => void, onDocument: (document: DocPage) => void) {
    this.actorId = actorId; this.documentId = session.document.id;
    this.publish = publish; this.onDocument = onDocument;
    this.state = { phase: 'connecting', ready: false, pending: false, peers: [], epoch: session.epoch || '', document: session.document, error: '', storageError: false, otherRecoveries: 0 };
    this.loadPending(session.enabled);
    if (!session.enabled && this.state.phase !== 'recovery' && this.state.phase !== 'error') throw new Error('공동 편집 세션이 활성화되지 않았습니다.');
    this.doc.on('update', this.onUpdate);
  }

  private setState(changes: Partial<CollaborationView>) {
    this.state = { ...this.state, ...changes, pending: this.localSequence > this.acknowledgedSequence };
    this.publish(this.state);
  }
  get view() { return this.state; }
  getRemoteCursors(): readonly RemoteCollaborationCursor[] { return this.remoteCursorSnapshot; }
  subscribeCursors(listener: () => void): () => void {
    this.cursorListeners.add(listener);
    return () => { this.cursorListeners.delete(listener); };
  }
  setCursor(selection: CollaborationCursorSelection | null) {
    if (this.disposed || this.state.phase === 'recovery' || this.state.phase === 'error' || sameSelection(selection, this.localCursor)) return;
    this.localCursor = selection;
    this.flushCursor();
  }
  start() {
    this.publish(this.state);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    if (this.state.phase !== 'recovery') this.connect();
  }

  private loadPending(enabled: boolean) {
    try {
      const entries = pendingSnapshots(this.actorId, this.documentId).map(readPendingEntry)
        .sort((a, b) => (b.cache?.updatedAt ?? '').localeCompare(a.cache?.updatedAt ?? ''));
      const isCurrent = (entry: PendingEntry) => enabled && entry.update && entry.cache?.epoch === this.state.epoch;
      const current = entries.filter(isCurrent);
      const archived = entries.filter(entry => !isCurrent(entry));
      const first = archived[0] ?? current[0];
      if (!first) return;

      const group = !archived.length ? current : first.update
        ? archived.filter(entry => entry.update && entry.cache?.epoch === first.cache?.epoch) : [first];
      this.restoredSnapshots = group.map(entry => entry.snapshot);
      const displayed = new Set(group);
      const otherGroups = new Set(entries.filter(entry => !displayed.has(entry))
        .map(entry => entry.update ? `epoch:${entry.cache?.epoch}` : entry.snapshot.key));
      this.state.otherRecoveries = otherGroups.size;

      const candidate = first.cache;
      if (!candidate) throw new Error('이전 편집 보관 정보가 올바르지 않습니다.');
      if (supportsCollaborationSchema(candidate.schemaVersion) && candidate.schemaVersion !== COLLABORATION_SCHEMA) {
        Y.applyUpdate(this.doc, validateLegacyPending(candidate.update, candidate.schemaVersion), CACHE);
        this.legacyRecovery = true;
        this.localSequence = 1;
        this.state = { ...this.state, epoch: candidate.epoch, phase: 'recovery', ready: true, pending: true, error: '이전 문서 형식의 편집을 읽기 전용으로 복구했습니다. 원본 문서에 자동으로 합치지 않으니 사본으로 보관해주세요.' };
        return;
      }
      if (!first.update) {
        this.unreadableCache = true;
        this.state = { ...this.state, phase: 'error', error: '이전에 보관한 편집의 문서 형식이 다릅니다. 원본 데이터를 내려받아 복구해주세요.' };
        return;
      }
      const updates = group.flatMap(entry => entry.update ? [entry.update] : []);
      Y.applyUpdate(this.doc, updates.length === 1 ? first.update : Y.mergeUpdates(updates), CACHE);
      this.localSequence = 1;
      this.state.pending = true;
      if (!enabled || candidate.epoch !== this.state.epoch) {
        this.state = { ...this.state, epoch: candidate.epoch, phase: 'recovery', ready: true, error: '문서가 복구되거나 교체되어 이전 편집을 자동으로 합치지 않았습니다.' };
      }
    } catch { this.unreadableCache = true; this.state = { ...this.state, phase: 'error', error: '브라우저에 보관한 편집을 읽지 못했습니다. 원본 데이터를 보존한 채 문서를 다시 확인해주세요.' }; }
  }

  private persistPending() {
    if (this.unreadableCache || this.legacyRecovery) return;
    try {
      if (this.localSequence > this.acknowledgedSequence) {
        if (!this.snapshotNeedsWrite) return;
        const cached: PendingCache = { epoch: this.state.epoch, schemaVersion: COLLABORATION_SCHEMA, update: encodeBytes(Y.encodeStateAsUpdate(this.doc)), pending: true, updatedAt: new Date().toISOString() };
        const key = `${prefix(this.actorId, this.documentId)}${cached.epoch}:${cached.schemaVersion}:${this.snapshotWriter}:${++this.snapshotSequence}`;
        const snapshot = { key, value: JSON.stringify(cached) };
        const previous = this.ownSnapshot;
        // Publish a new immutable key before retiring the previous one. Other tabs can only consume observed keys.
        localStorage.setItem(key, snapshot.value);
        this.ownSnapshot = snapshot;
        this.snapshotNeedsWrite = false;
        if (previous) removeObservedSnapshot(previous);
      } else this.clearStoredSnapshots();
      this.state.storageError = false;
    } catch { this.state.storageError = true; }
  }

  private onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (this.disposed || this.legacyRecovery || origin === CACHE) return;
    if (origin !== REMOTE) {
      this.localSequence++;
      this.snapshotNeedsWrite = true;
      this.persistPending();
      this.setState({});
      this.sendPending();
    } else if (this.localSequence > this.acknowledgedSequence) {
      this.snapshotNeedsWrite = true;
      this.persistPending();
    }
  };

  private sendPending() {
    if (!this.welcomed || this.socket?.readyState !== WebSocket.OPEN || this.state.phase !== 'connected') return;
    if (this.localSequence <= this.acknowledgedSequence) return;
    // Each message contains every local change since the last durable ACK, so a
    // later ACK cannot claim a missing earlier incremental update is persisted.
    const update = Y.encodeStateAsUpdate(this.doc, this.serverVector.length ? this.serverVector : undefined);
    const requestId = `${this.doc.clientID}-${++this.requestSequence}-${Date.now()}`;
    this.inFlight.set(requestId, this.localSequence);
    this.socket.send(JSON.stringify({ type: 'update', epoch: this.state.epoch, requestId, update: encodeBytes(update) }));
  }

  private clearCursorTimer() {
    if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
  }

  private flushCursor = () => {
    this.clearCursorTimer();
    const socket = this.socket;
    if (!this.cursorPeerId || this.state.phase !== 'connected' || socket?.readyState !== WebSocket.OPEN) return;
    const selection = this.localCursor;
    if (selection) {
      // Peers can resolve only positions anchored to acknowledged document edits.
      if (this.localSequence > this.acknowledgedSequence) return;
      const interval = sameSelection(selection, this.sentCursor) ? CURSOR_HEARTBEAT : CURSOR_INTERVAL;
      const wait = this.lastCursorSentAt + interval - performance.now();
      if (wait > 0) {
        this.cursorTimer = setTimeout(this.flushCursor, Math.ceil(wait));
        return;
      }
    } else if (this.sentCursor === null) return;

    try { socket.send(JSON.stringify({ type: 'cursor', epoch: this.state.epoch, selection })); }
    catch { return; /* Cursor delivery never changes document synchronization. */ }
    this.sentCursor = selection;
    if (selection) {
      this.lastCursorSentAt = performance.now();
      this.cursorTimer = setTimeout(this.flushCursor, CURSOR_HEARTBEAT);
    }
  };

  private publishRemoteCursors() {
    const snapshot = this.state.peers.flatMap(peer => {
      const selection = this.remoteCursors.get(peer.id);
      return selection ? [{ peer, selection }] : [];
    });
    if (snapshot.length === this.remoteCursorSnapshot.length && snapshot.every(({ peer, selection }, index) => {
      const prior = this.remoteCursorSnapshot[index];
      return peer.id === prior.peer.id && peer.actorId === prior.peer.actorId && peer.name === prior.peer.name && peer.color === prior.peer.color && sameSelection(selection, prior.selection);
    })) return;
    this.remoteCursorSnapshot = snapshot;
    if (this.cursorNotificationQueued) return;
    // Keep ProseMirror decoration updates out of document transaction callbacks.
    this.cursorNotificationQueued = true;
    queueMicrotask(() => {
      this.cursorNotificationQueued = false;
      for (const listener of this.cursorListeners) listener();
    });
  }

  private rememberRemoteCursor(peerId: string, selection: CollaborationCursorSelection | null) {
    if (!this.cursorPeerId || peerId === this.cursorPeerId || !this.state.peers.some(peer => peer.id === peerId)) return;
    if (selection === null) this.remoteCursors.delete(peerId);
    else if (selection && typeof selection.anchor === 'string' && typeof selection.head === 'string') {
      this.remoteCursors.set(peerId, { anchor: selection.anchor, head: selection.head });
    }
  }

  private clearCursorChannel(keepLocal = false) {
    this.clearCursorTimer();
    this.cursorPeerId = null;
    if (!keepLocal) this.localCursor = null;
    this.sentCursor = null;
    this.lastCursorSentAt = -Infinity;
    this.remoteCursors.clear();
    this.publishRemoteCursors();
  }

  private connect() {
    if (this.disposed || this.state.phase === 'recovery' || this.state.phase === 'error') return;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    if (!navigator.onLine) { this.setState({ phase: 'offline', peers: [] }); return; }
    this.welcomed = false;
    this.clearCursorChannel(true);
    this.setState({ phase: 'connecting', peers: [], error: '' });
    const endpoint = new URL('/api/collaboration', window.location.href);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.search = new URLSearchParams({ documentId: this.documentId, actorId: this.actorId }).toString();
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    socket.onopen = () => {
      if (this.disposed || this.socket !== socket) return;
      socket.send(JSON.stringify({ type: 'hello', epoch: this.state.epoch, schemaVersion: COLLABORATION_SCHEMA, stateVector: encodeBytes(Y.encodeStateVector(this.doc)), cursorProtocol: COLLABORATION_CURSOR_PROTOCOL }));
    };
    socket.onmessage = event => {
      if (this.disposed || this.socket !== socket) return;
      try { this.receive(JSON.parse(String(event.data)) as CollaborationServerMessage); }
      catch { this.fail('공동 편집 응답을 처리하지 못했습니다. 편집을 보존한 채 연결을 중단했습니다.'); }
    };
    socket.onerror = () => { /* onclose schedules reconnection without discarding the Y.Doc. */ };
    socket.onclose = event => {
      if (this.disposed || this.socket !== socket) return;
      this.welcomed = false; this.socket = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.state.phase === 'recovery' || this.state.phase === 'error') return;
      this.clearCursorChannel(event.code !== 4409);
      if (event.code === 4409) { this.setState({ phase: 'recovery', error: '문서 버전이 교체되었습니다. 이전 편집을 보관하거나 최신 문서를 열어주세요.', peers: [] }); return; }
      this.setState({ phase: 'offline', peers: [] });
      void this.reconcileDisconnect();
    };
  }

  private receive(message: CollaborationServerMessage) {
    if (message.type === 'welcome') {
      if (message.schemaVersion !== COLLABORATION_SCHEMA) { this.fail('문서 형식이 달라 편집을 중단했습니다. 새로고침 후 다시 확인해주세요.'); return; }
      if (message.epoch !== this.state.epoch) { this.clearCursorChannel(); this.setState({ phase: 'recovery', error: '문서 버전이 교체되어 이전 편집을 자동으로 합치지 않았습니다.' }); this.socket?.close(); return; }
      Y.applyUpdate(this.doc, decodeBytes(message.update), REMOTE);
      this.serverVector = decodeBytes(message.stateVector);
      this.welcomed = true; this.retryCount = 0; this.inFlight.clear();
      this.acceptDocument(message.document);
      this.setState({ phase: 'connected', ready: true, peers: message.peers, error: '' });
      this.cursorPeerId = message.cursorProtocol === COLLABORATION_CURSOR_PROTOCOL &&
        message.peers.some(peer => peer.id === message.peerId && peer.actorId === this.actorId) ? message.peerId ?? null : null;
      this.remoteCursors.clear();
      if (this.cursorPeerId && Array.isArray(message.cursors)) {
        for (const cursor of message.cursors) if (cursor) this.rememberRemoteCursor(cursor.peerId, cursor.selection);
      }
      this.publishRemoteCursors();
      this.sendPending();
      this.flushCursor();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'ping' })); }, 20_000);
    } else if (message.type === 'update' && message.epoch === this.state.epoch) {
      Y.applyUpdate(this.doc, decodeBytes(message.update), REMOTE);
      this.acceptDocument(message.document);
      this.setState({});
    } else if (message.type === 'ack' && message.epoch === this.state.epoch) {
      const sequence = this.inFlight.get(message.requestId);
      if (sequence !== undefined) { this.acknowledgedSequence = Math.max(this.acknowledgedSequence, sequence); this.inFlight.delete(message.requestId); }
      this.serverVector = decodeBytes(message.stateVector);
      this.acceptDocument(message.document);
      this.persistPending();
      this.setState({});
      this.flushCursor();
    } else if (message.type === 'cursor' && message.epoch === this.state.epoch) {
      this.rememberRemoteCursor(message.peerId, message.selection);
      this.publishRemoteCursors();
    } else if (message.type === 'presence') {
      this.setState({ peers: message.peers });
      const peerIds = new Set(message.peers.map(peer => peer.id));
      for (const id of this.remoteCursors.keys()) if (!peerIds.has(id)) this.remoteCursors.delete(id);
      this.publishRemoteCursors();
    }
    else if (message.type === 'reset') {
      this.persistPending();
      this.clearCursorChannel();
      this.setState({ phase: 'recovery', peers: [], error: message.reason || '이전 버전 복구로 문서가 교체되었습니다.' });
      this.socket?.close();
    } else if (message.type === 'error') this.fail(message.message);
  }

  private acceptDocument(document: DocPage) {
    if (document.version < this.state.document.version) return;
    this.state.document = document;
    this.onDocument(document);
  }
  fail(message: string) {
    this.persistPending();
    this.clearCursorChannel();
    this.setState({ phase: 'error', error: message, peers: [] });
    this.socket?.close();
  }
  private scheduleReconnect() {
    if (this.disposed || this.retry || !navigator.onLine) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, Math.min(10_000, 400 * 2 ** this.retryCount++));
  }
  private async reconcileDisconnect() {
    if (this.disposed || !navigator.onLine) return;
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(this.documentId)}/collaboration`, { headers: { 'X-Actor-Id': this.actorId }, signal: AbortSignal.timeout(5000) });
      if (this.disposed || this.socket || this.state.phase === 'recovery' || this.state.phase === 'error') return;
      if (response.ok) {
        const session = await response.json() as CollaborationSession;
        if (!session.enabled || session.epoch !== this.state.epoch) {
          this.clearCursorChannel();
          this.setState({ phase: 'recovery', ready: this.state.ready || this.doc.getXmlFragment('default').length > 0, error: '문서가 교체되거나 공동 편집이 해제되어 이전 편집을 자동으로 합치지 않았습니다.' });
          return;
        }
      }
    } catch { /* An unavailable HTTP service retains offline edits and reconnects later. */ }
    if (!this.disposed && !this.socket) this.scheduleReconnect();
  }
  private onOnline = () => { if (this.retry) clearTimeout(this.retry); this.retry = null; this.connect(); };
  private onOffline = () => { if (this.state.phase === 'recovery' || this.state.phase === 'error') return; this.clearCursorChannel(true); this.socket?.close(); this.setState({ phase: 'offline', peers: [] }); };

  private clearStoredSnapshots() {
    for (const snapshot of this.restoredSnapshots) removeObservedSnapshot(snapshot);
    this.restoredSnapshots = [];
    if (this.ownSnapshot) removeObservedSnapshot(this.ownSnapshot);
    this.ownSnapshot = null;
  }
  discardDisplayedPending() {
    this.clearStoredSnapshots();
    this.acknowledgedSequence = this.localSequence;
    this.unreadableCache = false;
    this.setState({});
  }
  exportPending() {
    const caches = pendingSnapshots(this.actorId, this.documentId);
    return { format: 'teamspace-collaboration-recovery', schemaVersion: COLLABORATION_SCHEMA, documentId: this.documentId, actorId: this.actorId, epoch: this.state.epoch, update: encodeBytes(Y.encodeStateAsUpdate(this.doc)), pending: this.localSequence > this.acknowledgedSequence, caches };
  }
  destroy() {
    this.persistPending(); this.disposed = true;
    this.cursorListeners.clear();
    this.clearCursorChannel();
    window.removeEventListener('online', this.onOnline); window.removeEventListener('offline', this.onOffline);
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.doc.off('update', this.onUpdate);
    // The editor owns its binding lifecycle. Destroying Y.Doc here while React
    // tears down the ProseMirror view can discard a final transaction.
  }
}
