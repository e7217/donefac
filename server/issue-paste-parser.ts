import { isCalendarDate } from '../shared/calendar.js';
import { isDependencyLag, isDependencyType, MAX_DEPENDENCY_LAG_DAYS } from '../shared/schedule-dependencies.js';
import { SCHEDULE_PASTE_COLUMNS } from '../shared/schedule-paste-format.js';
import type { Dependency, DependencyType } from '../shared/types.js';
import { blankRecord, readDelimited, type DelimitedRecord, type DelimitedText } from '../shared/delimited-paste.js';
import { hasScheduleDependencyCycle } from './schedule-dependency-changes.js';

export const ISSUE_PASTE_MAX_ROWS = 100;
export const ISSUE_PASTE_MAX_BYTES = 128 * 1024;
export const ISSUE_PASTE_MAX_LINKS = 1_000;

export interface IssuePasteInputDependency {
  predecessor: { kind: 'new'; localKey: string } | { kind: 'existing'; key: string };
  type: DependencyType;
  lagDays: number;
}

export interface IssuePasteInputRow {
  line: number;
  title: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  startDate?: string;
  endDate?: string;
  dueDate?: string;
  labels?: string[];
  localKey?: string;
  dependencies?: IssuePasteInputDependency[];
}

interface Diagnostic {
  line: number | null;
  message: string;
}

interface Candidate {
  width: number;
  columns: Map<Column, number>;
  records: DelimitedRecord[];
  headerError?: Diagnostic;
  syntaxError?: Diagnostic;
}

const columnLabels = {
  title: '제목',
  description: '설명',
  type: '유형',
  status: '상태',
  priority: '우선순위',
  assignee: '담당자',
  startDate: '시작일',
  endDate: '종료일',
  dueDate: '목표 마감일',
  labels: '라벨',
  key: '업무 키',
  localKey: '임시 키',
  predecessor: SCHEDULE_PASTE_COLUMNS.predecessor,
  dependencyType: SCHEDULE_PASTE_COLUMNS.dependencyType,
  lag: SCHEDULE_PASTE_COLUMNS.lag,
};
type Column = keyof typeof columnLabels;

const normalizeHeader = (label: string) => label.toLowerCase().replace(/[\s_-]+/g, '');
const aliases = new Map<string, Column>([
  ['제목', 'title'], ['title', 'title'], ['issuetitle', 'title'], ['summary', 'title'],
  ['설명', 'description'], ['description', 'description'], ['desc', 'description'],
  ['유형', 'type'], ['type', 'type'], ['issuetype', 'type'],
  ['상태', 'status'], ['status', 'status'], ['state', 'status'],
  ['우선순위', 'priority'], ['priority', 'priority'],
  ['담당자', 'assignee'], ['assignee', 'assignee'], ['assignedto', 'assignee'],
  ['시작일', 'startDate'], ['start', 'startDate'], ['startdate', 'startDate'],
  ['종료일', 'endDate'], ['end', 'endDate'], ['enddate', 'endDate'],
  ['목표마감일', 'dueDate'], ['마감일', 'dueDate'], ['due', 'dueDate'], ['duedate', 'dueDate'],
  ['targetduedate', 'dueDate'], ['deadline', 'dueDate'],
  ['라벨', 'labels'], ['태그', 'labels'], ['label', 'labels'], ['labels', 'labels'], ['tags', 'labels'],
  ['업무키', 'key'], ['티켓', 'key'], ['key', 'key'], ['issuekey', 'key'],
  ['임시키', 'localKey'], ['localkey', 'localKey'], ['temporarykey', 'localKey'], ['tempkey', 'localKey'], ['batchkey', 'localKey'],
  ['선행업무', 'predecessor'], ['predecessor', 'predecessor'], ['predecessors', 'predecessor'],
  ['predecessorkey', 'predecessor'], ['predecessorkeys', 'predecessor'],
  ['연결유형', 'dependencyType'], ['dependencytype', 'dependencyType'], ['dependencytypes', 'dependencyType'],
  ['근무일간격', 'lag'], ['lag', 'lag'], ['lagdays', 'lag'],
]);
const exportOnlyHeaders = new Set(['프로젝트', 'project', '사이클', 'cycle', '모듈', 'module', '릴리스', 'release']);
const textColumns = ['description', 'type', 'status', 'priority', 'assignee'] as const;
const dateColumns = ['startDate', 'endDate', 'dueDate'] as const;
const requiredTitle = '제목 헤더(제목, title, summary)가 필요합니다.';
const existingKey = '업무 키가 있는 행은 신규 업무로 붙여넣을 수 없습니다. 기존 업무 일정은 간트에서 변경해 주세요.';
const localKeyPattern = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u;

