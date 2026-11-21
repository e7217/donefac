import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LegacyRecord } from '../../shared/types.js';
import { contentReferences, documentContentSchemaVersion } from '../../shared/document-nodes.js';
import { documentNodes } from '../../shared/document-references.js';
import { normalizeDocumentContent } from '../../server/document-content.js';
import { convertLegacyContent, type MigrationReferenceInput } from '../../server/migration-content.js';

const page = (text: string): LegacyRecord => ({
  id: 'page:old-page', kind: 'page', sourceId: 'old-page', title: '합성 원본',
  containerId: 'WIKI', parentId: null, authorId: null, createdAt: null, updatedAt: null,
  text, textFormat: 'confluence-storage', metadata: {}, references: [],
});
const parameter = (name: string, value: string) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
const macro = (name: string, content: string) => `<ac:structured-macro ac:name="${name}">${content}</ac:structured-macro>`;
const excerpt = (content: string, parameters = '') => macro('excerpt', `${parameters}<ac:rich-text-body>${content}</ac:rich-text-body>`);

test('Confluence excerpt and Excerpt Include preserve source formatting, hidden mode and exact supported target parameters', () => {
  const source = excerpt('<p>첫 <strong>발췌</strong></p><ul><li>원본 목록</li></ul>',
    parameter('hidden', ' true ') + parameter('atlassian-macro-output-type', 'BLOCK'));
  const second = excerpt('<p>다음 발췌</p>');
  const textTarget = macro('excerpt-include', '<ac:default-parameter>WIKI:지원 가이드</ac:default-parameter>' + parameter('nopanel', 'TRUE'));
  const idTarget = macro('excerpt-include', parameter('', '<ac:link><ri:page ri:content-id="32" ri:content-title="이전 이름"></ri:page></ac:link>'));
  const queries: MigrationReferenceInput[] = [];
  const result = convertLegacyContent(page(source + second + textTarget + idTarget), {
    resolveReference(input) {
      queries.push(input);
      return input.sourceId ? { id: 'exact-id', label: '새 이름' } : { id: 'exact-title', label: '지원 가이드' };
    },
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(documentContentSchemaVersion(result.content), 11);
  const children = result.content.content!;
  assert.deepEqual(children.map(node => node.type), ['documentExcerpt', 'documentExcerpt', 'documentExcerptInclude', 'documentExcerptInclude']);
  assert.deepEqual(children.slice(0, 2).map(node => node.attrs?.hidden), [true, false]);
  assert.equal(children[0].content?.[1].type, 'bulletList');
  assert.ok([...documentNodes(children[0])].some(node => node.text === '발췌' && node.marks?.some(mark => mark.type === 'bold')));
  assert.deepEqual(children.slice(2).map(node => ({ ...node.attrs })), [
    { documentId: 'exact-title', label: '지원 가이드', noPanel: true },
    { documentId: 'exact-id', label: '새 이름', noPanel: false },
  ]);
  assert.deepEqual(queries.map(({ kind, sourceId, title, spaceKey }) => [kind, sourceId, title, spaceKey]), [
    ['page', undefined, '지원 가이드', 'WIKI'], ['page', '32', '이전 이름', undefined],
  ]);
  assert.deepEqual(contentReferences(result.content).map(({ id, kind }) => [id, kind]), [['exact-title', 'include'], ['exact-id', 'include']]);
  assert.deepEqual(normalizeDocumentContent(result.content), { content: result.content, plainText: result.plainText });
});

test('unsupported or unresolved Confluence excerpt macros retain original XML and never select a later definition', () => {
  const cases = [
    [excerpt('<p>인라인 원본</p>', parameter('atlassian-macro-output-type', 'INLINE')), 'EXCERPT_PARAMETERS_UNSUPPORTED'],
    [excerpt('<p>모호한 원본</p>', parameter('hidden', 'true') + parameter('hidden', 'false')), 'EXCERPT_PARAMETERS_UNSUPPORTED'],
    [excerpt('<p>별칭 있는 원본</p>', parameter('name', '별칭')), 'EXCERPT_PARAMETERS_UNSUPPORTED'],
    [macro('excerpt-include', parameter('', '가이드') + parameter('page', '다른 가이드')), 'EXCERPT_INCLUDE_PARAMETERS_UNSUPPORTED'],
    [macro('excerpt-include', parameter('', '<ac:link ac:anchor="nested"><ri:page ri:content-id="3"></ri:page></ac:link>')), 'EXCERPT_INCLUDE_PARAMETERS_UNSUPPORTED'],
    [macro('excerpt-include', parameter('', '<ri:page ri:content-id="3" ri:page-id="4"></ri:page>')), 'EXCERPT_INCLUDE_PARAMETERS_UNSUPPORTED'],
    [macro('excerpt-include', parameter('', 'WIKI:')), 'EXCERPT_INCLUDE_PARAMETERS_UNSUPPORTED'],
    [macro('excerpt-include', parameter('', '다른 가이드') + parameter('nopanel', 'maybe')), 'EXCERPT_INCLUDE_PARAMETERS_UNSUPPORTED'],
    [macro('excerpt-include', parameter('', '없는 가이드')), 'UNRESOLVED_EXCERPT_INCLUDE'],
  ] as const;
  const context = { resolveReference: () => null };
  for (const [xml, expected] of cases) {
    const result = convertLegacyContent(page(xml), context);
    assert.deepEqual(result.diagnostics.map(item => item.code), [expected], xml);
    assert.equal(result.content.content?.[0].type, 'codeBlock');
    assert.equal(result.content.content?.[0].content?.[0].text, xml);
    assert.deepEqual(contentReferences(result.content), []);
  }
  const later = excerpt('<p>두 번째 발췌</p>');
  for (const first of [cases[0][0], `<ac:layout>${excerpt('<p>레이아웃 안 첫 발췌</p>')}</ac:layout>`]) {
    const result = convertLegacyContent(page(first + later), context);
    assert.deepEqual(result.content.content?.map(node => node.type), ['codeBlock', 'codeBlock']);
    assert.ok(result.diagnostics.some(item => item.code === 'EXCERPT_FIRST_DEFINITION_UNAVAILABLE'));
  }

  const previous = convertLegacyContent(page(excerpt('<p>기존 본문</p>') + cases[8][0]), {
    ...context, legacyDocumentExcerpt: true,
  });
  assert.deepEqual(previous.diagnostics.map(item => item.code), ['LEGACY_EXCERPT_REPRESENTATION']);
  assert.deepEqual(previous.content.content?.map(node => node.type), ['paragraph', 'codeBlock']);
  assert.equal(previous.content.content?.[0].content?.[0].text, '기존 본문');
  assert.equal(previous.content.content?.[1].content?.[0].text, cases[8][0]);
});
