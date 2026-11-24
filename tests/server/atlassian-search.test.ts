import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ATLASSIAN_LINK_URL_LENGTH } from '../../shared/atlassian-links.js';
import { parseAtlassianSearchInput, sameAtlassianSearchAddress } from '../../shared/atlassian-search.js';

function address(url: string) {
  const parsed = parseAtlassianSearchInput(url);
  assert.ok(parsed, url);
  return parsed;
}

test('Jira search canonicalizes issue keys without crossing source origin or installation path', () => {
  const input = address('  HTTPS://JIRA.EXAMPLE.TEST:443/jira/browse/ops_1%2d42?session=discard#comment  ');
  assert.deepEqual(input, {
    product: 'jira',
    issueKey: 'OPS_1-42',
    origin: 'https://jira.example.test',
    contextPath: '/jira',
    url: 'https://jira.example.test/jira/browse/OPS_1-42',
  });
  assert.ok(sameAtlassianSearchAddress(input, address('https://jira.example.test/jira/browse/OPS_1-42/')));
  for (const other of [
    'http://jira.example.test/jira/browse/OPS_1-42',
    'https://jira.example.test:9443/jira/browse/OPS_1-42',
    'https://old.example.test/jira/browse/OPS_1-42',
    'https://jira.example.test/Jira/browse/OPS_1-42',
    'https://jira.example.test/browse/OPS_1-42',
    'https://jira.example.test/jira/browse/OPS_1-43',
    'https://jira.example.test/jira/pages/viewpage.action?pageId=42',
  ]) assert.equal(sameAtlassianSearchAddress(input, address(other)), false, other);
});

test('Jira comment permalinks preserve the exact comment across supported source forms', () => {
  const base = 'https://jira.example.test/jira/browse/OPS-42';
  const commentId = '90071992547409931234';
  const canonical = `${base}?focusedCommentId=${commentId}`;
  for (const url of [
    canonical, `${base}?focusedCommentId=${commentId}&page=issuetabpanels%3Acomment-tabpanel#comment-${commentId}`,
    `${base}#%63omment%2D${commentId}`, `${base}?tracking=excluded#comment-${commentId}`,
    `${base}?focusedId=${commentId}#comment-${commentId}`,
  ]) {
    const parsed = address(url);
    assert.equal(parsed.product, 'jira');
    assert.equal(parsed.commentId, commentId, url);
    assert.equal(parsed.url, canonical, url);
    assert.deepEqual(address(canonical), parsed);
    assert.ok(sameAtlassianSearchAddress(parsed, address(base)));
  }
  assert.equal(address(`${base}?page=issuetabpanels%3Acomment-tabpanel#comments`).commentId, undefined);
});

test('Jira rejects malformed or inconsistent comment selectors without falling back to the ticket', () => {
  const issue = 'https://jira.example.test/jira/browse/OPS-42';
  for (const suffix of [
    '?focusedCommentId=', '?focusedCommentId=0', '?focusedCommentId=09', '?focusedCommentId=9.1',
    '?focusedCommentId=9&%66ocusedCommentId=9', '?focusedCommentId=9#comment-10', '?focusedCommentId=9#comment-9/extra',
    '?commentId=9', '?inlineCommentId=9#comment-9', '?FocusedCommentId=9', '#comment-0', '#comment-09', '#Comment-9', '#comment-%GG',
    '?focusedId=9', '?focusedId=9#comments', '?focusedId=8#comment-9', '?focusedId=9&focusedId=9#comment-9',
    '?focusedId=9&focusedCommentId=9#comment-9', '?FocusedId=9#comment-9',
  ]) assert.equal(parseAtlassianSearchInput(`${issue}${suffix}`), null, suffix);
});

