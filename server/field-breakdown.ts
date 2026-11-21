import { createHash } from 'node:crypto';
import type {
  CustomFieldDefinition,
  CustomFieldValue,
  Issue,
  IssueFieldBreakdown,
  IssueFieldBreakdownBucket,
  IssueFieldBreakdownColumn,
  IssueFieldBreakdownDimension,
  IssueFieldBreakdownIssue,
  User,
} from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';
import { fieldApplies, fieldValueLabel, hasCustomValue } from '../shared/issue-schema.js';

export class FieldBreakdownError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface BreakdownInput {
  projectId: string;
  field: CustomFieldDefinition;
  issues: Issue[];
  users: User[];
  savedView: IssueFieldBreakdown['savedView'];
  schemaVersion: number;
  generatedAt: string;
  groupBy?: IssueFieldBreakdownDimension;
  comparison?: { by: IssueFieldBreakdownDimension; field: CustomFieldDefinition };
  configuration?: { workflowVersion?: number; importGeneration: string | null };
}

const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'variant' });
const compareText = (left: string, right: string) => collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message: string, status = 422): never { throw new FieldBreakdownError(status, message); }

function displayLabel(value: string, limit = 180): string {
  const characters: string[] = [];
  for (const character of value) {
    if (characters.length === limit) return `${characters.slice(0, limit - 1).join('')}…`;
    characters.push(character);
  }
  return characters.join('');
}

function distinguishLabels(groups: ReadonlyMap<string, IssueFieldBreakdownColumn>) {
  const counts = new Map<string, number>();
  for (const group of groups.values()) counts.set(group.label, (counts.get(group.label) ?? 0) + 1);
  for (const group of groups.values()) {
    if (group.id.startsWith('value:') && counts.get(group.label)! > 1) {
      group.label = `${displayLabel(group.label, 165)} · ${group.id.slice(-12)}`;
    }
  }
}

function builtinValue(issue: Issue, by: IssueFieldBreakdownDimension): string | null | undefined {
  if (by === 'reporter') return issue.reporterId;
  return by === 'assignee' ? issue.assigneeId : issue[by];
}

const missingValueLabel = (by?: IssueFieldBreakdownDimension) => by === 'assignee' || by === 'reporter' ? '미지정' : '값 없음';
const unknownReporterLabel = '기록 없음';
const specialGroupOrder = new Map([['missing', 1], ['unknown', 2]]);

const valueId = (field: CustomFieldDefinition, value: string | number | boolean) => `value:${hash([field.id, field.kind, value])}`;

function ownValue(issue: Issue, field: CustomFieldDefinition): CustomFieldValue | undefined {
  const property = issue.customFields && Object.getOwnPropertyDescriptor(issue.customFields, field.id);
  if (property && !Object.hasOwn(property, 'value')) fail('업무 필드 값에는 접근자 속성을 사용할 수 없습니다.');
  return property?.value as CustomFieldValue | undefined;
}

