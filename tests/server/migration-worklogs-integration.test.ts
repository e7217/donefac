import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  IssueWorklogPage,
  LegacyPackageSummary,
  MigrationApplyResult,
  MigrationConfiguration,
  MigrationOptions,
  MigrationPreview,
  ProjectWorklogReport,
  SourceImport,
  SourceReconciliationPage,
  SourceRecordArchive,
  SourceRecordPage,
  WorklogEntry,
  WorkspaceSnapshot,
} from '../../shared/types.js';

type ImportedEntry = WorklogEntry & { sourceRecordId?: string; durationSeconds?: number };
type WorklogPage = Omit<IssueWorklogPage, 'entries'> & { entries: ImportedEntry[] };
type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  worklogs: (ImportedEntry & { createHash: string; deletedAt: string | null })[];
  sourceImports: SourceImport[];
  sourceRecords: SourceRecordArchive[];
};

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-migration-worklogs-'));
  const service = createApp({ dataDir: dir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, actorId = 'user-min') {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as T };
  }
  async function upload(value: unknown) {
    const params = new URLSearchParams({
      filename: typeof value === 'string' ? 'entities.xml' : `worklogs-${randomUUID()}.json`,
      product: 'jira',
      instanceKey: `synthetic-worklogs-${randomUUID()}`,
    });
    const response = await fetch(`${base}/legacy-import/packages?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-min' },
      body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    });
    const data = (await response.json()) as LegacyPackageSummary;
    assert.equal(response.status, 201, JSON.stringify(data));
    return data;
  }
  async function configure(pkg: LegacyPackageSummary, authorId: string) {
    const response = await call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const config = structuredClone(response.data.defaultConfiguration);
    config.projects = config.projects.map((project) => ({
      ...project,
      key: `WL${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
      name: '합성 작업 시간 이관 프로젝트',
    }));
    config.timezone = 'UTC';
    config.datePolicy = 'import-time';
    const identity = response.data.identities.find((value) => value.sourceValue === authorId);
    assert.ok(identity, `Original author ${authorId} was not analyzed`);
    config.users[identity.id] = 'user-seo';
    return config;
  }
  async function preview(configuration: MigrationConfiguration) {
    const response = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  const apply = (plan: MigrationPreview, acknowledgements = plan.requiredAcknowledgements) =>
    call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
      expectedVersion: plan.version,
      acknowledgements,
    });
  async function originals(importId: string) {
    const response = await call<SourceRecordPage>(
      `/source-imports/${importId}/records?kind=history&offset=0&limit=50`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const records = await Promise.all(
      response.data.records.map(async (row) => {
        const detail = await call<SourceRecordArchive>(`/source-imports/${importId}/records/${row.id}`);
        assert.equal(detail.status, 200, JSON.stringify(detail.data));
        return detail.data;
      }),
    );
    return records;
  }
  async function list(issueId: string) {
    const response = await call<WorklogPage>(`/issues/${issueId}/worklogs?offset=0`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  async function importedIssue(importId: string) {
    const snapshot = await call<WorkspaceSnapshot>('/workspace');
    assert.equal(snapshot.status, 200);
    const receipt = (await call<SourceImport[]>('/source-imports')).data.find(
      (value) => value.id === importId,
    );
    assert.ok(receipt);
    const issue = snapshot.data.issues.find((value) => receipt.projectIds.includes(value.projectId));
    assert.ok(issue);
    return issue;
  }
  return {
    call,
    upload,
    configure,
    preview,
    apply,
    originals,
    list,
    importedIssue,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const mappedAuthor = { accountId: 'original.author', displayName: '원본 작업자' };
const unmappedAuthor = { accountId: 'original.unmapped', displayName: '매핑하지 않은 원본 작업자' };
const started = '2020-01-02T00:30:00+09:00';
const sourceCreated = '2020-01-02T00:31:00+09:00';
function restPayload() {
  const log = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    author: mappedAuthor,
    started,
    created: sourceCreated,
    updated: '2020-01-02T00:32:00+09:00',
    timeSpentSeconds: 91,
    comment: `원본 작업 기록 ${id}`,
    ...extra,
  });
  return {
    startAt: 0,
    total: 1,
    issues: [
      {
        id: '100',
        key: 'OLD-1',
        changelog: { startAt: 0, total: 0, histories: [] },
        fields: {
          project: { id: '20', key: 'OLD', name: '원본 REST 프로젝트' },
          summary: 'REST 작업 시간 이관 검증',
          description: '합성 원본 설명',
          creator: mappedAuthor,
          reporter: mappedAuthor,
          created: '2020-01-01T00:00:00Z',
          updated: '2020-01-03T00:00:00Z',
          status: { id: '1', name: 'Open' },
          issuetype: { id: '3', name: 'Task' },
          worklog: {
            startAt: 0,
            total: 4,
            worklogs: [
              log('exact-91'),
              log('restricted', {
                timeSpentSeconds: 120,
                visibility: { type: 'group', value: 'private-team' },
              }),
              log('unmapped', { author: unmappedAuthor, timeSpentSeconds: 60 }),
              log('relative-start', { started: 'P-3D', timeSpentSeconds: 60 }),
            ],
          },
        },
      },
    ],
  };
}

test('real REST staging blocks restricted worklogs, preserves archive-only reasons and imports exact mapped seconds with source-local date', async () => {
  const f = await fixture();
  try {
    const beganAt = Date.now(),
      pkg = await f.upload(restPayload());
    const config = await f.configure(pkg, mappedAuthor.accountId);
    const blocked = await f.preview(config);
    const restrictedKey = `${pkg.id}/history:worklog:restricted`;
    assert.equal(blocked.canApply, false, JSON.stringify(blocked.notices));
    assert.ok(
      blocked.notices.some(
        (notice) =>
          notice.code === 'RESTRICTED_CONTENT' &&
          notice.severity === 'error' &&
          notice.recordId === restrictedKey,
      ),
    );
    assert.equal((await f.apply(blocked)).status, 409);
    assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).data, []);

    config.excludedRecords = [restrictedKey];
    const plan = await f.preview(config);
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    assert.equal(plan.counts.worklogs, 1);
    assert.equal(plan.counts.archivedWorklogs, 3);
    for (const [code, originalId] of [
      ['WORKLOG_AUTHOR_UNMAPPED', 'unmapped'],
      ['WORKLOG_START_INVALID', 'relative-start'],
    ]) {
      const notice = plan.notices.find(
        (value) => value.code === code && value.recordId === `${pkg.id}/history:worklog:${originalId}`,
      );
      assert.ok(notice, `${code}: ${JSON.stringify(plan.notices)}`);
      assert.equal(notice.severity, 'warning');
      assert.equal(notice.requiresAcknowledgement, true);
      assert.ok(plan.requiredAcknowledgements.includes(code));
    }
    assert.equal((await f.apply(plan, [])).status, 400);
    const applied = await f.apply(plan);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    assert.equal(applied.data.import.actorId, 'user-min');
    assert.equal(applied.data.import.counts.worklogs, 1);
    assert.equal(applied.data.import.counts.archivedWorklogs, 3);
    assert.deepEqual(applied.data.import.notices, plan.notices);

    const issue = await f.importedIssue(plan.id),
      page = await f.list(issue.id);
    assert.equal(page.totalEntries, 1);
    assert.equal(page.totalMinutes, 91 / 60);
    const entry = page.entries[0];
    assert.equal(entry.authorId, 'user-seo');
    assert.equal(entry.durationSeconds, 91);
    assert.equal(entry.minutes, 91 / 60);
    assert.equal(entry.workDate, '2020-01-02');
    assert.equal(new Date(started).toISOString().slice(0, 10), '2020-01-01');
    assert.ok(Date.parse(entry.createdAt) >= beganAt, 'canonical audit time is migration time');
    assert.equal(entry.issueKey, issue.key);
    assert.equal(entry.issueTitle, issue.title);

    const report = await f.call<ProjectWorklogReport>(
      `/projects/${issue.projectId}/worklog-report?startDate=2020-01-01&endDate=2020-01-02&authorId=user-seo`,
    );
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(report.data.minutes, 91 / 60);
    assert.equal(report.data.entryCount, 1);
    assert.deepEqual(
      report.data.days.filter((day) => day.entries),
      [{ date: '2020-01-02', minutes: 91 / 60, entries: 1 }],
    );
    const otherAuthor = await f.call<ProjectWorklogReport>(
      `/projects/${issue.projectId}/worklog-report?startDate=2020-01-01&endDate=2020-01-02&authorId=user-min`,
    );
    assert.equal(otherAuthor.status, 200);
    assert.equal(otherAuthor.data.minutes, 0);

    const archives = await f.originals(plan.id);
    assert.equal(archives.length, 4, 'excluded and archive-only logs remain in the import receipt');
    const original = archives.find((value) => value.record.sourceId === 'worklog:exact-91');
    assert.ok(original);
    assert.equal(entry.sourceRecordId, original.id);
    assert.equal(original.ownerType, 'issue');
    assert.equal(original.ownerId, issue.id);
    assert.equal(original.record.authorId, mappedAuthor.accountId);
    assert.equal(original.record.metadata.started, started);
    assert.equal(Number(original.record.metadata.timeSpentSeconds), 91);
    assert.equal(original.record.createdAt, sourceCreated);
    assert.equal(original.record.text, '원본 작업 기록 exact-91');
    assert.equal(
      archives.find((value) => value.record.sourceId === 'worklog:relative-start')?.record.metadata
        .started,
      'P-3D',
    );
    const origins = await f.call<SourceRecordPage>(
      `/resource-origins?resourceType=issue&resourceId=${issue.id}&kind=history&offset=0&limit=50`,
    );
    assert.equal(origins.status, 200);
    assert.deepEqual(
      origins.data.records.map((value) => value.record.sourceId).sort(),
      ['worklog:exact-91', 'worklog:relative-start', 'worklog:unmapped'].sort(),
    );
    const reconciliationPath = `/source-imports/${plan.id}/reconciliation`;
    const reconciled = await f.call<SourceReconciliationPage>(`${reconciliationPath}?kind=history`);
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
    assert.deepEqual(Object.fromEntries(reconciled.data.rows.map(row => [row.sourceId, row.status])), {
      'worklog:exact-91': 'linked',
      'worklog:relative-start': 'archive-only',
      'worklog:restricted': 'excluded',
      'worklog:unmapped': 'archive-only',
    });
    const matchedWorklog = reconciled.data.rows.find(row => row.sourceRecordId === original.id);
    assert.equal(matchedWorklog?.target?.type, 'worklog');
    assert.equal(matchedWorklog.target.id, entry.id);
    assert.equal(matchedWorklog.target.owner?.id, issue.id);
    const issueBySourceKey = await f.call<SourceReconciliationPage>(`${reconciliationPath}?kind=issue&q=OLD-1`);
    assert.equal(issueBySourceKey.status, 200);
    assert.equal(issueBySourceKey.data.total, 1);
    assert.equal(issueBySourceKey.data.rows[0].sourceKey, 'OLD-1');
    assert.equal(issueBySourceKey.data.rows[0].target?.id, issue.id);

    const patch = {
      expectedVersion: entry.version,
      workDate: entry.workDate,
      note: '작성자가 메모만 수정',
    };
    const path = `/issues/${issue.id}/worklogs/${entry.id}`;
    assert.equal((await f.call(path, 'PATCH', patch, 'user-min')).status, 403);
    const edited = await f.call<ImportedEntry>(path, 'PATCH', patch, 'user-seo');
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.minutes, 91 / 60);
    assert.equal(edited.data.durationSeconds, 91);
    assert.equal(edited.data.sourceRecordId, original.id);
    assert.equal(edited.data.authorId, 'user-seo');
    assert.ok(edited.data.version > entry.version);
    assert.equal((await f.call(path, 'PATCH', patch, 'user-seo')).status, 409);
    const archiveAfterEdit = await f.call<SourceRecordArchive>(
      `/source-imports/${plan.id}/records/${original.id}`,
    );
    assert.deepEqual(archiveAfterEdit.data, original);
    const retried = await f.apply(plan);
    assert.equal(retried.status, 200);
    assert.equal(retried.data.duplicate, true);
    assert.equal((await f.list(issue.id)).totalEntries, 1);

    const backup = await f.call<Backup>('/export');
    assert.equal(backup.status, 200);
    assert.equal(backup.data.schemaVersion, 20);
    const raw = backup.data.worklogs.find((value) => value.id === entry.id);
    assert.ok(raw);
    assert.equal(raw.durationSeconds, 91);
    assert.equal(raw.minutes, 91 / 60);
    assert.equal(raw.sourceRecordId, original.id);
    assert.equal(raw.deletedAt, null);
    assert.match(raw.createHash, /^[a-f\d]{64}$/);
    const beforeInvalid = await f.list(issue.id);
    for (const change of [
      (data: Backup) => {
        data.worklogs.find((value) => value.id === entry.id)!.sourceRecordId = randomUUID();
      },
      (data: Backup) => {
        data.worklogs.find((value) => value.id === entry.id)!.durationSeconds = 90;
      },
    ]) {
      const invalid = structuredClone(backup.data);
      change(invalid);
      const rejected = await f.call('/import', 'POST', { data: invalid });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
      assert.deepEqual(await f.list(issue.id), beforeInvalid);
    }
    const restored = await f.call('/import', 'POST', { data: backup.data });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const restoredEntry = (await f.list(issue.id)).entries[0];
    assert.equal(restoredEntry.minutes, 91 / 60);
    assert.equal(restoredEntry.durationSeconds, 91);
    assert.equal(restoredEntry.sourceRecordId, original.id);
    assert.equal(restoredEntry.workDate, '2020-01-02');
    assert.equal(restoredEntry.note, edited.data.note);
    assert.ok(restoredEntry.version > edited.data.version);
    assert.equal(
      (await f.call(path, 'PATCH', { expectedVersion: edited.data.version, note: 'stale' }, 'user-seo'))
        .status,
      409,
    );

    const refreshed = await f.call<WorkspaceSnapshot>('/workspace');
    const refreshedIssue = refreshed.data.issues.find(item => item.id === issue.id)!;
    const trashed = await f.call<{ trashEntryId: string }>(`/issues/${issue.id}`, 'DELETE', { expectedVersion: refreshedIssue.version });
    assert.equal(trashed.status, 200);
    const withoutOwner = await f.call<SourceReconciliationPage>(`${reconciliationPath}?kind=history&status=linked`);
    assert.equal(withoutOwner.status, 200);
    assert.equal(withoutOwner.data.total, 1);
    assert.equal(withoutOwner.data.rows[0].target?.id, entry.id);
    assert.equal(withoutOwner.data.rows[0].target?.owner, null);
    assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}/restore`, 'POST')).status, 200);

    assert.equal((await f.call(path, 'DELETE', { expectedVersion: restoredEntry.version }, 'user-seo')).status, 200);
    const deletedWorklog = await f.call<SourceReconciliationPage>(`${reconciliationPath}?kind=history&status=missing`);
    assert.equal(deletedWorklog.status, 200);
    assert.deepEqual(deletedWorklog.data.rows.map(row => [row.sourceRecordId, row.target?.type, row.target?.id]), [[original.id, 'worklog', entry.id]]);
  } finally {
    await f.close();
  }
});

test('Importers long worklogs preserve more than one day of exact seconds while normal input limits still apply', async () => {
  const f = await fixture();
  try {
    const seconds = 90001,
      sourceStarted = '2020-02-04T23:40:00-0500';
    const pkg = await f.upload({
      users: [{ name: 'importer.author', fullname: '원본 Importers 작업자' }],
      projects: [
        {
          key: 'LONG',
          name: '장시간 원본 프로젝트',
          issues: [
            {
              externalId: 'long-issue',
              key: 'LONG-1',
              summary: '장시간 작업 기록 보존',
              created: '2020-02-01T00:00:00Z',
              updated: '2020-02-06T00:00:00Z',
              reporter: 'importer.author',
              issueType: 'Task',
              status: 'Open',
              worklogs: [
                {
                  id: 'long-90001',
                  author: 'importer.author',
                  started: sourceStarted,
                  created: '2020-02-05T04:40:00Z',
                  updated: '2020-02-06T00:00:00Z',
                  timeSpentSeconds: seconds,
                  comment: '25시간 1초의 원본 작업 기록',
                },
              ],
            },
          ],
        },
      ],
    });
    const config = await f.configure(pkg, 'importer.author'),
      plan = await f.preview(config);
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    assert.equal(plan.counts.worklogs, 1);
    assert.equal(plan.counts.archivedWorklogs, 0);
    const applied = await f.apply(plan);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const issue = await f.importedIssue(plan.id),
      list = await f.list(issue.id),
      entry = list.entries[0];
    assert.equal(list.totalEntries, 1);
    assert.equal(list.totalMinutes, seconds / 60);
    assert.equal(entry.durationSeconds, seconds);
    assert.equal(entry.minutes, seconds / 60);
    assert.ok(entry.minutes > 1440);
    assert.equal(entry.workDate, '2020-02-04');
    assert.equal(new Date(sourceStarted).toISOString().slice(0, 10), '2020-02-05');
    assert.equal(entry.authorId, 'user-seo');
    const report = await f.call<ProjectWorklogReport>(
      `/projects/${issue.projectId}/worklog-report?startDate=2020-02-04&endDate=2020-02-04`,
    );
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(report.data.minutes, seconds / 60);
    const patch = await f.call<ImportedEntry>(
      `/issues/${issue.id}/worklogs/${entry.id}`,
      'PATCH',
      { expectedVersion: entry.version, note: '메모만 고쳐도 초 단위 보존' },
      'user-seo',
    );
    assert.equal(patch.status, 200, JSON.stringify(patch.data));
    assert.equal(patch.data.durationSeconds, seconds);
    assert.equal(patch.data.minutes, seconds / 60);
    const invalidEdit = await f.call(
      `/issues/${issue.id}/worklogs/${entry.id}`,
      'PATCH',
      { expectedVersion: patch.data.version, minutes: 1441 },
      'user-seo',
    );
    assert.equal(invalidEdit.status, 400, JSON.stringify(invalidEdit.data));
    const manual = await f.call(
      `/issues/${issue.id}/worklogs`,
      'POST',
      {
        requestId: randomUUID(),
        workDate: entry.workDate,
        minutes: 1441,
        note: '수동 입력에는 한도 유지',
      },
      'user-seo',
    );
    assert.equal(manual.status, 400, JSON.stringify(manual.data));
    assert.equal((await f.list(issue.id)).totalEntries, 1);
    const backup = (await f.call<Backup>('/export')).data;
    assert.equal(backup.schemaVersion, 20);
    assert.equal(backup.worklogs.find((value) => value.id === entry.id)?.durationSeconds, seconds);
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
    const after = (await f.list(issue.id)).entries[0];
    assert.equal(after.durationSeconds, seconds);
    assert.equal(after.minutes, seconds / 60);
    assert.equal(after.sourceRecordId, entry.sourceRecordId);
  } finally {
    await f.close();
  }
});

test('administrator XML Worklog timeworked and role restrictions pass through real analysis, preview and application', async () => {
  const f = await fixture();
  try {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><entity-engine-xml>
      <ApplicationUser id="10" userKey="xml-author-key" lowerUserName="xmlalice"/>
      <User id="11" userName="xmlalice" displayName="원본 XML 작업자" active="1"/>
      <Project id="20" pkey="XML" name="XML 작업 기록 프로젝트"/>
      <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
      <Issue id="100" project="20" number="1" summary="관리자 XML 작업 기록 검증" creator="xmlalice" reporter="xmlalice" status="1" issuetype="3" created="2020-02-28T00:00:00Z" updated="2020-03-02T00:00:00Z"/>
      <Worklog id="31" issue="100" author="xmlalice" timeworked="59" startdate="2020-03-01 00:30:00" created="2020-03-01T00:35:00+09:00" updated="2020-03-01T00:36:00+09:00"><body><![CDATA[ XML 59초 작업 원문\r\n둘째 줄 ]]></body></Worklog>
      <Worklog id="32" issue="100" author="xmlalice" timeworked="61" startdate="2020-03-01 01:30:00" created="2020-03-01T01:35:00+09:00" rolelevel="123"><body><![CDATA[제한된 XML 작업 원문]]></body></Worklog>
    </entity-engine-xml>`;
    const pkg = await f.upload(xml);
    assert.equal(pkg.source.format, 'jira-backup-xml');
    const config = await f.configure(pkg, 'xml-author-key');
    config.timezone = 'Asia/Seoul';
    const blocked = await f.preview(config),
      excludedId = `${pkg.id}/history:worklog:32`;
    assert.equal(blocked.canApply, false, JSON.stringify(blocked.notices));
    assert.ok(
      blocked.notices.some(
        (value) => value.code === 'RESTRICTED_CONTENT' && value.recordId === excludedId,
      ),
    );
    config.excludedRecords = [excludedId];
    const plan = await f.preview(config);
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    assert.equal(plan.counts.worklogs, 1);
    assert.equal(plan.counts.archivedWorklogs, 1);
    const applied = await f.apply(plan);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const issue = await f.importedIssue(plan.id),
      page = await f.list(issue.id);
    assert.equal(page.totalEntries, 1);
    assert.equal(page.totalMinutes, 59 / 60);
    const entry = page.entries[0];
    assert.equal(entry.authorId, 'user-seo');
    assert.equal(entry.durationSeconds, 59);
    assert.equal(entry.workDate, '2020-03-01');
    assert.match(entry.note, /XML 59초 작업 원문/);
    assert.match(entry.note, /둘째 줄/);
    const originals = await f.originals(plan.id),
      raw = originals.find((value) => value.record.sourceId === 'worklog:31');
    assert.ok(raw);
    assert.equal(entry.sourceRecordId, raw.id);
    assert.equal(raw.record.authorId, 'xml-author-key');
    assert.equal(raw.record.metadata.startdate, '2020-03-01 00:30:00');
    assert.equal(Number(raw.record.metadata.timeworked), 59);
    assert.equal(raw.record.text, ' XML 59초 작업 원문\r\n둘째 줄 ');
    assert.equal(
      originals.find((value) => value.record.sourceId === 'worklog:32')?.record.metadata.rolelevel,
      '123',
    );
  } finally {
    await f.close();
  }
});
