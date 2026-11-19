import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Comment, DocPage, Issue, MutationOrigin, OutboundEventType, WebhookDelivery, WebhookEndpoint, WebhookEndpointCreated, WebhookEnvelope } from '../shared/types.js';
import { Store, type StoreChange } from './store.js';

export class OutboundWebhookError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
const fail = (status: number, message: string): never => { throw new OutboundWebhookError(status, message); };
export const OUTBOUND_EVENT_TYPES: OutboundEventType[] = ['issue.created', 'issue.updated', 'issue.deleted', 'document.created', 'document.updated', 'document.deleted', 'comment.created'];
export const WEBHOOK_MAX_ENDPOINTS = 20, WEBHOOK_MAX_ATTEMPTS = 5, WEBHOOK_RETENTION_DAYS = 30;
const GENERATION_SETTING = 'outboundWebhookGeneration', BATCH_SIZE = 4, MAX_DELIVERIES = 50000;
const issueFields = ['projectId', 'title', 'description', 'type', 'status', 'priority', 'assigneeId', 'collaboratorIds', 'parentId', 'labels', 'startDate', 'endDate', 'dueDate', 'estimate', 'plannedEffortMinutes', 'cycle', 'module', 'release', 'cycleId', 'moduleId', 'releaseId', 'customFields', 'completedAt'];
const documentFields = ['projectId', 'parentId', 'title', 'content', 'icon', 'status'];
type Hooks = { actor: (request: Request) => string; activity: (request: Request, type: string, id: string, action: string, detail?: string) => unknown };
export interface OutboundWebhookOptions { autoStart?: boolean; pollIntervalMs?: number; timeoutMs?: number; leaseMs?: number; maxAttempts?: number; now?: () => number; retryBaseMs?: number }
export interface WebhookDeliveryDetail { delivery: WebhookDelivery; envelope: WebhookEnvelope }
type DeliveryRow = { json: string; endpoint_version: number; generation: string; lease_owner: string | null; lease_until: string | null };
type Claim = { delivery: WebhookDelivery; endpoint: WebhookEndpoint; endpointVersion: number; generation: string; body: string; envelope: WebhookEnvelope; secret: string };
type EndpointRow = { json: string; secret: string };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, '웹훅 설정은 JSON 객체여야 합니다.'); return value as Record<string, unknown>; }
function version(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) return fail(400, '양의 정수 expectedVersion이 필요합니다.'); return Number(value); }
function cas(expected: unknown, current: { version: number }) { if (version(expected) !== current.version) fail(409, '다른 변경사항이 있습니다. 최신 목록을 불러와 주세요.'); }
function short(value: unknown, length: number): string | undefined { return typeof value === 'string' ? value.slice(0, length) : undefined; }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function semanticField(record: Record<string, unknown>, field: string): unknown {
  const value = record[field];
  if (field === 'customFields') return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([, entry]) => entry !== null && entry !== undefined && entry !== '' && (!Array.isArray(entry) || entry.length)).map(([key, entry]) => [key, Array.isArray(entry) ? [...entry].sort() : entry]));
  if (['labels', 'collaboratorIds'].includes(field)) return Array.isArray(value) ? [...value].sort() : [];
  return value ?? null;
}
function changed(before: unknown, after: unknown, fields: string[]) {
  const a = before as Record<string, unknown> | null, b = after as Record<string, unknown> | null;
  if (!a || !b) return fields.filter(field => semanticField((b || a)!, field) !== null && stable(semanticField((b || a)!, field)) !== stable([]) && stable(semanticField((b || a)!, field)) !== stable({}));
  return fields.filter(field => stable(semanticField(a, field)) !== stable(semanticField(b, field)));
}
function safeOrigin(origin: MutationOrigin): MutationOrigin { return ['user', 'gitlab', 'automation', 'system', 'import', 'restore'].includes(origin) ? origin : 'system'; }

/** Transactional outbox plus an at-least-once leased HTTP worker. Destination
 * configuration and secrets never enter native workspace exports. */
