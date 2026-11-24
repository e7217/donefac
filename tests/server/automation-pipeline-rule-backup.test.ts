import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { AutomationRule, AutomationRun, GitlabSettings } from '../../shared/types.js';

type Backup = { schemaVersion: number; automationRules: AutomationRule[]; automationRuns: AutomationRun[] };

test('native backup retains pipeline rule filters and decision metadata and restores rules disabled', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-pipeline-rule-backup-'));
  const runtime = createApp({ dataDir, seed: true, outboundWorker: false, deadlineReminderWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const api = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, headers: Record<string, string> = {}) {
    const response = await fetch(api + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    assert.equal(response.status, status, raw);
    return JSON.parse(raw) as T;
  }
  const gitlab = '/integrations/gitlab';
  const baseUrl = 'https://git.example.test';
  const webUrl = `${baseUrl}/team/repo`;
  const webhookSecret = 'synthetic-pipeline-rule-backup';
  const { version } = await call<GitlabSettings>(gitlab);
  await call(gitlab, 'PATCH', { expectedVersion: version, baseUrl, projectIds: [42], webhookSecret });
  const rule = await call<AutomationRule>('/automation-rules', 'POST', {
    name: 'Pipeline branch verification', projectId: 'project-neo', enabled: true, trigger: 'pipeline.succeeded',
    gitlabProjectIds: [42], branchPattern: 'feature/*', pipelineSources: ['push', 'schedule'], pipelineRefKind: 'branch',
    issueTypes: [], fromStatuses: ['in_progress'], toStatusId: 'done',
  }, 201);
  const delivered = await call<{ runs: AutomationRun[] }>(`${gitlab}/webhook`, 'POST', {
    object_kind: 'pipeline', project: { id: 42, web_url: webUrl },
    object_attributes: {
      id: 202, iid: 2, ref: 'feature/NEO-1', sha: 'a'.repeat(40), source: 'push', tag: false, status: 'success',
      finished_at: new Date().toISOString(), url: `${webUrl}/-/pipelines/202`,
    },
  }, 200, { 'X-Gitlab-Token': webhookSecret, 'X-Gitlab-Event': 'Pipeline Hook', 'X-Gitlab-Event-UUID': randomUUID() });
  const [run] = delivered.runs;
  assert.equal(run?.outcome, 'changed');
  assert.ok(run.context);
  assert.equal(run.context.pipelineSource, 'push');
  assert.equal(run.context.pipelineTag, false);

  const backup = await call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.automationRules, [rule]);
  assert.deepEqual(backup.automationRuns, [run]);
  assert.deepEqual(rule.pipelineSources, ['push', 'schedule']);
  assert.equal(rule.pipelineRefKind, 'branch');
  const legacyRule = { ...rule };
  delete legacyRule.pipelineSources;
  delete legacyRule.pipelineRefKind;
  const legacyContext = { ...run.context };
  delete legacyContext.pipelineSource;
  delete legacyContext.pipelineTag;
  const legacyRun = { ...run, context: legacyContext };
  const legacy = { ...backup, schemaVersion: 111, automationRules: [legacyRule], automationRuns: [legacyRun] };

  for (const data of [
    { ...legacy, automationRules: [{ ...legacyRule, pipelineSources: rule.pipelineSources }] },
    { ...legacy, automationRules: [{ ...legacyRule, pipelineRefKind: rule.pipelineRefKind }] },
    { ...legacy, automationRuns: [{ ...run, context: { ...legacyContext, pipelineSource: 'push' } }] },
    { ...legacy, automationRuns: [{ ...run, context: { ...legacyContext, pipelineTag: false } }] },
  ]) {
    const result = await call<{ error: string }>('/import', 'POST', { data }, 400);
    assert.match(result.error, /schemaVersion 112/u);
  }
  for (const data of [
    { ...backup, automationRules: [{ ...rule, pipelineSources: ['push', 'push'] }] },
    { ...backup, automationRules: [{ ...rule, trigger: 'merge_request.merged' }] },
    { ...backup, automationRuns: [{ ...run, context: { ...run.context, pipelineSource: 'invalid source' } }] },
    { ...backup, automationRuns: [{ ...run, context: { ...run.context, pipelineTag: 'false' } }] },
    { ...backup, automationRuns: [{ ...run, context: { ...run.context, objectKind: 'merge_request', trigger: 'merge_request.merged' } }] },
  ]) await call('/import', 'POST', { data }, 400);
  assert.deepEqual(await call<AutomationRule[]>('/automation-rules'), [rule]);
  assert.deepEqual(await call<AutomationRun[]>('/automation-runs'), [run]);

  await call('/import', 'POST', { data: backup });
  const [restored] = await call<AutomationRule[]>('/automation-rules');
  assert.ok(restored.version > rule.version);
  assert.deepEqual(restored, { ...rule, enabled: false, enabledAt: null, version: restored.version });
  assert.deepEqual(await call<AutomationRun[]>('/automation-runs'), [run]);

  await call('/import', 'POST', { data: legacy });
  const [restoredLegacy] = await call<AutomationRule[]>('/automation-rules');
  assert.deepEqual(restoredLegacy, { ...legacyRule, enabled: false, enabledAt: null, version: restoredLegacy.version });
  assert.deepEqual(await call<AutomationRun[]>('/automation-runs'), [legacyRun]);
});
