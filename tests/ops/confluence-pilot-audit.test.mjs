import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import { parseConfluenceFindings } from '../../scripts/pilot-migration-confluence-findings.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../../scripts/confluence-pilot-audit.mjs', import.meta.url));
const run = promisify(execFile);
const context = '/tools/wiki';
const apiPath = `${context}/rest/api`;
const listing = `${apiPath}/space/WIKI/content/page`;
const authValue = 'Bearer synthetic-private-wiki-token';
const privateTitle = 'Synthetic private source page title';
const privateBody = 'Synthetic private source document body';
const privateGroup = 'synthetic-private-wiki-group';
const privateUsername = 'synthetic-private-wiki-user';
const privateFilename = 'synthetic-private-binary-name.txt';
const attachment = Buffer.from([0, 1, 2, 127, 255]);
const root = { id: '100', version: 2, ancestors: [] };
const child = { id: '101', version: 1, ancestors: ['100'] };

function property(name, value) { return `<property name="${name}">${value}</property>`; }
function reference(name, type, id) { return `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`; }
function object(type, id, properties) { return `<object class="${type}"><id name="id">${id}</id>${properties}</object>`; }

function nativeExport(pages = [root, child], { extras = false, restricted = [], spaceId = '42', includeBinary = true,
  spacePermission = false, omitBody = [], otherSpaceId } = {}) {
  const space = object('Space', spaceId, property('key', 'WIKI') + property('name', 'Fixture Wiki'));
  const otherSpace = otherSpaceId ? object('Space', otherSpaceId, property('key', 'OTHER')) : '';
  function pageRows(page, originalId) {
    const parent = page.ancestors.at(-1);
    const owner = page.spaceId === undefined ? spaceId : page.spaceId;
    return [object('Page', page.id, property('contentStatus', originalId ? 'historical' : 'current') +
      property('title', `${privateTitle} ${page.id}`) + property('version', page.version) + (owner ? reference('space', 'Space', owner) : '') +
      (parent ? reference('parent', 'Page', parent) : '') + (originalId ? reference('originalVersion', 'Page', originalId) : '')),
    ...(omitBody.includes(page.id) ? [] :
      [object('BodyContent', `9${page.id}`, property('body', `<![CDATA[<p>${privateBody}</p>]]>`) + reference('content', 'Page', page.id))])];
  }
  const rows = pages.flatMap(page => pageRows(page));
  const files = [];
  if (extras) {
    rows.push(...pageRows({ id: '200', version: 1, ancestors: [] }, root.id));
    rows.push(object('Attachment', '700', property('title', privateFilename) + property('version', '1') +
      property('contentStatus', 'current') + property('fileSize', attachment.length) + reference('containerContent', 'Page', child.id)));
    if (includeBinary) files.push({ path: 'attachments/101/700/1', bytes: attachment });
  }
  for (const [index, id] of restricted.entries()) {
    rows.push(object('ContentPermissionSet', `80${index}`, property('type', 'View') + reference('owningContent', 'Page', id)));
  }
  if (spacePermission) rows.push(object('SpacePermission', '900', property('type', 'VIEWSPACE') + reference('space', 'Space', spaceId)));
  return zip([{ path: 'native/entities.xml', bytes: Buffer.from(`<hibernate-generic>${space}${otherSpace}${rows.join('')}</hibernate-generic>`) },
    ...files.map(file => ({ ...file, path: `native/${file.path}` }))]);
}

