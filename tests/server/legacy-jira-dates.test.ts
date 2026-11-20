import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegacyDataset } from '../../shared/types.js';
import { parseJira } from '../../server/legacy-import-jira.js';

const picker = 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker';
const parse = (entries: Record<string, string>) =>
  parseJira(new Map(Object.entries(entries).map(([name, value]) => [name, Buffer.from(value)])), 'sample-jira');
const metadata = (dataset: LegacyDataset, id: string) => dataset.records.find(row => row.id === `issue:${id}`)!.metadata;

test('Jira administrator XML projects typed single datevalue fields and keeps original metadata', () => {
  const data = parse({ 'entities.xml': `<entity-engine-xml version="9.12">
    <Project id="10" pkey="OLD" name="Test"/>
    <CustomField id="101" cfname=" Start date " customfieldtypekey="${picker}"/>
    <CustomField id="102" name="END DATE" customfieldtypekey="${picker}"/>
    <CustomField id="103" name="Baseline start date" customfieldtypekey="${picker}"/>
    <Issue id="1" project="10" number="1" summary="valid"/>
    <Issue id="2" project="10" number="2" summary="sparse"/>
    <Issue id="3" project="10" number="3" summary="multiple"/>
    <Issue id="4" project="10" number="4" summary="conflicting representation"/>
    <CustomFieldValue id="11" issue="1" customfield="101" datevalue="2030-01-02 00:00:00.0"/>
    <CustomFieldValue id="12" issue="1" customfield="102"><datevalue>2030-01-09</datevalue></CustomFieldValue>
    <CustomFieldValue id="13" issue="1" customfield="103" datevalue="2030-02-09"/>
    <CustomFieldValue id="21" issue="2" customfield="102" datevalue=""/>
    <CustomFieldValue id="31" issue="3" customfield="101" datevalue="2030-01-02"/>
    <CustomFieldValue id="32" issue="3" customfield="101" datevalue="2030-01-04"/>
    <CustomFieldValue id="41" issue="4" customfield="102" datevalue="2030-01-02" stringvalue="2030-01-04"/>
  </entity-engine-xml>` });

  const valid = metadata(data, '1');
  assert.deepEqual(valid.jiraProjectedDates, { startDate: '2030-01-02 00:00:00.0', endDate: '2030-01-09' });
  assert.deepEqual(valid.jiraProjectedDateSources, { startDate: '101', endDate: '102' });
  assert.deepEqual(valid.fields, {
    101: [{ datevalue: '2030-01-02 00:00:00.0' }], 102: [{ datevalue: '2030-01-09' }], 103: [{ datevalue: '2030-02-09' }],
  });
  assert.equal(metadata(data, '2').jiraProjectedDates, undefined);
  assert.equal(metadata(data, '3').jiraProjectedDates, undefined);
  assert.equal(metadata(data, '4').jiraProjectedDates, undefined);
  assert.deepEqual(data.diagnostics.filter(item => item.code === 'JIRA_PROJECTED_DATE_VALUE_AMBIGUOUS')
    .map(item => item.recordId), ['issue:3', 'issue:4']);
});

test('Jira REST projects only proven date pickers and preserves separate standard values', () => {
  const data = parse({ 'issues.json': JSON.stringify({
    names: { customfield_101: 'Start date', customfield_102: 'End date', customfield_103: 'Baseline start date' },
    schema: { customfield_101: { type: 'date' }, customfield_102: { type: 'date', custom: picker }, customfield_103: { type: 'date' } },
    issues: [
      { id: '1', key: 'OLD-1', fields: {
        summary: 'valid', startDate: '2030-01-03', customfield_101: '2030-01-02', customfield_102: null, customfield_103: '2030-01-01',
      } },
      { id: '2', key: 'OLD-2', fields: { summary: 'sparse', customfield_103: '2030-01-08' } },
      { id: '3', key: 'OLD-3', fields: { summary: 'invalid shapes', customfield_101: ['2030-01-04'], customfield_102: {} } },
      { id: '4', key: 'OLD-4', fields: { summary: 'blank string', customfield_101: '' } },
    ],
  }), 'single.json': JSON.stringify({
    id: '5', key: 'OLD-5', names: { customfield_101: 'Start date' }, schema: { customfield_101: { type: 'date' } },
    fields: { summary: 'single issue', customfield_101: '2030-02-02' },
  }) });

  const valid = metadata(data, '1');
  assert.deepEqual(valid.jiraProjectedDates, { startDate: '2030-01-02', endDate: null });
  assert.deepEqual(valid.jiraProjectedDateSources, { startDate: 'customfield_101', endDate: 'customfield_102' });
  assert.deepEqual(valid.jiraScheduleFields, { startDate: '2030-01-03' });
  assert.deepEqual(valid.fields, { customfield_101: '2030-01-02', customfield_102: null, customfield_103: '2030-01-01' });
  for (const id of ['2', '3', '4']) assert.equal(metadata(data, id).jiraProjectedDates, undefined);
  assert.deepEqual(metadata(data, '5').jiraProjectedDates, { startDate: '2030-02-02' });
  assert.equal(data.diagnostics.filter(item => item.code === 'JIRA_PROJECTED_DATE_VALUE_AMBIGUOUS').length, 2);
});

