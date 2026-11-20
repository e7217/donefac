import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegacyRecord, RichContent } from '../../shared/types.js';
import { contentReferences } from '../../shared/document-nodes.js';
import { normalizeDocumentContent } from '../../server/document-content.js';
import { convertLegacyContent, type MigrationContentContext, type MigrationContentResult, type MigrationReferenceInput } from '../../server/migration-content.js';

const source = (textFormat: LegacyRecord['textFormat'], text: string): LegacyRecord => ({ id: 'page:old-page', kind: 'page', sourceId: 'old-page', title: '합성 원본', containerId: 'old-space', parentId: null, authorId: null, createdAt: null, updatedAt: null, text, textFormat, metadata: {}, references: [] });
function resolver(calls: MigrationReferenceInput[] = []): MigrationContentContext {
  return { resolveReference: value => {
    calls.push(value);
    if (value.kind === 'page' && (value.sourceId === 'old-page-2' || value.title === 'Target' || value.url?.includes('pageId=200'))) return { id: 'doc-new', label: '이관 대상 문서' };
    if (value.kind === 'issue' && (value.sourceId === 'OLD-7' || value.url?.includes('/browse/OLD-7'))) return { id: 'issue-new', label: 'OLD-7 이관 업무' };
    if (value.kind === 'attachment' && (value.sourceId === 'media-1' || value.title === 'diagram.png')) return { id: 'attachment-new', label: 'diagram.png', url: '/api/attachments/attachment-new/content?inline=1' };
    if (value.kind === 'attachment' && value.title === 'report.pdf') return { id: 'attachment-pdf', label: 'report.pdf', url: '/api/attachments/attachment-pdf/content' };
    return null;
  } };
}
function nodes(content: RichContent, type: string): RichContent[] { const found: RichContent[] = [], stack = [content]; while (stack.length) { const node = stack.pop()!; if (node.type === type) found.push(node); for (let i = (node.content?.length || 0) - 1; i >= 0; i--) stack.push(node.content![i]); } return found; }
function canonical(result: MigrationContentResult) { assert.deepEqual(normalizeDocumentContent(result.content), { content: result.content, plainText: result.plainText }); assert.equal(result.diagnostics.some(value => value.severity === 'error'), false); }

test('plain text preserves line order, blank lines and literal HTML without executing or converting it', () => {
  const text = '첫 줄\r\n\r\n  <script>alert("literal")</script>  \n마지막😀';
  const result = convertLegacyContent(source('plain', text), resolver()); canonical(result);
  assert.equal(result.plainText, text.replaceAll('\r\n', '\n')); assert.equal(nodes(result.content, 'paragraph').length, 4); assert.equal(nodes(result.content, 'codeBlock').length, 0); assert.deepEqual(result.diagnostics, []);
  const empty = convertLegacyContent(source('none', ''), resolver()); canonical(empty); assert.equal(empty.plainText, '');
});

