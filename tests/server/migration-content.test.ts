import assert from 'node:assert/strict';
import test from 'node:test';
import { TableMap } from '@tiptap/pm/tables';
import type { LegacyRecord, RichContent } from '../../shared/types.js';
import { contentReferences, MAX_CALLOUT_TITLE_LENGTH, MAX_STATUS_BADGE_LABEL_LENGTH } from '../../shared/document-nodes.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import { locateDocumentSelection } from '../../shared/document-selection-highlight.js';
import { createEditorSchema } from '../../shared/editor-schema.js';
import { normalizeDocumentContent, readDocumentSelection } from '../../server/document-content.js';
import { convertLegacyContent, extractJiraOriginalCommentLinks, hasConfluenceEngineeringEntity, MAX_JIRA_ORIGINAL_COMMENT_LINKS, type MigrationContentContext, type MigrationContentResult, type MigrationReferenceInput } from '../../server/migration-content.js';

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

const jiraComment = (textFormat: LegacyRecord['textFormat'], text: string, metadata: LegacyRecord['metadata'] = {}): LegacyRecord => ({
  ...source(textFormat, text), id: 'comment:old', sourceId: 'old', kind: 'comment', metadata,
});

test('archived Jira wiki links retain the first original label and exact destinations in source order', () => {
  const report = 'https://ci.example.test/run?build=1.';
  const jira = 'https://jira.example.test/browse/OLD-7';
  const bare = 'https://gitlab.example.test/team/repo/-/merge_requests/2';
  const record = jiraComment('jira-wiki', [
    `원본 링크 ${bare}.`,
    `[CI 보고서|${report}] [기존 업무|${jira}] [나중에 같은 주소|${report}]`,
    '[권한 주소|https://demo:fake@private.example.test/path] [https://not-the-destination.example.test|javascript:alert(1)]',
    '{noformat}', '[예시|https://example.test/code]', '{noformat}',
  ].join('\n'));
  const original = structuredClone(record);
  assert.deepEqual(extractJiraOriginalCommentLinks(record), {
    links: [{ label: bare, href: bare }, { label: 'CI 보고서', href: report }, { label: '기존 업무', href: jira }], limited: false,
  });
  assert.deepEqual(record, original);
});

test('archived Jira ADF merges adjacent marks and never falls back to scanning raw JSON', () => {
  const preview = 'https://ci.example.test/report';
  const card = 'https://wiki.example.test/wiki/x/y';
  const bare = 'https://ci.example.test/artifacts/42';
  const marked = (label: string, href: string, extraMarks: { type: string }[] = []) => ({
    type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }, ...extraMarks],
  });
  const record = jiraComment('adf', JSON.stringify({ type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [marked('배포', preview, [{ type: 'strong' }]), marked(' 결과', preview),
      marked(' 주소', 'https://unsafe\u202e.example.test/link')] },
    { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: card } }] },
    { type: 'paragraph', content: [{ type: 'text', text: '주소 https://ci.example.test/' },
      { type: 'text', text: 'artifacts/42.', marks: [{ type: 'strong' }] }] },
    { type: 'paragraph', content: [marked('역방향\u202e레이블', 'https://example.test/neutral')] },
  ] }));
  assert.deepEqual(extractJiraOriginalCommentLinks(record), {
    links: [{ label: '배포 결과', href: preview }, { label: card, href: card }, { label: bare, href: bare },
      { label: 'https://example.test/neutral', href: 'https://example.test/neutral' }], limited: false,
  });
  assert.deepEqual(extractJiraOriginalCommentLinks({ ...record, text: record.text.slice(0, -1) }), { links: [], limited: true });
});

test('archived Jira search XML only reads links from supported rendered HTML', () => {
  const html = '<p><a href="https://wiki.example.test/pages/viewpage.action?pageId=200&amp;ref=release"><code>절차</code></a></p>';
  const metadata = { bodyFormat: 'search-rendered-html' };
  assert.deepEqual(extractJiraOriginalCommentLinks(jiraComment('plain', html, metadata)), {
    links: [{ label: '절차', href: 'https://wiki.example.test/pages/viewpage.action?pageId=200&ref=release' }], limited: false,
  });
  for (const invalid of [`<script>${html}</script>`, html.slice(0, -4), `<!DOCTYPE unsafe>${html}`]) {
    assert.deepEqual(extractJiraOriginalCommentLinks(jiraComment('plain', invalid, metadata)), { links: [], limited: true });
  }
});

test('literal Jira comment links respect URL and count limits without reading oversized source text', () => {
  const literal = 'https://example.test/releases.';
  const short = 'http://example.test/view';
  const sourceText = `<${literal}> 확인, ${short}. 다시 <${literal}> 와 https://id:secret@example.test/private`;
  assert.deepEqual(extractJiraOriginalCommentLinks(jiraComment('plain', sourceText)), {
    links: [{ label: literal, href: literal }, { label: short, href: short }], limited: false,
  });
  const addresses = Array.from({ length: MAX_JIRA_ORIGINAL_COMMENT_LINKS + 2 }, (_, index) => `https://example.test/item/${index}`);
  const limited = extractJiraOriginalCommentLinks(jiraComment('plain', addresses.join('\n')));
  assert.deepEqual(limited, { links: addresses.slice(0, MAX_JIRA_ORIGINAL_COMMENT_LINKS).map(href => ({ label: href, href })), limited: true });
  const longUrl = `https://example.test/${'x'.repeat(2048)}`;
  assert.deepEqual(extractJiraOriginalCommentLinks(jiraComment('plain', `<${longUrl}> ${short}`)), {
    links: [{ label: short, href: short }], limited: true,
  });
  assert.deepEqual(extractJiraOriginalCommentLinks(jiraComment('plain', `${short} ${'가'.repeat(100_000)}`)), { links: [], limited: true });
});

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

