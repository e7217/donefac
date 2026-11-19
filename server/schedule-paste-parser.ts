import { isCalendarDate } from '../shared/calendar.js';
import type { SchedulePasteDiagnostic } from '../shared/types.js';

export const SCHEDULE_PASTE_MAX_ROWS = 500;
export const SCHEDULE_PASTE_MAX_BYTES = 128 * 1024;

export interface SchedulePasteRow {
  line: number;
  key: string;
  startDate: string | null | undefined;
  endDate: string | null | undefined;
}

interface DelimitedRecord {
  line: number;
  cells: string[];
}

interface DelimitedText {
  records: DelimitedRecord[];
  error?: SchedulePasteDiagnostic;
}

interface Header {
  recordIndex: number;
  record: DelimitedRecord;
  keyIndex: number;
  startIndex: number | undefined;
  endIndex: number | undefined;
}

interface Candidate {
  parsed: DelimitedText;
  header?: Header;
  errors: SchedulePasteDiagnostic[];
  recognized: number;
}

type Column = 'key' | 'start' | 'end';

const columnAliases = new Map<string, Column>([
  ['업무키', 'key'], ['티켓', 'key'], ['issuekey', 'key'], ['key', 'key'],
  ['시작일', 'start'], ['startdate', 'start'],
  ['종료일', 'end'], ['enddate', 'end'],
]);

const blankRecord = (record: DelimitedRecord) => record.cells.every(cell => !cell.trim());

/** Strict quoting avoids shifting an issue's dates into another physical row. */
function readDelimited(text: string, delimiter: '\t' | ','): DelimitedText {
  const records: DelimitedRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let mode: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  let endedWithNewline = false;

  const finishCell = () => {
    cells.push(cell);
    cell = '';
    mode = 'start';
  };
  const finishRecord = () => {
    finishCell();
    records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const newline = character === '\r' || character === '\n';
    const newlineText = character === '\r' && text[index + 1] === '\n' ? '\r\n' : character;
    endedWithNewline = false;

    if (mode === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          mode = 'closed';
        }
      } else {
        cell += newline ? newlineText : character;
        if (newline) {
          line++;
          if (newlineText.length === 2) index++;
        }
      }
      continue;
    }

    if (character === delimiter) {
      finishCell();
    } else if (newline) {
      finishRecord();
      line++;
      recordLine = line;
      if (newlineText.length === 2) index++;
      endedWithNewline = true;
    } else if (character === '"' && mode === 'start') {
      mode = 'quoted';
      quoteLine = line;
    } else if (character === '"' || mode === 'closed') {
      return {
        records,
        error: { line, message: '따옴표 형식이 올바르지 않습니다. 셀 전체를 큰따옴표로 감싸고 내부 큰따옴표는 두 번 써 주세요.' },
      };
    } else {
      cell += character;
      mode = 'plain';
    }
  }

  if (mode === 'quoted') {
    return { records, error: { line: quoteLine, message: '닫히지 않은 큰따옴표가 있습니다.' } };
  }
  if (!endedWithNewline) finishRecord();
  return { records };
}

function inspectHeader(parsed: DelimitedText): Candidate {
  const recordIndex = parsed.records.findIndex(record => !blankRecord(record));
  const errors: SchedulePasteDiagnostic[] = [];
  const candidate: Candidate = { parsed, errors, recognized: 0 };
  if (recordIndex < 0) {
    errors.push(parsed.error ?? { line: null, message: '업무 키와 시작일 또는 종료일 헤더가 필요합니다.' });
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
    const column = columnAliases.get(label.toLowerCase().replace(/\s+/g, ''));
    // Only explicitly headed unrelated columns may be ignored.
    if (!column) continue;
    candidate.recognized++;
    if (columns.has(column)) {
      const name = column === 'key' ? '업무 키' : column === 'start' ? '시작일' : '종료일';
      errors.push({ line: record.line, message: `${name} 헤더가 중복되었습니다. 같은 의미의 열은 하나만 사용해 주세요.` });
    } else {
      columns.set(column, index);
    }
  }
  if (!columns.has('key')) errors.push({ line: record.line, message: '업무 키 헤더(업무 키, 티켓, issue key, key)가 필요합니다.' });
  if (!columns.has('start') && !columns.has('end')) {
    errors.push({ line: record.line, message: '시작일 또는 종료일 헤더가 하나 이상 필요합니다.' });
  }
  if (!errors.length) {
    candidate.header = {
      recordIndex, record, keyIndex: columns.get('key')!,
      startIndex: columns.get('start'), endIndex: columns.get('end'),
    };
  }
  return candidate;
}

function readDate(cell: string | undefined): string | null | undefined {
  if (cell === undefined || !cell.trim()) return undefined;
  const value = cell.trim();
  if (value === '-') return null;
  return isCalendarDate(value) ? value : undefined;
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
  const { recordIndex, record, keyIndex, startIndex, endIndex } = header!;
  const dataRecords = parsed.records.slice(recordIndex + 1).filter(row => !blankRecord(row));
  if (dataRecords.length > SCHEDULE_PASTE_MAX_ROWS) {
    return { rows: [], errors: [{ line: dataRecords[SCHEDULE_PASTE_MAX_ROWS].line, message: '일정은 한 번에 500행까지 붙여넣을 수 있습니다.' }] };
  }

  const rows: SchedulePasteRow[] = [];
  const errors: SchedulePasteDiagnostic[] = [];
  const seenKeys = new Map<string, number>();
  for (const row of dataRecords) {
    if (row.cells.length !== record.cells.length) {
      errors.push({ line: row.line, message: `열 수가 헤더(${record.cells.length}개)와 다릅니다. 빈 날짜 셀도 구분자를 유지해 주세요.` });
      continue;
    }
    const key = row.cells[keyIndex].trim().toUpperCase();
    if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
      errors.push({ line: row.line, message: '업무 키는 제어 문자가 없는 1~200자여야 합니다.' });
      continue;
    }
    const firstLine = seenKeys.get(key);
    if (firstLine !== undefined) {
      errors.push({ line: row.line, key, message: `업무 키가 중복되었습니다. ${firstLine}번째 줄에도 ${key}가 있습니다.` });
      continue;
    }
    seenKeys.set(key, row.line);

    let validDates = true;
    for (const [index, label] of [[startIndex, '시작일'], [endIndex, '종료일']] as const) {
      if (index === undefined) continue;
      const value = row.cells[index].trim();
      if (value && value !== '-' && !isCalendarDate(value)) {
        errors.push({ line: row.line, key, message: `${label}은 유효한 YYYY-MM-DD 날짜, 빈칸(유지), -(삭제)만 사용할 수 있습니다.` });
        validDates = false;
      }
    }
    if (validDates) {
      rows.push({
        line: row.line, key,
        startDate: readDate(startIndex === undefined ? undefined : row.cells[startIndex]),
        endDate: readDate(endIndex === undefined ? undefined : row.cells[endIndex]),
      });
    }
  }
  return { rows, errors };
}
