import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readLegacyArchive } from '../../server/legacy-import-archive.ts';
import { analyzeLegacyPackage } from '../../server/legacy-import-analysis.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../../scripts/jira-pilot-collect.mjs', import.meta.url));
const run = promisify(execFile);
const token = 'synthetic-private-jira-pilot-token';
const credential = `Bearer ${token}`;
const context = '/tools/jira';
const apiPath = `${context}/rest/api/2`;
const attachmentPath = `${context}/secure/attachment/400/sample.bin`;
const attachment = Buffer.from([0, 1, 2, 31, 127, 200, 255]);
const date = '2020-03-06T02:15:00.000+0900';
const author = { key: 'synthetic-author', name: 'synthetic-jira-reader', displayName: 'Synthetic Jira Reader' };
const project = { id: '10', key: 'SRC', name: 'Local Jira project' };
const privateRemoteTitle = 'Synthetic private remote link title';
const remotePath = id => `${apiPath}/issue/${id}/remotelink`;
const remoteObject = url => ({ url, title: privateRemoteTitle, summary: 'Original object metadata', status: { resolved: false } });
const selectedIssues = [
  { id: '100', key: 'SRC-1', fields: { project } },
  { id: '101', key: 'SRC-2', fields: { project } },
];
const statusChange = id => ({ id, author, created: date,
  items: [{ field: 'status', fieldtype: 'jira', from: '1', fromString: 'Open', to: '2', toString: 'Done' }] });

async function serve(t, handler) {
  const seen = [], errors = [];
  const server = createServer((request, response) => {
    const requestOrigin = `http://${request.headers.host}`;
    const url = new URL(request.url, requestOrigin);
    seen.push({ path: url.pathname, startAt: url.searchParams.get('startAt'), method: request.method,
      authorization: request.headers.authorization });
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
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, errors };
}

async function jiraFixture(t, { unavailableHistory = false, searchDrift = false, repeatedComment = false, wrongCommentOwner = false,
  inconsistentCommentTotal = false, offOriginAttachment, remoteLinks = () => ({ value: [] }),
  observeActivity = (_source, _kind, row) => row } = {}) {
  return serve(t, ({ url, request, response, json }) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, credential);
    const base = `${url.origin}${apiPath}`;
    if (url.pathname === `${apiPath}/search`) {
      assert.equal(url.searchParams.get('fields'), 'project');
      assert.equal(url.searchParams.get('jql'), 'project = "SRC" ORDER BY key ASC');
      const startAt = Number(url.searchParams.get('startAt'));
      // Jira may cap the response below the client's requested maxResults.
      return json({ startAt, maxResults: 1, total: searchDrift && startAt > 0 ? 3 : selectedIssues.length,
        issues: selectedIssues.slice(startAt, startAt + 1) });
    }
    if (url.pathname === attachmentPath) {
      return response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': attachment.length }).end(attachment);
    }
    const route = new RegExp(`^${apiPath}/issue/([^/]+)(?:/(comment|worklog|changelog|remotelink))?$`).exec(url.pathname);
    const selected = selectedIssues.find(issue => issue.id === route?.[1] || issue.key === route?.[1]);
    if (!selected) return json({ error: 'synthetic route not found' }, 404);
    const { id, key } = selected;
    const sourceIssue = `${base}/issue/${id}`;
    const first = id === '100';
    const comment = { id: '200', self: `${sourceIssue}/comment/200`, author, body: 'First private fixture comment', created: date };
    const worklog = { id: '300', issueId: id, self: `${sourceIssue}/worklog/300`, author, comment: 'Synthetic private worklog',
      created: date, started: date, timeSpentSeconds: 91 };
    if (!route[2]) {
      assert.deepEqual(new Set(url.searchParams.get('expand')?.split(',')), new Set(['names', 'schema', 'changelog']));
      assert.ok(url.searchParams.get('fields')?.split(',').includes('*all'));
      const attachments = [{ id: '400', filename: 'sample.bin', size: attachment.length, mimeType: 'application/octet-stream',
        content: `${url.origin}${attachmentPath}`, created: date, author }];
      if (offOriginAttachment) attachments.push({ ...attachments[0], id: '401', content: offOriginAttachment });
      const fields = { project, summary: `Synthetic original ${key}`, description: 'Synthetic private issue body', created: date, updated: date,
        reporter: author, status: { id: '2', name: 'Done' }, issuetype: { id: '3', name: 'Task' },
        customfield_10206: '2020-03-06', customfield_10207: '2020-03-09',
        ...(first ? { attachment: attachments, comment: { startAt: 0, maxResults: 1, total: inconsistentCommentTotal ? 3 : 2,
          comments: [observeActivity('embedded', 'comment', comment)] },
          worklog: { startAt: 0, maxResults: 1, total: 1, worklogs: [observeActivity('embedded', 'worklog', worklog)] } } : {}) };
      const dateSchema = { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' };
      return json({ id, key, self: sourceIssue, fields, names: { customfield_10206: 'Start date', customfield_10207: 'End date' },
        schema: { customfield_10206: dateSchema, customfield_10207: dateSchema },
        changelog: first ? { startAt: 0, total: 1, maxResults: 1, histories: [statusChange('600')] }
          : { startAt: 0, total: 2, maxResults: 1, histories: [statusChange('601')] } });
    }
    if (route[2] === 'remotelink') {
      assert.equal(route[1], id);
      assert.equal(url.search, '');
      const { value, status } = remoteLinks({ id, key, origin: url.origin });
      return json(value, status);
    }
    const startAt = Number(url.searchParams.get('startAt'));
    function page(field, rows) {
      return json({ startAt, maxResults: 1, total: rows.length, [field]: rows.slice(startAt, startAt + 1) });
    }
    if (route[2] === 'comment') {
      const second = { id: '201', author, body: 'Second private fixture comment', created: date,
        visibility: { type: 'role', value: 'Synthetic restricted role' } };
      if (wrongCommentOwner) second.self = `${base}/issue/101/comment/201`;
      return page('comments', first ? [observeActivity('page', 'comment', comment),
        repeatedComment ? { ...comment, body: 'Repeated fixture comment' } : second] : []);
    }
    if (route[2] === 'worklog') return page('worklogs', first ? [observeActivity('page', 'worklog', worklog)] : []);
    if (unavailableHistory) return json({ error: 'synthetic changelog is unavailable' }, 404);
    return page('values', [statusChange('601'), statusChange('602')]);
  });
}