test('Confluence engineering character references keep ordinary page and revision content editable', () => {
  const literal = '<!-- &minus; --><ac:structured-macro ac:name="code">' +
    '<ac:plain-text-body><![CDATA[raw = "&times; &sup2; &bogus;";]]></ac:plain-text-body></ac:structured-macro>';
  const fixture = '<h2>Installation</h2><p><strong>Dimension</strong> 50 &times; 20 mm &plusmn; 1 mm at 25 &deg;C.' +
    ' Area 10 cm&sup2;; current &le; 50 &micro;A; resistance 20 &Omega;; &frac12; turn.</p>' +
    '<ul><li>Step 1 &rarr; Step 2 &amp; literal &amp;times;</li></ul>' + literal;
  for (const kind of ['page', 'revision'] as const) {
    const result = convertLegacyContent({ ...source('confluence-storage', fixture), kind }, resolver());
    canonical(result);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.content.content?.map(block => block.type), ['heading', 'paragraph', 'bulletList', 'codeBlock']);
    assert.match(result.plainText, /50 × 20 mm ± 1 mm at 25 °C\. Area 10 cm²; current ≤ 50 µA; resistance 20 Ω; ½ turn\./u);
    assert.match(result.plainText, /Step 1 → Step 2 & literal &times;/u);
    assert.deepEqual(nodes(result.content, 'text').find(node => node.text === 'Dimension')?.marks, [{ type: 'bold' }]);
    assert.equal(nodes(result.content, 'codeBlock')[0].content?.[0].text, 'raw = "&times; &sup2; &bogus;";');
  }
  assert.equal(hasConfluenceEngineeringEntity(fixture), true);
  assert.equal(hasConfluenceEngineeringEntity(`${literal}<p>&amp;times; &nbsp;</p>`), false);
});

test('Confluence table column declarations become native widths across merged cells and saved revisions', () => {
  const fixture = `<table class="wrapped">
    <colgroup><col style="width: 160.4px;"/><col/><col width="320"/></colgroup>
    <thead><tr><th colspan="2">Version</th><th>Notes</th></tr></thead>
    <tbody><tr><td rowspan="2">1.2</td><td>A</td><td>Release A</td></tr>
    <tr><td colspan="2">Release B</td></tr></tbody>
  </table><table><colgroup><col span="2"/></colgroup><tr><td>Left</td><td>Right</td></tr></table>`;
  const schema = createEditorSchema();
  for (const kind of ['page', 'revision'] as const) {
    const result = convertLegacyContent({ ...source('confluence-storage', fixture), kind }, resolver());
    canonical(result);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.content.content?.map(node => node.type), ['table', 'table']);
    assert.equal(result.plainText, 'Version\tNotes\n1.2\tA\tRelease A\nRelease B\nLeft\tRight');
    const [fixed, flexible] = nodes(result.content, 'table');
    const widths = (table: RichContent) => table.content?.map(row => row.content?.map(cell => cell.attrs?.colwidth));
    assert.deepEqual(widths(fixed), [[[160, 0], [320]], [[160], null, [320]], [[0, 320]]]);
    assert.deepEqual(widths(flexible), [[null, null]]);
    assert.equal(TableMap.get(schema.nodeFromJSON(fixed)).problems, null);
  }
});

test('unsupported or unmatched column declarations remain inert without assigning partial widths', () => {
  const tables = [
    '<table><colgroup><col style="width: 40%;"/><col width="155"/></colgroup><tr><td>One</td><td>Two</td></tr></table>',
    '<table><colgroup><col style="width: 155px; background-image: url(example.test);"/></colgroup><tr><td>One</td></tr></table>',
    '<table><colgroup><col style="width: 155px;"/></colgroup><tr><td>One</td><td>Two</td></tr></table>',
  ];
  for (const fixture of tables) {
    const result = convertLegacyContent(source('confluence-storage', fixture), resolver());
    canonical(result);
    assert.deepEqual(result.content.content?.map(node => node.type), ['codeBlock', 'table']);
    assert.match(result.plainText, /\[XML colgroup\]/u);
    assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_CONTENT'));
    assert.ok(nodes(result.content, 'tableCell').every(cell => cell.attrs?.colwidth === null));
  }
});

const storageTask = (id: number, checked: boolean, body: string) => `<ac:task><ac:task-id>${id}</ac:task-id>` +
  `<ac:task-status>${checked ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>${body}</ac:task-body></ac:task>`;

test('Confluence inline comment markers preserve body text, inline marks and links in their original blocks', () => {
  const marked = '<ac:inline-comment-marker ac:ref="source-comment-selection-17">' +
    '<strong>검토한 <em>결정</em></strong><ac:inline-comment-marker ac:ref="overlap-7"> 항목</ac:inline-comment-marker>' +
    '</ac:inline-comment-marker>';
  const xml = `<h2>릴리스 검토</h2><p>이번에 ${marked} 뒤쪽을 확인합니다.</p>` +
    '<table><tr><td><ac:inline-comment-marker ac:ref="cell-1">' +
    '<a href="https://example.test/guide">검토 지침</a></ac:inline-comment-marker> <em>참조</em></td></tr></table>';
  for (const kind of ['page', 'revision'] as const) {
    const record = { ...source('confluence-storage', xml), kind };
    const result = convertLegacyContent(record, { ...resolver(), sectionLinks: { documentId: 'local-doc' } });
    canonical(result);
    assert.deepEqual(result.content.content?.map(node => node.type), ['heading', 'paragraph', 'table']);
    assert.ok(result.sectionTargets?.get('릴리스 검토'));
    assert.match(result.plainText, /이번에 검토한 결정 항목 뒤쪽을 확인합니다\./u);
    assert.match(result.plainText, /검토 지침 참조/u);
    assert.doesNotMatch(result.plainText, /ac:inline-comment-marker|source-comment-selection-17/u);
    const leaves = nodes(result.content, 'text');
    assert.deepEqual(leaves.find(node => node.text === '결정')?.marks?.map(mark => mark.type).sort(), ['bold', 'italic']);
    assert.equal(leaves.find(node => node.text === '검토 지침')?.marks?.find(mark => mark.type === 'link')?.attrs?.href, 'https://example.test/guide');
    assert.equal(result.diagnostics.filter(item => item.code === 'INLINE_COMMENT_ANCHOR_ARCHIVED').length, 1);
    assert.equal(record.text, xml);
  }
});

