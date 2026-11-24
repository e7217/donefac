import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'marked';
import { renderDocumentExportMarkdown, type DocumentMarkdownExportResolvers } from '../../shared/document-export-markdown.js';
import type { RichContent } from '../../shared/types.js';
import { contentMarkdown } from '../../src/features/document-utils.js';

type Mark = NonNullable<RichContent['marks']>[number];
const text = (value: string, ...marks: Mark[]): RichContent => ({ type: 'text', text: value, marks });
const link = (value: string, href: string): RichContent => text(value, { type: 'link', attrs: { href } });
const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', content });
const render = (content: RichContent[], resolve: DocumentMarkdownExportResolvers = {
  document: () => undefined, attachment: () => undefined,
}) => renderDocumentExportMarkdown({ id: 'root', title: '팀 문서 [검토]', content: { type: 'doc', content } }, resolve);

test('Markdown exports preserve the reading order, formatting and section links inside document columns', () => {
  const heading: RichContent = { type: 'heading', attrs: { level: 2, sectionId: 'column-left' }, content: [text('작업 절차')] };
  const column = (...content: RichContent[]): RichContent => ({ type: 'documentColumn', content });
  const doc: RichContent[] = [
    { type: 'documentColumnLayout', attrs: { weights: [3, 7], border: true }, content: [
      column(heading, paragraph(text('승인 필요', { type: 'bold' }))),
      column(paragraph(link('절로 이동', '#column-left')),
        { type: 'codeBlock', attrs: { language: 'sh' }, content: [text('echo 준비')] }),
    ] },
    { type: 'documentColumnLayout', attrs: { weights: [1], border: false }, content: [column(paragraph(text('공통 점검')))] },
  ];
  const offline = render(doc);
  assert.deepEqual(offline.diagnostics.map(({ code, nodeType }) => [code, nodeType]), [['layout_linearized', 'documentColumnLayout']]);
  const standalone = contentMarkdown({ type: 'doc', content: doc });
  for (const markdown of [offline.markdown, standalone]) {
    const html = parse(markdown, { async: false, gfm: true });
    assert.match(html, /id="column-left"[\s\S]*<h2>작업 절차<\/h2>[\s\S]*<strong>승인 필요<\/strong>[\s\S]*href="#column-left">절로 이동<\/a>[\s\S]*<pre><code class="language-sh">echo 준비\n<\/code><\/pre>[\s\S]*<p>공통 점검<\/p>/u);
  }
});

test('Markdown exports keep heading levels 4–6, section anchors and matching table of contents entries', () => {
  const heading = (level: number, title: string, sectionId: string): RichContent => ({
    type: 'heading', attrs: { level, sectionId }, content: [text(title)],
  });
  const content: RichContent[] = [
    { type: 'documentToc', attrs: { minLevel: 4, maxLevel: 6 } },
    heading(3, '개요', 'overview'),
    heading(4, '검증 절차', 'checks'),
    heading(5, '연결 점검', 'connection'),
    heading(6, '오류 코드', 'error-codes'),
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [
      heading(6, '결과 표', 'results'),
    ] }] }] },
  ];

  for (const markdown of [render(content).markdown, contentMarkdown({ type: 'doc', content })]) {
    assert.match(markdown, /^#### 검증 절차$/mu);
    assert.match(markdown, /^##### 연결 점검$/mu);
    assert.match(markdown, /^###### 오류 코드$/mu);
    const html = parse(markdown, { async: false, gfm: true });
    assert.doesNotMatch(html, /href="#overview"/u);
    assert.match(html, /href="#checks">검증 절차<\/a>[\s\S]*href="#connection">연결 점검<\/a>[\s\S]*href="#error-codes">오류 코드<\/a>[\s\S]*href="#results">결과 표<\/a>/u);
    assert.match(html, /id="checks"[\s\S]*<h4>검증 절차<\/h4>[\s\S]*id="connection"[\s\S]*<h5>연결 점검<\/h5>[\s\S]*id="error-codes"[\s\S]*<h6>오류 코드<\/h6>/u);
    assert.match(html, /<td>(?:<p>)?<a id="results"[^>]*><\/a>(?:<\/p>)?(?:&#10;|\s)*<h6>결과 표<\/h6><\/td>/u);
  }
});

test('standalone Markdown keeps merged table headers, rich cell content and safe links', () => {
  const row = (...content: RichContent[]): RichContent => ({ type: 'tableRow', content });
  const header = (value: string, attrs?: RichContent['attrs']): RichContent => ({
    type: 'tableHeader', attrs, content: [paragraph(text(value))],
  });
  const cell = (...content: RichContent[]): RichContent => ({ type: 'tableCell', content });
  const content: RichContent = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, sectionId: 'review-table' }, content: [text('표 검토')] },
    { type: 'table', content: [
      row(header('병합 머리글', { colspan: 2, rowspan: 2 }), cell(paragraph(text('본문 칸')))),
      row(cell(
        paragraph(text('강조한 결정', { type: 'bold' })),
        paragraph(text('둘째 문단 ', { type: 'italic' }), link('외부 참고', 'https://docs.example.test/review')),
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('셀 안의 목록'))] }] },
      )),
      row(header('행 머리글'), { ...cell(
        paragraph(link('표 제목으로', '#review-table')),
        paragraph(text('<sample>문자 예제</sample>'), text(' · '), link('주소가 잘못된 링크', 'javascript:void(0)')),
      ), attrs: { colspan: 2 } }),
    ] },
    { type: 'table', content: [row(header('검사 항목'), header('결과')), row(cell(paragraph(text('날짜'))), cell(paragraph(text('확인'))))] },
  ] };

  const markdown = contentMarkdown(content);
  const html = parse(markdown, { async: false, gfm: true }).replaceAll('&#10;', '\n');
  assert.match(html, /<th\b(?=[^>]*colspan="2")(?=[^>]*rowspan="2")[^>]*><p>병합 머리글<\/p><\/th><td><p>본문 칸<\/p><\/td>/u);
  assert.match(html, /<td><p><strong>강조한 결정<\/strong><\/p>\s*<p><em>둘째 문단<\/em> <a href="https:\/\/docs\.example\.test\/review">외부 참고<\/a><\/p>/u);
  assert.match(html, /<ul>\s*<li>셀 안의 목록<\/li>\s*<\/ul>/u);
  assert.match(html, /<th><p>행 머리글<\/p><\/th><td colspan="2">[\s\S]*<a href="#review-table">표 제목으로<\/a>/u);
  assert.match(html, /&lt;sample&gt;문자 예제&lt;\/sample&gt; · 주소가 잘못된 링크/u);
  assert.doesNotMatch(html, /<\/?sample>|href=["']\s*javascript:/iu);
  assert.match(markdown, /^\| 검사 항목 \| 결과 \|\n\|[\s|:-]+\|\n\| 날짜 \| 확인 \|$/mu);
});

