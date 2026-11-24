import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { isCalendarDate } from '../shared/calendar.js';
import { issueDeadline } from '../shared/my-work.js';
import type { DecisionFollowUpDraftRequest, DecisionFollowUpDraftResult, DecisionFollowUpItem, DecisionFollowUpPage, DecisionFollowUpSource,
  DocPage, DocRevision, Project, ProjectWorkflow, ResourceLink, RichContent, User } from '../shared/types.js';
import { statusMeta } from '../shared/workflow-helpers.js';
import { matchingIssueSearchAliases, normalizeWorkspaceSearchKey } from '../shared/workspace-search.js';
import { buildDecisionFollowUpDraftContent } from './decision-follow-up-draft-content.js';
import type { DocumentCreationService } from './document-creation.js';
import { DocumentFollowUpError, validateDocumentDecisionSource } from './document-follow-up.js';
import { readIssueSearchAliases } from './issue-search-aliases.js';
import type { Store } from './store.js';

const PAGE_SIZE = 20;
const MAX_OFFSET = 1_000_000;
const invalidControl = /[\u0000-\u001f\u007f]/u;
export const DECISION_FOLLOW_UP_QUERY_PARAMETERS = ['status', 'assigneeId', 'q', 'unscheduledOnly', 'offset'] as const;
export const TEAM_DECISION_FOLLOW_UP_QUERY_PARAMETERS = ['projectId', ...DECISION_FOLLOW_UP_QUERY_PARAMETERS] as const;
const draftFields = ['requestId', 'title', 'revision', 'destinationProjectId', 'linkIds', ...DECISION_FOLLOW_UP_QUERY_PARAMETERS];

export class DecisionFollowUpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { reason: 'stale_report' | 'destination_unavailable' }) { super(message); }
}

type ProjectScope = readonly string[] | null;
type DocumentCapture = { documentId: string; projectId: string | null; title: string; actorId: string; createdAt: string };
type Dependencies = {
  store: Store;
  workflow: (projectId: string) => ProjectWorkflow;
  projectScope: (request: Request) => ProjectScope;
  authorizeDocumentBody: (request: Request, content: RichContent) => void;
  actor: (request: Request) => string;
  documentCreation: DocumentCreationService;
  createDocument: (request: Request, capture: DocumentCapture, content: RichContent, issueIds: string[]) => DocPage;
};

