import { equal, deepEqual, match } from 'node:assert/strict';
import test from 'node:test';
import { MAX_DOCUMENT_NODES } from '../../shared/document-nodes.js';
import { DOCUMENT_TABLE_PASTE_LIMITS, documentTableFromPaste, parseDocumentTablePaste } from '../../shared/document-table-paste.js';

test('pasted spreadsheet cells keep quoted values, newlines and exact empty positions', () => {
  const parsed = parseDocumentTablePaste('\uFEFF이름\t비고\t상태\r\nA\t"두 줄\r\n탭\t""인용"""\t\r\n\t\t\r\nB\t값\r\n');
  deepEqual(parsed, { kind: 'ready', columns: 3, rows: [['이름', '비고', '상태'], ['A', '두 줄\n탭\t"인용"', ''], ['', '', ''], ['B', '값', '']] });
  if (parsed.kind !== 'ready') throw new Error('expected valid spreadsheet data');
  const withHeader = documentTableFromPaste(parsed.rows, true);
  deepEqual(withHeader.content?.[0].content?.map(node => node.type), ['tableHeader', 'tableHeader', 'tableHeader']);
  deepEqual(withHeader.content?.[1].content?.[1].content?.[0].content, [
    { type: 'text', text: '두 줄' }, { type: 'hardBreak' }, { type: 'text', text: '탭\t"인용"' },
  ]);
  deepEqual(withHeader.content?.[1].content?.[2].content, [{ type: 'paragraph', content: [] }]);
  const withoutHeader = documentTableFromPaste(parsed.rows, false);
  equal(withoutHeader.content?.[0].content?.[0].type, 'tableCell');
});

test('table paste rejects invalid controls, malformed quotes and over-limit data without a partial table', () => {
  equal(parseDocumentTablePaste('\t\n\t').kind, 'empty');
  for (const value of ['x\0\ty', 'x\u0085\ty', Array(DOCUMENT_TABLE_PASTE_LIMITS.rows + 1).fill('x').join('\n'),
    Array(DOCUMENT_TABLE_PASTE_LIMITS.columns + 1).fill('x').join('\t'), 'x'.repeat(DOCUMENT_TABLE_PASTE_LIMITS.characters + 1)]) {
    equal(parseDocumentTablePaste(value).kind, 'error');
  }
  const malformed = parseDocumentTablePaste('첫 행\t열\n"둘째 행\n끝나지 않음');
  equal(malformed.kind, 'error');
  if (malformed.kind === 'error') match(malformed.message, /2행/);
  const expanded = parseDocumentTablePaste(`"위${'\n'.repeat(MAX_DOCUMENT_NODES)}아래"`);
  equal(expanded.kind, 'error');
  if (expanded.kind === 'error') match(expanded.message, /블록 수/);
});
