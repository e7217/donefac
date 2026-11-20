import type { LegacyRecord, LegacyValue } from '../shared/types.js';
import { isJiraWorklog, isRestrictedJiraWorklog } from './migration-worklog.js';

export type JiraHistoryKind = 'comment' | 'worklog';

export function jiraHistoryKind(record: LegacyRecord): JiraHistoryKind | null {
  return record.kind === 'comment' ? 'comment' : isJiraWorklog(record) ? 'worklog' : null;
}

export function jiraHistorySourceKey(record: LegacyRecord): { kind: JiraHistoryKind; sourceId: string } | null {
  const kind = jiraHistoryKind(record);
  if (!kind || record.metadata.syntheticId === true) return null;
  const { sourceId } = record;
  const originalId = kind === 'worklog' && sourceId.startsWith('worklog:') ? sourceId.slice('worklog:'.length) : sourceId;
  // Position-based fallbacks have colon-delimited issue IDs and row indices.
  return /^[a-z\d][a-z\d_.-]{0,199}$/i.test(originalId) && (kind === 'comment' || originalId !== sourceId)
    ? { kind, sourceId } : null;
}

const ownerRelations = new Set(['commentOn', 'worklogOf', 'historyOf', 'container-content', 'body-owner', 'attachedTo']);

export function jiraHistoryOwnerAliases(record: LegacyRecord): string[] | null {
  const kind = jiraHistoryKind(record);
  const relation = kind === 'comment' ? 'commentOn' : 'worklogOf';
  const references = record.references.filter(reference => ownerRelations.has(reference.relation));
  if (!kind || !record.containerId || !references.length || references.some(reference =>
    reference.kind !== 'issue' || reference.relation !== relation || !reference.sourceId)) return null;
  return [...new Set([record.containerId, ...references.map(reference => reference.sourceId)])];
}

const commentRestrictionNames = new Set([
  'level', 'role', 'roleid', 'rolekey', 'rolelevel', 'group', 'groupid', 'groupkey', 'groupname', 'grouplevel',
  'restricted', 'isrestricted', 'hasrestrictions', 'restriction', 'restrictions', 'restrictiontype', 'restrictionvalue',
  'viewrole', 'viewrolelevel', 'viewgroup', 'viewgrouplevel', 'permissions', 'internal',
]);

const attributeName = (name: string) => name.replace(/[\s_-]/g, '').toLowerCase();

export function isJiraCommentRestrictionAttribute(name: string): boolean {
  const normalized = attributeName(name);
  return commentRestrictionNames.has(normalized) || normalized === 'public' || normalized === 'visibility' || normalized === 'properties';
}

function nonemptyRestriction(value: LegacyValue): boolean {
  if (value == null || value === false) return false;
  if (typeof value === 'string') return !['', 'false', '0'].includes(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.some(nonemptyRestriction);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return value !== 0;
}

function restrictedCommentProperty(value: LegacyValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { key, value: details } = value;
  if (typeof key !== 'string' || key.toLowerCase() !== 'sd.public.comment') return false;
  if (!details || typeof details !== 'object' || Array.isArray(details) ||
      !Object.hasOwn(details, 'internal') && !Object.hasOwn(details, 'public')) return true;
  return nonemptyRestriction(details.internal) || details.public === false || details.public === 'false';
}

export function isRestrictedJiraHistory(record: LegacyRecord): boolean {
  if (isJiraWorklog(record)) return isRestrictedJiraWorklog(record);
  if (record.kind !== 'comment') return false;
  return Object.entries(record.metadata).some(([name, value]) => {
    const normalized = attributeName(name);
    if (normalized === 'public') return value === false || value === 'false' || value === 0 || value === '0';
    if (normalized === 'properties') return Array.isArray(value) ? value.some(restrictedCommentProperty) : nonemptyRestriction(value);
    if (normalized === 'visibility') {
      // Older staged JSON encoded service-desk properties in the visibility field.
      return Array.isArray(value) ? value.some(property => !property || typeof property !== 'object' || Array.isArray(property) ||
        typeof property.key !== 'string' || restrictedCommentProperty(property)) : nonemptyRestriction(value);
    }
    return commentRestrictionNames.has(normalized) && nonemptyRestriction(value);
  });
}

const issueSecurityFields = new Set(['security', 'securitylevel', 'issuesecuritylevel']);

export function isRestrictedJiraHistoryOwner(record: LegacyRecord): boolean {
  if (record.kind !== 'issue') return false;
  const fields = record.metadata.fields;
  return fields !== null && typeof fields === 'object' && !Array.isArray(fields) && Object.entries(fields).some(([name, value]) =>
    issueSecurityFields.has(attributeName(name)) && nonemptyRestriction(value));
}
