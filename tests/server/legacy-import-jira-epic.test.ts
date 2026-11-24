import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegacyDataset } from '../../shared/types.js';
import { parseJira } from '../../server/legacy-import-jira.js';

function readBackup(entities: string): LegacyDataset {
  const xml = `<entity-engine-xml><Project id="20" pkey="OLD"/>${entities}</entity-engine-xml>`;
  return parseJira(new Map([['entities.xml', Buffer.from(xml)]]), 'jira-admin-epic');
}

function issue(id: number, attribute = '') {
  return `<Issue id="${id}" project="20" number="${id}" ${attribute}/>`;
}

function link(id: number, source: number, destination: number, type = 800) {
  return `<IssueLink id="${id}" linktype="${type}" source="${source}" destination="${destination}"/>`;
}

function find(data: LegacyDataset, id: string) {
  const row = data.records.find(row => row.id === id);
  assert.ok(row, id);
  return row;
}

test('Jira admin Epic link projects a hierarchy by verified database style and source direction', () => {
  const data = readBackup(`
    <IssueType id="55" pname="에픽"/><IssueType id="56" pname="Story"/>
    <IssueType id="57" pname="하위 작업" style="jira_subtask"/>
    ${issue(100, 'issuetype="55"')}${issue(101, 'issuetype="56"')}
    ${issue(200)}${issue(201)}${issue(202)}${issue(203)}
    ${issue(204, 'issuetype="57"')}${issue(205, 'issuetype="57"')}
    <IssueLinkType id="800" linkname="에픽 관계" style="jira_gh_epic_story"/>
    <IssueLinkType id="850" linkname="Epic-Story Link" inward="has Epic" outward="is Epic of"/>
    <IssueLinkType id="860" style="jira_subtask"/>
    ${link(801, 100, 200)}${link(802, 101, 201)}${link(803, 100, 202, 850)}
    ${link(804, 203, 203)}${link(805, 100, 204)}${link(806, 100, 205)}${link(807, 101, 205, 860)}
  `);

  const child = find(data, 'issue:200');
  assert.equal(child.parentId, '100');
  assert.equal(child.metadata.jiraParentSourceId, '100');
  assert.ok(child.references.some(reference => reference.relation === 'parent' && reference.sourceId === '100'));
  for (const id of [100, 101, 201, 202, 203, 204]) {
    const row = find(data, `issue:${id}`);
    assert.equal(row.parentId, null);
    assert.equal(row.metadata.jiraParentSourceId, undefined);
  }
  assert.equal(find(data, 'issue:205').metadata.jiraParentSourceId, '101');
  assert.deepEqual(find(data, 'relation:801').references.map(({ relation, sourceId }) => [relation, sourceId]),
    [['source', '100'], ['target', '200']]);
});

test('Jira admin Epic link preserves ambiguous endpoints, parents and type declarations as source evidence', () => {
  const data = readBackup(`
    ${[100, 101, 200, 201, 202, 203].map(id => issue(id)).join('')}
    <IssueLinkType id="800" style="jira_gh_epic_story"/>
    ${link(801, 100, 200)}${link(802, 101, 200)}${link(803, 100, 201)}${link(804, 100, 202)}
    <IssueLink id="805" linktype="800" source="101" destination="201"><destination>202</destination></IssueLink>
    <IssueLink id="806" linktype="800" source="100" destination="203"><source>101</source></IssueLink>
  `);

  for (const id of [200, 201, 202, 203]) {
    const row = find(data, `issue:${id}`);
    assert.equal(row.parentId, null);
    assert.equal(row.metadata.jiraParentSourceId, undefined);
  }
  assert.deepEqual(find(data, 'relation:805').metadata.jiraEpicLinkClaims, {
    ids: ['805'], typeIds: ['800'], sourceIds: ['101'], destinationIds: ['201', '202'],
  });

  for (const declarations of [
    '<IssueLinkType id="800" style="jira_gh_epic_story"/><IssueLinkType id="800" style="ordinary"/>',
    '<IssueLinkType id="800" style="jira_gh_epic_story"/><IssueLinkType id="850" style="jira_gh_epic_story"/>',
    '<IssueLinkType id="800" style="ordinary"><style>jira_gh_epic_story</style></IssueLinkType>',
  ]) {
    const ambiguous = readBackup(`${issue(100)}${issue(200)}${declarations}${link(801, 100, 200)}`);
    assert.equal(find(ambiguous, 'issue:200').parentId, null);
    assert.ok(find(ambiguous, 'relation:801').metadata.jiraEpicLinkClaims);
  }
});

