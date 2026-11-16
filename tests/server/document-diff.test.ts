import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RichContent } from '../../shared/types.js';
import { diffDocuments, DocumentDiffError, DOCUMENT_DIFF_LIMITS, flattenDocumentForDiff, type DocumentDiffSource } from '../../shared/document-diff.js';

const paragraph = (text: string, attrs?: Record<string, unknown>): RichContent => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text }] });
const source = (blocks: RichContent[], title = '문서'): DocumentDiffSource => ({ title, content: { type: 'doc', content: blocks } });
function exact(before: DocumentDiffSource, after: DocumentDiffSource) {
  const result = diffDocuments(before, after);
  assert.deepEqual(result.runs.flatMap(run => run.before), flattenDocumentForDiff(before).units);
  assert.deepEqual(result.runs.flatMap(run => run.after), flattenDocumentForDiff(after).units);
  for (const run of result.runs) if (run.kind === 'equal') { assert.equal(run.before.length, run.after.length); assert.deepEqual(run.before.map(unit => unit.signature), run.after.map(unit => unit.signature)); }
  return result;
}

test('revision diff reconstructs both complete sources across insertions, removals, duplicate blocks and changed titles', () => {
  const before = source([paragraph('같은 내용'), paragraph('삭제'), paragraph('같은 내용'), paragraph('끝')], '이전 제목');
  const after = source([paragraph('추가'), paragraph('같은 내용'), paragraph('같은 내용'), paragraph('끝')], '새 제목');
  const result = exact(before, after);
  assert.equal(result.identical, false); assert.ok(result.stats.added > 0); assert.ok(result.stats.removed > 0);
  assert.ok(result.runs.some(run => run.kind === 'delete' && run.before.some(unit => unit.kind === 'title' && unit.text === '이전 제목')));
  assert.equal(diffDocuments(before, before).identical, true);
});

test('formatting, table/image attributes, reference targets and details children differ even when text is equal', () => {
  const before = source([
    { type: 'paragraph', content: [{ type: 'text', text: '같은 글', marks: [{ type: 'bold' }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, background: 'white' }, content: [paragraph('표')] }] }] },
    { type: 'image', attrs: { src: '/old.png', alt: '그림' } },
    { type: 'issueReference', attrs: { issueId: 'issue-a', label: '업무' } },
    { type: 'documentReference', attrs: { documentId: 'doc-a', label: '참고' } },
    { type: 'documentInclude', attrs: { documentId: 'include-a', label: '포함' } },
    { type: 'details', attrs: { presentation: 'one' }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: '제목' }] }, { type: 'detailsContent', content: [paragraph('본문')] }] },
  ]);
  const after = structuredClone(before);
  const blocks = after.content.content!;
  blocks[0].content![0].marks = [{ type: 'italic' }]; blocks[1].content![0].content![0].attrs = { background: 'green', colspan: 1 };
  blocks[2].attrs!.src = '/new.png'; blocks[3].attrs!.issueId = 'issue-b'; blocks[4].attrs!.documentId = 'doc-b'; blocks[5].attrs!.documentId = 'include-b'; blocks[6].attrs!.presentation = 'two';
  const result = exact(before, after), removed = result.runs.filter(run => run.kind === 'delete').flatMap(run => run.before).map(unit => unit.metadata).join('\n'), added = result.runs.filter(run => run.kind === 'insert').flatMap(run => run.after).map(unit => unit.metadata).join('\n');
  assert.equal(result.identical, false); assert.equal(result.stats.textAdded, 0); assert.equal(result.stats.textRemoved, 0);
  for (const text of ['bold', '/old.png', 'issue-a', 'doc-a', 'include-a', 'white', 'one']) assert.ok(removed.includes(text));
  for (const text of ['italic', '/new.png', 'issue-b', 'doc-b', 'include-b', 'green', 'two']) assert.ok(added.includes(text));
  const changedChildren = structuredClone(after); changedChildren.content.content![6].content!.reverse(); assert.equal(exact(after, changedChildren).identical, false);
});

