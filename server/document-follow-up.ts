import { createHash, randomUUID } from 'node:crypto';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isDocumentSectionId } from '../shared/document-sections.js';
import { DOCUMENT_SELECTION_TEXT_LIMIT, documentChecklistItemSelection } from '../shared/document-selection.js';
import { createEditorSchema } from '../shared/editor-schema.js';
import type {
  Comment, DocPage, DocRevision, DocumentChecklistWork, DocumentDecisionSource, DocumentFollowUpCommentSource, DocumentFollowUpResult, DocumentIssueLinkResult,
  DocumentSourceSelection, Issue, ResourceLink, RichContent,
} from '../shared/types.js';
import { readDocumentChecklistItem, readDocumentSelection } from './document-content.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type IssueInput = Record<string, unknown>;
type RequestInput = { documentId: string; actorId: string; body: unknown };
type ResultAuthorization = { authorizeResult(issue: Issue, link: ResourceLink): void };
type CreationHooks = ResultAuthorization & {
  create(documentId: string, expectedVersion: number, issueInput: IssueInput, selection?: DocumentSourceSelection,
    sourceComment?: DocumentFollowUpCommentSource): Pick<DocumentFollowUpResult, 'issue' | 'link'>;
};
type DecisionLinkHooks = ResultAuthorization & {
  checkVersion(document: DocPage, expectedVersion: number): void;
  authorizeSource(content: DocPage['content']): void;
  onLinked(issue: Issue, document: DocPage): void;
};
type Receipt = { documentId: string; actorId: string; fingerprint: string; issueId: string; linkId: string };
type DecisionLinkReceipt = Receipt & { revisionId: string };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type FollowUpErrorReason = 'source_selection_changed' | 'decision_source_exists' | 'comment_source_unavailable' | 'workspace_restored';

export class DocumentFollowUpError extends Error {
  constructor(public status: number, message: string, public details?: { reason: FollowUpErrorReason } | { currentVersion: number }) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSelection(value: Record<string, unknown>): value is Record<string, unknown> & DocumentSourceSelection {
  const { from, to, text } = value;
  return typeof from === 'number' && Number.isSafeInteger(from) && from >= 0
    && typeof to === 'number' && Number.isSafeInteger(to) && to > from
    && typeof text === 'string' && text.length <= DOCUMENT_SELECTION_TEXT_LIMIT && Boolean(text.trim()) && text.isWellFormed();
}

export function parseDocumentSourceSelection(input: unknown): DocumentSourceSelection | undefined {
  if (!record(input) || Object.keys(input).length !== 3 || !validSelection(input)) return;
  const { from, to, text } = input;
  return { from, to, text };
}

function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseSourceComment(source: unknown): DocumentFollowUpCommentSource | undefined {
  if (!record(source) || Object.keys(source).length !== 2 || !isSourceId(source.commentId) || !isSourceId(source.revisionId)) return;
  return { commentId: source.commentId, revisionId: source.revisionId };
}

function parse(body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !['requestId', 'expectedDocumentVersion', 'issue', 'actorId', 'sourceSelection', 'sourceComment'].includes(key))) {
    throw new DocumentFollowUpError(400, '후속 업무 요청을 확인해 주세요.');
  }
  const { requestId, expectedDocumentVersion, issue } = body;
  if (typeof requestId !== 'string' || !uuid.test(requestId)) {
    throw new DocumentFollowUpError(400, '후속 업무 요청 ID를 확인해 주세요.');
  }
  if (typeof expectedDocumentVersion !== 'number' || !Number.isSafeInteger(expectedDocumentVersion) || expectedDocumentVersion < 1) {
    throw new DocumentFollowUpError(400, '연결할 문서의 버전을 확인해 주세요.');
  }
  if (!record(issue)) throw new DocumentFollowUpError(400, '생성할 업무 정보를 확인해 주세요.');
  let selection: DocumentSourceSelection | undefined;
  if (Object.hasOwn(body, 'sourceSelection')) {
    selection = parseDocumentSourceSelection(body.sourceSelection);
    if (!selection) {
      throw new DocumentFollowUpError(400, '후속 업무에 남길 문서의 선택 범위를 확인해 주세요.');
    }
  }
  let sourceComment: DocumentFollowUpCommentSource | undefined;
  if (Object.hasOwn(body, 'sourceComment')) {
    sourceComment = parseSourceComment(body.sourceComment);
    if (selection || !sourceComment) {
      throw new DocumentFollowUpError(400, '후속 업무에 남길 문장 댓글을 확인해 주세요.');
    }
  }
  return { requestId: requestId.toLowerCase(), expectedDocumentVersion, issue, selection, sourceComment };
}