function validatePresentValue(field: CustomFieldDefinition, value: CustomFieldValue): void {
  switch (field.kind) {
    case 'text':
    case 'url':
    case 'select':
    case 'user':
      if (typeof value !== 'string') fail(`${field.name}: 저장된 필드 값이 문자열이 아닙니다.`);
      return;
    case 'date':
      if (!isCalendarDate(value)) fail(`${field.name}: 저장된 날짜가 올바르지 않습니다.`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field.name}: 저장된 숫자는 유한해야 합니다.`);
      return;
    case 'checkbox':
      if (typeof value !== 'boolean') fail(`${field.name}: 저장된 값은 예·아니요여야 합니다.`);
      return;
    case 'multi_select':
      if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) fail(`${field.name}: 저장된 선택지 ID 목록이 올바르지 않습니다.`);
      return;
    default:
      return fail('지원하지 않는 사용자 정의 필드 종류입니다.', 400);
  }
}

/** Exact binary accumulation prevents intermediate overflow/cancellation from
 * corrupting a finite sum or mean. Every finite double is an integer * 2^-1074. */
function numericStatistics(values: number[]): IssueFieldBreakdown['numeric'] {
  if (!values.length) return null;
  const bits = new DataView(new ArrayBuffer(8));
  const one = BigInt(1), fractionUnit = one << BigInt(52);
  let total = BigInt(0), min = values[0], max = values[0];
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    bits.setFloat64(0, value, false);
    const high = bits.getUint32(0, false), low = bits.getUint32(4, false);
    const exponent = (high >>> 20) & 0x7ff;
    const fraction = (BigInt(high & 0xfffff) << BigInt(32)) | BigInt(low);
    const coefficient = exponent ? (fractionUnit | fraction) << BigInt(exponent - 1) : fraction;
    total += high >>> 31 ? -coefficient : coefficient;
  }
  const rounded = (count: number): number => {
    if (total === BigInt(0)) return 0;
    const negative = total < BigInt(0), absolute = negative ? -total : total;
    const divisor = BigInt(count);
    const whole = absolute / divisor;
    const shift = Math.max(0, whole.toString(2).length - 53);
    const denominator = divisor << BigInt(shift);
    let mantissa = absolute / denominator;
    const remainder = absolute % denominator;
    const comparison = remainder * BigInt(2) - denominator;
    if (comparison > BigInt(0) || (comparison === BigInt(0) && (mantissa & one) === one)) mantissa++;
    const value = Number(mantissa) * 2 ** (shift - 1074);
    return negative ? -value : value;
  };
  const sum = rounded(1), average = rounded(values.length);
  if (!Number.isFinite(average)) fail('숫자 평균을 유한한 값으로 계산할 수 없습니다.');
  return { min: min === 0 ? 0 : min, max: max === 0 ? 0 : max, average, sum: Number.isFinite(sum) ? sum : null };
}

export function buildIssueFieldBreakdown(input: BreakdownInput): {
  report: IssueFieldBreakdown;
  issuesByBucket: Map<string, IssueFieldBreakdownIssue[]>;
  columnByIssue: ReadonlyMap<string, string>;
} {
  if (!Array.isArray(input.issues) || input.issues.length > 10000) fail('필드 분포는 최대 10,000개 업무까지 집계할 수 있습니다.', 413);
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) fail('업무 스키마 버전을 확인해 주세요.', 400);
  const { projectId, field, users, groupBy, comparison } = input;
  const buckets = new Map<string, IssueFieldBreakdownBucket>();
  const issuesByBucket = new Map<string, IssueFieldBreakdownIssue[]>();
  const columnByIssue = new Map<string, string>();
  const columns = new Map<string, IssueFieldBreakdownColumn>();
  const counts = new Map<string, Map<string, number>>();
  const missing: IssueFieldBreakdownBucket = { id: 'missing', label: missingValueLabel(groupBy), kind: 'missing', count: 0 };
  const unknown: IssueFieldBreakdownBucket | null = groupBy === 'reporter'
    ? { id: 'unknown', label: unknownReporterLabel, kind: 'missing', count: 0 } : null;
  const notApplicable: IssueFieldBreakdownBucket = { id: 'not-applicable', label: '유형 미적용', kind: 'not_applicable', count: 0 };
  const specialBuckets = unknown ? [missing, unknown, notApplicable] : [missing, notApplicable];
  for (const bucket of specialBuckets) {
    buckets.set(bucket.id, bucket);
    issuesByBucket.set(bucket.id, []);
  }
  const seen = new Set<string>(), numericValues: number[] = [];
  const summaries = new Map<string, IssueFieldBreakdownIssue>();
  const fingerprints: unknown[][] = [];
  let applicableIssues = 0, populatedIssues = 0;

  const add = (bucket: IssueFieldBreakdownBucket, issue: Issue) => {
    let summary = summaries.get(issue.id);
    if (!summary) { summary = { id: issue.id, key: issue.key, title: issue.title }; summaries.set(issue.id, summary); }
    bucket.count++;
    issuesByBucket.get(bucket.id)!.push(summary);
    const columnId = columnByIssue.get(issue.id);
    if (columnId) {
      let row = counts.get(bucket.id);
      if (!row) { row = new Map(); counts.set(bucket.id, row); }
      row.set(columnId, (row.get(columnId) ?? 0) + 1);
    }
  };
  for (const issue of input.issues) {
    if (issue.projectId !== projectId) fail('다른 프로젝트 업무를 필드 분포에 포함할 수 없습니다.', 400);
    if (!issue.id || seen.has(issue.id)) fail('필드 분포에 중복되거나 비어 있는 업무 ID가 있습니다.', 400);
    if (!Number.isSafeInteger(issue.version) || issue.version < 1) fail('업무 버전을 확인해 주세요.', 400);
    seen.add(issue.id);
    let columnId: string | undefined;
    if (comparison) {
      const comparedValue = builtinValue(issue, comparison.by);
      const unknownReporter = comparison.by === 'reporter' && comparedValue === undefined;
      columnId = hasCustomValue(comparedValue) ? valueId(comparison.field, comparedValue!) : (unknownReporter ? 'unknown' : 'missing');
      let column = columns.get(columnId);
      if (!column) {
        const label = columnId === 'unknown' ? unknownReporterLabel : columnId === 'missing' ? missingValueLabel(comparison.by)
          : fieldValueLabel(comparison.field, comparedValue, users);
        column = { id: columnId, label: displayLabel(label), count: 0 };
        columns.set(columnId, column);
      }
      column.count++;
      columnByIssue.set(issue.id, columnId);
    }
    const applicable = fieldApplies(field, issue.type);
    const value = applicable ? (groupBy ? builtinValue(issue, groupBy) : ownValue(issue, field)) : undefined;
    const emptyBucket = value === undefined ? unknown ?? missing : missing;
    const valueFingerprint = value == null ? (emptyBucket === unknown ? 'unknown' : null) : hash([field.kind, value]);
    fingerprints.push([issue.id, issue.version, issue.key, issue.title, issue.type, applicable,
      valueFingerprint, ...(columnId ? [columnId] : [])]);
    if (!applicable) { add(notApplicable, issue); continue; }
    applicableIssues++;
    if (!hasCustomValue(value)) { add(emptyBucket, issue); continue; }
    validatePresentValue(field, value!);
    populatedIssues++;
    if (field.kind === 'number') numericValues.push(value as number);
    const distinctValues: (string | number | boolean)[] = field.kind === 'multi_select'
      ? [...new Set(value as string[])].sort(compareText)
      : [value as string | number | boolean];
    for (const distinct of distinctValues) {
      const id = valueId(field, distinct);
      let bucket = buckets.get(id);
      if (!bucket) {
        const label = fieldValueLabel(field, field.kind === 'multi_select' ? [distinct as string] : distinct, users);
        bucket = { id, label: displayLabel(label), kind: 'value', count: 0 };
        buckets.set(id, bucket);
        issuesByBucket.set(id, []);
      }
      add(bucket, issue);
    }
  }
  const compareIssues = (left: IssueFieldBreakdownIssue, right: IssueFieldBreakdownIssue) => compareText(left.key, right.key) || compareText(left.id, right.id);
  for (const issues of issuesByBucket.values()) issues.sort(compareIssues);
  distinguishLabels(buckets);
  const groups = [...buckets.values()].filter(bucket => bucket.kind === 'value').sort(
    (left, right) => right.count - left.count || compareText(left.label, right.label) || compareText(left.id, right.id),
  );
  groups.push(...specialBuckets);
  const numeric = field.kind === 'number' ? numericStatistics(numericValues) : null;
  const savedView = input.savedView ? { id: input.savedView.id, name: input.savedView.name, version: input.savedView.version } : null;
  let comparisonResult: IssueFieldBreakdown['comparison'];
  if (comparison) {
    distinguishLabels(columns);
    const workflowOrder = comparison.by === 'status'
      ? new Map(comparison.field.options.map((option, index) => [valueId(comparison.field, option.id), index]))
      : new Map<string, number>();
    const orderedColumns = [...columns.values()].sort((left, right) =>
      (specialGroupOrder.get(left.id) ?? 0) - (specialGroupOrder.get(right.id) ?? 0) ||
      (workflowOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (workflowOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.label, right.label) || compareText(left.id, right.id));
    const columnPosition = new Map(orderedColumns.map((column, index) => [column.id, index]));
    comparisonResult = { by: comparison.by, columns: orderedColumns, counts: Object.fromEntries(groups.flatMap(group => {
      const row = counts.get(group.id);
      return row ? [[group.id, Object.fromEntries([...row].sort(([left], [right]) => columnPosition.get(left)! - columnPosition.get(right)!))]] : [];
    })) };
  }
  const revision = hash({
    projectId, schemaVersion: input.schemaVersion,
    field: [field.id, field.name, field.description, field.kind, field.required, field.archived,
      [...field.issueTypes].sort(compareText), [...field.options].sort((left, right) => compareText(left.id, right.id)).map(option => [option.id, option.name, option.archived])],
    savedView,
    issues: fingerprints.sort((left, right) => compareText(left[0] as string, right[0] as string)),
    groups: groups.map(bucket => [bucket.id, bucket.label, bucket.kind, bucket.count]),
    numeric,
    ...(groupBy || comparisonResult ? { groupBy, comparison: comparisonResult, configuration: input.configuration } : {}),
  });
  return {
    report: {
      projectId, field: { id: field.id, name: field.name, kind: field.kind, archived: field.archived },
      ...(groupBy ? { groupBy } : {}), ...(comparisonResult ? { comparison: comparisonResult } : {}),
      savedView, revision, generatedAt: input.generatedAt, totalIssues: input.issues.length,
      applicableIssues, populatedIssues, missingIssues: missing.count + (unknown?.count ?? 0), notApplicableIssues: notApplicable.count,
      groups, numeric,
    },
    issuesByBucket, columnByIssue,
  };
}
