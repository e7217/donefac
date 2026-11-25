import { calendarDate, calendarDay, isCalendarDate, MAX_CALENDAR_DATE, MIN_CALENDAR_DATE } from './calendar.js';
import { MAX_FIELD_FILTER_RULES } from './issue-field-filter.js';
import {
  ISSUE_VIEW_LABEL_FILTER_LIMIT, ISSUE_VIEW_LABEL_MAX_LENGTH, ISSUE_VIEW_STATUS_LIMIT,
  issuePriorityLabelFilterLabels, issueViewStatusCriteria, parseIssueViewLabelFilter, parseIssueViewPriorities,
} from './issue-view.js';
import { JIRA_SAVED_VIEW_QUERY_LIMIT, PRIORITY, type IssueFieldFilter, type IssueTypeDefinition, type IssueViewLabelFilter, type IssueViewSortRule, type JiraSavedViewPreview, type Priority, type Project, type User, type WorkflowStatus } from './types.js';

export interface JiraViewComponentField {
  fieldId: string;
  name: string;
  resolve: (value: string, quoted: boolean) => { kind: 'mapped'; targetId: string; label: string }
    | { kind: 'ambiguous' | 'unmapped' } | undefined;
  hasCompleteCoverage: boolean;
}

export interface JiraViewQueryContext {
  project: Pick<Project, 'id' | 'key' | 'name'>;
  sourceProjectAliases?: readonly string[];
  blockedSourceProjectAliases?: readonly string[];
  statuses: readonly Pick<WorkflowStatus, 'id' | 'label'>[];
  issueTypes: readonly Pick<IssueTypeDefinition, 'id' | 'name' | 'archived'>[];
  users: readonly Pick<User, 'id' | 'name' | 'email'>[];
  prepareSourceAliases?: (fields: readonly JiraViewAliasField[]) => JiraViewSourceAliasResolver | undefined;
  prepareComponentField?: () => JiraViewComponentField | undefined;
}

export class JiraViewQueryError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(message);
    this.name = 'JiraViewQueryError';
  }
}

type Translation = Pick<JiraSavedViewPreview, 'filters' | 'criteria' | 'orderBy' | 'sort' | 'requiresProjectOrderAcceptance'>;
export type JiraViewAliasField = 'status' | 'type' | 'assignee' | 'reporter' | 'priority';
export type JiraViewSourceAlias = {
  kind: 'mapped';
  sourceId: string;
  targetId: string;
  /** The complete set of source priority IDs that share this target. Omit for a one-to-one mapping. */
  targetSourceIds?: readonly string[];
  /** Label-only source values covered by this exact name. Numeric aliases omit these values. */
  sameNameSourceIds?: readonly string[];
} | { kind: 'ambiguous' | 'unmapped' };
export type JiraViewSourceAliasResolver = (field: JiraViewAliasField, value: string) => JiraViewSourceAlias | undefined;
type ScalarField = 'project' | Exclude<JiraViewAliasField, 'priority'>;
type Field = ScalarField | 'priority' | 'labels' | 'due' | 'component';
type Token = { kind: 'word' | 'quoted' | 'symbol' | 'end'; value: string; offset: number };
type BasicClause = { field: Exclude<Field, 'due'>; offset: number } & (
  | { operator: '=' | '!=' | 'in' | 'not in'; values: Token[] }
  | { operator: 'empty' | 'set' }
);
type StatusClause = (BasicClause & { field: 'status'; operator: '=' | 'in' })
  | { field: 'status'; offset: number; branches: StatusClause[][] };
type ComponentClause = (BasicClause & { field: 'component' }) | { field: 'component'; offset: number; branches: ComponentClause[][] };
type PriorityClause = { offset: number; values: Token[] };
type DueClause = { field: 'due'; offset: number; from?: string; to?: string; presence?: 'empty' | 'set' };
type CurrentUserClause = { field: 'assignee' | 'reporter'; offset: number; operator: 'current-user' };
type ScalarCondition = { id: string | null; label: string };
type Clause = BasicClause | StatusClause | ComponentClause | DueClause | CurrentUserClause;

function isStatusClause(clause: Clause): clause is StatusClause {
  return clause.field === 'status' && ('branches' in clause || clause.operator === '=' || clause.operator === 'in');
}

function isComponentClause(clause: Clause): clause is ComponentClause {
  return clause.field === 'component';
}

const MAX_TOKENS = 512;
const MAX_NESTING = 16;
const MAX_CLAUSES = 40;
const MAX_SORT_FIELDS = 10;
const literalWord = /[\p{L}\p{N}\p{M}_-]+/uy;
const customFieldWord = /cf\[[0-9]+\]/iuy;
const controls = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const reservedWords = new Set([
  'after', 'all', 'and', 'any', 'asc', 'before', 'by', 'cf', 'changed', 'desc', 'during', 'empty', 'from',
  'in', 'is', 'isempty', 'isnull', 'not', 'notin', 'null', 'or', 'order', 'to', 'was',
]);
const dueOperators = ['=', '<', '<=', '>', '>='];
const fieldLabels: Record<Field, string> = {
  project: '프로젝트', status: '상태', type: '이슈 유형', assignee: '담당자', reporter: '요청자', priority: '우선순위',
  labels: '라벨', due: '목표 마감일', component: 'Jira 컴포넌트',
};
const disjunctionMessage = 'OR는 상태 조건끼리 또는 컴포넌트 조건끼리 연결할 수 있습니다. 다른 조건과 AND로 연결할 때는 OR 조건을 괄호로 묶어 주세요.';
const priorities = (Object.keys(PRIORITY) as Priority[]).map(id => ({ id, label: PRIORITY[id] }));