function parseDecisionLink(body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !['requestId', 'expectedDocumentVersion', 'expectedRestoreGeneration', 'issueId', 'actorId', 'sourceSelection', 'sourceComment'].includes(key))) {
    throw new DocumentFollowUpError(400, '결정 근거 연결 요청을 확인해 주세요.');
  }
  const { requestId, expectedDocumentVersion, expectedRestoreGeneration, issueId } = body;
  if (typeof requestId !== 'string' || !uuid.test(requestId)) {
    throw new DocumentFollowUpError(400, '결정 근거 연결 요청 ID를 확인해 주세요.');
  }
  if (typeof expectedDocumentVersion !== 'number' || !Number.isSafeInteger(expectedDocumentVersion) || expectedDocumentVersion < 1) {
    throw new DocumentFollowUpError(400, '연결할 문서의 버전을 확인해 주세요.');
  }
  if (expectedRestoreGeneration !== undefined && !isSourceId(expectedRestoreGeneration)) {
    throw new DocumentFollowUpError(400, '결정 근거를 연결할 워크스페이스 세대를 확인해 주세요.');
  }
  if (typeof issueId !== 'string' || !issueId.length) throw new DocumentFollowUpError(400, '연결할 업무를 확인해 주세요.');
  const request = { requestId: requestId.toLowerCase(), expectedDocumentVersion, expectedRestoreGeneration, issueId };
  if (Object.hasOwn(body, 'sourceComment')) {
    const sourceComment = parseSourceComment(body.sourceComment);
    if (Object.hasOwn(body, 'sourceSelection') || !sourceComment) {
      throw new DocumentFollowUpError(400, '결정 근거로 남길 문장 댓글을 확인해 주세요.');
    }
    return { ...request, sourceComment, selection: undefined };
  }
  const selection = parseDocumentSourceSelection(body.sourceSelection);
  if (!selection) throw new DocumentFollowUpError(400, '결정 근거로 남길 문서의 선택 범위를 확인해 주세요.');
  return { ...request, selection, sourceComment: undefined };
}

function sameSelection(a: DocumentSourceSelection, b: DocumentSourceSelection): boolean {
  return a.from === b.from && a.to === b.to && a.text === b.text;
}

function matchesCurrentSelection(store: Store, document: DocPage, pinned: DocumentDecisionSource, selection: DocumentSourceSelection): boolean {
  const revision = store.get<DocRevision>('revisions', pinned.revisionId);
  return sameSelection(pinned, selection) && Boolean(revision && revision.documentId === document.id &&
    revision.confluenceSourceVersion === undefined && revision.version === document.version && revision.title === document.title &&
    JSON.stringify(revision.content) === JSON.stringify(document.content) &&
    readDocumentSelection(document.content, selection.from, selection.to) === selection.text);
}

type ChecklistItem = { selection: DocumentSourceSelection | null; id?: string; ambiguous: boolean; index: number };
type ChecklistSnapshot = {
  topology: string[];
  items: ChecklistItem[];
  byPosition: Map<number, ChecklistItem>;
  byId: Map<string, ChecklistItem | null>;
};
type SavedChecklistBody = { title: string; content: string };
type SavedChecklistSnapshot = SavedChecklistBody & { snapshot: ChecklistSnapshot };
const checklistSchema = createEditorSchema();
const MAX_CHECKLIST_HISTORY_STEPS = 32;
const MAX_CHECKLIST_HISTORY_BYTES = 32 * 1024 * 1024;