type Row = {
  linkId: string;
  issueId: string;
  issueProjectId: string;
  issueKey: string;
  issueTitle: string;
  issueStatus: string;
  assigneeId: string | null;
  dueDate: string | null;
  startDate: string | null;
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
const projectIdentifier = (value: unknown) => identifier(value, '프로젝트 ID를 확인해 주세요.');

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

function draftLinkIds(value: unknown): string[] | undefined {
  if (value === undefined) return;
  const message = `회의 초안에 담을 결정 근거를 1~${PAGE_SIZE}개 선택해 주세요.`;
  if (!Array.isArray(value) || !value.length || value.length > PAGE_SIZE) throw new DecisionFollowUpError(400, message);
  const ids = value.map(id => identifier(id, message));
  if (new Set(ids).size !== ids.length) throw new DecisionFollowUpError(400, message);
  return ids;
}

function searchable(value: string) {
  return value.normalize('NFC').toLowerCase();
}

type Filters = {
  status: NonNullable<DecisionFollowUpDraftRequest['status']>;
  assigneeId: string | null;
  query: string;
  searchTerm: string;
  unscheduledOnly?: true;
  offset: number;
};

function parseQuery(query: Record<string, unknown>, allowed: readonly string[] = DECISION_FOLLOW_UP_QUERY_PARAMETERS): Filters {
  if (Object.keys(query).some(key => !allowed.includes(key))) {
    throw new DecisionFollowUpError(400, '결정 후속 업무의 조회 조건을 확인해 주세요.');
  }
  const { status = 'open', assigneeId, q, unscheduledOnly, offset = '0' } = query;
  if (status !== 'open' && status !== 'closed' && status !== 'all') {
    throw new DecisionFollowUpError(400, '결정 후속 업무의 상태 조건을 확인해 주세요.');
  }
  if (q !== undefined && (typeof q !== 'string' || q.length > 160 || !q.isWellFormed() || invalidControl.test(q))) {
    throw new DecisionFollowUpError(400, '검색어는 160자까지 입력할 수 있습니다.');
  }
  if (unscheduledOnly !== undefined && unscheduledOnly !== '0' && unscheduledOnly !== '1') {
    throw new DecisionFollowUpError(400, '일정 미정 조건을 확인해 주세요.');
  }
  if (typeof offset !== 'string' || !/^[0-9]{1,7}$/u.test(offset) || Number(offset) > MAX_OFFSET) {
    throw new DecisionFollowUpError(400, '조회 시작 위치는 0~1,000,000 사이의 정수여야 합니다.');
  }
  const searchTerm = typeof q === 'string' ? q.trim() : '';
  return {
    status, assigneeId: assigneeId === undefined ? null : identifier(assigneeId, '담당자 ID를 확인해 주세요.'),
    query: searchable(searchTerm), searchTerm, offset: Number(offset),
    ...(unscheduledOnly === '1' ? { unscheduledOnly: true } : {}),
  };
}

function requireProject(store: Store, projectId: string, scope: ProjectScope, purpose: 'source' | 'destination' = 'source') {
  if (scope !== null && !scope.includes(projectId)) {
    throw new DecisionFollowUpError(403, '이 API 키에서 허용하지 않은 프로젝트입니다.');
  }
  if (!store.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) {
    if (purpose === 'destination') {
      throw new DecisionFollowUpError(422, '저장 위치의 프로젝트를 찾을 수 없습니다. 다른 저장 위치를 선택해 주세요.', { reason: 'destination_unavailable' });
    }
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

function pageLabels(store: Store, projectId: string | null, assigneeId: string | null, items: DecisionFollowUpItem[]) {
  const projects = new Set([projectId, ...items.flatMap(item => [item.issue.projectId, item.document.projectId])]);
  const assignees = new Set([assigneeId === 'unassigned' ? null : assigneeId, ...items.map(item => item.issue.assigneeId)]);
  return {
    projectNames: new Map([...projects].flatMap(id => id === null ? [] : [[id, store.get<Project>('projects', id)?.name ?? '프로젝트 정보 없음']])),
    assigneeNames: new Map([...assignees].flatMap(id => id === null ? [] : [[id, store.get<User>('users', id)?.name ?? '미지정']])),
  };
}

function listDecisions({ store, workflow }: Dependencies, projectId: string | null, scope: ProjectScope, filters: Filters, teamReport: boolean) {
  return readSnapshot(store, () => {
    const conditions = [
      "json_type(l.json,'$.documentSource')='object'",
      "json_type(r.json,'$.confluenceSourceVersion') IS NULL",
      "json_type(r.json,'$.version')='integer'",
      "json_type(r.json,'$.title')='text'",
      "json_type(r.json,'$.createdAt')='text'",
      "json_type(l.json,'$.documentSource.from')='integer'",
      "json_type(l.json,'$.documentSource.to')='integer'",
    ];
    const params: string[] = [];
    if (projectId !== null) {
      requireProject(store, projectId, scope);
      conditions.push('i.project_id=?');
      params.push(projectId);
    }
    if (scope !== null) {
      const projects = JSON.stringify(scope);
      if (projectId === null) {
        conditions.push('i.project_id IN (SELECT value FROM json_each(?))');
        params.push(projects);
      }
      conditions.push('d.project_id IN (SELECT value FROM json_each(?))');
      params.push(projects);
    }
    if (filters.assigneeId === 'unassigned') conditions.push('i.assignee_id IS NULL');
    else if (filters.assigneeId !== null) {
      conditions.push('i.assignee_id=?');
      params.push(filters.assigneeId);
    }
    const eligible = `FROM issues i JOIN resource_links l ON l.issue_id=i.id JOIN documents d ON d.id=l.document_id
      JOIN revisions r ON r.id=json_extract(l.json,'$.documentSource.revisionId') AND r.document_id=d.id
      WHERE ${conditions.join(' AND ')}`;
    const rows = store.db.prepare(`SELECT l.id AS linkId, i.id AS issueId, i.project_id AS issueProjectId,
      json_extract(i.json,'$.key') AS issueKey, json_extract(i.json,'$.title') AS issueTitle,
      json_extract(i.json,'$.status') AS issueStatus, i.assignee_id AS assigneeId,
      json_extract(i.json,'$.dueDate') AS dueDate, json_extract(i.json,'$.startDate') AS startDate, json_extract(i.json,'$.endDate') AS endDate,
      d.id AS documentId, d.project_id AS documentProjectId, json_extract(d.json,'$.title') AS documentTitle,
      r.id AS revisionId, json_extract(r.json,'$.version') AS version, json_extract(r.json,'$.title') AS sourceTitle,
      json_extract(r.json,'$.createdAt') AS createdAt, json_extract(l.json,'$.documentSource.from') AS sourceFrom,
      json_extract(l.json,'$.documentSource.to') AS sourceTo ${eligible}`);
    const workflows = new Map<string, ProjectWorkflow>();
    const items: DecisionFollowUpItem[] = [];
    const keyQuery = normalizeWorkspaceSearchKey(filters.searchTerm);
    const owners = keyQuery ? store.db.prepare(`SELECT DISTINCT i.id, json_extract(i.json,'$.key') AS key ${eligible}`)
      .all(...params) as { id: string; key: string }[] : [];
    const aliasData = { issueAliases: owners.length ? readIssueSearchAliases(store, owners) : undefined };
    for (const value of rows.iterate(...params)) {
      const row = value as unknown as Row;
      if (!Number.isSafeInteger(row.version) || row.version < 1 || !Number.isFinite(Date.parse(row.createdAt)) ||
          !Number.isSafeInteger(row.sourceFrom) || !Number.isSafeInteger(row.sourceTo) ||
          row.sourceFrom < 0 || row.sourceTo <= row.sourceFrom) continue;
      const startDate = isCalendarDate(row.startDate) ? row.startDate : null;
      const endDate = isCalendarDate(row.endDate) ? row.endDate : null;
      if (filters.unscheduledOnly && startDate && endDate) continue;
      const issueProjectId = row.issueProjectId;
      let issueWorkflow = workflows.get(issueProjectId);
      if (!issueWorkflow) {
        issueWorkflow = workflow(issueProjectId);
        workflows.set(issueProjectId, issueWorkflow);
      }
      const status = statusMeta({ workflows: [issueWorkflow] }, issueProjectId, row.issueStatus);
      const closed = status.category === 'done' || status.category === 'cancelled';
      if ((filters.status === 'open' && closed) || (filters.status === 'closed' && !closed)) continue;
      if (filters.query && ![row.issueKey, row.issueTitle, row.sourceTitle, row.documentTitle]
        .some(value => typeof value === 'string' && searchable(value).includes(filters.query)) &&
        !(keyQuery && normalizeWorkspaceSearchKey(row.issueKey).includes(keyQuery)) &&
        !matchingIssueSearchAliases(aliasData, row.issueId, keyQuery).length) continue;
      const deadline = issueDeadline(row);
      items.push({
        linkId: row.linkId,
        issue: {
          id: row.issueId, projectId: issueProjectId, key: row.issueKey, title: row.issueTitle, status: row.issueStatus,
          statusLabel: status.label, statusColor: status.color, statusCategory: status.category,
          assigneeId: row.assigneeId, startDate, endDate, deadline: deadline?.value ?? null, deadlineSource: deadline?.source ?? null,
        },
        document: { id: row.documentId, projectId: row.documentProjectId, title: row.documentTitle },
        source: { revisionId: row.revisionId, version: row.version, title: row.sourceTitle, createdAt: row.createdAt,
          from: row.sourceFrom, to: row.sourceTo },
      });
    }
    items.sort(compare);
    const visible = items.slice(filters.offset, filters.offset + PAGE_SIZE);
    const labels = pageLabels(store, projectId, filters.assigneeId, visible);
    const revision = createHash('sha256').update(JSON.stringify([
      teamReport, projectId, filters.status, filters.assigneeId, filters.searchTerm, filters.unscheduledOnly === true, filters.offset, items.length, visible,
      [...labels.projectNames], [...labels.assigneeNames], store.setting('attachmentImportGeneration'),
    ])).digest('hex');
    const page: DecisionFollowUpPage = { projectId, total: items.length, offset: filters.offset, limit: PAGE_SIZE,
      items: visible, revision, generatedAt: new Date().toISOString() };
    return { page, ...labels };
  });
}

function readDecisionSource({ store, authorizeDocumentBody }: Dependencies, request: Request, projectId: string,
  linkId: string, scope: ProjectScope, revisions?: Map<string, DocRevision | null>): DecisionFollowUpSource {
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
    const stored = revisions?.get(documentSource.revisionId);
    const revision = stored === undefined ? store.get<DocRevision>('revisions', documentSource.revisionId) ?? null : stored;
    if (stored === undefined) revisions?.set(documentSource.revisionId, revision);
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

function draftInput(request: Request, teamReport: boolean) {
  const body: unknown = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(request.query).length ||
      Object.keys(body).some(key => !draftFields.includes(key) && !(teamReport && key === 'projectId'))) {
    throw new DecisionFollowUpError(400, '결정 후속 업무 회의 초안의 입력을 확인해 주세요.');
  }
  const { title: inputTitle, requestId, revision, destinationProjectId, projectId, status, assigneeId, q, unscheduledOnly, offset, linkIds } = body as Record<string, unknown>;
  const title = typeof inputTitle === 'string' ? inputTitle.trim() : '';
  if (!title || title.length > 200 || !title.isWellFormed() || invalidControl.test(title)) {
    throw new DecisionFollowUpError(400, '회의 초안 제목을 1~200자로 입력해 주세요.');
  }
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)) {
    throw new DecisionFollowUpError(400, '조회한 결정 후속 업무 보고서의 버전이 필요합니다.');
  }
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET)) {
    throw new DecisionFollowUpError(400, '조회 시작 위치는 0~1,000,000 사이의 정수여야 합니다.');
  }
  if (unscheduledOnly !== undefined && typeof unscheduledOnly !== 'boolean') {
    throw new DecisionFollowUpError(400, '일정 미정 조건을 확인해 주세요.');
  }
  return { title, requestId, revision, destination: destinationProjectId === null ? null : projectIdentifier(destinationProjectId),
    reportProject: teamReport ? (projectId === undefined ? null : projectIdentifier(projectId)) : projectIdentifier(request.params.id),
    filters: parseQuery({ status, assigneeId, q, offset: String(offset ?? 0), ...(unscheduledOnly ? { unscheduledOnly: '1' } : {}) }),
    linkIds: draftLinkIds(linkIds),
  };
}