function isBare(token: Token, value: string): boolean {
  return (token.kind === 'symbol' || token.kind === 'word') && token.value.toLowerCase() === value;
}

function quotedToken(query: string, start: number): { token: Token; end: number } {
  const delimiter = query[start];
  let value = '';
  for (let offset = start + 1; offset < query.length; offset++) {
    const character = query[offset];
    if (character === delimiter) {
      if (!value.trim()) throw new JiraViewQueryError('따옴표 안에 값을 입력해 주세요.', start);
      return { token: { kind: 'quoted', value, offset: start }, end: offset + 1 };
    }
    if (character === '\\') {
      const escaped = query[++offset];
      if (escaped !== '\\' && escaped !== '"' && escaped !== "'") {
        throw new JiraViewQueryError('따옴표와 역슬래시만 역슬래시로 이스케이프할 수 있습니다.', offset - 1);
      }
      value += escaped;
    } else {
      if (controls.test(character)) throw new JiraViewQueryError('따옴표 안에 줄바꿈이나 제어 문자를 사용할 수 없습니다.', offset);
      value += character;
    }
  }
  throw new JiraViewQueryError('닫는 따옴표를 찾을 수 없습니다.', start);
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < query.length) {
    const character = query[offset];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      offset++;
      continue;
    }
    if (tokens.length === MAX_TOKENS) throw new JiraViewQueryError('JQL에 지정된 조건이 너무 많습니다.', offset);
    if (character === '"' || character === "'") {
      const quoted = quotedToken(query, offset);
      tokens.push(quoted.token);
      offset = quoted.end;
      continue;
    }
    const comparison = query.slice(offset, offset + 2);
    const symbol = ['!=', '<=', '>='].includes(comparison) ? comparison : '(),=<>'.includes(character) ? character : undefined;
    if (symbol) {
      tokens.push({ kind: 'symbol', value: symbol, offset });
      offset += symbol.length;
      continue;
    }
    customFieldWord.lastIndex = offset;
    literalWord.lastIndex = offset;
    const word = customFieldWord.exec(query)?.[0] ?? literalWord.exec(query)?.[0];
    if (!word) throw new JiraViewQueryError('지원하지 않는 문자가 있습니다. 기호가 포함된 값은 따옴표로 감싸 주세요.', offset);
    tokens.push({ kind: 'word', value: word, offset });
    offset += word.length;
  }
  tokens.push({ kind: 'end', value: '', offset });
  return tokens;
}

function parseField(token: Token): Field {
  const value = token.value.toLowerCase();
  switch (value) {
    case 'project': case 'status': case 'type': case 'assignee': case 'reporter': case 'priority': case 'labels': case 'due': case 'component':
      return value;
    case 'issuetype':
      return 'type';
    case 'duedate':
      return 'due';
    default:
      throw new JiraViewQueryError('이 JQL 필드는 이슈 보기에서 지원되지 않습니다.', token.offset);
  }
}

