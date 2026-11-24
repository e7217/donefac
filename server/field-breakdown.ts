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
  IssueFieldBreakdownMeasure,
  IssueFieldBreakdownMeasureResult,
  IssueFieldBreakdownMeasureTotal,
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
  comparison?: BreakdownAxis;
  measure?: { source: IssueFieldBreakdownMeasure; label: string; field?: CustomFieldDefinition };
  configuration?: { workflowVersion?: number; importGeneration: string | null };
}

interface BreakdownAxis {
  by?: IssueFieldBreakdownDimension;
  field: CustomFieldDefinition;
}

type Scalar = string | number | boolean;
type SpecialBucketId = 'missing' | 'unknown' | 'not-applicable';
type ColumnMemberships = ReadonlyMap<string, ReadonlySet<string>>;
const MAX_CUSTOM_COMPARISON_CELLS = 50_000;
const ZERO = BigInt(0), ONE = BigInt(1);
const fractionUnit = ONE << BigInt(52);

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
const notApplicableLabel = '유형 미적용';
const specialGroupOrder = new Map([['missing', 1], ['unknown', 2], ['not-applicable', 3]]);

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

function axisValue(issue: Issue, { by, field }: BreakdownAxis) {
  const applicable = fieldApplies(field, issue.type);
  const raw = applicable ? (by ? builtinValue(issue, by) : ownValue(issue, field)) : undefined;
  const emptyId: SpecialBucketId = by === 'reporter' && raw === undefined ? 'unknown' : 'missing';
  if (!applicable) return { raw, emptyId, specialId: 'not-applicable' as const };
  if (!hasCustomValue(raw)) return { raw, emptyId, specialId: emptyId };
  validatePresentValue(field, raw!);
  const values: Scalar[] = field.kind === 'multi_select' ? [...new Set(raw as string[])] : [raw as Scalar];
  return { raw, emptyId, values };
}

function axisIds(field: CustomFieldDefinition) {
  const cached = new Map<Scalar, string>();
  return (value: Scalar) => {
    let id = cached.get(value);
    if (!id) { id = valueId(field, value); cached.set(value, id); }
    return id;
  };
}

const valueLabel = (field: CustomFieldDefinition, value: Scalar, users: User[]) =>
  displayLabel(fieldValueLabel(field, field.kind === 'multi_select' ? [value as string] : value, users));

function specialLabel(id: SpecialBucketId, by?: IssueFieldBreakdownDimension) {
  if (id === 'unknown') return unknownReporterLabel;
  if (id === 'not-applicable') return notApplicableLabel;
  return missingValueLabel(by);
}

