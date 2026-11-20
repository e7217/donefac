import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDocumentContent } from '../../server/document-content.js';
import { markdownImportSectionId } from '../../shared/document-sections.js';
import type { RichContent } from '../../shared/types.js';
import { MAX_MARKDOWN_IMPORT_BYTES, previewMarkdownImport } from '../../src/features/document-markdown-import.js';

const children = (value: RichContent): RichContent[] => [value, ...(value.content ?? []).flatMap(children)];
const linkOf = (value: RichContent) => value.marks?.find(mark => mark.type === 'link')?.attrs?.href;

test('Markdown headings, GFM styles, nested checklists, code, tables and breaks convert to valid Teamspace content', () => {
  const result = previewMarkdownImport([
    '# 운영 &amp; 점검',
    '',
    '#### 이후 절',
    '',
    '일반 **강조**와 *기울임*, ~~이전~~, `종료`  ',
    '다음 줄',
    '',
    '> 안내',
    '>',
    '> - [x] 완료',
    '>   - [ ] 하위 작업',
    '> - 일반 항목',
    '> - [ ] 다음 확인',
    '',
    '0. 영부터',
    '1. [x] 번호 체크',
    '2. 다음 번호',
    '',
    '| 항목 | 상태 |',
    '| :--- | ---: |',
    '| `포트` | **정상** |',
    '',
    '```sh title=sample',
    'printf "<그대로>"',
    '```',
    '',
    '---',
  ].join('\n'));
  const normalized = normalizeDocumentContent(result.content);
  const nodes = children(normalized.content);
  assert.equal(result.suggestedTitle, '운영 & 점검');
  assert.deepEqual(normalized.content.content?.map(node => node.type), [
    'heading', 'heading', 'paragraph', 'blockquote', 'orderedList', 'taskList', 'orderedList', 'table', 'codeBlock', 'horizontalRule',
  ]);
  assert.deepEqual(nodes.filter(node => node.type === 'heading').map(node => [node.attrs?.level, node.attrs?.sectionId]), [
    [1, markdownImportSectionId(1)], [3, markdownImportSectionId(2)],
  ]);
  assert.deepEqual(nodes.filter(node => node.type === 'text' && node.marks?.length).slice(0, 4)
    .map(node => [node.text, node.marks?.map(mark => mark.type)]), [
    ['강조', ['bold']], ['기울임', ['italic']], ['이전', ['strike']], ['종료', ['code']],
  ]);
  assert.equal(nodes.filter(node => node.type === 'hardBreak').length, 1);
  assert.deepEqual(nodes.filter(node => node.type === 'taskItem').map(node => node.attrs?.checked), [true, false, false, true]);
  assert.deepEqual(nodes.filter(node => node.type === 'orderedList').map(node => node.attrs?.start), [0, 2]);
  assert.deepEqual(nodes.filter(node => node.type === 'tableHeader').map(node => node.attrs?.align), ['left', 'right']);
  assert.deepEqual(nodes.filter(node => node.type === 'tableCell').map(node => node.attrs?.align), ['left', 'right']);
  assert.equal(nodes.find(node => node.type === 'codeBlock')?.attrs?.language, 'sh');
  assert.equal(nodes.find(node => node.type === 'codeBlock')?.content?.[0]?.text, 'printf "<그대로>"');
  assert.deepEqual(result.warnings.map(({ code, count }) => [code, count]), [['headingLevel', 1], ['numberedTask', 1]]);
});