class QueryParser {
  private index = 0;
  private clauseCount = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): { clauses: Clause[]; orderBy: Translation['orderBy'] } {
    const clauses = isBare(this.current(), 'order') ? [] : this.disjunction(0);
    const orderBy = this.consume('order') ? this.sort() : [];
    const rest = this.current();
    if (rest.kind !== 'end') throw new JiraViewQueryError('조건 연결과 괄호를 확인하고, 정렬은 마지막에 ORDER BY로 지정해 주세요.', rest.offset);
    return { clauses, orderBy };
  }

  private current(): Token {
    return this.tokens[this.index];
  }

  private consume(value: string): boolean {
    if (!isBare(this.current(), value)) return false;
    this.index++;
    return true;
  }

  private expect(value: string, message: string) {
    if (!this.consume(value)) throw new JiraViewQueryError(message, this.current().offset);
  }

  private literal(message: string, allowCustomField = false): Token {
    const token = this.current();
    if (token.kind !== 'quoted' && (token.kind !== 'word' || reservedWords.has(token.value.toLowerCase()) || (!allowCustomField && token.value.includes('[')))) {
      throw new JiraViewQueryError(message, token.offset);
    }
    this.index++;
    if (isBare(this.current(), '(')) throw new JiraViewQueryError('JQL 함수는 가져올 수 없습니다.', token.offset);
    return token;
  }

  private disjunction(depth: number): Clause[] {
    const first = this.conjunction(depth);
    const offset = this.current().offset;
    if (!this.consume('or')) return first;
    if (first.every(isStatusClause)) return [{ field: 'status', offset, branches: this.branches(first, depth, offset, isStatusClause) }];
    if (first.every(isComponentClause)) return [{ field: 'component', offset, branches: this.branches(first, depth, offset, isComponentClause) }];
    throw new JiraViewQueryError(disjunctionMessage, offset);
  }

  private branches<T extends Clause>(first: T[], depth: number, offset: number, check: (clause: Clause) => clause is T): T[][] {
    const branches = [first];
    let separator = offset;
    while (true) {
      const branch = this.conjunction(depth);
      if (!branch.every(check)) throw new JiraViewQueryError(disjunctionMessage, separator);
      branches.push(branch);
      separator = this.current().offset;
      if (!this.consume('or')) break;
    }
    return branches;
  }

  private conjunction(depth: number): Clause[] {
    const clauses = this.primary(depth);
    while (this.consume('and')) clauses.push(...this.primary(depth));
    return clauses;
  }

  private primary(depth: number): Clause[] {
    if (this.consume('(')) {
      if (depth === MAX_NESTING) throw new JiraViewQueryError('JQL 괄호가 너무 깊게 중첩되어 있습니다.', this.current().offset);
      const clauses = this.disjunction(depth + 1);
      this.expect(')', '조건을 마치는 닫는 괄호가 필요합니다.');
      return clauses;
    }
    if (this.clauseCount === MAX_CLAUSES) throw new JiraViewQueryError(`JQL 조건은 최대 ${MAX_CLAUSES}개까지 지정할 수 있습니다.`, this.current().offset);
    this.clauseCount++;
    return [this.clause()];
  }

  private clause(): Clause {
    const start = this.literal('JQL 조건 필드를 입력해 주세요.');
    const field = parseField(start);
    if (field === 'due') return this.dueClause(start.offset);
    const base = { field, offset: start.offset };
    if (this.consume('=')) {
      if ((field === 'assignee' || field === 'reporter') && isBare(this.current(), 'currentuser') && isBare(this.tokens[this.index + 1], '(')) {
        this.index += 2;
        this.expect(')', 'currentUser()에는 인수를 지정할 수 없습니다.');
        return { field, offset: start.offset, operator: 'current-user' };
      }
      return { ...base, operator: '=', values: [this.literal('비교할 값을 입력해 주세요.')] };
    }
    if (base.field === 'status' && this.consume('in')) return { ...base, operator: 'in', values: this.list('상태', ISSUE_VIEW_STATUS_LIMIT) };
    if (base.field === 'priority' && this.consume('in')) return { ...base, operator: 'in', values: this.list(fieldLabels.priority, MAX_TOKENS) };
    const isMultiValue = field === 'labels' || field === 'component';
    if (isMultiValue) {
      const label = fieldLabels[field];
      const limit = field === 'labels' ? ISSUE_VIEW_LABEL_FILTER_LIMIT : MAX_TOKENS;
      if (this.consume('!=')) {
        const valueMessage = field === 'labels' ? '제외할 라벨을 입력해 주세요.' : '제외할 컴포넌트를 입력해 주세요.';
        return { ...base, operator: '!=', values: [this.literal(valueMessage)] };
      }
      if (this.consume('in')) return { ...base, operator: 'in', values: this.list(label, limit) };
      if (this.consume('not')) {
        this.expect('in', `${label} 제외 목록에는 NOT IN을 사용해 주세요.`);
        return { ...base, operator: 'not in', values: this.list(label, limit) };
      }
    }
    if ((field === 'assignee' || field === 'reporter' || isMultiValue) && this.consume('is')) {
      const operator = isMultiValue && this.consume('not') ? 'set' : 'empty';
      if (!this.consume('empty') && !this.consume('null')) throw new JiraViewQueryError('값이 비어 있는지 확인하려면 EMPTY 또는 NULL을 사용해 주세요.', this.current().offset);
      return { ...base, operator };
    }
    throw new JiraViewQueryError('이 JQL 연산자는 해당 필드의 저장된 보기에서 지원되지 않습니다.', this.current().offset);
  }

  private dueClause(offset: number): DueClause {
    const clause: DueClause = { field: 'due', offset };
    if (this.consume('is')) {
      const presence = this.consume('not') ? 'set' : 'empty';
      if (!this.consume('empty') && !this.consume('null')) {
        throw new JiraViewQueryError('목표 마감일이 비어 있는지 확인하려면 EMPTY 또는 NULL을 사용해 주세요.', this.current().offset);
      }
      return { ...clause, presence };
    }
    const operator = this.current();
    if (operator.kind !== 'symbol' || !dueOperators.includes(operator.value)) {
      throw new JiraViewQueryError('목표 마감일에는 =, <, <=, >, >=, IS, IS NOT을 사용할 수 있습니다.', operator.offset);
    }
    this.index++;
    const dateMessage = '목표 마감일은 따옴표로 감싼 유효한 YYYY-MM-DD 또는 YYYY/MM/DD 날짜여야 합니다.';
    const value = this.literal(dateMessage);
    const date = value.value.replace(/^(\d{4})\/(\d{2})\/(\d{2})$/u, '$1-$2-$3');
    if (value.kind !== 'quoted' || !isCalendarDate(date)) throw new JiraViewQueryError(dateMessage, value.offset);

    switch (operator.value) {
      case '=': return { ...clause, from: date, to: date };
      case '>=': return { ...clause, from: date };
      case '<=': return { ...clause, to: date };
      case '>':
        if (date !== MAX_CALENDAR_DATE) return { ...clause, from: calendarDate(calendarDay(date) + 1) };
        break;
      case '<':
        if (date !== MIN_CALENDAR_DATE) return { ...clause, to: calendarDate(calendarDay(date) - 1) };
        break;
    }
    throw new JiraViewQueryError('목표 마감일 조건에 일치할 수 있는 날짜가 없습니다.', value.offset);
  }

  private list(label: string, limit: number): Token[] {
    this.expect('(', `${label} 목록을 괄호로 감싸 주세요.`);
    const values: Token[] = [];
    do {
      if (values.length === limit) throw new JiraViewQueryError(`${label} 목록은 최대 ${limit}개까지 지정할 수 있습니다.`, this.current().offset);
      values.push(this.literal(`${label} 목록에 값을 입력해 주세요.`));
    } while (this.consume(','));
    this.expect(')', `${label} 목록에 닫는 괄호가 필요합니다.`);
    return values;
  }

  private sort(): Translation['orderBy'] {
    this.expect('by', '정렬에는 ORDER BY를 사용해 주세요.');
    const orderBy: Translation['orderBy'] = [];
    do {
      if (orderBy.length === MAX_SORT_FIELDS) throw new JiraViewQueryError(`정렬 필드는 최대 ${MAX_SORT_FIELDS}개까지 지정할 수 있습니다.`, this.current().offset);
      const { value: field } = this.literal('정렬 필드를 입력해 주세요.', true);
      const direction = this.consume('asc') ? 'asc' : this.consume('desc') ? 'desc' : undefined;
      orderBy.push(direction ? { field, direction } : { field });
    } while (this.consume(','));
    return orderBy;
  }
}

