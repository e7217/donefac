import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertLegacyContent } from '../../server/migration-content.js';
import { contentReferences, documentContentSchemaVersion } from '../../shared/document-nodes.js';
import { documentNodes } from '../../shared/document-references.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import type { LegacyRecord } from '../../shared/types.js';

const page = (text: string): LegacyRecord => ({
  id: 'page:42', kind: 'page', sourceId: '42', title: '이관 원본',
  containerId: 'WIKI', parentId: null, authorId: null, createdAt: null, updatedAt: null,
  text, textFormat: 'confluence-storage', metadata: {}, references: [],
});
const section = (kind: string, contents: string[]) => `<ac:layout-section ac:type="${kind}">\n${contents.map(content =>
  `<ac:layout-cell>${content}</ac:layout-cell>`).join('\n')}\n</ac:layout-section>`;
const layout = (body: string, attrs = '') => `<ac:layout${attrs}>\n${body}\n</ac:layout>`;
const parameter = (name: string, value: string) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
const macro = (name: string, body: string, parameters = '', attrs = '') =>
  `<ac:structured-macro ac:name="${name}"${attrs}>${parameters}<ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`;
const column = (body: string, width?: string) => macro('column', body, width === undefined ? '' : parameter('width', width));
const withoutReferences = { resolveReference: () => null };

test('all Confluence storage column types keep ordered editable cells in pages and revisions', () => {
  const layouts = {
    single: [1], two_equal: [1, 1], two_left_sidebar: [3, 7], two_right_sidebar: [7, 3],
    three_equal: [1, 1, 1], three_with_sidebars: [1, 3, 1],
  };
  const rows = Object.entries(layouts).map(([kind, weights]) => section(kind, weights.map((_, i) => `<p>${kind} 열 ${i + 1}</p>`)));
  const source = layout(rows.join('\n'), ' xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier"');
  for (const kind of ['page', 'revision'] as const) {
    const converted = convertLegacyContent({ ...page(source), kind }, withoutReferences);
    assert.deepEqual(converted.diagnostics, []);
    assert.equal(documentContentSchemaVersion(converted.content), 12);
    assert.deepEqual(converted.content.content?.map(node => [node.type, { ...node.attrs }, node.content?.map(cell => [cell.type, cell.content?.[0]?.content?.[0]?.text])]),
      Object.entries(layouts).map(([name, weights]) => ['documentColumnLayout', { weights, border: false }, weights.map((_, i) => ['documentColumn', `${name} 열 ${i + 1}`])]));
  }
  const comment = convertLegacyContent({ ...page(source), kind: 'comment' }, withoutReferences);
  assert.deepEqual(comment.content.content?.map(node => node.type), ['codeBlock']);
});

