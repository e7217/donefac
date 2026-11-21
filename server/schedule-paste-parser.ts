import { isCalendarDate } from '../shared/calendar.js';
import { isDependencyLag, isDependencyType, MAX_DEPENDENCY_LAG_DAYS } from '../shared/schedule-dependencies.js';
import { SCHEDULE_PASTE_COLUMNS as columnLabels, SCHEDULE_PASTE_MAX_BYTES, SCHEDULE_PASTE_MAX_ROWS } from '../shared/schedule-paste-format.js';
import type { DependencyType, SchedulePasteDiagnostic } from '../shared/types.js';
import { blankRecord, readDelimited, type DelimitedRecord, type DelimitedText } from './delimited-paste.js';

export { SCHEDULE_PASTE_MAX_BYTES, SCHEDULE_PASTE_MAX_ROWS } from '../shared/schedule-paste-format.js';

export interface SchedulePasteRow {
  line: number;
  key: string;
  startDate: string | null | undefined;
  endDate: string | null | undefined;
  dueDate?: string | null;
  dependency?: { predecessorKey: string; type?: DependencyType | '-'; lagDays?: number };
}

interface Header {
  recordIndex: number;
  record: DelimitedRecord;
  keyIndex: number;
  startIndex: number | undefined;
  endIndex: number | undefined;
  dueIndex: number | undefined;
  predecessorIndex: number | undefined;
  typeIndex: number | undefined;
  lagIndex: number | undefined;
}

interface Candidate {
  parsed: DelimitedText;
  header?: Header;
  errors: SchedulePasteDiagnostic[];
  recognized: number;
}

interface SeenIssueRows {
  predecessorLines: Map<string, number>;
  dates: Partial<Record<'startDate' | 'endDate' | 'dueDate', { value: string | null; line: number }>>;
}

type Column = keyof typeof columnLabels;
const normalizeColumn = (label: string) => label.toLowerCase().replace(/\s+/g, '');

const columnAliases = new Map<string, Column>([
  ...(Object.keys(columnLabels) as Column[]).map(column => [normalizeColumn(columnLabels[column]), column] as const),
  ['티켓', 'key'], ['issuekey', 'key'], ['key', 'key'],
  ['startdate', 'start'], ['enddate', 'end'], ['duedate', 'due'],
  ['predecessor', 'predecessor'], ['predecessorkey', 'predecessor'],
  ['dependencytype', 'dependencyType'], ['lagdays', 'lag'],
]);

const requiredHeader = '업무 키와 시작일·종료일·목표 마감일·선행 업무 중 하나 이상의 헤더가 필요합니다.';

function inspectHeader(parsed: DelimitedText): Candidate {
  const recordIndex = parsed.records.findIndex(record => !blankRecord(record));
  const errors: SchedulePasteDiagnostic[] = [];
  const candidate: Candidate = { parsed, errors, recognized: 0 };
  if (recordIndex < 0) {
    errors.push(parsed.error ?? { line: null, message: requiredHeader });
    return candidate;
  }

  const record = parsed.records[recordIndex];
  const columns = new Map<Column, number>();
  for (let index = 0; index < record.cells.length; index++) {
    const label = record.cells[index].trim();
    if (!label) {
      errors.push({ line: record.line, message: `${index + 1}번째 열의 헤더가 비어 있습니다. 사용하지 않는 열에도 헤더를 지정해 주세요.` });
      continue;
    }
    const column = columnAliases.get(normalizeColumn(label));
    // Only explicitly headed unrelated columns may be ignored.
    if (!column) continue;
    candidate.recognized++;
    if (columns.has(column)) {
      errors.push({ line: record.line, message: `${columnLabels[column]} 헤더가 중복되었습니다. 같은 의미의 열은 하나만 사용해 주세요.` });
    } else {
      columns.set(column, index);
    }
  }
  if (!columns.has('key')) errors.push({ line: record.line, message: '업무 키 헤더(업무 키, 티켓, issue key, key)가 필요합니다.' });
  if (!columns.has('start') && !columns.has('end') && !columns.has('due') && !columns.has('predecessor')) {
    errors.push({ line: record.line, message: requiredHeader });
  }
  if (!errors.length) {
    candidate.header = {
      recordIndex, record, keyIndex: columns.get('key')!,
      startIndex: columns.get('start'), endIndex: columns.get('end'), dueIndex: columns.get('due'),
      predecessorIndex: columns.get('predecessor'), typeIndex: columns.get('dependencyType'), lagIndex: columns.get('lag'),
    };
  }
  return candidate;
}

const normalizedKey = (cell: string | undefined) => cell?.trim().toUpperCase() ?? '';
const validKey = (key: string) => Boolean(key && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key));

function readDependency(row: DelimitedRecord, header: Header, predecessorKey: string): SchedulePasteRow['dependency'] | string {
  const cell = (index: number | undefined) => index === undefined ? undefined : row.cells[index];
  const type = cell(header.typeIndex)?.trim().toUpperCase() ?? '';
  const lag = cell(header.lagIndex)?.trim() ?? '';
  if (!predecessorKey) {
    return type || lag ? '연결 유형이나 근무일 간격을 입력하려면 선행 업무 키를 지정해 주세요.' : undefined;
  }
  if (!validKey(predecessorKey)) return '선행 업무 키는 제어 문자가 없는 1~200자여야 합니다.';
  if (type !== '' && type !== '-' && !isDependencyType(type)) {
    return '연결 유형은 FS, SS, FF, SF 또는 -(연결 해제)만 사용할 수 있습니다.';
  }
  if (type === '-' && lag) return '연결을 해제할 때는 근무일 간격을 비워 주세요.';

  const lagDays = lag ? Number(lag) : undefined;
  if (lag && (!/^[+-]?\d+$/.test(lag) || !isDependencyLag(lagDays))) {
    return `근무일 간격은 -${MAX_DEPENDENCY_LAG_DAYS}~${MAX_DEPENDENCY_LAG_DAYS} 사이의 정수여야 합니다.`;
  }
  return {
    predecessorKey,
    ...(type ? { type } : {}),
    ...(lagDays !== undefined ? { lagDays: lagDays || 0 } : {}),
  };
}

