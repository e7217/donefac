import { createHash } from 'node:crypto';
import type { Express, Request } from 'express';
import {
  DELIVERY_BLOCKER_REASONS, type DeliveryBlockerReason, type DeliveryBlockerReport, type DeliveryBlockerRow,
  type Dependency, type GitlabLink, type Issue, type IssueRelation, type ProjectWorkflow, type SavedView, type User,
} from '../shared/types.js';
import { createIssueViewMatcher } from '../shared/issue-view.js';
import type { CalendarService } from './calendars.js';
import { buildDeliveryBlockers } from './delivery-blockers.js';
import type { IssueSchemaService } from './issue-schema.js';
import type { Store } from './store.js';

const PAGE_SIZE = 20;
const TARGET_LIMIT = 10_000;
const CONNECTION_LIMIT = 50_000;
const GITLAB_LIMIT = 100_000;
const parameters = new Set(['savedViewId', 'reason', 'offset', 'revision']);
type Selection = { savedViewId: string | null; reason: DeliveryBlockerReason | null; offset: number; revision: string | null };
type Sources = {
  store: Store;
  schemas: IssueSchemaService;
  calendars: CalendarService;
  projectScope: (request: Request) => readonly string[] | null;
};

class DeliveryBlockerQueryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function selectionFor(query: Request['query']): Selection {
  const { savedViewId, reason, offset, revision } = query;
  if (Object.keys(query).some(key => !parameters.has(key)) ||
      (savedViewId !== undefined && (typeof savedViewId !== 'string' || !savedViewId.trim() ||
        savedViewId.length > 200 || /[\u0000-\u001f\u007f]/u.test(savedViewId))) ||
      (reason !== undefined && !DELIVERY_BLOCKER_REASONS.some(value => value === reason)) ||
      (offset !== undefined && (typeof offset !== 'string' || !/^\d{1,5}$/.test(offset) || Number(offset) > TARGET_LIMIT)) ||
      (revision !== undefined && (typeof revision !== 'string' || !/^[0-9a-f]{64}$/u.test(revision)))) {
    throw new DeliveryBlockerQueryError(400, '진행 차단 보고서 조회 조건을 확인해 주세요.');
  }
  if (Number(offset) > 0 && !revision) throw new DeliveryBlockerQueryError(400, '다음 페이지를 읽으려면 조회한 보고서의 버전이 필요합니다.');
  return {
    savedViewId: typeof savedViewId === 'string' ? savedViewId : null,
    reason: DELIVERY_BLOCKER_REASONS.find(value => value === reason) ?? null,
    offset: Number(offset ?? 0),
    revision: typeof revision === 'string' ? revision : null,
  };
}

function matchesReason(row: DeliveryBlockerRow, reason: DeliveryBlockerReason | null): boolean {
  switch (reason) {
    case 'issue_block': return row.blockers.total > 0;
    case 'schedule_conflict': return row.scheduleConflicts.total > 0;
    case 'gitlab': return row.gitlab.blockedMergeRequests > 0 || row.gitlab.failedPipelines > 0;
    default: return true;
  }
}

const decode = <T>(row: { json?: unknown }): T => JSON.parse(String(row.json)) as T;

