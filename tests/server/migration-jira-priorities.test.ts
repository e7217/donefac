import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  Issue, JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview,
  SourceImport, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';
import { jiraFieldDigest } from '../../server/migration-planner.js';
import { historicalMigrationBackup } from '../fixtures/historical-migration-backup.js';

const priorityRows = `
  <Priority id="11" pname="Highest"/><Priority id="22" pname="High"/>
  <Priority id="33" pname="Medium"/><Priority id="44" pname="Low"/>
  <Priority id="66" pname="Needs review"/><Priority id="77" pname="Highest"/><Priority id="77" pname="Low"/>`;

function adminXml(issues: [number, string, number?, string?][], updated = '2025-03-02T00:00:00Z') {
  return `<entity-engine-xml>
    <Project id="42" pkey="ORIG" name="원본 프로젝트"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    ${priorityRows}
    ${issues.map(([number, summary, priority, extra = '']) => `<Issue id="${200 + number}" project="42" number="${number}"
      summary="${summary}" status="1" issuetype="3" created="2025-03-01T00:00:00Z" updated="${updated}"
      ${priority === undefined ? '' : `priority="${priority}"`}>${extra}</Issue>`).join('\n')}
  </entity-engine-xml>`;
}

type Backup = WorkspaceSnapshot & { schemaVersion: number; sourceRecords: SourceRecordArchive[]; sourceImports: SourceImport[] };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-jira-priorities-'));
  const service = createApp({ dataDir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;

  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, status = 200) {
    const bytes = typeof input === 'string';
    const response = await fetch(base + path, {
      method, headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' },
      body: input === undefined ? undefined : bytes ? input : JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${body}`);
    return JSON.parse(body) as T;
  }

  async function review(xml: string, projectId?: string) {
    const parameters = new URLSearchParams({ filename: 'entities.xml', product: 'jira', instanceKey: 'priority-admin-xml' });
    const source = await call<LegacyPackageSummary>(`/legacy-import/packages?${parameters}`, 'POST', xml, 201);
    const { defaultConfiguration, appendTarget, statuses, issueTypes } = await call<MigrationOptions>(`/migrations/options?packageId=${source.id}`);
    let configuration: MigrationConfiguration = { ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(project => ({ ...project, key: 'JPRI' })) };
    if (projectId) {
      assert.equal(appendTarget?.projectId, projectId);
      configuration = { ...defaultConfiguration, appendTo: {
        projectId, refreshExisting: true,
        statuses: Object.fromEntries(statuses.map(option => [option.id, appendTarget.statuses.find(status => status.label === option.label)!.id])),
        issueTypes: Object.fromEntries(issueTypes.map(option => [option.id, appendTarget.issueTypes.find(type => type.name === option.label)!.id])),
        fields: {},
      } };
    }
    return call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  }

  async function apply(preview: MigrationPreview) {
    assert.ok(preview.canApply, JSON.stringify(preview.notices));
    const result = await call<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, 'POST', {
      expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
    }, 201);
    return result.import.projectIds[0];
  }

  const snapshot = () => call<WorkspaceSnapshot>('/workspace');
  const projectIssues = async (projectId: string) => (await snapshot()).issues.filter(issue => issue.projectId === projectId);
  return { call, review, apply, projectIssues };
}

test('administrator priority IDs use recognized option names and explicitly review uncertain source evidence', async t => {
  const f = await fixture(t);
  const preview = await f.review(adminXml([
    [1, '가장 높은 업무', 11], [2, '높은 업무', 22], [3, '보통 업무', 33], [4, '낮은 업무', 44],
    [5, '해석할 수 없는 이름', 66], [6, '찾을 수 없는 원본 ID', 55], [7, '겹치는 원본 ID', 77],
    [8, '한 업무의 두 값', 22, '<priority>44</priority>'], [9, '우선순위가 없는 업무'],
  ]));
  const sourceRows = preview.notices.filter(row => row.code === 'JIRA_PRIORITY_UNRESOLVED');
  assert.deepEqual(sourceRows.map(row => row.recordId?.split('/').at(-1)).sort(), ['issue:205', 'issue:206', 'issue:207', 'issue:208']);
  assert.ok(preview.requiredAcknowledgements.includes('JIRA_PRIORITY_UNRESOLVED'));
  const projectId = await f.apply(preview);
  const issues = await f.projectIssues(projectId);
  assert.deepEqual(issues.map(({ priority }) => priority), ['urgent', 'high', 'medium', 'low', 'medium', 'medium', 'medium', 'medium', 'medium']);
  const urgent = await f.call<Issue[]>('/issues/query', 'POST', { projectId, priorities: ['urgent'] });
  assert.deepEqual(urgent.map(({ id }) => id), [issues[0].id]);
  const backup = await f.call<Backup>('/export');
  const archived = backup.sourceRecords.find(row => row.targetId === issues[0].id && row.record.kind === 'issue');
  assert.equal(archived?.jiraIssueFieldHashes?.priority, jiraFieldDigest('priority', 'urgent'));
  assert.equal(backup.sourceRecords.find(row => row.record.sourceId === 'builtin:priority:11')?.record.title, 'Highest');
  assert.equal(backup.sourceRecords.find(row => row.record.sourceId === 'builtin:priority:77')?.record.metadata.jiraPriorityAmbiguous, true);

  const previewView = (jql: string) => f.call<JiraSavedViewPreview>('/views/jira/preview', 'POST', { projectId, jql });
  const qualified = await previewView('project = ORIG AND priority IN (11, High)');
  assert.deepEqual(qualified.filters.priorities, ['urgent', 'high']);
  assert.deepEqual(qualified.issues.map(({ id }) => id), issues.slice(0, 2).map(({ id }) => id));
  for (const value of ['33', '55', '77']) {
    const invalid = await f.call<{ error: string }>('/views/jira/preview', 'POST', { projectId, jql: `priority = ${value}` }, 400);
    assert.match(invalid.error, /우선순위/u);
  }
});

test('new appended Jira issues get mapped priority and old receipts keep their historic default when comparing refreshes', async t => {
  const initial = await fixture(t);
  const projectId = await initial.apply(await initial.review(adminXml([
    [1, '수정하지 않은 이전 업무', 11], [2, '팀에서 수정한 이전 업무', 22], [3, '원본 값이 그대로인 업무', 11],
  ])));
  const backup = historicalMigrationBackup(await initial.call<Backup>('/export'), 38);
  for (const receipt of backup.sourceImports) delete receipt.integrity;
  for (const source of backup.sourceRecords) delete source.jiraIssueFieldHashes;
  for (const issue of backup.issues) if (issue.projectId === projectId) issue.priority = 'medium';
  const f = await fixture(t);
  await f.call('/import', 'POST', { data: backup });
  const unsupportedLegacy = await f.call<{ error: string }>('/views/jira/preview', 'POST',
    { projectId, jql: 'project = ORIG AND priority = 11' }, 400);
  assert.match(unsupportedLegacy.error, /원본 값과 현재 우선순위/u);
  const [, changed] = await f.projectIssues(projectId);
  await f.call<Issue>(`/issues/${changed.id}`, 'PATCH', { expectedVersion: changed.version, priority: 'urgent' });

  const review = await f.review(adminXml([
    [1, '수정하지 않은 이전 업무', 44], [2, '팀에서 수정한 이전 업무', 44], [3, '원본 값이 그대로인 업무', 11],
    [4, '추가 이관한 Jira 업무', 22],
  ], '2025-03-03T00:00:00Z'), projectId);
  const priorityDecisions = review.issueRefresh?.flatMap(({ sourceKey, fields }) => fields.filter(row => row.field === 'priority')
    .map(({ decision }) => [sourceKey, decision]));
  assert.deepEqual(priorityDecisions, [['ORIG-1', 'apply'], ['ORIG-2', 'conflict']]);
  await f.apply(review);
  const issues = await f.projectIssues(projectId);
  assert.deepEqual(issues.map(({ priority }) => priority), ['low', 'urgent', 'medium', 'high']);
  assert.equal(issues[1].id, changed.id);
});

test('a renamed administrator priority retains the proven native mapping of its stable Jira ID', async t => {
  const f = await fixture(t);
  const projectId = await f.apply(await f.review(adminXml([[1, '원래 업무', 11], [2, '별도 높은 업무', 22]])));
  const [original] = await f.projectIssues(projectId);
  const later = adminXml([[1, '이름이 바뀐 업무', 11]], '2025-03-03T00:00:00Z')
    .replace('<Priority id="11" pname="Highest"/>', '<Priority id="11" pname="Critical"/>');
  await f.apply(await f.review(later, projectId));
  for (const value of ['11', 'Highest', 'Critical']) {
    const preview = await f.call<JiraSavedViewPreview>('/views/jira/preview', 'POST', { projectId, jql: `priority = ${value}` });
    assert.deepEqual(preview.filters.priorities, ['urgent']);
    assert.deepEqual(preview.issues.map(({ id, title }) => [id, title]), [[original.id, '이름이 바뀐 업무']]);
  }
});
