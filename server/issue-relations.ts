import { randomUUID } from 'node:crypto';
import { isIssueRelationDirection, isIssueRelationType, isRelationId, isTeamspaceIssueRelation, issueRelationEndpoints, type TeamspaceIssueRelation } from '../shared/issue-relations.js';
import type { Issue, IssueRelation, IssueRelationView, TeamScheduleBlocker } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import { findTeamspaceIssueRelation, nextIssueRelationVersion, recordIssueRelationVersion } from './issue-relation-persistence.js';
import type { SourcePreservationService } from './source-preservation.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type RelationChange = '업무 관계 추가' | '업무 관계 수정' | '업무 관계 해제';
type Audit = (issueId: string, action: RelationChange, detail: string) => void;
type NotifyChange = (before: IssueRelation | undefined, after: IssueRelation | undefined) => void;
type Row = { json: string };

export class IssueRelationError extends Error {
  constructor(readonly status: number, message: string,
    readonly details?: { currentVersion: number; reason?: 'source_version_changed' | 'target_version_changed' }) { super(message); }
}

function relationInput(input: unknown, key: 'otherIssueId' | 'expectedVersion') {
  const allowed = ['type', 'direction', key, 'actorId'];
  if (key === 'expectedVersion') allowed.push('requestId', 'expectedRestoreGeneration');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(field => !allowed.includes(field))) {
    throw new IssueRelationError(400, '업무 관계 요청을 확인해 주세요.');
  }
  const { type, direction, [key]: value, requestId, expectedRestoreGeneration } = input as Record<string, unknown>;
  if (!isIssueRelationType(type) || !isIssueRelationDirection(direction)) {
    throw new IssueRelationError(400, '업무 관계 유형과 방향을 확인해 주세요.');
  }
  return { type, direction, value, requestId, expectedRestoreGeneration };
}

function verifyVersion(relation: IssueRelation, version: unknown) {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new IssueRelationError(400, '업무 관계의 expectedVersion이 필요합니다.');
  }
  if (relation.version !== version) {
    throw new IssueRelationError(409, '다른 작업자가 업무 관계를 변경했습니다. 최신 관계를 확인해 주세요.', { currentVersion: relation.version });
  }
}

export function listIssueRelations(store: Store, issueId: string, allowedProjects: readonly string[] | null = null): IssueRelation[] {
  const scope = allowedProjects ? JSON.stringify(allowedProjects) : null;
  const rows = store.db.prepare(`SELECT relation.json FROM issue_relations relation
    JOIN issues source ON source.id=relation.source_issue_id
    JOIN issues target ON target.id=relation.target_issue_id
    WHERE (relation.source_issue_id=? OR relation.target_issue_id=?)
      AND (? IS NULL OR (source.project_id IN (SELECT value FROM json_each(?)) AND target.project_id IN (SELECT value FROM json_each(?))))
    ORDER BY relation.rowid`).all(issueId, issueId, scope, scope, scope) as Row[];
  return rows.map(row => JSON.parse(row.json) as IssueRelation);
}