test('offline Markdown renders rich Korean text, nested structures and stable navigation', () => {
  const result = render([
    { type: 'documentToc' },
    { type: 'heading', attrs: { sectionId: 'section-1', level: 1 }, content: [text('안전 규정')] },
    { type: 'heading', attrs: { level: 2 }, content: [text('설치 절차')] },
    paragraph(text('굵게', { type: 'bold' }), text(' '), text('기울임', { type: 'italic' }), text(' '),
      text('밑줄', { type: 'underline' }), text(' '), text('취소선', { type: 'strike' }), { type: 'hardBreak' },
      text('`장비`', { type: 'code' }), text(' '), link('상단으로', '#section-1')),
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph(text('장비 연결'))] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('연결 확인'))] }] },
    { type: 'details', content: [{ type: 'detailsSummary', content: [text('접힌 설명')] },
      { type: 'detailsContent', content: [paragraph(text('본문 확인'))] }] },
    { type: 'callout', attrs: { variant: 'warning', title: '측정 주의' }, content: [paragraph(text('보호 장구'))] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2 }, content: [
      { type: 'codeBlock', attrs: { language: 'sh' }, content: [text('before\n\n```\nafter')] },
    ] }] }] },
    { type: 'documentExcerpt', attrs: { hidden: true }, content: [paragraph(text('저장된 발췌 본문'))] },
  ]);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.markdown, /\[안전 규정\]\(#section-1\)[\s\S]*\[설치 절차\]\(#section-2\)/u);
  const html = parse(result.markdown, { async: false, gfm: true });
  assert.match(html, /<h1>팀 문서 \[검토\]<\/h1>/u);
  for (const [tag, value] of [['strong', '굵게'], ['em', '기울임'], ['u', '밑줄'], ['del', '취소선'], ['code', '`장비`']]) {
    assert.ok(html.includes(`<${tag}>${value}</${tag}>`), html);
  }
  assert.match(html, /<br>[\s\S]*href="#section-1">상단으로/u);
  assert.match(html, /<ol start="3">\s*<li>장비 연결<\/li>/u);
  assert.match(html, /<input checked="" disabled="" type="checkbox"> 연결 확인/u);
  assert.match(html, /<summary>접힌 설명<\/summary>[\s\S]*<p>본문 확인<\/p>/u);
  assert.match(html, /<th colspan="2"><pre><code class="language-sh">before&#10;&#10;```&#10;after/u);
  assert.match(html, /경고<\/strong> · 측정 주의[\s\S]*보호 장구/u);
  assert.match(html, /원본 표시에서 숨김[\s\S]*저장된 발췌 본문/u);

  const soleSubheading = render([{ type: 'documentToc' }, { type: 'heading', attrs: { level: 3 }, content: [text('단독 소제목')] }]);
  assert.match(parse(soleSubheading.markdown, { async: false }), /<li><a href="#section-1">단독 소제목<\/a><\/li>/u);
});

