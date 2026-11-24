import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'marked';
import type { LegacyRecord } from '../../shared/types.js';
import { record } from '../../server/legacy-import-model.js';
import { projectJiraDescription } from '../../server/migration-jira-description.js';
import type { MigrationContentContext } from '../../server/migration-content.js';

const owned = 'b7e7ff60-1459-42f7-a22b-dad014b870bf';
const foreign = '9b27ed0d-2bd2-4619-a98a-d99f2dfcd333';
const resolveReference: MigrationContentContext['resolveReference'] = input => {
  if (input.kind === 'issue' && input.sourceId === 'OLD-7') return { id: 'issue-new', label: '이관 업무' };
  if (input.kind !== 'attachment') return null;
  const id = input.title === 'owned.png' ? owned : input.title === 'foreign.png' ? foreign : undefined;
  return id ? { id, label: input.title!, url: `/api/attachments/${id}/content?inline=1` } : null;
};
const project = (text: string, textFormat: LegacyRecord['textFormat'], metadata: LegacyRecord['metadata'] = {}) =>
  projectJiraDescription(record('issue', '1', { title: '합성 Jira 업무', text, textFormat, metadata }), {
    resolveReference, ownsAttachment: id => id === owned,
  });

test('plain text and simple ADF keep plain storage and literal Markdown-looking text', () => {
  const plain = '*태그처럼 보이는 글자*\r\n\r\n<em>일반 원문</em>';
  const expected = plain.replaceAll('\r\n', '\n');
  assert.deepEqual(project(plain, 'plain'), { description: expected, diagnostics: [], reliable: true });
  const content = JSON.stringify({ type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: '*별표는 평문*' }] },
  ] });
  assert.deepEqual(project(content, 'adf'), { description: '*별표는 평문*', diagnostics: [], reliable: true });
});

test('ADF and Jira wiki project into editable Markdown with safe working links and inert media', () => {
  const adf = JSON.stringify({ type: 'doc', version: 1, content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '검토 절차' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: '검토 대상', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' · ' },
      { type: 'text', text: '안전 링크', marks: [{ type: 'link', attrs: { href: 'https://example.test/run?lang=ko&step=1' } }] },
      { type: 'text', text: ' · ' },
      { type: 'text', text: '위험 주소', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
    ] },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { url: 'https://example.test/image.png', alt: '원격 사진' } }] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const raw = "<script>";' }] },
  ] });
  const projected = project(adf, 'adf');
  assert.equal(projected.descriptionFormat, 'markdown');
  assert.equal(projected.reliable, true);
  assert.match(projected.description, /^## 검토 절차\n/u);
  assert.match(projected.description, /\*\*검토 대상\*\*/u);
  assert.ok(projected.description.includes('[안전 링크](https://example.test/run?lang=ko&step=1)'));
  const html = parse(projected.description, { async: false });
  assert.doesNotMatch(html, /<img|<script|href="javascript:/iu);
  assert.ok(projected.diagnostics.some(item => item.code === 'REMOTE_IMAGE_NOT_EMBEDDED'));

  const wiki = project('h2. 설치 내역\n\n[OLD-7]\n\n[^owned.png]\n\n!owned.png!\n\n[^foreign.png]', 'jira-wiki');
  assert.equal(wiki.descriptionFormat, 'markdown');
  assert.match(wiki.description, /\[이관 업무\]\(\/#\/all\/issues\?issue=issue-new\)/u);
  assert.ok(wiki.description.includes(`/api/attachments/${owned}/content`));
  assert.ok(!wiki.description.includes(foreign));
  assert.doesNotMatch(wiki.description, /!\[/u);
});

test('formatted ADF anchor labels and existing cards and Wiki links stay usable in ticket Markdown', () => {
  const url = 'https://jira.example.test/jira/browse/OLD-7';
  const external = 'https://other.example.test/jira/browse/OLD-7';
  const comment = `${url}?focusedCommentId=8#comment-8`;
  const recordOf = (body: string, format: LegacyRecord['textFormat']) => record('issue', '1', { text: body, textFormat: format });
  const called: string[] = [];
  const options = {
    resolveReference(input: Parameters<typeof resolveReference>[0]) {
      if (input.url) called.push(input.url);
      return input.kind === 'issue' && input.url === url ? { id: 'issue-new', label: '이관한 티켓' } : null;
    },
    ownsAttachment: () => false,
  };
  const marked = (text: string, href: string) => ({ type: 'text', text, marks: [{ type: 'strong' }, { type: 'link', attrs: { href } }] });
  const adf = JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [marked('굵은 링크 이름', url)] },
    { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url } }] },
    { type: 'paragraph', content: [marked('댓글 확인', comment)] },
  ] });
  const projected = projectJiraDescription(recordOf(adf, 'adf'), options);
  const html = parse(projected.description, { async: false });
  assert.match(html, /<a href="\/#\/all\/issues\?issue=issue-new">(?:<strong>)?굵은 링크 이름/u);
  assert.match(html, /<strong>/u);
  assert.match(html, /<a href="\/#\/all\/issues\?issue=issue-new">이관한 티켓<\/a>/u);
  assert.ok(html.includes(`href="${comment}"`));
  assert.ok(!called.includes(comment));
  assert.deepEqual(projected.diagnostics, []);
  const wiki = projectJiraDescription(recordOf(`[원래 이름|${url}] [다른 설치|${external}]`, 'jira-wiki'), options);
  assert.equal(wiki.description.replace(/\s+/gu, ' '), `[원래 이름](/#/all/issues?issue=issue-new) [다른 설치](${external})`);
  assert.deepEqual(wiki.diagnostics, []);
});

test('Jira search-rendered HTML is normalized only when its source identifies the representation', () => {
  const html = '<p><strong>원본 굵게</strong> <a href="https://example.test/help">도움말</a></p>' +
    '<ul><li>업무 하나</li><li>업무 둘</li></ul><img src="https://example.test/remote.png" alt="가져오지 않은 사진"/>';
  const source = { descriptionFormat: 'search-rendered-html' };
  const converted = project(html, 'plain', source);
  assert.equal(converted.descriptionFormat, 'markdown');
  assert.equal(converted.reliable, true);
  assert.match(converted.description, /\*\*원본 굵게\*\* \[도움말\]\(https:\/\/example\.test\/help\)/u);
  assert.match(converted.description, /- 업무 하나\n- 업무 둘/u);
  assert.doesNotMatch(parse(converted.description, { async: false }), /<img/iu);
  assert.equal(project(html, 'plain').description, html);
  const malformed = '<p><strong>닫히지 않은 본문';
  assert.deepEqual(project(malformed, 'plain', source), { description: malformed, reliable: false, diagnostics: [
    { code: 'RAW_CONTENT_FALLBACK', severity: 'warning', message: '원본 구조를 안전하게 변환할 수 없어 실행하지 않는 원문 코드 블록으로 보존했습니다.' },
  ] });
});
