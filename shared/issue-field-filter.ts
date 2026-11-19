import type {
  CustomFieldDefinition,
  CustomFieldKind,
  CustomFieldValue,
  Issue,
  IssueFieldFilter,
  IssueFieldOperator,
  IssueFieldRule,
  ProjectIssueSchema,
  User,
} from './types.js';
import { isCalendarDate } from './calendar.js';
import { fieldApplies, hasCustomValue } from './issue-schema.js';

export class IssueFieldFilterError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); }
}

export const MAX_FIELD_FILTER_RULES = 8;

const presence: readonly IssueFieldOperator[] = Object.freeze(['is_set', 'is_empty']);
const operators = new Map<CustomFieldKind, readonly IssueFieldOperator[]>([
  ['text', Object.freeze([...presence, 'equals', 'not_equals', 'contains'])],
  ['url', Object.freeze([...presence, 'equals', 'not_equals', 'contains'])],
  ['number', Object.freeze([...presence, 'equals', 'not_equals', 'gte', 'lte'])],
  ['date', Object.freeze([...presence, 'equals', 'not_equals', 'gte', 'lte'])],
  ['checkbox', Object.freeze([...presence, 'equals', 'not_equals'])],
  ['select', Object.freeze([...presence, 'equals', 'not_equals'])],
  ['user', Object.freeze([...presence, 'equals', 'not_equals'])],
  ['multi_select', Object.freeze([...presence, 'includes', 'excludes'])],
]);
const noOperators: readonly IssueFieldOperator[] = Object.freeze([]);

export function fieldFilterOperators(kind: CustomFieldKind): readonly IssueFieldOperator[] {
  return operators.get(kind) || noOperators;
}

function fail(message: string): never { throw new IssueFieldFilterError(message); }

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 객체가 필요합니다.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label}은 일반 객체여야 합니다.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(`${label}에 알 수 없는 속성이 있습니다.`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) fail(`${label}에 접근자 속성을 사용할 수 없습니다.`);
  }
  return value as Record<string, unknown>;
}

function operand(
  value: unknown,
  field: CustomFieldDefinition,
  operator: IssueFieldOperator,
  users: ReadonlySet<string> | undefined,
): string | number | boolean {
  switch (field.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field.name}: 유한한 숫자가 필요합니다.`);
      return value;
    case 'date':
      if (!isCalendarDate(value)) fail(`${field.name}: 유효한 YYYY-MM-DD 날짜가 필요합니다.`);
      return value;
    case 'checkbox':
      if (typeof value !== 'boolean') fail(`${field.name}: 예·아니요 값이 필요합니다.`);
      return value;
    case 'select':
    case 'multi_select':
      if (typeof value !== 'string' || !field.options.some(option => option.id === value)) {
        fail(`${field.name}: 선택지 ID를 확인해 주세요.`);
      }
      return value;
    case 'user':
      if (typeof value !== 'string' || !value || (users && !users.has(value))) fail(`${field.name}: 팀원 ID를 확인해 주세요.`);
      return value;
    case 'text':
      if (typeof value !== 'string' || !value.trim() || value.length > 20000) fail(`${field.name}: 비어 있지 않은 20,000자 이하 텍스트가 필요합니다.`);
      // Issue text deliberately preserves surrounding whitespace.
      return value;
    case 'url': {
      if (typeof value !== 'string' || !value.trim() || value.length > 4000) fail(`${field.name}: 비어 있지 않은 4,000자 이하 URL 조건이 필요합니다.`);
      const normalized = value.trim();
      if (operator !== 'contains') {
        let url: URL;
        try { url = new URL(normalized); } catch { fail(`${field.name}: 절대 http(s) URL이 필요합니다.`); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${field.name}: 인증 정보가 없는 http(s) URL이 필요합니다.`);
      }
      return normalized;
    }
    default:
      return fail('지원하지 않는 사용자 정의 필드 종류입니다.');
  }
}

