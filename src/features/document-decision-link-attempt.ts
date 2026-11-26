import { DOCUMENT_SELECTION_TEXT_LIMIT } from '../../shared/document-selection';
import type { DocPage, DocumentDecisionSource, DocumentSourceSelection } from '../../shared/types';

export type DecisionLinkSource = Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'> & (
  { sourceSelection: DocumentSourceSelection } | { comment: { id: string; source: DocumentDecisionSource } }
);

export type DecisionLinkAttempt = {
  actorId: string;
  expectedRestoreGeneration: string;
  source: DecisionLinkSource;
  issueId: string;
  issueLabel: string;
  requestId: string;
  confirmedIssueKey?: string;
};

const key = (actorId: string, id: string, generation: string) => `teamspace:document-decision-link:${JSON.stringify([actorId, id, generation])}`;

function validSelection(selection: DocumentSourceSelection | undefined) {
  return Boolean(selection && Number.isSafeInteger(selection.from) && Number.isSafeInteger(selection.to) &&
    selection.from >= 0 && selection.to > selection.from && typeof selection.text === 'string' &&
    selection.text.trim() && selection.text.isWellFormed() && selection.text.length <= DOCUMENT_SELECTION_TEXT_LIMIT);
}

export function readDecisionLinkAttempt(actorId: string, id: string, generation: string): DecisionLinkAttempt | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(key(actorId, id, generation)) ?? 'null') as DecisionLinkAttempt | null;
    if (!attempt || attempt.actorId !== actorId || attempt.expectedRestoreGeneration !== generation ||
        !attempt.issueId || typeof attempt.issueId !== 'string' || typeof attempt.issueLabel !== 'string' ||
        typeof attempt.requestId !== 'string' || (attempt.confirmedIssueKey !== undefined && typeof attempt.confirmedIssueKey !== 'string')) return null;
    const { source } = attempt;
    if (source?.id !== id || typeof source.title !== 'string' || (source.projectId !== null && typeof source.projectId !== 'string') ||
        !Number.isSafeInteger(source.version) || source.version < 1) return null;
    if ('comment' in source) {
      if (typeof source.comment?.id !== 'string' || !validSelection(source.comment.source) || typeof source.comment.source.revisionId !== 'string') return null;
    } else if (!validSelection(source.sourceSelection)) return null;
    return attempt;
  } catch { return null; }
}

export function writeDecisionLinkAttempt(attempt: DecisionLinkAttempt, next: DecisionLinkAttempt | null) {
  const attemptKey = key(attempt.actorId, attempt.source.id, attempt.expectedRestoreGeneration);
  if (next) sessionStorage.setItem(attemptKey, JSON.stringify(next));
  else sessionStorage.removeItem(attemptKey);
}
