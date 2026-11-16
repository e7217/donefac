import * as Y from 'yjs';
import { COLLABORATION_SCHEMA, type CollaborationPeer, type CollaborationServerMessage, type CollaborationSession } from '../../shared/collaboration';
import type { DocPage } from '../../shared/types';

export type CollaborationPhase = 'connecting' | 'connected' | 'offline' | 'recovery' | 'error';
export interface CollaborationView {
  phase: CollaborationPhase; ready: boolean; pending: boolean; peers: CollaborationPeer[];
  epoch: string; document: DocPage; error: string; storageError: boolean;
}
interface PendingCache { epoch: string; schemaVersion: number; update: string; pending: true; updatedAt: string }
const REMOTE = Symbol('server-update');
const CACHE = Symbol('pending-cache');
const prefix = (actorId: string, documentId: string) => `teamspace:collaboration-pending:${actorId}:${documentId}:`;
const key = (actorId: string, documentId: string, epoch: string) => `${prefix(actorId, documentId)}${epoch}:${COLLABORATION_SCHEMA}`;
export function hasPendingCollaboration(actorId: string, documentId: string): boolean {
  return Object.keys(localStorage).some(storedKey => storedKey.startsWith(prefix(actorId, documentId)));
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

/** One actor/document/epoch session. Browser caches contain unacknowledged work,
 * never the canonical document. A server ACK is the only successful save signal. */
export class CollaborationClient {
  readonly doc = new Y.Doc();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private welcomed = false;
  private retryCount = 0;
  private localSequence = 0;
  private acknowledgedSequence = 0;
  private requestSequence = 0;
  private unreadableCache = false;
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
    this.state = { phase: 'connecting', ready: false, pending: false, peers: [], epoch: session.epoch || '', document: session.document, error: '', storageError: false };
    this.loadPending();
    if (!session.enabled && this.state.phase !== 'recovery' && this.state.phase !== 'error') throw new Error('공동 편집 세션이 활성화되지 않았습니다.');
    this.doc.on('update', this.onUpdate);
  }

  private setState(changes: Partial<CollaborationView>) {
    this.state = { ...this.state, ...changes, pending: this.localSequence > this.acknowledgedSequence };
    this.publish(this.state);
  }
  get view() { return this.state; }
  start() {
    this.publish(this.state);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    if (this.state.phase !== 'recovery') this.connect();
  }

  private loadPending() {
    try {
      let candidate: PendingCache | null = null;
      for (let index = 0; index < localStorage.length; index++) {
        const storedKey = localStorage.key(index);
        if (!storedKey?.startsWith(prefix(this.actorId, this.documentId))) continue;
        const stored = localStorage.getItem(storedKey);
        if (!stored) continue;
        const parsed = JSON.parse(stored) as PendingCache;
        if (!parsed.pending || !parsed.update || !parsed.epoch) continue;
        if (!candidate || parsed.updatedAt > candidate.updatedAt) candidate = parsed;
      }
      if (!candidate) return;
      if (candidate.schemaVersion !== COLLABORATION_SCHEMA) {
        this.unreadableCache = true;
        this.state = { ...this.state, phase: 'error', error: '이전에 보관한 편집의 문서 형식이 다릅니다. 원본 데이터를 내려받아 복구해주세요.' };
        return;
      }
      Y.applyUpdate(this.doc, decodeBytes(candidate.update), CACHE);
      this.localSequence = 1;
      this.state.pending = true;
      if (candidate.epoch !== this.state.epoch) {
        this.state = { ...this.state, epoch: candidate.epoch, phase: 'recovery', ready: true, error: '문서가 복구되거나 교체되어 이전 편집을 자동으로 합치지 않았습니다.' };
      }
    } catch { this.unreadableCache = true; this.state = { ...this.state, phase: 'error', error: '브라우저에 보관한 편집을 읽지 못했습니다. 원본 데이터를 보존한 채 문서를 다시 확인해주세요.' }; }
  }

  private persistPending() {
    if (this.unreadableCache) return;
    try {
      if (this.localSequence > this.acknowledgedSequence) {
        const cached: PendingCache = { epoch: this.state.epoch, schemaVersion: COLLABORATION_SCHEMA, update: encodeBytes(Y.encodeStateAsUpdate(this.doc)), pending: true, updatedAt: new Date().toISOString() };
        localStorage.setItem(key(this.actorId, this.documentId, this.state.epoch), JSON.stringify(cached));
      } else localStorage.removeItem(key(this.actorId, this.documentId, this.state.epoch));
      this.state.storageError = false;
    } catch { this.state.storageError = true; }
  }

  private onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (this.disposed || origin === CACHE) return;
    if (origin !== REMOTE) {
      this.localSequence++;
      this.persistPending();
      this.setState({});
      this.sendPending();
    } else if (this.localSequence > this.acknowledgedSequence) this.persistPending();
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

  private connect() {
    if (this.disposed || this.state.phase === 'recovery' || this.state.phase === 'error') return;
    if (!navigator.onLine) { this.setState({ phase: 'offline', peers: [] }); return; }
    this.welcomed = false;
    this.setState({ phase: 'connecting', peers: [], error: '' });
    const endpoint = new URL('/api/collaboration', window.location.href);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.search = new URLSearchParams({ documentId: this.documentId, actorId: this.actorId }).toString();
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    socket.onopen = () => {
      if (this.disposed || this.socket !== socket) return;
      socket.send(JSON.stringify({ type: 'hello', epoch: this.state.epoch, schemaVersion: COLLABORATION_SCHEMA, stateVector: encodeBytes(Y.encodeStateVector(this.doc)) }));
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
      if (event.code === 4409) { this.setState({ phase: 'recovery', error: '문서 버전이 교체되었습니다. 이전 편집을 보관하거나 최신 문서를 열어주세요.', peers: [] }); return; }
      this.setState({ phase: 'offline', peers: [] });
      void this.reconcileDisconnect();
    };
  }

  private receive(message: CollaborationServerMessage) {
    if (message.type === 'welcome') {
      if (message.schemaVersion !== COLLABORATION_SCHEMA) { this.fail('문서 형식이 달라 편집을 중단했습니다. 새로고침 후 다시 확인해주세요.'); return; }
      if (message.epoch !== this.state.epoch) { this.setState({ phase: 'recovery', error: '문서 버전이 교체되어 이전 편집을 자동으로 합치지 않았습니다.' }); this.socket?.close(); return; }
      Y.applyUpdate(this.doc, decodeBytes(message.update), REMOTE);
      this.serverVector = decodeBytes(message.stateVector);
      this.welcomed = true; this.retryCount = 0; this.inFlight.clear();
      this.acceptDocument(message.document);
      this.setState({ phase: 'connected', ready: true, peers: message.peers, error: '' });
      this.sendPending();
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
    } else if (message.type === 'presence') this.setState({ peers: message.peers });
    else if (message.type === 'reset') {
      this.persistPending();
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
          this.setState({ phase: 'recovery', ready: this.state.ready || this.doc.getXmlFragment('default').length > 0, error: '문서가 교체되거나 공동 편집이 해제되어 이전 편집을 자동으로 합치지 않았습니다.' });
          return;
        }
      }
    } catch { /* An unavailable HTTP service retains offline edits and reconnects later. */ }
    if (!this.disposed && !this.socket) this.scheduleReconnect();
  }
  private onOnline = () => { if (this.retry) clearTimeout(this.retry); this.retry = null; this.connect(); };
  private onOffline = () => { if (this.state.phase === 'recovery' || this.state.phase === 'error') return; this.socket?.close(); this.setState({ phase: 'offline', peers: [] }); };

  discardOwnPending(allEpochs = false) {
    const ownPrefix = prefix(this.actorId, this.documentId);
    if (allEpochs) {
      for (const storedKey of Object.keys(localStorage)) if (storedKey.startsWith(ownPrefix)) localStorage.removeItem(storedKey);
    } else localStorage.removeItem(key(this.actorId, this.documentId, this.state.epoch));
    this.acknowledgedSequence = this.localSequence;
    this.unreadableCache = false;
    this.setState({});
  }
  exportPending() {
    const caches = Object.keys(localStorage).filter(storedKey => storedKey.startsWith(prefix(this.actorId, this.documentId))).map(storedKey => ({ key: storedKey, value: localStorage.getItem(storedKey) }));
    return { format: 'teamspace-collaboration-recovery', schemaVersion: COLLABORATION_SCHEMA, documentId: this.documentId, actorId: this.actorId, epoch: this.state.epoch, update: encodeBytes(Y.encodeStateAsUpdate(this.doc)), pending: this.localSequence > this.acknowledgedSequence, caches };
  }
  destroy() {
    this.persistPending(); this.disposed = true;
    window.removeEventListener('online', this.onOnline); window.removeEventListener('offline', this.onOffline);
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.doc.off('update', this.onUpdate);
    // The editor owns its binding lifecycle. Destroying Y.Doc here while React
    // tears down the ProseMirror view can discard a final transaction.
  }
}
