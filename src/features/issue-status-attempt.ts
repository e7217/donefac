import type { IssueStatusChangeRequest, IssueStatusChangeResult } from '../../shared/types';
import { api } from '../lib/api';

export type StatusChangeAttempt = {
  actorId: string;
  issueId: string;
  projectId: string;
  issueKey: string;
  statusLabel: string;
  input: IssueStatusChangeRequest;
};

type Phase = 'awaiting' | 'confirmed';
export type SavedStatusChangeAttempt = StatusChangeAttempt & { phase: Phase };

export const statusChangeAttemptEvent = 'teamspace:status-change-attempt';
const key = (actorId: string, generation: string) => `teamspace:status-change:${JSON.stringify([actorId, generation])}`;

export function statusChangeAttemptSnapshot(actorId: string, generation: string) {
  if (!actorId || !generation) return '[]';
  try { return sessionStorage.getItem(key(actorId, generation)) ?? '[]'; }
  catch { return '[]'; }
}

export function readStatusChangeAttempts(raw: string, actorId: string, generation: string): SavedStatusChangeAttempt[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry: SavedStatusChangeAttempt | null) => {
      if (!entry || entry.actorId !== actorId || (entry.phase !== 'awaiting' && entry.phase !== 'confirmed') ||
          typeof entry.issueId !== 'string' || typeof entry.projectId !== 'string' || typeof entry.issueKey !== 'string' ||
          typeof entry.statusLabel !== 'string') return false;
      const input = entry.input;
      return input?.restoreGeneration === generation && typeof input.requestId === 'string' && typeof input.status === 'string' &&
        Number.isSafeInteger(input.expectedVersion) && Number.isSafeInteger(input.expectedWorkflowVersion) &&
        (input.comment === undefined || typeof input.comment?.body === 'string');
    });
  } catch { return []; }
}

export function saveStatusChangeAttempt(attempt: StatusChangeAttempt, phase: Phase | null) {
  const { actorId, input: { requestId, restoreGeneration } } = attempt;
  const attempts = readStatusChangeAttempts(statusChangeAttemptSnapshot(actorId, restoreGeneration), actorId, restoreGeneration)
    .filter(saved => saved.input.requestId !== requestId);
  if (phase) attempts.push({ ...attempt, phase });
  try {
    const scope = key(actorId, restoreGeneration);
    if (attempts.length) sessionStorage.setItem(scope, JSON.stringify(attempts));
    else sessionStorage.removeItem(scope);
    window.dispatchEvent(new Event(statusChangeAttemptEvent));
  } catch { /* The current dialog can still confirm its in-memory request. */ }
}

export async function confirmStatusChange(attempt: StatusChangeAttempt, signal?: AbortSignal) {
  const { actorId, issueId, projectId, input } = attempt;
  const timeout = AbortSignal.timeout(12_000);
  const result = await api<IssueStatusChangeResult>(`/issues/${encodeURIComponent(issueId)}/status-change`, {
    method: 'POST', headers: { 'X-Actor-Id': actorId }, body: JSON.stringify(input),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const { issue, receipt, duplicate } = result ?? {};
  const valid = receipt && issue && typeof duplicate === 'boolean' && receipt.requestId === input.requestId &&
    receipt.issueId === issueId && receipt.projectId === projectId && receipt.appliedVersion === input.expectedVersion + 1 &&
    receipt.status === input.status && (receipt.assigneeId === null || typeof receipt.assigneeId === 'string') &&
    (input.assigneeId === undefined || receipt.assigneeId === input.assigneeId) && receipt.priority === input.priority && receipt.dueDate === input.dueDate &&
    (input.comment ? typeof receipt.commentId === 'string' && receipt.commentId.length > 0 : receipt.commentId === null) &&
    issue.id === receipt.issueId && issue.projectId === receipt.projectId && Number.isSafeInteger(issue.version) &&
    (issue.version === receipt.appliedVersion ? issue.status === receipt.status && issue.assigneeId === receipt.assigneeId &&
      (receipt.priority === undefined || issue.priority === receipt.priority) && (receipt.dueDate === undefined || issue.dueDate === receipt.dueDate) :
      duplicate && issue.version > receipt.appliedVersion);
  if (!valid) throw new Error('상태 변경의 저장 결과를 확인하지 못했습니다.');
}