test('Markdown fragment and link destinations bind only matched headings or validated source-relative addresses', () => {
  const result = previewMarkdownImport([
    '[첫 목차](#%ED%95%9C%EA%B8%80--%EC%A0%9C%EB%AA%A9) [둘째 목차](#한글--제목-1)',
    '[문서 링크][related] [외부 절](#unknown) [링크 쿼리](https://example.test/path?a=1&amp;b=2)',
    '[`파일 링크`](../Config.yaml) [메일](mailto:ops@example.test)',
    '',
    '# 한글  제목!',
    '',
    '# 한글  제목!',
    '',
    '[related]: ../Runbook.md "원본 제목"',
  ].join('\n'), 'https://gitlab.example.test/ops/repo/-/blob/main/Docs/ReadMe.md?source-only=1#start');
  const { content } = normalizeDocumentContent(result.content);
  assert.deepEqual(children(content).filter(linkOf).map(node => [node.text, linkOf(node)]), [
    ['첫 목차', `#${markdownImportSectionId(1)}`], ['둘째 목차', `#${markdownImportSectionId(2)}`],
    ['문서 링크', 'https://gitlab.example.test/ops/repo/-/blob/main/Runbook.md'],
    ['외부 절', 'https://gitlab.example.test/ops/repo/-/blob/main/Docs/ReadMe.md#unknown'],
    ['링크 쿼리', 'https://example.test/path?a=1&b=2'], ['파일 링크', 'https://gitlab.example.test/ops/repo/-/blob/main/Config.yaml'],
    ['메일', 'mailto:ops@example.test'],
  ]);
  assert.equal(result.warnings.length, 0);
});

test('Markdown HTML and images stay inert and deceptive or missing link destinations produce scoped warnings', () => {
  const { content, warnings } = previewMarkdownImport([
    '<div>literal tag</div>',
    '',
    '둘 <b>원문</b> &constructor; &lt;script&gt;',
    '',
    '![배포 화면](https://example.test/run.png) ![](diagram.png) [원본 경로](../Guide.md)',
    '[숫자 스킴](jav&#97;script:foo) [이름 스킴](javascript&colon;foo) [공백](java&Tab;script:foo)',
    '[메일 우회](mailto:ops@example.test?subject=x%0d%0abcc:y@example.test) [자동 서버](//evil.example.test/api)',
  ].join('\n'));
  const normalized = normalizeDocumentContent(content);
  const nodes = children(normalized.content);
  assert.equal(nodes.some(node => node.type === 'image'), false);
  assert.deepEqual(nodes.filter(linkOf).map(node => [node.text, linkOf(node)]), [['배포 화면 (이미지)', 'https://example.test/run.png']]);
  assert.match(normalized.plainText, /<div>literal tag<\/div>/);
  assert.match(normalized.plainText, /<b>원문<\/b> &constructor; <script>/);
  assert.match(normalized.plainText, /이미지 \(diagram\.png\)[\s\S]*원본 경로 \(\.\.\/Guide\.md\)/);
  assert.match(normalized.plainText, /숫자 스킴 이름 스킴 공백 메일 우회 자동 서버/);
  assert.deepEqual(warnings.map(({ code, count }) => [code, count]), [['html', 3], ['image', 2], ['relativeLink', 2], ['unsafeLink', 5]]);
});

test('Markdown rejects empty, malformed, excessively large and excessively structured input before creating a draft', () => {
  assert.throws(() => previewMarkdownImport('\uFEFF\n '), /가져올 Markdown 내용/);
  assert.throws(() => previewMarkdownImport('a\u0000b'), /올바른 Markdown 텍스트/);
  assert.throws(() => previewMarkdownImport('[definition]: https://a.example.test'), /가져올 수 있는 Markdown 본문/);
  assert.throws(() => previewMarkdownImport('한'.repeat(Math.floor(MAX_MARKDOWN_IMPORT_BYTES / 3) + 1)), /512KiB/);
  assert.throws(() => previewMarkdownImport('line\n\n'.repeat(15_000)), /블록이나 중첩/);
  assert.throws(() => previewMarkdownImport('> '.repeat(65) + 'too deep'), /블록이나 중첩/);
  assert.throws(() => previewMarkdownImport('본문', 'file:///repo/README.md'), /HTTP 또는 HTTPS/);
  assert.throws(() => previewMarkdownImport('본문', 'https://name:password@site.example.test/README.md'), /자격 증명이 없는/);
  assert.equal(previewMarkdownImport('본문\n\n# 뒤에 오는 제목').suggestedTitle, '뒤에 오는 제목');
  assert.equal(previewMarkdownImport('제목이 없는 본문').suggestedTitle, '');
});