function parseFilter(value: unknown, schema: ProjectIssueSchema, users?: ReadonlySet<string>): IssueFieldFilter {
  const group = object(value, ['match', 'rules'], '필드 필터');
  if (!Object.hasOwn(group, 'match') || (group.match !== 'all' && group.match !== 'any')) fail('필터 조건 결합은 all 또는 any여야 합니다.');
  if (!Object.hasOwn(group, 'rules') || !Array.isArray(group.rules) || !group.rules.length || group.rules.length > MAX_FIELD_FILTER_RULES) {
    fail('필드 필터 조건은 1~8개여야 합니다.');
  }
  for (let index = 0; index < group.rules.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(group.rules, String(index));
    if (!entry || !Object.hasOwn(entry, 'value')) fail('필터 조건 목록에는 빈 항목이나 접근자를 사용할 수 없습니다.');
  }
  const fields = new Map(schema.fields.map(field => [field.id, field]));
  const rules: IssueFieldRule[] = group.rules.map(raw => {
    const rule = object(raw, ['fieldId', 'operator', 'value'], '필드 조건');
    if (!Object.hasOwn(rule, 'fieldId') || typeof rule.fieldId !== 'string' || !fields.has(rule.fieldId)) fail('필터의 사용자 정의 필드를 찾을 수 없습니다.');
    const field = fields.get(rule.fieldId)!;
    if (!Object.hasOwn(rule, 'operator') || typeof rule.operator !== 'string' || !fieldFilterOperators(field.kind).includes(rule.operator as IssueFieldOperator)) {
      fail(`${field.name}: 지원하지 않는 필터 연산자입니다.`);
    }
    const operator = rule.operator as IssueFieldOperator;
    if (operator === 'is_set' || operator === 'is_empty') {
      if (Object.hasOwn(rule, 'value')) fail(`${field.name}: 값 유무 조건에는 비교 값을 지정할 수 없습니다.`);
      return { fieldId: field.id, operator };
    }
    if (!Object.hasOwn(rule, 'value')) fail(`${field.name}: 비교 값이 필요합니다.`);
    return { fieldId: field.id, operator, value: operand(rule.value, field, operator, users) };
  });
  return { match: group.match, rules };
}

export function parseIssueFieldFilter(
  value: unknown,
  schema: ProjectIssueSchema,
  users: readonly Pick<User, 'id'>[],
): IssueFieldFilter {
  return parseFilter(value, schema, new Set(users.map(user => user.id)));
}

function matchesValue(field: CustomFieldDefinition, rule: IssueFieldRule, value: CustomFieldValue | undefined): boolean {
  const present = hasCustomValue(value);
  if (rule.operator === 'is_set') return present;
  if (rule.operator === 'is_empty') return !present;
  // Missing values never satisfy a negative comparison either.
  if (!present) return false;
  if (field.kind === 'multi_select') {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return false;
    return rule.operator === 'includes' ? value.includes(rule.value as string) : !value.includes(rule.value as string);
  }
  if (typeof value !== typeof rule.value) return false;
  if (field.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (field.kind === 'date' && !isCalendarDate(value)) return false;
  switch (rule.operator) {
    case 'equals': return value === rule.value;
    case 'not_equals': return value !== rule.value;
    case 'contains': return typeof value === 'string' && value.toLowerCase().includes((rule.value as string).toLowerCase());
    case 'gte': return typeof value === 'number' ? value >= (rule.value as number) : typeof value === 'string' && value >= (rule.value as string);
    case 'lte': return typeof value === 'number' ? value <= (rule.value as number) : typeof value === 'string' && value <= (rule.value as string);
    default: return false;
  }
}

export function createIssueFieldMatcher(filter: IssueFieldFilter | undefined, schema: ProjectIssueSchema): (issue: Issue) => boolean {
  if (filter === undefined) return () => true;
  let parsed: IssueFieldFilter;
  try { parsed = parseFilter(filter, schema); } catch { return () => false; }
  const fields = new Map(schema.fields.map(field => [field.id, field]));
  const rules = parsed.rules.map(rule => ({ rule, field: fields.get(rule.fieldId)! }));
  return issue => {
    if (issue.projectId !== schema.projectId) return false;
    const evaluate = ({ rule, field }: typeof rules[number]) => {
      if (!fieldApplies(field, issue.type)) return false;
      const values = issue.customFields;
      const property = values && Object.getOwnPropertyDescriptor(values, field.id);
      if (property && !Object.hasOwn(property, 'value')) return false;
      const value = property?.value as CustomFieldValue | undefined;
      return matchesValue(field, rule, value);
    };
    return parsed.match === 'all' ? rules.every(evaluate) : rules.some(evaluate);
  };
}