test('Confluence marker positions survive adjacent text merges, nested formatting and table nesting', () => {
  const marker = (ref: string, content: string) => `<ac:inline-comment-marker ac:ref="${ref}">${content}</ac:inline-comment-marker>`;
  const word = '배포 승인 🧪';
  const prefix = `${word}와 `;
  const xml = `<p>${prefix}${marker('repeat', word)} 뒤</p><table><tr><td><p>` +
    `${marker('cell', `<strong>이관 ${marker('nested', '<em>확인</em>')}</strong><br/>또 확인`)}</p></td></tr></table>`;
  const input = source('confluence-storage', xml);
  const result = convertLegacyContent(input, { ...resolver(), captureInlineCommentAnchors: true });
  canonical(result);
  assert.deepEqual(result.content, convertLegacyContent(input, resolver()).content);
  const anchors = result.inlineCommentAnchors!;
  assert.deepEqual(anchors.get('repeat'), { from: 1 + prefix.length, to: 1 + prefix.length + word.length, text: word });
  assert.equal(anchors.get('cell')?.text, '이관 확인\n또 확인');
  assert.equal(anchors.get('nested')?.text, '확인');
  for (const { from, to, text } of anchors.values()) assert.equal(readDocumentSelection(result.content, from, to), text);
  assert.deepEqual([...locateDocumentSelection(result.content, anchors.get('repeat')!)!.marks.values()],
    [{ kind: 'text', from: prefix.length, to: prefix.length + word.length }]);
});

test('Confluence marker positions omit duplicates, including a marker projected inside a code block, and unsupported selections', () => {
  const marker = (ref: string, content: string) => `<ac:inline-comment-marker ac:ref="${ref}">${content}</ac:inline-comment-marker>`;
  const xml = `<p>${marker('dup', '이곳')} ${marker('kept', '한 군데')}</p>` +
    `<pre>${marker('dup', '중복 위치')}</pre><p>${marker('space', ' ')}</p>` +
    `<p>${marker('long', '긴'.repeat(2001))}</p>${marker('block', '<p>블록 전체</p>')}`;
  const result = convertLegacyContent(source('confluence-storage', xml), { ...resolver(), captureInlineCommentAnchors: true });
  canonical(result);
  assert.deepEqual([...result.inlineCommentAnchors!.keys()], ['kept']);
  assert.match(result.plainText, /중복 위치/u);
  assert.match(result.plainText, /블록 전체/u);
});

test('Confluence checklist assignees and valid dates stay readable inside editable task items', () => {
  const xml = '<h2>배포 절차</h2><p>체크리스트 바로 앞 설명</p><ac:task-list>' +
    storageTask(1, false, '<ac:link><ri:user ri:userkey="release-reviewer-key"/></ac:link> ' +
      '<strong>배포 결과 확인</strong> 기한 <time datetime="2026-11-28"/> 이후 점검') +
    storageTask(2, true, '확인 시작: <ri:user ri:username="qa-reviewer"/> ' +
      '<ac:link><ri:user ri:userkey="historical-account"/><ac:link-body><em>원문에서 표시한 담당자</em></ac:link-body></ac:link> ' +
      '<time datetime="2024-02-29">2월 마지막 날</time> 작업 종료') +
    '</ac:task-list><p>체크리스트 바로 뒤 설명</p>';
  for (const kind of ['page', 'revision'] as const) {
    const result = convertLegacyContent({ ...source('confluence-storage', xml), kind }, resolver());
    canonical(result);
    assert.deepEqual(result.content.content?.map(node => node.type), ['heading', 'paragraph', 'taskList', 'paragraph']);
    const items = nodes(result.content, 'taskItem');
    assert.deepEqual(items.map(item => item.attrs?.checked), [false, true]);
    for (const item of items) assert.equal(item.content?.[0].type, 'paragraph');
    const inlineText = (item: RichContent) => nodes(item, 'text').map(node => node.text).join('');
    assert.match(inlineText(items[0]), /release-reviewer-key.*배포 결과 확인.*2026-11-28.*이후 점검/u);
    assert.match(inlineText(items[1]), /확인 시작.*qa-reviewer.*작업 종료/u);
    for (const text of ['원문에서 표시한 담당자', '2월 마지막 날', '2024-02-29']) assert.ok(inlineText(items[1]).includes(text), text);
    assert.equal(nodes(items[0], 'text').find(node => node.text === '배포 결과 확인')?.marks?.[0].type, 'bold');
    assert.equal(nodes(items[1], 'text').find(node => node.text === '원문에서 표시한 담당자')?.marks?.[0].type, 'italic');
    assert.equal(nodes(result.content, 'codeBlock').length, 0);
    assert.ok(!nodes(result.content, 'text').some(node => node.marks?.some(mark => mark.type === 'link')));
    assert.ok(!result.diagnostics.some(diagnostic => diagnostic.code === 'RAW_CONTENT_FALLBACK'));
  }
});

test('unsupported Confluence task content and missing identity or date attributes retain local source evidence', () => {
  const xml = '<h2>다른 제목은 편집 가능</h2><ac:task-list>' +
    storageTask(1, false, '<vendor:unknown-assignment code="source-extension">확인할 확장 원문</vendor:unknown-assignment>' +
      '<p>지원하지 않는 구조 뒤의 설명</p>') +
    storageTask(2, true, '앞 내용 <ac:link><ri:user/><ac:link-body>계정 키가 없는 원문 담당자</ac:link-body></ac:link> ' +
      '<time>날짜 속성이 없는 원문</time> <time datetime="2026-02-30">달력 범위 오류 원문</time> 뒤 내용') +
    '</ac:task-list><p>별도로 저장할 문단</p>';
  const result = convertLegacyContent(source('confluence-storage', xml), resolver());
  canonical(result);
  assert.deepEqual(result.content.content?.map(node => node.type), ['heading', 'taskList', 'paragraph']);
  const items = nodes(result.content, 'taskItem');
  assert.deepEqual(items.map(item => item.attrs?.checked), [false, true]);
  assert.equal(items[0].content?.[0].type, 'paragraph');
  const fallback = nodes(items[0], 'codeBlock').map(node => node.content?.[0]?.text).join('');
  assert.match(fallback, /source-extension[\s\S]*확인할 확장 원문/u);
  assert.match(result.plainText.replaceAll('\n', ' '), /앞 내용.*계정 키가 없는 원문 담당자.*날짜 속성이 없는 원문.*달력 범위 오류 원문.*뒤 내용/u);
  assert.ok(result.plainText.includes('2026-02-30'));
  for (const text of ['다른 제목은 편집 가능', '지원하지 않는 구조 뒤의 설명', '별도로 저장할 문단']) assert.ok(result.plainText.includes(text), text);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.severity === 'warning'));
  assert.ok(!result.diagnostics.some(diagnostic => diagnostic.code === 'RAW_CONTENT_FALLBACK'));
});

