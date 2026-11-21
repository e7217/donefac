export type DecisionFollowUpScope = {
  status: 'open' | 'closed' | 'all';
  assigneeId: string;
  q: string;
  offset: number;
};

export const MAX_DECISION_FOLLOW_UP_SEARCH_LENGTH = 160;
export const DEFAULT_DECISION_FOLLOW_UP_SCOPE: DecisionFollowUpScope = { status: 'open', assigneeId: '', q: '', offset: 0 };

export function decisionFollowUpParameters(scope: DecisionFollowUpScope): URLSearchParams {
  const parameters = new URLSearchParams();
  if (scope.status !== 'open') parameters.set('status', scope.status);
  if (scope.assigneeId) parameters.set('assigneeId', scope.assigneeId);
  if (scope.q) parameters.set('q', scope.q);
  if (scope.offset) parameters.set('offset', String(scope.offset));
  return parameters;
}

export function readDecisionFollowUpScope(parameters: URLSearchParams, isKnownAssignee: (id: string) => boolean): DecisionFollowUpScope {
  const { status, assigneeId, q, offset } = DEFAULT_DECISION_FOLLOW_UP_SCOPE;
  const requestedStatus = parameters.get('status');
  const requestedAssignee = parameters.get('assigneeId');
  const query = parameters.get('q')?.trim() ?? '';
  const position = parameters.get('offset') ?? '';
  return {
    status: requestedStatus === 'closed' || requestedStatus === 'all' ? requestedStatus : status,
    assigneeId: requestedAssignee && (requestedAssignee === 'unassigned' || isKnownAssignee(requestedAssignee)) ? requestedAssignee : assigneeId,
    q: query.length <= MAX_DECISION_FOLLOW_UP_SEARCH_LENGTH && query.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(query) ? query : q,
    offset: /^\d{1,7}$/u.test(position) && Number(position) <= 1_000_000 ? Number(position) : offset,
  };
}

export function sameDecisionFollowUpScope(left?: DecisionFollowUpScope | null, right?: DecisionFollowUpScope | null): boolean {
  return left?.status === right?.status && left?.assigneeId === right?.assigneeId && left?.q === right?.q && left?.offset === right?.offset;
}
