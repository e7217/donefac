import { ISSUE_VIEW_LABEL_FILTER_LIMIT, ISSUE_VIEW_LABEL_MAX_LENGTH, issuePriorityLabelFilterLabels, parseIssueViewLabelFilter } from './issue-view.js';
import { JIRA_SAVED_VIEW_QUERY_LIMIT, type IssueTypeDefinition, type IssueViewLabelFilter, type JiraSavedViewPreview, type Project, type User, type WorkflowStatus } from './types.js';

export interface JiraViewQueryContext {
  project: Pick<Project, 'id' | 'key' | 'name'>;
  sourceProjectAliases?: readonly string[];
  blockedSourceProjectAliases?: readonly string[];
  statuses: readonly Pick<WorkflowStatus, 'id' | 'label'>[];
  issueTypes: readonly Pick<IssueTypeDefinition, 'id' | 'name' | 'archived'>[];
  users: readonly Pick<User, 'id' | 'name' | 'email'>[];
  prepareSourceAliases?: (fields: readonly JiraViewAliasField[]) => JiraViewSourceAliasResolver | undefined;
}

export class JiraViewQueryError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(message);
    this.name = 'JiraViewQueryError';
  }
}

type Translation = Pick<JiraSavedViewPreview, 'filters' | 'criteria' | 'orderBy'>;
export type JiraViewAliasField = 'status' | 'type' | 'assignee' | 'reporter';
export type JiraViewSourceAlias = { kind: 'mapped'; sourceId: string; targetId: string } | { kind: 'ambiguous' | 'unmapped' };
export type JiraViewSourceAliasResolver = (field: JiraViewAliasField, value: string) => JiraViewSourceAlias | undefined;
type ScalarField = 'project' | JiraViewAliasField;
type Field = ScalarField | 'labels';
type Token = { kind: 'word' | 'quoted' | 'symbol' | 'end'; value: string; offset: number };
type Clause = { field: Field; offset: number } & (
  | { operator: '=' | '!=' | 'in' | 'not in'; values: Token[] }
  | { operator: 'empty' | 'set' }
);

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
const fieldLabels: Record<Field, string> = {
  project: '프로젝트', status: '상태', type: '이슈 유형', assignee: '담당자', reporter: '요청자', labels: '라벨',
};

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
    const symbol = query.startsWith('!=', offset) ? '!=' : '(),='.includes(character) ? character : undefined;
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
    case 'project': case 'status': case 'type': case 'assignee': case 'reporter': case 'labels':
      return value;
    case 'issuetype':
      return 'type';
    default:
      throw new JiraViewQueryError('이 JQL 필드는 이슈 보기에서 지원되지 않습니다.', token.offset);
  }
}

class QueryParser {
  private index = 0;
  private readonly clauses: Clause[] = [];

  constructor(private readonly tokens: Token[]) {}