async function serve(t, handler) {
  const requests = [], errors = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    requests.push({ url, method: request.method, authorization: request.headers.authorization });
    const json = (value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    try { handler({ url, request, response, json }); }
    catch (error) { errors.push(error); json({ error: 'synthetic fixture assertion failed' }, 500); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, errors };
}

function pageValue(page, origin, spaceKey = 'WIKI') {
  return { id: page.id, type: 'page', status: 'current', title: privateTitle, space: { id: 42, key: spaceKey },
    version: { number: page.version, by: { username: privateUsername } },
    ancestors: page.ancestors.map(id => ({ id, type: 'page', status: 'current' })),
    _links: { self: `${origin}${apiPath}/content/${page.id}`, base: `${origin}${context}` } };
}

function pageEnvelope(results, start, limit, url, more) {
  const query = new URLSearchParams(url.search);
  query.set('start', start + results.length);
  query.set('limit', limit);
  return { results, start, limit, size: results.length,
    _links: { self: url.href, ...(more ? { next: `${url.pathname}?${query}` } : {}) } };
}

async function fixture(t, { pages = [root, child], listed = pages, listingOverride, restrictionOverride, documentOverride } = {}) {
  const byId = new Map(pages.map(page => [page.id, page]));
  return serve(t, ({ url, request, response, json }) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, authValue);
    const expand = (url.searchParams.get('expand') || '').split(',');
    if (url.pathname === listing) {
      assert.deepEqual(new Set(expand), new Set(['space', 'version', 'ancestors']));
      const start = Number(url.searchParams.get('start'));
      const values = listed.slice(start, start + 1).map(page => pageValue(page, url.origin));
      const envelope = pageEnvelope(values, start, 1, url, start + values.length < listed.length);
      return json(listingOverride?.({ envelope, start, url }) ?? envelope);
    }
    const relative = url.pathname.slice(apiPath.length);
    const [, id, operation] = /^\/content\/([0-9]+)(?:\/restriction\/byOperation\/(read|update))?$/.exec(relative) ?? [];
    const page = byId.get(id);
    if (!page) return json({ message: privateBody }, 404);
    if (!operation) {
      assert.deepEqual(new Set(expand), new Set(['space', 'version', 'ancestors']));
      const value = pageValue(page, url.origin);
      return json(documentOverride?.({ value, id }) ?? value);
    }
    assert.deepEqual(new Set(expand), new Set(['restrictions.user', 'restrictions.group']));
    const start = Number(url.searchParams.get('start'));
    const limit = Number(url.searchParams.get('limit')) || 100;
    const empty = () => pageEnvelope([], start, limit, url, false);
    const envelope = { operation, restrictions: { user: empty(), group: empty() }, _links: { self: url.href } };
    if (restrictionOverride?.({ url, id, operation, envelope, response, json })) return;
    return json(envelope);
  });
}

async function invocation(t, baseUrl, { pageIds, archive } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'teamspace-confluence-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'source.json');
  const exportPath = join(directory, 'native-private-source.zip');
  await writeFile(join(directory, 'confluence-auth'), `${authValue}\n`, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ baseUrl, authFile: 'confluence-auth', spaceKey: 'WIKI', ...(pageIds ? { pageIds } : {}) }), { mode: 0o600 });
  if (archive) await writeFile(exportPath, archive, { mode: 0o600 });
  const args = ['--import', 'tsx', cli, config, ...(archive ? [exportPath] : [])];
  async function audit(...options) {
    try { return { code: 0, ...await run(process.execPath, [...args, ...options], { cwd: repo, timeout: 30_000 }) }; }
    catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }
  return { directory, exportPath, audit };
}

function assertPrivate(result, directory) {
  for (const value of [authValue, authValue.split(' ')[1], privateTitle, privateBody, privateGroup, privateUsername, privateFilename,
    'native-private-source.zip', directory]) {
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(value), `Output retained sensitive fixture value ${value}`);
  }
}

function assertCounts(report, expected) {
  for (const [key, count] of Object.entries(expected)) assert.equal(report[key], count, key);
}

async function assertFindings(path, { directory, archive, status, selection, findings, unidentifiedPages = 0, coverage, permissionCheckedPageIds }) {
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const raw = await readFile(path, 'utf8');
  assertPrivate({ stdout: raw, stderr: '' }, directory);
  const { checkedAt, ...report } = parseConfluenceFindings(JSON.parse(raw));
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.deepEqual(report, {
    format: 'teamspace-confluence-audit-findings', version: 3, selection, status,
    archive: { sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length },
    spacePermissions: 'manual-review', unidentifiedPages, findings, coverage, permissionCheckedPageIds,
  });
  return raw;
}