test('Confluence mixed inline order, core formatting, code CDATA, tables, tasks and expand become canonical editor blocks', () => {
  const code = '  const raw = "<&>";\r\nnext();\r trailing  ';
  const xml = `<h2>설계</h2><p>앞 <strong>굵게 <em>겹침</em></strong> 뒤 <u>밑줄</u> <span style="text-decoration: line-through;">취소</span><br/>끝&nbsp;&mdash;</p><blockquote><p>인용</p></blockquote><ul><li>하나<ul><li>안쪽</li></ul></li></ul><ol start="3"><li>셋</li></ol><table><tbody><tr><th colspan="2">머리</th></tr><tr><td>왼쪽</td><td>오른쪽</td></tr></tbody></table><ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>완료한 일</ac:task-body></ac:task></ac:task-list><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">javascript</ac:parameter><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">펼쳐 보기</ac:parameter><ac:rich-text-body><p>접힌 내용</p></ac:rich-text-body></ac:structured-macro>`;
  const result = convertLegacyContent(source('confluence-storage', xml), resolver()); canonical(result);
  assert.ok(result.plainText.includes('앞 굵게 겹침 뒤 밑줄 취소\n끝\u00a0—')); assert.equal(nodes(result.content, 'heading')[0].attrs?.level, 2);
  const overlap = nodes(result.content, 'text').find(value => value.text === '겹침')!; assert.deepEqual(overlap.marks?.map(value => value.type).sort(), ['bold', 'italic']);
  assert.equal(nodes(result.content, 'codeBlock')[0].content?.[0].text, code); assert.equal(nodes(result.content, 'codeBlock')[0].attrs?.language, 'javascript');
  assert.equal(nodes(result.content, 'tableHeader')[0].attrs?.colspan, 2); assert.equal(nodes(result.content, 'taskItem')[0].attrs?.checked, true);
  assert.equal(nodes(result.content, 'orderedList')[0].attrs?.start, 3); assert.equal(nodes(result.content, 'detailsSummary')[0].content?.[0].text, '펼쳐 보기'); assert.ok(result.plainText.includes('접힌 내용'));
});

test('Confluence references/includes and local images resolve through callbacks, keeping surrounding text and custom labels', () => {
  const calls: MigrationReferenceInput[] = [];
  const xml = '<p>먼저 <ac:link><ri:page ri:content-title="Target" ri:space-key="SYN"/><ac:plain-text-link-body><![CDATA[사용자 표시]]></ac:plain-text-link-body></ac:link> 다음</p><ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ri:page ri:content-id="old-page-2"/></ac:parameter></ac:structured-macro><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">OLD-7</ac:parameter></ac:structured-macro><ac:image ac:alt="설계 그림"><ri:attachment ri:filename="diagram.png"/></ac:image><p><ac:link><ri:attachment ri:filename="report.pdf"/><ac:plain-text-link-body>보고서</ac:plain-text-link-body></ac:link></p>';
  const result = convertLegacyContent(source('confluence-storage', xml), resolver(calls)); canonical(result);
  assert.deepEqual(contentReferences(result.content).map(value => [value.type, value.kind, value.id]), [['document', 'reference', 'doc-new'], ['document', 'include', 'doc-new'], ['issue', 'reference', 'issue-new']]);
  assert.equal(nodes(result.content, 'documentReference')[0].attrs?.label, '사용자 표시'); assert.match(result.plainText, /먼저[\s\S]*사용자 표시[\s\S]*다음/);
  assert.deepEqual(nodes(result.content, 'image')[0].attrs?.src, '/api/attachments/attachment-new/content?inline=1');
  assert.ok(nodes(result.content, 'text').some(value => value.marks?.some(mark => mark.type === 'link' && mark.attrs?.href === '/api/attachments/attachment-pdf/content')));
  assert.ok(calls.some(value => value.kind === 'page' && value.spaceKey === 'SYN'));
});