function translateOrderBy(orderBy: Translation['orderBy']): Pick<Translation, 'sort' | 'requiresProjectOrderAcceptance'> {
  if (!orderBy.length) return {};
  const sort: IssueViewSortRule[] = [];
  for (const { field, direction } of orderBy) {
    const name = field.toLowerCase();
    const target = name === 'due' || name === 'duedate' ? 'dueDate'
      : name === 'created' || name === 'createddate' ? 'createdAt'
        : name === 'updated' || name === 'updateddate' ? 'updatedAt' : undefined;
    // Jira has field-specific defaults and an administrator-defined priority order. Original ranks are also unavailable.
    if (!direction || !target || sort.some(rule => rule.field === target)) return { requiresProjectOrderAcceptance: true };
    sort.push({ field: target, direction });
  }
  return { sort };
}

function sameIdentifier(candidate: string, value: string): boolean {
  return candidate.toLowerCase() === value.toLowerCase();
}

function resolveValue<T extends { id: string }>(field: JiraViewAliasField, value: Token, candidates: readonly T[],
  keys: (item: T) => string[], resolveSourceAlias?: JiraViewSourceAliasResolver): T {
  const source = resolveSourceAlias?.(field, value.value);
  if (source?.kind === 'ambiguous') {
    throw new JiraViewQueryError(`${fieldLabels[field]} · 이관 원본에서 이 값을 하나의 현재 값으로 구분할 수 없습니다.`, value.offset);
  }
  if (source && (source.kind === 'unmapped' || source.kind === 'mapped' && !candidates.some(item => item.id === source.targetId))) {
    throw new JiraViewQueryError(`${fieldLabels[field]} · 이관 원본에 대응하는 현재 값을 찾을 수 없습니다.`, value.offset);
  }
  const matches = candidates.filter(item => (source?.kind === 'mapped' && item.id === source.targetId) ||
    keys(item).some(key => sameIdentifier(key, value.value)));
  if (matches.length !== 1) {
    const message = matches.length ? '해당하는 값이 여러 개 있습니다. 고유한 값을 입력해 주세요.' : '선택한 프로젝트에서 해당 값을 찾을 수 없습니다.';
    throw new JiraViewQueryError(`${fieldLabels[field]} · ${message}`, value.offset);
  }
  return matches[0];
}

function isSelectableId(id: string): boolean {
  return Boolean(id) && id.trim() === id && id !== 'all';
}

function projectCriterion(context: JiraViewQueryContext, value?: Token) {
  const { project, sourceProjectAliases = [], blockedSourceProjectAliases = [] } = context;
  if (value) {
    if (blockedSourceProjectAliases.some(alias => sameIdentifier(alias, value.value))) {
      throw new JiraViewQueryError('여러 Jira 프로젝트에서 가져온 이슈를 기존 프로젝트 조건으로 구분할 수 없습니다.', value.offset);
    }
    if (![project.id, project.key, project.name, ...sourceProjectAliases].some(alias => sameIdentifier(alias, value.value))) {
      throw new JiraViewQueryError('JQL의 프로젝트가 선택한 프로젝트와 일치하지 않습니다.', value.offset);
    }
  }
  return `프로젝트 · ${project.key} ${project.name}`;
}

