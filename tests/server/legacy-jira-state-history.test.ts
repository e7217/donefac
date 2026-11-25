import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJira } from '../../server/legacy-import-jira.js';
import { LegacyImportError } from '../../server/legacy-import-model.js';
import type { LegacyDataset } from '../../shared/types.js';

function parseJson(files: Record<string, unknown>): LegacyDataset {
  return parseJira(new Map(Object.entries(files).map(([path, data]) => [path, Buffer.from(JSON.stringify(data))])), 'jira-fixture');
}

function parseXml(xml: string): LegacyDataset {
  return parseJira(new Map([['entities.xml', Buffer.from(`<entity-engine-xml>${xml}</entity-engine-xml>`)]]), 'jira-fixture');
}

function history(data: LegacyDataset, id: string) {
  const row = data.records.find(record => record.kind === 'history' && record.sourceId === id);
  assert.ok(row, `Missing history ${id}`);
  return row;
}

const jira = 'https://jira.example.test/jira/rest/api/3/issue';
const issue = { id: '1000', key: 'OLD-7', self: `${jira}/1000`, fields: { summary: 'REST issue' } };
const transition = { field: '상태', fieldId: 'status', fieldtype: 'jira', from: '1', fromString: '열림', to: '2', toString: '진행 중' };
const first = { id: '3000', created: '2020-01-03T10:00:00+0000', author: { accountId: 'alice' }, items: [transition] };
const next = { ...first, id: '3001' };

test('REST history preserves typed field evidence and scope without importing arbitrary properties', () => {
  const data = parseJson({ 'issue.json': { ...issue, changelog: { histories: [
    { ...first, restricted: true, visibility: { type: 'role', value: 'Developers', token: 'DO_NOT_STORE' },
      items: [{ ...transition, id: 6100, groupLevel: 'staff' }, { field: 'status', fieldId: 'customfield_10000', fieldType: 'custom', toString: '실제 상태와 무관' }] },
    { items: [{ fieldId: 'status', fromString: null, to: '3' }] }, { id: 'supplied id without provenance', items: [transition] },
  ] } } });
  const change = history(data, first.id);
  assert.equal(change.containerId, issue.id);
  assert.equal(change.authorId, 'alice');
  assert.deepEqual(change.metadata, {
    restricted: true, visibility: { type: 'role', value: 'Developers' },
    items: [{ ...transition, id: '6100', groupLevel: 'staff' }, { field: 'status', fieldId: 'customfield_10000', fieldType: 'custom', toString: '실제 상태와 무관' }],
  });
  assert.equal(history(data, 'json:1000:history:1').metadata.syntheticId, true);
  assert.deepEqual(history(data, 'json:1000:history:1').metadata.items, [{ fieldId: 'status', fromString: '', to: '3' }]);
  assert.equal(history(data, 'supplied id without provenance').metadata.syntheticId, true);
  assert.ok(!JSON.stringify(data).includes('DO_NOT_STORE'));
});

test('Jira Backup ChangeGroup and ChangeItem retain explicit visibility and source fields', () => {
  const data = parseXml(`<Project id="20" pkey="OLD"/>
    <Issue id="1000" project="20" number="7"/>
    <ChangeGroup id="3000" issue="1000" created="2020-01-03 10:00:00.000" level="staff" public="false"/>
    <ChangeItem id="6100" group="3000" field="status" fieldtype="jira" oldvalue="1" oldstring="열림" newvalue="2" newstring="진행 중" rolelevel="33"/>`);
  const change = history(data, '3000');
  assert.equal(change.containerId, '1000');
  assert.deepEqual(change.references, [{ kind: 'issue', sourceId: '1000', relation: 'historyOf' }]);
  assert.deepEqual(change.metadata, { level: 'staff', public: 'false', items: [{ id: '6100', field: 'status', fieldtype: 'jira',
    oldvalue: '1', oldstring: '열림', newvalue: '2', newstring: '진행 중', rolelevel: '33' }], jiraWorkflowStatusChangePositions: [0] });
});

test('duplicate Jira Backup ChangeGroup IDs cannot reassign history to another issue', () => {
  const xml = `<Project id="20" pkey="OLD"/>
    <Issue id="1000" project="20" number="7"/><Issue id="1001" project="20" number="8"/>
    <ChangeGroup id="3000" issue="1000"/><ChangeGroup id="3000" issue="1001"/>
    <ChangeItem id="6100" group="3000" field="status" fieldtype="jira" oldvalue="1" newvalue="2"/>`;
  assert.throws(() => parseXml(xml), error => error instanceof LegacyImportError && error.status === 400 && /ChangeGroup/.test(error.message));
});