function reportHref(routeProject: string, reportProject: string | null, filters: Filters, teamReport: boolean) {
  const parameters = new URLSearchParams();
  if (filters.status !== 'open') parameters.set('status', filters.status);
  if (filters.assigneeId) parameters.set('assigneeId', filters.assigneeId);
  if (filters.searchTerm) parameters.set('q', filters.searchTerm);
  if (filters.unscheduledOnly) parameters.set('unscheduledOnly', '1');
  if (filters.offset) parameters.set('offset', String(filters.offset));
  if (teamReport) {
    parameters.set('scope', 'team');
    if (reportProject) parameters.set('decisionProject', reportProject);
  }
  return `#/${encodeURIComponent(routeProject)}/reports/decision-follow-ups${parameters.size ? `?${parameters}` : ''}`;
}

function createDraft(request: Request, dependencies: Dependencies, teamReport: boolean): DecisionFollowUpDraftResult {
  const { title, requestId, revision, destination, reportProject, filters, linkIds } = draftInput(request, teamReport);
  const { store } = dependencies;
  const scope = dependencies.projectScope(request);
  const actorId = dependencies.actor(request);
  const input = { requestId, title, revision, projectId: destination, teamReport, reportProject, filters,
    ...(linkIds ? { linkIds: linkIds.toSorted() } : {}),
  };
  return dependencies.documentCreation.create(actorId, input, () => {
    const { page, projectNames, assigneeNames } = listDecisions(dependencies, reportProject, scope, filters, teamReport);
    if (destination !== null) requireProject(store, destination, scope, 'destination');
    if (page.revision !== revision) {
      throw new DecisionFollowUpError(409, '조회 이후 결정 후속 업무 내용이 바뀌었습니다. 같은 조건으로 다시 조회해 주세요.', { reason: 'stale_report' });
    }
    const selected = linkIds ? new Set(linkIds) : undefined;
    const items = selected ? page.items.filter(item => selected.has(item.linkId)) : page.items;
    if (selected && items.length !== selected.size) throw new DecisionFollowUpError(422, '현재 보고서 페이지에서 결정 근거를 다시 선택해 주세요.');
    if (!items.length) throw new DecisionFollowUpError(422, '회의 초안에 담을 결정 후속 업무가 없습니다.');
    const sources = new Map<string, DecisionFollowUpSource>();
    const revisions = new Map<string, DocRevision | null>();
    for (const item of items) {
      try {
        sources.set(item.linkId, readDecisionSource(dependencies, request, item.issue.projectId, item.linkId, scope, revisions));
      } catch (error) {
        if (!(error instanceof DecisionFollowUpError) || error.status !== 404) throw error;
      }
    }
    const routeProject = reportProject ?? destination ?? page.items[0].issue.projectId;
    const { content, issueIds } = buildDecisionFollowUpDraftContent({ page, items, filters, projectNames, assigneeNames, sources,
      href: reportHref(routeProject, reportProject, filters, teamReport),
    });
    return dependencies.createDocument(request, { documentId: randomUUID(), projectId: destination, title, actorId, createdAt: page.generatedAt }, content, issueIds);
  }, 'decision-follow-up-draft');
}

