import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AtlassianReader } from '../../server/atlassian-read.js';
import { AtlassianReadError, parseAtlassianLink } from '../../shared/atlassian-links.js';

function hasStatus(status: number) {
  return (error: unknown) => error instanceof AtlassianReadError && error.status === status;
}

async function listen(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function scratch(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-atlassian-read-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Atlassian browser URLs preserve only the host, context and supported item identity', () => {
  assert.deepEqual(parseAtlassianLink('jira', 'https://JIRA.example.test/jira/browse/ops-25?auth=discard#note'), {
    url: 'https://jira.example.test/jira/browse/OPS-25', origin: 'https://jira.example.test', contextPath: '/jira',
    product: 'jira', issueKey: 'OPS-25',
  });
  assert.deepEqual(parseAtlassianLink('confluence', 'https://wiki.example.test/company/docs/pages/viewpage.action?secret=discard&pageId=4902#section'), {
    url: 'https://wiki.example.test/company/docs/pages/viewpage.action?pageId=4902', origin: 'https://wiki.example.test', contextPath: '/company/docs',
    product: 'confluence', pageId: '4902',
  });
  assert.deepEqual(parseAtlassianLink('confluence', 'https://wiki.example.test/wiki/spaces/OPS/pages/4902/Release%20Notes?src=discard'), {
    url: 'https://wiki.example.test/wiki/spaces/OPS/pages/4902/Release%20Notes', origin: 'https://wiki.example.test', contextPath: '/wiki',
    product: 'confluence', pageId: '4902',
  });
  const display = parseAtlassianLink('confluence', 'https://wiki.example.test/wiki/display/OPS/Release+%2B+Notes');
  assert.deepEqual(display, {
    url: 'https://wiki.example.test/wiki/display/OPS/Release+%2B+Notes', origin: 'https://wiki.example.test', contextPath: '/wiki',
    product: 'confluence', spaceKey: 'OPS', title: 'Release + Notes',
  });
  assert.deepEqual(parseAtlassianLink(display.product, display.url), display);
  for (const [product, value] of [
    ['jira', 'https://user:password@jira.example.test/jira/browse/OPS-25'],
    ['jira', 'javascript:alert(1)'],
    ['jira', 'https:///jira.example.test/jira/browse/OPS-25'],
    ['jira', 'https://jira.example.test/jira%2Fother/browse/OPS-25'],
    ['jira', 'https://jira.example.test/jira/browse/OPS-25/transitions'],
    ['confluence', 'https://wiki.example.test/pages/viewpage.action?pageId=1&%70ageId=2'],
    ['confluence', 'https://wiki.example.test/wiki/spaces/OPS/pages/0'],
    ['confluence', 'https://wiki.example.test/wiki/display/OPS/Line%0ABreak'],
    ['other', 'https://example.test/browse/OPS-25'],
  ]) assert.throws(() => parseAtlassianLink(product, value), hasStatus(400));
});