function scalarCondition(field: Exclude<ScalarField, 'status'>, clause: BasicClause | CurrentUserClause, context: JiraViewQueryContext,
  resolveSourceAlias?: JiraViewSourceAliasResolver): ScalarCondition {
  if (clause.operator === 'current-user') return { id: null, label: `${fieldLabels[field]} · 현재 사용자` };
  if (!('values' in clause)) return { id: '', label: `${fieldLabels[field]} 없음` };
  const [value] = clause.values;
  if (field === 'project') return { id: context.project.id, label: projectCriterion(context, value) };
  if (field === 'type') {
    const type = resolveValue(field, value, context.issueTypes, item => [item.id, item.name], resolveSourceAlias);
    if (type.archived || !isSelectableId(type.id)) throw new JiraViewQueryError('이슈 유형은 현재 프로젝트에서 개별 값으로 선택할 수 있어야 합니다.', value.offset);
    return { id: type.id, label: `이슈 유형 · ${type.name}` };
  }
  const user = resolveValue(field, value, context.users, item => [item.id, item.name, item.email], resolveSourceAlias);
  if (!user.id || (field === 'assignee' && (user.id === 'none' || !isSelectableId(user.id)))) {
    throw new JiraViewQueryError('이 팀원은 저장된 보기에서 개별 값으로 선택할 수 없습니다.', value.offset);
  }
  return { id: user.id, label: `${fieldLabels[field]} · ${user.name}` };
}

function statusIntersection(clauses: readonly StatusClause[], context: JiraViewQueryContext, resolveSourceAlias?: JiraViewSourceAliasResolver) {
  let selected: Map<string, string> | undefined;
  for (const clause of clauses) {
    const options = new Map<string, string>();
    if ('branches' in clause) {
      for (const branch of clause.branches) {
        for (const [id, label] of statusIntersection(branch, context, resolveSourceAlias)) options.set(id, label);
      }
    } else {
      for (const value of clause.values) {
        const { id, label } = resolveValue('status', value, context.statuses, item => [item.id, item.label], resolveSourceAlias);
        if (!isSelectableId(id)) throw new JiraViewQueryError('이 상태는 저장된 보기에서 개별 값으로 선택할 수 없습니다.', value.offset);
        options.set(id, label);
      }
    }
    if (!selected) selected = options;
    else for (const id of selected.keys()) if (!options.has(id)) selected.delete(id);
  }
  return selected ?? new Map<string, string>();
}

function priorityFilter(clauses: readonly PriorityClause[], requireSource: boolean, resolveSourceAlias?: JiraViewSourceAliasResolver): Priority[] | undefined {
  if (!clauses.length) return undefined;
  // Intersect original values before converting them. One Teamspace priority can represent several Jira options.
  const coverage = new Map<Priority, Set<string | null>>();
  let selected: Map<Priority, Set<string | null>> | undefined;
  for (const { values } of clauses) {
    const options = new Map<Priority, Set<string | null>>();
    for (const value of values) {
      const source = resolveSourceAlias?.('priority', value.value) ?? (requireSource ? { kind: 'unmapped' as const } : undefined);
      const { id } = resolveValue('priority', value, priorities, item => [item.id, item.label], () => source);
      const matchedSources = source?.kind === 'mapped' ? [source.sourceId, ...(source.sameNameSourceIds ?? [])] : [null];
      const originals = new Set<string | null>(source?.kind === 'mapped' ? source.targetSourceIds ?? [source.sourceId] : [null]);
      const previous = coverage.get(id);
      if (matchedSources.some(sourceId => !originals.has(sourceId)) ||
          (previous && (previous.size !== originals.size || [...previous].some(item => !originals.has(item))))) {
        throw new JiraViewQueryError('우선순위 · 이관 원본에서 이 값을 하나의 현재 값으로 구분할 수 없습니다.', value.offset);
      }
      coverage.set(id, originals);
      const included = options.get(id) ?? new Set<string | null>();
      for (const sourceId of matchedSources) included.add(sourceId);
      options.set(id, included);
    }
    if (!selected) selected = options;
    else for (const [id, included] of selected) {
      const other = options.get(id);
      for (const sourceId of included) if (!other?.has(sourceId)) included.delete(sourceId);
      if (included.size === 0) selected.delete(id);
    }
  }

  const offset = clauses.at(-1)?.offset;
  if (!selected?.size) throw new JiraViewQueryError('우선순위 조건에 공통으로 일치하는 값이 없습니다.', offset);
  for (const [id, included] of selected) {
    if (included.size !== coverage.get(id)?.size) {
      throw new JiraViewQueryError(`우선순위 · 현재 값 ‘${PRIORITY[id]}’에 함께 이관된 원본 값을 하나의 보기에서 나눌 수 없습니다.`, offset);
    }
  }
  return parseIssueViewPriorities([...selected.keys()]);
}