test('Confluence attachments carry the declared owner to link and image resolution', () => {
  const calls: MigrationReferenceInput[] = [];
  const context: MigrationContentContext = { resolveReference: input => {
    calls.push(input);
    if (input.attachmentOwner?.title === '공유 문서' && input.attachmentOwner.spaceKey === 'DOC') {
      return { id: 'remote-report', label: 'report.pdf', url: '/api/attachments/remote-report/content' };
    }
    if (input.attachmentOwner?.sourceId === '123') {
      return { id: 'remote-diagram', label: 'diagram.png', url: '/api/attachments/remote-diagram/content?inline=1' };
    }
    return null;
  } };
  const xml = `<p><ac:link><ri:attachment ri:filename="report.pdf"><ri:page ri:content-title="공유 문서" ri:space-key="DOC"/></ri:attachment><ac:plain-text-link-body>공유 보고서</ac:plain-text-link-body></ac:link></p>
    <ac:image ac:alt="공유 그림"><ri:attachment ri:filename="diagram.png" ri:content-id="987"><ri:content-entity ri:content-id="123"/></ri:attachment></ac:image>
    <ac:image><ri:attachment ri:filename="unknown.png"><ri:blog-post ri:content-title="블로그"/></ri:attachment></ac:image>`;
  const result = convertLegacyContent(source('confluence-storage', xml), context);
  canonical(result);
  const [report, diagram, unknown] = calls;
  assert.equal(calls.length, 3);
  assert.equal(report.attachmentOwner?.title, '공유 문서');
  assert.equal(report.attachmentOwner.spaceKey, 'DOC');
  assert.equal(diagram.sourceId, '987');
  assert.deepEqual(diagram.attachmentOwner, { sourceId: '123' });
  assert.equal(unknown.attachmentOwner, null);
  const label = nodes(result.content, 'text').find(node => node.text === '공유 보고서');
  assert.equal(label?.marks?.[0].attrs?.href, '/api/attachments/remote-report/content');
  assert.deepEqual(nodes(result.content, 'image').map(node => node.attrs?.src), ['/api/attachments/remote-diagram/content?inline=1']);
  assert.match(result.plainText, /unknown\.png/);
  assert.ok(result.diagnostics.some(notice => notice.code === 'UNRESOLVED_IMAGE'));
});

test('unsupported macros, script/HTML, unresolved references and unsafe URLs stay visible with diagnostics and no active unsafe nodes', () => {
  const xml = '<p><a href="javascript:alert(1)">위험 링크</a></p><script>dangerous()</script><ac:structured-macro ac:name="unknown-widget"><ac:parameter ac:name="value">보존해야 할 값</ac:parameter><ac:rich-text-body><p>미지원 본문</p></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="excerpt-include"><ac:parameter ac:name="">Target</ac:parameter></ac:structured-macro><ac:image><ri:url ri:value="https://example.test/remote.png"/></ac:image><ac:link><ri:page ri:content-title="Missing"/></ac:link>';
  const result = convertLegacyContent(source('confluence-storage', xml), resolver()); canonical(result);
  for (const value of ['javascript:alert(1)', 'dangerous()', '보존해야 할 값', '미지원 본문', 'excerpt-include', 'https://example.test/remote.png', 'Missing']) assert.ok(result.plainText.includes(value), value);
  assert.equal(nodes(result.content, 'image').length, 0); assert.equal(nodes(result.content, 'documentInclude').length, 0);
  assert.ok(result.diagnostics.some(value => value.code === 'UNSAFE_URL')); assert.ok(result.diagnostics.some(value => value.code === 'UNSUPPORTED_MACRO')); assert.ok(result.diagnostics.some(value => value.code === 'REMOTE_IMAGE_NOT_EMBEDDED')); assert.ok(result.diagnostics.some(value => value.code === 'UNRESOLVED_REFERENCE'));
  assert.ok(!nodes(result.content, 'text').some(node => node.marks?.some(mark => mark.type === 'link' && String(mark.attrs?.href).startsWith('javascript:'))));
});

test('malformed storage, XXE/DOCTYPE, unknown HTML entities and invalid ADF fall back to the complete inert original', () => {
  const inputs: [LegacyRecord['textFormat'], string][] = [['confluence-storage', '<p>unclosed'], ['confluence-storage', '<!DOCTYPE p [<!ENTITY x SYSTEM "http://127.0.0.1:9/never">]><p>&x;</p>'], ['confluence-storage', '<p>&unrecognized;</p>'], ['adf', '{bad json'], ['adf', JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: 'MALFORMED_BUT_PRESERVED' }] })]];
  for (const [format, raw] of inputs) { const result = convertLegacyContent(source(format, raw), resolver()); canonical(result); assert.equal(nodes(result.content, 'codeBlock')[0].content?.[0].text, raw); assert.ok(result.diagnostics.some(value => value.code === 'RAW_CONTENT_FALLBACK')); }
});