/** No mutation is safe while errors exist, even when some rows parsed successfully. */
export function parseSchedulePaste(text: unknown): { rows: SchedulePasteRow[]; errors: SchedulePasteDiagnostic[] } {
  if (typeof text !== 'string') {
    return { rows: [], errors: [{ line: null, message: '붙여넣을 일정은 문자열이어야 합니다.' }] };
  }
  if (Buffer.byteLength(text, 'utf8') > SCHEDULE_PASTE_MAX_BYTES) {
    return { rows: [], errors: [{ line: null, message: '붙여넣을 일정은 UTF-8 기준 128 KiB 이하여야 합니다.' }] };
  }

  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const candidates = [inspectHeader(readDelimited(source, '\t')), inspectHeader(readDelimited(source, ','))];
  const valid = candidates.filter(candidate => candidate.header);
  if (valid.length > 1) {
    return { rows: [], errors: [{ line: valid[0].header!.record.line, message: '탭과 쉼표 헤더가 모두 해석되어 구분자가 모호합니다. TSV 또는 CSV 한 형식으로 붙여넣어 주세요.' }] };
  }
  if (!valid.length) {
    const best = [...candidates].sort((a, b) => b.recognized - a.recognized)[0];
    return { rows: [], errors: best.errors };
  }

  const { parsed, header } = valid[0];
  if (parsed.error) return { rows: [], errors: [parsed.error] };
  const { recordIndex, record, keyIndex, startIndex, endIndex, dueIndex, predecessorIndex } = header!;
  const dataRecords = parsed.records.slice(recordIndex + 1).filter(row => !blankRecord(row));
  if (dataRecords.length > SCHEDULE_PASTE_MAX_ROWS) {
    return { rows: [], errors: [{ line: dataRecords[SCHEDULE_PASTE_MAX_ROWS].line, message: '일정은 한 번에 500행까지 붙여넣을 수 있습니다.' }] };
  }

  const rows: SchedulePasteRow[] = [];
  const errors: SchedulePasteDiagnostic[] = [];
  const seenKeys = new Map<string, SeenIssueRows>();
  const dateColumns = [
    [startIndex, 'startDate', columnLabels.start], [endIndex, 'endDate', columnLabels.end], [dueIndex, 'dueDate', columnLabels.due],
  ] as const;
  for (const row of dataRecords) {
    if (row.cells.length !== record.cells.length) {
      errors.push({ line: row.line, message: `열 수가 헤더(${record.cells.length}개)와 다릅니다. 빈 날짜 셀도 구분자를 유지해 주세요.` });
      continue;
    }
    const key = normalizedKey(row.cells[keyIndex]);
    if (!validKey(key)) {
      errors.push({ line: row.line, message: '업무 키는 제어 문자가 없는 1~200자여야 합니다.' });
      continue;
    }
    let seen = seenKeys.get(key);
    if (!seen) {
      seen = { predecessorLines: new Map(), dates: {} };
      seenKeys.set(key, seen);
    }
    const predecessorKey = normalizedKey(predecessorIndex === undefined ? undefined : row.cells[predecessorIndex]);
    const firstLine = seen.predecessorLines.get(predecessorKey);
    if (firstLine !== undefined) {
      const message = predecessorKey
        ? `선행 업무 연결이 중복되었습니다. ${firstLine}번째 줄에도 ${predecessorKey} → ${key}가 있습니다.`
        : `업무 키가 중복되었습니다. ${firstLine}번째 줄에도 선행 업무 없이 ${key}가 있습니다.`;
      errors.push({ line: row.line, key, message });
      continue;
    }
    seen.predecessorLines.set(predecessorKey, row.line);

    const parsedRow: SchedulePasteRow = { line: row.line, key, startDate: undefined, endDate: undefined };
    let validDates = true;
    for (const [index, field, label] of dateColumns) {
      if (index === undefined) continue;
      const value = row.cells[index].trim();
      if (!value) continue;
      if (value !== '-' && !isCalendarDate(value)) {
        errors.push({ line: row.line, key, message: `${label}은 유효한 YYYY-MM-DD 날짜, 빈칸(유지), -(삭제)만 사용할 수 있습니다.` });
        validDates = false;
        continue;
      }
      const date = value === '-' ? null : value;
      const previous = seen.dates[field];
      if (previous && previous.value !== date) {
        errors.push({ line: row.line, key, message: `${label} 값이 ${previous.line}번째 줄의 값과 충돌합니다.` });
        validDates = false;
        continue;
      }
      seen.dates[field] ??= { value: date, line: row.line };
      parsedRow[field] = date;
    }
    const dependency = readDependency(row, header!, predecessorKey);
    if (typeof dependency === 'string') errors.push({ line: row.line, key, message: dependency });
    if (validDates && typeof dependency !== 'string') {
      if (dependency) parsedRow.dependency = dependency;
      rows.push(parsedRow);
    }
  }
  return { rows, errors };
}