function teamspaceBlockers(store: Store, { targetIds, issueIds, allowedProjects = null, crossProjectOnly = false, sameProjectOnly = false, limit }: {
  targetIds?: readonly string[]; issueIds?: readonly string[]; allowedProjects?: readonly string[] | null;
  crossProjectOnly?: boolean; sameProjectOnly?: boolean; limit?: number;
}): TeamScheduleBlocker[] {
  if (targetIds?.length === 0 || issueIds?.length === 0 || allowedProjects?.length === 0 || limit === 0) return [];
  const scope = allowedProjects ? JSON.stringify(allowedProjects) : null;
  const targetSql = targetIds ? 'AND relation.target_issue_id IN (SELECT value FROM json_each(?))' : '';
  const issueScope = issueIds ? JSON.stringify(issueIds) : undefined;
  const incidentSql = issueScope === undefined ? '' : `AND (relation.source_issue_id IN (SELECT value FROM json_each(?))
      OR relation.target_issue_id IN (SELECT value FROM json_each(?)))`;
  return store.db.prepare(`SELECT relation.id,
    relation.source_issue_id AS sourceIssueId, relation.target_issue_id AS targetIssueId,
    json_extract(relation.json, '$.version') AS version
    FROM issue_relations AS relation
    JOIN issues AS source ON source.id=relation.source_issue_id
    JOIN issues AS target ON target.id=relation.target_issue_id
    WHERE json_extract(relation.json, '$.origin')='teamspace' AND json_extract(relation.json, '$.type')='blocks'
      AND source.id<>target.id ${targetSql} ${incidentSql}
      AND (?=0 OR source.project_id<>target.project_id)
      AND (?=0 OR source.project_id=target.project_id)
      AND (? IS NULL OR (source.project_id IN (SELECT value FROM json_each(?)) AND target.project_id IN (SELECT value FROM json_each(?))))
    ORDER BY relation.source_issue_id, relation.target_issue_id LIMIT ?`)
    .all(...(targetIds ? [JSON.stringify(targetIds)] : []), ...(issueScope === undefined ? [] : [issueScope, issueScope]),
      Number(crossProjectOnly), Number(sameProjectOnly),
      scope, scope, scope, limit ?? -1) as TeamScheduleBlocker[];
}

export function directTeamspaceBlockers(store: Store, targetIds: readonly string[], allowedProjects: readonly string[] | null = null,
  limit?: number): TeamScheduleBlocker[] {
  return teamspaceBlockers(store, { targetIds, allowedProjects, limit });
}

function mergeBlockers(native: TeamScheduleBlocker[], imported: TeamScheduleBlocker[], limit = Infinity): TeamScheduleBlocker[] {
  const pair = ({ sourceIssueId, targetIssueId }: TeamScheduleBlocker) => JSON.stringify([sourceIssueId, targetIssueId]);
  const seen = new Set(native.map(pair));
  const blockers = [...native];
  for (const relation of imported) {
    if (blockers.length >= limit) break;
    const key = pair(relation);
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push(relation);
  }
  return blockers;
}

const labels = {
  related: ['관련 업무', '관련 업무'],
  blocks: ['상대 업무를 차단', '상대 업무에 의해 차단'],
  duplicates: ['상대 업무의 중복', '중복 업무의 원본'],
} as const;

