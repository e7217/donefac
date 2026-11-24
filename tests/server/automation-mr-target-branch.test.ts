import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { AutomationPreview, AutomationRule, AutomationRun, GitlabIssueRefreshResult, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const repositoryId = 42;
const otherRepositoryId = 73;
const projectId = 'project-neo';
const sourceBranch = 'feature/shared-work';
const secret = 'synthetic-mr-target-webhook';
const token = 'synthetic-mr-target-read';
const settingsPath = '/integrations/gitlab';
const rulesPath = '/automation-rules';
const projectRead = `/forge/api/v4/projects/${repositoryId}`;
const mergeRequestRead = (iid: number) => `${projectRead}/merge_requests/${iid}`;
type Backup = Pick<WorkspaceSnapshot, 'gitlabLinks'> & { schemaVersion: number; automationRules: AutomationRule[]; automationRuns: AutomationRun[] };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-mr-target-branch-'));
  const runtime = createApp({ dataDir, seed: true, outboundWorker: false, deadlineReminderWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  const details = new Map<string, unknown>();
  const calls: { path: string; method?: string; credential?: string | string[] }[] = [];
  const mock = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture.test').pathname;
    calls.push({ path, method: req.method, credential: req.headers['private-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (path === projectRead) res.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/repo', web_url: repoUrl }));
    else if (details.has(path)) res.end(JSON.stringify(details.get(path)));
    else res.writeHead(404).end('{}');
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      await Promise.all([server, mock].map(instance => {
        instance.closeAllConnections();
        return new Promise<void>(resolve => instance.close(() => resolve()));
      }));
    } finally { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  await Promise.all([once(server, 'listening'), once(mock, 'listening')]);
  const localUrl = (instance: typeof server) => {
    const address = instance.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  const apiUrl = `${localUrl(server)}/api`;
  const baseUrl = `${localUrl(mock)}/forge`;
  const repoUrl = `${baseUrl}/team/repo`;
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, headers: Record<string, string> = {}) {
    const response = await fetch(apiUrl + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000),
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return JSON.parse(raw) as T;
  }
  const { version } = await call<GitlabSettings>(settingsPath);
  await call(settingsPath, 'PATCH', { expectedVersion: version, baseUrl, projectIds: [repositoryId, otherRepositoryId], token, webhookSecret: secret });
  const ruleInput = {
    projectId, name: 'Merge to the release target', enabled: true, trigger: 'merge_request.merged', gitlabProjectIds: [repositoryId],
    branchPattern: 'feature/*', targetBranchPattern: 'ma*', issueTypes: [], fromStatuses: ['in_progress'], toStatusId: 'done', priority: 10,
  };
  function mergeRequest(iid: number, issue: Issue, targetBranch: unknown, state: 'opened' | 'merged', time: string) {
    return { id: 1000 + iid, iid, project_id: repositoryId, target_project_id: repositoryId, source_project_id: otherRepositoryId,
      title: `${issue.key} Synthetic merge request`, state, action: state === 'opened' ? 'open' : 'merge', source_branch: sourceBranch,
      target_branch: targetBranch, sha: 'a'.repeat(40), updated_at: time, ...(state === 'merged' ? { merged_at: time } : {}),
      url: `${repoUrl}/-/merge_requests/${iid}`, web_url: `${repoUrl}/-/merge_requests/${iid}` };
  }
  return {
    call, calls, ruleInput, details, mergeRequest,
    issue: (title: string) => call<Issue>('/issues', 'POST', { projectId, title, status: 'in_progress' }, 201),
    snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    hook: (attributes: ReturnType<typeof mergeRequest>) => call<{ linked: number; runs: AutomationRun[] }>(`${settingsPath}/webhook`, 'POST', {
      object_kind: 'merge_request', project: { id: repositoryId, web_url: repoUrl }, object_attributes: attributes,
    }, 200, { 'X-Gitlab-Token': secret, 'X-Gitlab-Event': 'Merge Request Hook', 'webhook-id': randomUUID() }),
  };
}

test('MR automation matches targets independently from the source and preserves target evidence through backup', async t => {
  const f = await fixture(t);
  const rule = await f.call<AutomationRule>(rulesPath, 'POST', f.ruleInput, 201);
  assert.equal(rule.targetBranchPattern, 'ma*');
  const sameSource = await f.issue('Same source, different targets');
  const preview = (targetBranch?: unknown, branch = sourceBranch, status = 200) => f.call<AutomationPreview>('/automation/preview', 'POST', {
    rule, issueIds: [sameSource.id], sample: { trigger: rule.trigger, gitlabProjectId: repositoryId, branch, targetBranch },
  }, status);
  assert.equal((await preview('main')).outcomes[0]?.outcome, 'changed');
  assert.equal((await preview('develop')).outcomes[0]?.outcome, 'ignored');
  assert.equal((await preview()).outcomes[0]?.outcome, 'ignored');
  assert.equal((await preview('main', 'fix/shared-work')).outcomes[0]?.outcome, 'ignored');
  await preview('main invalid', sourceBranch, 400);
  assert.deepEqual(await f.call<AutomationRun[]>('/automation-runs'), []);
  await f.call(rulesPath, 'POST', { ...f.ruleInput, trigger: 'pipeline.succeeded' }, 400);

  for (const [iid, branch] of [[31, 'develop'], [32, undefined], [33, 'main invalid'], [34, 17], [38, token], [39, secret]] as const) {
    const received = await f.hook(f.mergeRequest(iid, sameSource, branch, 'merged', new Date().toISOString()));
    assert.equal(received.linked, 1);
    assert.equal(received.runs.length, 1);
    const [run] = received.runs;
    assert.equal(run.ruleId, rule.id);
    assert.equal(run.outcome, 'ignored');
    assert.equal(run.context?.branch, sourceBranch);
    assert.equal(run.context?.targetBranch, branch === 'develop' ? branch : undefined);
    const snapshot = await f.snapshot();
    assert.equal(snapshot.gitlabLinks.find(link => link.issueId === sameSource.id && link.iid === iid)?.targetBranch,
      branch === 'develop' ? branch : undefined);
    assert.deepEqual(snapshot.issues.find(issue => issue.id === sameSource.id), sameSource);
  }

  const genuine = f.mergeRequest(35, sameSource, 'main', 'merged', new Date().toISOString());
  const foreign = await f.hook({ ...genuine, target_project_id: otherRepositoryId });
  assert.equal(foreign.linked, 0);
  assert.equal(foreign.runs.length, 1);
  assert.equal(foreign.runs[0].outcome, 'ignored');
  assert.match(foreign.runs[0].reason, /대상 저장소/u);
  assert.equal(foreign.runs[0].context?.targetBranch, undefined);
  const beforeGenuine = await f.snapshot();
  assert.deepEqual(beforeGenuine.issues.find(issue => issue.id === sameSource.id), sameSource);
  assert.equal(beforeGenuine.gitlabLinks.some(link => link.issueId === sameSource.id && link.iid === 35), false);
  const [matched] = (await f.hook(genuine)).runs;
  assert.equal(matched?.outcome, 'changed');
  assert.equal(matched.ruleId, rule.id);
  assert.equal(matched.context?.targetBranch, 'main');
  assert.equal((await f.snapshot()).issues.find(issue => issue.id === sameSource.id)?.status, 'done');

  const broad = await f.call<AutomationRule>(rulesPath, 'POST', {
    ...f.ruleInput, targetBranchPattern: undefined, name: 'Older source-only rule', priority: 20,
  }, 201);
  for (const [iid, branch] of [[36, undefined], [37, 'main invalid']] as const) {
    const issue = await f.issue(`Older source-only rule handles MR ${iid}`);
    const [run] = (await f.hook(f.mergeRequest(iid, issue, branch, 'merged', new Date().toISOString()))).runs;
    assert.equal(run?.ruleId, broad.id);
    assert.equal(run.outcome, 'changed');
    assert.equal(run.context?.targetBranch, undefined);
  }
  assert.deepEqual(f.calls, []);

  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.automationRules.find(value => value.id === rule.id)?.targetBranchPattern, 'ma*');
  assert.equal(backup.automationRuns.find(run => run.id === matched.id)?.context?.targetBranch, 'main');
  assert.equal(backup.gitlabLinks.find(link => link.issueId === sameSource.id && link.iid === 35)?.targetBranch, 'main');

  const rulePath = `${rulesPath}/${rule.id}`;
  const cleared = await f.call<AutomationRule>(rulePath, 'PATCH', { expectedVersion: rule.version, targetBranchPattern: null });
  assert.equal(Object.hasOwn(cleared, 'targetBranchPattern'), false);
  const reset = await f.call<AutomationRule>(rulePath, 'PATCH', { expectedVersion: cleared.version, targetBranchPattern: 'develop' });
  assert.equal(reset.targetBranchPattern, 'develop');
  const pipelineRule = await f.call<AutomationRule>(rulePath, 'PATCH', { expectedVersion: reset.version, trigger: 'pipeline.succeeded' });
  assert.equal(pipelineRule.trigger, 'pipeline.succeeded');
  assert.equal(Object.hasOwn(pipelineRule, 'targetBranchPattern'), false);

  await f.call('/import', 'POST', { data: backup });
  const restored = (await f.call<AutomationRule[]>(rulesPath)).find(value => value.id === rule.id);
  assert.ok(restored && restored.version > pipelineRule.version);
  assert.deepEqual(restored, { ...rule, enabled: false, enabledAt: null, version: restored.version });
  assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).find(run => run.id === matched.id), matched);
  assert.equal((await f.snapshot()).gitlabLinks.find(link => link.issueId === sameSource.id && link.iid === 35)?.targetBranch, 'main');

  const olderWithTarget = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 112 } }, 400);
  assert.match(olderWithTarget.error, /schemaVersion 113/u);
  const legacy = { ...structuredClone(backup), schemaVersion: 112 };
  for (const value of legacy.automationRules) delete value.targetBranchPattern;
  for (const run of legacy.automationRuns) if (run.context) delete run.context.targetBranch;
  for (const link of legacy.gitlabLinks) delete link.targetBranch;
  await f.call('/import', 'POST', { data: legacy });
  const older = (await f.call<AutomationRule[]>(rulesPath)).find(value => value.id === rule.id);
  assert.ok(older);
  assert.equal(older.enabled, false);
  assert.equal(Object.hasOwn(older, 'targetBranchPattern'), false);
  assert.equal((await f.call<AutomationRun[]>('/automation-runs')).find(run => run.id === matched.id)?.context?.targetBranch, undefined);
});

