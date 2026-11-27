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
import { zip } from '../fixtures/legacy-export-zip.mjs';

const sourceFieldId = 'jira:components';
const sourceProject = { id: '4100', key: 'ORIG', name: 'Jira 컴포넌트 프로젝트' };
const fieldName = 'Jira 컴포넌트';
const firstComponent = { id: '4201', name: '검색' };
const secondComponent = { id: '4202', name: '저장' };
const unusedComponent = { id: '4203', name: '미배정 선택지' };
const titles = ['이름이 바뀐 Jira 선택지', 'Jira에서 비운 선택', '필드가 빠진 응답', '불완전한 컴포넌트 응답', '팀이 수정한 선택'];

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-jira-components-'));
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
  const actor = { 'X-Actor-Id': 'user-seo' };
  async function call<T = unknown>(route: string, method = 'GET', input?: unknown, status = 200): Promise<T> {
    const response = await fetch(base + route, {
      method, headers: { ...actor, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${body}`);
    return JSON.parse(body) as T;
  }
  async function upload(filename: string, bytes: Buffer): Promise<LegacyPackageSummary> {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: 'synthetic-jira-components' });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { ...actor, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body) as LegacyPackageSummary;
  }
  const options = (pkg: LegacyPackageSummary) => call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  const preview = (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  function apply(plan: MigrationPreview) {
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    return call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    }, 201);
  }
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  return { dataDir, call, upload, options, preview, apply, workspace };
}

function removeProjectionFromStagedPackage(dataDir: string, pkg: LegacyPackageSummary) {
  const db = new DatabaseSync(join(dataDir, 'donefac.sqlite'));
  try {
    const removed = db.prepare(`DELETE FROM legacy_records WHERE package_id=? AND
      ((kind='field' AND source_id=?) OR (kind='option' AND json_extract(json,'$.containerId')=?))`)
      .run(pkg.id, sourceFieldId, sourceFieldId);
    assert.equal(removed.changes, 6);
    const fieldPath = `$.metadata.fields."${sourceFieldId}"`;
    const updated = db.prepare(`UPDATE legacy_records SET json=json_remove(json,?)
      WHERE package_id=? AND kind='issue' AND json_type(json,?) IS NOT NULL`).run(fieldPath, pkg.id, fieldPath);
    assert.equal(updated.changes, titles.length + 1);
    const counts = Object.fromEntries(db.prepare('SELECT kind, COUNT(*) AS total FROM legacy_records WHERE package_id=? GROUP BY kind')
      .all(pkg.id).map(row => [row.kind, row.total]));
    db.prepare('UPDATE legacy_packages SET json=? WHERE id=?').run(JSON.stringify({ ...pkg, counts }), pkg.id);
  } finally { db.close(); }
}

function administratorPackage(): Buffer {
  const issue = (id: string, projectId: string, number: number, title: string) =>
    `<Issue id="${id}" project="${projectId}" number="${number}" summary="${title}" status="1" issuetype="3"
      created="2025-01-01T00:00:00Z" updated="2025-01-02T00:00:00Z"/>`;
  const component = ({ id, name }: typeof firstComponent, projectId: string) =>
    `<Component id="${id}" project="${projectId}" cname="${name}"/>`;
  const membership = (issueId: string, componentId: string) =>
    `<NodeAssociation sourceNodeId="${issueId}" sourceNodeEntity="Issue" sinkNodeId="${componentId}"
      sinkNodeEntity="Component" associationType="IssueComponent"/>`;
  const originalRows = titles.map((title, index) => {
    const id = String(4401 + index);
    return `${issue(id, sourceProject.id, index + 1, title)}${membership(id, firstComponent.id)}${membership(id, secondComponent.id)}`;
  }).join('\n');
  const xml = `<entity-engine-xml>
    <Project id="${sourceProject.id}" pkey="${sourceProject.key}" name="${sourceProject.name}"/>
    <Project id="5100" pkey="NEIGHBOR" name="별도 Jira 프로젝트"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    ${[firstComponent, secondComponent, unusedComponent].map(value => component(value, sourceProject.id)).join('\n')}
    ${component({ id: '5201', name: firstComponent.name }, '5100')}
    ${component({ id: '5202', name: '다른 프로젝트 선택' }, '5100')}
    ${originalRows}
    ${issue('5401', '5100', 1, '별도 프로젝트 구성')}${membership('5401', '5201')}
  </entity-engine-xml>`;
  return zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]);
}

function restPackage(): Buffer {
  const issue = (index: number, title: string, fields: Record<string, unknown>) => ({
    id: String(4401 + index), key: `${sourceProject.key}-${index + 1}`,
    fields: { project: sourceProject, summary: title, created: '2025-01-01T00:00:00Z', updated: '2025-01-03T00:00:00Z',
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, ...fields },
  });
  const renamed = { id: Number(secondComponent.id), name: 'Jira에서 바뀐 저장 이름' };
  return Buffer.from(JSON.stringify({ issues: [
    issue(0, titles[0], { components: [renamed] }),
    issue(1, titles[1], { components: [] }),
    issue(2, titles[2], {}),
    issue(3, titles[3], { components: [firstComponent, { name: '검증할 수 없는 값' }] }),
    issue(4, titles[4], { components: [] }),
    issue(5, '이름이 바뀐 선택지에 연결한 새 업무', { components: [renamed] }),
  ] }));
}

test('Jira Component memberships and project choices survive native import and conservative REST refresh', async t => {
  const f = await fixture(t);
  const source = await f.upload('jira-components.zip', administratorPackage());
  // A package staged before the projection still contains the raw component declarations and associations.
  removeProjectionFromStagedPackage(f.dataDir, source);
  const initialOptions = await f.options(source);
  const sourceField = initialOptions.fields.find(field => field.sourceValue === sourceFieldId);
  assert.ok(sourceField);
  assert.equal(sourceField.suggestedKind, 'multi_select');
  assert.equal(initialOptions.defaultConfiguration.fields[sourceField.id], 'multi_select');
  const initial = await f.apply(await f.preview(initialOptions.defaultConfiguration));
  const workspace = await f.workspace();
  const project = workspace.projects.find(value => value.key === sourceProject.key);
  const neighbor = workspace.projects.find(value => value.key === 'NEIGHBOR');
  assert.ok(project && neighbor && initial.import.projectIds.includes(project.id));
  const projectId = project.id;
  const field = workspace.issueSchemas?.find(value => value.projectId === project.id)?.fields.find(value => value.name === fieldName);
  const neighborField = workspace.issueSchemas?.find(value => value.projectId === neighbor.id)?.fields.find(value => value.name === fieldName);
  assert.ok(field && neighborField);
  assert.equal(field.kind, 'multi_select');
  assert.deepEqual(field.options.map(option => option.name).sort(), [firstComponent.name, secondComponent.name, unusedComponent.name].sort());
  assert.deepEqual(neighborField.options.map(option => option.name).sort(), [firstComponent.name, '다른 프로젝트 선택'].sort());
  const optionsByName = new Map(field.options.map(option => [option.name, option.id]));
  const searchId = optionsByName.get(firstComponent.name), storageId = optionsByName.get(secondComponent.name);
  assert.ok(searchId && storageId);
  assert.notEqual(neighborField.options.find(option => option.name === firstComponent.name)?.id, searchId);
  const membership = [searchId, storageId].sort();

  function ticket(snapshot: WorkspaceSnapshot, number: number) {
    const issue = snapshot.issues.find(value => value.projectId === projectId && value.key === `${sourceProject.key}-${number}`);
    assert.ok(issue, `Jira-${number}`);
    return issue;
  }
  const initialIssues = titles.map((_, index) => ticket(workspace, index + 1));
  for (const issue of initialIssues) {
    assert.deepEqual([...(issue.customFields?.[field.id] as string[])].sort(), membership);
    assert.equal(issue.moduleId, null);
  }

  type Backup = WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] };
  const backup = await f.call<Backup>('/export');
  const originalIssue = backup.sourceRecords.find(record => record.targetId === initialIssues[0].id && record.record.kind === 'issue');
  assert.equal(originalIssue?.jiraCustomFieldHashes?.[field.id]?.sourceFieldId, sourceFieldId);
  await f.call('/import', 'POST', { data: backup });

  const beforeRefresh = await f.workspace();
  const edited = ticket(beforeRefresh, 5);
  const local = await f.call<Issue>(`/issues/${edited.id}`, 'PATCH', { expectedVersion: edited.version,
    customFields: { ...edited.customFields, [field.id]: [storageId] } });
  const delta = await f.upload('jira-components-refresh.json', restPackage());
  const options = await f.options(delta);
  const target = options.appendTarget;
  const deltaField = options.fields.find(value => value.sourceValue === sourceFieldId);
  assert.equal(target?.projectId, project.id);
  assert.ok(target && deltaField);
  const plan = await f.preview({ ...options.defaultConfiguration, appendTo: {
    projectId: project.id, refreshCustomFields: true,
    statuses: Object.fromEntries(options.statuses.map(value => [value.id, target.statuses.find(status => status.label === value.label)!.id])),
    issueTypes: Object.fromEntries(options.issueTypes.map(value => [value.id, target.issueTypes.find(kind => kind.name === value.label)!.id])),
    fields: { [deltaField.id]: field.id },
  } });
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.issues, 1);
  assert.equal(plan.counts.updatedCustomFields, 2);
  assert.equal(plan.counts.conflictingCustomFields, 1);
  assert.deepEqual(Object.fromEntries(plan.issueRefresh?.map(review => [review.sourceKey, review.customFields?.map(change => [change.fieldId, change.decision])]) ?? []), {
    'ORIG-1': [[field.id, 'apply']], 'ORIG-2': [[field.id, 'apply']], 'ORIG-5': [[field.id, 'conflict']],
  });

  const applied = await f.apply(plan);
  const updated = await f.workspace();
  assert.equal(ticket(updated, 1).id, initialIssues[0].id);
  assert.deepEqual(ticket(updated, 1).customFields?.[field.id], [storageId]);
  assert.equal(ticket(updated, 2).customFields?.[field.id], null);
  for (const number of [3, 4]) assert.deepEqual(ticket(updated, number), ticket(beforeRefresh, number));
  assert.deepEqual(ticket(updated, 5), local);
  assert.deepEqual(ticket(updated, 6).customFields?.[field.id], [storageId]);
  assert.deepEqual(updated.issueSchemas?.find(value => value.projectId === project.id)?.fields.find(value => value.id === field.id)?.options, field.options);

  const afterBackup = await f.call<Backup>('/export');
  const clear = afterBackup.sourceRecords.find(record => record.sourceImportId === applied.import.id && record.targetId === initialIssues[1].id);
  assert.equal(clear?.jiraCustomFieldHashes?.[field.id]?.sourceFieldId, sourceFieldId);
  assert.deepEqual(clear?.record.metadata.jiraSnapshotCustomFields, [sourceFieldId]);
  assert.deepEqual((clear?.record.metadata.fields as Record<string, unknown> | undefined)?.components, []);
});