async function invocation(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'teamspace-jira-collector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'source.json');
  const output = join(directory, 'export.zip');
  const plan = join(directory, 'plan.json');
  await writeFile(join(directory, 'jira-auth'), `${credential}\n`, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ authFile: 'jira-auth', ...options }), { mode: 0o600 });
  async function invoke(...args) {
    try {
      return { code: 0, ...await run(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: repo, timeout: 30_000 }) };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }
  return { directory, config, output, plan, invoke, collect: () => invoke(config, output) };
}

function inventoryRows(count) {
  return Array.from({ length: count }, (_, index) => ({ id: String(1000 + index), key: `SRC-${index + 1}` }));
}

async function jiraInventoryFixture(t, rows, { searchPage, issueDetail } = {}) {
  const receivedDetails = [];
  let searchPass = 0;
  const mock = await serve(t, ({ url, request, json }) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, credential);
    if (url.pathname === `${apiPath}/search`) {
      assert.equal(url.searchParams.get('fields'), 'project');
      assert.equal(url.searchParams.get('jql'), 'project = "SRC" ORDER BY key ASC');
      assert.equal(url.searchParams.get('maxResults'), '100');
      const startAt = Number(url.searchParams.get('startAt'));
      if (startAt === 0) searchPass++;
      // Use nonstandard page sizes to observe both full traversals.
      const pageSize = 73;
      const issues = rows.slice(startAt, startAt + pageSize).map(row => ({ ...row, fields: { project } }));
      const page = { startAt, maxResults: pageSize, total: rows.length, issues };
      return json(searchPage ? searchPage(page, searchPass) : page);
    }

    const route = new RegExp(`^${apiPath}/issue/([0-9]+)(?:/(comment|worklog|remotelink))?$`, 'u').exec(url.pathname);
    const row = rows.find(value => value.id === route?.[1]);
    if (!route || !row) return json({ error: 'synthetic route not found' }, 404);
    if (route[2] === 'remotelink') return json([]);
    if (route[2]) {
      return json({ startAt: 0, maxResults: 1, total: 0, [route[2] === 'comment' ? 'comments' : 'worklogs']: [] });
    }
    receivedDetails.push(row.id);
    const detail = issueDetail ? issueDetail(row) : row;
    return json({ ...detail, self: `${url.origin}${apiPath}/issue/${detail.id}`,
      fields: { project, summary: `Synthetic original ${detail.key}`, description: 'Synthetic private issue body', created: date,
        updated: date, status: { id: '2', name: 'Done' }, issuetype: { id: '3', name: 'Task' } },
      changelog: { startAt: 0, total: 0, maxResults: 0, histories: [] } });
  });
  return { ...mock, receivedDetails };
}

