import type { DocumentPublicationList, DocumentPublicationListItem, DocumentPublicationListTab, DocumentPublicationScope } from '../shared/types.js';
import { DocumentPublicationError } from './document-publication.js';
import type { Store } from './store.js';

const PAGE_SIZE = 30;
const MAX_OFFSET = 1_000_000;
interface Selection { tab: DocumentPublicationListTab; scope: DocumentPublicationScope; projectId: string | null; query: string; offset: number }
interface Row {
  documentId: string;
  projectId: string | null;
  documentVersion: number;
  revisionId: string;
  revisionVersion: number;
  title: string;
  status: DocumentPublicationListItem['status'];
  requestedById: string;
  reviewerId: string;
  actionAt: string;
  reviewerIds: string | null;
  approvedCount: number | null;
}
function fail(status: number, message: string): never { throw new DocumentPublicationError(status, message); }
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `${label}을(를) 확인해 주세요.`);
  return value;
}
function actor(store: Store, actorId: string): void {
  identifier(actorId, '작업자 ID');
  if (!store.db.prepare('SELECT id FROM users WHERE id=?').get(actorId)) fail(400, '등록된 작업자를 선택해 주세요.');
}
function parse(store: Store, value: Record<string, unknown>): Selection {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['tab', 'scope', 'projectId', 'q', 'offset'].includes(key))) fail(400, '문서 검토 목록의 조회 조건을 확인해 주세요.');
  const tab = value.tab === undefined ? 'assigned' : value.tab;
  const scope = value.scope === undefined ? 'workspace' : value.scope;
  if (tab !== 'assigned' && tab !== 'requested' && tab !== 'published') fail(400, '내 검토·내 요청·발행 문서 중 하나를 선택해 주세요.');
  if (scope !== 'workspace' && scope !== 'project' && scope !== 'common') fail(400, '전체·프로젝트·공통 문서 범위를 확인해 주세요.');
  const suppliedProject = Object.hasOwn(value, 'projectId') && value.projectId !== undefined;
  let projectId: string | null = null;
  if (scope === 'project') {
    projectId = identifier(value.projectId, '프로젝트 ID');
    if (!store.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) fail(404, '문서 목록의 프로젝트를 찾을 수 없습니다.');
  } else if (suppliedProject) fail(400, '프로젝트 범위에서만 프로젝트 ID를 지정할 수 있습니다.');
  const text = value.q === undefined ? '' : value.q;
  if (typeof text !== 'string' || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) fail(400, '문서 제목 검색어는 200자 이하여야 합니다.');
  const rawOffset = value.offset === undefined ? 0 : value.offset;
  const offset = typeof rawOffset === 'string' && /^\d{1,7}$/.test(rawOffset) ? Number(rawOffset) : rawOffset;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) fail(400, '문서 목록의 시작 위치는 0~1,000,000 사이의 정수여야 합니다.');
  return { tab, scope, projectId, query: text.trim().normalize('NFC').toLowerCase(), offset };
}

// Pointer and revision must belong to the same surviving document. User/project
// joins also keep broken historical foreign references out of navigable lists.
function joins(pointer: 'review' | 'published'): string {
  return `FROM document_publications p
    JOIN documents d ON d.id=p.document_id
    JOIN revisions r ON r.id=json_extract(p.json,'$.${pointer}.revisionId') AND r.document_id=d.id
    JOIN users requester ON requester.id=json_extract(p.json,'$.${pointer}.requestedById')
    JOIN users reviewer ON reviewer.id=json_extract(p.json,'$.${pointer}.reviewerId')
    LEFT JOIN projects project ON project.id=d.project_id`;
}
const validProject = '(d.project_id IS NULL OR project.id IS NOT NULL)';
const pending = "json_type(p.json,'$.review')='object' AND json_type(p.json,'$.review.changesRequested')='null'";
const reviewRequestedAt = "json_extract(p.json,'$.review.requestedAt')";
const reviewParticipants = "json_each(p.json,'$.review.reviewers') member";
const pendingForMember = `CASE WHEN json_type(p.json,'$.review.reviewers')='array' THEN EXISTS (
    SELECT 1 FROM ${reviewParticipants}
    WHERE json_extract(p.json,member.fullkey||'.reviewerId')=? AND json_type(p.json,member.fullkey||'.approval')='null'
  ) ELSE reviewer.id=? END`;
const latestApprovalAt = `(SELECT MAX(json_extract(p.json,member.fullkey||'.approval.at')) FROM ${reviewParticipants})`;
const pendingCountSql = `SELECT COUNT(*) AS count ${joins('review')}
  WHERE ${validProject} AND ${pending} AND (${pendingForMember})`;
function pendingCount(store: Store, actorId: string): number {
  return (store.db.prepare(pendingCountSql).get(actorId, actorId) as { count: number }).count;
}
function readSnapshot<T>(store: Store, action: () => T): T {
  const own = !store.db.isTransaction;
  if (own) store.db.exec('BEGIN');
  try {
    const result = action();
    if (own) store.db.exec('COMMIT');
    return result;
  } catch (error) { if (own) store.db.exec('ROLLBACK'); throw error; }
}

/** Global current-reviewer badge, deliberately independent of every inbox filter. */
export function countDocumentAssignedReviews(store: Store, actorId: string): number {
  return readSnapshot(store, () => { actor(store, actorId); return pendingCount(store, actorId); });
}