test('unsupported Confluence checklist siblings keep adjacent task runs editable in their original order', () => {
  const xml = '<p>체크리스트 앞 문단</p><ac:task-list>\n' + storageTask(1, false, '지원하는 첫 번째 업무') +
    '<vendor:task-set label="source-list-note">형식이 다른 목록 항목</vendor:task-set>' +
    storageTask(2, true, '지원하는 두 번째 업무') + '\n</ac:task-list><p>체크리스트 뒤 문단</p>';
  const result = convertLegacyContent(source('confluence-storage', xml), resolver());
  canonical(result);
  assert.deepEqual(result.content.content?.map(node => node.type), ['paragraph', 'taskList', 'codeBlock', 'taskList', 'paragraph']);
  assert.deepEqual(nodes(result.content, 'taskItem').map(item => item.attrs?.checked), [false, true]);
  assert.match(result.plainText.replaceAll('\n', ' '), /체크리스트 앞 문단.*지원하는 첫 번째 업무.*source-list-note.*형식이 다른 목록 항목.*지원하는 두 번째 업무.*체크리스트 뒤 문단/u);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.severity === 'warning'));
  assert.ok(!result.diagnostics.some(diagnostic => diagnostic.code === 'RAW_CONTENT_FALLBACK'));
});

test('Confluence section links preserve proven case-sensitive anchors and degrade ambiguous or unavailable targets', () => {
  const marker = (name: string) => `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">${name}</ac:parameter></ac:structured-macro>`;
  const link = (name: string, label: string) => `<p><ac:link ac:anchor="${name}"><ac:link-body><strong>${label}</strong></ac:link-body></ac:link></p>`;
  const xml = [
    link('deploy', 'Named'), '<p><a href="#ReleaseNotes">Title</a></p>',
    link('duplicate', 'Ambiguous'), link('DEPLOY', 'Unknown'), link('raw-id', 'Literal ID'),
    `<p>${marker('deploy')}</p><h2>Deploy guide</h2><h2>Release Notes</h2><h3 id="raw-id">Literal</h3>`,
    `${marker('duplicate')}<h2>First</h2><p>Unrelated</p>${marker('duplicate')}`,
    '<h2>ab c</h2><h2>a bc</h2>',
  ].join('');
  const context = { ...resolver(), sectionLinks: { documentId: 'doc-self' } };
  const convert = (text: string) => convertLegacyContent(source('confluence-storage', text), context);
  const result = convert(xml);
  canonical(result);
  const href = (label: string) => nodes(result.content, 'text').find(node => node.text === label)?.marks?.find(mark => mark.type === 'link')?.attrs?.href;
  const targets = result.sectionTargets!;
  for (const [label, alias] of [['Named', 'deploy'], ['Title', 'ReleaseNotes'], ['Literal ID', 'raw-id']]) {
    assert.ok(targets.get(alias));
    assert.equal(href(label), documentSectionHash('doc-self', targets.get(alias)!));
  }
  assert.equal(nodes(result.content, 'text').find(node => node.text === 'Named')?.marks?.some(mark => mark.type === 'bold'), true);
  assert.equal(targets.get('abc'), undefined);
  assert.notEqual(targets.get('ab c'), targets.get('a bc'));
  assert.ok(result.plainText.includes('Ambiguous (#duplicate)'));
  assert.ok(result.plainText.includes('Unknown (#DEPLOY)'));
  assert.equal(result.diagnostics.some(item => item.code === 'SECTION_LINK_UNRESOLVED'), true);
  assert.equal(convert(xml.replace('Deploy guide', 'Renamed guide')).sectionTargets?.get('deploy'), targets.get('deploy'));
});

