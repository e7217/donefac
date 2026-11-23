import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegacyDataset, LegacyValue } from '../../shared/types.js';
import { parseJira } from '../../server/legacy-import-jira.js';
import { JIRA_COMPONENTS_FIELD_ID as field, projectJiraComponents } from '../../server/legacy-import-jira-components.js';

const parse = (path: string, source: string) => parseJira(new Map([[path, Buffer.from(source)]]), 'jira-components');
const find = (data: LegacyDataset, id: string) => {
  const row = data.records.find(item => item.id === id);
  assert.ok(row, `Missing ${id}`);
  return row;
};
const fields = (data: LegacyDataset, issueId: string) => find(data, `issue:${issueId}`).metadata.fields as Record<string, LegacyValue>;
const selection = (id: string, name: string) => ({ id, name });
const options = (data: LegacyDataset) => data.records.filter(row => row.kind === 'option' && row.containerId === field);
const warned = (data: LegacyDataset, issueId: string) => data.diagnostics.some(row =>
  row.recordId === `issue:${issueId}` && row.code === 'JIRA_COMPONENT_EVIDENCE_UNRESOLVED');

test('administrator XML joins every exact IssueComponent within its project and preserves raw evidence', () => {
  const relation = (issue: string, component: string, extra = '', type = 'IssueComponent') =>
    `<NodeAssociation sourceNodeEntity="Issue" sourceNodeId="${issue}" sinkNodeEntity="Component" sinkNodeId="${component}" associationType="${type}" ${extra}/>`;
  const data = parse('entities.xml', `<entity-engine-xml>
    <Project id="20" pkey="OLD"/><Project id="30" pkey="NEW"/>
    <Issue id="100" project="20" number="1"/><Issue id="101" project="20" number="2"/>
    <Issue id="102" project="20" number="3"/><Issue id="103" project="20" number="4"/>
    <Issue id="104" project="20" number="5"/><Issue id="105" project="20" number="6"/><Issue id="106" project="20" number="7"/>
    <Component id="11" project="20" cname="펌웨어"/><Component id="12" project="20" cname="검증"/>
    <Component id="13" project="30" cname="검증"/><Component id="14" project="20" cname="보드"/>
    <Component id="14" project="30" cname="보드"/>
    ${relation('100', '11')}${relation('100', '12', 'destNodeId="12" destNodeEntity="Component"')}
    ${relation('101', '11')}${relation('101', '13')}
    ${relation('102', '12', 'destNodeId="13" destNodeEntity="Component"')}
    ${relation('103', '99')}${relation('104', '11', '', 'UnrelatedAssociation')}
    ${relation('105', '14')}
    ${relation('106', '11')}
    <NodeAssociation sourceNodeEntity="Issue" sourceNodeId="106" sinkNodeEntity="Component" sinkNodeId="12" associationType="IssueComponent">
      <associationType>UnrelatedAssociation</associationType>
    </NodeAssociation>
  </entity-engine-xml>`);
  const fieldRow = find(data, `field:${field}`);
  assert.equal(fieldRow.title, 'Jira 컴포넌트');
  assert.equal(fieldRow.metadata.fieldType, 'multi_select');
  assert.deepEqual(fields(data, '100')[field], [selection('11', '펌웨어'), selection('12', '검증')]);
  for (const id of ['101', '102', '103', '105', '106']) {
    assert.equal(fields(data, id)[field], undefined);
    assert.equal(warned(data, id), true);
  }
  assert.equal(fields(data, '104')[field], undefined);
  assert.deepEqual(options(data).map(row => row.metadata.originalId), ['11', '12', '13']);
  assert.deepEqual(find(data, `option:${field}:12`).references.filter(ref => ref.kind === 'project'),
    [{ kind: 'project', sourceId: '20', relation: 'project' }]);
  assert.deepEqual(find(data, `option:${field}:12`).references.find(ref => ref.relation === 'sourceDefinition'),
    { kind: 'option', sourceId: 'builtin:components:12', relation: 'sourceDefinition' });
  assert.deepEqual(find(data, 'issue:100').references.filter(ref => ref.relation === 'jiraComponentMembership'), [
    { kind: 'relation', sourceId: 'association:100:Component:11:IssueComponent', relation: 'jiraComponentMembership' },
    { kind: 'relation', sourceId: 'association:100:Component:12:IssueComponent', relation: 'jiraComponentMembership' },
  ]);
  assert.equal(find(data, 'option:builtin:components:13').metadata.project, '30');
  const ambiguous = find(data, 'relation:association:102:Component:12:IssueComponent');
  assert.equal(ambiguous.metadata.sinkNodeId, '12');
  assert.equal(ambiguous.metadata.destNodeId, '13');
});

