import type { IssueRelation } from '../shared/types.js';
import type { Store } from './store.js';

const relationVersionKey = 'issue.relationVersion';

export class IssueRelationVersionError extends Error {
  readonly status = 409;
  constructor() { super('업무 관계의 버전 범위를 초과했습니다.'); }
}

export function issueRelationVersionFloor(store: Store): number {
  const value: unknown = store.setting(relationVersionKey);
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// Retain the maximum even after deletion so older backups cannot revive a used version.
export function recordIssueRelationVersion(store: Store, version: number): void {
  if (version > issueRelationVersionFloor(store)) store.setSetting(relationVersionKey, version);
}

export function nextIssueRelationVersion(version: number, floor = 0): number {
  const next = Math.max(version, floor) + 1;
  if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) throw new IssueRelationVersionError();
  return next;
}

export function findTeamspaceIssueRelation(store: Store, relation: Pick<IssueRelation, 'sourceIssueId' | 'targetIssueId' | 'type'>): IssueRelation | undefined {
  const row = store.db.prepare(`SELECT json FROM issue_relations WHERE source_issue_id=? AND target_issue_id=?
    AND json_extract(json,'$.origin')='teamspace' AND json_extract(json,'$.type')=?`)
    .get(relation.sourceIssueId, relation.targetIssueId, relation.type) as {json: string} | undefined;
  return row && JSON.parse(row.json) as IssueRelation;
}
