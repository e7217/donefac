import type { JiraIssueStatusValue, LegacyRecord, LegacyValue } from '../shared/types.js';
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

function jiraChildOwnerAliases(record: LegacyRecord, relation: string): string[] | null {
  const references = record.references.filter(reference => ownerRelations.has(reference.relation));
  if (!record.containerId || !references.length || references.some(reference =>
    reference.kind !== 'issue' || reference.relation !== relation || !reference.sourceId)) return null;
  return [...new Set([record.containerId, ...references.map(reference => reference.sourceId)])];
}

export function jiraHistoryOwnerAliases(record: LegacyRecord): string[] | null {
  const kind = jiraHistoryKind(record);
  return kind ? jiraChildOwnerAliases(record, kind === 'comment' ? 'commentOn' : 'worklogOf') : null;
}

export function jiraAttachmentSourceId(record: LegacyRecord): string | null {
  return record.kind === 'attachment' && record.metadata.syntheticId !== true &&
    /^[a-z\d][a-z\d_.-]{0,199}$/i.test(record.sourceId) ? record.sourceId : null;
}

export function jiraAttachmentOwnerAliases(record: LegacyRecord): string[] | null {
  return record.kind === 'attachment' ? jiraChildOwnerAliases(record, 'attachedTo') : null;
}