test('Confluence page and revision tables of contents become editable blocks with supported heading ranges and layouts', () => {
  const toc = '<ac:structured-macro ac:name="toc" ac:macro-id="synthetic-toc"/>';
  const flat = '<ac:macro ac:name="toc"><ac:parameter ac:name="type">flat</ac:parameter><ac:parameter ac:name="minLevel">2</ac:parameter><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="separator">brackets</ac:parameter></ac:macro>';
  const xml = `${toc}<h1>팀 설계</h1><p>안내 ${flat} 끝</p><h2>설치</h2><h3>확인</h3>`;
  const result = convertLegacyContent(source('confluence-storage', xml), resolver());
  canonical(result);
  assert.deepEqual(result.content.content?.map(node => node.type), ['documentToc', 'heading', 'paragraph', 'documentToc', 'paragraph', 'heading', 'heading']);
  assert.deepEqual(nodes(result.content, 'documentToc').map(node => ({ ...node.attrs })), [
    { minLevel: 1, maxLevel: 6, layout: 'list' }, { minLevel: 2, maxLevel: 3, layout: 'flat' },
  ]);
  assert.deepEqual(result.diagnostics, []);
  const revision = convertLegacyContent({ ...source('confluence-storage', xml), kind: 'revision' }, resolver());
  assert.deepEqual(revision, result);
  const comment = convertLegacyContent({ ...source('confluence-storage', toc), kind: 'comment' }, resolver());
  assert.equal(nodes(comment.content, 'documentToc').length, 0);
  assert.equal(comment.diagnostics[0]?.code, 'UNSUPPORTED_MACRO');

  const deepRange = '<ac:macro ac:name="toc"><ac:parameter ac:name="minLevel">4</ac:parameter><ac:parameter ac:name="maxLevel">6</ac:parameter></ac:macro>';
  const bounded = '<ac:macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:macro>';
  const deepXml = `${toc}${deepRange}${bounded}<h4 id="deep">깊은 제목</h4><h5>하위 소제목</h5><h6>가장 깊은 제목</h6>`;
  const context = { ...resolver(), sectionLinks: { documentId: 'doc-deep' } };
  const deep = convertLegacyContent(source('confluence-storage', deepXml), context);
  canonical(deep);
  assert.deepEqual(nodes(deep.content, 'documentToc').map(node => ({ ...node.attrs })), [
    { minLevel: 1, maxLevel: 6, layout: 'list' }, { minLevel: 4, maxLevel: 6, layout: 'list' },
    { minLevel: 1, maxLevel: 3, layout: 'list' },
  ]);
  assert.deepEqual(nodes(deep.content, 'heading').map(node => node.attrs?.level), [4, 5, 6]);
  assert.equal(nodes(deep.content, 'heading')[0].attrs?.sectionId, deep.sectionTargets?.get('deep'));
  assert.ok(deep.sectionTargets?.get('deep'));
  assert.deepEqual(deep.diagnostics, []);
  assert.deepEqual(convertLegacyContent({ ...source('confluence-storage', deepXml), kind: 'revision' }, context), deep);
  const legacy = convertLegacyContent(source('confluence-storage', deepXml), { ...context, legacyDocumentHeadingLevels: true });
  assert.deepEqual(nodes(legacy.content, 'heading').map(node => node.attrs?.level), [3, 3, 3]);
  assert.deepEqual(nodes(legacy.content, 'codeBlock').map(node => node.content?.[0].text), [deepRange, bounded]);
});

test('Confluence table of contents preserves unsupported and malformed settings as inert XML', () => {
  for (const [body, extra] of [
    ['<ac:parameter ac:name="include">^(a+)+$</ac:parameter>', ''],
    ['<ac:parameter ac:name="exclude"> </ac:parameter>', ''],
    ['<ac:parameter ac:name="type">flat</ac:parameter><ac:parameter ac:name="separator">pipe</ac:parameter>', ''],
    ['<ac:parameter ac:name="minLevel">3</ac:parameter><ac:parameter ac:name="maxLevel">2</ac:parameter>', ''],
    ['<ac:parameter ac:name="minLevel">3</ac:parameter><ac:parameter ac:name="minLevel">2</ac:parameter>', ''],
    ['<ac:parameter ac:name="minLevel"><strong>2</strong></ac:parameter>', ''],
    ['<ac:parameter ac:name="maxLevel">8</ac:parameter>', '<h4>깊은 제목</h4>'],
    ['<ac:parameter ac:name="minLevel">7</ac:parameter>', ''],
    ['<ac:rich-text-body><p>잘못 붙은 본문</p></ac:rich-text-body>', ''],
  ]) {
    const macro = `<ac:structured-macro ac:name="toc">${body}</ac:structured-macro>`;
    const result = convertLegacyContent(source('confluence-storage', `${macro}${extra}`), resolver());
    canonical(result);
    assert.equal(nodes(result.content, 'documentToc').length, 0);
    assert.equal(nodes(result.content, 'codeBlock')[0].content?.[0].text, macro);
    assert.ok(result.diagnostics.some(item => item.code === 'TOC_PARAMETERS_UNSUPPORTED'));
  }
});