async function inspectArchive(output) {
  const bytes = await readFile(output);
  const { files } = await readLegacyArchive(bytes, 'export.zip');
  const { dataset } = await analyzeLegacyPackage({ path: output, filename: 'export.zip', instanceKey: 'source-synthetic', product: 'jira' });
  assert.equal(dataset.source.format, 'jira-json');
  assert.ok(!dataset.diagnostics.some(item => item.severity === 'error'));
  return { bytes, files, dataset, records: new Map(dataset.records.map(record => [record.id, record])) };
}

function assertPrivateOutput(result) {
  for (const value of [token, 'Synthetic private issue body', 'First private fixture comment', 'Synthetic private worklog', privateRemoteTitle]) {
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(value));
  }
}

test('Jira pilot collection downloads paged and bound originals into a private Teamspace package', async t => {
  const other = await serve(t, ({ json }) => json({}));
  const sameHostDestinationPath = `${context}/pages/viewpage.action`;
  const sameHostDestination = `${sameHostDestinationPath}?pageId=700`;
  const externalDestination = `${other.origin}/wiki/pages/viewpage.action?pageId=701`;
  const remoteLinks = origin => [
    { id: 7001, self: `${origin}${remotePath('100')}/7001`, globalId: 'system=synthetic&id=701',
      relationship: 'documents', application: { type: 'com.atlassian.confluence', name: 'Synthetic wiki' },
      object: { ...remoteObject(externalDestination), icon: { url16x16: `${other.origin}/private-icon` } } },
    { id: '7002', self: `${origin}${context}/rest/api/latest/issue/SRC-1/remotelink/7002`, object: remoteObject(origin + sameHostDestination) },
    { id: 7003, object: remoteObject(`${other.origin}/private-unscoped-destination`) },
  ];
  const source = await jiraFixture(t, { offOriginAttachment: `${other.origin}${context}/secure/attachment/401/sample.bin`,
    remoteLinks: ({ id, origin }) => ({ value: id === '100' ? remoteLinks(origin) : [] }) });
  const { output, collect } = await invocation(t, { baseUrl: source.origin + context, projectKey: 'SRC' });
  const result = await collect();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivateOutput(result);
  const report = JSON.parse(result.stdout);
  for (const [key, count] of Object.entries({ issueCount: 2, commentCount: 2, worklogCount: 1, historyCount: 3,
    remoteLinkCount: 3, unavailableRemoteLinkIssues: 0,
    incompleteHistories: 0, attachmentCount: 1, skippedAttachments: 0, unavailableAttachments: 1, oversizedAttachments: 0 })) {
    assert.equal(report[key], count, key);
  }
  assert.deepEqual(source.seen.filter(request => request.path.endsWith('/search')).slice(0, 2).map(request => request.startAt), ['0', '1']);
  assert.deepEqual(source.seen.filter(request => /\/issue\/(?:100|SRC-1)\/comment$/.test(request.path)).map(request => request.startAt), ['0', '1']);
  assert.ok(source.seen.some(request => request.path === attachmentPath));
  assert.deepEqual(source.seen.filter(({ path }) => path.endsWith('/remotelink')).map(({ path }) => path), [remotePath('100'), remotePath('101')]);
  assert.ok(!source.seen.some(({ path }) => path === sameHostDestinationPath));
  assert.deepEqual(other.seen, []);
  assert.ok(source.seen.every(request => request.method === 'GET' && request.authorization === credential));
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  const { bytes, files, dataset, records } = await inspectArchive(output);
  assert.equal(report.bytes, bytes.length);
  assert.equal(report.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual([...files.keys()].filter(path => path.startsWith('issues/')).sort(), ['issues/100.json', 'issues/101.json']);
  const issue = JSON.parse(files.get('issues/100.json'));
  assert.equal(issue.fields.description, 'Synthetic private issue body');
  assert.deepEqual(issue.remoteLinks, { status: 'complete', values: remoteLinks(source.origin) });
  assert.deepEqual(JSON.parse(files.get('issues/101.json')).remoteLinks, { status: 'complete', values: [] });
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(externalDestination));
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sameHostDestination));
  assert.ok(!Object.hasOwn(issue.fields, 'comment') && !Object.hasOwn(issue.fields, 'worklog'));
  assert.deepEqual(files.get('attachments/400'), attachment);
  assert.ok([...files.values()].every(value => !value.includes(token)));
  assert.deepEqual(records.get('issue:100').metadata.jiraProjectedDates, { startDate: '2020-03-06', endDate: '2020-03-09' });
  assert.equal(records.get('issue:101').metadata.key, 'SRC-2');
  assert.equal(records.get('comment:200').containerId, '100');
  assert.deepEqual(records.get('comment:201').metadata.visibility, { type: 'role', value: 'Synthetic restricted role' });
  assert.equal(records.get('history:worklog:300').containerId, '100');
  assert.equal(records.get('history:worklog:300').metadata.timeSpentSeconds, '91');
  assert.deepEqual(['600', '601', '602'].map(id => records.get(`history:${id}`).containerId), ['100', '101', '101']);
  assert.equal(records.get('attachment:400').metadata.bytesPresent, true);
  assert.equal(records.get('attachment:400').metadata.sha256, createHash('sha256').update(attachment).digest('hex'));
  assert.equal(records.get('attachment:401').metadata.bytesPresent, false);
  assert.deepEqual(dataset.diagnostics.filter(item => item.code === 'ATTACHMENT_BYTES_MISSING').map(item => item.recordId), ['attachment:401']);
  assert.ok(!dataset.diagnostics.some(item => /^(?:ISSUES_PARTIAL|COMMENTS_PARTIAL|WORKLOGS_PARTIAL|HISTORY_PARTIAL|JIRA_ACTIVITY_PAGE_|HISTORY_PAGE_OWNER_UNRESOLVED)/.test(item.code)));

  assert.notEqual((await collect()).code, 0, 'A completed archive must never be replaced.');
  assert.deepEqual(await readFile(output), bytes);
});