test('REST membership verifies the whole vector and only literal empty REST arrays provide a clear', () => {
  const row = (id: number, components?: unknown, project = { id: '20', key: 'OLD' }) => ({
    id, key: `${project.key}-${id}`, fields: { project, summary: 'Original issue',
      ...(components !== undefined && { components }) },
  });
  const valid = [{ id: '11', name: '펌웨어', projectId: 20 }, { id: 12, name: '검증', project: 'OLD' }];
  const data = parse('issues.json', JSON.stringify({ issues: [
    row(100, valid), row(101, []), row(102), row(103, null),
    row(104, [...valid, { name: 'unknown' }]), row(105, [{ id: '11', name: '검증', projectId: '30' }]),
    row(106, [{ id: '50', name: '공유 이름' }]),
    row(107, [{ id: '50', name: '공유 이름' }], { id: '30', key: 'NEW' }),
    row(108, [{ id: '11', name: '새 이름' }], { id: '', key: 'OLD' }),
    row(109, [[{ id: '11', name: '펌웨어' }]]),
  ] }));
  assert.deepEqual(fields(data, '100')[field], [selection('11', '펌웨어'), selection('12', '검증')]);
  assert.deepEqual(fields(data, '100').components, valid);
  assert.deepEqual(fields(data, '108')[field], [selection('11', '펌웨어')]);
  assert.deepEqual(find(data, `option:${field}:11`).references.filter(ref => ref.kind === 'project').map(ref => ref.sourceId),
    ['20', 'OLD']);
  assert.equal(fields(data, '101')[field], undefined);
  assert.deepEqual(find(data, 'issue:101').metadata.jiraSnapshotCustomFields, [field]);
  for (const id of ['102', '103', '104', '105', '106', '107', '109']) {
    assert.equal(fields(data, id)[field], undefined);
    assert.equal(find(data, `issue:${id}`).metadata.jiraSnapshotCustomFields, undefined);
    assert.equal(warned(data, id), id !== '102');
  }
  const clearOnly = parse('empty.json', JSON.stringify({ issues: [row(101, [])] }));
  assert.ok(find(clearOnly, `field:${field}`));
  assert.deepEqual(options(clearOnly), []);
});

test('RSS exact IDs match REST IDs and staged raw fields can be projected in place exactly once', () => {
  const issue = (id: string, components: string) =>
    `<item><key id="${id}">OLD-${id}</key><project id="20" key="OLD"/>${components}</item>`;
  const data = parse('search.xml', `<rss><channel>
    ${issue('100', '<component id="11">펌웨어</component><component id="12">검증</component>')}
    ${issue('101', '<component id="11">펌웨어</component><component>검증</component>')}
    ${issue('102', '<component id="11"><label>펌웨어</label></component>')}
    ${issue('103', '')}
  </channel></rss>`);
  assert.deepEqual(fields(data, '100')[field], [selection('11', '펌웨어'), selection('12', '검증')]);
  assert.deepEqual(fields(data, '100').component, [{ id: '11', text: '펌웨어' }, { id: '12', text: '검증' }]);
  for (const id of ['101', '102', '103']) {
    assert.equal(fields(data, id)[field], undefined);
    assert.equal(find(data, `issue:${id}`).metadata.jiraSnapshotCustomFields, undefined);
  }
  const staged = structuredClone(data);
  staged.records = staged.records.filter(row => row.sourceId !== field && row.containerId !== field);
  delete fields(staged, '100')[field];
  projectJiraComponents(staged);
  projectJiraComponents(staged);
  assert.deepEqual(staged.records, data.records);
  assert.deepEqual(staged.diagnostics, data.diagnostics);
});

test('CSV repeated label columns preserve exact punctuation and keep project scopes distinct', () => {
  const data = parse('issues.csv', [
    'Issue key,Issue id,Summary,Project key,Project id,Component/s,Component/s',
    'OLD-1,100,First,OLD,20,"Firmware, QA",Board',
    'OLD-2,101,Second,OLD,20,Board,board',
    'NEW-1,102,Other project,NEW,30,Board,',
    'OLD-3,103,Empty,OLD,20,,',
    'OLD-4,104,Conflicting key,NEW,30,Board,',
    'OLD-5,105,Incomplete,OLD,20,Board',
    'SAME-1,106,Inconsistent project,SAME,40,Board,',
    'SAME-2,107,Inconsistent project,SAME,41,Board,',
  ].join('\n'));
  const asOptions = (id: string) => fields(data,id)[field] as Array<{ id: string; name: string }>;
  assert.deepEqual(fields(data, '100')['Component/s'], ['Firmware, QA', 'Board']);
  assert.deepEqual(asOptions('100').map(row => row.name), ['Firmware, QA', 'Board']);
  assert.equal(asOptions('100')[1].id, asOptions('101')[0].id);
  assert.notEqual(asOptions('101')[0].id, asOptions('101')[1].id);
  assert.notEqual(asOptions('100')[1].id, asOptions('102')[0].id);
  assert.deepEqual(options(data).map(row => row.metadata.jiraComponentLabelOnly), [true, true, true, true]);
  for (const id of ['103', '104', '105', '106', '107']) {
    assert.equal(fields(data, id)[field], undefined);
    assert.equal(find(data, `issue:${id}`).metadata.jiraSnapshotCustomFields, undefined);
  }
  assert.ok(data.diagnostics.some(row => row.code === 'JIRA_COMPONENT_LABEL_ONLY'));
});

test('unresolved-only packages do not duplicate warnings when reopened for planning', () => {
  const parsed = parse('issues.json', JSON.stringify({ issues: [{
    id: 100, key: 'OLD-1', fields: { project: { id: 20, key: 'OLD' }, components: [{ name: 'Label without ID' }] },
  }] }));
  assert.equal(warned(parsed, '100'), true);
  assert.equal(parsed.records.some(row => row.sourceId === field), false);
  const reopened = structuredClone(parsed);
  projectJiraComponents(reopened);
  projectJiraComponents(reopened);
  assert.deepEqual(reopened, parsed);
});
