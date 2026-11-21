import assert from 'node:assert/strict';
import test from 'node:test';
import { locateDocumentSelection } from '../../shared/document-selection-highlight.js';
import type { RichContent } from '../../shared/types.js';

const doc = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', content });
const text = (value: string, mark?: string): RichContent => ({
  type: 'text', text: value, ...(mark ? { marks: [{ type: mark }] } : {}),
});

test('repeated text highlights the recorded occurrence only', () => {
  const sentence = '반복 문장';
  const gap = ' / ';
  const content = doc(paragraph(text(sentence + gap + sentence)), paragraph(text(sentence)));
  const offset = sentence.length + gap.length;
  const from = offset + 1;
  const result = locateDocumentSelection(content, { from, to: from + sentence.length, text: sentence });
  assert.ok(result);
  assert.equal(result.anchor, 'readonly:0:0');
  assert.deepEqual([...result.marks], [['readonly:0:0', { kind: 'text', from: offset, to: offset + sentence.length }]]);
  assert.equal(locateDocumentSelection(content, { from: 2, to: 2 + sentence.length, text: sentence }), null);
});

test('nested and formatted fragments follow renderer indices through hard breaks and paragraphs', () => {
  const content = doc({ type: 'blockquote', content: [
    paragraph(text('top '), text('bold', 'bold'), { type: 'hardBreak' }, text('tail!', 'italic')),
    paragraph(text('next')),
  ] });
  const result = locateDocumentSelection(content, { from: 4, to: 20, text: 'p bold\ntail!\nne' });
  assert.ok(result);
  assert.equal(result.anchor, 'readonly:0:0:0');
  assert.deepEqual([...result.marks], [
    ['readonly:0:0:0', { kind: 'text', from: 2, to: 4 }],
    ['readonly:0:0:1', { kind: 'text', from: 0, to: 4 }],
    ['readonly:0:0:3', { kind: 'text', from: 0, to: 5 }],
    ['readonly:0:1:0', { kind: 'text', from: 0, to: 2 }],
  ]);
});

test('text offsets are UTF-16 and a highlight cannot split surrogate pairs', () => {
  const content = doc(paragraph(text('가😀나')));
  const result = locateDocumentSelection(content, { from: 2, to: 4, text: '😀' });
  assert.ok(result);
  assert.deepEqual([...result.marks], [['readonly:0:0', { kind: 'text', from: 1, to: 3 }]]);
  assert.equal(locateDocumentSelection(content, { from: 2, to: 3, text: '😀'[0] }), null);
  const brokenFragments = doc(paragraph(text('😀'[0], 'bold'), text('😀'[1], 'italic')));
  assert.equal(locateDocumentSelection(brokenFragments, { from: 1, to: 3, text: '😀' }), null);
});

test('status badges occupy a single position and appear as a whole-leaf mark', () => {
  const badge = { type: 'statusBadge', attrs: { label: '검토 중', tone: 'neutral' } };
  const content = doc(paragraph(text('A'), badge, text('BE')));
  const result = locateDocumentSelection(content, { from: 2, to: 4, text: '검토 중B' });
  assert.ok(result);
  assert.equal(result.anchor, 'readonly:0:1');
  assert.deepEqual([...result.marks], [
    ['readonly:0:1', { kind: 'badge' }],
    ['readonly:0:2', { kind: 'text', from: 0, to: 1 }],
  ]);
  const onlyBadge = locateDocumentSelection(content, { from: 2, to: 3, text: '검토 중' });
  assert.deepEqual(onlyBadge, { anchor: 'readonly:0:1', marks: new Map([['readonly:0:1', { kind: 'badge' }]]) });
});

test('wrong positions, invalid schema and merged raw paths fail closed', () => {
  const selection = { from: 1, to: 5, text: 'text' };
  const content = doc(paragraph(text('text')));
  for (const invalid of [
    { ...selection, from: -1 }, { ...selection, from: 1.5 }, { ...selection, to: 1 },
    { ...selection, to: 7 }, { ...selection, text: 'TEXT' },
  ]) assert.equal(locateDocumentSelection(content, invalid), null);
  for (const invalid of [
    paragraph(text('text')), doc(text('text')),
    doc(paragraph({ type: 'unknownNode', text: 'text' })),
    doc(paragraph({ ...text('text'), content: [text('hidden')] })),
    doc(paragraph(text('te'), text('xt'))),
  ]) assert.equal(locateDocumentSelection(invalid, selection), null);

  const mergedSibling = doc(paragraph(text('te'), text('xt')), paragraph(text('text')));
  const accessible = locateDocumentSelection(mergedSibling, { from: 7, to: 11, text: 'text' });
  assert.deepEqual(accessible, { anchor: 'readonly:1:0', marks: new Map([['readonly:1:0', { kind: 'text', from: 0, to: 4 }]]) });
});