test('explicit issue collection retains partial history and intentionally omitted file metadata', async t => {
  const source = await jiraFixture(t, { unavailableHistory: true, remoteLinks: ({ id }) => ({
    status: id === '100' ? 403 : 404, value: { message: privateRemoteTitle },
  }) });
  const { output, collect } = await invocation(t, { baseUrl: source.origin + context, issueKeys: ['SRC-1', 'SRC-2'], includeAttachments: false });
  const result = await collect();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivateOutput(result);
  assert.ok(!source.seen.some(request => request.path.endsWith('/search') || request.path === attachmentPath));
  assert.ok(source.seen.some(request => request.path === `${apiPath}/issue/SRC-2`));
  const report = JSON.parse(result.stdout);
  assert.equal(report.incompleteHistories, 1);
  assert.equal(report.historyCount, 2);
  assert.equal(report.remoteLinkCount, 0);
  assert.equal(report.unavailableRemoteLinkIssues, 2);
  assert.equal(report.attachmentCount, 0);
  assert.equal(report.skippedAttachments, 1);
  const { dataset, records, files } = await inspectArchive(output);
  for (const id of ['100', '101']) assert.deepEqual(JSON.parse(files.get(`issues/${id}.json`)).remoteLinks, { status: 'unavailable' });
  assert.equal(records.get('attachment:400').metadata.bytesPresent, false);
  assert.ok(records.has('history:601'), 'The embedded fragment of the original history must remain.');
  assert.ok(dataset.diagnostics.some(item => item.code === 'HISTORY_PARTIAL' && item.recordId === 'issue:101'));
  assert.ok(dataset.diagnostics.some(item => item.code === 'ATTACHMENT_BYTES_MISSING'));
});

