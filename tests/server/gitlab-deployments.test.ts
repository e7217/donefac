import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GitlabDeploymentError, GitlabDeployments } from '../../server/gitlab-deployments.js';
import { Store } from '../../server/store.js';
import type { GitlabDeployment, GitlabLink } from '../../shared/types.js';

const base = 'https://git.example.test/git';
const alternateBase = 'https://another.example.test';
const namespace = 'root/group/repository';
const repositoryId = 30;
const sha = '279484c09fbe69ededfced8c1bb6e6d24616b468';
const otherSha = 'b'.repeat(40);
const mergedSha = 'a'.repeat(40);
const started = '2026-01-02T10:30:00.000Z';
const completed = '2026-01-02T10:31:00.000Z';
const later = '2026-01-02T10:32:00.000Z';
const exportedAt = '2026-01-02T10:33:00.000Z';
const instanceKey = (origin: string) => createHash('sha256').update(origin).digest('hex').slice(0, 12);
const instance = instanceKey(base);

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-deployment-observations-'));
  const store = new Store(dir);
  const deployments = new GitlabDeployments(store);
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.put('projects', { id: 'team-project', key: 'TEAM' });
  store.put('issues', { id: 'team-issue', projectId: 'team-project', parentId: null, assigneeId: null });
  return { dir, store, deployments };
}

function event(origin = base, id = repositoryId, sourceSha = sha) {
  const projectUrl = `${origin}/${namespace}`;
  return {
    object_kind: 'deployment', status: 'success', status_changed_at: completed, deployment_id: 15,
    deployable_id: 796, deployable_url: `${projectUrl}/-/jobs/796`, environment: 'staging/preview', environment_tier: 'staging',
    environment_external_url: 'https://staging.example.test?do-not-copy=1',
    project: { id, path_with_namespace: namespace, web_url: projectUrl },
    short_sha: sourceSha.slice(0, 8), commit_url: `${projectUrl}/-/commit/${sourceSha}`, commit_title: 'TEAM-1 candidate',
  };
}

function historyRow(changes: Partial<Omit<GitlabDeployment, 'instance'>> = {}): Omit<GitlabDeployment, 'instance'> {
  return {
    repositoryId, deploymentId: 15, environment: 'staging/preview', sha, status: 'success', changedAt: completed,
    projectUrl: `${base}/${namespace}`, environmentTier: 'staging', source: 'sync', ...changes,
  };
}