test('native Confluence ZIP matches paged live metadata without reading document bodies or writing an export', async t => {
  const source = await fixture(t, { listingOverride: ({ envelope }) => {
    if (envelope._links.next) envelope._links.next = envelope._links.next.slice(context.length);
    return envelope;
  } });
  const archive = nativeExport([root, child], { extras: true });
  const { directory, exportPath, audit } = await invocation(t, source.origin + context, { archive });
  const result = await audit();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivate(result, directory);
  const report = JSON.parse(result.stdout);
  assertCounts(report, { status: 'matched', selection: 'visible-space', visiblePages: 2, unavailablePages: 0, restrictedPages: 0,
    unknownRestrictions: 0, spacePermissions: 'manual-review' });
  assertCounts(report.archive, { sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length,
    pages: 2, totalCurrentPages: 2, matchedPages: 2, permissionCheckedPages: 2, missingPages: 0, archiveOnlyPages: 0,
    versionMismatches: 0, hierarchyMismatches: 0,
    restrictionMismatches: 0, archivedRestrictedPages: 0, missingPageBodies: 0, attachments: 1, attachmentBinaries: 1,
    attachmentEvidenceProblems: 0, analysisErrors: 0, needsReview: false });
  assert.deepEqual(source.requests.filter(({ url }) => url.pathname === listing).map(({ url }) => url.searchParams.get('start')), ['0', '1']);
  for (const id of [root.id, child.id]) {
    assert.ok(source.requests.some(({ url }) => url.pathname === `${apiPath}/content/${id}/restriction/byOperation/read`));
    assert.ok(source.requests.some(({ url }) => url.pathname === `${apiPath}/content/${id}/restriction/byOperation/update`));
  }
  assert.deepEqual(await readdir(directory), ['confluence-auth', 'native-private-source.zip', 'source.json']);
  assert.deepEqual(await readFile(exportPath), archive);

  const findingsPath = join(directory, 'private-review.json');
  const detailed = await audit('--findings', findingsPath);
  assert.equal(detailed.code, 0, detailed.stdout + detailed.stderr);
  assert.equal(detailed.stdout, result.stdout);
  assertPrivate(detailed, directory);
  await assertFindings(findingsPath, { directory, archive, status: 'matched', selection: 'visible-space', findings: [],
    permissionCheckedPageIds: [root.id, child.id],
    coverage: { archivePages: 2, matchedPages: 2, permissionCheckedPages: 2, outsideSelectionPages: 0, otherSpacePages: 0, unassignedPages: 0 } });
  assert.deepEqual(await readFile(exportPath), archive);
});

test('audit distinguishes live-only and export-only pages, changed versions and changed parents', async t => {
  const rest = [{ ...root, version: 3 }, child, { id: '102', version: 1, ancestors: [] }];
  const archive = nativeExport([root, { ...child, ancestors: ['103'] }, { id: '103', version: 1, ancestors: [] }]);
  const source = await fixture(t, { pages: rest });
  const { directory, audit } = await invocation(t, source.origin + context, { archive });
  const result = await audit();
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivate(result, directory);
  const report = JSON.parse(result.stdout);
  assertCounts(report, { status: 'needs-review', visiblePages: 3 });
  assertCounts(report.archive, { pages: 3, matchedPages: 2, missingPages: 1, archiveOnlyPages: 1, versionMismatches: 1,
    hierarchyMismatches: 1, needsReview: true });
});

