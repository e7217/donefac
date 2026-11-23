import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { ApiKeyCreated, ApiKeyRecord, Attachment, AttachmentVersion, Comment, Dependency, DocPage, DocRevision, Issue, IssueRelation, PlanningItem, Project, ResourceLink, RichContent, User } from '../shared/types.js';
import { Store } from './store.js';
import { creationRequestId } from './creation-request.js';
import { normalizeDocumentContent } from './document-content.js';
import { listIssueRelations } from './issue-relations.js';
import { DECISION_FOLLOW_UP_QUERY_PARAMETERS, TEAM_DECISION_FOLLOW_UP_QUERY_PARAMETERS } from './decision-follow-ups.js';
import { contentReferences, documentIssueBlocks } from '../shared/document-nodes.js';
import { documentChildLists } from '../shared/document-child-list.js';
import { documentLabelLists } from '../shared/document-label-list.js';
import { documentNodes } from '../shared/document-references.js';

export class ApiKeyError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
const fail = (status: number, message: string): never => { throw new ApiKeyError(status, message); };
const unauthorized = (): never => fail(401, '유효한 Bearer API 키가 필요합니다.');
const metadata = (row: { json: string } | undefined) => row ? JSON.parse(row.json) as ApiKeyRecord : undefined;
type Hooks = { actor: (request: Request) => string; activity: (request: Request, type: string, id: string, action: string, detail?: string) => unknown };
type Context = { id: string; version: number; actorId: string; path: string; projectIds: readonly string[] | null };

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
        this.contexts.set(request, {
          id: record.id, actorId: record.actorId, version: record.version, path: rewritten.split('?')[0], projectIds: record.projectIds,
        });
        request.headers['x-actor-id'] = record.actorId;
        request.url = rewritten;
        next();
      } catch (error) { next(error); }
    });
  }

  projectScope(request: Request): readonly string[] | null {
    return this.contexts.get(request)?.projectIds ?? null;
  }

  private allowedProject(key: ApiKeyRecord, projectId: unknown) {
    if (key.projectIds === null) return;
    if (typeof projectId !== 'string' || !key.projectIds.includes(projectId)) fail(403, '이 API 키에서 허용하지 않은 프로젝트입니다.');
  }
  private canReadDocumentBody(key: ApiKeyRecord, content: RichContent): boolean {
    const projects = key.projectIds;
    if (projects === null) return true;
    const allowsDocument = (id: string) => {
      const target = this.store.get<DocPage>('documents', id);
      return !target || (target.projectId !== null && projects.includes(target.projectId));
    };
    for (const node of documentNodes(content)) {
      if (node.type === 'documentExcerptInclude' && typeof node.attrs?.documentId === 'string' && !allowsDocument(node.attrs.documentId)) return false;
    }
    return (
      documentIssueBlocks(content).every(({ type, projectId }) => type !== 'issueSummary' || projects.includes(projectId)) &&
      documentLabelLists(content).every(({ projectId }) => projectId !== null && projects.includes(projectId)) &&
      documentChildLists(content).every(({ scope, projectId, documentId }) => {
        if (scope === 'space') return projectId !== null && projects.includes(projectId);
        return scope !== 'document' || !documentId || allowsDocument(documentId);
      })
    );
  }
  private requireDocumentBody(key: ApiKeyRecord, content: RichContent) {
    if (!this.canReadDocumentBody(key, content)) fail(403, '문서에 이 API 키의 범위를 벗어난 업무 현황, 문서 목록 또는 발췌가 있습니다.');
  }
  authorizeDocumentBody(request: Request, content: RichContent) {
    const context = this.contexts.get(request);
    if (context) this.requireDocumentBody(this.valid(this.get(context.id)), content);
  }
  authorizeDocumentDecisionResult(request: Request, issue: Issue, link: ResourceLink): void {
    const context = this.contexts.get(request);
    if (!context) return;
    const key = this.valid(this.get(context.id));
    this.resource(key, 'issues', issue.id);
    this.resource(key, 'documents', link.documentId);
    if (link.documentSource) {
      const revision = this.store.get<DocRevision>('revisions', link.documentSource.revisionId);
      if (!revision || revision.documentId !== link.documentId || revision.confluenceSourceVersion !== undefined) {
        return fail(404, '결정 근거의 원문 저장본을 찾을 수 없습니다.');
      }
      this.requireDocumentBody(key, revision.content);
    }
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
  private references(key: ApiKeyRecord, body: Record<string, unknown>, projectId: unknown, type: 'issue' | 'document', previous?: Issue | DocPage) {
    this.allowedProject(key, projectId);
    if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') this.resource(key, type === 'issue' ? 'issues' : 'documents', body.parentId);
    if (type === 'issue') for (const field of ['cycleId', 'moduleId', 'releaseId']) {
      if (body[field] !== undefined && body[field] !== null && body[field] !== '') this.resource(key, 'planning_items', body[field]);
    }
    if (type === 'document' && Object.hasOwn(body, 'content')) {
      const { content } = normalizeDocumentContent(body.content);
      const referenceKey = ({ type, kind, id, revisionId }: ReturnType<typeof contentReferences>[number]) => JSON.stringify([type, kind, id, revisionId]);
      const historical = new Set(previous && 'content' in previous ? contentReferences(previous.content).map(referenceKey) : []);
      for (const reference of contentReferences(content)) {
        const table = reference.type === 'issue' ? 'issues' : 'documents';
        if (!this.store.get(table, reference.id) && historical.has(referenceKey(reference))) continue;
        this.resource(key, table, reference.id);
      }
      for (const { projectId } of documentIssueBlocks(content)) this.allowedProject(key, projectId);
      for (const { projectId } of documentLabelLists(content)) this.allowedProject(key, projectId);
      for (const { scope, projectId } of documentChildLists(content)) {
        if (scope === 'space') this.allowedProject(key, projectId);
      }
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
    const commentEdit = /^\/api\/comments\/([^/]+)(\/edit)?$/.exec(path);
    if (commentEdit && (commentEdit[2] ? request.method === 'GET' : request.method === 'PATCH')) {
      if (key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
      this.query(request, []);
      const comment = this.store.get<Comment>('comments', this.decode(commentEdit[1]));
      if (!comment) return fail(404, '수정할 댓글을 찾을 수 없습니다.');
      this.resource(key, comment.resourceType === 'issue' ? 'issues' : 'documents', comment.resourceId);
      if (comment.resourceType === 'document') {
        let source = comment.documentSource;
        if (comment.parentCommentId) {
          const parent = this.store.get<Comment>('comments', comment.parentCommentId);
          if (parent?.resourceType !== 'document' || parent.resourceId !== comment.resourceId || !parent.documentSource) {
            return fail(404, '원래 문장 댓글을 찾을 수 없습니다.');
          }
          source = parent.documentSource;
        }
        if (source) {
          const revision = this.store.get<DocRevision>('revisions', source.revisionId);
          if (!revision || revision.documentId !== comment.resourceId) return fail(404, '댓글의 원문 저장본을 찾을 수 없습니다.');
          this.requireDocumentBody(key, revision.content);
        }
      }
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
    const projectReports = /^\/api\/projects\/([^/]+)\/(report|report-snapshots(?:\/([^/]+))?)$/.exec(path);
    if (projectReports) {
      this.allowedProject(key, this.decode(projectReports[1]));
      if (request.method === 'GET') {
        this.query(request, projectReports[2] === 'report' ? ['startDate', 'endDate', 'timeZone', 'issueType', 'assigneeId'] : []);
        if (projectReports[3]) this.decode(projectReports[3]);
      } else if (request.method === 'POST' && projectReports[2] === 'report-snapshots') {
        if (key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
        this.query(request, []);
        const input = request.body ?? {};
        if (Object.keys(input).some(name => !['requestId', 'title', 'query', 'actorId'].includes(name))) {
          fail(400, '지원하지 않는 주간 보고서 생성 항목입니다.');
        }
        const { requestId } = input;
        if (typeof requestId !== 'string' || !creationRequestId.test(requestId)) {
          throw new ApiKeyError(400, '주간 보고서 생성 요청 ID를 확인해 주세요.', { reason: 'invalid_request_id' });
        }
      } else return fail(403, '공개 API에서 지원하지 않는 보고서 작업입니다.');
      this.used(key);
      return next();
    }
    const deliveryBlockers = /^\/api\/projects\/([^/]+)\/delivery-blockers$/.exec(path);
    if (request.method === 'GET' && deliveryBlockers) {
      this.query(request, ['savedViewId', 'reason', 'offset', 'revision']);
      this.allowedProject(key, this.decode(deliveryBlockers[1]));
      this.used(key);
      return next();
    }
    if (request.method === 'GET' && path === '/api/decision-follow-ups') {
      this.query(request, [...TEAM_DECISION_FOLLOW_UP_QUERY_PARAMETERS]);
      this.used(key);
      return next();
    }
    const decisionFollowUps = /^\/api\/projects\/([^/]+)\/decision-follow-ups(?:\/([^/]+)\/source)?$/.exec(path);
    if (request.method === 'GET' && decisionFollowUps) {
      this.query(request, decisionFollowUps[2] ? [] : [...DECISION_FOLLOW_UP_QUERY_PARAMETERS]);
      this.allowedProject(key, this.decode(decisionFollowUps[1]));
      if (decisionFollowUps[2]) this.decode(decisionFollowUps[2]);
      this.used(key);
      return next();
    }
    const cycleCompletionRecords = /^\/api\/projects\/([^/]+)\/cycle-completion-records(?:\/([^/]+))?$/.exec(path);
    if (request.method === 'GET' && cycleCompletionRecords) {
      this.query(request, cycleCompletionRecords[2] ? [] : ['cycleId', 'cursor', 'limit']);
      this.allowedProject(key, this.decode(cycleCompletionRecords[1]));
      if (cycleCompletionRecords[2]) this.decode(cycleCompletionRecords[2]);
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
    const issueRelations = /^\/api\/issues\/([^/]+)\/relations(?:\/([^/]+))?$/.exec(path);
    const publication = /^\/api\/documents\/([^/]+)\/publication(\/snapshot|\/comparison)?$/.exec(path);
    const projectResource = /^\/api\/projects\/([^/]+)\/(workload|workload-capacity|issue-order|schedule-analysis|dependencies)$/.exec(path);
    if (projectResource && (request.method === 'GET' || (request.method === 'PATCH' && ['workload-capacity','issue-order'].includes(projectResource[2])))) {
      if (request.method === 'PATCH' && key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
      this.query(request, projectResource[2] === 'workload' ? ['startDate','endDate'] : []);
      this.allowedProject(key, this.decode(projectResource[1]));
      this.used(key); return next();
    }
    const recurringIssues = /^\/api\/projects\/([^/]+)\/recurring-issues(?:\/([^/]+))?$/.exec(path);
    if (recurringIssues) {
      const read = request.method === 'GET' && !recurringIssues[2];
      const write = recurringIssues[2] ? request.method === 'PATCH' : request.method === 'POST';
      if (!read && !write) fail(403, '공개 API에서 지원하지 않는 반복 업무 작업입니다.');
      if (write && key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
      this.query(request, read ? ['includeArchived'] : []);
      this.allowedProject(key, this.decode(recurringIssues[1]));
      if (recurringIssues[2]) this.decode(recurringIssues[2]);
      this.used(key); return next();
    }
    if (request.method === 'GET') {
      if (path === '/api/issue-key-matches') {
        const query = this.query(request, ['key', 'projectId']);
        if (query.projectId !== undefined) this.allowedProject(key, query.projectId);
        this.used(key);
        return next();
      }
      const issueHistory = /^\/api\/issues\/([^/]+)\/change-history$/.exec(path);
      if (issueHistory) {
        this.query(request, ['beforeVersion']);
        this.resource(key, 'issues', this.decode(issueHistory[1]));
        this.used(key); return next();
      }
      const resourceLinks = /^\/api\/(issues|documents)\/([^/]+)\/resource-links$/.exec(path);
      if (resourceLinks) {
        this.query(request, []);
        const table = resourceLinks[1] as 'issues' | 'documents';
        const id = this.decode(resourceLinks[2]);
        this.resource(key, table, id);
        const column = table === 'issues' ? 'issue_id' : 'document_id';
        const rows = this.store.db.prepare(`SELECT l.id, l.issue_id AS issueId, l.document_id AS documentId,
          json_extract(l.json, '$.kind') AS kind, i.project_id AS issueProjectId, d.project_id AS documentProjectId
          FROM resource_links l JOIN issues i ON i.id=l.issue_id JOIN documents d ON d.id=l.document_id
          WHERE l.${column}=? ORDER BY l.id`).all(id) as (Pick<ResourceLink, 'id' | 'issueId' | 'documentId' | 'kind'> & {
            issueProjectId: string; documentProjectId: string | null;
          })[];
        const projects = key.projectIds;
        const links = rows.flatMap(({ id, issueId, documentId, kind, issueProjectId, documentProjectId }) =>
          projects === null || (projects.includes(issueProjectId) && documentProjectId !== null && projects.includes(documentProjectId))
            ? [{ id, issueId, documentId, kind }] : []);
        this.used(key);
        response.set('Cache-Control', 'no-store').json(links);
        return;
      }
      if (issueRelations && !issueRelations[2]) {
        this.query(request, []);
        const id = this.decode(issueRelations[1]);
        this.resource(key, 'issues', id);
        const projects = key.projectIds;
        const relations = listIssueRelations(this.store, id).filter(relation => {
          if (projects === null) return true;
          const otherId = relation.sourceIssueId === id ? relation.targetIssueId : relation.sourceIssueId;
          const other = this.store.get<Issue>('issues', otherId);
          return Boolean(other && projects.includes(other.projectId));
        });
        this.used(key);
        response.set('Cache-Control', 'no-store').json(relations);
        return;
      }
      const gitlabLinks = /^\/api\/issues\/([^/]+)\/gitlab-links$/.exec(path);
      if (gitlabLinks) {
        this.query(request, ['kind', 'offset']);
        this.resource(key, 'issues', this.decode(gitlabLinks[1]));
        this.used(key); return next();
      }
      const gitlabDeployments = /^\/api\/issues\/([^/]+)\/gitlab-deployments$/.exec(path);
      if (gitlabDeployments) {
        this.query(request, ['offset']);
        this.resource(key, 'issues', this.decode(gitlabDeployments[1]));
        this.used(key); return next();
      }
      if (publication) {
        if (publication[2] !== '/comparison') this.query(request, publication[2] ? ['kind', 'revisionId'] : []);
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
      const issueTemplates = /^\/api\/projects\/([^/]+)\/issue-templates$/.exec(path);
      if (issueTemplates) {
        this.query(request, []);
        this.allowedProject(key, this.decode(issueTemplates[1]));
        this.used(key); return next();
      }
      if (['/api/issues', '/api/documents', '/api/planning-items'].includes(path)) {
        const query = this.query(request, path === '/api/planning-items' ? ['projectId', 'kind'] :
          path === '/api/issues' ? ['projectId', 'reporterId'] : ['projectId']);
        if (query.projectId) { this.allowedProject(key, query.projectId); if (!this.store.get('projects', query.projectId)) fail(404, '프로젝트를 찾을 수 없습니다.'); }
        if (query.kind && !['cycle', 'module', 'release'].includes(query.kind)) fail(400, '계획 종류를 확인해 주세요.');
        if (query.reporterId && !this.store.get<User>('users', query.reporterId)) fail(400, '등록된 요청자를 선택해 주세요.');
        const table = path === '/api/issues' ? 'issues' : path === '/api/documents' ? 'documents' : 'planning_items';
        const values = this.store.all<Issue | DocPage | PlanningItem>(table).filter(record =>
          (key.projectIds === null || (record.projectId !== null && key.projectIds.includes(record.projectId))) &&
          (!query.projectId || record.projectId === query.projectId) &&
          (!query.reporterId || 'reporterId' in record && record.reporterId === query.reporterId) &&
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
        const comments = this.store.commentsForResource(query.resourceType as Comment['resourceType'], query.resourceId);
        const byId = new Map(comments.map(comment => [comment.id, comment]));
        const readableRevisions = new Map<string, boolean>();
        const canReadSource = (revisionId: string) => {
          if (!readableRevisions.has(revisionId)) {
            const revision = this.store.get<DocRevision>('revisions', revisionId);
            readableRevisions.set(revisionId, Boolean(revision && revision.documentId === query.resourceId && this.canReadDocumentBody(key, revision.content)));
          }
          return readableRevisions.get(revisionId);
        };
        this.used(key);
        response.set('Cache-Control', 'no-store').json(comments.flatMap(comment => {
          if (comment.parentCommentId !== undefined) {
            const parent = byId.get(comment.parentCommentId);
            return parent && parent.parentCommentId === undefined && parent.documentSource &&
              canReadSource(parent.documentSource.revisionId) ? [comment] : [];
          }
          const { documentSource, ...plainComment } = comment;
          return [!documentSource || canReadSource(documentSource.revisionId) ? comment : plainComment];
        }));
        return;
      }
      return fail(403, '공개 API에서 지원하지 않는 경로입니다.');
    }
    if (key.access !== 'write') fail(403, '이 API 키는 읽기 전용입니다.');
    const detail = /^\/api\/(issues|documents)\/([^/]+)$/.exec(path);
    const issueClone = /^\/api\/issues\/([^/]+)\/clone$/.exec(path);
    const documentDecision = /^\/api\/documents\/([^/]+)\/(follow-up-issues|decision-links)$/.exec(path);
    const closeAsDuplicate = /^\/api\/issues\/([^/]+)\/close-as-duplicate$/.exec(path);
    const cycleCompletion = /^\/api\/planning-items\/([^/]+)\/complete(\/preview)?$/.exec(path);
    const resourceLink = /^\/api\/resource-links\/([^/]+)$/.exec(path);
    const dependency = /^\/api\/dependencies\/([^/]+)$/.exec(path);
    const relationDependency = /^\/api\/issues\/([^/]+)\/relations\/([^/]+)\/schedule-dependency$/.exec(path);
    if (request.method === 'POST' && ['/api/issues', '/api/documents'].includes(path)) {
      this.query(request, []);
      const type = path === '/api/issues' ? 'issue' : 'document';
      this.references(key, request.body, request.body.projectId ?? null, type);
    } else if (request.method === 'POST' && documentDecision) {
      this.query(request, []);
      const document = this.resource(key, 'documents', this.decode(documentDecision[1]));
      if (documentDecision[2] === 'decision-links') {
        this.resource(key, 'issues', request.body?.issueId);
      } else {
        const issue = request.body?.issue;
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) fail(400, '생성할 업무 정보를 확인해 주세요.');
        this.references(key, issue, Object.hasOwn(issue, 'projectId') ? issue.projectId : document.projectId, 'issue');
      }
    } else if (request.method === 'POST' && issueClone) {
      this.query(request, []);
      const source = this.store.get<Issue>('issues', this.decode(issueClone[1]));
      if (!source) throw new ApiKeyError(404, '원본 업무를 찾을 수 없습니다.', { reason: 'source_missing' });
      this.allowedProject(key, source.projectId);
      const issue = request.body.issue;
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)) fail(400, '복제할 업무 정보를 확인해 주세요.');
      this.references(key, issue, Object.hasOwn(issue, 'projectId') ? issue.projectId : source.projectId, 'issue');
    } else if (request.method === 'POST' && closeAsDuplicate) {
      this.query(request, []);
      this.resource(key, 'issues', this.decode(closeAsDuplicate[1]));
      this.resource(key, 'issues', request.body?.originalIssueId);
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
      } else this.references(key, request.body, Object.hasOwn(request.body, 'projectId') ? request.body.projectId : source.projectId, detail[1] === 'issues' ? 'issue' : 'document', source as Issue | DocPage);
    } else if (request.method === 'POST' && cycleCompletion) {
      this.query(request, []);
      this.resource(key, 'planning_items', this.decode(cycleCompletion[1]));
      const destination = request.body?.destinationId;
      if (cycleCompletion[2] && typeof destination === 'string' && destination) this.resource(key, 'planning_items', destination);
    } else if (request.method === 'POST' && path === '/api/resource-links') {
      this.query(request, []);
      this.resource(key, 'issues', request.body?.issueId);
      this.resource(key, 'documents', request.body?.documentId);
    } else if (request.method === 'DELETE' && resourceLink) {
      this.query(request, []);
      const link = this.store.get<ResourceLink>('resource_links', this.decode(resourceLink[1]));
      if (!link) return fail(404, '업무와 문서의 연결을 찾을 수 없습니다.');
      this.resource(key, 'issues', link.issueId);
      this.resource(key, 'documents', link.documentId);
      if (link.documentSource !== undefined) fail(409, '결정 근거가 연결된 항목은 자동화 API에서 삭제할 수 없습니다.');
    } else if (request.method === 'POST' && (path === '/api/dependencies' || relationDependency)) {
      this.query(request, []);
      if (relationDependency) {
        const issueId = this.decode(relationDependency[1]);
        this.resource(key, 'issues', issueId);
        const relation = this.store.get<IssueRelation>('issue_relations', this.decode(relationDependency[2]));
        if (!relation || (relation.sourceIssueId !== issueId && relation.targetIssueId !== issueId)) return fail(404, '업무 관계를 찾을 수 없습니다.');
        this.resource(key, 'issues', relation.sourceIssueId === issueId ? relation.targetIssueId : relation.sourceIssueId);
      }
      this.resource(key, 'issues', request.body?.predecessorId);
      this.resource(key, 'issues', request.body?.successorId);
    } else if (dependency && ['PATCH', 'DELETE'].includes(request.method)) {
      const query = this.query(request, request.method === 'DELETE' ? ['expectedVersion'] : []);
      const existing = this.store.get<Dependency>('dependencies', this.decode(dependency[1]));
      if (!existing) return fail(404, '일정 연결을 찾을 수 없습니다.');
      this.resource(key, 'issues', existing.predecessorId);
      this.resource(key, 'issues', existing.successorId);
      if (request.method === 'DELETE') {
        const version = /^\d+$/.test(query.expectedVersion ?? '') ? Number(query.expectedVersion) : NaN;
        if (!Number.isSafeInteger(version) || version < 1 || Object.hasOwn(request.body ?? {}, 'expectedVersion')) {
          fail(400, '일정 연결을 삭제하려면 쿼리의 expectedVersion이 필요합니다.');
        }
      }
    } else if (issueRelations && (!issueRelations[2] && request.method === 'POST' || issueRelations[2] && ['PATCH','DELETE'].includes(request.method))) {
      this.query(request, request.method === 'DELETE' ? ['expectedVersion'] : []);
      const id = this.decode(issueRelations[1]);
      this.resource(key, 'issues', id);
      if (!issueRelations[2]) this.resource(key, 'issues', request.body?.otherIssueId);
      else {
        const relation = this.store.get<IssueRelation>('issue_relations', this.decode(issueRelations[2]));
        if (!relation || (relation.sourceIssueId !== id && relation.targetIssueId !== id)) return fail(404, '업무 관계를 찾을 수 없습니다.');
        this.resource(key, 'issues', relation.sourceIssueId === id ? relation.targetIssueId : relation.sourceIssueId);
      }
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
