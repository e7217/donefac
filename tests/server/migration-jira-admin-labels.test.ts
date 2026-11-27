import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions,
  MigrationPreview, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { parseJira } from '../../server/legacy-import-jira.js';

const labelsType = 'com.atlassian.jira.plugin.system.customfieldtypes:labels';
const textType = 'com.atlassian.jira.plugin.system.customfieldtypes:textfield';
const streamId = '10101';
const reviewerId = '10102';
const project = '<Project id="42" pkey="ORIG" name="라벨 이관 프로젝트"/>';
const issueType = '<Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>';
const custom = `<CustomField id="${streamId}" cfname="배포 라벨" customfieldtypekey="${labelsType}"/>
  <CustomField id="${reviewerId}" cfname="검토 라벨" customfieldtypekey="${labelsType}"/>
  <CustomField id="10109" cfname="일반 메모" customfieldtypekey="${textType}"/>`;
const issue = (id: number, key: number, title: string, updated: string) => `<Issue id="${id}" project="42" number="${key}"
  summary="${title}" status="1" issuetype="3" created="2025-01-01T00:00:00Z" updated="${updated}"/>`;
const stream = (id: number, owner: number, value: string) => `<Label id="${id}" issue="${owner}" fieldid="${streamId}" label="${value}"/>`;
const xml = (rows: string) => `<entity-engine-xml>${project}${issueType}${custom}${rows}</entity-engine-xml>`;

test('Jira admin Label rows only enter the system field when the field ID is absent', () => {
  const rows = `
    ${issue(100, 1, '라벨 범위를 확인할 업무', '2025-01-02T00:00:00Z')}
    <Label id="201" issue="100" label="standard"/>
    ${stream(202, 100, 'pilot')}
    <Label id="203" issue="100" fieldid="99999" label="unknown-field"/>
    <Label id="204" issue="100" fieldid="10109" label="wrong-type"/>
    <Label id="205" issue="100" fieldid="" label="blank-field"/>
    <Label id="206" issue="100" fieldid="${streamId}" label="ambiguous-field"><fieldid>${reviewerId}</fieldid></Label>
    <Label id="207" issue="100" label="ambiguous-owner"><issue>101</issue></Label>
    <Label id="208" issue="999" fieldid="${streamId}" label="unknown-issue"/>
    <CustomFieldValue id="209" issue="100" customfield="${streamId}" stringvalue="unproven-value"/>`;
  const dataset = parseJira(new Map([['entities.xml', Buffer.from(xml(rows))]]), 'jira-admin-labels-test');
  const source = dataset.records.find(record => record.id === 'issue:100');
  assert.ok(source);
  assert.deepEqual(source.metadata.fields, { issuetype: '3', status: '1', labels: ['standard'], [streamId]: ['pilot'] });
  assert.deepEqual(source.metadata.jiraAdminUnconfirmedLabelValues, [
    { id: '209', fieldId: streamId, value: { stringvalue: 'unproven-value' } },
  ]);
  assert.deepEqual(source.references.filter(reference => reference.relation === 'customField'), [
    { kind: 'field', sourceId: streamId, relation: 'customField' },
  ]);
  const archived = dataset.records.filter(record => record.metadata.jiraAdminLabel).map(record => record.metadata.jiraAdminLabel);
  assert.equal(archived.length, 6);
  assert.ok(archived.some(row => JSON.stringify(row) === JSON.stringify({
    id: ['206'], issue: ['100'], fieldid: [streamId, reviewerId], label: ['ambiguous-field'],
  })));
  assert.equal(dataset.diagnostics.filter(diagnostic => diagnostic.code === 'JIRA_ADMIN_LABEL_SCOPE_UNVERIFIED').length, 7);
});

