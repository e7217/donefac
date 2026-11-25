import { isRelationId } from './issue-relations.js';

export const cycleCompletionRecordParameter = 'completionRecord';

export function readCycleCompletionRecordId(parameters: URLSearchParams): string | null {
  const values = parameters.getAll(cycleCompletionRecordParameter);
  return values.length === 1 && isRelationId(values[0]) ? values[0] : null;
}

export function cycleCompletionRecordHash(projectId: string, recordId: string): string {
  return `#/${encodeURIComponent(projectId)}/planning?${new URLSearchParams({ [cycleCompletionRecordParameter]: recordId })}`;
}