test('Jira collection rejects conflicting comment and worklog observations before it publishes a ZIP', async t => {
  const visibility = { type: 'role', value: 'Synthetic private audience' };
  const serviceDeskProperty = { key: 'sd.public.comment', value: { internal: true } };
  const legacyProperty = { key: 'sd.allow.public.comment', value: { allow: false } };
  const changedBody = 'Synthetic changed private comment';
  const cases = [
    ['comment body', 'comment', {}, { body: changedBody }],
    ['missing comment body', 'comment', {}, { body: undefined }],
    ['comment author', 'comment', {}, { author: { ...author, key: 'different-author' } }],
    ['missing comment author', 'comment', {}, { author: undefined }],
    ['unverified worklog author', 'worklog', {}, { author: { displayName: 'Same author label' } }],
    ['missing comment creation timestamp', 'comment', {}, { created: undefined }],
    ['missing worklog update timestamp', 'worklog', { updated: date }, {}],
    ['missing comment role', 'comment', { visibility }, {}],
    ['changed comment role', 'comment', { visibility }, { visibility: { type: 'role', value: 'Other synthetic role' } }],
    ['missing service-desk privacy property', 'comment', { properties: [serviceDeskProperty] },
      { properties: [{ key: serviceDeskProperty.key, value: { internal: false } }] }],
    ['missing older service-desk privacy property', 'comment', { properties: [legacyProperty] }, { properties: [] }],
    ['missing worklog restriction', 'worklog', { 'group-id': 42 }, {}],
    ['missing worklog note', 'worklog', {}, { comment: undefined }],
    ['unconfirmed cleared worklog note', 'worklog', { comment: null }, { comment: undefined }],
    ['changed worklog duration', 'worklog', {}, { timeSpentSeconds: 92 }],
    ['missing worklog duration', 'worklog', {}, { timeSpentSeconds: undefined }],
    ['unreadable worklog duration', 'worklog', {}, { timeSpentSeconds: null, timeSpent: 'PT1M31S' }],
    ['changed worklog source day', 'worklog', {}, { started: new Date(date).toISOString() }],
    ['missing worklog source day', 'worklog', {}, { started: undefined }],
  ];
  for (const [name, kind, embedded, page] of cases) {
    await t.test(name, async inner => {
      const source = await jiraFixture(inner, { observeActivity: (mode, currentKind, row) => {
        if (currentKind !== kind) return row;
        return { ...row, ...(mode === 'embedded' ? embedded : page) };
      } });
      const { directory, collect } = await invocation(inner, { baseUrl: source.origin + context, issueKeys: ['SRC-1'] });
      const result = await collect();
      assert.equal(result.code, 1);
      assert.deepEqual(source.errors, []);
      assert.match(result.stderr, new RegExp(`같은 Jira ${kind === 'worklog' ? '작업 시간' : '댓글'}의 내용 또는 열람 제한`));
      assert.ok(source.seen.some(({ path }) => path === `${apiPath}/issue/100/${kind}`));
      assert.deepEqual((await readdir(directory)).sort(), ['jira-auth', 'source.json']);
      assertPrivateOutput(result);
      for (const privateValue of [changedBody, visibility.value, 'different-author', 'Other synthetic role']) {
        assert.ok(!`${result.stdout}\n${result.stderr}`.includes(privateValue));
      }
    });
  }
});

