import type { IssueRelationType, LegacyRecord } from '../shared/types.js';

export interface JiraIssueRelationSource {
  sourceAlias: string;
  targetAlias: string;
  storedSourceAlias: string;
  storedTargetAlias: string;
  stableSourceId: string | null;
  typeName: string;
  typeId: string | null;
  nativeType: IssueRelationType | null;
}

const numericId = /^[1-9]\d{0,24}$/;
const jiraIssueAlias = /^(?:[1-9]\d{0,24}|[A-Z][A-Z0-9_]*-[1-9]\d*)$/;
const asString = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const label = (value: unknown) => asString(value).trim().replace(/\s+/gu, ' ').toLowerCase();

function nativeType(name: string, outward: string, inward: string): IssueRelationType | null {
  const type = label(name);
  if (type === 'blocks' && outward === 'blocks' && ['is blocked by', 'blocked by'].includes(inward)) return 'blocks';
  if (['duplicates', 'duplicate'].includes(type) && outward === 'duplicates' && ['is duplicated by', 'duplicated by'].includes(inward)) return 'duplicates';
  if (['relates', 'related', 'relates to'].includes(type) && outward === 'relates to' && inward === 'relates to') return 'related';
  return null;
}

function searchNativeType(name: string, description: string, inward: boolean): IssueRelationType | null {
  const outward = inward ? '' : description;
  const inside = inward ? description : '';
  if (label(name) === 'blocks' && (outward === 'blocks' || ['is blocked by', 'blocked by'].includes(inside))) return 'blocks';
  if (['duplicates', 'duplicate'].includes(label(name)) &&
      (outward === 'duplicates' || ['is duplicated by', 'duplicated by'].includes(inside))) return 'duplicates';
  if (['relates', 'related', 'relates to'].includes(label(name)) && description === 'relates to') return 'related';
  return null;
}

export function jiraIssueRelationSource(record: LegacyRecord): JiraIssueRelationSource | null {
  if (record.kind !== 'relation' || record.references.length !== 2 || record.metadata.style === 'jira_subtask' ||
      record.metadata.jiraRelationConflict === true) return null;
  const source = record.references.find(ref => ref.kind === 'issue' && ref.relation === 'source');
  const target = record.references.find(ref => ref.kind === 'issue' && ref.relation === 'target');
  if (!source || !target || !jiraIssueAlias.test(source.sourceId) || !jiraIssueAlias.test(target.sourceId)) return null;

  const { metadata } = record;
  const direction = metadata.direction;
  const rest = direction === 'inward' || direction === 'outward';
  const search = direction === 'inwardlinks' || direction === 'outwardlinks';
  const databaseId = asString(metadata.typeId);
  if (!rest && !search && !(direction === undefined && numericId.test(databaseId))) return null;
  const inward = direction === 'inward' || direction === 'inwardlinks';
  const typeIdValue = rest ? asString(metadata.id) : search ? asString(metadata.originalTypeId) : databaseId;
  const typeName = record.title || 'related';
  if (typeName.length > 120 || !typeName.trim() || /[\x00-\x1f\x7f]/.test(typeName)) return null;
  return {
    sourceAlias: inward ? target.sourceId : source.sourceId,
    targetAlias: inward ? source.sourceId : target.sourceId,
    storedSourceAlias: source.sourceId,
    storedTargetAlias: target.sourceId,
    stableSourceId: numericId.test(record.sourceId) ? record.sourceId : null,
    typeName,
    typeId: numericId.test(typeIdValue) ? typeIdValue : null,
    nativeType: search ? searchNativeType(typeName, label(metadata.description), inward) :
      nativeType(typeName, label(metadata.outward), label(metadata.inward)),
  };
}

export function jiraRelationEndpoints(link: JiraIssueRelationSource, source: string, target: string): [string, string] {
  return link.nativeType === 'related' && source > target ? [target, source] : [source, target];
}

export function sameJiraRelationType(left: JiraIssueRelationSource, right: JiraIssueRelationSource): boolean {
  return left.typeId && right.typeId ? left.typeId === right.typeId : label(left.typeName) === label(right.typeName);
}