function checklistSnapshot(content: RichContent): ChecklistSnapshot | null {
  try {
    const document = checklistSchema.nodeFromJSON(content);
    if (document.type !== checklistSchema.topNodeType) return null;
    const result: ChecklistSnapshot = { topology: [], items: [], byPosition: new Map(), byId: new Map() };
    const hashes = new WeakMap<ProseMirrorNode, string>();
    const roots: { key: string; from: number; to: number }[] = [];
    function fingerprint(node: ProseMirrorNode): string {
      const previous = hashes.get(node);
      if (previous) return previous;
      const children: string[] = [];
      node.forEach(child => { children.push(fingerprint(child)); });
      const attributes = node.type.name === 'taskItem'
        ? Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== 'checked' && key !== 'checklistItemId'))
        : node.attrs;
      const hash = createHash('sha256').update(JSON.stringify([node.type.name, attributes, node.text, node.marks.map(mark => mark.toJSON()), children])).digest('hex');
      hashes.set(node, hash);
      return hash;
    }
    function visit(node: ProseMirrorNode, position: number, insideList: boolean, ambiguous: boolean) {
      if (node.type.name === 'taskItem') {
        const { checklistItemId } = node.attrs;
        const id = isDocumentSectionId(checklistItemId) ? checklistItemId : undefined;
        const selection = documentChecklistItemSelection(document, node, position);
        const item: ChecklistItem = { selection, id, ambiguous, index: result.items.length };
        result.items.push(item);
        if (selection) result.byPosition.set(selection.from, item);
        if (id) result.byId.set(id, result.byId.has(id) ? null : item);
      }
      if (node.type.name === 'taskList') {
        const from = result.items.length;
        const rootKey = !insideList ? fingerprint(node) : undefined;
        if (rootKey) result.topology.push(rootKey);
        const counts = new Map<string, number>();
        node.forEach(child => { const key = fingerprint(child); counts.set(key, (counts.get(key) ?? 0) + 1); });
        node.forEach((child, offset) => visit(child, position + 1 + offset, true, ambiguous || (counts.get(fingerprint(child)) ?? 0) > 1));
        if (rootKey) roots.push({ key: rootKey, from, to: result.items.length });
      } else {
        node.forEach((child, offset) => visit(child, position + 1 + offset, insideList, ambiguous));
      }
    }
    visit(document, -1, false, false);
    const rootCounts = new Map<string, number>();
    for (const { key } of roots) rootCounts.set(key, (rootCounts.get(key) ?? 0) + 1);
    for (const { key, from, to } of roots) {
      if ((rootCounts.get(key) ?? 0) > 1) for (let index = from; index < to; index++) result.items[index].ambiguous = true;
    }
    return result;
  } catch { return null; }
}