test('GitLab deployment observations verify repository, full SHA and scope and preserve monotonic lifecycle evidence', t => {
  const { store, deployments } = fixture(t);
  const payload = event();
  const observe = (changes: Record<string, unknown> = {}) => deployments.observe(instance, base, repositoryId, { ...payload, ...changes });

  for (const invalid of [
    { status: 'approved' }, { status: 'rejected' }, { status_changed_at: undefined }, { object_kind: 'push' },
    { status_changed_at: '2026-02-30T10:31:00.000Z' }, { status_changed_at: '9999-01-01T00:00:00Z' },
    { deployment_id: 0 }, { deployment_id: Number.MAX_SAFE_INTEGER + 1 }, { project: { ...payload.project, id: 31 } },
    { project_id: 31 }, { commit_url: `${base}/${namespace}/-/commit/${payload.short_sha}` }, { short_sha: 'abababab' },
    { commit_url: `https://lookalike.example.test/git/${namespace}/-/commit/${sha}` },
    { commit_url: `${base}/root/group/different/-/commit/${sha}` },
    { commit_url: `${payload.commit_url}?query=forged` }, { deployable_url: `${base}/${namespace}/-/jobs/797` },
    { deployable_url: `https://another.example.test/${namespace}/-/jobs/796` },
    { environment: 'staging\nproduction' }, { environment_tier: 'x'.repeat(65) },
  ]) assert.equal(observe(invalid), false, JSON.stringify(invalid));
  assert.equal(deployments.observe(instanceKey(alternateBase), base, repositoryId, payload), false);
  assert.equal(deployments.repositoryPage(instance, repositoryId, 0).total, 0);

  assert.throws(() => store.transaction(() => {
    assert.equal(observe(), true);
    throw new Error('reject webhook transaction');
  }), /reject webhook transaction/u);
  assert.deepEqual(deployments.exportRows(), []);

  assert.equal(observe({ status: 'running', status_changed_at: '2026-01-02T19:30:00+09:00' }), true);
  assert.equal(deployments.exportRows()[0].changedAt, started);
  assert.equal(observe({ deployable_id: null, deployable_url: null }), true);
  assert.equal(observe(), false);
  assert.equal(observe({ status: 'failed' }), false);
  assert.equal(observe({ status: 'running', status_changed_at: started }), false);
  assert.equal(observe({ status: 'blocked', status_changed_at: later }), false);
  assert.equal(observe({ status: 'failed', status_changed_at: later, environment: 'production' }), false);
  assert.equal(observe({ status: 'failed', status_changed_at: later, short_sha: otherSha.slice(0, 8), commit_url: `${base}/${namespace}/-/commit/${otherSha}` }), false);
  const latest = deployments.repositoryPage(instance, repositoryId, 0);
  assert.deepEqual(latest, { items: [{ instance, repositoryId, deploymentId: 15, environment: 'staging/preview', sha,
    status: 'success', changedAt: completed, projectUrl: payload.project.web_url, jobUrl: payload.deployable_url, environmentTier: 'staging' }], total: 1, offset: 0, limit: 50 });
  assert.equal(observe({ deployment_id: 16, deployable_id: null, deployable_url: null, environment_tier: undefined }), true);
  assert.equal(Object.hasOwn(deployments.repositoryPage(instance, repositoryId, 0).items[0], 'jobUrl'), false);
  assert.match(JSON.stringify(deployments.exportRows()), /staging\/preview/u);
  assert.doesNotMatch(JSON.stringify(deployments.exportRows()), /do-not-copy|commit_title/u);
});

test('issue deployment history joins exact current revisions, deduplicates multiple proof links and pages stable results', t => {
  const { store, deployments } = fixture(t);
  const issueId = 'team-issue';
  // Same SHA and deployment ID exist in a different project and instance.
  for (const [origin, projectId, sourceSha] of [[base, repositoryId, sha], [base, 31, sha], [alternateBase, repositoryId, sha],
    [base, repositoryId, otherSha], [base, repositoryId, mergedSha]] as const) {
    const payload = event(origin, projectId, sourceSha);
    const deploymentId = sourceSha === sha ? 15 : sourceSha === otherSha ? 16 : 17;
    assert.equal(deployments.observe(instanceKey(origin), origin, projectId, { ...payload, deployment_id: deploymentId }), true);
  }
  assert.equal(deployments.issuePage(issueId, 0).total, 0);

  function putLink(kind: GitlabLink['kind'], externalId: string, extra: Partial<GitlabLink> = {}) {
    const id = `gitlab:${instance}:${repositoryId}:${kind}:${externalId}:${issueId}`;
    store.put('gitlab_links', { id, issueId, projectId: repositoryId, kind, sourceSha: sha,
      title: 'Activity', webUrl: `${base}/${namespace}`, state: 'active', iid: 1, ...extra });
    return id;
  }

  putLink('branch', 'feature-branch');
  putLink('commit', mergedSha); // Malformed link: exact commit identity and claimed source disagree.
  putLink('merge_request', '101', { state: 'merged' }); // Source head is separate from a merged revision.
  const openMr = putLink('merge_request', '102', { state: 'opened', mergeCommitShas: [mergedSha] });
  assert.equal(deployments.issuePage(issueId, 0).total, 0);

  const directCommit = putLink('commit', sha, { state: 'committed' });
  const pipeline = putLink('pipeline', '202', { state: 'success', sourceSha: sha.toUpperCase() });
  assert.deepEqual(deployments.issuePage(issueId, 0).items.map(row => row.deploymentId), [15]);
  putLink('merge_request', '102', { state: 'merged', mergeCommitShas: [mergedSha, otherSha, mergedSha] });
  assert.deepEqual(deployments.issuePage(issueId, 0).items.map(row => row.deploymentId), [17, 16, 15]);

  for (let id = 20; id < 72; id++) assert.equal(deployments.observe(instance, base, repositoryId, { ...event(), deployment_id: id }), true);
  const repositoryFirst = deployments.repositoryPage(instance, repositoryId, 0);
  const issueFirst = deployments.issuePage(issueId, 0);
  assert.deepEqual(repositoryFirst, issueFirst);
  assert.equal(issueFirst.total, 55);
  assert.equal(issueFirst.limit, 50);
  assert.equal(issueFirst.items.length, 50);
  assert.equal(issueFirst.items[0].deploymentId, 71);
  assert.deepEqual(deployments.issuePage(issueId, 50).items.map(row => row.deploymentId), [21, 20, 17, 16, 15]);

  store.remove('gitlab_links', openMr);
  store.remove('gitlab_links', directCommit);
  store.remove('gitlab_links', pipeline);
  assert.equal(deployments.issuePage(issueId, 0).total, 0);
  assert.equal(deployments.repositoryPage(instance, repositoryId, 0).total, 55);
});