test('Jira search XML projects only a typed Epic Link with one scalar value', () => {
  const typedKey = 'com.pyxis.greenhopper.jira:gh-epic-link';
  const customfield = (id: number, key: string, values: string[]) =>
    `<customfields><customfield id="customfield_${id}" key="${key}"><customfieldname>Epic Link</customfieldname>` +
    `<customfieldvalues>${values.map(value => `<customfieldvalue>${value}</customfieldvalue>`).join('')}</customfieldvalues>` +
    `</customfield></customfields>`;
  const searchItem = (id: number, number: number, additional = '') =>
    `<item><key id="${id}">OLD-${number}</key><project id="20" key="OLD"/>${additional}</item>`;
  const xml = `<rss><channel>${searchItem(100, 1)}${searchItem(101, 2)}
    ${searchItem(200, 3, customfield(1001, typedKey, ['OLD-1']))}
    ${searchItem(201, 4, customfield(1002, 'example.plugin:fake-epic-link', ['OLD-1']))}
    ${searchItem(202, 5, customfield(1001, typedKey, ['OLD-1', 'OLD-2']))}
    </channel></rss>`;
  const data = parseJira(new Map([['search.xml', Buffer.from(xml)]]), 'jira-search-epic');

  assert.equal(find(data, 'issue:200').metadata.jiraParentSourceId, '100');
  assert.equal(find(data, 'issue:200').metadata.jiraParentSourceKey, 'OLD-1');
  assert.equal(find(data, 'issue:201').metadata.jiraParentSourceId, undefined);
  assert.equal(find(data, 'issue:201').metadata.jiraEpicParentUnresolved, undefined);
  assert.equal(find(data, 'issue:202').parentId, null);
  assert.equal(find(data, 'issue:202').metadata.jiraEpicParentUnresolved, true);
  assert.deepEqual(find(data, 'issue:202').metadata.fields, { customfield_1001: ['OLD-1', 'OLD-2'] });
});

test('Jira REST search uses the root Epic Link schema and distinguishes a clear from missing evidence', () => {
  const project = { id: '20', key: 'OLD' };
  const restIssue = (id: number, number: number, fields: Record<string, unknown> = {}) =>
    ({ id: String(id), key: `OLD-${number}`, fields: { project, ...fields } });
  const input = {
    names: { customfield_1001: 'Epic Link', customfield_1002: 'Epic Link' },
    schema: {
      customfield_1001: { type: 'any', customId: 1001, custom: 'com.pyxis.greenhopper.jira:gh-epic-link' },
      customfield_1002: { type: 'string', customId: 1002, custom: 'example.plugin:fake-epic-link' },
    },
    issues: [restIssue(100, 1), restIssue(101, 2), restIssue(200, 3, { customfield_1001: 'OLD-1' }),
      restIssue(201, 4, { customfield_1002: 'OLD-1' }), restIssue(202, 5, { customfield_1001: ['OLD-1', 'OLD-2'] }),
      restIssue(203, 6, { customfield_1001: null })],
  };
  const data = parseJira(new Map([['search.json', Buffer.from(JSON.stringify(input))]]), 'jira-rest-epic');

  assert.equal(find(data, 'issue:200').metadata.jiraParentSourceId, '100');
  assert.equal(find(data, 'issue:200').metadata.jiraParentSourceKey, 'OLD-1');
  assert.equal(find(data, 'issue:201').metadata.jiraParentSourceId, undefined);
  assert.equal(find(data, 'issue:201').metadata.jiraEpicParentUnresolved, undefined);
  assert.equal(find(data, 'issue:202').parentId, null);
  assert.equal(find(data, 'issue:202').metadata.jiraEpicParentUnresolved, true);
  assert.deepEqual(find(data, 'issue:202').metadata.fields, { customfield_1001: ['OLD-1', 'OLD-2'] });
  assert.equal(find(data, 'issue:203').metadata.jiraParentSourceId, null);
});

test('conflicting Jira REST field declarations in one package withhold the Epic projection', () => {
  const epicField = 'customfield_1001';
  const project = { id: '20', key: 'OLD' };
  const part = (rows: { id: string; key: string; fields: object }[], custom: string) => Buffer.from(JSON.stringify({
    schema: { [epicField]: { customId: 1001, custom } }, issues: rows,
  }));
  const files = new Map([
    ['first.json', part([
      { id: '100', key: 'OLD-1', fields: { project } },
      { id: '200', key: 'OLD-2', fields: { project, [epicField]: 'OLD-1' } },
    ], 'com.pyxis.greenhopper.jira:gh-epic-link')],
    ['second.json', part([{ id: '201', key: 'OLD-3', fields: { project, [epicField]: 'OLD-1' } }], 'example.plugin:other')],
  ]);
  const data = parseJira(files, 'jira-conflicting-epic-schema');

  const child = find(data, 'issue:200');
  assert.equal(child.parentId, null);
  assert.equal(child.metadata.jiraEpicParentUnresolved, true);
  assert.deepEqual(child.metadata.fields, { [epicField]: 'OLD-1' });
  assert.equal(find(data, `field:${epicField}`).metadata.jiraEpicLinkField, undefined);
});
