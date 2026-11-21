import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'marked';
import { renderDocumentExportMarkdown, type DocumentMarkdownExportResolvers } from '../../server/document-export-markdown.js';
import type { RichContent } from '../../shared/types.js';

type Mark = NonNullable<RichContent['marks']>[number];
const text = (value: string, ...marks: Mark[]): RichContent => ({ type: 'text', text: value, marks });
const link = (value: string, href: string): RichContent => text(value, { type: 'link', attrs: { href } });
const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', content });
const render = (content: RichContent[], resolve: DocumentMarkdownExportResolvers = {
  document: () => undefined, attachment: () => undefined,
}) => renderDocumentExportMarkdown({ id: 'root', title: '팀 문서 [검토]', content: { type: 'doc', content } }, resolve);

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
