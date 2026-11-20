import { createHash } from 'node:crypto';
import { hasCustomValue } from '../shared/issue-schema.js';
import type { CustomFieldDefinition, CustomFieldValue, LegacyRecord, LegacyValue } from '../shared/types.js';

export function jiraCustomSourceFieldId(sourceFieldId: string): string {
  const jiraId = /^(?:customfield_)?([1-9]\d*)$/.exec(sourceFieldId)?.[1];
  return jiraId ? `customfield_${jiraId}` : sourceFieldId;
}

export function jiraCustomSourceFieldAliases(sourceFieldId: string): string[] {
  const canonical = jiraCustomSourceFieldId(sourceFieldId);
  const numeric = /^customfield_([1-9]\d*)$/.exec(canonical)?.[1];
  return numeric ? [sourceFieldId, sourceFieldId === numeric ? canonical : numeric] : [sourceFieldId];
}

export function jiraCustomRawField(record: LegacyRecord, sourceFieldId: string, explicitEmpty = false): LegacyValue | undefined {
  const fields = record.metadata.fields;
  if (fields !== null && typeof fields === 'object' && !Array.isArray(fields)) {
    const key = [sourceFieldId, sourceFieldId.replace(/^csv:/, '')].find(key => Object.hasOwn(fields, key));
    if (key !== undefined) return fields[key];
  }
  const observed = record.metadata.jiraSnapshotCustomFields;
  return explicitEmpty && Array.isArray(observed) && observed.includes(sourceFieldId) ? null : undefined;
}

export function jiraCustomValueDigest(field: CustomFieldDefinition, value: CustomFieldValue | undefined): string {
  const normalized = !hasCustomValue(value) ? null : Array.isArray(value) ? [...new Set(value)].sort() : value;
  return createHash('sha256').update(JSON.stringify([field.id, field.kind, normalized])).digest('hex');
}