test('preview reads bounded metadata from the configured Jira and Confluence contexts', async t => {
  const directory = scratch(t);
  const jiraAuthFile = join(directory, 'jira-auth');
  const confluenceAuthFile = join(directory, 'confluence-auth');
  const jiraHeader = 'Bearer jira-fixture-token';
  const confluenceHeader = `Basic ${Buffer.from('wiki-reader:wiki-fixture-password').toString('base64')}`;
  writeFileSync(jiraAuthFile, `${jiraHeader}\n`, { mode: 0o600 });
  writeFileSync(confluenceAuthFile, `${confluenceHeader}\r\n`, { mode: 0o600 });
  const requests: { method: string | undefined; url: URL; authorization: string | undefined; accept: string | undefined }[] = [];
  const page = {
    id: '4902', type: 'page', title: 'Release + Notes', status: 'current', space: { key: 'OPS' },
    version: { number: 4, when: '2026-11-20T10:00:00.000Z' }, body: { storage: { value: 'not returned' } },
  };
  const origin = await listen(t, (request, response) => {
    const url = new URL(request.url!, 'http://fixture.test');
    requests.push({ method: request.method, url, authorization: request.headers.authorization, accept: request.headers.accept });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/services/jira/rest/api/2/issue/OPS-25') {
      response.end(JSON.stringify({ key: 'OPS-26', fields: { summary: 'Review scheduling', status: { name: 'Open' },
        updated: '2026-11-20T19:00:00.000+0900', description: 'not returned' } }));
    } else if (url.pathname === '/wiki/rest/api/content/4902') response.end(JSON.stringify(page));
    else if (url.pathname === '/wiki/rest/api/content/4903') {
      response.end(JSON.stringify({ ...page, id: '4903', title: 'Returned wiki-fixture-password in title', status: 'wiki-reader' }));
    } else if (url.pathname === '/wiki/rest/api/content') {
      const title = url.searchParams.get('title');
      if (title === 'Missing') response.end(JSON.stringify({ results: [] }));
      else if (title === 'Ambiguous') response.end(JSON.stringify({ results: [page, page] }));
      else response.end(JSON.stringify({ results: [page] }));
    } else response.writeHead(404).end();
  });
  const reader = new AtlassianReader({
    NODE_ENV: 'test',
    DONEFAC_JIRA_BASE_URL: `${origin}/services/jira/`, DONEFAC_JIRA_AUTH_FILE: jiraAuthFile,
    DONEFAC_CONFLUENCE_BASE_URL: `${origin}/wiki`, DONEFAC_CONFLUENCE_AUTH_FILE: confluenceAuthFile,
  });
  const jira = await reader.preview('jira', `${origin}/services/jira/browse/ops-25?secret=discard`);
  assert.deepEqual(jira, { title: 'Review scheduling', locator: 'OPS-26', status: 'Open', updatedAt: '2026-11-20T10:00:00.000Z' });
  const confluence = await reader.preview('confluence', `${origin}/wiki/pages/viewpage.action?pageId=4902`);
  assert.deepEqual(confluence, {
    title: 'Release + Notes', locator: 'OPS · 4902 · v4', status: 'current', updatedAt: '2026-11-20T10:00:00.000Z',
  });
  assert.deepEqual(await reader.preview('confluence', `${origin}/wiki/display/OPS/Release+%2B+Notes`), confluence);
  assert.deepEqual(requests.map(({ method, url, authorization, accept }) => [method, url.pathname, authorization, accept]), [
    ['GET', '/services/jira/rest/api/2/issue/OPS-25', jiraHeader, 'application/json'],
    ['GET', '/wiki/rest/api/content/4902', confluenceHeader, 'application/json'],
    ['GET', '/wiki/rest/api/content', confluenceHeader, 'application/json'],
  ]);
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { fields: 'summary,status,updated' });
  assert.deepEqual(Object.fromEntries(requests[1].url.searchParams), { expand: 'version,space' });
  assert.deepEqual(Object.fromEntries(requests[2].url.searchParams), {
    expand: 'version,space', type: 'page', spaceKey: 'OPS', title: 'Release + Notes', limit: '2',
  });
  assert.deepEqual(await reader.preview('confluence', `${origin}/wiki/spaces/OPS/pages/4903`), {
    title: '[숨김]', locator: 'OPS · 4903 · v4', status: '[숨김]', updatedAt: '2026-11-20T10:00:00.000Z',
  });
  await assert.rejects(reader.preview('confluence', `${origin}/wiki/display/OPS/Missing`), hasStatus(404));
  await assert.rejects(reader.preview('confluence', `${origin}/wiki/display/OPS/Ambiguous`), hasStatus(409));
  await assert.rejects(reader.preview('confluence', `${origin}/wiki/display/OTHER/Release+%2B+Notes`), hasStatus(502));
});

