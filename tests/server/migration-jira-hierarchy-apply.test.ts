import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  Issue, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions,
  MigrationPreview, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';

async function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-jira-hierarchy-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  const db = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const actor = { 'X-Actor-Id': 'user-seo' };
  async function request<T>(path: string, status = 200, method = 'GET', input?: unknown): Promise<T> {
    const response = await fetch(base + path, {
      method, headers: { ...actor, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${body}`);
    return JSON.parse(body) as T;
  }
  async function uploadSource(filename: string, content: string) {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: 'jira-hierarchy-apply' });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { ...actor, 'Content-Type': 'application/octet-stream' },
      body: new TextEncoder().encode(content),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    const { id } = JSON.parse(body) as LegacyPackageSummary;
    return request<MigrationOptions>(`/migrations/options?packageId=${id}`);
  }
  async function upload(name: string, day: number, rows: readonly [number, number | { key: string } | null][]) {
    const issues = rows.map(([number, parent]) => ({
      id: String(number * 100), key: `ORIGINAL-${number}`, fields: {
        project: { id: '42', key: 'ORIGINAL', name: 'Jira hierarchy' },
        summary: `Issue ${number}`, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
        created: '2025-04-01T00:00:00Z', updated: `2025-04-0${day}T00:00:00Z`, description: `Body ${number}`,
        parent: typeof parent === 'number' ? { id: String(parent * 100), key: `ORIGINAL-${parent}` } : parent,
      },
    }));
    return uploadSource(`${name}.json`, JSON.stringify({ issues }));
  }
  const preview = (configuration: MigrationConfiguration) => request<MigrationPreview>('/migrations/preview', 201, 'POST', { configuration });
  const apply = (plan: MigrationPreview, status = 201) => request<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, status, 'POST', {
    expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
  });
  const allIssues = async () => (await request<WorkspaceSnapshot>('/workspace')).issues;
  return { db, request, upload, uploadSource, preview, apply, allIssues };
}

function refreshConfig(options: MigrationOptions, projectId: string): MigrationConfiguration {
  const target = options.appendTarget;
  assert.equal(target?.projectId, projectId);
  assert.ok(target);
  return { ...options.defaultConfiguration, appendTo: {
    projectId, refreshExisting: true,
    statuses: Object.fromEntries(options.statuses.map(option => [option.id, target.statuses.find(status => status.label === option.label)!.id])),
    issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(type => type.name === option.label)!.id])),
    fields: {},
  } };
}

test('Jira applies reviewed parents against the combined tree and rolls back if the receipt fails', async t => {
  const f = await workspace(t);
  const initial = await f.preview((await f.upload('hierarchy-initial', 2, [[1, null], [2, 1], [3, 2], [4, 5], [6, null]])).defaultConfiguration);
  assert.equal(initial.canApply, true, JSON.stringify(initial.notices));
  assert.ok(initial.notices.some(notice => notice.code === 'PARENT_NOT_IMPORTED' && notice.recordId?.endsWith('/issue:400')));
  const [projectId] = (await f.apply(initial)).import.projectIds;
  const config = (options: MigrationOptions) => refreshConfig(options, projectId);
  const find = (issues: Issue[], title: string) => {
    const issue = issues.find(item => item.projectId === projectId && item.title === title);
    assert.ok(issue, title);
    return issue;
  };
  const original = await f.allIssues();
  const a = find(original, 'Issue 1'), b = find(original, 'Issue 2'), descendant = find(original, 'Issue 3');
  const d = find(original, 'Issue 4'), anchor = find(original, 'Issue 6');
  assert.deepEqual([a.parentId, b.parentId, descendant.parentId, d.parentId, anchor.parentId], [null, a.id, b.id, null, null]);

  const cycle = await f.preview(config(await f.upload('hierarchy-cycle', 3, [[1, 3]])));
  assert.equal(cycle.canApply, false, JSON.stringify(cycle.notices));
  assert.ok(cycle.notices.some(notice => notice.severity === 'error' && notice.message.includes('순환')));
  await f.apply(cycle, 409);
  assert.deepEqual(await f.allIssues(), original);

  const delta = config(await f.upload('hierarchy-projected', 4, [[1, 2], [2, 6], [4, 5], [5, 1]]));
  const stale = await f.preview(delta);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  const movedAnchor = await f.request<Issue>(`/issues/${anchor.id}`, 200, 'PATCH', { expectedVersion: anchor.version, parentId: descendant.id });
  await f.apply(stale, 409);
  assert.deepEqual(find(await f.allIssues(), 'Issue 1'), a);
  const blocked = await f.preview(delta);
  assert.equal(blocked.canApply, false, JSON.stringify(blocked.notices));
  assert.ok(blocked.notices.some(notice => notice.severity === 'error' && notice.message.includes('순환')));
  await f.request<Issue>(`/issues/${anchor.id}`, 200, 'PATCH', { expectedVersion: movedAnchor.version, parentId: null });

  const plan = await f.preview(delta);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.issues, 1);
  assert.equal(plan.counts.updatedIssues, 3);
  const parentReview = (issue: Issue) => plan.issueRefresh?.find(row => row.issueId === issue.id)?.fields.find(field => field.field === 'parentId');
  for (const issue of [a, b, d]) assert.equal(parentReview(issue)?.decision, 'apply');
  assert.equal(parentReview(d)?.current, '최상위 업무');

  const beforeApply = await f.allIssues();
  f.db.exec(`CREATE TRIGGER fail_jira_hierarchy_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic Jira hierarchy receipt failure'); END`);
  try { await f.apply(plan, 500); }
  finally { f.db.exec('DROP TRIGGER fail_jira_hierarchy_receipt'); }
  assert.deepEqual(await f.allIssues(), beforeApply);

  const receipt = await f.apply(plan);
  assert.equal(receipt.duplicate, false);
  const projected = await f.allIssues();
  const newIssue = find(projected, 'Issue 5');
  assert.equal(parentReview(d)?.incoming, `${newIssue.key} · ${newIssue.title}`);
  assert.deepEqual([find(projected, 'Issue 1').parentId, find(projected, 'Issue 2').parentId,
    find(projected, 'Issue 4').parentId, newIssue.parentId], [b.id, anchor.id, newIssue.id, a.id]);
  for (const issue of [a, b, d]) assert.equal(find(projected, issue.title).version, issue.version + 1);
  assert.deepEqual(find(projected, descendant.title), descendant);
  assert.equal((await f.apply(plan, 200)).duplicate, true);
  assert.deepEqual(await f.allIssues(), projected);

  const detach = await f.preview(config(await f.upload('hierarchy-detach', 5, [[1, null]])));
  assert.equal(detach.canApply, true, JSON.stringify(detach.notices));
  assert.equal(detach.issueRefresh?.[0].fields.find(field => field.field === 'parentId')?.decision, 'apply');
  await f.apply(detach);
  const detached = await f.allIssues();
  assert.equal(find(detached, a.title).parentId, null);
  assert.deepEqual(find(detached, newIssue.title), newIssue);

  const backup = await f.request<{ schemaVersion: number; sourceRecords: SourceRecordArchive[] }>('/export');
  assert.equal(backup.schemaVersion, 100);
  assert.ok(backup.sourceRecords.some(row => row.targetId === a.id && row.jiraIssueFieldHashes?.parentId));
  const older = await f.request<{ error: string }>('/import', 400, 'POST', { data: { ...backup, schemaVersion: 99 } });
  assert.match(older.error, /schemaVersion 100/);
});

test('Jira parent provenance survives adding the REST project ID to a CSV project binding', async t => {
  const f = await workspace(t);
  const { defaultConfiguration } = await f.uploadSource('older-key-only.csv', [
    'Issue key,Project key,Summary,Issue Type,Status,Created,Updated,Description',
    'ORIGINAL-1,ORIGINAL,Issue 1,Task,Open,2025-04-01T00:00:00Z,2025-04-02T00:00:00Z,Body 1',
    'ORIGINAL-2,ORIGINAL,Issue 2,Task,Open,2025-04-01T00:00:00Z,2025-04-02T00:00:00Z,Body 2',
    'OTHER-1,OTHER,Other Jira project,Task,Open,2025-04-01T00:00:00Z,2025-04-02T00:00:00Z,Other body',
  ].join('\n'));
  const initial = await f.preview({ ...defaultConfiguration, projects: defaultConfiguration.projects.map(mapping => ({
    ...mapping, key: 'JIRABRIDGE', name: 'Combined Jira projects',
  })) });
  assert.equal(initial.canApply, true, JSON.stringify(initial.notices));
  const { import: { projectIds: [projectId] } } = await f.apply(initial);
  const before = (await f.allIssues()).filter(issue => issue.projectId === projectId);
  assert.equal(before.length, 3);
  const child = before.find(issue => issue.title === 'Issue 1');
  const parent = before.find(issue => issue.title === 'Issue 2');
  assert.ok(child && parent);
  const config = (options: MigrationOptions) => refreshConfig(options, projectId);
  const delta = config(await f.upload('numeric-parent-delta', 4, [[1, 2]]));
  const parentReview = (plan: MigrationPreview) => plan.issueRefresh?.find(row => row.issueId === child.id)
    ?.fields.find(field => field.field === 'parentId');
  assert.equal(parentReview(await f.preview(delta))?.decision, 'apply');

  const bridge = await f.preview(config(await f.upload('numeric-project-alias', 3, [[3, null]])));
  assert.equal(bridge.canApply, true, JSON.stringify(bridge.notices));
  await f.apply(bridge);
  const review = await f.preview(delta);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.deepEqual(parentReview(review), { field: 'parentId', current: '최상위 업무', incoming: `${parent.key} · ${parent.title}`, decision: 'apply' });
  await f.apply(review);
  assert.equal((await f.allIssues()).find(issue => issue.id === child.id)?.parentId, parent.id);

  const cross = await f.preview(config(await f.upload('wrong-source-project', 5, [[1, { key: 'OTHER-1' }]])));
  assert.equal(cross.canApply, false, JSON.stringify(cross.notices));
  assert.ok(cross.notices.some(notice => notice.code === 'JIRA_REFRESH_PARENT_UNAVAILABLE'));
  assert.equal(parentReview(cross), undefined);
  assert.equal((await f.allIssues()).find(issue => issue.id === child.id)?.parentId, parent.id);
});