function dueFilter(clauses: readonly DueClause[]) {
  if (!clauses.length) return undefined;
  let from: string | undefined;
  let to: string | undefined;
  let presence: DueClause['presence'];
  for (const clause of clauses) {
    if (clause.presence && presence && clause.presence !== presence) {
      throw new JiraViewQueryError('목표 마감일 입력 여부 조건이 서로 충돌합니다.', clause.offset);
    }
    presence = clause.presence ?? presence;
    if (clause.from && (!from || from < clause.from)) from = clause.from;
    if (clause.to && (!to || to > clause.to)) to = clause.to;
    if ((presence === 'empty' && (from || to)) || (from && to && from > to)) {
      throw new JiraViewQueryError('목표 마감일 조건에 공통으로 일치할 수 있는 날짜가 없습니다.', clause.offset);
    }
  }
  if (!from && !to) return presence === 'empty' ? { dates: { mode: 'due_missing' as const }, label: '목표 마감일 없음' }
    : { dates: { mode: 'due_set' as const }, label: '목표 마감일 있음' };
  const range = from && to ? `${from} ~ ${to}` : from ? `${from}부터` : `${to}까지`;
  return { dates: { mode: 'due' as const, ...(from ? { from } : {}), ...(to ? { to } : {}) }, label: `${fieldLabels.due} · ${range}` };
}

function checkLabel(value: Token): string {
  if (value.value.length > ISSUE_VIEW_LABEL_MAX_LENGTH) {
    throw new JiraViewQueryError(`라벨은 최대 ${ISSUE_VIEW_LABEL_MAX_LENGTH}자까지 지정할 수 있습니다.`, value.offset);
  }
  return value.value;
}

function labelFilter(clauses: BasicClause[]): IssueViewLabelFilter | undefined {
  if (!clauses.length) return undefined;
  const required = new Set<string>();
  const excluded = new Set<string>();
  const anyGroups: string[][] = [];
  let empty = false;
  let set = false;
  for (const clause of clauses) {
    if (!('values' in clause)) {
      if (clause.operator === 'empty') empty = true;
      else set = true;
      continue;
    }
    const values = clause.values.map(checkLabel);
    if (clause.operator === '=') required.add(values[0]);
    else if (clause.operator === 'in') anyGroups.push(values);
    else {
      for (const value of values) excluded.add(value);
      // In Jira, negative comparisons only match issues whose label field is set.
      set = true;
    }
  }

  const offset = clauses[0].offset;
  const conflict = () => new JiraViewQueryError('서로 충돌하는 라벨 조건은 가져올 수 없습니다.', offset);
  if (empty && (set || required.size || anyGroups.length)) throw conflict();
  const remainingGroups: string[][] = [];
  for (const group of anyGroups) {
    const remaining = [...new Set(group)].filter(value => !excluded.has(value));
    if (!remaining.length) throw conflict();
    if (remaining.length === 1) required.add(remaining[0]);
    else remainingGroups.push(remaining);
  }
  if ([...required].some(value => excluded.has(value))) throw conflict();

  const minimalGroups: string[][] = [];
  for (const group of remainingGroups.sort((a, b) => a.length - b.length)) {
    if (group.some(value => required.has(value))) continue;
    if (minimalGroups.some(smaller => smaller.every(value => group.includes(value)))) continue;
    minimalGroups.push(group);
  }
  if (minimalGroups.length > 1 || (minimalGroups.length && required.size)) {
    throw new JiraViewQueryError('이 라벨 조합을 하나의 이슈 보기 조건으로 표현할 수 없습니다.', offset);
  }
  const include = minimalGroups[0] ?? [...required];
  if (include.length > ISSUE_VIEW_LABEL_FILTER_LIMIT || excluded.size > ISSUE_VIEW_LABEL_FILTER_LIMIT) {
    throw new JiraViewQueryError(`합쳐진 라벨 조건은 목록마다 최대 ${ISSUE_VIEW_LABEL_FILTER_LIMIT}개까지 지정할 수 있습니다.`, offset);
  }
  return parseIssueViewLabelFilter({
    ...(include.length ? { include, ...(required.size ? { match: 'all' } : {}) } : {}),
    ...(excluded.size ? { exclude: [...excluded] } : {}),
    ...(empty || set ? { presence: empty ? 'empty' : 'set' } : {}),
  });
}

type ComponentRule = { operator: 'includes' | 'excludes'; value: string } | { operator: 'is_empty' | 'is_set'; value?: never };

function componentRuleKey(rule: ComponentRule): string {
  return `${rule.operator}:${rule.value ?? ''}`;
}

function incompatibleComponentRules(left: ComponentRule, right: ComponentRule) {
  if (left.operator === right.operator) return false;
  if (left.operator === 'is_empty' || right.operator === 'is_empty') return true;
  return left.value !== undefined && right.value !== undefined && left.value === right.value;
}