test('Confluence column markup keeps heading targets, resolved attachment references, and nested editable blocks', () => {
  const rich = '<h2 id="equal-target">왼쪽 절</h2><p><strong>첫 문장</strong>과 <em>이어지는 내용</em></p>';
  const picture = '<ac:image ac:alt="대조 사진"><ri:attachment ri:filename="check.png"></ri:attachment></ac:image>';
  const footer = '<p><a href="#equal-target">왼쪽 절로 이동</a></p>';
  const inner = macro('section', column(picture, '125.25px') + column('<ul><li>두 번째 열</li></ul>', '250.50px'),
    parameter('border', ' true '), ' xmlns:ac="http://atlassian.com/content"');
  const equal = macro('section', column('<p>첫째</p>') + column('<p>둘째</p>'));
  const percent = macro('section', column('<p>왼쪽</p>', '12.5%') + column('<p>중앙</p>', '50%') + column('<p>오른쪽</p>', '37.5%'));
  const source = layout(section('two_equal', [rich, inner + footer]) + section('single', [equal + percent]));
  const converted = convertLegacyContent(page(source), {
    sectionLinks: { documentId: 'target-document' },
    resolveReference: input => input.kind === 'attachment' && input.title === 'check.png'
      ? { id: 'exact-version', label: '대조 사진', url: '/api/attachments/exact-version/content?inline=1' } : null,
  });
  assert.deepEqual(converted.diagnostics, []);
  const nodes = [...documentNodes(converted.content)];
  const layoutOptions = nodes.filter(node => node.type === 'documentColumnLayout').map(node => ({ ...node.attrs }));
  assert.deepEqual(layoutOptions, [
    { weights: [1, 1], border: false }, { weights: [1, 2], border: true }, { weights: [1], border: false },
    { weights: [1, 1], border: false }, { weights: [1, 4, 3], border: false },
  ]);
  const target = converted.sectionTargets?.get('equal-target');
  assert.ok(target);
  assert.equal(nodes.find(node => node.type === 'heading')?.attrs?.sectionId, target);
  assert.deepEqual(nodes.find(node => node.text === '왼쪽 절로 이동')?.marks?.map(mark => mark.attrs?.href), [documentSectionHash('target-document', target)]);
  assert.equal(nodes.find(node => node.type === 'image')?.attrs?.src, '/api/attachments/exact-version/content?inline=1');
  assert.equal(nodes.find(node => node.text === '첫 문장')?.marks?.[0].type, 'bold');
  assert.equal(nodes.find(node => node.text === '이어지는 내용')?.marks?.[0].type, 'italic');
});

test('malformed Confluence layouts and unrepresentable column settings stay inert; supported layouts reproduce exact legacy blocks', () => {
  const reference = '<ac:link><ri:page ri:content-id="4"></ri:page></ac:link>';
  const valid = layout(section('two_equal', ['<p>하나</p>', reference]));
  const goodMacro = macro('section', column('<p>테스트</p>') + column(reference));
  const malformed = [
    layout(section('single', [reference, '<p>예상 밖 열</p>'])),
    layout(section('custom', [reference])),
    layout(section('single', [reference]), ' xmlns:ac="urn:other"'),
    layout(section('single', [reference]).replace('ac:type=', 'other="x" ac:type=')),
    layout(section('single', [reference]).replace('<ac:layout-cell>', '<ac:layout-cell onclick="ignored">')),
    layout(macro('excerpt', reference)),
    macro('section', column(reference, '30%') + column('<p>없음</p>')),
    macro('section', column(reference, '30%') + column('<p>혼합</p>', '70px')),
    macro('section', column(reference, '99999px') + column('<p>비율 한도</p>', '2px')),
    macro('section', column(reference, '0px') + column('<p>범위 밖</p>', '2px')),
    macro('section', column(reference), parameter('border', 'true') + parameter('border', 'false')),
    macro('section', reference + column('<p>잘못된 자식</p>')),
    macro('section', Array.from({ length: 4 }, () => column(reference)).join('')),
  ];
  let resolutions = 0;
  const safeContext = { resolveReference: () => { resolutions++; return { id: 'unexpected', label: '연결' }; } };
  for (const raw of malformed) {
    const converted = convertLegacyContent(page(raw), safeContext);
    assert.deepEqual(converted.diagnostics.map(item => item.code), ['LAYOUT_STRUCTURE_UNSUPPORTED'], raw);
    const expected = raw.startsWith('<ac:layout') ? `[XML ac:layout]\n${raw}` : raw;
    assert.deepEqual(converted.content.content?.map(node => node.content?.[0]?.text), [expected]);
    assert.deepEqual(contentReferences(converted.content), []);
  }
  const projection = convertLegacyContent(page(valid + goodMacro), { ...safeContext, legacyDocumentLayout: true });
  assert.deepEqual(projection.diagnostics.map(item => item.code), ['LEGACY_LAYOUT_REPRESENTATION']);
  assert.deepEqual(projection.content.content?.map(node => node.content?.[0]?.text), [`[XML ac:layout]\n${valid}`, goodMacro]);
  assert.equal(resolutions, 0);
});
