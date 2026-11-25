import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import {
  DELIVERY_BLOCKER_REASONS, RELEASE_BLOCKER_REASONS, type DeliveryBlockerDraftResult, type DeliveryBlockerReason, type DeliveryBlockerRelease, type DeliveryBlockerReport,
  type DeliveryBlockerRow, type Dependency, type DocPage, type GitlabLink, type Issue,
  type PlanningItem, type ProjectWorkflow, type ReportSnapshot, type RichContent, type SavedView, type User,
} from '../shared/types.js';
import { isRelationId } from '../shared/issue-relations.js';
import { createIssueViewMatcher, issueViewUsesCurrentUser } from '../shared/issue-view.js';
import type { CalendarService } from './calendars.js';
import { buildDeliveryBlockers, hasGitlabDeliveryBlocker } from './delivery-blockers.js';
import { buildDeliveryBlockerDraftContent } from './delivery-blocker-draft-content.js';
import type { DocumentCreationService } from './document-creation.js';
import type { IssueRelationsService } from './issue-relations.js';
import type { IssueSchemaService } from './issue-schema.js';
import type { Store } from './store.js';

const PAGE_SIZE = 20;
const TARGET_LIMIT = 10_000;
const CONNECTION_LIMIT = 50_000;
const GITLAB_LIMIT = 100_000;
const parameters = new Set(['savedViewId', 'releaseId', 'reason', 'offset', 'revision']);
const draftFields = new Set(['savedViewId', 'releaseId', 'reason', 'revision', 'title', 'requestId']);
const reasons = [...DELIVERY_BLOCKER_REASONS, ...RELEASE_BLOCKER_REASONS];
type Selection = { savedViewId: string | null; releaseId: string | null; reason: DeliveryBlockerReason | null; offset: number; revision: string | null };
type DocumentCapture = Pick<ReportSnapshot, 'documentId' | 'projectId' | 'title' | 'actorId' | 'createdAt'>;
type Sources = {
  store: Store;
  schemas: IssueSchemaService;
  calendars: CalendarService;
  issueRelations: Pick<IssueRelationsService, 'directBlockers'>;
  projectScope: (request: Request) => readonly string[] | null;
  actor: (request: Request) => string;
  viewer: (request: Request) => string | undefined;
  documentCreation: DocumentCreationService;
  createDocument: (request: Request, capture: DocumentCapture, content: RichContent, issueIds: string[]) => DocPage;
};

class DeliveryBlockerQueryError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { reason: 'stale_report' }) { super(message); }
}

function selectionFor(query: Request['query']): Selection {
  const { savedViewId, releaseId, reason, offset, revision } = query;
  const selectedReason = reasons.find(value => value === reason);
  if (Object.keys(query).some(key => !parameters.has(key)) ||
      (savedViewId !== undefined && !isRelationId(savedViewId)) ||
      (releaseId !== undefined && !isRelationId(releaseId)) ||
      (reason !== undefined && !selectedReason) ||
      (offset !== undefined && (typeof offset !== 'string' || !/^\d{1,5}$/.test(offset) || Number(offset) > TARGET_LIMIT)) ||
      (revision !== undefined && (typeof revision !== 'string' || !/^[0-9a-f]{64}$/u.test(revision)))) {
    throw new DeliveryBlockerQueryError(400, '진행 차단 보고서 조회 조건을 확인해 주세요.');
  }
  if (Number(offset) > 0 && !revision) throw new DeliveryBlockerQueryError(400, '다음 페이지를 읽으려면 조회한 보고서의 버전이 필요합니다.');
  if (!releaseId && RELEASE_BLOCKER_REASONS.some(value => value === selectedReason)) {
    throw new DeliveryBlockerQueryError(400, '릴리스 일정 원인을 보려면 릴리스를 선택해 주세요.');
  }
  return {
    savedViewId: savedViewId ?? null,
    releaseId: releaseId ?? null,
    reason: selectedReason ?? null,
    offset: Number(offset ?? 0),
    revision: typeof revision === 'string' ? revision : null,
  };
}

function matchesReason(row: DeliveryBlockerRow, reason: DeliveryBlockerReason | null): boolean {
  switch (reason) {
    case 'issue_block': return row.blockers.total > 0;
    case 'schedule_conflict': return row.scheduleConflicts.total > 0;
    case 'gitlab': return hasGitlabDeliveryBlocker(row.gitlab);
    case 'missing_schedule': return Boolean(row.releaseSchedule?.missing.length);
    case 'after_release_date': return row.releaseSchedule?.afterDeadline === true;
    default: return true;
  }
}