function intersectionCount(left: Uint32Array, right: Uint32Array) {
  let count = 0;
  for (let index = 0; index < left.length; index++) {
    let bits = left[index] & right[index];
    bits -= (bits >>> 1) & 0x55555555;
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
    count += (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}

function comparisonCounts(issuesByBucket: ReadonlyMap<string, IssueFieldBreakdownIssue[]>, columnIdsByIssue: ColumnMemberships,
  columns: ReadonlyMap<string, IssueFieldBreakdownColumn>, custom: boolean, bothMultiple: boolean) {
  const counts = new Map<string, Map<string, number>>();
  let populated = 0;
  const add = (row: Map<string, number>, columnId: string, count = 1) => {
    const previous = row.get(columnId) ?? 0;
    if (custom && !previous && ++populated > MAX_CUSTOM_COMPARISON_CELLS) {
      fail('업무가 있는 교차 셀이 50,000개를 넘습니다. 저장된 보기로 집계 범위를 좁혀 주세요.', 413);
    }
    row.set(columnId, previous + count);
  };

  // For dense multi-select pairs, intersect issue memberships a word at a time.
  // The sparse path avoids walking huge empty grids for high-cardinality dimensions.
  if (bothMultiple && columnIdsByIssue.size > 64 && issuesByBucket.size * columns.size <= MAX_CUSTOM_COMPARISON_CELLS * 2) {
    const issueIndex = new Map([...columnIdsByIssue.keys()].map((id, index) => [id, index]));
    const words = Math.ceil(issueIndex.size / 32);
    const columnBits = new Map([...columns.keys()].map(id => [id, new Uint32Array(words)]));
    for (const [issueId, memberships] of columnIdsByIssue) {
      const index = issueIndex.get(issueId)!;
      for (const columnId of memberships) columnBits.get(columnId)![index >>> 5] |= 1 << (index & 31);
    }
    for (const [bucketId, issues] of issuesByBucket) {
      if (!issues.length) continue;
      const rowBits = new Uint32Array(words);
      for (const { id } of issues) {
        const index = issueIndex.get(id)!;
        rowBits[index >>> 5] |= 1 << (index & 31);
      }
      const row = new Map<string, number>();
      for (const [columnId, bits] of columnBits) {
        const count = intersectionCount(rowBits, bits);
        if (count) add(row, columnId, count);
      }
      counts.set(bucketId, row);
    }
    return counts;
  }

  for (const [bucketId, issues] of issuesByBucket) {
    if (!issues.length) continue;
    const row = new Map<string, number>();
    for (const { id } of issues) for (const columnId of columnIdsByIssue.get(id)!) add(row, columnId);
    counts.set(bucketId, row);
  }
  return counts;
}

/** Every finite double is an integer * 2^-1074. Sum those integers before rounding. */
function exactCoefficient(value: number, bits: DataView): bigint {
  bits.setFloat64(0, value, false);
  const high = bits.getUint32(0, false), low = bits.getUint32(4, false);
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << BigInt(32)) | BigInt(low);
  const coefficient = exponent ? (fractionUnit | fraction) << BigInt(exponent - 1) : fraction;
  return high >>> 31 ? -coefficient : coefficient;
}

function roundCoefficient(total: bigint, count = 1): number {
  if (total === ZERO) return 0;
  const negative = total < ZERO, absolute = negative ? -total : total;
  const divisor = BigInt(count);
  const whole = absolute / divisor;
  const shift = Math.max(0, whole.toString(2).length - 53);
  const denominator = divisor << BigInt(shift);
  let mantissa = absolute / denominator;
  const remainder = absolute % denominator;
  const comparison = remainder * BigInt(2) - denominator;
  if (comparison > ZERO || (comparison === ZERO && (mantissa & ONE) === ONE)) mantissa++;
  const value = Number(mantissa) * 2 ** (shift - 1074);
  return negative ? -value : value;
}

function numericStatistics(values: number[]): IssueFieldBreakdown['numeric'] {
  if (!values.length) return null;
  const bits = new DataView(new ArrayBuffer(8));
  let total = ZERO, min = values[0], max = values[0];
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    total += exactCoefficient(value, bits);
  }
  const sum = roundCoefficient(total), average = roundCoefficient(total, values.length);
  if (!Number.isFinite(average)) fail('숫자 평균을 유한한 값으로 계산할 수 없습니다.');
  return { min: min === 0 ? 0 : min, max: max === 0 ? 0 : max, average, sum: Number.isFinite(sum) ? sum : null };
}

type ExactMeasure = { valueCount: number; coefficient: bigint };
const emptyMeasure = (): ExactMeasure => ({ valueCount: 0, coefficient: ZERO });
function addMeasure(total: ExactMeasure, coefficient: bigint, valueCount = 1): void {
  total.coefficient += coefficient;
  total.valueCount += valueCount;
}

function summaryMeasure({ valueCount, coefficient }: ExactMeasure): IssueFieldBreakdownMeasureTotal {
  const sum = valueCount ? roundCoefficient(coefficient) : null;
  return { valueCount, sum: sum !== null && Number.isFinite(sum) ? sum : null };
}

