import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { ApiKeyCreated, ApiKeyRecord, Attachment, AttachmentVersion, Comment, DocPage, DocRevision, Issue, PlanningItem, Project, RichContent, User } from '../shared/types.js';
import { Store } from './store.js';
import { normalizeDocumentContent } from './document-content.js';
import { contentReferences, documentIssueBlocks } from '../shared/document-nodes.js';

export class ApiKeyError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
const fail = (status: number, message: string): never => { throw new ApiKeyError(status, message); };
const unauthorized = (): never => fail(401, '유효한 Bearer API 키가 필요합니다.');
const metadata = (row: { json: string } | undefined) => row ? JSON.parse(row.json) as ApiKeyRecord : undefined;
type Hooks = { actor: (request: Request) => string; activity: (request: Request, type: string, id: string, action: string, detail?: string) => unknown };
type Context = { id: string; version: number; actorId: string; path: string };

/** The existing /api browser surface remains local/trusted. Only /api/v1 is a
 * strict Bearer gateway; it reuses the application's normal mutation routes. */
export class ApiKeyService {
  private contexts = new WeakMap<Request, Context>();
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS api_keys(
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS api_keys_actor ON api_keys(actor_id);`);
  }

  list(actorId: string): ApiKeyRecord[] {
    return (this.store.db.prepare('SELECT json FROM api_keys WHERE actor_id=?').all(actorId) as { json: string }[]).map(row => JSON.parse(row.json) as ApiKeyRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private get(id: string): ApiKeyRecord | undefined {
    return metadata(this.store.db.prepare('SELECT json FROM api_keys WHERE id=?').get(id) as { json: string } | undefined);
  }
  private valid(record: ApiKeyRecord | undefined): ApiKeyRecord {
    if (!record || record.revokedAt || !this.store.get('users', record.actorId)) return unauthorized();
    if (record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now())) return unauthorized();
    return record;
  }
  authenticate(token: string): ApiKeyRecord {
    if (!/^ts_[A-Za-z0-9_-]{43}$/.test(token)) return unauthorized();
    const hash = createHash('sha256').update(token).digest('hex');
    return this.valid(metadata(this.store.db.prepare('SELECT json FROM api_keys WHERE token_hash=?').get(hash) as { json: string } | undefined));
  }

  create(actorId: string, input: unknown): ApiKeyCreated {
    if (!this.store.get('users', actorId)) fail(400, '작업자를 확인해 주세요.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'API 키 설정을 확인해 주세요.');
    const value = input as Record<string, unknown>;
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) fail(400, 'API 키 이름은 1~120자여야 합니다.');
    if (!['read', 'write'].includes(value.access as string)) fail(400, '읽기 또는 읽기·쓰기 권한을 선택해 주세요.');
    let projectIds: string[] | null = null;
    if (value.projectIds !== null) {
      if (!Array.isArray(value.projectIds) || !value.projectIds.length || value.projectIds.length > 10000 || !value.projectIds.every(id => typeof id === 'string' && this.store.get('projects', id))) fail(400, '허용할 프로젝트를 확인해 주세요.');
      projectIds = [...new Set(value.projectIds as string[])];
    }
    let expiresAt: string | null = null;
    if (value.expiresAt !== null && value.expiresAt !== undefined) {
      if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) fail(400, '만료일은 현재보다 미래여야 합니다.');
      expiresAt = new Date(value.expiresAt as string).toISOString();
    }
    const token = `ts_${randomBytes(32).toString('base64url')}`;
    const key: ApiKeyRecord = { id: randomUUID(), name: (value.name as string).trim(), prefix: token.slice(0, 11), actorId, access: value.access as ApiKeyRecord['access'], projectIds, version: 1, createdAt: new Date().toISOString(), expiresAt, lastUsedAt: null, revokedAt: null };
    this.store.db.prepare('INSERT INTO api_keys(id,actor_id,token_hash,json) VALUES(?,?,?,?)').run(key.id, actorId, createHash('sha256').update(token).digest('hex'), JSON.stringify(key));
    return { key, token };
  }

  revoke(id: string, actorId: string, expectedVersion: unknown, onRevoked?: (record: ApiKeyRecord) => void): ApiKeyRecord {
    return this.store.transaction(() => {
      const key = this.get(id);
      if (!key || key.actorId !== actorId) fail(404, 'API 키를 찾을 수 없습니다.');
      if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) fail(400, 'expectedVersion이 필요합니다.');
      if (key!.revokedAt) return key!;
      if (key!.version !== expectedVersion) fail(409, 'API 키가 변경되었습니다. 목록을 다시 불러와 주세요.');
      const updated = { ...key!, version: key!.version + 1, revokedAt: new Date().toISOString() };
      this.store.db.prepare('UPDATE api_keys SET json=? WHERE id=?').run(JSON.stringify(updated), id);
      onRevoked?.(updated);
      return updated;
    });
  }

  installAuthentication(app: Express) {
    app.use((request: Request, _response: Response, next: NextFunction) => {
      try {
        const path = request.url.split('?')[0];
        if (path !== '/api/v1' && !path.startsWith('/api/v1/')) return next();
        const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
        const match = /^Bearer (ts_[A-Za-z0-9_-]{43})$/i.exec(request.header('Authorization') || '');
        if (count !== 1 || !match) return unauthorized();
        const record = this.authenticate(match[1]);
        const rewritten = `/api${request.url.slice('/api/v1'.length)}`;
        this.contexts.set(request, { id: record.id, actorId: record.actorId, version: record.version, path: rewritten.split('?')[0] });
        request.headers['x-actor-id'] = record.actorId;
        request.url = rewritten;
        next();
      } catch (error) { next(error); }
    });
  }

  private allowedProject(key: ApiKeyRecord, projectId: unknown) {
    if (key.projectIds === null) return;
    if (typeof projectId !== 'string' || !key.projectIds.includes(projectId)) fail(403, '이 API 키에서 허용하지 않은 프로젝트입니다.');
  }
  private canReadDocumentBody(key: ApiKeyRecord, content: RichContent): boolean {
    const projects = key.projectIds;
    return projects === null || documentIssueBlocks(content).every(({ type, projectId }) => type !== 'issueSummary' || projects.includes(projectId));
  }
  private requireDocumentBody(key: ApiKeyRecord, content: RichContent) {
    if (!this.canReadDocumentBody(key, content)) fail(403, '문서에 이 API 키에서 허용하지 않은 프로젝트의 업무 현황이 있습니다.');
  }
  authorizeDocumentBody(request: Request, content: RichContent) {
    const context = this.contexts.get(request);
    if (context) this.requireDocumentBody(this.valid(this.get(context.id)), content);
  }
  private resource(key: ApiKeyRecord, table: 'issues' | 'documents' | 'planning_items', id: unknown): Issue | DocPage | PlanningItem {
    if (typeof id !== 'string' || !id) fail(400, '대상 ID를 확인해 주세요.');
    const record = this.store.get<Issue | DocPage | PlanningItem>(table, id as string);
    if (!record) fail(404, '대상을 찾을 수 없습니다.');
    this.allowedProject(key, record!.projectId);
    return record!;
  }
  private query(request: Request, names: string[]): Record<string, string> {
    const raw = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '';
    const parsed = new URLSearchParams(raw);
    const result: Record<string, string> = {};
    for (const [name, value] of parsed) {
      if (!names.includes(name) || Object.hasOwn(result, name) || !value) fail(400, '조회 조건은 허용된 단일 값이어야 합니다.');
      result[name] = value;
    }
    return result;
  }
  private decode(value: string): string {
    let id: string;
    try { id = decodeURIComponent(value); } catch { return fail(400, '대상 ID 형식이 올바르지 않습니다.'); }
    if (!id || /[\/\\\u0000-\u001f]/.test(id) || id === '.' || id === '..') fail(400, '대상 ID 형식이 올바르지 않습니다.');
    return id;
  }
  private references(key: ApiKeyRecord, request: Request, projectId: unknown, type: 'issue' | 'document', previous?: Issue | DocPage) {
    this.allowedProject(key, projectId);
    const body = request.body as Record<string, unknown>;
    if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') this.resource(key, type === 'issue' ? 'issues' : 'documents', body.parentId);
    if (type === 'issue') for (const field of ['cycleId', 'moduleId', 'releaseId']) {
      if (body[field] !== undefined && body[field] !== null && body[field] !== '') this.resource(key, 'planning_items', body[field]);
    }
    if (type === 'document' && Object.hasOwn(body, 'content')) {
      const { content } = normalizeDocumentContent(body.content);
      const historical = new Set(previous && 'content' in previous ? contentReferences(previous.content).map(reference => `${reference.type}:${reference.kind}:${reference.id}`) : []);
      for (const reference of contentReferences(content)) {
        const table = reference.type === 'issue' ? 'issues' : 'documents';
        if (!this.store.get(table, reference.id) && historical.has(`${reference.type}:${reference.kind}:${reference.id}`)) continue;
        this.resource(key, table, reference.id);
      }
      for (const { projectId } of documentIssueBlocks(content)) this.allowedProject(key, projectId);
    }
  }

  installAuthorization(app: Express) {
    app.use((request: Request, response: Response, next: NextFunction) => {
      const context = this.contexts.get(request);
      if (!context) return next();
      try {
        // Authentication happens before body parsing. Recheck after the entire
        // body arrives so revocation/import during a slow upload takes effect.
        const key = this.valid(this.get(context.id));
        if (key.version !== context.version || key.actorId !== context.actorId) return unauthorized();
        request.headers['x-actor-id'] = key.actorId;
        if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) request.body.actorId = key.actorId;
        this.authorize(key, context.path, request, response, next);
      } catch (error) { next(error); }
    });
  }

  private used(key: ApiKeyRecord) {
    const result = this.store.db.prepare("UPDATE api_keys SET json=json_set(json,'$.lastUsedAt',?) WHERE id=? AND json_extract(json,'$.version')=? AND json_extract(json,'$.revokedAt') IS NULL").run(new Date().toISOString(), key.id, key.version);
    if (Number(result.changes) !== 1) unauthorized();
  }
  private authorizeAttachment(key: ApiKeyRecord, path: string, request: Request): boolean {
    const versions = /^\/api\/attachments\/([^/]+)\/versions$/.exec(path);
    const content = /^\/api\/attachments\/([^/]+)\/content$/.exec(path);
    const download = /^\/api\/attachment-versions\/([^/]+)\/download$/.exec(path);
    if (path !== '/api/attachments' && !versions && !content && !download) return false;
    const upload = request.method === 'POST' && (path === '/api/attachments' || versions);
    if (request.method !== 'GET' && !upload) fail(403, '공개 API에서 지원하지 않는 첨부 작업입니다.');
    if (upload && key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
    const owner = (type: unknown, id: unknown) => {
      if (type !== 'issue' && type !== 'document') fail(400, '첨부파일 대상을 확인해 주세요.');
      this.resource(key, type === 'issue' ? 'issues' : 'documents', id);
    };
    if (path === '/api/attachments') {
      const query = this.query(request, upload ? ['resourceType','resourceId','filename'] : ['resourceType','resourceId']);
      owner(query.resourceType, query.resourceId);
    } else if (versions) {
      this.query(request, upload ? ['filename','expectedVersionId'] : []);
      const attachment = this.store.get<Attachment>('attachments', this.decode(versions[1]));
      if (!attachment) return fail(404, '첨부파일을 찾을 수 없습니다.');
      owner(attachment.resourceType, attachment.resourceId);
    } else {
      const query = this.query(request, ['inline']);
      if (query.inline !== undefined && query.inline !== '1') fail(400, '첨부파일 표시 방식을 확인해 주세요.');
      const id = this.decode((content ?? download)![1]);
      const attachment = this.store.get<Attachment>('attachments', id) ?? this.store.get<AttachmentVersion>('attachment_versions', id);
      if (!attachment) return fail(404, '첨부파일을 찾을 수 없습니다.');
      owner(attachment.resourceType, attachment.resourceId);
    }
    return true;
  }
  private authorize(key: ApiKeyRecord, path: string, request: Request, response: Response, next: NextFunction) {
    if (this.authorizeAttachment(key, path, request)) {
      this.used(key);
      return next();
    }
    const fieldBreakdown = /^\/api\/projects\/([^/]+)\/field-breakdown(?:\/issues)?$/.exec(path);
    if (request.method === 'POST' && fieldBreakdown) {
      this.query(request, []);
      this.allowedProject(key, this.decode(fieldBreakdown[1]));
      this.used(key);
      return next();
    }
    if (request.method === 'POST' && path === '/api/issues/query') {
      this.query(request, []);
      if (typeof request.body.projectId !== 'string' || !request.body.projectId) fail(400, '필터를 적용할 프로젝트가 필요합니다.');
      this.allowedProject(key, request.body.projectId);
      this.used(key);
      return next();
    }
    const worklogs = /^\/api\/issues\/([^/]+)\/worklogs(?:\/([^/]+))?$/.exec(path);
    const publication = /^\/api\/documents\/([^/]+)\/publication(\/snapshot)?$/.exec(path);
    const projectResource = /^\/api\/projects\/([^/]+)\/(workload|workload-capacity|issue-order|schedule-analysis)$/.exec(path);
    if (projectResource && (request.method === 'GET' || (request.method === 'PATCH' && ['workload-capacity','issue-order'].includes(projectResource[2])))) {
      if (request.method === 'PATCH' && key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
      this.query(request, projectResource[2] === 'workload' ? ['startDate','endDate'] : []);
      this.allowedProject(key, this.decode(projectResource[1]));
      this.used(key); return next();
    }
    if (request.method === 'GET') {
      const gitlabLinks = /^\/api\/issues\/([^/]+)\/gitlab-links$/.exec(path);
      if (gitlabLinks) {
        this.query(request, ['kind', 'offset']);
        this.resource(key, 'issues', this.decode(gitlabLinks[1]));
        this.used(key); return next();
      }
      if (publication) {
        this.query(request, publication[2] ? ['kind', 'revisionId'] : []);
        this.resource(key, 'documents', this.decode(publication[1]));
        this.used(key); return next();
      }
      if (worklogs && !worklogs[2]) {
        this.query(request, ['offset']);
        this.resource(key, 'issues', this.decode(worklogs[1]));
        this.used(key); return next();
      }
      const worklogReport = /^\/api\/projects\/([^/]+)\/worklog-report$/.exec(path);
      if (worklogReport) {
        this.query(request, ['startDate', 'endDate', 'authorId']);
        this.allowedProject(key, this.decode(worklogReport[1]));
        this.used(key); return next();
      }
      if (path === '/api/users') {
        this.query(request, []); this.used(key);
        response.json(this.store.all<User>('users').map(({ id, name, color }) => ({ id, name, color }))); return;
      }
      if (path === '/api/projects') {
        this.query(request, []); this.used(key);
        response.json(this.store.all<Project>('projects').filter(project => key.projectIds === null || key.projectIds.includes(project.id))); return;
      }
      const workflow = /^\/api\/projects\/([^/]+)\/(workflow|issue-schema)$/.exec(path);
      if (workflow) { this.query(request, []); this.allowedProject(key, this.decode(workflow[1])); this.used(key); return next(); }
      if (['/api/issues', '/api/documents', '/api/planning-items'].includes(path)) {
        const query = this.query(request, path === '/api/planning-items' ? ['projectId', 'kind'] : ['projectId']);
        if (query.projectId) { this.allowedProject(key, query.projectId); if (!this.store.get('projects', query.projectId)) fail(404, '프로젝트를 찾을 수 없습니다.'); }
        if (query.kind && !['cycle', 'module', 'release'].includes(query.kind)) fail(400, '계획 종류를 확인해 주세요.');
        const table = path === '/api/issues' ? 'issues' : path === '/api/documents' ? 'documents' : 'planning_items';
        const values = this.store.all<Issue | DocPage | PlanningItem>(table).filter(record =>
          (key.projectIds === null || (record.projectId !== null && key.projectIds.includes(record.projectId))) &&
          (!query.projectId || record.projectId === query.projectId) &&
          (!query.kind || ('kind' in record && record.kind === query.kind)) &&
          (!('content' in record) || this.canReadDocumentBody(key, record.content)));
        this.used(key); response.json(values); return;
      }
      const detail = /^\/api\/(issues|documents|planning-items)\/([^/]+)$/.exec(path);
      if (detail) {
        this.query(request, []);
        const record = this.resource(key, detail[1] === 'planning-items' ? 'planning_items' : detail[1] as 'issues' | 'documents', this.decode(detail[2]));
        if ('content' in record) this.requireDocumentBody(key, record.content);
        this.used(key); response.json(record); return;
      }
      const revisions = /^\/api\/documents\/([^/]+)\/revisions$/.exec(path);
      if (revisions) {
        this.query(request, []); const id = this.decode(revisions[1]); this.resource(key, 'documents', id);
        this.used(key); response.json(this.store.all<DocRevision>('revisions').filter(revision => revision.documentId === id && this.canReadDocumentBody(key, revision.content)).sort((a, b) => b.version - a.version)); return;
      }
      if (path === '/api/comments') {
        const query = this.query(request, ['resourceType', 'resourceId']);
        if (!['issue', 'document'].includes(query.resourceType) || !query.resourceId) fail(400, '댓글 대상을 확인해 주세요.');
        this.resource(key, query.resourceType === 'issue' ? 'issues' : 'documents', query.resourceId);
        this.used(key); response.json(this.store.all<Comment>('comments').filter(comment => comment.resourceType === query.resourceType && comment.resourceId === query.resourceId)); return;
      }
      return fail(403, '공개 API에서 지원하지 않는 경로입니다.');
    }
    if (key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
    const detail = /^\/api\/(issues|documents)\/([^/]+)$/.exec(path);
    if (request.method === 'POST' && ['/api/issues', '/api/documents'].includes(path)) {
      this.query(request, []);
      const type = path === '/api/issues' ? 'issue' : 'document';
      this.references(key, request, request.body.projectId ?? null, type);
    } else if ((request.method === 'PATCH' || request.method === 'DELETE') && detail) {
      const id = this.decode(detail[2]);
      const source = this.resource(key, detail[1] as 'issues' | 'documents', id);
      if ('content' in source) this.requireDocumentBody(key, source.content);
      const query = this.query(request, request.method === 'DELETE' ? ['expectedVersion'] : []);
      if (request.method === 'DELETE') {
        const fromQuery = query.expectedVersion === undefined ? undefined : /^\d+$/.test(query.expectedVersion) ? Number(query.expectedVersion) : NaN;
        const version = request.body.expectedVersion ?? fromQuery;
        if (!Number.isSafeInteger(version) || version < 1 || (fromQuery !== undefined && fromQuery !== version)) fail(400, '삭제할 대상의 expectedVersion이 필요합니다.');
        request.body.expectedVersion = version;
      } else this.references(key, request, Object.hasOwn(request.body, 'projectId') ? request.body.projectId : source.projectId, detail[1] === 'issues' ? 'issue' : 'document', source as Issue | DocPage);
    } else if (worklogs && (!worklogs[2] && request.method === 'POST' || worklogs[2] && ['PATCH','DELETE'].includes(request.method))) {
      this.query(request, []);
      this.resource(key, 'issues', this.decode(worklogs[1]));
    } else if (publication && !publication[2] && request.method === 'POST') {
      this.query(request, []);
      this.resource(key, 'documents', this.decode(publication[1]));
    } else if (request.method === 'POST' && path === '/api/comments') {
      this.query(request, []);
      if (!['issue', 'document'].includes(request.body.resourceType)) fail(400, '댓글 대상을 확인해 주세요.');
      this.resource(key, request.body.resourceType === 'issue' ? 'issues' : 'documents', request.body.resourceId);
    } else return fail(403, '공개 API에서 지원하지 않는 경로 또는 작업입니다.');
    this.used(key);
    next();
  }

  registerManagementRoutes(app: Express, hooks: Hooks) {
    app.get('/api/api-keys', (request, response) => response.json(this.list(hooks.actor(request))));
    app.post('/api/api-keys', (request, response) => {
      const result = this.store.transaction(() => {
        const created = this.create(hooks.actor(request), request.body);
        hooks.activity(request, 'api-key', created.key.id, 'API 키 발급', created.key.name);
        return created;
      });
      response.status(201).json(result);
    });
    app.post('/api/api-keys/:id/revoke', (request, response) => {
      const result = this.revoke(String(request.params.id), hooks.actor(request), request.body.expectedVersion, record => hooks.activity(request, 'api-key', record.id, 'API 키 폐기', record.name));
      response.json(result);
    });
  }
}