const decode = <T>(row: { json?: unknown }): T => JSON.parse(String(row.json)) as T;

function reportFor(
  projectId: string, selection: Selection, allowedProjects: readonly string[] | null, viewerId: string | undefined,
  { store, schemas, calendars, issueRelations }: Sources,
): DeliveryBlockerReport {
  const schema = schemas.get(projectId);
  const view = selection.savedViewId ? store.get<SavedView>('saved_views', selection.savedViewId) : undefined;
  if (selection.savedViewId && view?.projectId !== projectId) {
    throw new DeliveryBlockerQueryError(404, '이 프로젝트에서 저장된 보기를 찾을 수 없습니다.');
  }
  const releaseItem = selection.releaseId ? store.get<PlanningItem>('planning_items', selection.releaseId) : undefined;
  if (selection.releaseId && (releaseItem?.projectId !== projectId || releaseItem.kind !== 'release')) {
    throw new DeliveryBlockerQueryError(404, '이 프로젝트에서 릴리스를 찾을 수 없습니다.');
  }
  const deadlineSource = releaseItem?.targetDate ? 'targetDate' : releaseItem?.endDate ? 'endDate' : null;
  const release: DeliveryBlockerRelease | undefined = releaseItem && {
    id: releaseItem.id, name: releaseItem.name, version: releaseItem.version,
    deadline: deadlineSource ? releaseItem[deadlineSource] : null, deadlineSource,
  };
  const users = store.all<User>('users');
  const issueSchemas = [schema];
  const candidateMatch = view ? createIssueViewMatcher({ ...view.filters, gitlab: undefined }, { issueSchemas, users }, schema, viewerId) : null;
  const candidates: Issue[] = [];
  for (const result of store.db.prepare(`SELECT json FROM issues WHERE project_id=?
    AND (? IS NULL OR json_extract(json,'$.releaseId')=?)`).iterate(projectId, selection.releaseId, selection.releaseId)) {
    const issue = decode<Issue>(result);
    if (candidateMatch && !candidateMatch(issue)) continue;
    if (candidates.length >= TARGET_LIMIT) {
      throw new DeliveryBlockerQueryError(413, '한 번에 업무 10,000개까지 확인할 수 있습니다. 저장된 보기로 대상을 좁혀 주세요.');
    }
    candidates.push(issue);
  }
  const candidateIds = JSON.stringify(candidates.map(issue => issue.id));
  const gitlabRows = store.db.prepare(`SELECT link.json FROM json_each(?) AS choices
    JOIN gitlab_links AS link ON link.issue_id=choices.value LIMIT ?`).all(candidateIds, GITLAB_LIMIT + 1);
  if (gitlabRows.length > GITLAB_LIMIT) throw new DeliveryBlockerQueryError(413, '업무에 연결된 GitLab 활동이 100,000개를 넘습니다. 저장된 보기로 대상을 좁혀 주세요.');
  const gitlabLinks = gitlabRows.map(row => decode<GitlabLink>(row));
  const targets = view?.filters.gitlab
    ? candidates.filter(createIssueViewMatcher(view.filters, { issueSchemas, users, gitlabLinks }, schema, viewerId))
    : candidates;
  const targetIssueIds = targets.map(issue => issue.id);
  const blockers = issueRelations.directBlockers(targetIssueIds, allowedProjects, CONNECTION_LIMIT + 1);
  const dependencyRows = store.db.prepare(`SELECT dependency.json FROM json_each(?) AS choices
    JOIN dependencies AS dependency ON dependency.successor_id=choices.value
    JOIN issues AS source ON source.id=dependency.predecessor_id AND source.project_id=? LIMIT ?`)
    .all(JSON.stringify(targetIssueIds), projectId, CONNECTION_LIMIT + 1);
  if (blockers.length + dependencyRows.length > CONNECTION_LIMIT) {
    throw new DeliveryBlockerQueryError(413, '한 번에 업무와 일정 연결 50,000개까지 확인할 수 있습니다. 저장된 보기로 대상을 좁혀 주세요.');
  }
  const dependencies = dependencyRows.map(row => decode<Dependency>(row));
  const sourceIds = [...new Set([...blockers.map(blocker => blocker.sourceIssueId), ...dependencies.map(dependency => dependency.predecessorId)])];
  const sources = store.db.prepare(`SELECT issue.json FROM json_each(?) AS selected
    JOIN issues AS issue ON issue.id=selected.value`).all(JSON.stringify(sourceIds)).map(row => decode<Issue>(row));

  const { rows, counts } = buildDeliveryBlockers({
    targets, sources, blockers, dependencies, gitlabLinks, calendar: calendars.get(projectId), release,
    data: { issueSchemas, users, workflows: store.all<ProjectWorkflow>('workflows') },
  });
  const savedView = view ? { id: view.id, name: view.name, version: view.version } : null;
  const releaseRevision = release ? [release, targets.map(({ id, version }) => [id, version] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)] : [];
  const viewerRevision = view && issueViewUsesCurrentUser(view.filters) ? [viewerId ?? null] : [];
  const revision = createHash('sha256').update(JSON.stringify([projectId, savedView, selection.reason, counts, rows,
    ...releaseRevision, ...viewerRevision])).digest('hex');
  if (selection.revision && selection.revision !== revision) {
    throw new DeliveryBlockerQueryError(409, '조회 이후 진행 차단 내용이 바뀌었습니다. 첫 페이지부터 다시 조회해 주세요.', { reason: 'stale_report' });
  }
  const selectedRows = rows.filter(row => matchesReason(row, selection.reason));
  return {
    projectId, generatedAt: new Date().toISOString(), savedView, ...(release ? { release } : {}), reason: selection.reason, revision, counts,
    total: selectedRows.length, offset: selection.offset, limit: PAGE_SIZE,
    items: selectedRows.slice(selection.offset, selection.offset + PAGE_SIZE),
  };
}