test('standalone changelog pages attach to the exact issue, deduplicate overlap, and prove coverage', () => {
  const data = parseJson({
    'a.json': { self: `${jira}/OLD-7/changelog?startAt=1&token=DO_NOT_STORE`, startAt: 1, total: 2, values: [next] },
    'b.json': { self: `${jira}/1000/changelog`, startAt: 0, total: 2, values: [first] },
    'z.json': { ...issue, changelog: { startAt: 0, total: 2, histories: [first] } },
  });
  assert.equal(history(data, first.id).containerId, issue.id);
  assert.equal(history(data, next.id).containerId, issue.id);
  assert.equal(data.records.filter(record => record.kind === 'history').length, 2);
  assert.ok(!data.diagnostics.some(row => row.code === 'HISTORY_PARTIAL' || row.code === 'HISTORY_NOT_PROVIDED'));
  assert.ok(!JSON.stringify(data).includes('DO_NOT_STORE'));
});

test('standalone pages never infer ownership from a filename or a different issue or Jira host', () => {
  const data = parseJson({
    '1000.json': { startAt: 0, total: 1, values: [first] },
    'OLD-7.json': { self: `${jira}/9900/changelog`, startAt: 0, total: 1, values: [first] },
    'issue-1000.json': { self: `${jira.replace('jira.example.test', 'other.example.test')}/1000/changelog`, startAt: 0, total: 1, values: [first] },
    'issue.json': issue,
    'other-issue.json': { ...issue, self: undefined, id: '1001', key: 'OLD-8' },
    'other-page.json': { self: `${jira}/1001/changelog`, startAt: 0, total: 1, values: [first] },
  });
  assert.equal(data.records.filter(record => record.kind === 'history').length, 0);
  assert.equal(data.diagnostics.filter(row => row.code === 'HISTORY_PAGE_OWNER_UNRESOLVED').length, 4);
  assert.ok(data.diagnostics.some(row => row.code === 'HISTORY_NOT_PROVIDED'));
});

test('missing or inconsistent embedded changelog data is distinct from an explicitly empty page', () => {
  const envelopes = [{}, { values: null }, { total: 0, histories: [] }, { values: [] },
    { total: 2, histories: [first] }, { startAt: 'unknown', histories: [] }, { total: 0, histories: [next] }];
  const data = parseJson({ 'issues.json': { issues: envelopes.map((changelog, index) => ({
    id: String(1100 + index), key: `OLD-${index + 1}`, fields: issue.fields, changelog,
  })) } });
  assert.deepEqual(data.diagnostics.filter(row => row.code === 'HISTORY_NOT_PROVIDED').map(row => row.recordId), ['issue:1100', 'issue:1101']);
  assert.deepEqual(data.diagnostics.filter(row => row.code === 'HISTORY_PARTIAL').map(row => row.recordId), ['issue:1104', 'issue:1105', 'issue:1106']);
  assert.equal(history(data, first.id).containerId, '1104');
  assert.equal(history(data, next.id).containerId, '1106');
});

test('standalone pages keep a partial diagnostic when offsets are missing', () => {
  const data = parseJson({
    'a.json': { self: `${jira}/1000/changelog`, startAt: 1, total: 2, values: [next] }, 'issue.json': issue,
  });
  assert.equal(history(data, next.id).containerId, issue.id);
  assert.ok(data.diagnostics.some(row => row.code === 'HISTORY_PARTIAL' && row.recordId === 'issue:1000'));
  assert.ok(!data.diagnostics.some(row => row.code === 'HISTORY_NOT_PROVIDED'));
});

test('conflicting standalone group data cannot overwrite the observed transition or access scope', () => {
  const files = {
    'a.json': { self: `${jira}/1000/changelog`, startAt: 0, total: 1, values: [{ ...first, restricted: true }] },
    'issue.json': { ...issue, changelog: { histories: [first] } },
  };
  assert.throws(() => parseJson(files), error => error instanceof LegacyImportError && error.status === 400 && /변경 이력 ID/.test(error.message));
});