test('optional findings preserve aggregate stdout and list the selected page IDs and differences', async t => {
  const liveOnly = { id: '90', version: 1, ancestors: [] };
  const archiveOnly = { id: '103', version: 1, ancestors: [] };
  const unidentified = { id: 'synthetic-private-unidentified-id', version: 1, ancestors: [] };
  const rest = [child, { ...root, version: 3 }, liveOnly];
  const archive = nativeExport([archiveOnly, unidentified, root, { ...child, ancestors: [archiveOnly.id] }],
    { extras: true, restricted: [child.id], includeBinary: false, omitBody: [child.id] });
  const source = await fixture(t, { pages: rest });
  const { directory, audit } = await invocation(t, source.origin + context, { archive });
  const findingsPath = join(directory, 'private-review.json');
  const aggregate = await audit();
  const detailed = await audit('--findings', findingsPath);
  assert.equal(detailed.code, 2, detailed.stdout + detailed.stderr);
  assert.equal(detailed.stdout, aggregate.stdout);
  assert.deepEqual(source.errors, []);
  assertPrivate(detailed, directory);
  assert.ok(!detailed.stdout.includes('"pageId"'));
  assert.ok(!detailed.stdout.includes('"permissionCheckedPageIds"'));
  const raw = await assertFindings(findingsPath, { directory, archive, status: 'needs-review', selection: 'visible-space', unidentifiedPages: 1,
    permissionCheckedPageIds: [root.id, child.id],
    coverage: { archivePages: 4, matchedPages: 2, permissionCheckedPages: 2, outsideSelectionPages: 0, otherSpacePages: 0, unassignedPages: 0 }, findings: [
    { pageId: liveOnly.id, codes: ['MISSING_FROM_ARCHIVE'] },
    { pageId: root.id, codes: ['VERSION_MISMATCH'] },
    { pageId: child.id, codes: ['ARCHIVE_RESTRICTED', 'ATTACHMENT_EVIDENCE_PROBLEM', 'HIERARCHY_MISMATCH', 'MISSING_ARCHIVE_BODY', 'RESTRICTION_MISMATCH'] },
    { pageId: archiveOnly.id, codes: ['ARCHIVE_ONLY_PAGE'] },
  ] });
  assert.ok(!raw.includes(source.origin));
  assert.ok(!raw.includes(unidentified.id));
  assert.ok(!detailed.stdout.includes(unidentified.id));
});

test('explicit selection checks inherited restrictions outside the selection and preserves other selected evidence', async t => {
  const source = await fixture(t, { restrictionOverride({ id, operation, envelope, url, json }) {
    if (id !== root.id || operation !== 'read') return false;
    envelope.restrictions.group = pageEnvelope([{ id: 'group-id', type: 'group', name: privateGroup }], 0, 100, url, false);
    json(envelope);
    return true;
  } });
  for (const [archiveRestriction, restrictionMismatches, codes] of [
    [[root.id], 0, ['ARCHIVE_RESTRICTED', 'LIVE_RESTRICTED']],
    [[], 1, ['LIVE_RESTRICTED', 'RESTRICTION_MISMATCH']],
  ]) {
    const archive = nativeExport([root, child], { restricted: archiveRestriction });
    const { directory, audit } = await invocation(t, source.origin + context, { pageIds: [child.id], archive });
    const findingsPath = join(directory, 'private-review.json');
    const result = await audit('--findings', findingsPath);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assertPrivate(result, directory);
    const report = JSON.parse(result.stdout);
    assertCounts(report, { status: 'needs-review', selection: 'explicit-pages', visiblePages: 1, restrictedPages: 1, unknownRestrictions: 0 });
    assertCounts(report.archive, { outsideSelectionPages: 1, missingPages: 0, archiveOnlyPages: 0, restrictionMismatches });
    await assertFindings(findingsPath, { directory, archive, status: 'needs-review', selection: 'explicit-pages',
      permissionCheckedPageIds: [child.id],
      coverage: { archivePages: 2, matchedPages: 1, permissionCheckedPages: 1, outsideSelectionPages: 1, otherSpacePages: 0, unassignedPages: 0 },
      findings: [{ pageId: child.id, codes }] });
  }
  assert.deepEqual(source.errors, []);
  assert.ok(!source.requests.some(({ url }) => url.pathname === listing));
  assert.ok(source.requests.some(({ url }) => url.pathname === `${apiPath}/content/${root.id}`));
  assert.ok(source.requests.some(({ url }) => url.pathname === `${apiPath}/content/${root.id}/restriction/byOperation/read`));
});