export function normalizeIssuePasteKey(value: string): string {
  return value.normalize('NFC').toUpperCase().normalize('NFC');
}

function inspectHeader(parsed: DelimitedText): Candidate {
  const headerIndex = parsed.records.findIndex(record => !blankRecord(record));
  const header = parsed.records[headerIndex];
  const columns = new Map<Column, number>();
  if (!header) {
    return { width: 0, columns, records: [], headerError: parsed.error ?? { line: null, message: requiredTitle } };
  }

  let error: Diagnostic | undefined;
  for (const [index, rawLabel] of header.cells.entries()) {
    const label = rawLabel.trim();
    const normalized = normalizeHeader(label);
    const column = aliases.get(normalized);
    if (!label) {
      error ??= { line: header.line, message: `${index + 1}번째 열의 헤더가 비어 있습니다.` };
    } else if (!column) {
      const displayLabel = label.length > 80 ? `${label.slice(0, 80)}…` : label;
      error ??= {
        line: header.line,
        message: exportOnlyHeaders.has(normalized)
          ? `'${displayLabel}' 열은 업무 붙여넣기에서 지원하지 않습니다. 내보낸 목록에서 이 열을 제거해 주세요.`
          : `${index + 1}번째 열의 '${displayLabel}' 헤더를 인식할 수 없습니다.`,
      };
    } else if (columns.has(column)) {
      error ??= { line: header.line, message: `${columnLabels[column]} 헤더가 중복되었습니다.` };
    } else {
      columns.set(column, index);
    }
  }
  if (!columns.has('title')) {
    error = { line: header.line, message: error ? `${error.message} ${requiredTitle}` : requiredTitle };
  }
  return {
    width: header.cells.length,
    columns,
    records: parsed.records.slice(headerIndex + 1).filter(row => !blankRecord(row)),
    headerError: error,
    syntaxError: parsed.error,
  };
}

function selectCandidate(candidates: Candidate[]): Candidate {
  const valid = candidates.filter(candidate => !candidate.headerError);
  if (valid.length === 1) return valid[0];
  if (valid.length === 2) {
    // A title-only header has no separator. Let the row widths and quoting select the format.
    const complete = valid.find(candidate => !candidate.syntaxError &&
      candidate.records.every(row => row.cells.length === candidate.width));
    return complete ?? valid.find(candidate => !candidate.syntaxError) ?? valid[0];
  }
  return candidates.sort((a, b) => b.columns.size - a.columns.size || b.width - a.width)[0];
}

const splitValues = (cell: string) => cell.split(',').map(value => value.trim());