function reportFor(
  projectId: string, selection: Selection, allowedProjects: readonly string[] | null,
  { store, schemas, calendars }: Sources,
): DeliveryBlockerReport {
  const schema = schemas.get(projectId);
  const view = selection.savedViewId ? store.get<SavedView>('saved_views', selection.savedViewId) : undefined;
  if (selection.savedViewId && view?.projectId !== projectId) {
    throw new DeliveryBlockerQueryError(404, '이 프로젝트에서 저장된 보기를 찾을 수 없습니다.');
  }
  const users = store.all<User>('users');
  const issueSchemas = [schema];
  const candidateMatch = view ? createIssueViewMatcher({ ...view.filters, gitlab: undefined }, { issueSchemas, users }, schema) : null;
  const candidates: Issue[] = [];
  for (const result of store.db.prepare('SELECT json FROM issues WHERE project_id=?').iterate(projectId)) {
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
    ? candidates.filter(createIssueViewMatcher(view.filters, { issueSchemas, users, gitlabLinks }, schema))
    : candidates;
  const targetIds = JSON.stringify(targets.map(issue => issue.id));
  const relationRows = store.db.prepare(`SELECT relation.json FROM json_each(?) AS choices
    JOIN issue_relations AS relation ON relation.target_issue_id=choices.value
    JOIN issues AS source ON source.id=relation.source_issue_id
    WHERE json_extract(relation.json,'$.origin')='teamspace' AND json_extract(relation.json,'$.type')='blocks'
      AND (? IS NULL OR source.project_id IN (SELECT value FROM json_each(?))) LIMIT ?`)
    .all(targetIds, allowedProjects ? 1 : null, JSON.stringify(allowedProjects), CONNECTION_LIMIT + 1);
  const dependencyRows = store.db.prepare(`SELECT dependency.json FROM json_each(?) AS choices
    JOIN dependencies AS dependency ON dependency.successor_id=choices.value
    JOIN issues AS source ON source.id=dependency.predecessor_id AND source.project_id=? LIMIT ?`)
    .all(targetIds, projectId, CONNECTION_LIMIT + 1);
  if (relationRows.length + dependencyRows.length > CONNECTION_LIMIT) {
    throw new DeliveryBlockerQueryError(413, '한 번에 업무와 일정 연결 50,000개까지 확인할 수 있습니다. 저장된 보기로 대상을 좁혀 주세요.');
  }
  const relations = relationRows.map(row => decode<IssueRelation>(row));
  const dependencies = dependencyRows.map(row => decode<Dependency>(row));
  const sourceIds = [...new Set([...relations.map(relation => relation.sourceIssueId), ...dependencies.map(dependency => dependency.predecessorId)])];
  const sources = store.db.prepare(`SELECT issue.json FROM json_each(?) AS selected
    JOIN issues AS issue ON issue.id=selected.value`).all(JSON.stringify(sourceIds)).map(row => decode<Issue>(row));

  const { rows, counts } = buildDeliveryBlockers({
    targets, sources, relations, dependencies, gitlabLinks, calendar: calendars.get(projectId),
    data: { issueSchemas, users, workflows: store.all<ProjectWorkflow>('workflows') },
  });
  const savedView = view ? { id: view.id, name: view.name, version: view.version } : null;
  const revision = createHash('sha256').update(JSON.stringify([projectId, savedView, selection.reason, counts, rows])).digest('hex');
  if (selection.revision && selection.revision !== revision) {
    throw new DeliveryBlockerQueryError(409, '조회 이후 진행 차단 내용이 바뀌었습니다. 첫 페이지부터 다시 조회해 주세요.');
  }
  const selectedRows = rows.filter(row => matchesReason(row, selection.reason));
  return {
    projectId, generatedAt: new Date().toISOString(), savedView, reason: selection.reason, revision, counts,
    total: selectedRows.length, offset: selection.offset, limit: PAGE_SIZE,
    items: selectedRows.slice(selection.offset, selection.offset + PAGE_SIZE),
  };
}

export function registerDeliveryBlockerRoutes(app: Express, sources: Sources) {
  sources.store.db.exec('CREATE INDEX IF NOT EXISTS dependencies_by_successor ON dependencies(successor_id)');
  app.get('/api/projects/:projectId/delivery-blockers', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const projectId = String(req.params.projectId);
      const selection = selectionFor(req.query);
      const allowedProjects = sources.projectScope(req);
      const report = sources.store.transaction(() => reportFor(projectId, selection, allowedProjects, sources));
      res.json(report);
    } catch (error) {
      if (!(error instanceof DeliveryBlockerQueryError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
}