test('findings report uncovered ZIP pages even when the selection matches without any findings', async t => {
  const source = await fixture(t);
  const otherSpace = { id: '801', version: 1, ancestors: [], spaceId: '99' };
  const archive = nativeExport([root, child, otherSpace], { otherSpaceId: otherSpace.spaceId });
  const { directory, audit } = await invocation(t, source.origin + context, { pageIds: [root.id], archive });
  const findingsPath = join(directory, 'private-review.json');
  const result = await audit('--findings', findingsPath);
  assert.equal(result.code, 0, result.stderr);
  const expected = { archivePages: 3, matchedPages: 1, permissionCheckedPages: 1, outsideSelectionPages: 1, otherSpacePages: 1, unassignedPages: 0 };
  await assertFindings(findingsPath, { directory, archive, status: 'matched', selection: 'explicit-pages', findings: [],
    permissionCheckedPageIds: [root.id], coverage: expected });
  assertCounts(JSON.parse(result.stdout).archive, { totalCurrentPages: 3, matchedPages: 1, permissionCheckedPages: 1,
    outsideSelectionPages: 1, otherSpacePages: 1, unassignedPages: 0 });
  assert.deepEqual(source.errors, []);
});

test('unsupported or incomplete permission evidence keeps the current page and descendants under review', async t => {
  for (const [name, override] of [
    ['permission endpoint unavailable', ({ json }) => json({ message: privateBody }, 404)],
    ['permission groups missing', ({ envelope, json }) => { delete envelope.restrictions.group; json(envelope); }],
  ]) {
    await t.test(name, async inner => {
      const source = await fixture(inner, { restrictionOverride(args) {
        if (args.operation !== 'read' || args.id !== root.id) return false;
        override(args);
        return true;
      } });
      const { directory, audit } = await invocation(inner, source.origin + context);
      const result = await audit();
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.deepEqual(source.errors, []);
      assertPrivate(result, directory);
      assertCounts(JSON.parse(result.stdout), { status: 'needs-review', visiblePages: 2, unknownRestrictions: 2 });
      assert.deepEqual(await readdir(directory), ['confluence-auth', 'source.json']);
    });
  }
});

test('a direct edit restriction requires review only for its own selected page', async t => {
  const source = await fixture(t, { restrictionOverride({ id, operation, envelope, url, json }) {
    if (id !== root.id || operation !== 'update') return false;
    envelope.restrictions.user = pageEnvelope([{ type: 'known', username: privateUsername }], 0, 100, url, false);
    json(envelope);
    return true;
  } });
  const { directory, audit } = await invocation(t, source.origin + context);
  const result = await audit();
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivate(result, directory);
  assertCounts(JSON.parse(result.stdout), { status: 'needs-review', visiblePages: 2, restrictedPages: 1, unknownRestrictions: 0 });
});

