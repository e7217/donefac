export interface DelimitedRecord {
  line: number;
  cells: string[];
}

export interface DelimitedText {
  records: DelimitedRecord[];
  error?: { line: number; message: string };
}

export const blankRecord = (record: DelimitedRecord) => record.cells.every(cell => !cell.trim());

/** Strict quoting preserves cell boundaries and physical source lines. */
export function readDelimited(text: string, delimiter: '\t' | ','): DelimitedText {
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
