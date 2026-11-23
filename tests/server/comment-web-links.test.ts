import assert from 'node:assert/strict';
import test from 'node:test';
import { commentWebLinkRanges, commentWebUrl } from '../../shared/comment-web-links.js';

test('comment web links keep exact UTF-16 ranges across emoji, bracketed URLs and surrounding punctuation', () => {
  const pipeline = 'https://gitlab.example.test/team/repo/-/pipelines/42?label=한글,&status=ok!';
  const manual = 'https://docs.example.test/a_(b)#release';
  const ipv6 = 'http://[2001:db8::1]:8080/api';
  const clinic = 'HTTPS://team.example.test/display/운영';
  const body = `📎 CI 결과 <${pipeline}>에서 보세요. 문서(${manual})를 확인하세요. 다음 ${ipv6},\n“${clinic}”`;
  const expected = [pipeline, manual, ipv6, clinic].map(href => ({ from: body.indexOf(href), to: body.indexOf(href) + href.length, href }));
  assert.deepEqual(commentWebLinkRanges(body), expected);
  assert.deepEqual(commentWebLinkRanges(`${ipv6}, ${manual}).`), [
    { from: 0, to: ipv6.length, href: ipv6 },
    { from: ipv6.length + 2, to: ipv6.length + 2 + manual.length, href: manual },
  ]);
});

test('only explicit credential-free HTTP or HTTPS becomes an active comment link', () => {
  const invalid = ['javascript:alert(1)', 'data:text/plain,ok', 'mailto:team@example.test', '//gitlab.example.test',
    '/#/all/documents/id', 'https:///gitlab.example.test', 'https://token@source.example.test/project',
    'https://@source.example.test/', 'https://source.example.test\\@other.example.test/', 'https:// source.example.test',
    'https://source.example.test/\u0000value', 'https://source.example.test/\u202evalue', 'https://source.example.test/\ud800',
    'https://source.example.test/<a>', 'https://source.example.test/"a"'];
  for (const value of invalid) assert.equal(commentWebUrl(value), undefined, value);
  assert.equal(commentWebUrl('  https://ci.example.test/!  '), 'https://ci.example.test/!');
  const rejected = '붙여쓴 abchttps://source.example.test javascript:https://source.example.test https://u:p@other.test';
  assert.deepEqual(commentWebLinkRanges(rejected), []);
});