test('the audit counts an explicitly selected unreadable page without exposing its details', async t => {
  const source = await fixture(t, { pages: [root], restrictionOverride({ id, operation, json }) {
    if (id !== root.id || operation !== 'read') return false;
    json({ message: privateBody }, 404);
    return true;
  } });
  const archive = nativeExport([root, child, { id: '802', version: 1, ancestors: [], spaceId: null }]);
  const { directory, audit } = await invocation(t, source.origin + context, { pageIds: [child.id, root.id], archive });
  const findingsPath = join(directory, 'private-review.json');
  const result = await audit('--findings', findingsPath);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivate(result, directory);
  const report = JSON.parse(result.stdout);
  assertCounts(report, { status: 'needs-review', selection: 'explicit-pages', visiblePages: 1, unavailablePages: 1, unknownRestrictions: 1 });
  assertCounts(report.archive, { archiveOnlyPages: 1, outsideSelectionPages: 0, unassignedPages: 1 });
  assert.ok(!source.requests.some(({ url }) => url.pathname.startsWith(`${apiPath}/content/${child.id}/`)));
  await assertFindings(findingsPath, { directory, archive, status: 'needs-review', selection: 'explicit-pages',
    permissionCheckedPageIds: [],
    coverage: { archivePages: 3, matchedPages: 1, permissionCheckedPages: 0, outsideSelectionPages: 0, otherSpacePages: 0, unassignedPages: 1 }, findings: [
    { pageId: root.id, codes: ['LIVE_RESTRICTION_UNKNOWN'] },
    { pageId: child.id, codes: ['ARCHIVE_ONLY_PAGE', 'LIVE_PAGE_UNAVAILABLE'] },
  ] });
});

test('findings require a ZIP and a new absolute path without replacing existing files', async t => {
  const source = await fixture(t);
  const withoutArchive = await invocation(t, source.origin + context);
  const noZip = await withoutArchive.audit('--findings', join(withoutArchive.directory, 'private-review.json'));
  assert.equal(noZip.code, 1);
  assert.equal(noZip.stdout, '');
  assertPrivate(noZip, withoutArchive.directory);
  assert.deepEqual(await readdir(withoutArchive.directory), ['confluence-auth', 'source.json']);
  assert.deepEqual(source.requests, []);

  const archive = nativeExport();
  const { directory, exportPath, audit } = await invocation(t, source.origin + context, { archive });
  const relative = await audit('--findings', 'private-review.json');
  assert.equal(relative.code, 1);
  assert.equal(relative.stdout, '');
  assertPrivate(relative, directory);
  assert.deepEqual(source.requests, []);

  const existing = join(directory, 'existing-review.json');
  const linked = join(directory, 'linked-review.json');
  const sentinel = 'private preexisting review';
  await writeFile(existing, sentinel, { mode: 0o600 });
  await symlink(existing, linked);
  for (const path of [existing, linked, join(directory, 'missing-directory', 'private-review.json')]) {
    const invalid = await audit('--findings', path);
    assert.equal(invalid.code, 1, invalid.stdout + invalid.stderr);
    assert.equal(invalid.stdout, '');
    assert.ok(!invalid.stderr.includes(sentinel));
    assertPrivate(invalid, directory);
  }
  assert.deepEqual(source.errors, []);
  assert.equal(await readFile(existing, 'utf8'), sentinel);
  assert.equal(await readFile(linked, 'utf8'), sentinel);
  assert.ok((await lstat(linked)).isSymbolicLink());
  assert.deepEqual(await readFile(exportPath), archive);
  assert.deepEqual((await readdir(directory)).sort(), ['confluence-auth', 'existing-review.json', 'linked-review.json', 'native-private-source.zip', 'source.json']);
});

test('without a native archive the command reports observation and keeps an empty visible scope under review', async t => {
  for (const [pages, code, status] of [[[root], 0, 'observed'], [[], 2, 'needs-review']]) {
    await t.test(status, async inner => {
      const source = await fixture(inner, { pages });
      const { directory, audit } = await invocation(inner, source.origin + context);
      const result = await audit();
      assert.equal(result.code, code, result.stdout + result.stderr);
      assert.deepEqual(source.errors, []);
      assertPrivate(result, directory);
      const report = JSON.parse(result.stdout);
      assertCounts(report, { status, visiblePages: pages.length, spacePermissions: 'manual-review' });
      assert.ok(!Object.hasOwn(report, 'archive'));
    });
  }
});

