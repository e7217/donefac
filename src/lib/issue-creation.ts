import type { Issue } from '../../shared/types';
import { api, ApiError } from './api';
import { newRequestId } from './request-id';

export type IssueCreationAttempt = {
  readonly actorId: string;
  readonly body: string;
};

export function createIssueAttempt(actorId: string, input: Record<string, unknown>): IssueCreationAttempt {
  return { actorId, body: JSON.stringify({ ...input, requestId: newRequestId() }) };
}

export async function requestIssueCreation(attempt: IssueCreationAttempt, projectId: string, path = '/issues'): Promise<Issue> {
  const issue = await api<Issue>(path, {
    method: 'POST', headers: { 'X-Actor-Id': attempt.actorId }, body: attempt.body,
  });
  if (typeof issue?.id !== 'string' || !issue.id || typeof issue.key !== 'string' || !issue.key || issue.projectId !== projectId) {
    throw new Error('업무 생성 응답을 읽을 수 없습니다.');
  }
  return issue;
}

export function isDefiniteIssueCreationFailure(error: unknown, replay = false): boolean {
  if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) return false;
  if (replay && (error.status === 401 || error.status === 403)) return false;
  return ![408, 425, 429, 499].includes(error.status);
}