function publicationColumns(pointer: 'review' | 'published', status: string, actionAt: string): string {
  const review = pointer === 'review';
  const path = review ? '$.review.reviewers' : '$.published.approvals';
  const reviewerField = review ? 'reviewerId' : 'byId';
  const approvedCount = review ? `(SELECT COUNT(*) FROM ${reviewParticipants}
    WHERE json_type(p.json,member.fullkey||'.approval')='object')` : `json_array_length(p.json,'${path}')`;
  return `SELECT p.document_id AS documentId,d.project_id AS projectId,
    json_extract(d.json,'$.version') AS documentVersion,r.id AS revisionId,
    json_extract(r.json,'$.version') AS revisionVersion,json_extract(r.json,'$.title') AS title,
    ${status} AS status,json_extract(p.json,'$.${pointer}.requestedById') AS requestedById,
    json_extract(p.json,'$.${pointer}.reviewerId') AS reviewerId,${actionAt} AS actionAt,
    CASE WHEN json_type(p.json,'${path}')='array' THEN (
      SELECT json_group_array(json_extract(p.json,member.fullkey||'.${reviewerField}') ORDER BY member.key)
      FROM json_each(p.json,'${path}') member
    ) END AS reviewerIds,
    CASE WHEN json_type(p.json,'${path}')='array' THEN ${approvedCount} END AS approvedCount`;
}

function publicationItem(row: Row): DocumentPublicationListItem {
  return {
    documentId: row.documentId, projectId: row.projectId, documentVersion: row.documentVersion,
    revision: { id: row.revisionId, version: row.revisionVersion, title: row.title }, status: row.status,
    requestedById: row.requestedById, reviewerId: row.reviewerId, actionAt: row.actionAt,
    ...(row.reviewerIds !== null && row.approvedCount !== null
      ? { reviewerIds: JSON.parse(row.reviewerIds) as string[], approvedCount: row.approvedCount } : {}),
  };
}

/** The team overview lists still-pending pinned reviews in oldest-first order. */
export function listPendingTeamReviews(store: Store, filters: {
  projectId: string | null; memberId: string | null; offset: number; limit: number;
}): { total: number; offset: number; limit: number; items: DocumentPublicationListItem[] } {
  return readSnapshot(store, () => {
    const { projectId, memberId, offset, limit } = filters;
    const where = [validProject, pending, `typeof(${reviewRequestedAt})='text'`, `julianday(${reviewRequestedAt}) IS NOT NULL`];
    const params: string[] = [];
    if (projectId !== null) { where.push('d.project_id=?'); params.push(projectId); }
    if (memberId !== null) { where.push(`(${pendingForMember})`); params.push(memberId, memberId); }
    const query = `${joins('review')} WHERE ${where.join(' AND ')}`;
    const { total } = store.db.prepare(`SELECT count(*) AS total ${query}`).get(...params) as { total: number };
    const rows = store.db.prepare(`${publicationColumns('review', "'pending'", reviewRequestedAt)} ${query}
      ORDER BY julianday(${reviewRequestedAt}) ASC,p.document_id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as Row[];
    return { total, offset, limit, items: rows.map(publicationItem) };
  });
}

/** Read only pinned revision metadata; draft titles, bodies and review notes are
 * never materialized. Streaming Unicode matching keeps page memory bounded. */
export function listDocumentPublications(store: Store, actorId: string, query: Record<string, unknown>): DocumentPublicationList {
  return readSnapshot(store, () => {
    actor(store, actorId);
    const selection = parse(store, query), pointer = selection.tab === 'published' ? 'published' : 'review';
    const where = [validProject], parameters: string[] = [];
    let status = "'published'", actionAt = "json_extract(p.json,'$.published.publishedAt')";
    if (selection.tab === 'assigned') {
      where.push(pending, `(${pendingForMember})`); parameters.push(actorId, actorId);
      status = "'pending'"; actionAt = reviewRequestedAt;
    } else if (selection.tab === 'requested') {
      where.push("json_type(p.json,'$.review')='object'", "json_type(p.json,'$.review.changesRequested') IN ('null','object')", "json_extract(p.json,'$.review.requestedById')=?"); parameters.push(actorId);
      status = "CASE WHEN json_type(p.json,'$.review.changesRequested')='object' THEN 'changes_requested' ELSE 'pending' END";
      actionAt = `COALESCE(json_extract(p.json,'$.review.changesRequested.at'),${latestApprovalAt},${reviewRequestedAt})`;
    } else where.push("json_type(p.json,'$.published')='object'");
    if (selection.scope === 'project') { where.push('d.project_id=?'); parameters.push(selection.projectId!); }
    else if (selection.scope === 'common') where.push('d.project_id IS NULL');
    const rows = store.db.prepare(`${publicationColumns(pointer, status, actionAt)}
      ${joins(pointer)} WHERE ${where.join(' AND ')} ORDER BY actionAt DESC,p.document_id ASC`);
    const items: DocumentPublicationListItem[] = [];
    let total = 0;
    for (const raw of rows.iterate(...parameters)) {
      const row = raw as unknown as Row;
      if (selection.query && !row.title.normalize('NFC').toLowerCase().includes(selection.query)) continue;
      if (total >= selection.offset && items.length < PAGE_SIZE) items.push(publicationItem(row));
      total++;
    }
    return { tab: selection.tab, scope: selection.scope, projectId: selection.projectId, offset: selection.offset, total, pendingAssigned: pendingCount(store, actorId), items };
  });
}
