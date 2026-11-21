import { randomUUID } from 'node:crypto';
import { isIssueRelationDirection, isIssueRelationType, isRelationId, isTeamspaceIssueRelation, issueRelationEndpoints, type TeamspaceIssueRelation } from '../shared/issue-relations.js';
import type { Issue, IssueRelation } from '../shared/types.js';
import { findTeamspaceIssueRelation, nextIssueRelationVersion, recordIssueRelationVersion } from './issue-relation-persistence.js';
import type { Store } from './store.js';

type RelationChange = '업무 관계 추가' | '업무 관계 수정' | '업무 관계 해제';
type Audit = (issueId: string, action: RelationChange, detail: string) => void;
type NotifyChange = (before: IssueRelation | undefined, after: IssueRelation | undefined) => void;
type Row = { json: string };

export class IssueRelationError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { currentVersion: number }) { super(message); }
}

function relationInput(input: unknown, key: 'otherIssueId' | 'expectedVersion') {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(field => !['type', 'direction', key, 'actorId'].includes(field))) {
    throw new IssueRelationError(400, '업무 관계 요청을 확인해 주세요.');
  }
  const { type, direction, [key]: value } = input as Record<string, unknown>;
  if (!isIssueRelationType(type) || !isIssueRelationDirection(direction)) {
    throw new IssueRelationError(400, '업무 관계 유형과 방향을 확인해 주세요.');
  }
  return { type, direction, value };
}

function verifyVersion(relation: IssueRelation, version: unknown) {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new IssueRelationError(400, '업무 관계의 expectedVersion이 필요합니다.');
  }
  if (relation.version !== version) {
    throw new IssueRelationError(409, '다른 작업자가 업무 관계를 변경했습니다. 최신 관계를 확인해 주세요.', { currentVersion: relation.version });
  }
}

export function listIssueRelations(store: Store, issueId: string): IssueRelation[] {
  const rows = store.db.prepare('SELECT json FROM issue_relations WHERE source_issue_id=? OR target_issue_id=? ORDER BY rowid')
    .all(issueId, issueId) as Row[];
  return rows.map(row => JSON.parse(row.json) as IssueRelation);
}

const labels = {
  related: ['관련 업무', '관련 업무'],
  blocks: ['상대 업무를 차단', '상대 업무에 의해 차단'],
  duplicates: ['상대 업무의 중복', '중복 업무의 원본'],
} as const;

export class IssueRelationsService {
  constructor(private readonly store: Store) {}

  list(issueId: string): IssueRelation[] {
    this.requireIssue(issueId);
    return listIssueRelations(this.store, issueId);
  }

  create(issueId: string, input: unknown, audit: Audit, notifyChange: NotifyChange): { relation: IssueRelation; created: boolean } {
    return this.store.transaction(() => this.createInTransaction(issueId, input, audit, notifyChange));
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

  update(issueId: string, relationId: string, input: unknown, audit: Audit, notifyChange: NotifyChange): IssueRelation {
    const { type, direction, value: expectedVersion } = relationInput(input, 'expectedVersion');
    return this.store.transaction(() => {
      const { issue, other, relation } = this.requireLocalRelation(issueId, relationId);
      verifyVersion(relation, expectedVersion);
      const endpoints = issueRelationEndpoints(issue.id, other.id, type, direction);
      if (relation.type === type && relation.sourceIssueId === endpoints.sourceIssueId && relation.targetIssueId === endpoints.targetIssueId) {
        return relation;
      }
      if (findTeamspaceIssueRelation(this.store, { ...endpoints, type })) throw new IssueRelationError(409, '같은 업무 관계가 이미 있습니다.');

      const updated: TeamspaceIssueRelation = { ...relation, ...endpoints, type, version: nextIssueRelationVersion(relation.version) };
      this.store.db.prepare('UPDATE issue_relations SET source_issue_id=?,target_issue_id=?,json=? WHERE id=?')
        .run(updated.sourceIssueId, updated.targetIssueId, JSON.stringify(updated), updated.id);
      recordIssueRelationVersion(this.store, updated.version);
      this.recordActivity(issue, other, updated, '업무 관계 수정', audit);
      notifyChange(relation, updated);
      return updated;
    });
  }

  remove(issueId: string, relationId: string, expected: unknown, audit: Audit, notifyChange: NotifyChange): void {
    const expectedVersion = typeof expected === 'string' && /^\d+$/.test(expected) ? Number(expected) : undefined;
    this.store.transaction(() => {
      const { issue, other, relation } = this.requireLocalRelation(issueId, relationId);
      verifyVersion(relation, expectedVersion);
      this.store.remove('issue_relations', relation.id);
      this.recordActivity(issue, other, relation, '업무 관계 해제', audit);
      notifyChange(relation, undefined);
    });
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