function issueMeasure(issue: Issue, measure: NonNullable<BreakdownInput['measure']>): number | null {
  const { source, field, label } = measure;
  let value: unknown;
  if (source.kind === 'custom') {
    if (!field || field.id !== source.fieldId || field.kind !== 'number') fail('합산할 숫자 필드를 확인해 주세요.', 400);
    if (!fieldApplies(field, issue.type)) return null;
    const stored = ownValue(issue, field);
    if (!hasCustomValue(stored)) return null;
    value = stored;
  } else value = issue[source.kind];
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label}: 저장된 숫자는 유한해야 합니다.`);
  return value === 0 ? 0 : value;
}

function sparseMeasureRow(issues: readonly IssueFieldBreakdownIssue[], values: ReadonlyMap<string, bigint>,
  memberships: ColumnMemberships): Record<string, IssueFieldBreakdownMeasureTotal> {
  const membershipTotals = new Map<ReadonlySet<string>, ExactMeasure>();
  for (const { id } of issues) {
    const coefficient = values.get(id);
    if (coefficient === undefined) continue;
    const columns = memberships.get(id)!;
    let total = membershipTotals.get(columns);
    if (!total) { total = emptyMeasure(); membershipTotals.set(columns, total); }
    addMeasure(total, coefficient);
  }
  const cells = new Map<string, ExactMeasure>();
  for (const [columns, { valueCount, coefficient }] of membershipTotals) {
    for (const id of columns) {
      let cell = cells.get(id);
      if (!cell) { cell = emptyMeasure(); cells.set(id, cell); }
      addMeasure(cell, coefficient, valueCount);
    }
  }
  return Object.fromEntries([...cells].map(([id, total]) => [id, summaryMeasure(total)]));
}

function denseMeasureRows(values: ReadonlyMap<string, bigint>,
  memberships: ColumnMemberships, comparison: NonNullable<IssueFieldBreakdown['comparison']>) {
  const coefficients = [...values.values()];
  const indexes = new Map([...values.keys()].map((id, index) => [id, index]));
  const byteCount = Math.ceil(coefficients.length / 8);
  const columns = new Map(comparison.columns.map(column => [column.id, new Uint8Array(byteCount)]));
  for (const [id, index] of indexes) {
    for (const column of memberships.get(id)!) columns.get(column)![index >>> 3] |= 1 << (index & 7);
  }
  // Cache a partial sum for each eight-issue mask encountered in a cell intersection.
  const partials = Array.from({ length: byteCount }, () => new Array<ExactMeasure | undefined>(256));
  function partial(byte: number, mask: number): ExactMeasure {
    let result = partials[byte][mask];
    if (result) return result;
    const bit = mask & -mask;
    const rest = mask ^ bit;
    const selected = coefficients[byte * 8 + (31 - Math.clz32(bit))];
    const previous = rest ? partial(byte, rest) : undefined;
    result = { valueCount: (previous?.valueCount ?? 0) + 1, coefficient: (previous?.coefficient ?? ZERO) + selected };
    partials[byte][mask] = result;
    return result;
  }
  return (bucketId: string, issues: readonly IssueFieldBreakdownIssue[]) => {
    const row = new Uint8Array(byteCount);
    for (const { id } of issues) {
      const index = indexes.get(id);
      if (index !== undefined) row[index >>> 3] |= 1 << (index & 7);
    }
    const cells: [string, IssueFieldBreakdownMeasureTotal][] = [];
    for (const columnId of Object.keys(comparison.counts[bucketId] ?? {})) {
      const column = columns.get(columnId)!;
      const total = emptyMeasure();
      for (let byte = 0; byte < byteCount; byte++) {
        const mask = row[byte] & column[byte];
        if (mask) {
          const { coefficient, valueCount } = partial(byte, mask);
          addMeasure(total, coefficient, valueCount);
        }
      }
      if (total.valueCount) cells.push([columnId, summaryMeasure(total)]);
    }
    return Object.fromEntries(cells);
  };
}

function summarizeMeasure(measure: NonNullable<BreakdownInput['measure']>, values: ReadonlyMap<string, bigint>,
  issuesByBucket: ReadonlyMap<string, IssueFieldBreakdownIssue[]>, memberships: ColumnMemberships,
  comparison: IssueFieldBreakdown['comparison'], bothMultiple: boolean): IssueFieldBreakdownMeasureResult {
  const total = emptyMeasure();
  const columnTotals = new Map(comparison?.columns.map(column => [column.id, emptyMeasure()]));
  for (const [id, value] of values) {
    addMeasure(total, value);
    for (const column of memberships.get(id) ?? []) addMeasure(columnTotals.get(column)!, value);
  }
  const rows = Object.fromEntries([...issuesByBucket].map(([id, issues]) => {
    const sum = emptyMeasure();
    for (const issue of issues) {
      const value = values.get(issue.id);
      if (value !== undefined) addMeasure(sum, value);
    }
    return [id, summaryMeasure(sum)];
  }));
  const result = { source: measure.source, label: measure.label, total: summaryMeasure(total), rows };
  if (!comparison) return result;
  const dense = bothMultiple && values.size > 64 && issuesByBucket.size * comparison.columns.length <= MAX_CUSTOM_COMPARISON_CELLS * 2;
  const denseRow = dense ? denseMeasureRows(values, memberships, comparison) : null;
  const cells = Object.fromEntries([...issuesByBucket].flatMap(([id, issues]) => {
    if (!rows[id].valueCount) return [];
    const row = denseRow ? denseRow(id, issues) : sparseMeasureRow(issues, values, memberships);
    return Object.keys(row).length ? [[id, row]] : [];
  }));
  const columns = Object.fromEntries([...columnTotals].map(([id, total]) => [id, summaryMeasure(total)]));
  return { ...result, columns, cells };
}

export function buildIssueFieldBreakdown(input: BreakdownInput): {
  report: IssueFieldBreakdown;
  issuesByBucket: Map<string, IssueFieldBreakdownIssue[]>;
  columnIdsByIssue: ColumnMemberships;
} {
  if (!Array.isArray(input.issues) || input.issues.length > 10000) fail('필드 분포는 최대 10,000개 업무까지 집계할 수 있습니다.', 413);
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) fail('업무 스키마 버전을 확인해 주세요.', 400);
  const { projectId, field, users, groupBy, comparison, measure } = input;
  const rowAxis: BreakdownAxis = { by: groupBy, field };
  const rowId = axisIds(field);
  const comparisonId = comparison && axisIds(comparison.field);
  const buckets = new Map<string, IssueFieldBreakdownBucket>();
  const issuesByBucket = new Map<string, IssueFieldBreakdownIssue[]>();
  const columnIdsByIssue = new Map<string, ReadonlySet<string>>();
  const columns = new Map<string, IssueFieldBreakdownColumn>();
  const columnGroups = new Map<string, { ids: ReadonlySet<string>; count: number }>();
  const missing: IssueFieldBreakdownBucket = { id: 'missing', label: missingValueLabel(groupBy), kind: 'missing', count: 0 };
  const unknown: IssueFieldBreakdownBucket | null = groupBy === 'reporter'
    ? { id: 'unknown', label: unknownReporterLabel, kind: 'missing', count: 0 } : null;
  const notApplicable: IssueFieldBreakdownBucket = { id: 'not-applicable', label: notApplicableLabel, kind: 'not_applicable', count: 0 };
  const specialBuckets = unknown ? [missing, unknown, notApplicable] : [missing, notApplicable];
  for (const bucket of specialBuckets) {
    buckets.set(bucket.id, bucket);
    issuesByBucket.set(bucket.id, []);
  }
  const seen = new Set<string>(), numericValues: number[] = [];
  const coefficients = new Map<string, bigint>();
  const coefficientBits = new DataView(new ArrayBuffer(8));
  const fingerprints: unknown[][] = [];
  let applicableIssues = 0, populatedIssues = 0;

  const add = (bucket: IssueFieldBreakdownBucket, summary: IssueFieldBreakdownIssue) => {
    bucket.count++;
    issuesByBucket.get(bucket.id)!.push(summary);
  };
  for (const issue of input.issues) {
    if (issue.projectId !== projectId) fail('다른 프로젝트 업무를 필드 분포에 포함할 수 없습니다.', 400);
    if (!issue.id || seen.has(issue.id)) fail('필드 분포에 중복되거나 비어 있는 업무 ID가 있습니다.', 400);
    if (!Number.isSafeInteger(issue.version) || issue.version < 1) fail('업무 버전을 확인해 주세요.', 400);
    seen.add(issue.id);
    const measureValue = measure ? issueMeasure(issue, measure) : null;
    if (measureValue !== null) coefficients.set(issue.id, exactCoefficient(measureValue, coefficientBits));
    const summary = { id: issue.id, key: issue.key, title: issue.title, ...(measure ? { measureValue } : {}) };
    let columnFingerprint: string | undefined;
    if (comparison && comparisonId) {
      const { values, specialId } = axisValue(issue, comparison);
      // A group's sorted values identify identical memberships across issues.
      // Built-in dimensions keep their original per-issue fingerprint.
      columnFingerprint = specialId ?? (comparison.by ? comparisonId(values[0]) : hash(values.sort()));
      let columnGroup = columnGroups.get(columnFingerprint);
      if (!columnGroup) {
        const ids = new Set<string>();
        if (specialId) {
          columns.set(specialId, { id: specialId, label: specialLabel(specialId, comparison.by), count: 0 });
          ids.add(specialId);
        } else for (const value of values) {
          const id = comparisonId(value);
          if (!columns.has(id)) columns.set(id, { id, label: valueLabel(comparison.field, value, users), count: 0 });
          ids.add(id);
        }
        columnGroup = { ids, count: 0 };
        columnGroups.set(columnFingerprint, columnGroup);
      }
      columnGroup.count++;
      columnIdsByIssue.set(issue.id, columnGroup.ids);
    }
    const { raw, emptyId, values, specialId } = axisValue(issue, rowAxis);
    const applicable = specialId !== 'not-applicable';
    const valueFingerprint = raw == null ? (emptyId === 'unknown' ? 'unknown' : null) : hash([field.kind, raw]);
    fingerprints.push([issue.id, issue.version, issue.key, issue.title, issue.type, applicable,
      valueFingerprint, ...(columnFingerprint ? [columnFingerprint] : []), ...(measure ? [measureValue] : [])]);
    if (!applicable) { add(notApplicable, summary); continue; }
    applicableIssues++;
    if (specialId) { add(buckets.get(specialId)!, summary); continue; }
    populatedIssues++;
    if (field.kind === 'number') numericValues.push(raw as number);
    for (const distinct of values) {
      const id = rowId(distinct);
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = { id, label: valueLabel(field, distinct, users), kind: 'value', count: 0 };
        buckets.set(id, bucket);
        issuesByBucket.set(id, []);
      }
      add(bucket, summary);
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
  const bothMultiple = field.kind === 'multi_select' && comparison?.field.kind === 'multi_select';
  let comparisonResult: IssueFieldBreakdown['comparison'];
  if (comparison) {
    for (const { ids, count } of columnGroups.values()) for (const id of ids) columns.get(id)!.count += count;
    const counts = comparisonCounts(issuesByBucket, columnIdsByIssue, columns, !comparison.by, bothMultiple);
    distinguishLabels(columns);
    const workflowOrder = comparison.by === 'status'
      ? new Map(comparison.field.options.map((option, index) => [valueId(comparison.field, option.id), index]))
      : new Map<string, number>();
    const orderedColumns = [...columns.values()].sort((left, right) =>
      (specialGroupOrder.get(left.id) ?? 0) - (specialGroupOrder.get(right.id) ?? 0) ||
      (workflowOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (workflowOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.label, right.label) || compareText(left.id, right.id));
    const columnPosition = new Map(orderedColumns.map((column, index) => [column.id, index]));
    const orderedCounts = Object.fromEntries(groups.flatMap(group => {
      const row = counts.get(group.id);
      return row ? [[group.id, Object.fromEntries([...row].sort(([left], [right]) => columnPosition.get(left)! - columnPosition.get(right)!))]] : [];
    }));
    comparisonResult = comparison.by ? { by: comparison.by, columns: orderedColumns, counts: orderedCounts } : {
      field: { id: comparison.field.id, name: comparison.field.name, kind: comparison.field.kind, archived: comparison.field.archived },
      columns: orderedColumns, counts: orderedCounts,
    };
  }
  const measureResult = measure && summarizeMeasure(measure, coefficients, issuesByBucket, columnIdsByIssue, comparisonResult, bothMultiple);
  const revision = hash({
    projectId, schemaVersion: input.schemaVersion,
    field: [field.id, field.name, field.description, field.kind, field.required, field.archived,
      [...field.issueTypes].sort(compareText), [...field.options].sort((left, right) => compareText(left.id, right.id)).map(option => [option.id, option.name, option.archived])],
    savedView,
    issues: fingerprints.sort((left, right) => compareText(left[0] as string, right[0] as string)),
    groups: groups.map(bucket => [bucket.id, bucket.label, bucket.kind, bucket.count]),
    numeric,
    ...(measure ? { measure: [measure.source, measure.label] } : {}),
    ...(groupBy || comparisonResult || measure ? { groupBy, comparison: comparisonResult, configuration: input.configuration } : {}),
  });
  return {
    report: {
      projectId, field: { id: field.id, name: field.name, kind: field.kind, archived: field.archived },
      ...(groupBy ? { groupBy } : {}), ...(comparisonResult ? { comparison: comparisonResult } : {}),
      ...(measureResult ? { measure: measureResult } : {}),
      savedView, revision, generatedAt: input.generatedAt, totalIssues: input.issues.length,
      applicableIssues, populatedIssues, missingIssues: missing.count + (unknown?.count ?? 0), notApplicableIssues: notApplicable.count,
      groups, numeric,
    },
    issuesByBucket, columnIdsByIssue,
  };
}