test('deployment records restore old instance scopes without trusting malformed links or partial backups', t => {
  const { dir, store, deployments } = fixture(t);
  assert.equal(deployments.observe(instance, base, repositoryId, event()), true);
  assert.equal(deployments.observe(instanceKey(alternateBase), alternateBase, repositoryId, event(alternateBase)), true);
  const backup = deployments.exportRows();
  assert.equal(backup.length, 2);
  const reopened = new Store(dir);
  try { assert.deepEqual(new GitlabDeployments(reopened).exportRows(), backup); }
  finally { reopened.db.close(); }

  for (const rows of [
    [backup[0], backup[0]], [{ ...backup[0], environmentExternalUrl: 'https://external.example.test' }],
    [{ ...backup[0], changedAt: '2026-01-02T10:34:00.000Z' }], [{ ...backup[0], projectUrl: 'https://external.example.test/root/repo' }],
    [{ ...backup[0], instance: '123456789012' }], [{ ...backup[0], projectUrl: `${backup[0].projectUrl}?query=invalid` }],
    [{ ...backup[0], jobUrl: `${backup[0].projectUrl}/-/jobs/0` }], [{ ...backup[0], jobUrl: 'https://lookalike.example.test/root/repo/-/jobs/1' }],
    [{ ...backup[0], sha: '0'.repeat(40) }], [{ ...backup[0], repositoryId: '30' }], [{ ...backup[0], status: 'approved' }],
  ]) {
    assert.throws(() => store.transaction(() => deployments.restore(rows, exportedAt)), GitlabDeploymentError);
    assert.deepEqual(deployments.exportRows(), backup);
  }

  store.transaction(() => deployments.restore([], undefined));
  assert.deepEqual(deployments.exportRows(), []);
  store.transaction(() => deployments.restore(backup, exportedAt));
  assert.deepEqual(deployments.exportRows(), backup);
  assert.equal(deployments.observe(instance, base, repositoryId, { ...event(), status: 'running', status_changed_at: started }), false);
  assert.deepEqual(deployments.exportRows(), backup);
});

