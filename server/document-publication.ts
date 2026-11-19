import { randomUUID } from 'node:crypto';
import type { DocPage, DocRevision, DocumentPublicationState, DocumentPublicationView, DocumentPublishedVersion, DocumentReview, User } from '../shared/types.js';
import type { Store } from './store.js';

export class DocumentPublicationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new DocumentPublicationError(status, message); }
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `${label}을(를) 확인해 주세요.`);
  return value;
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, '문서 검토·발행 데이터 형식이 올바르지 않습니다.');
  return value as Record<string, unknown>;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(400, `${label}은 밀리초를 포함하는 UTC ISO 시각이어야 합니다.`);
  return value;
}
function note(value: unknown, required = false): string {
  if (typeof value !== 'string' || value.length > 2000 || required && !value.trim()) fail(400, required ? '수정 요청 내용을 1~2,000자로 입력해 주세요.' : '검토 메모는 2,000자 이하여야 합니다.');
  return value;
}
function version(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) >= Number.MAX_SAFE_INTEGER) fail(400, '문서 검토·발행 버전을 확인해 주세요.');
  return Number(value);
}
type RevisionSummary = Pick<DocRevision, 'id' | 'version' | 'title'>;

/** Publication owns pointers to immutable revisions. It never rewrites the
 * working document, the collaboration room, or the document's status field. */
