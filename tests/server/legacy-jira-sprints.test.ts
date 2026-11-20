import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LegacyDataset } from '../../shared/types.js';
import { parseJira } from '../../server/legacy-import-jira.js';

const fieldType = 'com.pyxis.greenhopper.jira:gh-sprint';
const sprint = (data: LegacyDataset, id: string) => data.records.find(record => record.id === `option:builtin:sprints:${id}`);
const issue = (data: LegacyDataset, id: number) => data.records.find(record => record.id === `issue:${id}`)!;
const backup = (memberships: string) => `<entity-engine-xml>
  <Project id="10" pkey="PROJ" name="Sprint fixture"/>
  <Issue id="1" project="10" number="1" summary="Current and past"/>
  <Issue id="2" project="10" number="2" summary="No Sprint"/>
  <CustomField id="10000" cfname="Team iteration" customfieldtypekey="${fieldType}"/>
  <CustomField id="10001" cfname="Sprint" customfieldtypekey="com.atlassian.jira.plugin.system.customfieldtypes:textfield"/>
  ${memberships}
</entity-engine-xml>`;

function admin(entities: string, activeObjects: string): LegacyDataset {
  return parseJira(new Map([['entities.xml', Buffer.from(entities)], ['activeobjects.xml', Buffer.from(activeObjects)]]), 'fixture-jira');
}

function rest(issues: object[], schema?: object): LegacyDataset {
  return parseJira(new Map([['issues.json', Buffer.from(JSON.stringify({ issues, schema }))]]), 'fixture-jira');
}

function issueFields(id: number, fields: object) {
  return { id: String(id), key: `PROJ-${id}`, fields: { project: { id: '10', key: 'PROJ' }, summary: 'Fixture', ...fields } };
}

test('Jira administrator backup reads positional sprint rows and typed issue membership only', () => {
  const data = admin(backup(`
    <CustomFieldValue id="1" customfield="10000" issue="1" stringvalue="7"/>
    <CustomFieldValue id="2" customfield="10000" issue="1" stringvalue="8"/>
    <CustomFieldValue id="3" customfield="10001" issue="2" stringvalue="9"/>
  `), `<backup xmlns="http://www.atlassian.com/ao" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <table name="AO_60DB71_SPRINT"><column name="ID"/></table>
    <data tableName="AO_60DB71_SPRINT">
      <column name="NAME"/><column name="ID"/><column name="START_DATE"/><column name="CLOSED"/>
      <column name="END_DATE"/><column name="RAPID_VIEW_ID"/><column name="SECRET"/><column name="STARTED"/>
      <column name="COMPLETE_DATE"/><column name="GOAL"/>
      <row><string>In progress</string><integer>7</integer><long>1717200000000</long><boolean>false</boolean>
        <long>1717804800</long><integer>42</integer><string>STRIPPED_SPRINT_ROW</string><boolean>true</boolean>
        <long xsi:nil="true"/><string>Ship safely</string></row>
      <row><string>Prior sprint</string><integer>8</integer><long>1716595200000</long><boolean>true</boolean>
        <long>1717200000000</long><integer>42</integer><string>STRIPPED_SPRINT_ROW</string><boolean>true</boolean>
        <long>1717200000123</long><string xsi:nil="true"/></row>
      <row><string>STRIPPED_UNREFERENCED_SPRINT</string><integer>9</integer><long xsi:nil="true"/><boolean>false</boolean>
        <long xsi:nil="true"/><integer>42</integer><string>STRIPPED_SPRINT_ROW</string><boolean>false</boolean>
        <long xsi:nil="true"/><string xsi:nil="true"/></row>
    </data>
    <data tableName="AO_PLUGIN"><column name="TOKEN"/><row><string>STRIPPED_OTHER_PLUGIN</string></row></data>
  </backup>`);
  assert.deepEqual(issue(data, 1).metadata.jiraSprintIds, ['7', '8']);
  assert.equal(issue(data, 1).metadata.jiraCurrentSprintIds, undefined);
  assert.deepEqual(issue(data, 1).metadata.fields, { '10000': [{ stringvalue: '7' }, { stringvalue: '8' }] });
  assert.equal(issue(data, 2).metadata.jiraSprintIds, undefined);
  assert.deepEqual(sprint(data, '7')?.metadata, { id: '7', state: 'active', boardId: '42',
    startdate: '2024-06-01T00:00:00.000Z', enddate: '2024-06-08T00:00:00.000Z' });
  assert.equal(sprint(data, '7')?.text, 'Ship safely');
  assert.equal(sprint(data, '8')?.metadata.state, 'closed');
  assert.equal(sprint(data, '8')?.metadata.completeDate, '2024-06-01T00:00:00.123Z');
  assert.equal(sprint(data, '9'), undefined);
  assert.deepEqual(issue(data, 1).references.filter(ref => ref.relation === 'sprint').map(ref => ref.sourceId), ['builtin:sprints:7', 'builtin:sprints:8']);
  assert.equal(data.unsupported.some(row => row.type === 'activeobjects:AO_PLUGIN'), true);
  assert.equal(data.unsupported.some(row => row.type === 'activeobjects:AO_60DB71_SPRINT'), false);
  assert.doesNotMatch(JSON.stringify(data), /STRIPPED_/);
});