test('Jira REST recognizes duplicate labels across export pages and rejects datetime and missing schema proof', () => {
  const data = parse({ 'first.json': JSON.stringify({
    names: { customfield_101: 'Start date', customfield_102: 'End date' },
    schema: { customfield_101: { type: 'date' }, customfield_102: { type: 'datetime' } },
    issues: [{ id: '1', key: 'OLD-1', fields: { summary: 'first', customfield_101: '2030-01-02', customfield_102: '2030-01-08' } }],
  }), 'second.json': JSON.stringify({
    names: { customfield_201: ' Start DATE ', customfield_102: 'End date' },
    issues: [{ id: '2', key: 'OLD-2', fields: { summary: 'second', customfield_201: '2030-01-03', customfield_102: '2030-01-09' } }],
  }) });

  assert.equal(metadata(data, '1').jiraProjectedDates, undefined);
  assert.equal(metadata(data, '2').jiraProjectedDates, undefined);
  assert.equal(data.diagnostics.filter(item => item.code === 'JIRA_PROJECTED_DATE_FIELD_AMBIGUOUS').length, 1);
});

test('Jira CSV projects exact custom date headers and only clears dates on complete rows', () => {
  const data = parse({ 'search.csv': [
    'Issue key,Issue id,Summary,Start date,Custom field (Start date),Custom field (End date),Custom field (Baseline start date)',
    'OLD-1,1,valid,2030-01-03,2/Jan/30,2030-01-08,2030-01-01',
    'OLD-2,2,explicit blanks,2030-01-03,,,2030-01-01',
    'OLD-3,3,missing cells,2030-01-03,2030-01-03',
  ].join('\n') });

  const valid = metadata(data, '1');
  assert.deepEqual(valid.jiraProjectedDates, { startDate: '2/Jan/30', endDate: '2030-01-08' });
  assert.deepEqual(valid.jiraProjectedDateSources, { startDate: 'csv:Custom field (Start date)', endDate: 'csv:Custom field (End date)' });
  assert.ok((valid.fields as Record<string, unknown>)['Custom field (Baseline start date)']);
  assert.deepEqual(metadata(data, '2').jiraProjectedDates, { startDate: null, endDate: null });
  assert.equal(metadata(data, '3').jiraProjectedDates, undefined);

  const duplicate = parse({ 'search.csv': [
    'Issue key,Issue id,Summary,Custom field (Start date),Custom field (Start date),Custom field (End date)',
    'OLD-1,1,duplicate,2030-01-02,,2030-01-08',
  ].join('\n') });
  assert.deepEqual(metadata(duplicate, '1').jiraProjectedDates, { endDate: '2030-01-08' });
  assert.ok(duplicate.diagnostics.some(item => item.code === 'JIRA_PROJECTED_DATE_FIELD_AMBIGUOUS'));
});

test('Jira RSS projects a single typed date picker element and preserves XML blanks as missing', () => {
  const data = parse({ 'search.xml': `<rss version="0.92"><channel>
    <item><key id="1">OLD-1</key><summary>valid</summary><customfields>
      <customfield id="customfield_101" key="${picker}"><customfieldname>Start date</customfieldname>
        <customfieldvalues><customfieldvalue>Tue, 02 Jan 2030 00:00:00 +0900</customfieldvalue></customfieldvalues>
      </customfield>
      <customfield id="customfield_102" key="${picker}"><customfieldname>End date</customfieldname>
        <customfieldvalues></customfieldvalues>
      </customfield>
    </customfields></item>
    <item><key id="2">OLD-2</key><summary>ambiguous</summary><customfields>
      <customfield id="customfield_101" key="${picker}"><customfieldname>Start date</customfieldname>
        <customfieldvalues><customfieldvalue>2030-01-02</customfieldvalue><customfieldvalue>2030-01-04</customfieldvalue></customfieldvalues>
      </customfield>
      <customfield id="customfield_102" key="${picker}"><customfieldname>End date</customfieldname>
        <customfieldvalues><customfieldvalue><span>2030-01-08</span></customfieldvalue></customfieldvalues>
      </customfield>
    </customfields></item>
  </channel></rss>` });

  const valid = metadata(data, '1');
  assert.deepEqual(valid.jiraProjectedDates, { startDate: 'Tue, 02 Jan 2030 00:00:00 +0900' });
  assert.deepEqual(valid.jiraProjectedDateSources, { startDate: 'customfield_101' });
  assert.deepEqual(valid.fields, { customfield_101: ['Tue, 02 Jan 2030 00:00:00 +0900'], customfield_102: [] });
  assert.equal(metadata(data, '2').jiraProjectedDates, undefined);
  assert.equal(data.diagnostics.filter(item => item.code === 'JIRA_PROJECTED_DATE_VALUE_AMBIGUOUS').length, 2);
});