/** Each group is an OR of rules. All groups must match. */
function simplifyComponentGroups(groups: ComponentRule[][], offset: number): ComponentRule[][] {
  const required = new Map<string, ComponentRule>();
  let alternatives = groups.map(group => [...new Map(group.map(rule => [componentRuleKey(rule), rule])).values()]);
  // A required term can leave just one viable alternative, which then becomes required itself.
  for (;;) {
    const before = required.size;
    alternatives = alternatives.flatMap(group => {
      const present = [...required.values()];
      if (group.some(rule => required.has(componentRuleKey(rule)) ||
          rule.operator === 'is_set' && present.some(known => known.operator !== 'is_empty'))) return [];
      const possible = group.filter(rule => !present.some(known => incompatibleComponentRules(known, rule)));
      if (!possible.length) throw new JiraViewQueryError('서로 충돌하는 컴포넌트 조건은 가져올 수 없습니다.', offset);
      if (possible.length > 1) return [possible];
      required.set(componentRuleKey(possible[0]), possible[0]);
      return [];
    });
    if (before === required.size) break;
  }
  if (required.size > 1) required.delete(componentRuleKey({ operator: 'is_set' }));
  const minimal: ComponentRule[][] = [];
  for (const group of alternatives.sort((left, right) => left.length - right.length)) {
    const keys = new Set(group.map(componentRuleKey));
    if (!minimal.some(smaller => smaller.every(rule => keys.has(componentRuleKey(rule))))) minimal.push(group);
  }
  return [...[...required.values()].map(rule => [rule]), ...minimal];
}

function componentFilter(clauses: readonly ComponentClause[], context: JiraViewQueryContext) {
  if (!clauses.length) return undefined;
  const field = context.prepareComponentField?.();
  const offset = clauses[0].offset;
  if (!field) throw new JiraViewQueryError('선택한 프로젝트에서 이관한 Jira 컴포넌트 필드를 확인할 수 없습니다.', offset);

  const labels = new Map<string, string>();
  const collect = (conditions: readonly ComponentClause[]): ComponentRule[][] => {
    return simplifyComponentGroups(conditions.flatMap(clause => {
      if ('branches' in clause) {
        const branches = clause.branches.map(collect);
        if (branches.some(branch => branch.length !== 1)) {
          throw new JiraViewQueryError('이 컴포넌트 OR 조합을 하나의 이슈 보기 조건으로 표현할 수 없습니다.', clause.offset);
        }
        return [branches.flatMap(branch => branch[0])];
      }
      if (!('values' in clause)) {
        if (!field.hasCompleteCoverage) {
          throw new JiraViewQueryError('이관 원본에서 컴포넌트 값 유무를 확인할 수 없습니다.', clause.offset);
        }
        return [[{ operator: clause.operator === 'empty' ? 'is_empty' : 'is_set' }]];
      }
      const excludes = clause.operator === '!=' || clause.operator === 'not in';
      if (excludes && !field.hasCompleteCoverage) {
        throw new JiraViewQueryError('이관 원본에서 컴포넌트 제외 조건의 결과를 확인할 수 없습니다.', clause.offset);
      }
      const rules: ComponentRule[] = clause.values.map(value => {
        const source = field.resolve(value.value, value.kind === 'quoted');
        if (source?.kind === 'ambiguous') {
          throw new JiraViewQueryError('이관 원본에서 컴포넌트 값을 하나로 구분할 수 없습니다. 원본 컴포넌트와 이관 매핑을 확인해 주세요.', value.offset);
        }
        if (source?.kind !== 'mapped') {
          throw new JiraViewQueryError('이관 원본에 대응하는 현재 Jira 컴포넌트 값을 찾을 수 없습니다.', value.offset);
        }
        labels.set(source.targetId, source.label);
        return { operator: excludes ? 'excludes' : 'includes', value: source.targetId };
      });
      // Each exclusion must match, and native exclusions already require a present value.
      return excludes ? rules.map(rule => [rule]) : [rules];
    }), conditions[0].offset);
  };

  const groups = collect(clauses);
  const match = groups.length === 1 && groups[0].length > 1 ? 'any' : 'all';
  if (match === 'all' && groups.some(group => group.length > 1)) {
    throw new JiraViewQueryError('이 컴포넌트 조합을 하나의 이슈 보기 조건으로 표현할 수 없습니다.', offset);
  }
  const rules = groups.flat();
  if (rules.length > MAX_FIELD_FILTER_RULES) {
    throw new JiraViewQueryError(`합쳐진 컴포넌트 조건은 최대 ${MAX_FIELD_FILTER_RULES}개까지 지정할 수 있습니다.`, offset);
  }
  const filter: IssueFieldFilter = { match, rules: rules.map(rule => ({ fieldId: field.fieldId, ...rule })) };
  const label = rules.map(rule => {
    switch (rule.operator) {
      case 'is_empty': return '값 없음';
      case 'is_set': return '값 있음';
      case 'includes': return `포함 ${labels.get(rule.value)}`;
      case 'excludes': return `제외 ${labels.get(rule.value)}`;
    }
  }).join(match === 'any' ? ' 또는 ' : ', ');
  return { filter, label: `${field.name} · ${label}` };
}