test('Confluence label lists preserve legacy scope, documented defaults and bounded modern CQL', () => {
  const macro = (name: string, params: Record<string, string>) => `<ac:structured-macro ac:name="${name}">${Object.entries(params)
    .map(([key, value]) => `<ac:parameter ac:name="${key}">${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</ac:parameter>`).join('')}</ac:structured-macro>`;
  const legacy = macro('contentbylabel', { type: 'page', spaces: '@self', labels: ' Release,design,release ', operator: 'AND' });
  const modern = macro('content-by-label', { cql: '(type = "page" AND (label IN ("Release", design) AND space IN ("WIKI"))) order by title DESC',
    title: '설계 & 기록', max: '500', showSpace: 'false', showLabels: 'false', excerptType: 'none', excludeCurrentPage: 'true' });
  const calls: (string | null)[] = [];
  const context: MigrationContentContext = { ...resolver(), resolveLabelListProject: space => {
    calls.push(space);
    return space === null || space === 'WIKI' ? 'project-now' : null;
  } };
  const result = convertLegacyContent(source('confluence-storage', `${legacy}${modern}`), context);
  canonical(result);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(calls, [null, 'WIKI']);
  assert.deepEqual(nodes(result.content, 'documentLabelList').map(node => ({ ...node.attrs })), [
    { projectId: 'project-now', labels: ['design', 'Release'], match: 'all', sort: 'updated', descending: true,
      limit: 15, title: '', showLabels: true, showSpace: true, excludeCurrent: false },
    { projectId: 'project-now', labels: ['design', 'Release'], match: 'any', sort: 'title', descending: true,
      limit: 500, title: '설계 & 기록', showLabels: false, showSpace: false, excludeCurrent: true },
  ]);
  const original = convertLegacyContent(source('confluence-storage', legacy), { ...context, legacyDocumentLabelList: true });
  assert.equal(nodes(original.content, 'codeBlock')[0].content?.[0].text, legacy);
  assert.equal(original.diagnostics[0]?.code, 'LEGACY_LABEL_LIST_REPRESENTATION');
});

test('Confluence label lists keep uncertain or unsupported filter terms as original code blocks', () => {
  const param = (name: string, value: string) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
  const base = param('type', 'page') + param('spaces', '@self') + param('labels', 'release');
  const wrap = (body: string) => `<ac:structured-macro ac:name="contentbylabel">${body}</ac:structured-macro>`;
  const convert = (markup: string, project: string | null = 'project-now') => convertLegacyContent(source('confluence-storage', markup), {
    ...resolver(), resolveLabelListProject: () => project,
  });
  const modern = 'type = page AND space = currentSpace() AND label = &quot;release&quot;';
  for (const body of [param('labels', 'release') + param('type', 'page'), base.replace('@self', '@all'),
    base.replace('release', '-private'), base.replace('page', 'page,blogpost'), base + param('author', 'user'),
    base + param('excerpt', 'true'), base + param('max', '501'), base + param('labels', 'another'),
    base + '<ac:rich-text-body><p>Unexpected</p></ac:rich-text-body>',
    param('cql', modern), param('cql', `${modern} AND creator = &quot;user&quot; order by title`),
    param('cql', `${modern} OR label = &quot;other&quot; order by title`),
    param('cql', `${modern} AND label IN (&quot;other&quot;, &quot;new&quot;) order by title`),
    param('cql', `${modern} order by title`) + param('sort', 'creation'),
    param('cql', `${modern} order by title`) + param('excerptType', 'rich content'),
    param('cql', `${modern} order by title`) + param('showLabels', 'unexpected'),
  ]) {
    const markup = wrap(body), result = convert(markup);
    canonical(result);
    assert.equal(nodes(result.content, 'documentLabelList').length, 0, markup);
    assert.equal(nodes(result.content, 'codeBlock')[0].content?.[0].text, markup);
    assert.equal(result.diagnostics[0]?.code, 'LABEL_LIST_PARAMETERS_UNSUPPORTED');
  }
  const scoped = wrap(param('cql', `${modern} order by lastmodified desc`));
  assert.equal(nodes(convert(scoped).content, 'documentLabelList')[0]?.attrs?.sort, 'updated');
  assert.equal(convert(scoped, null).diagnostics[0]?.code, 'LABEL_LIST_SCOPE_UNRESOLVED');
});

test('Confluence callouts preserve types, titles and nested blocks, and status macros remain inline', () => {
  const variants = ['info', 'note', 'warning', 'tip', 'panel'];
  const xml = variants.map(variant => `<ac:structured-macro ac:name="${variant}" ac:macro-id="synthetic-id">
    <ac:parameter ac:name="title">${variant} &amp; 제목</ac:parameter>
    <ac:rich-text-body><p><strong>강조</strong></p><ul><li>목록</li></ul></ac:rich-text-body>
    </ac:structured-macro>`).join('') +
    '<p>앞 <ac:macro ac:name="status"><ac:parameter ac:name="title">진행 중</ac:parameter><ac:parameter ac:name="colour">Yellow</ac:parameter><ac:parameter ac:name="subtle">false</ac:parameter></ac:macro> 다음 <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro> 끝</p>' +
    '<p><ac:structured-macro ac:name="status"/></p>';
  const result = convertLegacyContent(source('confluence-storage', xml), resolver());
  canonical(result);
  const callouts = nodes(result.content, 'callout');
  assert.deepEqual(callouts.map(node => ({ ...node.attrs })), variants.map(variant => ({ variant, title: `${variant} & 제목` })));
  for (const callout of callouts) {
    assert.deepEqual(callout.content?.map(node => node.type), ['paragraph', 'bulletList']);
    assert.deepEqual(callout.content?.[0].content?.[0].marks, [{ type: 'bold' }]);
  }
  assert.deepEqual(result.content.content?.[5].content?.map(node => node.text ?? node.attrs?.label),
    ['앞 ', '진행 중', ' 다음 ', 'Green', ' 끝']);
  assert.deepEqual(nodes(result.content, 'statusBadge').map(node => ({ ...node.attrs })), [
    { label: '진행 중', tone: 'amber' }, { label: 'Green', tone: 'green' }, { label: 'Grey', tone: 'neutral' },
  ]);
  assert.match(result.plainText, /info & 제목\n강조\n목록/);
  assert.match(result.plainText, /앞 진행 중 다음 Green 끝\nGrey$/);
  assert.deepEqual(result.diagnostics, []);
});

test('unsupported callout presentation and status colors are reported with readable source text and inert markup', () => {
  const title = '제'.repeat(MAX_CALLOUT_TITLE_LENGTH + 1);
  const label = '상'.repeat(MAX_STATUS_BADGE_LABEL_LENGTH + 1);
  const xml = '<ac:structured-macro ac:name="panel"><ac:parameter ac:name="bgColor">url(https://example.test/style)</ac:parameter>' +
    `<ac:parameter ac:name="title">${title}</ac:parameter><ac:rich-text-body><p>패널 본문</p></ac:rich-text-body></ac:structured-macro>` +
    '<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="title">&lt;script&gt;</ac:parameter>' +
    '<ac:parameter ac:name="colour">#f1e2d3</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro>' +
    ` <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">${label}</ac:parameter></ac:structured-macro></p>` +
    '<ac:structured-macro ac:name="tip"><ac:rich-text-body><p>첫 본문</p></ac:rich-text-body><ac:rich-text-body><p>다른 본문</p></ac:rich-text-body></ac:structured-macro>';
  const result = convertLegacyContent(source('confluence-storage', xml), resolver());
  canonical(result);
  assert.deepEqual(nodes(result.content, 'callout').map(node => ({ ...node.attrs })), [{ variant: 'panel', title: '' }]);
  assert.deepEqual(nodes(result.content, 'statusBadge').map(node => ({ ...node.attrs })), [{ label: '<script>', tone: 'neutral' }]);
  assert.ok(result.plainText.includes(`${title}\n패널 본문`));
  assert.ok(result.plainText.includes(label));
  assert.match(nodes(result.content, 'codeBlock')[0].content?.[0].text ?? '', /첫 본문.*다른 본문/);
  assert.doesNotMatch(JSON.stringify(result.content), /bgColor|https:\/\/example.test|#f1e2d3/);
  assert.deepEqual(result.diagnostics.map(value => value.code), [
    'CALLOUT_PRESENTATION_UNSUPPORTED', 'CALLOUT_TITLE_UNSUPPORTED', 'STATUS_PRESENTATION_UNSUPPORTED',
    'STATUS_COLOR_UNSUPPORTED', 'STATUS_LABEL_UNSUPPORTED', 'UNSUPPORTED_CONTENT',
  ]);
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

test('Confluence page and revision anchors keep Jira labels, formatting and full selectors', () => {
  const jira = 'https://jira.example.test:8443/jira/browse/';
  const known = `${jira}OLD-7`, unknown = `${jira}OLD-42`;
  const focused = `${known}?focusedCommentId=17&page=issuetabpanels:comment-tabpanel#comment-17`;
  const opaque = `${known}?focusedCommentId=abc#comment-17`;
  const encoded = `${jira}%4FLD-7?pageId=200`;
  const anchored = `${known}#comment-42`;
  const xml = `<p><a href="${known}">확인한 업무</a></p>` +
    `<p><a href="${unknown}"><strong>업무</strong> <em>설명</em></a></p>` +
    `<p><a href="${focused.replaceAll('&', '&amp;')}"><u>특정 댓글</u></a></p>` +
    `<p><a href="${opaque}">지원하지 않는 선택자</a></p>` +
    `<p><a href="${known}#"/><a href="${encoded}">인코딩된 키</a></p>` +
    `<p><a href="${anchored}"><code>기호</code></a></p>`;
  for (const kind of ['page', 'revision'] as const) {
    const calls: MigrationReferenceInput[] = [];
    const result = convertLegacyContent({ ...source('confluence-storage', xml), kind }, resolver(calls));
    canonical(result);
    assert.deepEqual(nodes(result.content, 'issueReference').map(node => ({ ...node.attrs })), [
      { issueId: 'issue-new', label: '확인한 업무' },
    ]);
    const linked = nodes(result.content, 'text').map(node => [node.text, node.marks?.find(mark => mark.type === 'link')?.attrs?.href,
      node.marks?.filter(mark => mark.type !== 'link').map(mark => mark.type)]);
    assert.deepEqual(linked, [
      ['업무', unknown, ['bold']], [' ', unknown, []], ['설명', unknown, ['italic']],
      ['특정 댓글', focused, ['underline']], ['지원하지 않는 선택자', opaque, []],
      [`${known}#`, `${known}#`, []], ['인코딩된 키', encoded, []],
      ['기호', undefined, ['code']], [' (', undefined, undefined], [anchored, anchored, []], [')', undefined, undefined],
    ]);
    assert.deepEqual(calls, [{ kind: 'issue', url: known }, { kind: 'issue', url: unknown }]);
    assert.deepEqual(result.diagnostics, []);
  }
});

test('legacy Confluence Jira anchor projection reproduces only the previous direct-link fallback', () => {
  const known = 'https://jira.example.test/jira/browse/OLD-7';
  const unknown = 'https://jira.example.test/jira/browse/OLD-42?focusedCommentId=17';
  const spoofed = 'https://example.test/path?target=/browse/OTHER-3';
  const xml = `<p><a href="${known}">확인한 업무</a></p>` +
    `<p><a href="${unknown}"><strong>원본 댓글</strong></a><a href="${spoofed}">다른 주소</a></p>` +
    '<p><ac:link><ri:page ri:content-title="누락 문서"/></ac:link></p>' +
    '<ac:image><ri:attachment ri:filename="missing.png"/></ac:image>';
  const result = convertLegacyContent(source('confluence-storage', xml), { ...resolver(), legacyConfluenceJiraAnchorProjection: true });
  canonical(result);
  assert.deepEqual(nodes(result.content, 'issueReference').map(node => ({ ...node.attrs })), [{ issueId: 'issue-new', label: '확인한 업무' }]);
  assert.ok(result.plainText.includes(`[업무 참조: 원본 댓글 (${unknown})][업무 참조: 다른 주소 (${spoofed})]`));
  assert.ok(result.plainText.includes('[문서 참조: 누락 문서]'));
  assert.deepEqual(result.diagnostics.map(item => item.code), ['LEGACY_CONFLUENCE_JIRA_ANCHOR', 'UNRESOLVED_REFERENCE', 'UNRESOLVED_IMAGE']);

  const comment = convertLegacyContent({ ...source('confluence-storage', `<p><a href="${unknown}">원본 댓글</a></p>`), kind: 'comment' }, resolver());
  assert.equal(comment.plainText, `[업무 참조: 원본 댓글 (${unknown})]`);
  assert.deepEqual(comment.diagnostics.map(item => item.code), ['UNRESOLVED_REFERENCE']);
});

test('Confluence textual include parameters preserve space scope and nested page identities', () => {
  const include = (value: string, parameter = '') =>
    `<ac:structured-macro ac:name="include"><ac:parameter ac:name="${parameter}">${value}</ac:parameter></ac:structured-macro>`;
  const xml = [include(' OPS:Runbook:network '), include('MISSING:Runbook'), include('~user.name:Runbook', 'pageTitle'),
    include('Summary: follow-up', 'page'), include('<ri:page ri:content-id="88" ri:content-title="OPS:Runbook"/>MISSING:Runbook')].join('');
  const calls: MigrationReferenceInput[] = [];
  const result = convertLegacyContent(source('confluence-storage', xml), { resolveReference: input => {
    calls.push(input);
    if (input.sourceId === '88') return { id: 'explicit', label: 'OPS:Runbook' };
    if (input.spaceKey === 'OPS' && input.title === 'Runbook:network') return { id: 'network', label: input.title };
    if (input.spaceKey === '~user.name' && input.title === 'Runbook') return { id: 'personal', label: input.title };
    if (!input.spaceKey && input.title === 'Summary: follow-up') return { id: 'literal', label: input.title };
    if (!input.spaceKey && input.title === 'Runbook') return { id: 'wrong-local-target', label: input.title };
    return null;
  } });
  canonical(result);
  assert.deepEqual(contentReferences(result.content).map(value => [value.kind, value.id]),
    [['include', 'network'], ['include', 'personal'], ['include', 'literal'], ['include', 'explicit']]);
  assert.deepEqual(calls.map(({ spaceKey, title }) => [spaceKey, title]),
    [['OPS', 'Runbook:network'], ['MISSING', 'Runbook'], ['~user.name', 'Runbook'], [undefined, 'Summary: follow-up'], [undefined, 'OPS:Runbook']]);
  assert.match(result.plainText, /\[문서 포함 참조: MISSING:Runbook\]/);
  assert.ok(result.diagnostics.some(value => value.code === 'UNRESOLVED_REFERENCE'));
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
  const xml = '<p><a href="javascript:alert(1)">위험 링크</a></p><script>dangerous()</script><ac:structured-macro ac:name="unknown-widget"><ac:parameter ac:name="value">보존해야 할 값</ac:parameter><ac:rich-text-body><p>미지원 본문</p></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="excerpt-include"><ac:parameter ac:name="">Missing excerpt</ac:parameter></ac:structured-macro><ac:image><ri:url ri:value="https://example.test/remote.png"/></ac:image><ac:link><ri:page ri:content-title="Missing"/></ac:link>';
  const result = convertLegacyContent(source('confluence-storage', xml), resolver()); canonical(result);
  for (const value of ['javascript:alert(1)', 'dangerous()', '보존해야 할 값', '미지원 본문', 'excerpt-include', 'https://example.test/remote.png', 'Missing']) assert.ok(result.plainText.includes(value), value);
  assert.equal(nodes(result.content, 'image').length, 0); assert.equal(nodes(result.content, 'documentInclude').length, 0);
  assert.ok(result.diagnostics.some(value => value.code === 'UNSAFE_URL')); assert.ok(result.diagnostics.some(value => value.code === 'UNSUPPORTED_MACRO')); assert.ok(result.diagnostics.some(value => value.code === 'REMOTE_IMAGE_NOT_EMBEDDED')); assert.ok(result.diagnostics.some(value => value.code === 'UNRESOLVED_REFERENCE'));
  assert.ok(result.diagnostics.some(value => value.code === 'UNRESOLVED_EXCERPT_INCLUDE'));
  assert.ok(!nodes(result.content, 'text').some(node => node.marks?.some(mark => mark.type === 'link' && String(mark.attrs?.href).startsWith('javascript:'))));
});

test('Confluence lists preserve Jira query markup for explicit document review and unsupported selectors stay archived', () => {
  const macro = (name: string, more = '') => `<ac:structured-macro ac:name="${name}" ac:schema-version="1">` +
    '<ac:parameter ac:name="server">기존 Jira</ac:parameter><ac:parameter ac:name="jqlQuery">project = OLD AND status = &quot;Open&quot;</ac:parameter>' +
    more + '</ac:structured-macro>';
  const supported = macro('Jira', '<ac:parameter ac:name="maximumIssues">10</ac:parameter>');
  const countOnly = macro('jira', '<ac:parameter ac:name="count">true</ac:parameter>');
  const mixed = macro('jira', '<ac:parameter ac:name="key">OLD-7</ac:parameter>');
  const result = convertLegacyContent(source('confluence-storage', `<p>목록 앞</p>${supported}${countOnly}${mixed}<p>목록 뒤</p>`), {
    resolveReference: () => { throw new Error('A Jira list must be archived for review'); },
  });
  canonical(result);
  assert.deepEqual(result.content.content?.map(node => node.type), ['paragraph', 'codeBlock', 'codeBlock', 'codeBlock', 'paragraph']);
  assert.deepEqual(nodes(result.content, 'codeBlock').map(node => node.content?.[0].text), [supported, countOnly, mixed]);
  assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.code), ['JIRA_LIST_REVIEW', 'UNSUPPORTED_MACRO']);
});

test('malformed storage, XXE/DOCTYPE, unknown HTML entities and invalid ADF fall back to the complete inert original', () => {
  const inputs: [LegacyRecord['textFormat'], string][] = [['confluence-storage', '<p>unclosed'], ['confluence-storage', '<!DOCTYPE p [<!ENTITY x SYSTEM "http://127.0.0.1:9/never">]><p>&deg; &x;</p>'], ['confluence-storage', '<p>&times; &unrecognized;</p>'], ['confluence-storage', '<p>&constructor;</p>'], ['adf', '{bad json'], ['adf', JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: 'MALFORMED_BUT_PRESERVED' }] })]];
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

