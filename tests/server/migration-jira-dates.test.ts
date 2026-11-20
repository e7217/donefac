import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  Issue, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview,
  ProjectIssueSchema, ProjectScheduleAnalysis, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const issueTitle = '가상 Jira 일정 업무';
const sourceInstance = 'synthetic-jira-schedule-dates';
const datePicker = 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-jira-dates-'));
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
  async function upload(bytes: Buffer, filename: string): Promise<LegacyPackageSummary> {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: sourceInstance });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { ...actor, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body) as LegacyPackageSummary;
  }
  const options = (pkg: LegacyPackageSummary) => call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  const preview = (configuration: MigrationConfiguration) =>
    call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  const apply = (plan: MigrationPreview) => {
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    return call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    }, 201);
  };
  return { call, upload, options, preview, apply };
}

function administratorPackage(start = '2025-03-10', end = '2025-03-14'): Buffer {
  const customFields = [
    ['42101', 'Start date', start],
    ['42102', 'End date', end],
    ['42103', 'Baseline start date', '2025-01-06'],
    ['42104', 'Baseline end date', '2025-01-09'],
  ];
  const definitions = customFields.map(([id, name]) => `<CustomField id="${id}" name="${name}" customfieldtypekey="${datePicker}"/>`);
  const values = customFields.map(([id, , date], index) =>
    `<CustomFieldValue id="${51000 + index}" issue="100" customfield="${id}" datevalue="${date} 00:00:00.000"/>`);
  const bytes = Buffer.from(`<entity-engine-xml version="9.12">
    <Project id="42" pkey="ORIG" name="일정 원본"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    <Issue id="100" project="42" number="1" summary="${issueTitle}" status="1" issuetype="3"
      created="2025-03-01T00:00:00Z" updated="2025-03-02T00:00:00Z" duedate="2025-03-28 00:00:00.000"/>
    ${definitions.join('\n')}
    ${values.join('\n')}
  </entity-engine-xml>`);
  return zip([{ path: 'entities.xml', bytes }]);
}

function restPackage(updated: string, fields: Record<string, string | null>): Buffer {
  return Buffer.from(JSON.stringify({
    names: { customfield_42101: 'Start date', customfield_42102: 'End date' },
    schema: {
      customfield_42101: { type: 'date', custom: datePicker, customId: 42101 },
      customfield_42102: { type: 'date', custom: datePicker, customId: 42102 },
    },
    issues: [{ id: '100', key: 'ORIG-1', fields: {
      project: { id: '42', key: 'ORIG', name: '일정 원본' },
      summary: issueTitle, created: '2025-03-01T00:00:00Z', updated,
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, ...fields,
    }, changelog: { total: 0, histories: [] } }],
  }));
}

