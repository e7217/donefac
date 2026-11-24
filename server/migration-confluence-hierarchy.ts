import type { LegacyRecord } from '../shared/types.js';

export function confluenceParentEvidence(record: LegacyRecord): string | null | undefined {
  if (record.kind !== 'page' || record.metadata.sourceClass !== 'Page') return undefined;
  const id = record.metadata.confluenceParentSourceId;
  if (id === null && record.parentId === null) return null;
  if (typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && id === record.parentId) return id;
  return undefined;
}

/** Null is unpositioned. Undefined is position data that cannot establish an order. */
export function confluencePositionEvidence(record: LegacyRecord): number | null | undefined {
  if (record.kind !== 'page' || record.metadata.sourceClass !== 'Page' || record.metadata.position == null) return null;
  if (typeof record.metadata.position !== 'string') return undefined;
  const value = record.metadata.position.trim();
  if (!value || value === '-1') return null;
  if (value.length > 16 || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const position = Number(value);
  return Number.isSafeInteger(position) ? position : undefined;
}