  parse(): { clauses: Clause[]; orderBy: Translation['orderBy'] } {
    if (!isBare(this.current(), 'order')) this.conjunction(0);
    const orderBy = this.consume('order') ? this.sort() : [];
    const rest = this.current();
    if (rest.kind !== 'end') throw new JiraViewQueryError('조건은 AND로 연결하고, 정렬은 마지막에 ORDER BY로 지정해 주세요.', rest.offset);
    return { clauses: this.clauses, orderBy };
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

  private conjunction(depth: number) {
    do {
      if (this.consume('(')) {
        if (depth === MAX_NESTING) throw new JiraViewQueryError('JQL 괄호가 너무 깊게 중첩되어 있습니다.', this.current().offset);
        this.conjunction(depth + 1);
        this.expect(')', '괄호 안에는 AND 조건만 사용할 수 있으며 닫는 괄호가 필요합니다.');
      } else {
        if (this.clauses.length === MAX_CLAUSES) throw new JiraViewQueryError(`JQL 조건은 최대 ${MAX_CLAUSES}개까지 지정할 수 있습니다.`, this.current().offset);
        this.clauses.push(this.clause());
      }
    } while (this.consume('and'));
  }

  private clause(): Clause {
    const start = this.literal('JQL 조건 필드를 입력해 주세요.');
    const base = { field: parseField(start), offset: start.offset };
    if (this.consume('=')) return { ...base, operator: '=', values: [this.literal('비교할 값을 입력해 주세요.')] };
    if (base.field === 'labels') {
      if (this.consume('!=')) return { ...base, operator: '!=', values: [this.literal('제외할 라벨을 입력해 주세요.')] };
      if (this.consume('in')) return { ...base, operator: 'in', values: this.list() };
      if (this.consume('not')) {
        this.expect('in', '라벨 제외 목록에는 NOT IN을 사용해 주세요.');
        return { ...base, operator: 'not in', values: this.list() };
      }
    }
    if ((base.field === 'assignee' || base.field === 'reporter' || base.field === 'labels') && this.consume('is')) {
      const operator = base.field === 'labels' && this.consume('not') ? 'set' : 'empty';
      if (!this.consume('empty') && !this.consume('null')) throw new JiraViewQueryError('값이 비어 있는지 확인하려면 EMPTY 또는 NULL을 사용해 주세요.', this.current().offset);
      return { ...base, operator };
    }
    throw new JiraViewQueryError('이 JQL 연산자는 해당 필드의 저장된 보기에서 지원되지 않습니다.', this.current().offset);
  }

  private list(): Token[] {
    this.expect('(', '라벨 목록을 괄호로 감싸 주세요.');
    const values: Token[] = [];
    do {
      if (values.length === ISSUE_VIEW_LABEL_FILTER_LIMIT) throw new JiraViewQueryError(`라벨 목록은 최대 ${ISSUE_VIEW_LABEL_FILTER_LIMIT}개까지 지정할 수 있습니다.`, this.current().offset);
      values.push(this.literal('라벨 목록에 값을 입력해 주세요.'));
    } while (this.consume(','));
    this.expect(')', '라벨 목록에 닫는 괄호가 필요합니다.');
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

function scalarCondition(field: ScalarField, clause: Clause, context: JiraViewQueryContext,
  resolveSourceAlias?: JiraViewSourceAliasResolver): { id: string; label: string } {
  if (!('values' in clause)) return { id: '', label: `${fieldLabels[field]} 없음` };
  const [value] = clause.values;
  if (field === 'project') return { id: context.project.id, label: projectCriterion(context, value) };
  if (field === 'status') {
    const status = resolveValue(field, value, context.statuses, item => [item.id, item.label], resolveSourceAlias);
    if (!isSelectableId(status.id)) throw new JiraViewQueryError('이 상태는 저장된 보기에서 개별 값으로 선택할 수 없습니다.', value.offset);
    return { id: status.id, label: `상태 · ${status.label}` };
  }
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

function checkLabel(value: Token): string {
  if (value.value.length > ISSUE_VIEW_LABEL_MAX_LENGTH) {
    throw new JiraViewQueryError(`라벨은 최대 ${ISSUE_VIEW_LABEL_MAX_LENGTH}자까지 지정할 수 있습니다.`, value.offset);
  }
  return value.value;
}

function labelFilter(clauses: Clause[]): IssueViewLabelFilter | undefined {
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

/** Translate only conditions the normal project issue matcher can evaluate without approximation. */
export function translateJiraViewQuery(query: unknown, context: JiraViewQueryContext): Translation {
  if (typeof query !== 'string') throw new JiraViewQueryError('JQL을 입력해 주세요.');
  if (query.length > JIRA_SAVED_VIEW_QUERY_LIMIT) throw new JiraViewQueryError(`JQL은 최대 ${JIRA_SAVED_VIEW_QUERY_LIMIT}자까지 입력할 수 있습니다.`);
  if (!query.trim()) throw new JiraViewQueryError('JQL을 입력해 주세요.');
  if (!query.isWellFormed()) throw new JiraViewQueryError('JQL에 잘못된 유니코드 문자가 있습니다.');
  const { clauses, orderBy } = new QueryParser(tokenize(query)).parse();
  const aliasFields = new Set<JiraViewAliasField>();
  if (context.prepareSourceAliases) for (const clause of clauses) {
    if (clause.field !== 'project' && clause.field !== 'labels' && 'values' in clause) aliasFields.add(clause.field);
  }
  const resolveSourceAlias = aliasFields.size ? context.prepareSourceAliases?.([...aliasFields]) : undefined;
  const filters: Translation['filters'] = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
  const conditions = new Map<ScalarField, { id: string; label: string }>();
  const labelClauses: Clause[] = [];
  for (const clause of clauses) {
    const { field } = clause;
    if (field === 'labels') {
      labelClauses.push(clause);
      continue;
    }
    const condition = scalarCondition(field, clause, context, resolveSourceAlias);
    const previous = conditions.get(field);
    if (previous && previous.id !== condition.id) throw new JiraViewQueryError(`${fieldLabels[field]}에 서로 충돌하는 조건이 있습니다.`, clause.offset);
    conditions.set(field, condition);
    switch (field) {
      case 'status': filters.status = condition.id; break;
      case 'type': filters.type = condition.id; break;
      case 'assignee': filters.assigneeId = condition.id || 'none'; break;
      case 'reporter': filters.reporter = condition.id ? { kind: 'member', memberId: condition.id } : { kind: 'unset' }; break;
    }
  }
  const labels = labelFilter(labelClauses);
  if (labels) filters.labels = labels;
  conditions.delete('project');
  const criteria: Translation['criteria'] = [
    { field: 'project', label: projectCriterion(context) },
    ...[...conditions].map(([field, condition]) => ({ field, label: condition.label })),
    ...issuePriorityLabelFilterLabels({ labels }).map(label => ({ field: 'labels', label })),
  ];
  return { filters, criteria, orderBy };
}
