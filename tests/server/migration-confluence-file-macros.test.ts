import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegacyRecord, RichContent } from '../../shared/types.js';
import { normalizeDocumentContent } from '../../server/document-content.js';
import { convertLegacyContent, type MigrationContentContext, type MigrationReferenceInput } from '../../server/migration-content.js';

const fileId = 'a1b2c3d4-1111-2222-3333-a1b2c3d4e5f6';
const download = `/api/attachments/${fileId}/content`;
const parameter = (key: string, value: string) => `<ac:parameter ac:name="${key}">${value}</ac:parameter>`;
const macro = (name: string, input: string, tag = 'ac:structured-macro') => `<${tag} ac:name="${name}">${input}</${tag}>`;
const attachment = (filename: string, owner = '', attrs = '') => `<ri:attachment ri:filename="${filename}"${attrs}>${owner}</ri:attachment>`;
const legacyRecord = (text: string, kind: LegacyRecord['kind'] = 'page'): LegacyRecord => ({
  id: `${kind}:100`, kind, sourceId: '100', title: '원본 파일 미리보기', containerId: '42', parentId: null, authorId: null,
  createdAt: null, updatedAt: null, text, textFormat: 'confluence-storage', metadata: {}, references: [],
});
const convert = (xml: string, resolveReference: MigrationContentContext['resolveReference']) => convertLegacyContent(legacyRecord(xml), { resolveReference });
const linked = (title: string): RichContent => ({
  type: 'paragraph', content: [{ type: 'text', text: title, marks: [{ type: 'link', attrs: { href: download } }] }],
});
const doc = (...content: RichContent[]) => normalizeDocumentContent({ type: 'doc', content }).content;
const raw = (xml: string) => doc({ type: 'codeBlock', content: [{ type: 'text', text: xml }] });

test('a Confluence PDF preview becomes an editable download link between the neighboring body paragraphs', () => {
  const pdf = macro('viewpdf', parameter('name', attachment('설치 &amp; 운영.pdf')));
  const seen: MigrationReferenceInput[] = [];
  const { content, plainText, diagnostics } = convert(`<p>파일 앞의 문장${pdf}파일 뒤의 문장</p>`, reference => {
    seen.push(reference);
    return { id: fileId, label: reference.title!, url: download };
  });
  assert.deepEqual(seen, [{ kind: 'attachment', title: '설치 & 운영.pdf', exactAttachment: true }]);
  assert.deepEqual(content, doc(
    { type: 'paragraph', content: [{ type: 'text', text: '파일 앞의 문장' }] }, linked('설치 & 운영.pdf'),
    { type: 'paragraph', content: [{ type: 'text', text: '파일 뒤의 문장' }] },
  ));
  assert.match(plainText, /설치 & 운영\.pdf/u);
  assert.deepEqual(diagnostics.map(item => item.code), ['CONFLUENCE_FILE_PREVIEW_LINKED']);
});

test('Office previews use the same native download path and preserve explicit page and file identities', () => {
  const word = macro('viewdoc', parameter('name', 'Operations.doc') + parameter('page', 'SUPPORT:공용 파일'), 'ac:macro');
  const excel = macro('viewxls', parameter('name', attachment('재고.xlsx', '<ri:content-entity ri:content-id="300"></ri:content-entity>')) +
    parameter('col', 'E') + parameter('sheet', 'Sheet1') +
    parameter('row', '5') + parameter('grid', 'false'));
  const slides = macro('viewppt', parameter('name', attachment('온보딩.pptx',
    '<ri:page ri:content-id="200" ri:content-title="팀 문서"></ri:page>', ' ri:content-id="450"')) +
    parameter('height', '250') + parameter('width', '15%') + parameter('slide', '4'));
  const seen: MigrationReferenceInput[] = [];
  const result = convert(word + excel + slides, reference => {
    seen.push(reference);
    return { id: fileId, label: reference.title!, url: download };
  });
  assert.deepEqual(result.content, doc(linked('Operations.doc'), linked('재고.xlsx'), linked('온보딩.pptx')));
  assert.deepEqual(seen, [
    { kind: 'attachment', title: 'Operations.doc', exactAttachment: true, attachmentOwner: { title: '공용 파일', spaceKey: 'SUPPORT' } },
    { kind: 'attachment', title: '재고.xlsx', exactAttachment: true, attachmentOwner: { sourceId: '300' } },
    { kind: 'attachment', title: '온보딩.pptx', exactAttachment: true, sourceId: '450', attachmentOwner: { sourceId: '200', title: '팀 문서', spaceKey: undefined } },
  ]);
  assert.deepEqual(result.diagnostics.map(item => item.code), ['CONFLUENCE_FILE_PREVIEW_LINKED']);
});

test('file preview XML does not resolve malformed, unsupported or contradictory attachment declarations', () => {
  const validName = parameter('name', attachment('brief.pdf'));
  const unsupported = [
    parameter('page', '문서'),
    validName + validName,
    validName + parameter('page', 'SUPPORT:'),
    validName + parameter('page', '<ri:page ri:content-id="1" ri:page-id="2"></ri:page>'),
    validName + parameter('destination', 'https://external.example/file.pdf'),
    validName + '<ac:rich-text-body><p>Unexpected body</p></ac:rich-text-body>',
    parameter('name', attachment('brief.docx')),
    parameter('name', 'https://external.example/file.pdf'),
    parameter('name', attachment('brief.pdf', '', ' ri:content-id="0"')),
    parameter('name', attachment('brief.pdf', '', ' ri:version-at-save="2"')),
    parameter('name', attachment('brief.pdf', '<ri:page ri:content-title="파일 위치"></ri:page>')) + parameter('page', '다른 파일 위치'),
    parameter('name', '<ri:url ri:value="https://external.example/file.pdf"></ri:url>'),
  ];
  for (const input of unsupported) {
    const xml = macro('viewpdf', input);
    const result = convert(xml, () => { assert.fail('Unsupported input must not resolve an attachment'); });
    assert.deepEqual(result.content, raw(xml), xml);
    assert.deepEqual(result.diagnostics.map(item => item.code), ['CONFLUENCE_FILE_PREVIEW_UNSUPPORTED'], xml);
  }
});

test('a file preview without a matching local download and file name stays an inert XML block', () => {
  const xml = macro('viewpdf', parameter('name', attachment('brief.pdf')));
  for (const found of [
    null,
    { id: fileId, label: 'brief.pdf', url: 'https://external.example/brief.pdf' },
    { id: fileId, label: 'brief.pdf', url: `${download}?inline=1` },
    { id: 'unrelated', label: 'brief.pdf', url: download },
    { id: fileId, label: 'unrelated.pdf', url: download },
  ]) {
    const result = convert(xml, () => found);
    assert.deepEqual(result.content, raw(xml));
    assert.deepEqual(result.diagnostics.map(item => item.code), ['UNRESOLVED_CONFLUENCE_FILE_PREVIEW']);
  }
});