test('historical deployment proof joins both MR identifiers within the exact repository and instance and deduplicates SHA matches', t => {
  const { store, deployments } = fixture(t);
  const putMr = (id: number, iid: number, scope = instance, repo = repositoryId) => {
    const linkId = `gitlab:${scope}:${repo}:merge_request:${id}:team-issue`;
    // The verified deployment proves membership even when a previously linked MR still shows open.
    store.put('gitlab_links', { id: linkId, issueId: 'team-issue', projectId: repo, iid, kind: 'merge_request', state: 'opened' });
    return linkId;
  };
  putMr(101, 41);
  putMr(100, 40, instance, 31);
  putMr(100, 40, instanceKey(alternateBase));
  const archive = historyRow({ mergeRequests: [{ id: 102, iid: 42 }, { id: 100, iid: 40 }, { id: 101, iid: 4 }] });
  const sync = (rows: Omit<GitlabDeployment, 'instance'>[]) =>
    store.transaction(() => deployments.recordSync(instance, repositoryId, rows, Date.now()));

  assert.deepEqual(sync([archive]), { stored: 1, mergeRequestsStored: 3 });
  assert.equal(deployments.issuePage('team-issue', 0).total, 0);
  const first = putMr(100, 40);
  const second = putMr(102, 42);
  const revisionLink = `gitlab:${instance}:${repositoryId}:commit:${sha}:team-issue`;
  store.put('gitlab_links', { id: revisionLink, issueId: 'team-issue', projectId: repositoryId, kind: 'commit', sourceSha: sha });
  const page = deployments.issuePage('team-issue', 0);
  assert.equal(page.total, 1);
  assert.deepEqual(page.items[0].mergeRequests, [{ id: 100, iid: 40 }, { id: 101, iid: 4 }, { id: 102, iid: 42 }]);
  assert.deepEqual(sync([historyRow({ mergeRequests: [{ id: 100, iid: 40 }] })]), { stored: 0, mergeRequestsStored: 0 });
  assert.deepEqual(sync([historyRow()]), { stored: 0, mergeRequestsStored: 0 });
  assert.deepEqual(sync([historyRow({ deploymentId: 17, status: 'skipped' }), historyRow({ deploymentId: 16, status: 'created' })]),
    { stored: 2, mergeRequestsStored: 0 });
  assert.equal(deployments.observe(instance, base, repositoryId, { ...event(), status: 'created', deployment_id: 18 }), false);
  assert.equal(deployments.observe(instance, base, repositoryId, { ...event(), status: 'skipped', deployment_id: 19 }), false);
  assert.deepEqual(deployments.repositoryPage(instance, repositoryId, 0).items.map(row => row.status), ['skipped', 'created', 'success']);

  store.remove('gitlab_links', revisionLink);
  assert.deepEqual(deployments.issuePage('team-issue', 0), page);
  assert.equal(deployments.issuePage('team-issue', 1).items.length, 0);
  store.remove('gitlab_links', first);
  store.remove('gitlab_links', second);
  assert.equal(deployments.issuePage('team-issue', 0).total, 0);
});

test('a newer webhook fences in-flight reads while retaining independently qualified historical MR proof', t => {
  const { store, deployments } = fixture(t);
  const capturedAt = Date.now();
  assert.equal(deployments.observe(instance, base, repositoryId, event()), true);
  const sync = (rows: Omit<GitlabDeployment, 'instance'>[]) =>
    store.transaction(() => deployments.recordSync(instance, repositoryId, rows, capturedAt));
  const proof = [{ id: 100, iid: 40 }];
  assert.deepEqual(sync([historyRow({ changedAt: later, status: 'failed' })]), { stored: 0, mergeRequestsStored: 0 });
  assert.deepEqual(sync([historyRow({ sha: otherSha, mergeRequests: proof })]), { stored: 0, mergeRequestsStored: 0 });
  assert.deepEqual(sync([historyRow({ changedAt: started, mergeRequests: proof })]), { stored: 0, mergeRequestsStored: 1 });
  assert.equal(deployments.repositoryPage(instance, repositoryId, 0).items[0].source, undefined);
  const successful = deployments.exportRows();
  assert.deepEqual(successful[0].mergeRequests, proof);
  assert.equal(successful[0].changedAt, completed);
  assert.equal(successful[0].status, 'success');

  const linkId = `gitlab:${instance}:${repositoryId}:merge_request:100:team-issue`;
  store.put('gitlab_links', { id: linkId, issueId: 'team-issue', projectId: repositoryId, iid: 40, kind: 'merge_request', state: 'merged' });
  assert.equal(deployments.issuePage('team-issue', 0).total, 1);
  assert.equal(deployments.observe(instance, base, repositoryId, { ...event(), status: 'failed', status_changed_at: later }), true);
  assert.equal(deployments.issuePage('team-issue', 0).total, 0);
  assert.equal(deployments.repositoryPage(instance, repositoryId, 0).items[0].mergeRequests, undefined);
  assert.deepEqual(deployments.exportRows()[0].mergeRequests, proof);

  const corrected = deployments.exportRows();
  store.transaction(() => deployments.restore(corrected, exportedAt));
  assert.deepEqual(deployments.exportRows(), corrected);
  assert.equal(deployments.issuePage('team-issue', 0).total, 0);
  assert.throws(() => sync([historyRow({ deploymentId: 16 }), historyRow({ deploymentId: 17, repositoryId: 31 })]), GitlabDeploymentError);
  assert.deepEqual(deployments.exportRows(), corrected);
});

