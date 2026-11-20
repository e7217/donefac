import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJira } from '../../server/legacy-import-jira.js';
import type { LegacyDataset } from '../../shared/types.js';

const parse = (file: string, text: string) => parseJira(new Map([[file, Buffer.from(text)]]), 'jira-synthetic');
const row = (data: LegacyDataset, id: string) => {
  const entry = data.records.find(entry => entry.id === id);
  assert.ok(entry, `Missing ${id}`);
  return entry;
};

test('Jira administrator XML distinguishes proven fix-version associations from affected and malformed associations', () => {
  const data = parse('entities.xml', `<entity-engine-xml>
    <Project id="100" pkey="OLD" name="Project"/>
    <Issue id="11" project="100" number="1" summary="Fixed"/>
    <Issue id="12" project="100" number="2" summary="Affected"/>
    <Issue id="13" project="100" number="3" summary="Incomplete relationship"/>
    <Version id="200" project="100" vname="Release A" description="Release notes"
      startdate="2030-01-01 00:00:00.0" releasedate="2030-02-20 00:00:00.0" released="Y" archived="N"/>
    <ProjectVersion id="201" project="100" name="Release B"/>
    <ProjectVersion id="201" project="100" name="Conflicting name"/>
    <NodeAssociation sourceNodeId="11" sourceNodeEntity="Issue" sinkNodeId="200" sinkNodeEntity="Version" associationType="IssueFixVersion"/>
    <NodeAssociation sourceNodeId="11" sourceNodeEntity="Issue" sinkNodeId="201" sinkNodeEntity="ProjectVersion" associationType="IssueFixVersion"/>
    <NodeAssociation sourceNodeId="11" sourceNodeEntity="Issue" sinkNodeId="202" sinkNodeEntity="Version" associationType="IssueVersion"/>
    <NodeAssociation sourceNodeId="12" sourceNodeEntity="Issue" sinkNodeId="200" sinkNodeEntity="Version" associationType="IssueVersion"/>
    <NodeAssociation sourceNodeId="13" sourceNodeEntity="Issue" sinkNodeId="200" sinkNodeEntity="Version" associationType="IssueFixVersion"/>
    <NodeAssociation sourceNodeId="13" sourceNodeEntity="Project" sinkNodeId="203" sinkNodeEntity="Version" associationType="IssueFixVersion"/>
  </entity-engine-xml>`);
  const a = row(data, 'option:builtin:versions:200');
  assert.equal(a.title, 'Release A');
  assert.equal(a.text, 'Release notes');
  assert.deepEqual(a.metadata, {
    id: '200', project: '100', released: true, archived: false,
    startdate: '2030-01-01 00:00:00.0', releasedate: '2030-02-20 00:00:00.0',
  });
  assert.deepEqual(row(data, 'issue:11').metadata.jiraFixVersionIds, ['200', '201']);
  assert.equal(row(data, 'issue:12').metadata.jiraFixVersionIds, undefined);
  assert.deepEqual(row(data, 'issue:13').metadata.jiraFixVersionIds, ['200']);
  assert.equal(row(data, 'issue:13').metadata.jiraFixVersionUnresolved, true);
  assert.equal(row(data, 'option:builtin:versions:201').metadata.jiraVersionAmbiguous, true);
  assert.equal(row(data, 'relation:association:11:Version:202:IssueVersion').metadata.associationType, 'IssueVersion');
  assert.ok(data.diagnostics.some(item => item.code === 'JIRA_VERSION_DEFINITION_AMBIGUOUS' && item.recordId === 'option:builtin:versions:201'));
});

