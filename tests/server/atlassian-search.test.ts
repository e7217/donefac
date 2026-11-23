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
    `${base}/wiki/browse/PLAN-42?token=${'x'.repeat(MAX_ATLASSIAN_LINK_URL_LENGTH)}`,
  ]) assert.equal(parseAtlassianSearchInput(invalid), null, invalid);
});
