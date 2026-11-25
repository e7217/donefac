import { blankRecord, readDelimited } from './delimited-paste.js';
import { MAX_DOCUMENT_NODES } from './document-nodes.js';
import type { RichContent } from './types.js';

export const DOCUMENT_TABLE_PASTE_LIMITS = { rows: 100, columns: 30, characters: 65_536 };

type DocumentTablePasteResult =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; columns: number; rows: string[][] };

export function parseDocumentTablePaste(value: string): DocumentTablePasteResult {
  const { rows: maxRows, columns: maxColumns, characters } = DOCUMENT_TABLE_PASTE_LIMITS;
  if (value.length > characters) return { kind: 'error', message: `표 데이터는 ${characters.toLocaleString('ko-KR')}자까지 붙여넣을 수 있습니다.` };
  if (/\p{Cc}/u.test(value.replace(/[\t\r\n]/gu, ''))) return { kind: 'error', message: '셀에 표시할 수 없는 문자가 있습니다.' };

  const { records, error } = readDelimited(value.replace(/^\uFEFF/u, ''), '\t');
  if (error) return { kind: 'error', message: `${error.line}행 · ${error.message}` };
  if (records.every(blankRecord)) return { kind: 'empty' };
  const columns = records.reduce((width, record) => Math.max(width, record.cells.length), 0);
  if (records.length > maxRows || columns > maxColumns) {
    return { kind: 'error', message: `표 데이터는 ${maxRows}행, ${maxColumns}열까지 붙여넣을 수 있습니다.` };
  }
  const rows = records.map(({ cells }) => Array.from({ length: columns }, (_, index) => (cells[index] ?? '').replace(/\r\n?/g, '\n')));
  let nodes = 2 + rows.length; // Document, table and row nodes.
  for (const cell of rows.flat()) {
    const lines = cell.split('\n');
    nodes += 2 + lines.length - 1 + lines.filter(Boolean).length; // Cell, paragraph, breaks and text runs.
    if (nodes > MAX_DOCUMENT_NODES) return { kind: 'error', message: '표의 문서 블록 수가 한도를 넘습니다. 긴 셀의 줄 수를 줄여 주세요.' };
  }
  return { kind: 'ready', columns, rows };
}

function cellContent(value: string): RichContent[] {
  const lines = value.split('\n');
  return lines.flatMap((line, index): RichContent[] => [
    ...(index !== 0 ? [{ type: 'hardBreak' }] : []),
    ...(line ? [{ type: 'text', text: line }] : []),
  ]);
}

export function documentTableFromPaste(rows: readonly (readonly string[])[], header: boolean): RichContent {
  return { type: 'table', content: rows.map((row, index) => ({
    type: 'tableRow', content: row.map(value => ({
      type: header && index === 0 ? 'tableHeader' : 'tableCell',
      content: [{ type: 'paragraph', content: cellContent(value) }],
    })),
  })) };
}