function checklistWork(store: Store, documentId: string, expectedVersion: number): DocumentChecklistWork {
  const row = store.db.prepare(`SELECT d.json AS document, CASE WHEN json_extract(d.json,'$.version')=? THEN (
    SELECT json_group_array(json_object('linkId',l.id,'issueId',l.issue_id,'source',json_extract(l.json,'$.documentSource'),
      'version',json_extract(r.json,'$.version'), 'sameSnapshot', CASE WHEN json_extract(r.json,'$.version')=json_extract(d.json,'$.version') THEN
      json_extract(r.json,'$.title')=json_extract(d.json,'$.title') AND json_extract(r.json,'$.content')=json_extract(d.json,'$.content') END))
    FROM resource_links l JOIN issues i ON i.id=l.issue_id
    JOIN revisions r ON r.id=json_extract(l.json,'$.documentSource.revisionId') AND r.document_id=d.id
    WHERE l.document_id=d.id AND json_extract(r.json,'$.documentId')=d.id AND json_extract(r.json,'$.id')=r.id
      AND json_type(r.json,'$.version')='integer' AND json_type(r.json,'$.confluenceSourceVersion') IS NULL
  ) END AS candidates FROM documents d WHERE d.id=?`).get(expectedVersion, documentId) as
    { document: string; candidates: string | null } | undefined;
  if (!row) throw new DocumentFollowUpError(404, '문서를 찾을 수 없습니다.');
  const document = JSON.parse(row.document) as DocPage;
  if (document.version !== expectedVersion) {
    throw new DocumentFollowUpError(409, '다른 작업자가 변경했습니다. 새로고침 후 다시 시도해 주세요.', { currentVersion: document.version });
  }

  const items = new Map<number, DocumentSourceSelection | null>();
  const history = new Map<number, SavedChecklistSnapshot | null>();
  const pins = new Map<string, SavedChecklistSnapshot | null>();
  let remainingBytes = MAX_CHECKLIST_HISTORY_BYTES;
  let current: ChecklistSnapshot | null | undefined;
  let currentContent: string | undefined;
  const currentSnapshot = () => current === undefined ? (current = checklistSnapshot(document.content)) : current;
  const pinById = store.db.prepare(`SELECT json_extract(json,'$.title') AS title, json_extract(json,'$.content') AS content
    FROM revisions WHERE id=? AND length(CAST(json AS BLOB))<=?`);
  const byVersion = store.db.prepare(`SELECT DISTINCT json_extract(json,'$.title') AS title, json_extract(json,'$.content') AS content
    FROM revisions WHERE document_id=? AND json_extract(json,'$.documentId')=? AND json_extract(json,'$.id')=id
    AND json_extract(json,'$.version')=? AND json_type(json,'$.confluenceSourceVersion') IS NULL LIMIT 2`);

  function savedSnapshot(row: SavedChecklistBody | undefined): SavedChecklistSnapshot | null {
    if (!row || typeof row.title !== 'string' || typeof row.content !== 'string') return null;
    const bytes = Buffer.byteLength(row.content);
    if (bytes > remainingBytes) return null;
    remainingBytes -= bytes;
    try {
      const snapshot = checklistSnapshot(JSON.parse(row.content) as RichContent);
      return snapshot ? { ...row, snapshot } : null;
    } catch { return null; }
  }

  function pin(revisionId: string) {
    if (!pins.has(revisionId)) {
      const row = pinById.get(revisionId, remainingBytes) as SavedChecklistBody | undefined;
      pins.set(revisionId, savedSnapshot(row));
    }
    return pins.get(revisionId);
  }

  function saved(version: number) {
    if (!history.has(version)) {
      const rows = byVersion.all(document.id, document.id, version) as SavedChecklistBody[];
      history.set(version, rows.length === 1 ? savedSnapshot(rows[0]) : null);
    }
    return history.get(version);
  }

  function projectHistorical(source: DocumentDecisionSource, version: number): DocumentSourceSelection | null {
    const old = pin(source.revisionId);
    const original = old?.snapshot.byPosition.get(source.from);
    if (!old || !original?.selection || !sameSelection(original.selection, source)) return null;
    const latest = currentSnapshot();
    if (!latest) return null;
    if (original.id) return old.snapshot.byId.get(original.id) === original ? latest.byId.get(original.id)?.selection ?? null : null;
    if (original.ambiguous) return null;
    const origin = saved(version);
    if (!origin || origin.title !== old.title || origin.content !== old.content) return null;
    const topology = old.snapshot.topology;
    const lastStep = Math.min(document.version, version + MAX_CHECKLIST_HISTORY_STEPS);
    for (let step = version + 1; step <= lastStep; step++) {
      const witness = saved(step);
      if (!witness || witness.snapshot.topology.length !== topology.length || witness.snapshot.topology.some((key, index) => key !== topology[index])) return null;
      const item = witness.snapshot.items[original.index];
      if (!item?.selection || item.ambiguous || item.selection.text !== source.text) return null;
      if (step === document.version && (witness.title !== document.title || witness.content !== (currentContent ??= JSON.stringify(document.content)))) return null;
      if (item.id) return witness.snapshot.byId.get(item.id) === item ? latest.byId.get(item.id)?.selection ?? null : null;
      if (step === document.version) return item.selection;
    }
    return null;
  }

  const links: DocumentChecklistWork['links'] = [];
  const candidates = JSON.parse(row.candidates ?? '[]') as { linkId: string; issueId: string; source: unknown; version: number; sameSnapshot: number | null }[];
  for (const { linkId, issueId, source, version, sameSnapshot } of candidates) {
    if (!record(source) || Object.keys(source).length !== 4 || !isSourceId(source.revisionId) || !validSelection(source)) continue;
    if (!Number.isSafeInteger(version) || version < 1 || version > document.version) continue;
    if (version === document.version) {
      if (!sameSnapshot) continue;
      if (!items.has(source.from)) items.set(source.from, readDocumentChecklistItem(document.content, source.from));
      const item = items.get(source.from);
      if (item && sameSelection(item, source)) links.push({ linkId, issueId, sourceSelection: item });
      continue;
    }
    const pinnedSource = { revisionId: source.revisionId, from: source.from, to: source.to, text: source.text };
    const sourceSelection = projectHistorical(pinnedSource, version);
    if (sourceSelection) links.push({ linkId, issueId, sourceSelection, pinnedSource });
  }
  links.sort((a, b) => a.sourceSelection.from - b.sourceSelection.from || a.linkId.localeCompare(b.linkId));
  return { documentId, documentVersion: document.version, links };
}