export function registerDecisionFollowUpRoutes(app: Express, dependencies: Dependencies): void {
  app.get('/api/decision-follow-ups', (request, response) => {
    const filters = parseQuery(request.query, TEAM_DECISION_FOLLOW_UP_QUERY_PARAMETERS);
    const projectId = request.query.projectId === undefined ? null : projectIdentifier(request.query.projectId);
    response.set('Cache-Control', 'no-store').json(listDecisions(dependencies, projectId, dependencies.projectScope(request), filters, true).page);
  });
  app.get('/api/projects/:id/decision-follow-ups', (request, response) => {
    response.set('Cache-Control', 'no-store').json(listDecisions(dependencies, projectIdentifier(request.params.id),
      dependencies.projectScope(request), parseQuery(request.query), false).page);
  });
  app.get('/api/projects/:id/decision-follow-ups/:linkId/source', (request, response) => {
    if (Object.keys(request.query).length) throw new DecisionFollowUpError(400, '결정 근거 원문의 조회 조건을 확인해 주세요.');
    response.set('Cache-Control', 'no-store').json(readDecisionSource(dependencies, request, projectIdentifier(request.params.id),
      identifier(request.params.linkId, '결정 근거 연결 ID를 확인해 주세요.'), dependencies.projectScope(request)));
  });
  for (const [path, teamReport] of [
    ['/api/projects/:id/decision-follow-ups/meeting-draft', false], ['/api/decision-follow-ups/meeting-draft', true],
  ] as const) {
    app.post(path, (request, response) => {
      response.set('Cache-Control', 'no-store');
      const draft = createDraft(request, dependencies, teamReport);
      response.status(draft.duplicate ? 200 : 201).json(draft);
    });
  }
}