test('invalid page pagination or source scope fails without publishing a report', async t => {
  for (const [name, options] of [
    ['repeated page ID', { listed: [root, root] }],
    ['drifting offset', { listingOverride: ({ envelope, start }) => ({ ...envelope, start: start ? 0 : start }) }],
    ['inconsistent ancestor chain', { pages: [root, child, { id: '102', version: 1, ancestors: [child.id] }] }],
    ['wrong space', { documentOverride: ({ value }) => ({ ...value, space: { id: 99, key: 'OTHER' } }) }],
    ['same key but different space IDs', { listingOverride: ({ envelope, start }) => {
      if (start) envelope.results[0].space.id = 99;
      return envelope;
    } }],
  ]) {
    await t.test(name, async inner => {
      const source = await fixture(inner, options);
      const { directory, audit } = await invocation(inner, source.origin + context, { pageIds: options.documentOverride ? [root.id] : undefined });
      const result = await audit();
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.deepEqual(source.errors, []);
      assertPrivate(result, directory);
    });
  }
});

test('a native ZIP for the same space key with a different original ID cannot match', async t => {
  const source = await fixture(t);
  const archive = nativeExport([root, child], { spaceId: '99' });
  const { directory, audit } = await invocation(t, source.origin + context, { archive });
  const result = await audit('--findings', join(directory, 'private-review.json'));
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /원본 ID가 일치하지 않습니다/);
  assert.deepEqual(source.errors, []);
  assertPrivate(result, directory);
  assert.deepEqual((await readdir(directory)).sort(), ['confluence-auth', 'native-private-source.zip', 'source.json']);
});

test('verified live pages still require review for missing native attachment bytes or space permissions', async t => {
  for (const [name, archiveOptions, counts, diagnostic] of [
    ['missing stored binary', { extras: true, includeBinary: false }, { attachmentEvidenceProblems: 1 }, 'CONFLUENCE_ATTACHMENT_BYTES_MISSING'],
    ['archived space permission', { spacePermission: true }, { permissionWarnings: 1 }, 'CONFLUENCE_SPACE_PERMISSION_REVIEW'],
  ]) {
    await t.test(name, async inner => {
      const source = await fixture(inner);
      const { directory, audit } = await invocation(inner, source.origin + context, { archive: nativeExport([root, child], archiveOptions) });
      const result = await audit();
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.deepEqual(source.errors, []);
      assertPrivate(result, directory);
      const { status, archive } = JSON.parse(result.stdout);
      assert.equal(status, 'needs-review');
      assertCounts(archive, { matchedPages: 2, needsReview: true, ...counts });
      assert.ok(archive.diagnostics.some(item => item.code === diagnostic), JSON.stringify(archive.diagnostics));
    });
  }
});

test('a URL supplied by the server cannot redirect credentials to another origin or service path', async t => {
  const outside = await serve(t, ({ json }) => json({}));
  await t.test('HTTP redirect', async inner => {
    const source = await serve(inner, ({ request, response }) => {
      assert.equal(request.headers.authorization, authValue);
      response.writeHead(302, { Location: `${outside.origin}/other` }).end();
    });
    const { directory, audit } = await invocation(inner, source.origin + context);
    const result = await audit();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assertPrivate(result, directory);
    assert.deepEqual(source.errors, []);
    assert.equal(source.requests.length, 1);
    assert.deepEqual(outside.requests, []);
  });
  for (const [name, next] of [['off-origin next link', `${outside.origin}${listing}?start=1`], ['off-context next link', '/other?start=1']]) {
    await t.test(name, async inner => {
      const source = await fixture(inner, { listingOverride: ({ envelope, start }) => (
        start === 0 ? { ...envelope, _links: { ...envelope._links, next } } : envelope) });
      const { directory, audit } = await invocation(inner, source.origin + context);
      const result = await audit();
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assertPrivate(result, directory);
      assert.deepEqual(source.errors, []);
      assert.ok(source.requests.every(({ url }) => url.pathname.startsWith(`${apiPath}/`)));
      assert.deepEqual(outside.requests, []);
    });
  }
});