export class DocumentPublicationService {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS document_publications(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_document ON revisions(document_id);
    `);
  }
  private documentVersion(documentId: string): number {
    id(documentId, '문서 ID');
    const row = this.store.db.prepare("SELECT json_extract(json,'$.version') AS version FROM documents WHERE id=?").get(documentId) as { version: number } | undefined;
    if (!row) fail(404, '문서를 찾을 수 없습니다.');
    return version(row.version, 1);
  }
  private state(documentId: string): DocumentPublicationState {
    const row = this.store.db.prepare('SELECT json FROM document_publications WHERE document_id=?').get(documentId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as DocumentPublicationState : { documentId, version: 0, review: null, published: null };
  }
  private generation(): string | null {
    const value: unknown = this.store.setting('attachmentImportGeneration');
    if (value !== null && typeof value !== 'string') fail(409, '워크스페이스 복원 상태를 확인해 주세요.');
    return value;
  }
  private summary(documentId: string, revisionId: string | undefined): RevisionSummary | null {
    if (!revisionId) return null;
    const value = this.store.db.prepare("SELECT id,json_extract(json,'$.version') AS version,json_extract(json,'$.title') AS title FROM revisions WHERE id=? AND document_id=?").get(revisionId, documentId) as RevisionSummary | undefined;
    if (!value) fail(409, '검토·발행 저장본을 찾을 수 없습니다. 최신 상태를 불러와 주세요.');
    return { id: value.id, version: value.version, title: value.title };
  }
  private put(state: DocumentPublicationState): void {
    this.store.db.prepare('INSERT INTO document_publications(document_id,json) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET json=excluded.json').run(state.documentId, JSON.stringify(state));
  }
  private actor(actorId: string): User {
    id(actorId, '작업자 ID');
    return this.store.get<User>('users', actorId) ?? fail(400, '등록된 작업자를 선택해 주세요.');
  }
  private audit(documentId: string, actorId: string, action: string, detail: string, at: string): void {
    this.store.put('activities', { id: randomUUID(), resourceType: 'document', resourceId: documentId, actorId, action, detail, createdAt: at });
  }
  private capture(document: DocPage, actorId: string, at: string): DocRevision {
    const existing = this.store.db.prepare(`
      SELECT json FROM revisions WHERE document_id=? AND json_extract(json,'$.version')=?
        AND json_extract(json,'$.title')=? AND json_extract(json,'$.content')=?
        AND json_extract(json,'$.plainText')=? ORDER BY id LIMIT 1
    `).get(document.id, document.version, document.title, JSON.stringify(document.content), document.plainText) as { json: string } | undefined;
    if (existing) return JSON.parse(existing.json) as DocRevision;
    const revision: DocRevision = {
      id: randomUUID(), documentId: document.id, version: document.version, title: document.title,
      content: document.content, plainText: document.plainText, authorId: actorId, createdAt: at, summary: '검토 요청 저장본',
    };
    this.store.put('revisions', revision);
    return revision;
  }
  get(documentId: string): DocumentPublicationView {
    const documentVersion = this.documentVersion(documentId), state = this.state(documentId);
    return { ...state, workspaceGeneration: this.generation(), documentVersion, reviewRevision: this.summary(documentId, state.review?.revisionId), publishedRevision: this.summary(documentId, state.published?.revisionId) };
  }
  snapshot(documentId: string, kind: 'review' | 'published', revisionId: string): DocRevision {
    this.documentVersion(documentId); id(revisionId, '저장본 ID');
    if (kind !== 'review' && kind !== 'published') fail(400, '검토 또는 발행 저장본을 선택해 주세요.');
    const pointer = this.state(documentId)[kind];
    if (!pointer) fail(404, '선택한 검토·발행 저장본이 없습니다.');
    if (pointer.revisionId !== revisionId) fail(409, '검토·발행 저장본이 변경되었습니다. 최신 상태를 불러와 주세요.');
    const path = kind === 'review' ? '$.review.revisionId' : '$.published.revisionId';
    const row = this.store.db.prepare(`
      SELECT r.json FROM document_publications p JOIN revisions r ON r.document_id=p.document_id
      WHERE p.document_id=? AND r.id=? AND json_extract(p.json,?)=r.id
    `).get(documentId, revisionId, path) as { json: string } | undefined;
    if (!row) fail(409, '검토·발행 저장본이 변경되었거나 삭제되었습니다.');
    return JSON.parse(row.json) as DocRevision;
  }
  transition(documentId: string, actorId: string, body: Record<string, unknown>): DocumentPublicationView {
    return this.store.transaction(() => {
      const documentVersion = this.documentVersion(documentId), current = this.state(documentId);
      this.actor(actorId);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '문서 검토 작업을 확인해 주세요.');
      const expectedVersion = version(body.expectedVersion);
      if (!Object.hasOwn(body, 'workspaceGeneration') || body.workspaceGeneration !== null && (typeof body.workspaceGeneration !== 'string' || !body.workspaceGeneration || body.workspaceGeneration.length > 200)) fail(400, '검토한 워크스페이스 복원 세대가 필요합니다.');
      if (body.workspaceGeneration !== this.generation()) fail(409, '워크스페이스가 복원되었습니다. 문서를 다시 불러와 주세요.');
      if (expectedVersion !== current.version) fail(409, '다른 작업자가 문서 검토 상태를 변경했습니다. 최신 상태를 불러와 주세요.');
      if (current.version >= Number.MAX_SAFE_INTEGER - 1) fail(409, '문서 검토 버전 범위를 초과했습니다.');
      const at = new Date().toISOString(), next = { ...current, version: current.version + 1 };
      if ([current.review?.requestedAt, current.review?.changesRequested?.at, current.published?.publishedAt].some(value => value && value > at)) fail(409, '현재 시각이 이전 검토·발행보다 이전입니다. 문서 상태와 서버 시각을 확인해 주세요.');
      if (body.action === 'request') {
        if (current.review && !current.review.changesRequested) fail(409, '진행 중인 검토 요청을 먼저 처리하거나 철회해 주세요.');
        if (version(body.expectedDocumentVersion, 1) !== documentVersion) fail(409, '검토 요청 전에 문서가 변경되었습니다. 저장된 최신 문서를 다시 확인해 주세요.');
        const reviewerId = id(body.reviewerId, '검토자 ID'), reviewer = this.actor(reviewerId);
        if (reviewerId === actorId) fail(400, '요청자와 다른 검토자를 선택해 주세요.');
        const requestNote = note(body.note ?? '').trim();
        const publishedRevision = this.summary(documentId, current.published?.revisionId);
        if (publishedRevision && publishedRevision.version >= documentVersion) fail(409, '이미 발행한 문서 버전입니다. 변경한 초안을 저장한 뒤 검토를 요청해 주세요.');
        const document = this.store.get<DocPage>('documents', documentId)!;
        const revision = this.capture(document, actorId, at);
        if (revision.id === current.published?.revisionId) fail(409, '이미 발행한 저장본입니다. 변경한 초안을 저장한 뒤 검토를 요청해 주세요.');
        if (!Number.isFinite(Date.parse(revision.createdAt)) || Date.parse(revision.createdAt) > Date.parse(at)) fail(409, '저장본 시각이 현재보다 미래입니다. 문서 이력을 확인해 주세요.');
        next.review = { revisionId: revision.id, requestedById: actorId, reviewerId, requestedAt: at, note: requestNote, changesRequested: null };
        this.audit(documentId, actorId, '문서 검토 요청', `${revision.title} · 저장본 v${revision.version} · 검토자 ${reviewer.name}${requestNote ? ` · ${requestNote}` : ''}`, at);
      } else if (body.action === 'publish' || body.action === 'request_changes') {
        const review = current.review;
        if (!review || review.changesRequested) fail(409, '처리할 검토 요청이 없습니다.');
        if (review.reviewerId !== actorId) fail(403, '지정된 검토자만 발행하거나 수정을 요청할 수 있습니다.');
        const revision = this.snapshot(documentId, 'review', review.revisionId);
        if (at < review.requestedAt) fail(409, '검토 요청보다 현재 시각이 이전입니다. 잠시 후 다시 시도해 주세요.');
        if (body.action === 'publish') {
          const publicationNote = note(body.note ?? '').trim();
          next.published = { revisionId: review.revisionId, publishedById: actorId, publishedAt: at, note: publicationNote, requestedById: review.requestedById, reviewerId: review.reviewerId, requestedAt: review.requestedAt };
          next.review = null;
          this.audit(documentId, actorId, '문서 발행', `${revision.title} · 검토한 저장본 v${revision.version}${publicationNote ? ` · ${publicationNote}` : ''}`, at);
        } else {
          const feedback = note(body.note, true).trim();
          next.review = { ...review, changesRequested: { byId: actorId, at, note: feedback } };
          this.audit(documentId, actorId, '문서 수정 요청', `${revision.title} · 저장본 v${revision.version} · ${feedback}`, at);
        }
      } else if (body.action === 'withdraw') {
        const review = current.review;
        if (!review) fail(409, '철회할 검토 요청이 없습니다.');
        if (review.requestedById !== actorId) fail(403, '검토 요청자만 요청을 철회할 수 있습니다.');
        next.review = null;
        this.audit(documentId, actorId, '문서 검토 철회', `저장본 ${review.revisionId}${review.note ? ` · ${review.note}` : ''}`, at);
      } else fail(400, '지원하지 않는 문서 검토 작업입니다.');
      this.put(next);
      return this.get(documentId);
    });
  }
  all(): DocumentPublicationState[] {
    return (this.store.db.prepare('SELECT json FROM document_publications ORDER BY document_id').all() as { json: string }[]).map(row => JSON.parse(row.json) as DocumentPublicationState);
  }
  validateRestore(value: unknown, documents: DocPage[], users: User[], revisions: DocRevision[], exportedAt: unknown): DocumentPublicationState[] {
    if (!Array.isArray(value) || value.length > 100000) fail(400, '백업의 문서 검토·발행 목록이 필요합니다.');
    if (!value.length) return [];
    const through = timestamp(exportedAt, '백업 내보내기 시각'), documentMap = new Map(documents.map(document => [document.id, document])), userIds = new Set(users.map(user => user.id));
    const revisionMap = new Map<string, DocRevision>(), seen = new Set<string>(), usedRevisions = new Set<string>();
    for (const revision of revisions) {
      if (revisionMap.has(revision.id)) fail(400, '문서 저장본 ID가 중복되었습니다.');
      revisionMap.set(revision.id, revision);
    }
    const user = (value: unknown): string => { const result = id(value, '검토 작업자 ID'); if (!userIds.has(result)) fail(400, '문서 검토·발행 작업자가 팀원 목록에 없습니다.'); return result; };
    const moment = (value: unknown, label: string): string => { const result = timestamp(value, label); if (result > through) fail(400, '문서 검토 시각이 백업 내보내기 이후입니다.'); return result; };
    const reference = (value: unknown, documentId: string, requestedAt: string): string => {
      const result = id(value, '문서 저장본 ID'), revision = revisionMap.get(result);
      if (!revision || revision.documentId !== documentId || usedRevisions.has(result) || !Number.isSafeInteger(revision.version) || revision.version < 1 || revision.version > documentMap.get(documentId)!.version || typeof revision.title !== 'string' || !revision.title.trim() || revision.title.length > 300 || !userIds.has(revision.authorId) || !Number.isFinite(Date.parse(revision.createdAt)) || Date.parse(revision.createdAt) > Date.parse(requestedAt)) fail(400, '문서 검토 저장본이 중복되거나 문서 버전·제목·작성자·시각이 올바르지 않습니다.');
      usedRevisions.add(result); return result;
    };
    return value.map(raw => {
      const state = object(raw, ['documentId', 'version', 'review', 'published']), documentId = id(state.documentId, '문서 ID');
      if (!documentMap.has(documentId) || seen.has(documentId)) fail(400, '문서 검토·발행의 문서가 없거나 중복되었습니다.');
      seen.add(documentId);
      let review: DocumentReview | null = null, published: DocumentPublishedVersion | null = null;
      if (state.review !== null) {
        const source = object(state.review, ['revisionId', 'requestedById', 'reviewerId', 'requestedAt', 'note', 'changesRequested']);
        const requestedById = user(source.requestedById), reviewerId = user(source.reviewerId), requestedAt = moment(source.requestedAt, '검토 요청 시각');
        if (requestedById === reviewerId) fail(400, '검토 요청자와 검토자가 같을 수 없습니다.');
        const revisionId = reference(source.revisionId, documentId, requestedAt);
        review = { revisionId, requestedById, reviewerId, requestedAt, note: note(source.note), changesRequested: null };
        if (source.changesRequested !== null) {
          const changes = object(source.changesRequested, ['byId', 'at', 'note']), byId = user(changes.byId), at = moment(changes.at, '수정 요청 시각');
          if (byId !== reviewerId || at < requestedAt) fail(400, '수정 요청의 검토자 또는 시각이 올바르지 않습니다.');
          review.changesRequested = { byId, at, note: note(changes.note, true) };
        }
      }
      if (state.published !== null) {
        const source = object(state.published, ['revisionId', 'publishedById', 'publishedAt', 'note', 'requestedById', 'reviewerId', 'requestedAt']);
        const requestedById = user(source.requestedById), reviewerId = user(source.reviewerId), publishedById = user(source.publishedById), requestedAt = moment(source.requestedAt, '발행본 검토 요청 시각'), publishedAt = moment(source.publishedAt, '발행 시각');
        if (requestedById === reviewerId || publishedById !== reviewerId || publishedAt < requestedAt || review && review.requestedAt < publishedAt) fail(400, '발행본의 검토자·발행자 또는 시각 순서가 올바르지 않습니다.');
        published = { revisionId: reference(source.revisionId, documentId, requestedAt), publishedById, publishedAt, note: note(source.note), requestedById, reviewerId, requestedAt };
        if (review && revisionMap.get(review.revisionId)!.version <= revisionMap.get(published.revisionId)!.version) fail(400, '진행 중인 검토본은 이전 발행본보다 새로운 문서 버전이어야 합니다.');
      }
      return { documentId, version: version(state.version, 1), review, published };
    });
  }
  /** Called after canonical documents/revisions have been restored, in their transaction. */
  replaceRestored(states: DocumentPublicationState[]): void {
    this.store.db.exec('DELETE FROM document_publications');
    for (const state of states) this.put(state);
  }
}
