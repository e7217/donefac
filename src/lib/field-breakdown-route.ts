import { ISSUE_FIELD_BREAKDOWN_DIMENSIONS, type IssueFieldBreakdownDimension } from '../../shared/types';
import { isRelationId } from '../../shared/issue-relations';

export interface FieldBreakdownScope {
  fieldId?: string;
  groupBy?: IssueFieldBreakdownDimension;
  savedViewId?: string;
  comparisonBy?: IssueFieldBreakdownDimension;
  comparisonFieldId?: string;
  invalid?: true;
}

const queryKeys = ['fieldId', 'groupBy', 'savedView', 'comparisonBy', 'comparisonFieldId'] as const;
const dimension = (value: string | null) => ISSUE_FIELD_BREAKDOWN_DIMENSIONS.find(candidate => candidate === value);
const isScopeId = (value: string) => isRelationId(value) && value.isWellFormed() && value === value.trim();

export function readFieldBreakdownScope(parameters: URLSearchParams): FieldBreakdownScope {
  const fieldId = parameters.get('fieldId');
  const savedViewId = parameters.get('savedView');
  const requestedGroup = parameters.get('groupBy');
  const requestedComparison = parameters.get('comparisonBy');
  const comparisonFieldId = parameters.get('comparisonFieldId');
  const groupBy = dimension(requestedGroup);
  const comparisonBy = dimension(requestedComparison);
  if (parameters.has('invalid') || queryKeys.some(key => parameters.getAll(key).length > 1) ||
      (fieldId !== null && (!isScopeId(fieldId) || requestedGroup !== null)) ||
      (savedViewId !== null && !isScopeId(savedViewId)) ||
      (requestedGroup !== null && !groupBy) ||
      (requestedComparison !== null && (!comparisonBy || (!fieldId && !groupBy) || groupBy === comparisonBy)) ||
      (comparisonFieldId !== null && (!isScopeId(comparisonFieldId) || requestedComparison !== null ||
        (!fieldId && !groupBy) || fieldId === comparisonFieldId))) {
    return { invalid: true };
  }
  return {
    ...(fieldId !== null ? { fieldId } : {}), ...(groupBy ? { groupBy } : {}),
    ...(savedViewId !== null ? { savedViewId } : {}), ...(comparisonBy ? { comparisonBy } : {}),
    ...(comparisonFieldId !== null ? { comparisonFieldId } : {}),
  };
}

export function fieldBreakdownParameters(scope: FieldBreakdownScope): URLSearchParams {
  const parameters = new URLSearchParams();
  if (scope.invalid) {
    parameters.set('invalid', '1');
    return parameters;
  }
  if (scope.fieldId) parameters.set('fieldId', scope.fieldId);
  if (scope.groupBy) parameters.set('groupBy', scope.groupBy);
  if (scope.savedViewId) parameters.set('savedView', scope.savedViewId);
  if (scope.comparisonBy) parameters.set('comparisonBy', scope.comparisonBy);
  if (scope.comparisonFieldId) parameters.set('comparisonFieldId', scope.comparisonFieldId);
  return parameters;
}

export function sameFieldBreakdownScope(left?: FieldBreakdownScope | null, right?: FieldBreakdownScope | null): boolean {
  return Boolean(left) === Boolean(right) && left?.fieldId === right?.fieldId && left?.groupBy === right?.groupBy &&
    left?.savedViewId === right?.savedViewId && left?.comparisonBy === right?.comparisonBy &&
    left?.comparisonFieldId === right?.comparisonFieldId && left?.invalid === right?.invalid;
}

export function fieldBreakdownHash(projectId: string, scope: FieldBreakdownScope): string {
  const parameters = fieldBreakdownParameters(scope).toString();
  return `#/${encodeURIComponent(projectId)}/reports/fields${parameters ? `?${parameters}` : ''}`;
}