export class OutboundWebhookService {
  private readonly instanceId = randomUUID();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;
  private closed = false;
  private running: Promise<number> | null = null;
  private controllers = new Map<string, { endpointId: string; controller: AbortController }>();

  constructor(private readonly store: Store, options: OutboundWebhookOptions = {}) {
    this.now = options.now || Date.now;
    this.timeoutMs = Math.max(10, Math.min(10000, options.timeoutMs || 10000));
    this.leaseMs = Math.max(this.timeoutMs + 1000, options.leaseMs || 30000);
    this.maxAttempts = Math.max(1, Math.min(WEBHOOK_MAX_ATTEMPTS, options.maxAttempts || WEBHOOK_MAX_ATTEMPTS));
    this.retryBaseMs = Math.max(1, options.retryBaseMs || 5000);
    store.db.exec(`CREATE TABLE IF NOT EXISTS webhook_endpoints(id TEXT PRIMARY KEY,json TEXT NOT NULL,secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY,json TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_deliveries(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
        endpoint_version INTEGER NOT NULL,generation TEXT NOT NULL,status TEXT NOT NULL,next_attempt_at TEXT,lease_owner TEXT,lease_until TEXT,json TEXT NOT NULL,UNIQUE(endpoint_id,event_id));
      CREATE INDEX IF NOT EXISTS webhook_delivery_due ON webhook_deliveries(status,next_attempt_at);
      CREATE INDEX IF NOT EXISTS webhook_delivery_endpoint ON webhook_deliveries(endpoint_id);
      CREATE INDEX IF NOT EXISTS webhook_delivery_lease ON webhook_deliveries(lease_owner,lease_until);`);
    if (!store.setting(GENERATION_SETTING)) store.setSetting(GENERATION_SETTING, randomUUID());
    this.unsubscribe = store.onChange(change => this.capture(change), ['issues', 'documents', 'comments']);
    this.prune();
    if (options.autoStart !== false) {
      const run = () => { void this.tick().catch(() => { if (!this.closed) console.error('[teamspace webhooks] 작업 상태를 갱신하지 못했습니다.'); }); };
      this.timer = setInterval(run, Math.max(10, options.pollIntervalMs || 1000)); this.timer.unref();
      this.initialTimer = setTimeout(run, 0); this.initialTimer.unref();
    }
  }
  private timestamp() { return new Date(this.now()).toISOString(); }
  private generation(): string { return this.store.setting(GENERATION_SETTING) as string; }
  listEndpoints(): WebhookEndpoint[] { return (this.store.db.prepare('SELECT json FROM webhook_endpoints ORDER BY rowid DESC').all() as { json: string }[]).map(row => JSON.parse(row.json) as WebhookEndpoint); }
  private endpoint(id: unknown): { endpoint: WebhookEndpoint; secret: string } {
    const row = typeof id === 'string' ? this.store.db.prepare('SELECT json,secret FROM webhook_endpoints WHERE id=?').get(id) as EndpointRow | undefined : undefined;
    if (!row) return fail(404, '웹훅 수신처를 찾을 수 없습니다.');
    return { endpoint: JSON.parse(row.json) as WebhookEndpoint, secret: row.secret };
  }
  private parse(input: unknown, previous?: WebhookEndpoint): Pick<WebhookEndpoint, 'name' | 'url' | 'projectIds' | 'eventTypes' | 'enabled'> {
    const value = object(input), candidate = { ...(previous || {}), ...value };
    if (typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 120) fail(400, '웹훅 이름은 1~120자여야 합니다.');
    if (typeof candidate.url !== 'string' || candidate.url.length > 4000 || /[\u0000-\u001f\u007f]/.test(candidate.url)) fail(400, '웹훅 URL을 확인해 주세요.');
    let url: URL; try { url = new URL((candidate.url as string).trim()); } catch { return fail(400, '절대 http(s) URL이 필요합니다.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (candidate.url as string).includes('#')) fail(400, '인증 정보와 fragment가 없는 http(s) URL이 필요합니다.');
    let projectIds: string[] | null = null;
    if (candidate.projectIds !== undefined && candidate.projectIds !== null) {
      if (!Array.isArray(candidate.projectIds) || !candidate.projectIds.length || candidate.projectIds.length > 10000 || candidate.projectIds.some(id => typeof id !== 'string' || !this.store.get('projects', id)) || new Set(candidate.projectIds).size !== candidate.projectIds.length) fail(400, '수신할 프로젝트 목록을 확인해 주세요.');
      projectIds = [...candidate.projectIds as string[]].sort();
    }
    const types = candidate.eventTypes;
    if (!Array.isArray(types) || !types.length || types.length > OUTBOUND_EVENT_TYPES.length || types.some(type => !OUTBOUND_EVENT_TYPES.includes(type as OutboundEventType)) || new Set(types).size !== types.length) fail(400, '수신할 이벤트 종류를 선택해 주세요.');
    if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') fail(400, '웹훅 활성화 여부를 확인해 주세요.');
    if (!previous && candidate.enabled === true) fail(400, '수신처는 비활성 상태로 만든 뒤 명시적으로 활성화해 주세요.');
    return { name: (candidate.name as string).trim(), url: url.toString(), projectIds, eventTypes: [...types as OutboundEventType[]].sort(), enabled: previous ? candidate.enabled as boolean : false };
  }
  private putEndpoint(endpoint: WebhookEndpoint, secret: string) { this.store.db.prepare('INSERT INTO webhook_endpoints(id,json,secret) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,secret=excluded.secret').run(endpoint.id, JSON.stringify(endpoint), secret); }
  private putDelivery(value: WebhookDelivery, endpointVersion: number, generation: string, owner: string | null = null, until: string | null = null) {
    this.store.db.prepare(`INSERT INTO webhook_deliveries(id,endpoint_id,event_id,endpoint_version,generation,status,next_attempt_at,lease_owner,lease_until,json) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET endpoint_id=excluded.endpoint_id,event_id=excluded.event_id,endpoint_version=excluded.endpoint_version,generation=excluded.generation,status=excluded.status,next_attempt_at=excluded.next_attempt_at,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,json=excluded.json`).run(value.id, value.endpointId, value.eventId, endpointVersion, generation, value.status, value.nextAttemptAt, owner, until, JSON.stringify(value));
  }
  private deliveryRow(id: string): DeliveryRow | undefined { return this.store.db.prepare('SELECT json,endpoint_version,generation,lease_owner,lease_until FROM webhook_deliveries WHERE id=?').get(id) as DeliveryRow | undefined; }
  create(input: unknown, afterSave?: (endpoint: WebhookEndpoint) => void): WebhookEndpointCreated {
    return this.store.transaction(() => {
      if (this.listEndpoints().length >= WEBHOOK_MAX_ENDPOINTS) fail(409, '웹훅 수신처는 최대 20개까지 만들 수 있습니다.');
      const value = this.parse(input), timestamp = this.timestamp(), secret = `whsec_${randomBytes(32).toString('base64')}`;
      const endpoint: WebhookEndpoint = { id: randomUUID(), ...value, enabled: false, secretConfigured: true, version: 1, createdAt: timestamp, updatedAt: timestamp };
      this.putEndpoint(endpoint, this.store.seal(secret)); afterSave?.(endpoint); return { endpoint, secret };
    });
  }
  private cancelStale(endpointId: string) {
    for (const row of this.store.db.prepare("SELECT json,endpoint_version,generation,lease_owner,lease_until FROM webhook_deliveries WHERE endpoint_id=? AND status IN ('pending','delivering')").all(endpointId) as DeliveryRow[]) {
      const old = JSON.parse(row.json) as WebhookDelivery;
      this.putDelivery({ ...old, status: 'cancelled', nextAttemptAt: null, lastError: '수신처 설정이 변경되었거나 삭제되어 전송을 취소했습니다.', version: old.version + 1, updatedAt: this.timestamp() }, row.endpoint_version, row.generation);
    }
  }
  private abortEndpoint(id: string) { for (const operation of this.controllers.values()) if (operation.endpointId === id) operation.controller.abort(); }
  update(id: string, input: unknown, expectedVersion: unknown, afterSave?: (endpoint: WebhookEndpoint) => void): WebhookEndpoint {
    let changed = false;
    const result = this.store.transaction(() => {
      const old = this.endpoint(id); cas(expectedVersion, old.endpoint); const values = this.parse(input, old.endpoint);
      if (stable(values) === stable(Object.fromEntries(['name', 'url', 'projectIds', 'eventTypes', 'enabled'].map(key => [key, old.endpoint[key as keyof WebhookEndpoint]])))) return old.endpoint;
      const endpoint = { ...old.endpoint, ...values, version: old.endpoint.version + 1, updatedAt: this.timestamp() };
      this.putEndpoint(endpoint, old.secret); this.cancelStale(id); afterSave?.(endpoint); changed = true; return endpoint;
    });
    if (changed) this.abortEndpoint(id); return result;
  }
  rotateSecret(id: string, expectedVersion: unknown, afterSave?: (endpoint: WebhookEndpoint) => void): WebhookEndpointCreated {
    const result = this.store.transaction(() => {
      const old = this.endpoint(id); cas(expectedVersion, old.endpoint); const secret = `whsec_${randomBytes(32).toString('base64')}`;
      const endpoint = { ...old.endpoint, secretConfigured: true, version: old.endpoint.version + 1, updatedAt: this.timestamp() };
      this.putEndpoint(endpoint, this.store.seal(secret)); this.cancelStale(id); afterSave?.(endpoint); return { endpoint, secret };
    });
    this.abortEndpoint(id); return result;
  }
  remove(id: string, expectedVersion: unknown, afterDelete?: (endpoint: WebhookEndpoint) => void) {
    this.store.transaction(() => { const old = this.endpoint(id); cas(expectedVersion, old.endpoint); this.cancelStale(id); this.store.db.prepare('DELETE FROM webhook_endpoints WHERE id=?').run(id); afterDelete?.(old.endpoint); });
    this.abortEndpoint(id);
  }
  private matches(endpoint: WebhookEndpoint, envelope: WebhookEnvelope) { return endpoint.enabled && endpoint.eventTypes.includes(envelope.type) && (endpoint.projectIds === null || envelope.projectId !== null && endpoint.projectIds.includes(envelope.projectId)); }
  private capture(change: StoreChange) {
    if (this.closed || change.context.origin === 'import') return;
    const before = change.before as Issue | DocPage | Comment | null, after = change.after as Issue | DocPage | Comment | null;
    if (!before && !after || change.table === 'comments' && (before || !after || change.context.origin === 'restore')) return;
    const record = (after || before)!;
    let projectId: string | null, type: OutboundEventType, resource: WebhookEnvelope['resource'], previous: WebhookEnvelope['previous'], changedFields: string[];
    if (change.table === 'comments') {
      const comment = record as Comment;
      const parent = this.store.get<Issue | DocPage>(comment.resourceType === 'issue' ? 'issues' : 'documents', comment.resourceId);
      if (!parent) return;
      projectId = parent.projectId;
      type = 'comment.created'; changedFields = ['body']; previous = null;
      resource = { id: comment.id, type: 'comment', parentType: comment.resourceType, parentId: comment.resourceId };
    } else {
      const issue = change.table === 'issues', old = before as Issue | DocPage | null, current = record as Issue | DocPage;
      changedFields = changed(before, after, issue ? issueFields : documentFields);
      if (before && after && !changedFields.length) return;
      projectId = current.projectId; type = `${issue ? 'issue' : 'document'}.${!before ? 'created' : !after ? 'deleted' : 'updated'}`;
      resource = { id: current.id, type: issue ? 'issue' : 'document', ...(issue ? { key: short((current as Issue).key, 80) } : {}), title: short(current.title, 300), status: short(current.status, 80), version: current.version };
      previous = old ? { title: short(old.title, 300), status: short(old.status, 80), version: old.version } : null;
    }
    const envelope: WebhookEnvelope = { id: randomUUID(), type, occurredAt: this.timestamp(), actorId: short(change.context.actorId, 200) || null, origin: safeOrigin(change.context.origin), projectId, sourceEventId: short(change.context.sourceEventId, 200) || null, changedFields, resource, previous };
    const endpoints = this.listEndpoints().filter(endpoint => this.matches(endpoint, envelope)); if (!endpoints.length) return;
    const count = (this.store.db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get() as { count: number }).count;
    if (count + endpoints.length > MAX_DELIVERIES) fail(503, '웹훅 전송 기록 한도에 도달했습니다. 전송 상태를 확인한 뒤 다시 시도해 주세요.');
    const body = JSON.stringify(envelope), generation = this.generation(); this.store.db.prepare('INSERT INTO webhook_events(id,json,body,created_at) VALUES(?,?,?,?)').run(envelope.id, body, body, envelope.occurredAt);
    for (const endpoint of endpoints) this.putDelivery({ id: randomUUID(), endpointId: endpoint.id, eventId: envelope.id, eventType: envelope.type, projectId: envelope.projectId, resourceId: envelope.resource.id, status: 'pending', attempts: 0, nextAttemptAt: envelope.occurredAt, lastAttemptAt: null, httpStatus: null, lastError: null, version: 1, createdAt: envelope.occurredAt, updatedAt: envelope.occurredAt }, endpoint.version, generation);
  }
  listDeliveries(options: { endpointId?: string; limit?: number } = {}): WebhookDelivery[] {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'limit은 1~100의 정수여야 합니다.');
    const rows = options.endpointId === undefined ? this.store.db.prepare('SELECT json FROM webhook_deliveries ORDER BY rowid DESC LIMIT ?').all(limit) : this.store.db.prepare('SELECT json FROM webhook_deliveries WHERE endpoint_id=? ORDER BY rowid DESC LIMIT ?').all(options.endpointId, limit);
    return (rows as { json: string }[]).map(row => JSON.parse(row.json) as WebhookDelivery);
  }
  deliveryDetail(id: string): WebhookDeliveryDetail {
    const row = this.deliveryRow(id); if (!row) return fail(404, '웹훅 전송 기록을 찾을 수 없습니다.'); const delivery = JSON.parse(row.json) as WebhookDelivery;
    const event = this.store.db.prepare('SELECT json FROM webhook_events WHERE id=?').get(delivery.eventId) as { json: string } | undefined; if (!event) return fail(404, '웹훅 이벤트를 찾을 수 없습니다.');
    return { delivery, envelope: JSON.parse(event.json) as WebhookEnvelope };
  }
  retry(id: string, expectedVersion: unknown, afterRetry?: (delivery: WebhookDelivery) => void): WebhookDelivery {
    return this.store.transaction(() => {
      const row = this.deliveryRow(id); if (!row) return fail(404, '웹훅 전송 기록을 찾을 수 없습니다.'); const old = JSON.parse(row.json) as WebhookDelivery; cas(expectedVersion, old);
      if (!['failed', 'cancelled'].includes(old.status)) fail(409, '실패하거나 취소된 전송만 다시 시도할 수 있습니다.');
      const { endpoint } = this.endpoint(old.endpointId), { envelope } = this.deliveryDetail(id); if (!this.matches(endpoint, envelope)) fail(422, '현재 활성화된 수신처의 프로젝트·이벤트 범위에서만 다시 시도할 수 있습니다.');
      const delivery: WebhookDelivery = { ...old, status: 'pending', attempts: 0, nextAttemptAt: this.timestamp(), lastAttemptAt: null, httpStatus: null, lastError: null, version: old.version + 1, updatedAt: this.timestamp() };
      this.putDelivery(delivery, endpoint.version, this.generation()); afterRetry?.(delivery); return delivery;
    });
  }
  private prune() {
    const cutoff = new Date(this.now() - WEBHOOK_RETENTION_DAYS * 86400000).toISOString();
    this.store.db.prepare("DELETE FROM webhook_deliveries WHERE status IN ('succeeded','failed','cancelled') AND json_extract(json,'$.updatedAt')<?").run(cutoff);
    this.store.db.exec('DELETE FROM webhook_events WHERE NOT EXISTS(SELECT 1 FROM webhook_deliveries WHERE event_id=webhook_events.id)');
  }
  private claim(): Claim[] {
    return this.store.transaction(() => {
      this.prune(); const now = this.timestamp(), generation = this.generation();
      for (const row of this.store.db.prepare("SELECT json,endpoint_version,generation,lease_owner,lease_until FROM webhook_deliveries WHERE status='delivering' AND lease_until<=?").all(now) as DeliveryRow[]) {
        const old = JSON.parse(row.json) as WebhookDelivery, exhausted = old.attempts >= this.maxAttempts;
        this.putDelivery({ ...old, status: exhausted ? 'failed' : 'pending', nextAttemptAt: exhausted ? null : now, lastError: '이전 전송의 임대가 만료되었습니다. 수신처에서 이벤트 ID로 중복 여부를 확인해 주세요.', version: old.version + 1, updatedAt: now }, row.endpoint_version, row.generation);
      }
      const candidates = this.store.db.prepare("SELECT json,endpoint_version,generation,lease_owner,lease_until FROM webhook_deliveries WHERE status='pending' AND next_attempt_at<=? ORDER BY rowid LIMIT ?").all(now, BATCH_SIZE) as DeliveryRow[];
      const claims: Claim[] = [];
      for (const row of candidates) {
        const old = JSON.parse(row.json) as WebhookDelivery;
        if (old.attempts >= this.maxAttempts) { this.putDelivery({ ...old, status: 'failed', nextAttemptAt: null, lastError: '최대 전송 시도 횟수에 도달했습니다. 수동 재시도를 사용할 수 있습니다.', version: old.version + 1, updatedAt: now }, row.endpoint_version, row.generation); continue; }
        const event = this.store.db.prepare('SELECT json,body FROM webhook_events WHERE id=?').get(old.eventId) as { json: string; body: string } | undefined;
        const endpointRow = this.store.db.prepare('SELECT json,secret FROM webhook_endpoints WHERE id=?').get(old.endpointId) as EndpointRow | undefined;
        const endpoint = endpointRow ? JSON.parse(endpointRow.json) as WebhookEndpoint : undefined, envelope = event ? JSON.parse(event.json) as WebhookEnvelope : undefined;
        if (!endpoint || !envelope || row.generation !== generation || endpoint.version !== row.endpoint_version || !this.matches(endpoint, envelope)) { this.putDelivery({ ...old, status: 'cancelled', nextAttemptAt: null, lastError: '현재 수신처 설정에서 전송할 수 없는 이벤트입니다.', version: old.version + 1, updatedAt: now }, row.endpoint_version, row.generation); continue; }
        const delivery: WebhookDelivery = { ...old, status: 'delivering', attempts: old.attempts + 1, nextAttemptAt: null, lastAttemptAt: now, httpStatus: null, lastError: null, version: old.version + 1, updatedAt: now };
        this.putDelivery(delivery, endpoint.version, generation, this.instanceId, new Date(this.now() + this.leaseMs).toISOString());
        claims.push({ delivery, endpoint, endpointVersion: endpoint.version, generation, body: event!.body, envelope, secret: endpointRow!.secret });
      }
      return claims;
    });
  }
  private async send(claim: Claim) {
    if (this.closed) return;
    const controller = new AbortController(); this.controllers.set(claim.delivery.id, { endpointId: claim.endpoint.id, controller });
    let timedOut = false, httpStatus: number | null = null, lastError: string | null = null;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs); timer.unref();
    let decoded: Buffer | undefined;
    try {
      const secret = this.store.unseal(claim.secret); decoded = Buffer.from(secret.slice('whsec_'.length), 'base64'); if (decoded.length !== 32 || !secret.startsWith('whsec_')) throw new Error('invalid key');
      const timestamp = String(Math.floor(this.now() / 1000)), signature = createHmac('sha256', decoded).update(`${claim.envelope.id}.${timestamp}.${claim.body}`).digest('base64');
      const response = await fetch(claim.endpoint.url, { method: 'POST', redirect: 'manual', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Teamspace-Webhooks/1', 'webhook-id': claim.envelope.id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }, body: claim.body });
      httpStatus = response.status;
      // No response content is needed, read or persisted. Cancel its stream
      // immediately so an arbitrarily large receiver body stays bounded.
      void response.body?.cancel().catch(() => {}); controller.abort();
      if (httpStatus < 200 || httpStatus >= 300) lastError = httpStatus >= 300 && httpStatus < 400 ? '수신처가 리다이렉트 응답을 반환했습니다. 자동으로 따라가지 않습니다.' : `수신처가 HTTP ${httpStatus} 응답을 반환했습니다.`;
    } catch { lastError = timedOut ? '전송 시간 제한을 초과했습니다.' : '수신처 연결 또는 서명 처리를 완료하지 못했습니다.'; }
    finally { clearTimeout(timer); decoded?.fill(0); this.controllers.delete(claim.delivery.id); }
    if (this.closed) return;
    this.store.transaction(() => {
      if (this.generation() !== claim.generation) return;
      const row = this.deliveryRow(claim.delivery.id); if (!row || row.lease_owner !== this.instanceId || row.endpoint_version !== claim.endpointVersion || row.generation !== claim.generation) return;
      const current = JSON.parse(row.json) as WebhookDelivery; if (current.status !== 'delivering') return;
      const endpointRow = this.store.db.prepare('SELECT json FROM webhook_endpoints WHERE id=?').get(current.endpointId) as { json: string } | undefined;
      const endpoint = endpointRow ? JSON.parse(endpointRow.json) as WebhookEndpoint : undefined;
      if (!endpoint || endpoint.version !== claim.endpointVersion || !this.matches(endpoint, claim.envelope)) { this.putDelivery({ ...current, status: 'cancelled', nextAttemptAt: null, lastError: '전송 중 수신처 설정이 변경되어 완료 결과를 반영하지 않았습니다.', version: current.version + 1, updatedAt: this.timestamp() }, row.endpoint_version, row.generation); return; }
      const succeeded = !lastError && httpStatus !== null && httpStatus >=200 && httpStatus <300, retry = !succeeded && current.attempts < this.maxAttempts;
      this.putDelivery({ ...current, status: succeeded ? 'succeeded' : retry ? 'pending' : 'failed', nextAttemptAt: retry ? new Date(this.now() + Math.min(3600000, this.retryBaseMs * 2 ** (current.attempts - 1))).toISOString() : null, httpStatus, lastError, version: current.version + 1, updatedAt: this.timestamp() }, row.endpoint_version, row.generation);
    });
  }
  tick(): Promise<number> {
    if (this.closed) return Promise.resolve(0); if (this.running) return this.running;
    this.running = (async () => { const claims = this.claim(); await Promise.all(claims.map(claim => this.send(claim))); return claims.length; })().finally(() => { this.running = null; });
    return this.running;
  }
  resetForImport(): void {
    this.store.db.exec('DELETE FROM webhook_deliveries; DELETE FROM webhook_events; DELETE FROM webhook_endpoints;');
    this.store.setSetting(GENERATION_SETTING, randomUUID());
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.unsubscribe(); if (this.timer) clearInterval(this.timer); if (this.initialTimer) clearTimeout(this.initialTimer);
    for (const { controller } of this.controllers.values()) controller.abort();
    this.store.transaction(() => {
      for (const row of this.store.db.prepare("SELECT json,endpoint_version,generation,lease_owner,lease_until FROM webhook_deliveries WHERE status='delivering' AND lease_owner=?").all(this.instanceId) as DeliveryRow[]) {
        const old = JSON.parse(row.json) as WebhookDelivery;
        const exhausted = old.attempts >= this.maxAttempts;
        this.putDelivery({ ...old, status: exhausted ? 'failed' : 'pending', nextAttemptAt: exhausted ? null : this.timestamp(), lastError: exhausted ? '서비스 중지로 마지막 전송 결과를 확인하지 못했습니다. 필요하면 수동 재시도를 사용해 주세요.' : '서비스 중지로 전송 임대를 반환했습니다.', version: old.version + 1, updatedAt: this.timestamp() }, row.endpoint_version, row.generation);
      }
    });
  }
  registerRoutes(app: Express, hooks: Hooks) {
    const route = (handler: (request: Request, response: Response) => unknown) => (request: Request, response: Response, next: NextFunction) => { try { handler(request, response); } catch (cause) { next(cause); } };
    app.get('/api/webhook-endpoints', route((_request, response) => response.json(this.listEndpoints())));
    app.post('/api/webhook-endpoints', route((request, response) => { hooks.actor(request); response.status(201).json(this.create(request.body, endpoint => hooks.activity(request, 'webhook_endpoint', endpoint.id, '웹훅 수신처 생성', endpoint.name))); }));
    app.patch('/api/webhook-endpoints/:id', route((request, response) => { hooks.actor(request); response.json(this.update(String(request.params.id), request.body, request.body.expectedVersion, endpoint => hooks.activity(request, 'webhook_endpoint', endpoint.id, '웹훅 수신처 변경', endpoint.name))); }));
    app.delete('/api/webhook-endpoints/:id', route((request, response) => { hooks.actor(request); const raw = request.query.expectedVersion; if (typeof raw !== 'string' || !/^\d+$/.test(raw)) fail(400, '삭제할 수신처의 expectedVersion이 필요합니다.'); this.remove(String(request.params.id), Number(raw), endpoint => hooks.activity(request, 'webhook_endpoint', endpoint.id, '웹훅 수신처 삭제', endpoint.name)); response.json({ ok: true }); }));
    app.post('/api/webhook-endpoints/:id/rotate-secret', route((request, response) => { hooks.actor(request); response.json(this.rotateSecret(String(request.params.id), request.body.expectedVersion, endpoint => hooks.activity(request, 'webhook_endpoint', endpoint.id, '웹훅 서명 키 교체', endpoint.name))); }));
    app.get('/api/webhook-deliveries', route((request, response) => { const { endpointId, limit } = request.query; if (Object.keys(request.query).some(key => !['endpointId', 'limit'].includes(key))) fail(400, '웹훅 전송 필터를 확인해 주세요.'); if (endpointId !== undefined && (typeof endpointId !== 'string' || !endpointId || endpointId.length >200)) fail(400, '수신처 필터를 확인해 주세요.'); if (limit !== undefined && (typeof limit !== 'string' || !/^\d+$/.test(limit))) fail(400, 'limit은 1~100의 정수여야 합니다.'); response.json(this.listDeliveries({ ...(typeof endpointId === 'string' ? { endpointId } : {}), ...(typeof limit === 'string' ? { limit: Number(limit) } : {}) })); }));
    app.get('/api/webhook-deliveries/:id', route((request, response) => response.json(this.deliveryDetail(String(request.params.id)))));
    app.post('/api/webhook-deliveries/:id/retry', route((request, response) => { hooks.actor(request); response.json(this.retry(String(request.params.id), request.body.expectedVersion, delivery => hooks.activity(request, 'webhook_delivery', delivery.id, '웹훅 전송 재시도', delivery.eventType))); }));
  }
}