test('deployment metadata upgrades old SQLite and validates bounded backup association pairs before replacing rows', t => {
  const { dir, store, deployments } = fixture(t);
  assert.equal(deployments.observe(instance, base, repositoryId, event()), true);
  const legacy = deployments.exportRows();
  store.db.exec(`DROP TABLE gitlab_deployment_merge_requests;
    ALTER TABLE gitlab_deployments DROP COLUMN source;
    ALTER TABLE gitlab_deployments DROP COLUMN webhook_received_at;`);
  const upgradedStore = new Store(dir);
  t.after(() => upgradedStore.db.close());
  const upgraded = new GitlabDeployments(upgradedStore);
  assert.deepEqual(upgraded.exportRows(), legacy);
  assert.deepEqual(upgradedStore.transaction(() => upgraded.recordSync(instance, repositoryId,
    [historyRow({ deploymentId: 16, mergeRequests: [{ id: 100, iid: 40 }] })], Date.now())), { stored: 1, mergeRequestsStored: 1 });

  const backup = upgraded.exportRows();
  const withoutNewFields = { ...backup[1], source: undefined, mergeRequests: undefined };
  for (const invalid of [
    { source: 'webhook' }, { mergeRequests: [{ id: 100, iid: '40' }] }, { mergeRequests: [{ id: 100, iid: 40, repositoryId: 31 }] },
    { mergeRequests: [{ id: 100, iid: 40 }, { id: 100, iid: 41 }] }, { mergeRequests: [{ id: 100, iid: 40 }, { id: 101, iid: 40 }] },
    { mergeRequests: Array.from({ length: 251 }, (_, index) => ({ id: index + 100, iid: index + 40 })) },
  ]) {
    assert.throws(() => upgradedStore.transaction(() => upgraded.restore([backup[0], { ...withoutNewFields, ...invalid }], exportedAt)), GitlabDeploymentError);
    assert.deepEqual(upgraded.exportRows(), backup);
  }

  upgradedStore.transaction(() => upgraded.restore(legacy, exportedAt));
  assert.deepEqual(upgraded.exportRows(), legacy);
  upgradedStore.transaction(() => upgraded.restore(backup, exportedAt));
  assert.deepEqual(upgraded.exportRows(), backup);

  // Old positive proofs are retained when multiple capped scans yield different partial pages.
  const bulk = Array.from({ length: 250 }, (_, index) => ({ id: index + 100, iid: index + 40 }));
  assert.deepEqual(upgradedStore.transaction(() => upgraded.recordSync(instance, repositoryId,
    [historyRow({ deploymentId: 16, mergeRequests: bulk })], Date.now())), { stored: 0, mergeRequestsStored: 249 });
  assert.deepEqual(upgradedStore.transaction(() => upgraded.recordSync(instance, repositoryId,
    [historyRow({ deploymentId: 16, mergeRequests: [{ id: 500, iid: 1500 }] })], Date.now())), { stored: 0, mergeRequestsStored: 0 });
  assert.deepEqual(upgraded.exportRows()[1].mergeRequests, bulk);
});