test('preview keeps credentials scoped and cancels origin redirects, oversized bodies and interrupted requests', async t => {
  const directory = scratch(t);
  const authFile = join(directory, 'auth');
  const token = 'sensitive-echoed-token';
  writeFileSync(authFile, `Bearer ${token}`, { mode: 0o600 });
  let markInterrupted: () => void = () => {};
  const interrupted = new Promise<void>(resolve => { markInterrupted = resolve; });
  const requests: string[] = [];
  const origin = await listen(t, (request, response) => {
    const { pathname } = new URL(request.url!, 'http://fixture.test');
    requests.push(pathname);
    switch (pathname) {
      case '/jira/rest/api/2/issue/HOME-1':
        response.writeHead(302, { Location: '/disallowed' }).end(token);
        break;
      case '/jira/rest/api/2/issue/HOME-2':
        response.end(JSON.stringify({ key: 'HOME-2', fields: { summary: `${'a'.repeat(490)}${token}`, status: { name: token } } }));
        break;
      case '/jira/rest/api/2/issue/HOME-3':
        response.writeHead(403).end(token);
        break;
      case '/jira/rest/api/2/issue/HOME-4':
        response.write(' '.repeat(256 * 1024));
        response.end('{"key":"HOME-4"}');
        break;
      case '/jira/rest/api/2/issue/HOME-5':
        markInterrupted();
        break;
      default:
        response.writeHead(404).end();
    }
  });
  const reader = new AtlassianReader({
    NODE_ENV: 'test',
    DONEFAC_JIRA_BASE_URL: `${origin}/jira`,
    DONEFAC_JIRA_AUTH_FILE: authFile,
  });
  await assert.rejects(reader.preview('jira', `${origin}/other/browse/HOME-1`), hasStatus(403));
  await assert.rejects(reader.preview('jira', `${origin.replace('127.0.0.1', 'localhost')}/jira/browse/HOME-1`), hasStatus(403));
  await assert.rejects(new AtlassianReader({ NODE_ENV: 'test' }).preview('jira', `${origin}/jira/browse/HOME-1`), hasStatus(409));
  const linkedFile = join(directory, 'linked-auth');
  symlinkSync(authFile, linkedFile);
  await assert.rejects(new AtlassianReader({
    NODE_ENV: 'test',
    DONEFAC_JIRA_BASE_URL: `${origin}/jira`,
    DONEFAC_JIRA_AUTH_FILE: linkedFile,
  }).preview('jira', `${origin}/jira/browse/HOME-1`), hasStatus(503));
  chmodSync(authFile, 0o644);
  await assert.rejects(reader.preview('jira', `${origin}/jira/browse/HOME-1`), hasStatus(503));
  chmodSync(authFile, 0o600);
  writeFileSync(authFile, `Bearer ${token}\n\n`);
  await assert.rejects(reader.preview('jira', `${origin}/jira/browse/HOME-1`), hasStatus(503));
  writeFileSync(authFile, `Bearer ${token}`);
  assert.deepEqual(requests, []);

  const scopedPreview = (number: number, signal?: AbortSignal) => reader.preview('jira', `${origin}/jira/browse/HOME-${number}`, signal);
  await assert.rejects(scopedPreview(1), hasStatus(502));
  assert.deepEqual(requests, ['/jira/rest/api/2/issue/HOME-1']);
  assert.deepEqual(await scopedPreview(2), { title: '[숨김]', locator: 'HOME-2', status: '[숨김]', updatedAt: null });
  await assert.rejects(scopedPreview(3), (error: unknown) => hasStatus(403)(error) && !String(error).includes(token));
  await assert.rejects(scopedPreview(4), (error: unknown) => hasStatus(502)(error) && String(error).includes('크기 한도'));
  const controller = new AbortController();
  const reading = scopedPreview(5, controller.signal);
  await interrupted;
  controller.abort();
  await assert.rejects(reading, hasStatus(408));
});