test('ADF preserves core blocks and marks, local media, task/expand nodes and safe links while retaining unknown extension JSON', () => {
  const raw = { type: 'doc', version: 1, content: [
    { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: '제목' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '강조', marks: [{ type: 'strong' }, { type: 'em' }] }, { type: 'hardBreak' }, { type: 'text', text: '링크', marks: [{ type: 'link', attrs: { href: 'https://example.test/path' } }] }] },
    { type: 'orderedList', attrs: { order: 4 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '목록' }] }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '셀' }] }] }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: '작업' }] }] },
    { type: 'expand', attrs: { title: '상세' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '상세 내용' }] }] },
    { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print("hi")\n' }] },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'media-1', type: 'file', alt: '그림' } }] },
    { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://legacy.test/browse/OLD-7' } }] },
    { type: 'extension', attrs: { extensionKey: 'vendor:unknown', parameters: { value: '확장 원문 값' } } },
  ] };
  const result = convertLegacyContent(source('adf', JSON.stringify(raw)), resolver()); canonical(result);
  assert.equal(nodes(result.content, 'heading')[0].attrs?.level, 3); assert.equal(nodes(result.content, 'orderedList')[0].attrs?.start, 4); assert.equal(nodes(result.content, 'taskItem')[0].attrs?.checked, true); assert.equal(nodes(result.content, 'tableHeader')[0].attrs?.colspan, 2);
  assert.equal(nodes(result.content, 'detailsSummary')[0].content?.[0].text, '상세'); assert.equal(nodes(result.content, 'codeBlock')[0].attrs?.language, 'python'); assert.equal(nodes(result.content, 'image').length, 1); assert.equal(nodes(result.content, 'issueReference').length, 1);
  assert.ok(result.plainText.includes('확장 원문 값')); assert.ok(result.diagnostics.some(value => value.code === 'UNSUPPORTED_CONTENT')); assert.ok(result.diagnostics.some(value => value.code === 'HEADING_LEVEL_NORMALIZED'));
});

test('Jira wiki converts nested lists, task lists, headings, table link pipes, marks, code, quotes, expand, references and images', () => {
  const wiki = 'h1. 위키 제목\n\n앞 *굵게 _겹침_* 뒤 +밑줄+ -취소- {{코드}}\n이어쓰기\\\\끝\n\n* 첫째\n** 안쪽\n* 둘째\n\n# 순서\n\n* [x] 완료\n* [ ] 미완료\n\n||제목||링크||\n|값|[사이트|https://example.test/a]|\n\nbq. 인용\n\n{code:javascript}\nconst x = "<&>";\n{code}\n\n{expand:추가 내용}\n내용\n{expand}\n\n[OLD-7]\n{include:SYN:Target}\n!diagram.png!\n[^report.pdf]';
  const result = convertLegacyContent(source('jira-wiki', wiki), resolver()); canonical(result);
  assert.equal(nodes(result.content, 'heading')[0].attrs?.level, 1); assert.equal(nodes(result.content, 'bulletList').length, 2); assert.equal(nodes(result.content, 'orderedList').length, 1); assert.deepEqual(nodes(result.content, 'taskItem').map(value => value.attrs?.checked), [true, false]);
  assert.equal(nodes(result.content, 'tableRow').length, 2); assert.equal(nodes(result.content, 'tableCell').length, 2); assert.equal(nodes(result.content, 'tableHeader').length, 2);
  assert.equal(nodes(result.content, 'codeBlock')[0].content?.[0].text, 'const x = "<&>";'); assert.equal(nodes(result.content, 'details').length, 1); assert.equal(nodes(result.content, 'issueReference').length, 1); assert.equal(nodes(result.content, 'documentInclude').length, 1); assert.equal(nodes(result.content, 'image').length, 1);
  assert.ok(nodes(result.content, 'text').some(value => value.text === '겹침' && value.marks?.length === 2)); assert.ok(result.plainText.includes('이어쓰기\n끝'));
});

