import {
  ISSUE_FIELD_BREAKDOWN_DIMENSIONS, ISSUE_FIELD_BREAKDOWN_MEASURE_LABELS,
  type IssueFieldBreakdownDimension, type IssueFieldBreakdownMeasure,
} from '../../shared/types';
import { isRelationId } from '../../shared/issue-relations';

export interface FieldBreakdownScope {
  fieldId?: string;
  groupBy?: IssueFieldBreakdownDimension;
  savedViewId?: string;
  comparisonBy?: IssueFieldBreakdownDimension;
  comparisonFieldId?: string;
  measure?: IssueFieldBreakdownMeasure;
  invalid?: true;
}

const queryKeys = ['fieldId', 'groupBy', 'savedView', 'comparisonBy', 'comparisonFieldId', 'measure'] as const;
const dimension = (value: string | null) => ISSUE_FIELD_BREAKDOWN_DIMENSIONS.find(candidate => candidate === value);
const isScopeId = (value: string) => isRelationId(value) && value.isWellFormed() && value === value.trim();
const customMeasurePrefix = 'custom:';

export function readFieldBreakdownMeasure(value: string | null): IssueFieldBreakdownMeasure | undefined {
  if (value && Object.hasOwn(ISSUE_FIELD_BREAKDOWN_MEASURE_LABELS, value)) {
    return { kind: value as keyof typeof ISSUE_FIELD_BREAKDOWN_MEASURE_LABELS };
  }
  if (value?.startsWith(customMeasurePrefix)) {
    const fieldId = value.slice(customMeasurePrefix.length);
    if (isScopeId(fieldId)) return { kind: 'custom', fieldId };
  }
}

export function fieldBreakdownMeasureParameter(measure?: IssueFieldBreakdownMeasure): string | undefined {
  return measure?.kind === 'custom' ? `${customMeasurePrefix}${measure.fieldId}` : measure?.kind;
}

export function readFieldBreakdownScope(parameters: URLSearchParams): FieldBreakdownScope {
  const fieldId = parameters.get('fieldId');
  const savedViewId = parameters.get('savedView');
  const requestedGroup = parameters.get('groupBy');
  const requestedComparison = parameters.get('comparisonBy');
  const comparisonFieldId = parameters.get('comparisonFieldId');
  const requestedMeasure = parameters.get('measure');
  const measure = readFieldBreakdownMeasure(requestedMeasure);
  const groupBy = dimension(requestedGroup);
  const comparisonBy = dimension(requestedComparison);
  if (parameters.has('invalid') || queryKeys.some(key => parameters.getAll(key).length > 1) ||
      (fieldId !== null && (!isScopeId(fieldId) || requestedGroup !== null)) ||
      (savedViewId !== null && !isScopeId(savedViewId)) ||
      (requestedGroup !== null && !groupBy) ||
      (requestedMeasure !== null && (!measure || (!fieldId && !groupBy))) ||
      (requestedComparison !== null && (!comparisonBy || (!fieldId && !groupBy) || groupBy === comparisonBy)) ||
      (comparisonFieldId !== null && (!isScopeId(comparisonFieldId) || requestedComparison !== null ||
        (!fieldId && !groupBy) || fieldId === comparisonFieldId))) {
    return { invalid: true };
  }
  return {
    ...(fieldId !== null ? { fieldId } : {}), ...(groupBy ? { groupBy } : {}),
    ...(savedViewId !== null ? { savedViewId } : {}), ...(comparisonBy ? { comparisonBy } : {}),
    ...(comparisonFieldId !== null ? { comparisonFieldId } : {}), ...(measure ? { measure } : {}),
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
  const measure = fieldBreakdownMeasureParameter(scope.measure);
  if (measure) parameters.set('measure', measure);
  return parameters;
}

export function sameFieldBreakdownScope(left?: FieldBreakdownScope | null, right?: FieldBreakdownScope | null): boolean {
  return Boolean(left) === Boolean(right) && left?.fieldId === right?.fieldId && left?.groupBy === right?.groupBy &&
    left?.savedViewId === right?.savedViewId && left?.comparisonBy === right?.comparisonBy &&
    left?.comparisonFieldId === right?.comparisonFieldId && left?.invalid === right?.invalid &&
    fieldBreakdownMeasureParameter(left?.measure) === fieldBreakdownMeasureParameter(right?.measure);
}

export function fieldBreakdownHash(projectId: string, scope: FieldBreakdownScope): string {
  const parameters = fieldBreakdownParameters(scope).toString();
  return `#/${encodeURIComponent(projectId)}/reports/fields${parameters ? `?${parameters}` : ''}`;
}