test('Jira Agile current Sprint, explicit null, and malformed history remain distinct', () => {
  const oldSprint = { id: 7, name: 'Previous', state: 'closed', self: 'https://jira.example.com/sprint/7?token=NEVER_COPY_THIS' };
  const currentSprint = { id: 8, name: 'Active', state: 'active', startDate: '2026-01-01', endDate: '2026-01-09' };
  const data = rest([
    issueFields(1, { sprint: currentSprint, closedSprints: [oldSprint, {}] }),
    issueFields(2, { sprint: null, closedSprints: [oldSprint] }),
    issueFields(3, { sprint: [currentSprint], closedSprints: [oldSprint] }),
    issueFields(4, { closedSprints: [currentSprint] }),
  ]);
  assert.deepEqual(issue(data, 1).metadata.jiraCurrentSprintIds, ['8']);
  assert.deepEqual(issue(data, 1).metadata.jiraSprintIds, ['8', '7']);
  assert.equal(issue(data, 1).metadata.jiraSprintUnresolved, true);
  assert.equal(issue(data, 1).metadata.jiraCurrentSprintUnresolved, undefined);
  assert.deepEqual(issue(data, 2).metadata.jiraCurrentSprintIds, []);
  assert.deepEqual(issue(data, 2).metadata.jiraSprintIds, ['7']);
  assert.equal(issue(data, 2).metadata.jiraSprintUnresolved, undefined);
  assert.deepEqual(issue(data, 3).metadata.jiraCurrentSprintIds, []);
  assert.equal(issue(data, 3).metadata.jiraCurrentSprintUnresolved, true);
  assert.deepEqual(issue(data, 4).metadata.jiraSprintIds, []);
  assert.equal(issue(data, 4).metadata.jiraSprintUnresolved, true);
  assert.deepEqual(sprint(data, '8')?.metadata, { id: '8', state: 'active', startdate: '2026-01-01', enddate: '2026-01-09' });
  assert.deepEqual((issue(data, 1).metadata.fields as { sprint?: object }).sprint, currentSprint);
  assert.doesNotMatch(JSON.stringify(data), /NEVER_COPY_THIS/);
});

test('Jira REST Sprint schema works without field names and preserves the legacy string and unresolved membership', () => {
  const legacy = 'com.atlassian.greenhopper.service.sprint.Sprint@abc123[id=25,rapidViewId=4,state=FUTURE,name=Next iteration, follow-up,goal=Release,startDate=2025-11-01T01:30:00.000+09:00,endDate=<null>,completeDate=<null>,sequence=25]';
  const data = rest([
    issueFields(1, { customfield_10000: [legacy, 'x-not-a-sprint'] }),
    issueFields(2, { customfield_10000: [25] }),
    issueFields(3, { customfield_10001: [legacy] }),
  ], { customfield_10000: { type: 'array', custom: fieldType }, customfield_10001: { type: 'array' } });
  assert.deepEqual((issue(data, 1).metadata.fields as Record<string, unknown>).customfield_10000, [legacy, 'x-not-a-sprint']);
  assert.deepEqual(issue(data, 1).metadata.jiraSprintIds, ['25']);
  assert.equal(issue(data, 1).metadata.jiraCurrentSprintUnresolved, true);
  assert.deepEqual(issue(data, 2).metadata.jiraSprintIds, ['25']);
  assert.equal(issue(data, 3).metadata.jiraSprintIds, undefined);
  assert.equal(sprint(data, '25')?.title, 'Next iteration, follow-up');
  assert.deepEqual(sprint(data, '25')?.metadata, { id: '25', state: 'future', boardId: '4', startdate: '2025-10-31T16:30:00.000Z' });
});

test('Jira Sprint conflicting definitions and the malformed AO table leave evidence without guessing', () => {
  const data = rest([
    issueFields(1, { sprint: { id: 8, name: 'One', state: 'active' } }),
    issueFields(2, { sprint: { id: 8, name: 'Two', state: 'future' } }),
    issueFields(3, { sprint: { id: 9, name: 'Invalid date', state: 'future', startDate: '2025-02-29' } }),
  ]);
  assert.equal(sprint(data, '8')?.metadata.jiraSprintAmbiguous, true);
  assert.equal(data.diagnostics.some(item => item.code === 'JIRA_SPRINT_DEFINITION_AMBIGUOUS'), true);
  assert.equal(sprint(data, '9')?.metadata.startdate, undefined);
  assert.equal(data.diagnostics.some(item => item.code === 'JIRA_SPRINT_DATE_UNRESOLVED' && item.recordId === sprint(data, '9')?.id), true);
  const ambiguous = admin(backup('<CustomFieldValue id="1" customfield="10000" issue="1" stringvalue="7"/>'),
    '<backup><data tableName="AO_60DB71_SPRINT"><column name="ID"/><column name="NAME"/><column name="NAME"/><row><integer>7</integer><string>A</string><string>B</string></row></data></backup>');
  assert.deepEqual(issue(ambiguous, 1).metadata.jiraSprintIds, ['7']);
  assert.equal(sprint(ambiguous, '7'), undefined);
  assert.equal(ambiguous.diagnostics.some(item => item.code === 'JIRA_SPRINT_TABLE_UNRESOLVED'), true);
  const csv = parseJira(new Map([['issues.csv', Buffer.from('Issue id,Issue key,Summary,Sprint,Custom field (Sprint)\n1,PROJ-1,Fixture,Prior sprint,Current sprint\n')]]), 'fixture-jira');
  assert.deepEqual(issue(csv, 1).metadata.jiraSprintIds, []);
  assert.equal(issue(csv, 1).metadata.jiraCurrentSprintUnresolved, true);
  assert.equal((issue(csv, 1).metadata.fields as Record<string, unknown>).Sprint, 'Prior sprint');
});
