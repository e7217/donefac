import { isCalendarDate } from '../shared/calendar.js';
import { blankRecord, readDelimited, type DelimitedRecord, type DelimitedText } from './delimited-paste.js';

export const ISSUE_PASTE_MAX_ROWS = 100;
export const ISSUE_PASTE_MAX_BYTES = 128 * 1024;

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
]);
const exportOnlyHeaders = new Set(['프로젝트', 'project', '사이클', 'cycle', '모듈', 'module', '릴리스', 'release']);
const textColumns = ['description', 'type', 'status', 'priority', 'assignee'] as const;
const dateColumns = ['startDate', 'endDate', 'dueDate'] as const;
const requiredTitle = '제목 헤더(제목, title, summary)가 필요합니다.';
const existingKey = '업무 키가 있는 행은 신규 업무로 붙여넣을 수 없습니다. 기존 업무 일정은 간트에서 변경해 주세요.';

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
    for (const column of dateColumns) {
      const value = cell(column).trim();
      if (!value) continue;
      if (isCalendarDate(value)) row[column] = value;
      else errors.push({ line, message: `${columnLabels[column]}은 유효한 YYYY-MM-DD 날짜여야 합니다.` });
    }
    if (errors.length === previousErrors) rows.push(row);
  }
  return { rows, errors };
}