function readDependencies(keys: string[], typeCell: string, lagCell: string, report: (message: string) => void): IssuePasteInputDependency[] {
  if (!keys.length) {
    if (typeCell.trim() || lagCell.trim()) report('연결 유형이나 근무일 간격을 입력하려면 선행 업무를 지정해 주세요.');
    return [];
  }
  const types = splitValues(typeCell);
  const lags = splitValues(lagCell);
  const validTypes = types.length === 1 || types.length === keys.length;
  const validLags = lags.length === 1 || lags.length === keys.length;
  if (!validTypes) report('연결 유형은 하나 또는 선행 업무 개수만큼 입력해 주세요.');
  if (!validLags) report('근무일 간격은 하나 또는 선행 업무 개수만큼 입력해 주세요.');
  if (!validTypes || !validLags) return [];

  const dependencies: IssuePasteInputDependency[] = [];
  const seen = new Set<string>();
  for (const [index, value] of keys.entries()) {
    const label = `선행 업무 ${index + 1}번째`;
    const key = value.normalize('NFC');
    if (!key || normalizeIssuePasteKey(key).length > 200 || !key.isWellFormed() || /\p{Cc}/u.test(key)) {
      report(`${label} 값은 제어 문자가 없는 1~200자여야 합니다.`);
      continue;
    }
    const predecessor: IssuePasteInputDependency['predecessor'] = /^new:/i.test(key)
      ? { kind: 'new', localKey: key.slice(4) } : { kind: 'existing', key };
    if (predecessor.kind === 'new' && !localKeyPattern.test(predecessor.localKey)) {
      report(`${label} 값의 new: 뒤에는 유효한 임시 키를 입력해 주세요.`);
      continue;
    }
    const normalized = normalizeIssuePasteKey(key);
    if (seen.has(normalized)) {
      report(`선행 업무 연결이 중복되었습니다. ${key}를 한 번만 입력해 주세요.`);
      continue;
    }
    seen.add(normalized);
    const type = (types[types.length === 1 ? 0 : index] || 'FS').toUpperCase();
    if (!isDependencyType(type)) {
      report(`${label} 연결 유형은 FS, SS, FF, SF 중 하나여야 합니다.`);
      continue;
    }
    const lag = lags[lags.length === 1 ? 0 : index] || '0';
    const lagDays = Number(lag);
    if (!/^[+-]?\d+$/.test(lag) || !isDependencyLag(lagDays)) {
      report(`${label} 근무일 간격은 -${MAX_DEPENDENCY_LAG_DAYS}~${MAX_DEPENDENCY_LAG_DAYS} 사이의 정수여야 합니다.`);
      continue;
    }
    dependencies.push({ predecessor, type, lagDays: lagDays || 0 });
  }
  return dependencies;
}

function validateLocalDependencies(rows: IssuePasteInputRow[], declared: ReadonlyMap<string, number>, errors: Diagnostic[]) {
  const edges: (Dependency & { line: number })[] = [];
  for (const row of rows) {
    if (!row.dependencies) continue;
    const successorId = row.localKey && normalizeIssuePasteKey(row.localKey);
    const retained = row.dependencies.filter(dependency => {
      if (dependency.predecessor.kind !== 'new') return true;
      const { localKey } = dependency.predecessor;
      const predecessorId = normalizeIssuePasteKey(localKey);
      if (!declared.has(predecessorId)) {
        errors.push({ line: row.line, message: `임시 키 ${localKey}에 해당하는 신규 업무를 찾을 수 없습니다.` });
        return false;
      }
      if (predecessorId === successorId) {
        errors.push({ line: row.line, message: '자기 자신을 선행 업무로 연결할 수 없습니다.' });
      } else if (successorId) {
        edges.push({ id: String(edges.length), predecessorId, successorId, type: dependency.type, lagDays: dependency.lagDays, line: row.line });
      }
      return true;
    });
    if (retained.length) row.dependencies = retained;
    else delete row.dependencies;
  }
  if (!hasScheduleDependencyCycle(edges)) return;
  // Locate the edge that closes the first cycle in physical input order.
  let first = 0;
  let last = edges.length - 1;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (hasScheduleDependencyCycle(edges.slice(0, middle + 1))) last = middle;
    else first = middle + 1;
  }
  errors.push({ line: edges[first].line, message: '신규 업무의 선행 연결에 순환 관계가 있습니다.' });
}