export function readDocumentChecklistWork(store: Store, documentId: string, expectedVersion: number): DocumentChecklistWork {
  if (store.db.isTransaction) return checklistWork(store, documentId, expectedVersion);
  store.db.exec('BEGIN');
  try { return checklistWork(store, documentId, expectedVersion); }
  finally { store.db.exec('ROLLBACK'); }
}

function requestFingerprint(version: number, issue: IssueInput, source?: DocumentSourceSelection | { sourceComment: DocumentFollowUpCommentSource }): string {
  let payload: string;
  try {
    // Keep earlier unquoted requests' fingerprints valid across upgrades.
    payload = JSON.stringify(source ? [version, issue, source] : [version, issue], (_key, value: unknown) => record(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  } catch {
    throw new DocumentFollowUpError(400, '생성할 업무의 입력 형식을 확인해 주세요.');
  }
  return createHash('sha256').update(payload).digest('hex');
}

export function resolveDocumentDecisionSource(store: Store, document: DocPage, actorId: string, selection: DocumentSourceSelection,
  summary = '후속 업무 원문 저장', acceptExisting: (revision: DocRevision) => boolean = () => true): DocumentDecisionSource {
  if (!store.db.isTransaction) throw new DocumentFollowUpError(500, '문서 발췌 저장에는 트랜잭션이 필요합니다.');
  const { from, to } = selection;
  const text = readDocumentSelection(document.content, from, to);
  if (text === null || text !== selection.text) {
    throw new DocumentFollowUpError(409, '선택한 문장이 현재 저장된 문서와 일치하지 않습니다. 원문에서 다시 선택해 주세요.', { reason: 'source_selection_changed' });
  }
  const content = JSON.stringify(document.content);
  const rows = store.db.prepare(`SELECT json FROM revisions
    WHERE document_id=? AND json_extract(json,'$.version')=? AND json_type(json,'$.confluenceSourceVersion') IS NULL
    ORDER BY rowid DESC`).all(document.id, document.version) as { json: string }[];
  const existing = rows.map(row => JSON.parse(row.json) as DocRevision)
    .find(revision => revision.title === document.title && JSON.stringify(revision.content) === content && acceptExisting(revision));
  if (existing) return { revisionId: existing.id, from, to, text };

  const revision: DocRevision = {
    id: randomUUID(), documentId: document.id, version: document.version, title: document.title,
    content: document.content, plainText: document.plainText, authorId: actorId, createdAt: new Date().toISOString(), summary,
  };
  store.put('revisions', revision);
  return { revisionId: revision.id, from, to, text };
}

export function validateDocumentDecisionSource(value: unknown, documentId: string, revisions: ReadonlyMap<string, DocRevision>, knownDocument: boolean,
  errorMessage = '업무에 연결된 문서 발췌와 원문 저장본을 확인해 주세요.', reason?: FollowUpErrorReason): void {
  const invalidSource = () => new DocumentFollowUpError(400, errorMessage, reason ? { reason } : undefined);
  if (!record(value) || Object.keys(value).length !== 4 || !validSelection(value)) throw invalidSource();
  const { revisionId, from, to, text } = value;
  if (!isSourceId(revisionId)) throw invalidSource();
  const revision = revisions.get(revisionId);
  if (!revision && !knownDocument) return;
  if (!revision || revision.documentId !== documentId || revision.confluenceSourceVersion !== undefined ||
      readDocumentSelection(revision.content, from, to) !== text) throw invalidSource();
}

export function resolveDocumentFollowUpComment(store: Store, documentId: string, input: DocumentFollowUpCommentSource,
  authorizeSource: (content: DocPage['content']) => void): DocumentDecisionSource {
  const unavailable = (status: number, message: string) => new DocumentFollowUpError(status, message, { reason: 'comment_source_unavailable' });
  const comment = store.get<Comment>('comments', input.commentId);
  if (!comment || comment.resourceType !== 'document' || comment.resourceId !== documentId || comment.parentCommentId) {
    throw unavailable(404, '이 문서에서 연결할 문장 댓글을 찾을 수 없습니다.');
  }
  const source = comment.documentSource;
  if (!source) throw unavailable(400, '원문이 저장된 문장 댓글을 선택해 주세요.');
  if (source.revisionId !== input.revisionId) throw unavailable(409, '댓글의 원문 저장본이 변경되었습니다. 댓글에서 다시 열어 주세요.');
  const revision = store.get<DocRevision>('revisions', source.revisionId);
  if (!revision) throw unavailable(409, '댓글의 원문 저장본을 찾을 수 없습니다.');
  validateDocumentDecisionSource(source, documentId, new Map([[revision.id, revision]]), true,
    '댓글의 원문과 선택 범위를 확인할 수 없습니다.', 'comment_source_unavailable');
  authorizeSource(revision.content);
  return source;
}

export class DocumentFollowUpService {
  constructor(private readonly store: Store) {
    // Receipts survive removal of either item so retries cannot recreate a purged issue.
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_follow_up_requests (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      link_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_decision_link_requests (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      link_id TEXT NOT NULL,
      revision_id TEXT NOT NULL
    )`);
  }

  create({ documentId, actorId, body }: RequestInput, hooks: CreationHooks): DocumentFollowUpResult {
    const { requestId, expectedDocumentVersion, issue: issueInput, selection, sourceComment } = parse(body);
    const fingerprint = requestFingerprint(expectedDocumentVersion, issueInput, sourceComment ? { sourceComment } : selection);
    return this.store.transaction(() => {
      const receipt = this.store.db.prepare(`SELECT document_id AS documentId, actor_id AS actorId, fingerprint,
        issue_id AS issueId, link_id AS linkId FROM document_follow_up_requests WHERE id=?`).get(requestId) as Receipt | undefined;
      if (receipt) {
        if (receipt.actorId !== actorId || receipt.documentId !== documentId || receipt.fingerprint !== fingerprint) {
          throw new DocumentFollowUpError(409, '이미 사용한 후속 업무 요청입니다. 현재 업무와 연결을 확인해 주세요.');
        }
        const document = this.store.get<DocPage>('documents', documentId);
        const issue = this.store.get<Issue>('issues', receipt.issueId);
        const link = this.store.get<ResourceLink>('resource_links', receipt.linkId);
        if (!document || !issue || !link || link.documentId !== documentId || link.issueId !== issue.id) {
          throw new DocumentFollowUpError(409, '이전에 생성한 후속 업무 또는 문서 연결을 확인할 수 없습니다.');
        }
        hooks.authorizeResult(issue, link);
        return { issue, link, duplicate: true };
      }

      const { issue, link } = hooks.create(documentId, expectedDocumentVersion, issueInput, selection, sourceComment);
      hooks.authorizeResult(issue, link);
      this.store.db.prepare(`INSERT INTO document_follow_up_requests(id, document_id, actor_id, fingerprint, issue_id, link_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(requestId, documentId, actorId, fingerprint, issue.id, link.id);
      return { issue, link, duplicate: false };
    });
  }

  linkExisting({ documentId, actorId, body }: RequestInput, hooks: DecisionLinkHooks): DocumentIssueLinkResult {
    const { requestId, expectedDocumentVersion, expectedRestoreGeneration, issueId, selection, sourceComment } = parseDecisionLink(body);
    // Existing selection receipts use the selection object directly in the fingerprint.
    const fingerprintInput = [expectedDocumentVersion, issueId, selection ?? { sourceComment }];
    if (expectedRestoreGeneration !== undefined) fingerprintInput.push(expectedRestoreGeneration);
    const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
    return this.store.transaction(() => {
      if (expectedRestoreGeneration !== undefined && expectedRestoreGeneration !== workspaceRestoreGeneration(this.store)) {
        throw new DocumentFollowUpError(409, '워크스페이스가 복원되었습니다. 새로고침한 뒤 연결을 다시 확인해 주세요.', { reason: 'workspace_restored' });
      }
      const receipt = this.store.db.prepare(`SELECT document_id AS documentId, actor_id AS actorId, fingerprint,
        issue_id AS issueId, link_id AS linkId, revision_id AS revisionId FROM document_decision_link_requests WHERE id=?`)
        .get(requestId) as DecisionLinkReceipt | undefined;
      if (receipt && (receipt.actorId !== actorId || receipt.documentId !== documentId || receipt.issueId !== issueId || receipt.fingerprint !== fingerprint)) {
        throw new DocumentFollowUpError(409, '이미 사용한 결정 근거 연결 요청입니다. 문서와 업무의 연결을 확인해 주세요.');
      }

      const document = this.store.get<DocPage>('documents', documentId);
      const issue = this.store.get<Issue>('issues', issueId);
      if (receipt) {
        const link = this.store.get<ResourceLink>('resource_links', receipt.linkId);
        const source = link?.documentSource;
        if (!document || !issue || link?.documentId !== documentId || link.issueId !== issueId ||
            !source || source.revisionId !== receipt.revisionId ||
            (sourceComment ? source.revisionId !== sourceComment.revisionId : !sameSelection(source, selection))) {
          throw new DocumentFollowUpError(409, '이전에 저장한 결정 근거 연결을 확인할 수 없습니다.');
        }
        hooks.authorizeResult(issue, link);
        return { issue, link, duplicate: true };
      }

      if (!document || !issue) throw new DocumentFollowUpError(404, '연결할 문서 또는 업무를 찾을 수 없습니다.');
      hooks.checkVersion(document, expectedDocumentVersion);
      const row = this.store.db.prepare('SELECT json FROM resource_links WHERE issue_id=? AND document_id=?')
        .get(issueId, documentId) as { json: string } | undefined;
      const existing = row && JSON.parse(row.json) as ResourceLink;
      const pinned = existing?.documentSource;
      const otherSource = () => new DocumentFollowUpError(409,
        '이 업무에 이 문서의 다른 결정 근거가 이미 연결되어 있습니다.', { reason: 'decision_source_exists' });
      let source: DocumentDecisionSource;
      if (sourceComment) {
        source = resolveDocumentFollowUpComment(this.store, documentId, sourceComment, hooks.authorizeSource);
        if (pinned && (pinned.revisionId !== source.revisionId || !sameSelection(pinned, source))) throw otherSource();
      } else {
        hooks.authorizeSource(document.content);
        if (pinned && !matchesCurrentSelection(this.store, document, pinned, selection)) throw otherSource();
        source = pinned ?? resolveDocumentDecisionSource(this.store, document, actorId, selection, '결정 근거 원문 저장');
      }
      const link: ResourceLink = existing && pinned ? existing
        : { ...(existing ?? { id: randomUUID(), documentId, issueId, kind: '결정 근거' }), documentSource: source };
      hooks.authorizeResult(issue, link);
      if (!pinned) {
        this.store.put('resource_links', link);
        hooks.onLinked(issue, document);
      }

      this.store.db.prepare(`INSERT INTO document_decision_link_requests(id, document_id, actor_id, fingerprint, issue_id, link_id, revision_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(requestId, documentId, actorId, fingerprint, issueId, link.id, source.revisionId);
      return { issue, link, duplicate: Boolean(pinned) };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new DocumentFollowUpError(500, '문서 업무 연결 요청 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM document_follow_up_requests; DELETE FROM document_decision_link_requests');
  }
}