export class IssueRelationsService {
  constructor(private readonly store: Store, private readonly sources: Pick<SourcePreservationService, 'jiraIssueBlockers'>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_relation_update_requests (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, applied_version INTEGER NOT NULL
    )`);
  }

  list(issueId: string, allowedProjects: readonly string[] | null = null): IssueRelationView[] {
    const issue = this.requireIssue(issueId);
    if (allowedProjects && !allowedProjects.includes(issue.projectId)) {
      throw new IssueRelationError(403, '이 프로젝트의 업무 관계를 확인할 수 없습니다.');
    }
    const relations = listIssueRelations(this.store, issueId, allowedProjects).map(relation => {
      const view: IssueRelationView = { ...relation };
      // Direction is derived from live proof, including for old archived rows.
      delete view.verifiedBlockerDirection;
      return view;
    });
    if (!relations.some(relation => relation.origin === undefined)) return relations;
    const native = relations.filter(isTeamspaceIssueRelation)
      .filter(relation => relation.type === 'blocks')
      .map(({ id, sourceIssueId, targetIssueId, version }) => ({ id, sourceIssueId, targetIssueId, version }));
    const imported = this.sources.jiraIssueBlockers({ issueIds: [issueId], allowedProjects });
    const directions = new Map(mergeBlockers(native, imported).filter(relation => relation.origin === 'jira')
      .map(relation => [relation.id, relation.sourceIssueId === issueId ? 'outgoing' : 'incoming'] as const));
    return relations.map(relation => {
      const verifiedBlockerDirection = directions.get(relation.id);
      if (verifiedBlockerDirection) relation.verifiedBlockerDirection = verifiedBlockerDirection;
      return relation;
    });
  }

  directBlockers(targetIds: readonly string[], allowedProjects: readonly string[] | null = null, limit?: number): TeamScheduleBlocker[] {
    if (!targetIds.length || allowedProjects?.length === 0 || limit === 0) return [];
    const native = directTeamspaceBlockers(this.store, targetIds, allowedProjects, limit);
    if (limit !== undefined && native.length >= limit) return native;
    const targets = new Set(targetIds);
    const imported = this.sources.jiraIssueBlockers({ issueIds: targetIds, allowedProjects })
      .filter(relation => targets.has(relation.targetIssueId));
    return mergeBlockers(native, imported, limit);
  }

  teamScheduleBlockers(issueIds?: readonly string[]): TeamScheduleBlocker[] {
    const scope = { crossProjectOnly: true, issueIds };
    return mergeBlockers(teamspaceBlockers(this.store, scope), this.sources.jiraIssueBlockers(scope));
  }

  localScheduleBlockers(allowedProjects: readonly string[] | null): TeamScheduleBlocker[] {
    const scope = { allowedProjects, sameProjectOnly: true };
    return mergeBlockers(teamspaceBlockers(this.store, scope), this.sources.jiraIssueBlockers(scope));
  }

  create(issueId: string, input: unknown, audit: Audit, notifyChange: NotifyChange): { relation: IssueRelation; created: boolean } {
    return this.store.transaction(() => this.createInTransaction(issueId, input, audit, notifyChange));
  }

  createTeamBlocker(input: unknown, isTerminal: (issue: Issue) => boolean, audit: Audit, notifyChange: NotifyChange): {
    relation: IssueRelation; created: boolean;
  } {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4) {
      throw new IssueRelationError(400, '프로젝트 간 차단 관계 요청을 확인해 주세요.');
    }
    const { sourceIssueId, targetIssueId, expectedSourceVersion, expectedTargetVersion } = input as Record<string, unknown>;
    if (!isRelationId(sourceIssueId) || !isRelationId(targetIssueId) || sourceIssueId === targetIssueId ||
        ![expectedSourceVersion, expectedTargetVersion].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
      throw new IssueRelationError(400, '두 업무와 확인한 업무 버전을 보내 주세요.');
    }
    return this.store.transaction(() => {
      const source = this.requireIssue(sourceIssueId);
      const target = this.requireIssue(targetIssueId);
      if (source.projectId === target.projectId) {
        throw new IssueRelationError(409, '서로 다른 프로젝트의 업무를 선택해 주세요.');
      }
      if (isTerminal(source) || isTerminal(target)) {
        throw new IssueRelationError(409, '완료 또는 취소된 업무는 프로젝트 간 차단에 추가할 수 없습니다.');
      }
      const staleSource = source.version !== expectedSourceVersion;
      if (staleSource || target.version !== expectedTargetVersion) {
        const existing = findTeamspaceIssueRelation(this.store, { sourceIssueId, targetIssueId, type: 'blocks' });
        if (existing) return { relation: existing, created: false };
        throw new IssueRelationError(409, `${staleSource ? '차단하는 업무' : '차단되는 업무'}가 변경되었습니다. 최신 업무를 확인해 주세요.`, {
          currentVersion: staleSource ? source.version : target.version,
          reason: staleSource ? 'source_version_changed' : 'target_version_changed',
        });
      }
      return this.createInTransaction(source.id, { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' }, audit, notifyChange);
    });
  }

  createDuplicateInTransaction(issueId: string, originalIssueId: string, audit: Audit, notifyChange: NotifyChange): { relation: IssueRelation; created: boolean } {
    if (!this.store.db.isTransaction) throw new Error('Closing a duplicate issue requires a transaction.');
    if (!isRelationId(issueId) || !isRelationId(originalIssueId) || issueId === originalIssueId) {
      throw new IssueRelationError(400, '중복인 업무와 원본 업무를 서로 다르게 선택해 주세요.');
    }
    this.requireIssue(issueId);
    this.requireIssue(originalIssueId);
    const conflictingOriginal = this.store.db.prepare(`SELECT 1 FROM issue_relations
      WHERE source_issue_id=? AND target_issue_id<>?
        AND json_extract(json,'$.origin')='teamspace' AND json_extract(json,'$.type')='duplicates' LIMIT 1`)
      .get(issueId, originalIssueId);
    if (conflictingOriginal) throw new IssueRelationError(409, '이미 다른 업무가 이 중복 업무의 원본으로 지정되어 있습니다.');

    // UNION visits each original once, including when existing links already contain a cycle.
    const cycle = this.store.db.prepare(`WITH RECURSIVE originals(id) AS (
      SELECT ?
      UNION
      SELECT relation.target_issue_id FROM issue_relations AS relation JOIN originals ON relation.source_issue_id=originals.id
      WHERE json_extract(relation.json,'$.origin')='teamspace' AND json_extract(relation.json,'$.type')='duplicates'
    ) SELECT 1 FROM originals WHERE id=? LIMIT 1`).get(originalIssueId, issueId);
    if (cycle) throw new IssueRelationError(409, '중복 업무 관계가 순환하므로 원본으로 지정할 수 없습니다.');
    return this.createInTransaction(issueId, { otherIssueId: originalIssueId, type: 'duplicates', direction: 'outgoing' }, audit, notifyChange);
  }

  createInTransaction(issueId: string, input: unknown, audit: Audit, notifyChange: NotifyChange): { relation: IssueRelation; created: boolean } {
    if (!this.store.db.isTransaction) throw new Error('Creating an issue relation requires a transaction.');
    const { type, direction, value: otherId } = relationInput(input, 'otherIssueId');
    if (!isRelationId(issueId) || !isRelationId(otherId)) {
      throw new IssueRelationError(400, '연결할 업무를 선택해 주세요.');
    }
    if (issueId === otherId) throw new IssueRelationError(400, '업무를 자기 자신에게 연결할 수 없습니다.');

    const issue = this.requireIssue(issueId);
    const other = this.requireIssue(otherId);
    const endpoints = issueRelationEndpoints(issue.id, other.id, type, direction);
    const existing = findTeamspaceIssueRelation(this.store, { ...endpoints, type });
    if (existing) return { relation: existing, created: false };

    const relation: TeamspaceIssueRelation = { id: randomUUID(), ...endpoints, origin: 'teamspace', type, version: 1, createdAt: new Date().toISOString() };
    this.store.db.prepare('INSERT INTO issue_relations(id,source_issue_id,target_issue_id,json) VALUES(?,?,?,?)')
      .run(relation.id, relation.sourceIssueId, relation.targetIssueId, JSON.stringify(relation));
    recordIssueRelationVersion(this.store, relation.version);
    this.recordActivity(issue, other, relation, '업무 관계 추가', audit);
    notifyChange(undefined, relation);
    return { relation, created: true };
  }

  update(issueId: string, relationId: string, actorId: string, input: unknown, audit: Audit, notifyChange: NotifyChange): IssueRelation {
    const { type, direction, value: expectedVersion, requestId, expectedRestoreGeneration } = relationInput(input, 'expectedVersion');
    return this.store.transaction(() => {
      const receipt = this.relationUpdateRequest(requestId, expectedRestoreGeneration, {
        scope: [actorId, issueId, relationId], type, direction, expectedVersion, expectedRestoreGeneration,
      });
      const { issue, other, relation } = this.requireLocalRelation(issueId, relationId);
      if (receipt?.appliedVersion !== undefined) {
        if (relation.version < receipt.appliedVersion) {
          throw new IssueRelationError(409, '수정한 업무 관계의 현재 버전을 확인할 수 없습니다.');
        }
        return relation;
      }
      verifyVersion(relation, expectedVersion);
      const endpoints = issueRelationEndpoints(issue.id, other.id, type, direction);
      if (relation.type === type && relation.sourceIssueId === endpoints.sourceIssueId && relation.targetIssueId === endpoints.targetIssueId) {
        this.recordRelationUpdate(receipt, relation.version);
        return relation;
      }
      if (findTeamspaceIssueRelation(this.store, { ...endpoints, type })) throw new IssueRelationError(409, '같은 업무 관계가 이미 있습니다.');

      const updated: TeamspaceIssueRelation = { ...relation, ...endpoints, type, version: nextIssueRelationVersion(relation.version) };
      this.store.db.prepare('UPDATE issue_relations SET source_issue_id=?,target_issue_id=?,json=? WHERE id=?')
        .run(updated.sourceIssueId, updated.targetIssueId, JSON.stringify(updated), updated.id);
      recordIssueRelationVersion(this.store, updated.version);
      this.recordActivity(issue, other, updated, '업무 관계 수정', audit);
      notifyChange(relation, updated);
      this.recordRelationUpdate(receipt, updated.version);
      return updated;
    });
  }

  private relationUpdateRequest(requestId: unknown, generation: unknown, payload: Record<string, unknown>) {
    if (requestId === undefined && generation === undefined) return undefined;
    if (typeof requestId !== 'string' || !creationRequestId.test(requestId) || typeof generation !== 'string' || !generation) {
      throw new IssueRelationError(400, '업무 관계 수정 요청 ID와 워크스페이스 세대를 확인해 주세요.');
    }
    if (generation !== workspaceRestoreGeneration(this.store)) {
      throw new IssueRelationError(409, '워크스페이스가 복원되었습니다. 새로고침한 뒤 현재 업무 관계를 확인해 주세요.');
    }
    const id = requestId.toLowerCase();
    const fingerprint = creationRequestFingerprint(payload);
    const receipt = this.store.db.prepare(`SELECT fingerprint,applied_version AS appliedVersion
      FROM issue_relation_update_requests WHERE id=?`).get(id) as { fingerprint: string; appliedVersion: number } | undefined;
    if (receipt && receipt.fingerprint !== fingerprint) {
      throw new IssueRelationError(409, '이미 사용한 업무 관계 수정 요청입니다. 현재 업무 관계를 확인해 주세요.');
    }
    return { id, fingerprint, appliedVersion: receipt?.appliedVersion };
  }

  private recordRelationUpdate(request: { id: string; fingerprint: string } | undefined, version: number) {
    if (!request) return;
    this.store.db.prepare('INSERT INTO issue_relation_update_requests(id,fingerprint,applied_version) VALUES(?,?,?)')
      .run(request.id, request.fingerprint, version);
  }

  remove(issueId: string, relationId: string, expected: unknown, audit: Audit, notifyChange: NotifyChange): void {
    const expectedVersion = typeof expected === 'string' && /^\d+$/.test(expected) ? Number(expected) : undefined;
    this.store.transaction(() => this.removeInTransaction(issueId, relationId, expectedVersion, audit, notifyChange));
  }

  removeInTransaction(issueId: string, relationId: string, expectedVersion: number | undefined, audit: Audit, notifyChange: NotifyChange): void {
    if (!this.store.db.isTransaction) throw new Error('Removing an issue relation requires a transaction.');
    const { issue, other, relation } = this.requireLocalRelation(issueId, relationId);
    verifyVersion(relation, expectedVersion);
    this.store.remove('issue_relations', relation.id);
    this.recordActivity(issue, other, relation, '업무 관계 해제', audit);
    notifyChange(relation, undefined);
  }

  private requireIssue(id: string): Issue {
    const issue = this.store.get<Issue>('issues', id);
    if (!issue) throw new IssueRelationError(404, '연결된 업무를 찾을 수 없습니다.');
    return issue;
  }

  private requireLocalRelation(issueId: string, relationId: string) {
    const issue = this.requireIssue(issueId);
    const relation = this.store.get<IssueRelation>('issue_relations', relationId);
    if (!relation || (relation.sourceIssueId !== issueId && relation.targetIssueId !== issueId)) {
      throw new IssueRelationError(404, '업무 관계를 찾을 수 없습니다.');
    }
    if (!isTeamspaceIssueRelation(relation)) throw new IssueRelationError(409, '이관한 업무 관계는 읽기 전용입니다.');
    const other = this.requireIssue(relation.sourceIssueId === issueId ? relation.targetIssueId : relation.sourceIssueId);
    return { issue, other, relation };
  }

  private recordActivity(issue: Issue, other: Issue, relation: TeamspaceIssueRelation, action: RelationChange, audit: Audit) {
    const [outgoing, incoming] = labels[relation.type];
    const [source, target] = relation.sourceIssueId === issue.id ? [issue, other] : [other, issue];
    audit(source.id, action, `${outgoing} · ${target.key}`);
    audit(target.id, action, `${incoming} · ${source.key}`);
  }
}
