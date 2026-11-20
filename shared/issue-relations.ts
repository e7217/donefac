import type { IssueRelation, IssueRelationDirection, IssueRelationType } from './types.js';

export type TeamspaceIssueRelation = IssueRelation & { origin: 'teamspace'; type: IssueRelationType };
export type IssueRelationScheduleMode = 'fixed-direction' | 'choose-direction';

export function isIssueRelationType(value: unknown): value is IssueRelationType {
  return value === 'related' || value === 'blocks' || value === 'duplicates';
}

export function isIssueRelationDirection(value: unknown): value is IssueRelationDirection {
  return value === 'outgoing' || value === 'incoming';
}

export function issueRelationEndpoints(issueId: string, otherIssueId: string, type: IssueRelationType, direction: IssueRelationDirection) {
  const issueIsSource = type === 'related' ? issueId < otherIssueId : direction === 'outgoing';
  return issueIsSource ? { sourceIssueId: issueId, targetIssueId: otherIssueId }
    : { sourceIssueId: otherIssueId, targetIssueId: issueId };
}

export function isTeamspaceIssueRelation(value: IssueRelation): value is TeamspaceIssueRelation {
  return value.origin === 'teamspace' && isIssueRelationType(value.type);
}

export function issueRelationScheduleMode(relation: IssueRelation): IssueRelationScheduleMode | null {
  if (isTeamspaceIssueRelation(relation)) return relation.type === 'blocks' ? 'fixed-direction' : null;
  if (relation.origin !== undefined) return null;
  const label = relation.type.trim().replace(/\s+/gu, ' ').toLowerCase();
  return label === 'blocks' || label === 'is blocked by' || label === 'blocked by' ? 'choose-direction' : null;
}

export function isRelationId(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
}

export function isCanonicalTeamspaceIssueRelation(value: Record<string, unknown>): boolean {
  const { id, sourceIssueId, targetIssueId, type, version } = value;
  return value.origin === 'teamspace' && isIssueRelationType(type)
    && isRelationId(id) && isRelationId(sourceIssueId) && isRelationId(targetIssueId) && sourceIssueId !== targetIssueId
    && (type !== 'related' || sourceIssueId < targetIssueId)
    && typeof version === 'number' && Number.isSafeInteger(version) && version > 0 && version < Number.MAX_SAFE_INTEGER;
}

export function hasDuplicateTeamspaceIssueRelations(relations: readonly TeamspaceIssueRelation[]): boolean {
  const seen = new Set<string>();
  for (const relation of relations) {
    const key = JSON.stringify([relation.sourceIssueId, relation.targetIssueId, relation.type]);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