test('ADF panels and status preserve native kinds, palette and inline text with explicit fallback for custom presentation', () => {
  const raw = { type: 'doc', version: 1, content: [
    ...['info', 'note', 'warning', 'success', 'error', 'custom'].map(panelType => ({
      type: 'panel', attrs: { panelType }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `본문 ${panelType}` }] }],
    })),
    { type: 'paragraph', content: [
      { type: 'text', text: '앞 ' },
      ...['neutral', 'blue', 'green', 'yellow', 'red', 'purple', '#123ABC'].map(color =>
        ({ type: 'status', attrs: { color, text: color === '#123ABC' ? '사용자 색상' : color, localId: 'source-status-id' } })),
      { type: 'text', text: ' 뒤' },
    ] },
  ] };
  const result = convertLegacyContent(source('adf', JSON.stringify(raw)), resolver());
  canonical(result);
  assert.deepEqual(nodes(result.content, 'callout').map(node => ({ ...node.attrs })), [
    { variant: 'info', title: '' }, { variant: 'note', title: '' }, { variant: 'warning', title: '' },
    { variant: 'tip', title: '성공' }, { variant: 'warning', title: '오류' },
  ]);
  assert.match(nodes(result.content, 'codeBlock')[0].content?.[0].text ?? '', /"panelType":"custom".*본문 custom/);
  assert.deepEqual(nodes(result.content, 'statusBadge').map(node => node.attrs?.tone),
    ['neutral', 'blue', 'green', 'amber', 'red', 'purple', 'neutral']);
  assert.match(result.plainText, /성공\n본문 success\n오류\n본문 error/);
  assert.match(result.plainText, /앞 neutralbluegreenyellowredpurple사용자 색상 뒤$/);
  assert.deepEqual(result.diagnostics.map(value => value.code),
    ['CALLOUT_PRESENTATION_UNSUPPORTED', 'UNSUPPORTED_CONTENT', 'STATUS_COLOR_UNSUPPORTED']);
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
