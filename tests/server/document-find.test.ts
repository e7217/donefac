import assert from 'node:assert/strict';
import test from 'node:test';
import { getExtensionField, type Editor } from '@tiptap/core';
import { history, redo, undo, undoDepth } from '@tiptap/pm/history';
import type { Node as EditorNode } from '@tiptap/pm/model';
import { EditorState, type Plugin, type Transaction } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { MAX_DOCUMENT_BYTES } from '../../shared/document-nodes.js';
import { createEditorSchema } from '../../shared/editor-schema.js';
import type { RichContent } from '../../shared/types.js';
import {
  DOCUMENT_FIND_MATCH_LIMIT, DOCUMENT_FIND_QUERY_LIMIT, DOCUMENT_FIND_REPLACEMENT_LIMIT,
  documentFindExtension, documentFindReplacementFitsBatch, findDocumentText, replaceDocumentFindMatches, showDocumentFindMatches,
} from '../../src/features/document-find.js';

const schema = createEditorSchema();
const text = (value: string, marks: string[] = []): RichContent => ({
  type: 'text', text: value, ...(marks.length ? { marks: marks.map(type => ({ type })) } : {}),
});
const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', content });

function doc(...content: RichContent[]): EditorNode {
  const result = schema.nodeFromJSON({ type: 'doc', content });
  result.check();
  return result;
}

function editorHarness(initial: EditorNode) {
  const [findPlugin] = getExtensionField<() => Plugin[]>(documentFindExtension, 'addProseMirrorPlugins')();
  let state = EditorState.create({ doc: initial, plugins: [history(), findPlugin] });
  const dispatched: Transaction[] = [];
  const view = {
    composing: false,
    dispatch(transaction: Transaction) {
      dispatched.push(transaction);
      state = state.applyTransaction(transaction).state;
    },
  };
  const stub = { get state() { return state; }, isEditable: true, isDestroyed: false, view };
  return {
    editor: stub as unknown as Editor, stub, view, dispatched,
    get state() { return state; },
    get decorations() { return findPlugin.getState(state) as DecorationSet; },
  };
}

test('document find matches literal Unicode text across marks and searches nested editable textblocks', () => {
  const body = doc(
    paragraph(text('İ 𐐨 낱'), text('말 [.*+?]', ['bold'])),
    { type: 'details', content: [{ type: 'detailsSummary', content: [text('절 낱말')] },
      { type: 'detailsContent', content: [{ type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', content: [paragraph(text('표 낱말'))] },
      ] }] }] }] },
    { type: 'documentColumnLayout', attrs: { weights: [1, 1] }, content: [
      { type: 'documentColumn', content: [paragraph(text('단 낱말'))] },
      { type: 'documentColumn', content: [{ type: 'codeBlock', content: [text('첫 줄\n코드 낱말')] }] },
    ] },
  );
  const find = (query: string, caseSensitive = false) => findDocumentText(body, query, caseSensitive).matches
    .map(({ from, to }) => [from, body.textBetween(from, to)] as const);
  assert.deepEqual(find('낱말').map(([, match]) => match), Array(5).fill('낱말'));
  assert.deepEqual(find('𐐀'), [[3, '𐐨']]);
  assert.deepEqual(find('𐐀', true), []);
  assert.deepEqual(find('[.*+?]').map(([, match]) => match), ['[.*+?]']);
  assert.deepEqual(find('첫 줄\n코드'), []);
});

test('document find does not combine blocks, hard breaks, atoms or different table cells', () => {
  const body = doc(
    paragraph(text('앞'), { type: 'hardBreak' }, text('뒤')),
    paragraph(text('왼'), { type: 'statusBadge', attrs: { label: '속성전용표지' } }, text('오')),
    paragraph(text('블록 앞')), paragraph(text('블록 뒤')),
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableCell', content: [paragraph(text('셀 앞'))] },
      { type: 'tableCell', content: [paragraph(text('셀 뒤'))] },
    ] }] },
  );
  for (const query of ['앞뒤', '왼오', '속성전용표지', '앞블록', '앞셀']) {
    assert.deepEqual(findDocumentText(body, query, false), { matches: [], truncated: false });
  }
});