test('Jira REST fix versions preserve raw fields, deduplicate IDs, and record competing or missing proof', () => {
  const project = { id: '100', key: 'OLD', name: 'Project' };
  const release = { id: 200, name: 'First', archived: false, released: true, startDate: '2030-01-01', releaseDate: '2030-02-20' };
  const baseIssue = (id: string, fields: object) => ({ id, key: `OLD-${id}`, fields: { project, summary: 'Task', ...fields } });
  const data = parse('jira.json', JSON.stringify({ issues: [
    baseIssue('11', { fixVersions: [release, { id: '200', name: 'First', projectId: 100 }],
      versions: [{ id: '299', name: 'Affected' }], affectedVersions: [{ id: '298', name: 'Affected' }] }),
    baseIssue('12', { fixVersions: [{ id: '200', name: 'First' }, { name: 'No ID' }, { id: '201', name: 'Outside', projectId: '999' }] }),
    baseIssue('13', { fixVersions: [{ id: '200', name: 'Conflicting name' }] }),
    baseIssue('14', { fixVersions: [] }),
    baseIssue('15', { versions: [{ id: '299', name: 'Affected' }] }),
    baseIssue('16', { fixVersions: [{ id: '204' }] }),
    baseIssue('17', { fixVersions: [{ id: '205' }] }),
    baseIssue('18', { fixVersions: [{ id: '205', name: 'Enriched definition' }] }),
  ] }));
  const first = row(data, 'option:builtin:versions:200');
  assert.equal(first.title, 'First');
  assert.equal(first.metadata.project, '100');
  assert.equal(first.metadata.startdate, '2030-01-01');
  assert.equal(first.metadata.releasedate, '2030-02-20');
  assert.equal(first.metadata.jiraVersionAmbiguous, true);
  assert.deepEqual(row(data, 'issue:11').metadata.jiraFixVersionIds, ['200']);
  assert.deepEqual((row(data, 'issue:11').metadata.fields as Record<string, unknown>).fixVersions,
    [release, { id: '200', name: 'First', projectId: 100 }]);
  assert.deepEqual(row(data, 'issue:12').metadata.jiraFixVersionIds, ['200', '201']);
  assert.equal(row(data, 'issue:12').metadata.jiraFixVersionUnresolved, true);
  assert.equal(row(data, 'option:builtin:versions:201').metadata.project, '999');
  assert.deepEqual(row(data, 'issue:14').metadata.jiraFixVersionIds, []);
  assert.equal(row(data, 'issue:15').metadata.jiraFixVersionIds, undefined);
  assert.ok(!data.records.some(entry => /builtin:versions:(?:298|299)$/.test(entry.id)));
  assert.equal(row(data, 'option:builtin:versions:204').metadata.jiraVersionNameMissing, true);
  assert.equal(row(data, 'option:builtin:versions:205').title, 'Enriched definition');
  assert.equal(row(data, 'option:builtin:versions:205').metadata.jiraVersionNameMissing, undefined);
});

test('Jira search XML and CSV preserve labels and require an ID from an explicit fixation', () => {
  const xml = parse('search.xml', `<rss><channel><item>
    <key id="11">OLD-1</key><project id="100" key="OLD">Project</project>
    <fixVersion id="200">First</fixVersion><fixVersion>Older label only</fixVersion>
    <version id="300">Affected only</version>
    </item><item><key id="12">OLD-2</key><fixVersion id="201">Without project</fixVersion></item></channel></rss>`);
  assert.deepEqual(row(xml, 'issue:11').metadata.jiraFixVersionIds, ['200']);
  assert.equal(row(xml, 'issue:11').metadata.jiraFixVersionUnresolved, true);
  assert.equal(row(xml, 'option:builtin:versions:200').metadata.project, '100');
  assert.equal(row(xml, 'issue:12').metadata.jiraFixVersionIds, undefined);
  assert.equal(row(xml, 'issue:12').metadata.jiraFixVersionUnresolved, true);
  assert.ok(!xml.records.some(entry => entry.id === 'option:builtin:versions:300'));
  const csv = parse('search.csv', 'Issue key,Issue id,Summary,Fix Version/s,Fix Version/s,Affects Version/s\n' +
    'OLD-1,11,Fixed,First,Second,Affected\nOLD-2,12,Affected only,,,Affected\n');
  const item = row(csv, 'issue:11');
  assert.equal(item.metadata.jiraFixVersionIds, undefined);
  assert.equal(item.metadata.jiraFixVersionUnresolved, true);
  assert.deepEqual((item.metadata.fields as Record<string, unknown>)['Fix Version/s'], ['First', 'Second']);
  assert.deepEqual(row(csv, 'issue:12').metadata.jiraFixVersionIds, []);
  assert.equal(row(csv, 'issue:12').metadata.jiraFixVersionUnresolved, undefined);
});

test('Jira Importers JSON keeps project versions and flags label-only issue references', () => {
  const data = parse('importers.json', JSON.stringify({ projects: [{
    id: '100', key: 'OLD', versions: [{ id: '200', name: 'First', releaseDate: '2030-01-03' }],
    issues: [{ externalId: '11', key: 'OLD-1', fixedVersions: ['First'] },
      { externalId: '12', key: 'OLD-2', fixedVersions: [{ id: '200' }] }],
  }] }));
  assert.equal(row(data, 'option:builtin:versions:200').metadata.project, '100');
  assert.equal(row(data, 'issue:11').metadata.jiraFixVersionUnresolved, true);
  assert.deepEqual(row(data, 'issue:12').metadata.jiraFixVersionIds, ['200']);
  assert.equal(row(data, 'issue:12').metadata.jiraFixVersionUnresolved, undefined);
});