test('typed Jira schedule dates enter native planning and survive partial REST refresh, team edits and restore', async t => {
  const f = await fixture(t);
  const original = await f.upload(administratorPackage(), 'jira-admin-dates.zip');
  const { defaultConfiguration } = await f.options(original);
  const configuration = {
    ...defaultConfiguration, timezone: 'Asia/Seoul',
    projects: defaultConfiguration.projects.map(project => ({ ...project, key: 'JMIG' })),
  };
  const initial = await f.apply(await f.preview(configuration));
  const [projectId] = initial.import.projectIds;
  async function issue() {
    const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
    const ticket = snapshot.issues.find(value => value.projectId === projectId && value.key === 'JMIG-1');
    assert.ok(ticket);
    return ticket;
  }
  const initialIssue = await issue();
  assert.equal(initialIssue.startDate, '2025-03-10');
  assert.equal(initialIssue.endDate, '2025-03-14');
  assert.equal(initialIssue.dueDate, '2025-03-28');
  const schema = await f.call<ProjectIssueSchema>(`/projects/${projectId}/issue-schema`);
  assert.deepEqual(schema.fields.map(field => field.name).sort(), ['Baseline end date', 'Baseline start date']);
  assert.deepEqual(Object.fromEntries(schema.fields.map(field => [field.name, initialIssue.customFields?.[field.id]])), {
    'Baseline end date': '2025-01-09', 'Baseline start date': '2025-01-06',
  });
  const schedule = await f.call<ProjectScheduleAnalysis>(`/projects/${projectId}/schedule-analysis`);
  assert.equal(schedule.projectedFinish, '2025-03-14');
  assert.ok(schedule.tasks.some(task => task.issueId === initialIssue.id));
  assert.deepEqual(await f.call(`/baselines?projectId=${projectId}`), []);
  const backup = await f.call<WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] }>('/export');
  const source = backup.sourceRecords.find(row => row.targetId === initialIssue.id && row.record.kind === 'issue');
  assert.ok(source?.jiraIssueFieldHashes?.startDate && source.jiraIssueFieldHashes.endDate);
  const originalFields = source.record.metadata.fields as Record<string, unknown>;
  assert.deepEqual(originalFields['42103'], [{ datevalue: '2025-01-06 00:00:00.000' }]);
  assert.deepEqual(originalFields['42104'], [{ datevalue: '2025-01-09 00:00:00.000' }]);
  await f.call('/import', 'POST', { data: backup });

  async function review(name: string, updated: string, fields: Record<string, string | null>) {
    const pkg = await f.upload(restPackage(updated, fields), `${name}.json`);
    const options = await f.options(pkg);
    assert.equal(options.appendTarget?.projectId, projectId);
    const target = options.appendTarget!;
    return f.preview({
      ...options.defaultConfiguration, timezone: configuration.timezone,
      appendTo: {
        projectId, refreshExisting: true,
        statuses: Object.fromEntries(options.statuses.map(option => [option.id, target.statuses.find(value => value.label === option.label)!.id])),
        issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(value => value.name === option.label)!.id])),
        fields: Object.fromEntries(options.fields.map(option => [option.id, null])),
      },
    });
  }
  function decisions(plan: MigrationPreview) {
    const row = plan.issueRefresh?.find(row => row.issueId === initialIssue.id);
    assert.ok(row, JSON.stringify(plan.notices));
    return Object.fromEntries(row.fields.map(value => [value.field, value.decision]));
  }
  const partial = await review('end-only', '2025-03-03T00:00:00Z', { customfield_42102: '2025-03-19' });
  assert.deepEqual(decisions(partial), { endDate: 'apply' });
  await f.apply(partial);
  const updated = await issue();
  assert.equal(updated.id, initialIssue.id);
  assert.equal(updated.startDate, '2025-03-10');
  assert.equal(updated.endDate, '2025-03-19');
  const local = await f.call<Issue>(`/issues/${updated.id}`, 'PATCH', {
    expectedVersion: updated.version, endDate: '2025-03-20',
  });

  const conflict = await review('reported-empty-start', '2025-03-04T00:00:00Z', {
    customfield_42101: null, customfield_42102: '2025-03-18',
  });
  assert.deepEqual(decisions(conflict), { startDate: 'apply', endDate: 'conflict' });
  await f.apply(conflict);
  const cleared = await issue();
  assert.equal(cleared.version, local.version + 1);
  assert.equal(cleared.startDate, null);
  assert.equal(cleared.endDate, '2025-03-20');
  assert.equal(cleared.dueDate, '2025-03-28');

  const explicit = await review('explicit-standard-start', '2025-03-05T00:00:00Z', {
    startDate: '2025-03-11', customfield_42101: '2025-03-12',
  });
  assert.deepEqual(decisions(explicit), { startDate: 'apply' });
  await f.apply(explicit);
  const final = await issue();
  assert.equal(final.startDate, '2025-03-11');
  assert.equal(final.endDate, '2025-03-20');
});

test('invalid and reversed Jira schedule dates block import even with import-time fallback', async t => {
  const f = await fixture(t);
  const candidates = [
    {
      file: 'invalid-jira-date.json',
      bytes: restPackage('2027-03-01T00:00:00Z', { customfield_42101: '2027-02-30', customfield_42102: '2027-03-04' }),
      error: 'JIRA_SCHEDULE_DATE_INVALID',
    },
    {
      file: 'reversed-jira-dates.zip',
      bytes: administratorPackage('2025-03-14', '2025-03-10'),
      error: 'ISSUE_DATE_RANGE',
    },
  ];
  for (const { file, bytes, error } of candidates) {
    const pkg = await f.upload(bytes, file);
    const { defaultConfiguration } = await f.options(pkg);
    const plan = await f.preview({ ...defaultConfiguration, datePolicy: 'import-time', timezone: 'Asia/Seoul' });
    assert.equal(plan.canApply, false, JSON.stringify(plan.notices));
    assert.ok(plan.notices.some(notice => notice.severity === 'error' && notice.code === error), JSON.stringify(plan.notices));
    await f.call(`/migrations/previews/${plan.id}/apply`, 'POST', {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    }, 409);
  }
  const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(snapshot.issues.some(value => value.title === issueTitle), false);
});
