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
  inconsistentCommentTotal = false, offOriginAttachment } = {}) {
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
    const route = new RegExp(`^${apiPath}/issue/([^/]+)(?:/(comment|worklog|changelog))?$`).exec(url.pathname);
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
          comments: [comment] },
          worklog: { startAt: 0, maxResults: 1, total: 1, worklogs: [worklog] } } : {}) };
      const dateSchema = { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' };
      return json({ id, key, self: sourceIssue, fields, names: { customfield_10206: 'Start date', customfield_10207: 'End date' },
        schema: { customfield_10206: dateSchema, customfield_10207: dateSchema },
        changelog: first ? { startAt: 0, total: 1, maxResults: 1, histories: [statusChange('600')] }
          : { startAt: 0, total: 2, maxResults: 1, histories: [statusChange('601')] } });
    }
    const startAt = Number(url.searchParams.get('startAt'));
    function page(field, rows) {
      return json({ startAt, maxResults: 1, total: rows.length, [field]: rows.slice(startAt, startAt + 1) });
    }
    if (route[2] === 'comment') {
      const second = { id: '201', author, body: 'Second private fixture comment', created: date,
        visibility: { type: 'role', value: 'Synthetic restricted role' } };
      if (wrongCommentOwner) second.self = `${base}/issue/101/comment/201`;
      return page('comments', first ? [comment, repeatedComment ? { ...comment, body: 'Repeated fixture comment' } : second] : []);
    }
    if (route[2] === 'worklog') return page('worklogs', first ? [worklog] : []);
    if (unavailableHistory) return json({ error: 'synthetic changelog is unavailable' }, 404);
    return page('values', [statusChange('601'), statusChange('602')]);
  });
}

async function invocation(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'teamspace-jira-collector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'source.json');
  const output = join(directory, 'export.zip');
  await writeFile(join(directory, 'jira-auth'), `${credential}\n`, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ authFile: 'jira-auth', ...options }), { mode: 0o600 });
  async function collect() {
    try {
      return { code: 0, ...await run(process.execPath, ['--import', 'tsx', cli, config, output], { cwd: repo, timeout: 30_000 }) };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }
  return { directory, output, collect };
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
  for (const value of [token, 'Synthetic private issue body', 'First private fixture comment', 'Synthetic private worklog']) {
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(value));
  }
}

test('Jira pilot collection downloads paged and bound originals into a private Teamspace package', async t => {
  const other = await serve(t, ({ json }) => json({}));
  const source = await jiraFixture(t, { offOriginAttachment: `${other.origin}${context}/secure/attachment/401/sample.bin` });
  const { output, collect } = await invocation(t, { baseUrl: source.origin + context, projectKey: 'SRC' });
  const result = await collect();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(source.errors, []);
  assertPrivateOutput(result);
  const report = JSON.parse(result.stdout);
  for (const [key, count] of Object.entries({ issueCount: 2, commentCount: 2, worklogCount: 1, historyCount: 3,
    incompleteHistories: 0, attachmentCount: 1, skippedAttachments: 0, unavailableAttachments: 1, oversizedAttachments: 0 })) {
    assert.equal(report[key], count, key);
  }
  assert.deepEqual(source.seen.filter(request => request.path.endsWith('/search')).slice(0, 2).map(request => request.startAt), ['0', '1']);
  assert.deepEqual(source.seen.filter(request => /\/issue\/(?:100|SRC-1)\/comment$/.test(request.path)).map(request => request.startAt), ['0', '1']);
  assert.ok(source.seen.some(request => request.path === attachmentPath));
  assert.deepEqual(other.seen, []);
  assert.ok(source.seen.every(request => request.method === 'GET' && request.authorization === credential));
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  const { bytes, files, dataset, records } = await inspectArchive(output);
  assert.equal(report.bytes, bytes.length);
  assert.equal(report.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual([...files.keys()].filter(path => path.startsWith('issues/')).sort(), ['issues/100.json', 'issues/101.json']);
  const issue = JSON.parse(files.get('issues/100.json'));
  assert.equal(issue.fields.description, 'Synthetic private issue body');
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
  const source = await jiraFixture(t, { unavailableHistory: true });
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
  assert.equal(report.attachmentCount, 0);
  assert.equal(report.skippedAttachments, 1);
  const { dataset, records } = await inspectArchive(output);
  assert.equal(records.get('attachment:400').metadata.bytesPresent, false);
  assert.ok(records.has('history:601'), 'The embedded fragment of the original history must remain.');
  assert.ok(dataset.diagnostics.some(item => item.code === 'HISTORY_PARTIAL' && item.recordId === 'issue:101'));
  assert.ok(dataset.diagnostics.some(item => item.code === 'ATTACHMENT_BYTES_MISSING'));
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