test('bounded Myers is exact for deterministic random small edits and repeated block shapes', () => {
  let seed = 917;
  const random = (max: number) => { seed = (seed * 16807) % 2147483647; return seed % max; };
  for (let attempt = 0; attempt < 100; attempt++) {
    const before = source(Array.from({ length: random(15) }, () => paragraph(String(random(4))))), after = structuredClone(before);
    for (let edit = 0; edit < 4; edit++) { const index = random(after.content.content!.length + 1); if (random(2)) after.content.content!.splice(index, 0, paragraph(String(random(6)))); else after.content.content!.splice(index, 1); }
    exact(before, after);
  }
});

test('large duplicate documents respect one global work budget and retain every unit in conservative fallback', { timeout: 15_000 }, () => {
  const before = source(Array.from({ length: 10_000 }, () => paragraph('이전 반복 문장'))), after = source(Array.from({ length: 10_000 }, () => paragraph('새 반복 문장')));
  const result = exact(before, after);
  assert.ok(result.fallbackGaps > 0); assert.ok(result.myersWork <= DOCUMENT_DIFF_LIMITS.myersWork); assert.equal(result.before.nodes, 20_001); assert.ok(result.stats.removed >= 10_000); assert.ok(result.stats.added >= 10_000);
});

test('exact 8MiB body plus a 300-character CJK title and 30000-node boundary reconstruct completely; one extra body byte rejects', { timeout: 15_000 }, () => {
  const title = '제'.repeat(300), overhead = new TextEncoder().encode(JSON.stringify(source([paragraph('')]).content)).length;
  const text = 'x'.repeat(DOCUMENT_DIFF_LIMITS.bytes - overhead), before = source([paragraph(text)], title), after = source([paragraph(`${text.slice(0, -1)}y`)], title);
  const result = exact(before, after);
  assert.equal(result.identical, false); assert.equal(result.before.bytes, DOCUMENT_DIFF_LIMITS.bytes); assert.equal(result.runs.flatMap(run => run.before).filter(unit => unit.kind === 'title').map(unit => unit.text).join(''), title); assert.ok(result.runs.flatMap(run => run.before).filter(unit => unit.kind === 'text').every(unit => unit.text.length <= DOCUMENT_DIFF_LIMITS.textChunk + 1));
  const nodes = source(Array.from({ length: DOCUMENT_DIFF_LIMITS.nodes - 1 }, () => ({ type: 'paragraph' })));
  assert.equal(diffDocuments(nodes, nodes).before.nodes, DOCUMENT_DIFF_LIMITS.nodes);
  assert.throws(() => diffDocuments(source([...nodes.content.content!, { type: 'paragraph' }]), nodes), (error: unknown) => error instanceof DocumentDiffError && error.code === 'nodes');
  assert.throws(() => diffDocuments(source([paragraph(`${text}x`)], title), before), (error: unknown) => error instanceof DocumentDiffError && error.code === 'size');
  assert.throws(() => diffDocuments(source([], 'x'.repeat(DOCUMENT_DIFF_LIMITS.titleBytes + 1)), before), (error: unknown) => error instanceof DocumentDiffError && error.code === 'size');
});

test('canonical attribute key order is stable, Unicode chunks rejoin exactly and invalid cycles fail explicitly', () => {
  const text = `${'가'.repeat(1023)}😀뒤`, before = source([paragraph(text, { z: 1, a: { two: true, one: '값' } })], text), after = source([paragraph(text, { a: { one: '값', two: true }, z: 1 })], text);
  assert.equal(exact(before, after).identical, true);
  const units = flattenDocumentForDiff(before).units;
  assert.equal(units.filter(unit => unit.kind === 'text').map(unit => unit.text).join(''), text); assert.equal(units.filter(unit => unit.kind === 'title').map(unit => unit.text).join(''), text);
  const cyclic: RichContent = { type: 'doc', content: [] }; cyclic.content!.push(cyclic);
  assert.throws(() => diffDocuments({ title: '', content: cyclic }, before), (error: unknown) => error instanceof DocumentDiffError && error.code === 'invalid');
});