/** Translate only conditions the normal project issue matcher can evaluate without approximation. */
export function translateJiraViewQuery(query: unknown, context: JiraViewQueryContext): Translation {
  if (typeof query !== 'string') throw new JiraViewQueryError('JQL을 입력해 주세요.');
  if (query.length > JIRA_SAVED_VIEW_QUERY_LIMIT) throw new JiraViewQueryError(`JQL은 최대 ${JIRA_SAVED_VIEW_QUERY_LIMIT}자까지 입력할 수 있습니다.`);
  if (!query.trim()) throw new JiraViewQueryError('JQL을 입력해 주세요.');
  if (!query.isWellFormed()) throw new JiraViewQueryError('JQL에 잘못된 유니코드 문자가 있습니다.');
  const { clauses, orderBy } = new QueryParser(tokenize(query)).parse();
  const aliasFields = new Set<JiraViewAliasField>();
  if (context.prepareSourceAliases) for (const clause of clauses) {
    if (('values' in clause || 'branches' in clause) &&
        clause.field !== 'project' && clause.field !== 'labels' && clause.field !== 'component') aliasFields.add(clause.field);
  }
  const resolveSourceAlias = aliasFields.size ? context.prepareSourceAliases?.([...aliasFields]) : undefined;
  const filters: Translation['filters'] = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
  const conditions = new Map<ScalarField, ScalarCondition>();
  const labelClauses: BasicClause[] = [];
  const statusClauses: StatusClause[] = [];
  const priorityClauses: PriorityClause[] = [];
  const dueClauses: DueClause[] = [];
  for (const clause of clauses) {
    if (isStatusClause(clause)) {
      statusClauses.push(clause);
      continue;
    }
    const { field } = clause;
    if (field === 'component') continue;
    if (field === 'labels') {
      labelClauses.push(clause);
      continue;
    }
    if (field === 'priority') {
      if (!('values' in clause)) throw new JiraViewQueryError('지원하지 않는 우선순위 조건입니다.', clause.offset);
      priorityClauses.push(clause);
      continue;
    }
    if (field === 'due') {
      dueClauses.push(clause);
      continue;
    }
    if (field === 'status') throw new JiraViewQueryError('지원하지 않는 상태 조건입니다.', clause.offset);
    const condition = scalarCondition(field, clause, context, resolveSourceAlias);
    const previous = conditions.get(field);
    if (previous && previous.id !== condition.id) throw new JiraViewQueryError(`${fieldLabels[field]}에 서로 충돌하는 조건이 있습니다.`, clause.offset);
    conditions.set(field, condition);
  }
  filters.type = conditions.get('type')?.id ?? 'all';
  const assignee = conditions.get('assignee');
  if (assignee?.id === null) filters.assignee = { kind: 'current-user' };
  else if (assignee) filters.assigneeId = assignee.id || 'none';
  const reporter = conditions.get('reporter');
  if (reporter) filters.reporter = reporter.id === null ? { kind: 'current-user' }
    : reporter.id ? { kind: 'member', memberId: reporter.id } : { kind: 'unset' };
  let statusLabel: string | undefined;
  if (statusClauses.length) {
    const statuses = statusIntersection(statusClauses, context, resolveSourceAlias);
    if (!statuses.size) throw new JiraViewQueryError('상태 조건에 공통으로 일치하는 상태가 없습니다.', statusClauses.at(-1)?.offset);
    if (statuses.size > ISSUE_VIEW_STATUS_LIMIT) throw new JiraViewQueryError(`상태는 최대 ${ISSUE_VIEW_STATUS_LIMIT}개까지 지정할 수 있습니다.`, statusClauses[0].offset);
    const ids = [...statuses.keys()].sort();
    Object.assign(filters, issueViewStatusCriteria(ids));
    statusLabel = `상태 · ${ids.map(id => statuses.get(id)).join(', ')}`;
  }
  const labels = labelFilter(labelClauses);
  if (labels) filters.labels = labels;
  const requirePrioritySource = Boolean(context.sourceProjectAliases?.length || context.blockedSourceProjectAliases?.length);
  const selectedPriorities = priorityFilter(priorityClauses, requirePrioritySource, resolveSourceAlias);
  if (selectedPriorities) filters.priorities = selectedPriorities;
  const [priorityLabel] = issuePriorityLabelFilterLabels({ priorities: selectedPriorities });
  const due = dueFilter(dueClauses);
  if (due) filters.planning = { dates: due.dates };
  const component = componentFilter(clauses.filter(isComponentClause), context);
  if (component) filters.fieldFilter = component.filter;
  const fields = new Set(clauses.map(clause => clause.field));
  const criteria: Translation['criteria'] = [
    { field: 'project', label: projectCriterion(context) },
    ...[...fields].flatMap(field => {
      if (field === 'project' || field === 'labels') return [];
      const label = field === 'status' ? statusLabel : field === 'due' ? due?.label : field === 'priority' ? priorityLabel
        : field === 'component' ? component?.label : conditions.get(field)?.label;
      return label === undefined ? [] : [{ field, label }];
    }),
    ...issuePriorityLabelFilterLabels({ labels }).map(label => ({ field: 'labels', label })),
  ];
  return { filters, criteria, orderBy, ...translateOrderBy(orderBy) };
}