function createDraft(req: Request, projectId: string, sources: Sources): DeliveryBlockerDraftResult {
  const { savedViewId, releaseId, reason, revision, title: inputTitle, requestId } = req.body;
  if (Object.keys(req.body).some(field => !draftFields.has(field)) || Object.keys(req.query).length) {
    throw new DeliveryBlockerQueryError(400, '진행 차단 회의 초안의 입력을 확인해 주세요.');
  }
  const title = typeof inputTitle === 'string' ? inputTitle.trim() : '';
  if (!title || title.length > 200) throw new DeliveryBlockerQueryError(400, '회의 초안 제목을 1~200자로 입력해 주세요.');
  const selection = selectionFor({ savedViewId, releaseId, reason, revision });
  if (!selection.revision) throw new DeliveryBlockerQueryError(400, '조회한 진행 차단 보고서의 버전이 필요합니다.');
  const actorId = sources.actor(req);
  return sources.documentCreation.create(actorId, {
    requestId, projectId, title, savedViewId: selection.savedViewId, reason: selection.reason, revision: selection.revision,
    ...(selection.releaseId ? { releaseId: selection.releaseId } : {}),
  }, () => {
    const report = reportFor(projectId, selection, sources.projectScope(req), sources.viewer(req), sources);
    if (!report.total) throw new DeliveryBlockerQueryError(422, '회의 초안에 담을 차단 업무가 없습니다.');
    const filters = new URLSearchParams();
    if (selection.releaseId) filters.set('release', selection.releaseId);
    if (selection.savedViewId) filters.set('savedView', selection.savedViewId);
    if (selection.reason) filters.set('reason', selection.reason);
    const href = `#/${encodeURIComponent(projectId)}/reports/blockers${filters.size ? `?${filters}` : ''}`;
    const { content, issueIds } = buildDeliveryBlockerDraftContent(report, href);
    return sources.createDocument(req, {
      documentId: randomUUID(), projectId, title, actorId, createdAt: report.generatedAt,
    }, content, issueIds);
  }, 'delivery-blocker-draft');
}

export function registerDeliveryBlockerRoutes(app: Express, sources: Sources) {
  sources.store.db.exec('CREATE INDEX IF NOT EXISTS dependencies_by_successor ON dependencies(successor_id)');
  const path = '/api/projects/:projectId/delivery-blockers';
  app.get(path, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const projectId = String(req.params.projectId);
      const selection = selectionFor(req.query);
      const allowedProjects = sources.projectScope(req);
      const report = sources.store.transaction(() => reportFor(projectId, selection, allowedProjects, sources.viewer(req), sources));
      res.json(report);
    } catch (error) {
      if (!(error instanceof DeliveryBlockerQueryError)) throw error;
      res.status(error.status).json({ error: error.message, details: error.details });
    }
  });
  app.post(`${path}/meeting-draft`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const draft = createDraft(req, String(req.params.projectId), sources);
      res.status(draft.duplicate ? 200 : 201).json(draft);
    } catch (error) {
      if (!(error instanceof DeliveryBlockerQueryError)) throw error;
      res.status(error.status).json({ error: error.message, details: error.details });
    }
  });
}