test('Jira unknown or unterminated macros preserve readable raw content and malicious URLs or remote images remain inert', () => {
  const wiki = '[unsafe|javascript:alert(1)]\n!https://example.test/no-fetch.png!\n[MissingPage]\n\n{unknown:vendor}\n원본 내용을 유지 *중요*\n{unknown}\n\n{code}\n닫히지 않은 원본';
  const result = convertLegacyContent(source('jira-wiki', wiki), resolver()); canonical(result);
  for (const value of ['javascript:alert(1)', 'https://example.test/no-fetch.png', 'MissingPage', '{unknown:vendor}', '원본 내용을 유지 *중요*', '닫히지 않은 원본']) assert.ok(result.plainText.includes(value), value);
  assert.equal(nodes(result.content, 'image').length, 0); assert.ok(result.diagnostics.some(value => value.code === 'UNSAFE_URL')); assert.ok(result.diagnostics.some(value => value.code === 'UNTERMINATED_WIKI_BLOCK'));
});

test('conversion bounds block oversize/deep/node-heavy content explicitly and never return a silently truncated success', () => {
  for (const record of [source('plain', 'x'.repeat(17 * 1024 * 1024)), source('plain', Array.from({ length: 16000 }, () => 'x').join('\n')), source('plain', 'x'.repeat(8 * 1024 * 1024))]) {
    const result = convertLegacyContent(record, resolver()); assert.ok(result.diagnostics.some(value => value.severity === 'error' && value.code === 'CONVERSION_LIMIT_EXCEEDED')); assert.ok(result.plainText.includes('적용하지 않았습니다')); assert.doesNotThrow(() => normalizeDocumentContent(result.content));
  }
  let deep: object = { type: 'paragraph', content: [{ type: 'text', text: '보존 자료에만 남은 심층 원문' }] };
  for (let index = 0; index < 70; index++) deep = { type: 'blockquote', content: [deep] };
  const result = convertLegacyContent(source('adf', JSON.stringify({ type: 'doc', version: 1, content: [deep] })), resolver()); assert.ok(result.diagnostics.some(value => value.severity === 'error')); assert.ok(result.plainText.includes('적용하지 않았습니다'));
});

test('invalid or failing reference mappings block application rather than creating dangling or executable targets', () => {
  const record = source('jira-wiki', '[OLD-7]');
  for (const context of [{ resolveReference: () => ({ id: '', label: '잘못된 ID' }) }, { resolveReference: () => { throw new Error('mapping failed'); } }]) {
    const result = convertLegacyContent(record, context); assert.ok(result.diagnostics.some(value => value.severity === 'error')); assert.equal(contentReferences(result.content).length, 0); assert.doesNotThrow(() => normalizeDocumentContent(result.content));
  }
});

test('pretty-print XML whitespace does not manufacture paragraphs, and malformed nested wiki paths keep every item', () => {
  const result = convertLegacyContent(source('confluence-storage', '\n<p>첫째</p>\n  <p>앞 <strong>강조</strong> <em>뒤</em></p>\n<blockquote>\n<p>인용</p>\n</blockquote>\n'), resolver()); canonical(result);
  assert.equal(result.plainText, '첫째\n앞 강조 뒤\n인용'); assert.equal(nodes(result.content, 'paragraph').length, 3);
  const oddList = convertLegacyContent(source('jira-wiki', '* root\n*# branch\n*** odd\n* final\n\nBefore {vendor:unknown} after'), resolver()); canonical(oddList);
  for (const word of ['root', 'branch', 'odd', 'final', 'Before', '{vendor:unknown}', 'after']) assert.ok(oddList.plainText.includes(word));
  assert.ok(oddList.diagnostics.some(value => value.code === 'LIST_DEPTH_NORMALIZED')); assert.equal(nodes(oddList.content, 'codeBlock')[0].content?.[0].text, '{vendor:unknown}');
});
