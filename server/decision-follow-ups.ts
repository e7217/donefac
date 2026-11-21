import type { Express, Request } from 'express';
import { issueDeadline } from '../shared/my-work.js';
import type { DecisionFollowUpItem, DecisionFollowUpPage, DecisionFollowUpSource, DocRevision, ProjectWorkflow, ResourceLink, RichContent } from '../shared/types.js';
import { statusMeta } from '../shared/workflow-helpers.js';
import { DocumentFollowUpError, validateDocumentDecisionSource } from './document-follow-up.js';
import type { Store } from './store.js';

const PAGE_SIZE = 20;
const MAX_OFFSET = 1_000_000;
const invalidControl = /[\u0000-\u001f\u007f]/u;
export const DECISION_FOLLOW_UP_QUERY_PARAMETERS = ['status', 'assigneeId', 'q', 'offset'] as const;

export class DecisionFollowUpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type ProjectScope = readonly string[] | null;
type Dependencies = {
  store: Store;
  workflow: (projectId: string) => ProjectWorkflow;
  projectScope: (request: Request) => ProjectScope;
  authorizeDocumentBody: (request: Request, content: RichContent) => void;
};

type Row = {
  linkId: string;
  issueId: string;
  issueKey: string;
  issueTitle: string;
  issueStatus: string;
  assigneeId: string | null;
  dueDate: string | null;
  endDate: string | null;
  documentId: string;
  documentProjectId: string | null;
  documentTitle: string;
  revisionId: string;
  version: number;
  sourceTitle: string;
  createdAt: string;
  sourceFrom: number;
  sourceTo: number;
};

const missingSource = () => new DecisionFollowUpError(404, '연결된 결정 근거나 원문 저장본을 찾을 수 없습니다.');

function readSnapshot<T>(store: Store, read: () => T): T {
  if (store.db.isTransaction) return read();
  store.db.exec('BEGIN');
  try {
    const result = read();
    store.db.exec('COMMIT');
    return result;
  } catch (cause) {
    store.db.exec('ROLLBACK');
    throw cause;
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || !value.isWellFormed() ||
      /[\/\\]/u.test(value) || invalidControl.test(value) || value === '.' || value === '..') {
    throw new DecisionFollowUpError(400, label);
  }
  return value;
}

function searchable(value: string) {
  return value.normalize('NFC').toLowerCase();
}

function parseQuery(query: Record<string, unknown>) {
  if (Object.keys(query).some(key => !(DECISION_FOLLOW_UP_QUERY_PARAMETERS as readonly string[]).includes(key))) {
    throw new DecisionFollowUpError(400, '결정 후속 업무의 조회 조건을 확인해 주세요.');
  }
  const { status = 'open', assigneeId, q, offset = '0' } = query;
  if (status !== 'open' && status !== 'closed' && status !== 'all') {
    throw new DecisionFollowUpError(400, '결정 후속 업무의 상태 조건을 확인해 주세요.');
  }
  if (q !== undefined && (typeof q !== 'string' || q.length > 160 || !q.isWellFormed() || invalidControl.test(q))) {
    throw new DecisionFollowUpError(400, '검색어는 160자까지 입력할 수 있습니다.');
  }
  if (typeof offset !== 'string' || !/^[0-9]{1,7}$/u.test(offset) || Number(offset) > MAX_OFFSET) {
    throw new DecisionFollowUpError(400, '조회 시작 위치는 0~1,000,000 사이의 정수여야 합니다.');
  }
  return {
    status, assigneeId: assigneeId === undefined ? null : identifier(assigneeId, '담당자 ID를 확인해 주세요.'),
    query: q === undefined ? '' : searchable(q.trim()), offset: Number(offset),
  };
}

function requireProject(store: Store, projectId: string, scope: ProjectScope) {
  if (scope !== null && !scope.includes(projectId)) {
    throw new DecisionFollowUpError(403, '이 API 키에서 허용하지 않은 프로젝트입니다.');
  }
  if (!store.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) {
    throw new DecisionFollowUpError(404, '프로젝트를 찾을 수 없습니다.');
  }
}

function compare(left: DecisionFollowUpItem, right: DecisionFollowUpItem) {
  const a = left.issue.deadline, b = right.issue.deadline;
  if (a !== b) {
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : 1;
  }
  const sourceOrder = Date.parse(right.source.createdAt) - Date.parse(left.source.createdAt);
  return sourceOrder || (left.linkId < right.linkId ? -1 : left.linkId > right.linkId ? 1 : 0);
}