test('offline Markdown connects only local document, revision and attachment targets', () => {
  const pinnedImage = '37a1a6f4-2222-47c8-9092-9f58cca86cb2';
  const downloads: { id: string; kind: string }[] = [];
  const result = render([
    paragraph(text('<img onerror="evil()"> https://evil.invalid/a'), text(' '), link('외부 주소', '//evil.invalid/path')),
    paragraph(link('다른 문서 절', '/#/space/documents/other?section=install-01')),
    paragraph(link('승인 당시 절', '#/space/documents/other?publication=published&revision=revision-3&section=install-01')),
    { type: 'documentRevisionInclude', attrs: { documentId: 'other', revisionId: 'revision-3', label: '승인 당시 포함' } },
    { type: 'documentRevisionInclude', attrs: { documentId: 'other', revisionId: 'old-revision', label: '옛날 포함' } },
    { type: 'documentExcerptInclude', attrs: { documentId: 'other', label: '살아 있는 발췌' } },
    { type: 'image', attrs: { src: `/api/attachments/${pinnedImage}/content?inline=1`, alt: '당시 사진' } },
    paragraph(link('정확한 파일', `/api/attachment-versions/${pinnedImage}/download`)),
    { type: 'image', attrs: { src: 'https://evil.invalid/image.png', alt: '외부 사진' } },
    paragraph(link('검증되지 않은 경로', '#/space/documents/unsafe')),
  ], {
    document(id, target) {
      if (id === 'unsafe') return 'javascript:alert(1)';
      if (id !== 'other' || target?.revisionId && target.revisionId !== 'revision-3') return undefined;
      return `다른%20문서.md${target?.sectionId ? `#${target.sectionId}` : ''}`;
    },
    attachment(id, kind) {
      downloads.push({ id, kind });
      return '../attachments/첨부%20사진.png';
    },
  });
  const html = parse(result.markdown, { async: false, gfm: true });
  assert.match(html, /&lt;img onerror=&quot;evil\(\)&quot;&gt;/u);
  assert.doesNotMatch(html, /(?:href|src)="(?:https?:|\/\/|javascript:)|<img[^>]+onerror/u);
  assert.equal((result.markdown.match(/\(다른%20문서\.md#install-01\)/gu) ?? []).length, 2);
  assert.match(result.markdown, /\[승인 당시 포함\]\(다른%20문서\.md\) · 저장본 revision\\-3/u);
  assert.match(result.markdown, /옛날 포함 · 저장본 old\\-revision · 이번 내보내기에 없음/u);
  assert.deepEqual(downloads, [{ id: pinnedImage, kind: 'inline-image' }, { id: pinnedImage, kind: 'attachment-version' }]);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    'external_link', 'pinned_revision_unavailable', 'live_include', 'external_image', 'document_outside_export',
  ]);
});

test('offline Markdown rewrites normal absolute clipboard links only on the trusted browser origin', () => {
  const browserOrigin = 'https://teamspace.example.test:7443';
  const otherOrigin = 'https://teamspace.example.test:8443';
  const attachment = '37a1a6f4-2222-47c8-9092-9f58cca86cb2';
  const section = '/#/space/documents/other?section=install-01';
  const download = `/api/attachment-versions/${attachment}/download`;
  const inline = `/api/attachments/${attachment}/content?inline=1`;
  const attachmentCalls: string[] = [];
  const result = render([
    paragraph(link('복사한 절 링크', browserOrigin + section)),
    paragraph(link('복사한 첨부 주소', browserOrigin + download)),
    { type: 'image', attrs: { src: browserOrigin + inline, alt: '로컬 사진' } },
    paragraph(link('다른 서버의 절', otherOrigin + section)),
    paragraph(link('다른 서버의 파일', otherOrigin + download)),
    { type: 'image', attrs: { src: otherOrigin + inline, alt: '외부 사진' } },
    paragraph(link('동일 서버의 업무 API', browserOrigin + '/api/workspace')),
    paragraph(link('자격 증명 포함 링크', `https://user@teamspace.example.test:7443${section}`)),
  ], {
    browserOrigin,
    document(id, target) {
      assert.equal(id, 'other');
      assert.deepEqual(target, { sectionId: 'install-01' });
      return '다른%20문서.md#install-01';
    },
    attachment(id, kind) {
      attachmentCalls.push(`${kind}:${id}`);
      return '../attachments/results.png';
    },
  });
  assert.match(result.markdown, /\[복사한 절 링크\]\(다른%20문서\.md#install-01\)/u);
  assert.match(result.markdown, /\[복사한 첨부 주소\]\(\.\.\/attachments\/results\.png\)/u);
  assert.match(result.markdown, /!\[로컬 사진\]\(\.\.\/attachments\/results\.png\)/u);
  assert.doesNotMatch(result.markdown, /teamspace\.example\.test|\/api\/workspace/u);
  assert.deepEqual(attachmentCalls, [`attachment-version:${attachment}`, `inline-image:${attachment}`]);
  assert.deepEqual(result.diagnostics.map(row => row.code), [
    'external_link', 'external_link', 'external_image', 'external_link', 'external_link',
  ]);
});