test('numeric Confluence locators match across page URL forms without rounding long IDs', () => {
  const pageId = '90071992547409931234';
  const base = 'https://kb.example.test/wiki';
  const legacy = address(`${base}/pages/viewpage.action?previewToken=discard&pageId=${pageId}#section`);
  const modern = address(`${base}/spaces/SPACE/pages/${pageId}/Renamed%20page?pageId=${pageId}&tracking=discard#section`);
  assert.equal(legacy.url, `${base}/pages/viewpage.action?pageId=${pageId}`);
  assert.equal(modern.url, `${base}/spaces/SPACE/pages/${pageId}/Renamed%20page`);
  assert.ok(sameAtlassianSearchAddress(legacy, modern));
  assert.ok(sameAtlassianSearchAddress(modern, address(`${base}/spaces/OTHER/pages/${pageId}`)));
  assert.equal(sameAtlassianSearchAddress(legacy, address(`${base}/spaces/SPACE/pages/90071992547409931235`)), false);
  assert.equal(sameAtlassianSearchAddress(legacy, address(
    `https://kb.example.test/other/spaces/SPACE/pages/${pageId}/Renamed%20page`,
  )), false);
});

test('Confluence Server tiny links decode to exact page IDs and retain the verified installation identity', () => {
  const base = 'https://kb.example.test/wiki';
  for (const [token, pageId] of [
    ['ZIAB', '98404'], // The matching Tiny Link and pageId in Atlassian's Confluence URL format examples.
    ['y', '200'],
    ['_w', '251'],
    ['-w', '255'],
    ['AQAAAAAAI', '9007199254740993'],
    ['---------38', '9223372036854775807'],
  ]) {
    const expected = `${base}/pages/viewpage.action?pageId=${pageId}`;
    const parsed = address(`${base}/x/${token}?pageId=${pageId}&tracking=hidden#section`);
    assert.deepEqual(parsed, { product: 'confluence', origin: 'https://kb.example.test', contextPath: '/wiki', url: expected, pageId });
    assert.ok(sameAtlassianSearchAddress(parsed, address(expected)));
    assert.equal(sameAtlassianSearchAddress(parsed, address(`${base}/elsewhere/x/${token}`)), false);
    assert.equal(sameAtlassianSearchAddress(parsed, address(expected.replace('kb.example', 'other.example'))), false);
  }
});

test('Confluence display locators use the exact decoded source space and title', () => {
  const base = 'https://kb.example.test/confluence';
  const canonical = address(`${base}/display/PLAN/Team+%2B+%EC%9A%B4%EC%98%81%2FNotes?token=discard#heading`);
  assert.deepEqual(canonical, {
    product: 'confluence',
    spaceKey: 'PLAN',
    title: 'Team + 운영/Notes',
    origin: 'https://kb.example.test',
    contextPath: '/confluence',
    url: `${base}/display/PLAN/Team+%2B+%EC%9A%B4%EC%98%81%2FNotes`,
  });
  assert.ok(sameAtlassianSearchAddress(canonical, address(`${base}/display/PLAN/Team%20%2B%20운영%2FNotes`)));
  for (const other of [
    `${base}/display/plan/Team+%2B+운영%2FNotes`,
    `${base}/display/PLAN/team+%2B+운영%2FNotes`,
    `${base}/spaces/PLAN/pages/42/Team+%2B+운영%2FNotes`,
  ]) assert.equal(sameAtlassianSearchAddress(canonical, address(other)), false, other);
});

test('Confluence comment permalinks preserve one exact selector across canonical page forms', () => {
  const base = 'https://kb.example.test/wiki';
  const commentId = '90071992547409931234';
  const numeric = `${base}/pages/viewpage.action?pageId=42`;
  const display = `${base}/display/PLAN/Release+notes`;
  const modern = `${base}/spaces/PLAN/pages/42/Release%20notes`;
  for (const [input, canonical] of [
    [`${numeric}&focusedCommentId=${commentId}&tracking=discard#comment-${commentId}`, `${numeric}&focusedCommentId=${commentId}`],
    [`${display}?tracking=discard#comment-${commentId}`, `${display}?focusedCommentId=${commentId}`],
    [`${display}?focusedCommentId=${commentId}#heading`, `${display}?focusedCommentId=${commentId}`],
    [`${modern}?focusedCommentId=${commentId}`, `${modern}?focusedCommentId=${commentId}`],
    [`${base}/x/ZIAB#%63omment%2D${commentId}`, `${base}/pages/viewpage.action?pageId=98404&focusedCommentId=${commentId}`],
  ]) {
    const parsed = address(input);
    assert.equal(parsed.commentId, commentId, input);
    assert.equal(parsed.url, canonical, input);
    assert.deepEqual(address(canonical), parsed, input);
  }
  assert.equal(address(`${display}#comments`).commentId, undefined);
  assert.equal(address(`${display}#release-comment-42`).url, display);
  assert.ok(sameAtlassianSearchAddress(address(`${numeric}&focusedCommentId=9`), address(`${modern}#comment-10`)));
});