test('Jira collection accepts sparse embedded records and equivalent page metadata while retaining restrictions', async t => {
  const visibility = { type: 'role', value: 'Synthetic private audience' };
  const source = await jiraFixture(t, { observeActivity: (mode, kind, row) => {
    if (mode === 'embedded' && kind === 'comment') return { id: row.id, author: { key: row.author.key }, visibility };
    if (mode === 'embedded') return { ...row, 'group-id': '42', started: undefined, startDate: row.started,
      timeSpentSeconds: undefined, timeSpent: 'PT1M31S' };
    if (kind === 'comment') return { ...row, id: Number(row.id), visibility: { ...visibility, identifier: 'role-42' } };
    return { ...row, id: Number(row.id), groupId: 42,
      author: { ...row.author, displayName: 'Enriched author name', avatarUrls: { '24x24': '/synthetic.png' } },
      created: new Date(row.created).toISOString(), started: row.started.replace('+0900', '+09:00') };
  } });
  const { output, collect } = await invocation(t, { baseUrl: source.origin + context, issueKeys: ['SRC-1'] });
  const result = await collect();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivateOutput(result);
  const { records } = await inspectArchive(output);
  assert.deepEqual(records.get('comment:200').metadata.visibility, { ...visibility, identifier: 'role-42' });
  assert.equal(records.get('history:worklog:300').metadata.groupId, 42);
  assert.equal(records.get('history:worklog:300').metadata.timeSpentSeconds, '91');
});

test('Jira collection rejects drifting pagination and redirects without publishing any archive', async t => {
  for (const [name, behavior, failingPage, failingOffset = '1'] of [
    ['changed search total', { searchDrift: true }, `${apiPath}/search`],
    ['repeated comment across pages', { repeatedComment: true }, `${apiPath}/issue/100/comment`],
    ['comment address for a different issue', { wrongCommentOwner: true }, `${apiPath}/issue/100/comment`],
    ['comment total conflicts with the issue snapshot', { inconsistentCommentTotal: true }, `${apiPath}/issue/100/comment`, '0'],
  ]) {
    await t.test(name, async inner => {
      const source = await jiraFixture(inner, behavior);
      const { directory, collect } = await invocation(inner, { baseUrl: source.origin + context, projectKey: 'SRC' });
      const result = await collect();
      assert.notEqual(result.code, 0);
      assert.deepEqual(source.errors, []);
      assert.ok(source.seen.some(request => request.path === failingPage && request.startAt === failingOffset));
      assertPrivateOutput(result);
      assert.deepEqual((await readdir(directory)).sort(), ['jira-auth', 'source.json']);
    });
  }

  await t.test('redirect never receives the original authentication', async inner => {
    const other = await serve(inner, ({ json }) => json({}));
    const source = await serve(inner, ({ request, response }) => {
      assert.equal(request.headers.authorization, credential);
      response.writeHead(302, { Location: `${other.origin}/do-not-follow` }).end();
    });
    const { directory, collect } = await invocation(inner, { baseUrl: source.origin + context, issueKeys: ['SRC-1'] });
    const result = await collect();
    assert.notEqual(result.code, 0);
    assertPrivateOutput(result);
    assert.equal(source.seen.length, 1);
    assert.deepEqual(source.errors, []);
    assert.deepEqual(other.seen, []);
    assert.deepEqual((await readdir(directory)).sort(), ['jira-auth', 'source.json']);
  });
});

test('Jira remote-link collection rejects malformed or contradictory lists without publishing a partial archive', async t => {
  const other = await serve(t, ({ json }) => json({}));
  const destination = `${other.origin}/wiki/private-unread-page`;
  const object = remoteObject(destination);
  for (const [name, remote, checkedIds = ['100']] of [
    ['instead of an array', () => ({ values: [{ id: 7001, object }] })],
    ['malformed remote object', () => [{ id: 7001, object: [] }]],
    ['noncanonical link ID', () => [{ id: '07001', object }]],
    ['duplicate across collected issues', ({ id }) => [{ id: id === '100' ? 7001 : '7001', object }], ['100', '101']],
    ['self under a different origin', () => [{ id: 7001, object, self: `${other.origin}${remotePath('100')}/7001` }]],
    ['self under a different mount', ({ origin }) => [{ id: 7001, object, self: `${origin}/other${remotePath('100')}/7001` }]],
    ['self for another issue', ({ origin }) => [{ id: 7001, object, self: `${origin}${remotePath('101')}/7001` }]],
    ['self for a different link ID', ({ origin }) => [{ id: 7001, object, self: `${origin}${remotePath('100')}/7002` }]],
    ['self with a query selector', ({ origin }) => [{ id: 7001, object, self: `${origin}${remotePath('100')}/7001?globalId=other` }]],
    ['self with a traversal segment', ({ origin }) => [{ id: 7001, object, self: `${origin}/other/%2e%2e${remotePath('100')}/7001` }]],
  ]) {
    await t.test(name, async inner => {
      const source = await jiraFixture(inner, { remoteLinks: input => ({ value: remote(input) }) });
      const { directory, collect } = await invocation(inner, { baseUrl: source.origin + context, issueKeys: ['SRC-1', 'SRC-2'] });
      const result = await collect();
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Jira 원격 연결/u);
      assertPrivateOutput(result);
      assert.ok(!`${result.stdout}\n${result.stderr}`.includes(destination));
      assert.deepEqual(source.errors, []);
      assert.deepEqual(source.seen.filter(({ path }) => path.endsWith('/remotelink')).map(({ path }) => path), checkedIds.map(remotePath));
      assert.deepEqual(other.seen, []);
      assert.deepEqual((await readdir(directory)).sort(), ['jira-auth', 'source.json']);
    });
  }
});