export function jiraAttachmentFileEvidence(record: LegacyRecord): { path: string; size: number; sha256: string } | null {
  const { bytesPresent, actualSize, size: declaredSize, sha256, path } = record.metadata;
  // Each Jira attachment ID identifies its own file. A version relationship
  // from another format does not prove the origin of a Jira attachment.
  if (record.kind !== 'attachment' || bytesPresent !== true || record.metadata.currentVersionId || record.metadata.originalVersionId ||
      record.references.some(ref => ref.relation === 'current-version' || ref.relation === 'original-version') ||
      typeof path !== 'string' || !path || record.metadata.packagePath && record.metadata.packagePath !== path ||
      typeof actualSize !== 'number' || !Number.isSafeInteger(actualSize) || actualSize < 1 ||
      typeof sha256 !== 'string' || !/^[a-f\d]{64}$/.test(sha256)) return null;
  if (declaredSize !== null && declaredSize !== undefined && declaredSize !== '' &&
      (typeof declaredSize !== 'number' && (typeof declaredSize !== 'string' || !/^\d+$/.test(declaredSize.trim())) ||
      Number(declaredSize) !== actualSize)) return null;
  return { path, size: actualSize, sha256 };
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

const serviceDeskCommentKeys = new Set(['sd.public.comment', 'sd.allow.public.comment']);

export function isJiraServiceDeskCommentKey(value: unknown): value is string {
  return typeof value === 'string' && serviceDeskCommentKeys.has(value.toLowerCase());
}

function restrictedCommentProperty(value: LegacyValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { key, value: details } = value;
  if (!isJiraServiceDeskCommentKey(key)) return false;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return true;
  const expectedPublic: [string, boolean][] = [['internal', false], ['public', true]];
  if (key.toLowerCase() === 'sd.allow.public.comment') expectedPublic.push(['allow', true]);
  const flags = expectedPublic.filter(([name]) => Object.hasOwn(details, name));
  return !flags.length || flags.some(([name, expected]) => {
    const flag = details[name];
    return flag !== expected && (typeof flag !== 'string' || flag.trim().toLowerCase() !== String(expected));
  });
}

export function hasRestrictedJiraServiceDeskComment(metadata: LegacyRecord['metadata']): boolean {
  return Object.entries(metadata).some(([name, value]) =>
    ['properties', 'visibility', 'jiraservicedeskcommentproperties'].includes(attributeName(name)) &&
    Array.isArray(value) && value.some(restrictedCommentProperty));
}

function hasJiraVisibilityRestriction(metadata: LegacyRecord['metadata']): boolean {
  return Object.entries(metadata).some(([name, value]) => {
    const normalized = attributeName(name);
    if (normalized === 'public') return value === false || value === 'false' || value === 0 || value === '0';
    if (normalized === 'properties' || normalized === 'jiraservicedeskcommentproperties') {
      return Array.isArray(value) ? value.some(restrictedCommentProperty) : nonemptyRestriction(value);
    }
    if (normalized === 'visibility') {
      // Older staged JSON encoded service-desk properties in the visibility field.
      return Array.isArray(value) ? value.some(property => !property || typeof property !== 'object' || Array.isArray(property) ||
        typeof property.key !== 'string' || restrictedCommentProperty(property)) : nonemptyRestriction(value);
    }
    return commentRestrictionNames.has(normalized) && nonemptyRestriction(value);
  });
}

export function isRestrictedJiraHistory(record: LegacyRecord): boolean {
  return isJiraWorklog(record) ? isRestrictedJiraWorklog(record) : record.kind === 'comment' && hasJiraVisibilityRestriction(record.metadata);
}

export function isRestrictedJiraStatusHistory(record: LegacyRecord): boolean {
  if (record.kind !== 'history' || isJiraWorklog(record)) return false;
  const { items } = record.metadata;
  return hasJiraVisibilityRestriction(record.metadata) || (Array.isArray(items) && items.some(item =>
    item !== null && typeof item === 'object' && !Array.isArray(item) && hasJiraVisibilityRestriction(item)));
}

export function jiraStatusHistoryOwnerAliases(record: LegacyRecord): string[] | null {
  return record.kind === 'history' && !isJiraWorklog(record) ? jiraChildOwnerAliases(record, 'historyOf') : null;
}

function statusText(value: unknown, limit: number): string | null {
  const raw = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  return raw.trim() && raw.length <= limit && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : null;
}

function readJiraStatusTransitions(record: LegacyRecord): { position: number; from: JiraIssueStatusValue; to: JiraIssueStatusValue }[] {
  const items = record.metadata.items;
  if (record.kind !== 'history' || isJiraWorklog(record) || !Array.isArray(items)) return [];
  const normalized = (value: unknown) => statusText(value, 200)?.trim().toLowerCase();
  return items.flatMap((item, position) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const fieldId = normalized(item.fieldId);
    const types = [item.fieldtype, item.fieldType].map(normalized).filter(type => type !== undefined);
    if ((fieldId ? fieldId !== 'status' : normalized(item.field) !== 'status') ||
        types.some(type => type !== 'jira' && type !== 'system')) return [];
    const from = { id: statusText(item.from, 200) ?? statusText(item.oldvalue, 200), label: statusText(item.fromString, 500) ?? statusText(item.oldstring, 500) };
    const to = { id: statusText(item.to, 200) ?? statusText(item.newvalue, 200), label: statusText(item.toString, 500) ?? statusText(item.newstring, 500) };
    if ((!from.id && !from.label && !to.id && !to.label) || (from.id === to.id && from.label === to.label)) return [];
    return [{ position, from, to }];
  });
}

/** Read status fields supplied by Jira, independent of Teamspace's current workflow. */
export function jiraStatusTransitions(record: LegacyRecord) {
  return isRestrictedJiraStatusHistory(record) ? [] : readJiraStatusTransitions(record);
}

/** Audit counts include recognized changes on restricted records without projecting their contents. */
export function countJiraStatusTransitions(record: LegacyRecord): number {
  return readJiraStatusTransitions(record).length;
}

export function isRestrictedJiraAttachment(record: LegacyRecord): boolean {
  return record.kind === 'attachment' && hasJiraVisibilityRestriction(record.metadata);
}

const issueSecurityFields = new Set(['security', 'securitylevel', 'issuesecuritylevel']);

export function isRestrictedJiraHistoryOwner(record: LegacyRecord): boolean {
  if (record.kind !== 'issue') return false;
  const fields = record.metadata.fields;
  return fields !== null && typeof fields === 'object' && !Array.isArray(fields) && Object.entries(fields).some(([name, value]) =>
    issueSecurityFields.has(attributeName(name)) && nonemptyRestriction(value));
}
