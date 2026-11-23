import type { LegacyRecord } from '../shared/types.js';

export function confluenceParentEvidence(record: LegacyRecord): string | null | undefined {
  if (record.kind !== 'page' || record.metadata.sourceClass !== 'Page') return undefined;
  const id = record.metadata.confluenceParentSourceId;
  if (id === null && record.parentId === null) return null;
  if (typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && id === record.parentId) return id;
  return undefined;
}