test('Jira project plan covers every visible tuple above 500 and collects a selected batch by ID', async t => {
  const rows = inventoryRows(501);
  const source = await jiraInventoryFixture(t, rows);
  const { directory, config, plan, output, invoke } = await invocation(t, { baseUrl: source.origin + context, projectKey: 'SRC' });

  const planned = await invoke('plan', config, plan);
  assert.equal(planned.code, 0, planned.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivateOutput(planned);
  assert.ok(!`${planned.stdout}\n${planned.stderr}`.includes('SRC-501'));
  const searchOffsets = ['0', '73', '146', '219', '292', '365', '438'];
  assert.deepEqual(source.seen.map(({ path, startAt }) => [path, startAt]),
    [...searchOffsets, ...searchOffsets].map(offset => [`${apiPath}/search`, offset]));
  assert.deepEqual(source.receivedDetails, []);
  assert.deepEqual((await readdir(directory)).sort(), ['jira-auth', 'plan.json', 'source.json']);
  assert.equal((await stat(plan)).mode & 0o777, 0o600);

  const planBytes = await readFile(plan);
  const planSha256 = createHash('sha256').update(planBytes).digest('hex');
  const { scopeSha256, ...inventory } = JSON.parse(planBytes);
  assert.match(scopeSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(inventory, {
    format: 'teamspace-jira-collection-plan', version: 1, batchSize: 100,
    batches: Array.from({ length: 6 }, (_, index) => rows.slice(index * 100, (index + 1) * 100)),
  });
  assert.deepEqual(JSON.parse(planned.stdout), { issueCount: 501, batchCount: 6, sha256: planSha256 });

  const requestsBeforeBatch = source.seen.length;
  const collected = await invoke('batch', config, plan, '6', output);
  assert.equal(collected.code, 0, collected.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivateOutput(collected);
  assert.deepEqual(source.receivedDetails, ['1500']);
  assert.deepEqual(source.seen.slice(requestsBeforeBatch).map(request => request.path), [
    `${apiPath}/issue/1500`, `${apiPath}/issue/1500/comment`, `${apiPath}/issue/1500/worklog`, remotePath('1500'),
  ]);
  const { bytes, files, records } = await inspectArchive(output);
  const report = JSON.parse(collected.stdout);
  assert.equal(report.issueCount, 1);
  assert.equal(report.remoteLinkCount, 0);
  assert.equal(report.unavailableRemoteLinkIssues, 0);
  assert.equal(report.batch, 6);
  assert.equal(report.planSha256, planSha256);
  assert.equal(report.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual([...files.keys()].filter(path => path.startsWith('issues/')), ['issues/1500.json']);
  assert.deepEqual(JSON.parse(files.get('issues/1500.json')).remoteLinks, { status: 'complete', values: [] });
  assert.equal(records.get('issue:1500').metadata.key, 'SRC-501');
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  assert.notEqual((await invoke('batch', config, plan, '6', output)).code, 0, 'A batch must not overwrite an archive.');
  assert.notEqual((await invoke('plan', config, plan)).code, 0, 'A new plan must not overwrite an existing plan.');
  assert.deepEqual(await readFile(output), bytes);
  assert.deepEqual(await readFile(plan), planBytes);
});

test('Jira project plans reject unstable or incomplete inventories before publication', async t => {
  const rows = inventoryRows(75);
  for (const { name, searchPage, expectedOffsets } of [
    {
      name: 'same total with a key changed on the second traversal',
      searchPage: (page, pass) => pass === 2 && page.startAt === 73
        ? { ...page, issues: [page.issues[0], { ...page.issues[1], key: 'SRC-9000' }] } : page,
      expectedOffsets: ['0', '73', '0', '73'],
    },
    {
      name: 'repeated issue ID with different keys across pages',
      searchPage: page => page.startAt === 73 ? { ...page, issues: [{ ...page.issues[0], id: rows[0].id }, page.issues[1]] } : page,
      expectedOffsets: ['0', '73'],
    },
    {
      name: 'server reports more than 10,000 visible issues',
      searchPage: page => ({ ...page, total: 10_001 }),
      expectedOffsets: ['0'],
    },
  ]) {
    await t.test(name, async inner => {
      const source = await jiraInventoryFixture(inner, rows, { searchPage });
      const { directory, config, plan, invoke } = await invocation(inner, { baseUrl: source.origin + context, projectKey: 'SRC' });
      const result = await invoke('plan', config, plan);
      assert.notEqual(result.code, 0);
      assertPrivateOutput(result);
      assert.deepEqual(source.errors, []);
      assert.deepEqual(source.seen.map(({ path, startAt }) => [path, startAt]), expectedOffsets.map(offset => [`${apiPath}/search`, offset]));
      assert.deepEqual((await readdir(directory)).sort(), ['jira-auth', 'source.json']);
    });
  }
});

test('Jira batch rejects incompatible plans and removes staged data when live identity changes', async t => {
  let patchDetail = issue => issue;
  const source = await jiraInventoryFixture(t, inventoryRows(3), { issueDetail: row => patchDetail(row) });
  const { directory, config, plan, output, invoke } = await invocation(t, { baseUrl: source.origin + context, projectKey: 'SRC' });
  assert.notEqual((await invoke('plan', config, plan, '--batch-size', '501')).code, 0);
  assert.deepEqual(source.seen, []);
  const planned = await invoke('plan', config, plan, '--batch-size', '2');
  assert.equal(planned.code, 0, planned.stderr);
  const inventory = JSON.parse(await readFile(plan));
  assert.deepEqual(inventory.batches.map(batch => batch.length), [2, 1]);
  assert.equal(inventory.batchSize, 2);
  const inventoryRequests = source.seen.length;

  assert.notEqual((await invoke('batch', config, plan, '3', output)).code, 0);
  const incompatible = join(directory, 'incompatible.json');
  await writeFile(incompatible, JSON.stringify({ baseUrl: source.origin + context, authFile: 'jira-auth', projectKey: 'OTHER' }), { mode: 0o600 });
  assert.notEqual((await invoke('batch', incompatible, plan, '1', output)).code, 0);
  const duplicate = join(directory, 'duplicate.json');
  const invalid = { ...inventory, batches: [inventory.batches[0], [inventory.batches[0][0]]] };
  await writeFile(duplicate, JSON.stringify(invalid), { mode: 0o600 });
  assert.notEqual((await invoke('batch', config, duplicate, '1', output)).code, 0);
  assert.equal(source.seen.length, inventoryRequests);

  for (const mutation of [{ key: 'SRC-9999' }, { id: '9999' }]) {
    source.receivedDetails.length = 0;
    const before = source.seen.length;
    patchDetail = row => row.id === '1001' ? { ...row, ...mutation } : row;
    const result = await invoke('batch', config, plan, '1', output);
    assert.notEqual(result.code, 0);
    assertPrivateOutput(result);
    assert.deepEqual(source.receivedDetails, ['1000', '1001']);
    assert.deepEqual(source.seen.slice(before).map(request => request.path), [
      `${apiPath}/issue/1000`, `${apiPath}/issue/1000/comment`, `${apiPath}/issue/1000/worklog`, remotePath('1000'), `${apiPath}/issue/1001`,
    ]);
    assert.deepEqual((await readdir(directory)).sort(), ['duplicate.json', 'incompatible.json', 'jira-auth', 'plan.json', 'source.json']);
  }
  assert.deepEqual(source.errors, []);
});