test('document find caps matches and rejects invalid queries without treating spaces as empty', () => {
  const body = doc(paragraph(text('x '.repeat(DOCUMENT_FIND_MATCH_LIMIT) + 'x')));
  assert.equal(findDocumentText(body, 'x', true).matches.length, DOCUMENT_FIND_MATCH_LIMIT);
  assert.equal(findDocumentText(body, 'x', true).truncated, true);
  assert.equal(findDocumentText(body, ' ', true).matches.length, DOCUMENT_FIND_MATCH_LIMIT);
  assert.equal(findDocumentText(body, ' ', true).truncated, false);
  for (const query of ['', 'x'.repeat(DOCUMENT_FIND_QUERY_LIMIT + 1), '\ud800', 'x\u2028x']) {
    assert.deepEqual(findDocumentText(body, query, true), { matches: [], truncated: false });
  }
});

test('document highlighting keeps editor content, selection and undo unchanged, then invalidates stale results', () => {
  const body = doc(paragraph(text('검증 검증')));
  const harness = editorHarness(body);
  const selection = harness.state.selection;
  const { matches } = findDocumentText(body, '검증', false);
  harness.stub.isEditable = false;
  showDocumentFindMatches(harness.editor, body, matches, 1);
  assert.equal(harness.state.doc, body);
  assert.equal(harness.state.selection, selection);
  assert.equal(undoDepth(harness.state), 0);
  const decorations = harness.decorations.find();
  assert.deepEqual(decorations.map(({ from, to }) => ({ from, to })), matches);
  const attributes = (decoration: typeof decorations[number]) =>
    (decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
  assert.deepEqual(attributes(decorations[0]), { 'data-document-find-match': 'true' });
  assert.deepEqual(attributes(decorations[1]), { 'data-document-find-match': 'true', 'data-document-find-active': 'true' });
  harness.view.dispatch(harness.state.tr.insertText('새 글 ', 1));
  showDocumentFindMatches(harness.editor, body, matches, 1);
  assert.deepEqual(harness.decorations.find(), []);
  const current = harness.state.doc;
  showDocumentFindMatches(harness.editor, current, findDocumentText(current, '검증', false).matches, 0);
  showDocumentFindMatches(harness.editor, current, [], -1);
  assert.deepEqual(harness.decorations.find(), []);
});

test('document replacement keeps common formatting and undo boundaries around the single content transaction', () => {
  const body = doc(paragraph(text('전', ['bold']), text('A', ['bold', 'italic']), text('B후', ['bold']), text(' AB 마침')));
  const harness = editorHarness(body);
  harness.view.dispatch(harness.state.tr.insertText('x', 2));
  const before = harness.state.doc;
  const { matches } = findDocumentText(before, 'AB', true);
  assert.equal(replaceDocumentFindMatches(harness.editor, before, matches, '교체'), true);
  assert.equal(harness.dispatched.length, 2);
  assert.equal(harness.dispatched[1].steps.length, 2);
  assert.deepEqual(harness.state.doc.firstChild?.content.content.map(node => [node.text, node.marks.map(mark => mark.type.name)]), [
    ['전x교체후', ['bold']], [' 교체 마침', []],
  ]);
  assert.equal(undoDepth(harness.state), 2);
  harness.view.dispatch(harness.state.tr.insertText('y', 3));
  assert.equal(undoDepth(harness.state), 3);
  assert.ok(undo(harness.state, harness.view.dispatch));
  assert.equal(harness.state.doc.textContent, '전x교체후 교체 마침');
  assert.ok(undo(harness.state, harness.view.dispatch));
  assert.ok(harness.state.doc.eq(before));
  assert.ok(redo(harness.state, harness.view.dispatch));
  assert.equal(harness.state.doc.textContent, '전x교체후 교체 마침');
});

test('document replacement refuses stale or overlapping ranges, cuts through atoms and pasted multiline text', () => {
  const body = doc(paragraph(text('AB', ['bold']), { type: 'statusBadge', attrs: { label: '상태' } }, text('AB')));
  const harness = editorHarness(body);
  const { matches } = findDocumentText(body, 'AB', true);
  const replacements = ['AB', 'x'.repeat(DOCUMENT_FIND_REPLACEMENT_LIMIT + 1), '다음\n줄', '\ud800'];
  for (const replacement of replacements) assert.equal(replaceDocumentFindMatches(harness.editor, body, matches, replacement), false);
  assert.equal(replaceDocumentFindMatches(harness.editor, body, [...matches, matches[0]], '겹침'), false);
  assert.equal(replaceDocumentFindMatches(harness.editor, body, [{ from: matches[0].from, to: matches[1].to }], '원자'), false);
  harness.stub.isEditable = false;
  assert.equal(replaceDocumentFindMatches(harness.editor, body, matches, ''), false);
  harness.stub.isEditable = true;
  harness.view.composing = true;
  assert.equal(replaceDocumentFindMatches(harness.editor, body, matches, ''), false);
  harness.view.composing = false;
  assert.equal(harness.state.doc, body);
  assert.equal(harness.dispatched.length, 0);
  harness.view.dispatch(harness.state.tr.insertText('새 ', 1));
  assert.equal(replaceDocumentFindMatches(harness.editor, body, matches, ''), false);
  const current = harness.state.doc;
  assert.equal(replaceDocumentFindMatches(harness.editor, current, findDocumentText(current, 'AB', true).matches, ''), true);
  assert.equal(harness.state.doc.firstChild?.lastChild?.type.name, 'statusBadge');
  assert.equal(harness.state.doc.textContent, '새 ');
});

test('bulk replacement counts inserted UTF-8 bytes and rejects a too-large update without dispatch', () => {
  const replacement = '한'.repeat(DOCUMENT_FIND_REPLACEMENT_LIMIT);
  const atLimit = Math.floor(512 * 1024 / Buffer.byteLength(replacement));
  assert.equal(documentFindReplacementFitsBatch(replacement, atLimit), true);
  assert.equal(documentFindReplacementFitsBatch(replacement, atLimit + 1), false);
  assert.equal(documentFindReplacementFitsBatch('a'.repeat(replacement.length), atLimit + 1), true);

  const body = doc(paragraph(text('x '.repeat(atLimit + 1))));
  const harness = editorHarness(body);
  const { matches } = findDocumentText(body, 'x', true);
  assert.equal(replaceDocumentFindMatches(harness.editor, body, matches, replacement), false);
  assert.equal(harness.state.doc, body);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(replaceDocumentFindMatches(harness.editor, body, matches.slice(0, atLimit), replacement), true);
  assert.equal(harness.dispatched.length, 1);
});

test('replacement checks the projected UTF-8 document size even if the individual update fits', () => {
  const template = doc(paragraph(text('찾기')), paragraph(text('x')));
  const overhead = Buffer.byteLength(JSON.stringify(template.toJSON())) - 1;
  const body = doc(paragraph(text('찾기')), paragraph(text('x'.repeat(MAX_DOCUMENT_BYTES - overhead))));
  assert.equal(Buffer.byteLength(JSON.stringify(body.toJSON())), MAX_DOCUMENT_BYTES);
  const harness = editorHarness(body);
  const { matches } = findDocumentText(body, '찾기', true);
  assert.equal(documentFindReplacementFitsBatch('찾았다', matches.length), true);
  assert.equal(replaceDocumentFindMatches(harness.editor, body, matches, '찾았다'), false);
  assert.equal(harness.state.doc, body);
  assert.equal(harness.dispatched.length, 0);
  assert.equal(replaceDocumentFindMatches(harness.editor, body, matches, '찾음'), true);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(Buffer.byteLength(JSON.stringify(harness.state.doc.toJSON())), MAX_DOCUMENT_BYTES);
});