test('exact MR status review uses the freshly verified target branch without applying the transition', async t => {
  const f = await fixture(t);
  const rule = await f.call<AutomationRule>(rulesPath, 'POST', f.ruleInput, 201);
  const issue = await f.issue('Review only after checking the exact target');
  const iid = 21;
  const openedAt = new Date().toISOString();
  await f.hook(f.mergeRequest(iid, issue, 'main', 'opened', openedAt));
  const before = await f.snapshot();
  const linked = before.gitlabLinks.find(link => link.issueId === issue.id && link.iid === iid);
  assert.ok(linked);
  assert.equal(linked.targetBranch, 'main');
  assert.deepEqual(await f.call<AutomationRun[]>('/automation-runs'), []);
  const reviewPath = `/issues/${issue.id}/gitlab-links/${encodeURIComponent(linked.id)}/status-review`;
  let lastTimestamp = Date.parse(openedAt);
  const review = async (target: unknown, timestamp?: string) => {
    lastTimestamp = timestamp === undefined ? Math.max(Date.now(), lastTimestamp + 1) : Date.parse(timestamp);
    const time = new Date(lastTimestamp).toISOString();
    f.details.set(mergeRequestRead(iid), f.mergeRequest(iid, issue, target, 'merged', time));
    const result = await f.call<GitlabIssueRefreshResult>(reviewPath, 'POST', {});
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.links.map(link => link.id), [linked.id]);
    assert.equal(result.links[0].sourceBranch, sourceBranch);
    return result;
  };
  assert.equal((await review(undefined)).statusReview, undefined);
  assert.equal((await review('main invalid')).statusReview, undefined);
  const develop = await review('develop');
  assert.equal(develop.links[0].targetBranch, 'develop');
  assert.equal(develop.statusReview, undefined);

  const main = await review('main');
  assert.equal(main.links[0].targetBranch, 'main');
  assert.ok(main.statusReview?.kind === 'suggestion');
  const { suggestion } = main.statusReview;
  assert.equal(suggestion.rule.id, rule.id);
  assert.equal(suggestion.issueId, issue.id);
  assert.equal(suggestion.toStatus, 'done');
  assert.equal(suggestion.evidence.link.id, linked.id);
  assert.equal(suggestion.evidence.link.targetBranch, 'main');
  assert.equal(suggestion.evidence.trigger, 'merge_request.merged');

  const retargeted = await review('develop', main.links[0].updatedAt);
  assert.equal(retargeted.statusReview, undefined);
  assert.deepEqual(retargeted.links[0], { ...main.links[0], targetBranch: 'develop' });
  assert.deepEqual((await f.snapshot()).gitlabLinks.find(link => link.id === linked.id), retargeted.links[0]);
  const rejected = await f.call<{ details?: { reason: string } }>(`/issues/${issue.id}`, 'PATCH', {
    expectedVersion: issue.version, status: suggestion.toStatus, gitlabStatusSuggestionToken: suggestion.token,
  }, 409);
  assert.equal(rejected.details?.reason, 'gitlab_status_suggestion_stale');
  assert.deepEqual((await f.snapshot()).issues, before.issues);
  assert.deepEqual(await f.call<AutomationRun[]>('/automation-runs'), []);
  assert.deepEqual(f.calls, Array.from({ length: 5 }, () => [projectRead, mergeRequestRead(iid)]).flat()
    .map(path => ({ path, method: 'GET', credential: token })));
});