function listDecisions({ store, workflow }: Dependencies, projectId: string, scope: ProjectScope,
  filters: ReturnType<typeof parseQuery>): DecisionFollowUpPage {
  return readSnapshot(store, () => {
    requireProject(store, projectId, scope);
    const conditions = [
      'i.project_id=?',
      "json_type(l.json,'$.documentSource')='object'",
      "json_type(r.json,'$.confluenceSourceVersion') IS NULL",
      "json_type(r.json,'$.version')='integer'",
      "json_type(r.json,'$.title')='text'",
      "json_type(r.json,'$.createdAt')='text'",
      "json_type(l.json,'$.documentSource.from')='integer'",
      "json_type(l.json,'$.documentSource.to')='integer'",
    ];
    const params = [projectId];
    if (scope !== null) {
      conditions.push('d.project_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(scope));
    }
    if (filters.assigneeId === 'unassigned') conditions.push('i.assignee_id IS NULL');
    else if (filters.assigneeId !== null) {
      conditions.push('i.assignee_id=?');
      params.push(filters.assigneeId);
    }
    const rows = store.db.prepare(`SELECT l.id AS linkId, i.id AS issueId,
      json_extract(i.json,'$.key') AS issueKey, json_extract(i.json,'$.title') AS issueTitle,
      json_extract(i.json,'$.status') AS issueStatus, i.assignee_id AS assigneeId,
      json_extract(i.json,'$.dueDate') AS dueDate, json_extract(i.json,'$.endDate') AS endDate,
      d.id AS documentId, d.project_id AS documentProjectId, json_extract(d.json,'$.title') AS documentTitle,
      r.id AS revisionId, json_extract(r.json,'$.version') AS version, json_extract(r.json,'$.title') AS sourceTitle,
      json_extract(r.json,'$.createdAt') AS createdAt, json_extract(l.json,'$.documentSource.from') AS sourceFrom,
      json_extract(l.json,'$.documentSource.to') AS sourceTo
      FROM issues i JOIN resource_links l ON l.issue_id=i.id JOIN documents d ON d.id=l.document_id
      JOIN revisions r ON r.id=json_extract(l.json,'$.documentSource.revisionId') AND r.document_id=d.id
      WHERE ${conditions.join(' AND ')}`);
    const workflowData = { workflows: [workflow(projectId)] };
    const items: DecisionFollowUpItem[] = [];
    for (const value of rows.iterate(...params)) {
      const row = value as unknown as Row;
      if (!Number.isSafeInteger(row.version) || row.version < 1 || !Number.isFinite(Date.parse(row.createdAt)) ||
          !Number.isSafeInteger(row.sourceFrom) || !Number.isSafeInteger(row.sourceTo) ||
          row.sourceFrom < 0 || row.sourceTo <= row.sourceFrom) continue;
      const status = statusMeta(workflowData, projectId, row.issueStatus);
      const closed = status.category === 'done' || status.category === 'cancelled';
      if ((filters.status === 'open' && closed) || (filters.status === 'closed' && !closed)) continue;
      if (filters.query && ![row.issueKey, row.issueTitle, row.sourceTitle, row.documentTitle]
        .some(value => typeof value === 'string' && searchable(value).includes(filters.query))) continue;
      const deadline = issueDeadline(row);
      items.push({
        linkId: row.linkId,
        issue: {
          id: row.issueId, projectId, key: row.issueKey, title: row.issueTitle, status: row.issueStatus,
          statusLabel: status.label, statusColor: status.color, statusCategory: status.category,
          assigneeId: row.assigneeId, deadline: deadline?.value ?? null, deadlineSource: deadline?.source ?? null,
        },
        document: { id: row.documentId, projectId: row.documentProjectId, title: row.documentTitle },
        source: { revisionId: row.revisionId, version: row.version, title: row.sourceTitle, createdAt: row.createdAt,
          from: row.sourceFrom, to: row.sourceTo },
      });
    }
    items.sort(compare);
    return { projectId, total: items.length, offset: filters.offset, limit: PAGE_SIZE,
      items: items.slice(filters.offset, filters.offset + PAGE_SIZE) };
  });
}

function readDecisionSource({ store, authorizeDocumentBody }: Dependencies, request: Request, projectId: string,
  linkId: string, scope: ProjectScope): DecisionFollowUpSource {
  return readSnapshot(store, () => {
    requireProject(store, projectId, scope);
    const row = store.db.prepare(`SELECT l.json, d.id AS documentId, d.project_id AS documentProjectId
      FROM resource_links l JOIN issues i ON i.id=l.issue_id JOIN documents d ON d.id=l.document_id
      WHERE l.id=? AND i.project_id=? AND json_type(l.json,'$.documentSource')='object'`)
      .get(linkId, projectId) as { json: string; documentId: string; documentProjectId: string | null } | undefined;
    if (!row) throw missingSource();
    if (scope !== null && (row.documentProjectId === null || !scope.includes(row.documentProjectId))) {
      throw new DecisionFollowUpError(403, '이 API 키에서 허용하지 않은 프로젝트입니다.');
    }
    const { documentId, documentSource } = JSON.parse(row.json) as ResourceLink;
    if (documentId !== row.documentId || typeof documentSource?.revisionId !== 'string') throw missingSource();
    const revision = store.get<DocRevision>('revisions', documentSource.revisionId);
    if (!revision) throw missingSource();
    try {
      validateDocumentDecisionSource(documentSource, documentId, new Map([[revision.id, revision]]), true);
    } catch (error) {
      if (error instanceof DocumentFollowUpError) throw missingSource();
      throw error;
    }
    authorizeDocumentBody(request, revision.content);
    return { linkId, documentId, source: documentSource };
  });
}

export function registerDecisionFollowUpRoutes(app: Express, dependencies: Dependencies): void {
  const project = (value: unknown) => identifier(value, '프로젝트 ID를 확인해 주세요.');
  app.get('/api/projects/:id/decision-follow-ups', (request, response) => {
    response.set('Cache-Control', 'no-store').json(listDecisions(dependencies, project(request.params.id),
      dependencies.projectScope(request), parseQuery(request.query)));
  });
  app.get('/api/projects/:id/decision-follow-ups/:linkId/source', (request, response) => {
    if (Object.keys(request.query).length) throw new DecisionFollowUpError(400, '결정 근거 원문의 조회 조건을 확인해 주세요.');
    response.set('Cache-Control', 'no-store').json(readDecisionSource(dependencies, request, project(request.params.id),
      identifier(request.params.linkId, '결정 근거 연결 ID를 확인해 주세요.'), dependencies.projectScope(request)));
  });
}