export function parseIssuePaste(text: unknown): { rows: IssuePasteInputRow[]; errors: Diagnostic[] } {
  if (typeof text !== 'string') {
    return { rows: [], errors: [{ line: null, message: '붙여넣을 업무 목록은 문자열이어야 합니다.' }] };
  }
  if (Buffer.byteLength(text, 'utf8') > ISSUE_PASTE_MAX_BYTES) {
    return { rows: [], errors: [{ line: null, message: '붙여넣을 업무 목록은 UTF-8 기준 128 KiB 이하여야 합니다.' }] };
  }
  const nul = text.indexOf('\0');
  if (nul >= 0) {
    const line = text.slice(0, nul).split(/\r\n|\r|\n/).length;
    return { rows: [], errors: [{ line, message: '붙여넣을 업무 목록에 널 문자를 사용할 수 없습니다.' }] };
  }

  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const { width, columns, records, headerError, syntaxError } = selectCandidate([
    inspectHeader(readDelimited(source, '\t')), inspectHeader(readDelimited(source, ',')),
  ]);
  const keyIndex = columns.get('key');
  if (headerError) {
    const keyed = keyIndex === undefined ? undefined : records.find(row => row.cells[keyIndex]?.trim());
    return { rows: [], errors: keyed ? [headerError, { line: keyed.line, message: existingKey }] : [headerError] };
  }
  if (syntaxError) return { rows: [], errors: [syntaxError] };
  if (!records.length) {
    return { rows: [], errors: [{ line: null, message: '붙여넣을 업무 행이 없습니다.' }] };
  }
  if (records.length > ISSUE_PASTE_MAX_ROWS) {
    return { rows: [], errors: [{ line: records[ISSUE_PASTE_MAX_ROWS].line, message: '업무는 한 번에 100행까지 붙여넣을 수 있습니다.' }] };
  }

  const rows: IssuePasteInputRow[] = [];
  const errors: Diagnostic[] = [];
  const declared = new Map<string, number>();
  let linkCount = 0;
  for (const record of records) {
    const { line, cells } = record;
    if (cells.length !== width) {
      errors.push({ line, message: `열 수가 헤더(${width}개)와 다릅니다. 빈 셀도 구분자를 유지해 주세요.` });
      continue;
    }
    if (keyIndex !== undefined && cells[keyIndex].trim()) {
      errors.push({ line, message: existingKey });
      continue;
    }

    const cell = (column: Column) => cells[columns.get(column) ?? -1] ?? '';
    const title = cell('title').trim();
    if (!title) {
      errors.push({ line, message: '제목을 입력해 주세요.' });
      continue;
    }

    const row: IssuePasteInputRow = { line, title };
    for (const column of textColumns) {
      const value = cell(column);
      const trimmed = value.trim();
      if (trimmed) row[column] = column === 'description' ? value : trimmed;
    }
    const labels = cell('labels').split(',').map(label => label.trim()).filter(Boolean);
    if (labels.length) row.labels = labels;

    const previousErrors = errors.length;
    const report = (message: string) => errors.push({ line, message });
    const localKey = cell('localKey').trim().normalize('NFC');
    if (localKey) {
      if (!localKeyPattern.test(localKey)) {
        report('임시 키는 문자나 숫자로 시작하며, 문자·숫자·밑줄·하이픈으로 1~48자를 사용해 주세요.');
      } else {
        const alias = normalizeIssuePasteKey(localKey);
        const firstLine = declared.get(alias);
        if (firstLine !== undefined) report(`임시 키 ${localKey}가 ${firstLine}번째 줄과 중복되었습니다.`);
        else {
          declared.set(alias, line);
          row.localKey = localKey;
        }
      }
    }
    for (const column of dateColumns) {
      const value = cell(column).trim();
      if (!value) continue;
      if (isCalendarDate(value)) row[column] = value;
      else report(`${columnLabels[column]}은 유효한 YYYY-MM-DD 날짜여야 합니다.`);
    }
    const predecessor = cell('predecessor');
    const keys = predecessor.trim() ? splitValues(predecessor) : [];
    linkCount += keys.length;
    if (linkCount > ISSUE_PASTE_MAX_LINKS) return { rows: [], errors: [{ line, message: '선행 연결은 한 번에 1,000개까지 붙여넣을 수 있습니다.' }] };
    const dependencies = readDependencies(keys, cell('dependencyType'), cell('lag'), report);
    if (dependencies.length) row.dependencies = dependencies;
    if (errors.length === previousErrors) rows.push(row);
  }
  validateLocalDependencies(rows, declared, errors);
  errors.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
  return { rows, errors };
}