test('Jira custom labels migrate through typed choices, native backup and subsequent updates', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-jira-admin-labels-'));
  const app = createApp({ dataDir, outboundWorker: false });
  const server = app.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      app.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, status = 200): Promise<T> {
    const isXml = typeof input === 'string';
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': isXml ? 'application/octet-stream' : 'application/json' },
      body: input === undefined ? undefined : isXml ? input : JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${body}`);
    return JSON.parse(body) as T;
  }
  async function options(rows: string) {
    const source = await call<LegacyPackageSummary>(
      '/legacy-import/packages?filename=entities.xml&product=jira&instanceKey=synthetic-admin-labels', 'POST', xml(rows), 201,
    );
    return call<MigrationOptions>(`/migrations/options?packageId=${source.id}`);
  }
  function preview(configuration: MigrationConfiguration) {
    return call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  }
  function apply(candidate: MigrationPreview) {
    assert.equal(candidate.canApply, true, JSON.stringify(candidate.notices));
    return call<MigrationApplyResult>(`/migrations/previews/${candidate.id}/apply`, 'POST', {
      expectedVersion: candidate.version, acknowledgements: candidate.requiredAcknowledgements,
    }, 201);
  }

  const early = '2025-01-02T00:00:00Z';
  const latest = '2025-01-03T00:00:00Z';
  const initial = await options(`
    ${issue(100, 1, '먼저 옮길 업무', early)}${issue(101, 2, '이미 지정된 선택지', early)}
    <Label id="201" issue="100" label="global-only"/>
    ${stream(202, 100, 'pilot')}${stream(203, 100, 'pilot')}${stream(204, 101, 'release')}
    <Label id="205" issue="100" fieldid="${reviewerId}" label="pilot"/>
    <Label id="206" issue="100" fieldid="99999" label="archived-only"/>`);
  const fieldOption = initial.fields.find(field => field.sourceValue === streamId);
  assert.ok(fieldOption);
  assert.equal(fieldOption.requiredKind, 'multi_select');
  assert.equal(initial.defaultConfiguration.fields[fieldOption.id], 'multi_select');
  const incompatible = await preview({ ...initial.defaultConfiguration, fields: {
    ...initial.defaultConfiguration.fields, [fieldOption.id]: 'select',
  } });
  assert.equal(incompatible.canApply, false);
  assert.ok(incompatible.notices.some(notice => notice.code === 'JIRA_LABEL_FIELD_KIND'));

  const initialPreview = await preview(initial.defaultConfiguration);
  assert.ok(initialPreview.notices.some(notice => notice.code === 'SOURCE_JIRA_ADMIN_LABEL_SCOPE_UNVERIFIED'));
  const { import: imported } = await apply(initialPreview);
  const [projectId] = imported.projectIds;
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  const snapshot = await workspace();
  const first = snapshot.issues.find(item => item.projectId === projectId && item.title === '먼저 옮길 업무');
  const schema = snapshot.issueSchemas?.find(value => value.projectId === projectId);
  const streams = schema?.fields.find(field => field.name === '배포 라벨');
  const reviewers = schema?.fields.find(field => field.name === '검토 라벨');
  assert.ok(first && streams && reviewers);
  const inPilot = streams.options.find(option => option.name === 'pilot');
  const inRelease = streams.options.find(option => option.name === 'release');
  const inReview = reviewers.options.find(option => option.name === 'pilot');
  assert.ok(inPilot && inRelease && inReview);
  assert.notEqual(inPilot.id, inReview.id);
  assert.deepEqual(first.labels, ['global-only']);
  assert.deepEqual(first.customFields, { [streams.id]: [inPilot.id], [reviewers.id]: [inReview.id] });

  type Backup = WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] };
  const backup = await call<Backup>('/export');
  const raw = backup.sourceRecords.find(record => record.record.metadata.jiraAdminLabel);
  assert.ok(raw);
  assert.deepEqual(raw.record.metadata.jiraAdminLabel, { id: ['206'], issue: ['100'], fieldid: ['99999'], label: ['archived-only'] });
  const earliest = backup.sourceRecords.find(record => record.targetId === first.id && record.record.kind === 'issue');
  assert.equal(earliest?.jiraCustomFieldHashes?.[streams.id]?.sourceFieldId, streamId);
  await call('/import', 'POST', { data: backup });

  const delta = await options(`
    ${issue(100, 1, '먼저 옮길 업무', latest)}${issue(102, 3, '두 번째로 옮길 업무', latest)}
    ${stream(202, 100, 'release')}${stream(207, 102, 'pilot')}`);
  const target = delta.appendTarget;
  assert.ok(target);
  assert.equal(target.projectId, projectId);
  const appendTo: NonNullable<MigrationConfiguration['appendTo']> = {
    projectId, refreshCustomFields: true,
    statuses: Object.fromEntries(delta.statuses.map(option => [option.id, target.statuses.find(status => status.label === option.label)!.id])),
    issueTypes: Object.fromEntries(delta.issueTypes.map(option => [option.id, target.issueTypes.find(type => type.name === option.label)!.id])),
    fields: Object.fromEntries(delta.fields.map(option => [option.id, option.sourceValue === streamId ? streams.id : null])),
  };
  await apply(await preview({ ...delta.defaultConfiguration, appendTo }));
  const updated = await workspace();
  assert.deepEqual(updated.issues.find(item => item.id === first.id)?.customFields,
    { [streams.id]: [inRelease.id], [reviewers.id]: [inReview.id] });
  assert.deepEqual(updated.issues.find(item => item.id === first.id)?.labels, ['global-only']);
  const appended = updated.issues.find(item => item.projectId === projectId && item.title === '두 번째로 옮길 업무');
  assert.deepEqual(appended?.customFields, { [streams.id]: [inPilot.id] });
  assert.deepEqual(appended?.labels, []);
});