test('invalid Confluence comment selectors never fall back to the page locator', () => {
  const page = 'https://kb.example.test/wiki/display/PLAN/Release+notes';
  for (const suffix of [
    '?focusedCommentId=', '?focusedCommentId=0', '?focusedCommentId=042', '?focusedCommentId=2.1',
    '?focusedCommentId=9&focusedCommentId=9', '?focusedCommentId=9&%66ocusedCommentId=9',
    '?focusedCommentId=9#comment-10', '?focusedCommentId=9#comment-9/extra',
    '?commentId=9', '?inlineCommentId=9#comment-9', '?FocusedCommentId=9', '?focusedCommentId=9&commentId=9',
    '#comment-', '#comment-zero', '#comment-0', '#comment-09', '#comment-9%00', '#Comment-9', '#inline-comment-9', '#%63omment-%GG',
  ]) assert.equal(parseAtlassianSearchInput(`${page}${suffix}`), null, suffix);

  const prefix = 'https://kb.example.test/wiki/spaces/PLAN/pages/42/';
  const fragment = '#comment-42';
  const tooLongAfterCanonicalization = `${prefix}${'a'.repeat(MAX_ATLASSIAN_LINK_URL_LENGTH - prefix.length - fragment.length)}${fragment}`;
  assert.equal(parseAtlassianSearchInput(tooLongAfterCanonicalization), null);
});

test('malformed source addresses never become canonical lookup input', () => {
  const base = 'https://kb.example.test';
  for (const invalid of [
    'PLAN-42',
    '//kb.example.test/wiki/browse/PLAN-42',
    'https://user:pass@kb.example.test/wiki/browse/PLAN-42',
    'https://@kb.example.test/wiki/browse/PLAN-42',
    'https://kb.example.test:99999/wiki/browse/PLAN-42',
    'https://kb.example.test\\wiki/browse/PLAN-42',
    'https://kb.example.test\n/wiki/browse/PLAN-42',
    `${base}/outside/../wiki/browse/PLAN-42`,
    `${base}/outside/%2e%2E/wiki/browse/PLAN-42`,
    `${base}/wiki/./pages/viewpage.action?pageId=42`,
    `${base}/wiki/%2e/pages/viewpage.action?pageId=42`,
    `${base}/wiki/display/PLAN/title%2F..%2Fnotes`,
    `${base}/wiki/display/PLAN/invalid%GGtitle`,
    `${base}/wiki/display/PLAN/title\ud800`,
    `${base}/wiki/pages/viewpage.action?pageId=42&pageId=42`,
    `${base}/wiki/pages/viewpage.action?pageId=0`,
    `${base}/wiki/spaces/PLAN/pages/42?pageId=43`,
    `${base}/wiki/spaces/PLAN/pages/42?pageId=42&pageId=42`,
    `${base}/wiki/display/PLAN/Title?pageId=42`,
    `${base}/wiki/x/A`,
    `${base}/wiki/x/AAAAAAAAAAA`,
    `${base}/wiki/x/AAAAAAAAAAAB`,
    `${base}/wiki/x/AAAAAAAAAI`,
    `${base}/wiki/x/ZIABA`,
    `${base}/wiki/x/---------39`,
    `${base}/wiki/x/%5AIAB`,
    `${base}/wiki/x/ZIAB=`,
    `${base}/wiki/x/ZIAB?pageId=98405`,
    `${base}/wiki/x/ZIAB?pageId=98404&pageId=98404`,
    `${base}/other/../wiki/x/ZIAB`,
    `${base}/wiki/browse/PLAN-42?token=${'x'.repeat(MAX_ATLASSIAN_LINK_URL_LENGTH)}`,
  ]) assert.equal(parseAtlassianSearchInput(invalid), null, invalid);
});
