import { createHash } from 'node:crypto';
import { isCalendarDate } from '../shared/calendar.js';
import type { Issue, JiraDeadlineRecoveryReview, LegacyRecord, LegacyValue, SourceImport, SourceRecordArchive } from '../shared/types.js';
import { isRestrictedJiraHistoryOwner } from './migration-jira-history.js';
import { sourceTimestamp } from './migration-source-time.js';
import { jiraFieldDigest } from './migration-planner.js';
import type { SourcePreservationService } from './source-preservation.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

const dueFields = new Set(['due', 'duedate']);
const emptyDeadlineHash = jiraFieldDigest('dueDate', null);
const relatedArchiveLimit = 200;
const relatedArchiveByteLimit = 4 * 1024 * 1024;

interface DeadlineSnapshot {
  id: string; instanceKey: string; sourceId: string; excluded: number | null; projectId: string | null;
  metadata: string; updatedAt: string | null; timezone: string; unbound: number;
}

function dueValues(value: unknown): LegacyValue[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, LegacyValue>).flatMap(([name, date]) =>
    dueFields.has(name.replace(/[\s_/-]/g, '').toLowerCase()) ? [date] : []);
}

function originalDeadline(record: LegacyRecord): string | null {
  const { metadata } = record;
  if (metadata.dialect !== 'rest-json' || dueValues(metadata.fields).length) return null;
  const values = [...dueValues(metadata.jiraScheduleFields), ...dueValues(metadata)];
  const [date] = values;
  return typeof date === 'string' && isCalendarDate(date) && values.every(value => value === date) ? date : null;
}

function agreesWithDeadline(record: LegacyRecord, original: string): boolean {
  const { metadata } = record;
  const values = [...dueValues(metadata.jiraScheduleFields), ...dueValues(metadata.fields), ...dueValues(metadata)];
  if (!values.length) return !Array.isArray(metadata.jiraSnapshotFields) || !metadata.jiraSnapshotFields.includes('dueDate');
  return values.every(value => value === original);
}

function deadlineSnapshots(store: Store, issue: Issue, origin: SourceRecordArchive, aliases: ReadonlySet<string>): Iterable<DeadlineSnapshot> {
  const aliasList = JSON.stringify([...aliases]);
  return store.db.prepare(`WITH issue_aliases(alias) AS (SELECT value FROM json_each(?)),
    matching(id) AS (
      SELECT id FROM source_records WHERE target_type='issue' AND target_id=? AND product='jira' AND kind='issue' AND id<>?
      UNION
      SELECT id FROM source_records
        WHERE product='jira' AND kind='issue' AND target_type IS NULL AND target_id IS NULL AND source_instance=?
        AND json_extract(json,'$.record.containerId')=? AND source_id IN (SELECT alias FROM issue_aliases)
      UNION
      SELECT id FROM source_records
        WHERE product='jira' AND kind='issue' AND target_type IS NULL AND target_id IS NULL AND source_instance=?
        AND json_extract(json,'$.record.containerId')=? AND json_extract(json,'$.record.metadata.key') IN (SELECT alias FROM issue_aliases)
    )
    SELECT record.id,record.source_instance AS instanceKey,record.source_id AS sourceId,
      json_extract(record.json,'$.excluded') AS excluded,json_extract(record.json,'$.targetProjectId') AS projectId,
      json_extract(record.json,'$.record.metadata') AS metadata,json_extract(record.json,'$.record.updatedAt') AS updatedAt,
      json_extract(receipt.json,'$.configuration.timezone') AS timezone,record.target_type IS NULL AS unbound
    FROM matching JOIN source_records record ON record.id=matching.id
    JOIN source_imports receipt ON receipt.id=record.import_id
    WHERE record.target_type='issue' OR json_extract(receipt.json,'$.configuration.appendTo.projectId')=?
    ORDER BY record.id LIMIT ?`)
    .iterate(aliasList, issue.id, origin.id, origin.source.instanceKey, origin.record.containerId,
      origin.source.instanceKey, origin.record.containerId, issue.projectId, relatedArchiveLimit + 1) as Iterable<DeadlineSnapshot>;
}

function reviewStatus(store: Store, issue: Issue): JiraDeadlineRecoveryReview['status'] {
  if (issue.dueDate != null) return 'current-value';
  // Each audited write has a unique (issue_id, issue_version). A gap can hide a local or automated clear.
  const history = store.db.prepare(`SELECT count(*) AS count,
      coalesce(max(EXISTS(SELECT 1 FROM json_each(change.json,'$.changes') field
        WHERE json_extract(field.value,'$.field')='dueDate')),0) AS changedDeadline,
      coalesce(min(change.project_id=? AND change.previous_project_id=? AND
        coalesce(json_extract(change.json,'$.origin') IN ('user','automation'),0) AND
        coalesce(json_array_length(change.json,'$.changes')>0,0)),1) AS sameProject
    FROM issue_change_history change WHERE change.issue_id=? AND change.issue_version>1 AND change.issue_version<=?`)
    .get(issue.projectId, issue.projectId, issue.id, issue.version) as { count: number; changedDeadline: number; sameProject: number };
  if (history.changedDeadline) return 'local-change';
  return history.count === issue.version - 1 && history.sameProject === 1 ? 'ready' : 'history-unverified';
}

export function readJiraDeadlineRecovery(store: Store, sources: SourcePreservationService, issue: Issue): JiraDeadlineRecoveryReview | null {
  const bindings = store.db.prepare(`SELECT source_instance AS instanceKey, source_alias AS alias, import_id AS importId
    FROM source_bindings WHERE target_type='issue' AND target_id=? AND product='jira' AND kind='issue' LIMIT ?`)
    .all(issue.id, relatedArchiveLimit + 1) as { instanceKey: string; alias: string; importId: string }[];
  const [binding] = bindings;
  if (!binding || bindings.length > relatedArchiveLimit ||
      !bindings.every(row => row.instanceKey === binding.instanceKey && row.importId === binding.importId)) return null;

  const origins = sources.jiraIssueOrigins(binding.instanceKey, [issue.id], 'issue');
  const [origin] = origins;
  if (!origin || origins.length !== bindings.length || !origins.every(row => row.archiveId === origin.archiveId &&
      row.projectId === issue.projectId && row.sourceProjectId === origin.sourceProjectId)) return null;

  const receipt = store.get<SourceImport>('source_imports', binding.importId);
  const archive = store.get<SourceRecordArchive>('source_records', origin.archiveId);
  if (!receipt || !archive || archive.sourceImportId !== binding.importId || archive.excluded ||
      archive.source.product !== 'jira' || archive.source.format !== 'jira-json' || archive.source.instanceKey !== binding.instanceKey ||
      archive.record.kind !== 'issue' || archive.targetType !== 'issue' || archive.targetId !== issue.id ||
      archive.ownerType !== 'issue' || archive.ownerId !== issue.id || archive.targetProjectId !== issue.projectId ||
      archive.record.containerId !== origin.sourceProjectId ||
      archive.record.metadata.restricted === true || isRestrictedJiraHistoryOwner(archive.record) ||
      archive.jiraIssueFieldHashes?.dueDate !== emptyDeadlineHash || !receipt.projectIds.includes(issue.projectId)) return null;

  const packages = receipt.packages.filter(pkg => pkg.sha256 === archive.packageSha256 && pkg.source.product === 'jira' &&
    pkg.source.format === 'jira-json' && pkg.source.instanceKey === binding.instanceKey);
  if (packages.length !== 1) return null;
  const sourceDueDate = originalDeadline(archive.record);
  if (!sourceDueDate) return null;

  const aliases = new Set(bindings.map(row => row.alias));
  const originalUpdate = sourceTimestamp(archive.record.updatedAt, receipt.configuration.timezone);
  const boundIssue = store.db.prepare(`SELECT target_id AS issueId FROM source_bindings
    WHERE product='jira' AND source_instance=? AND kind='issue' AND source_alias=? AND target_type='issue'`);
  const evidence = createHash('sha256');
  let bytes = 0;
  let count = 0;
  for (const snapshot of deadlineSnapshots(store, issue, archive, aliases)) {
    if (++count > relatedArchiveLimit) return null;
    if (snapshot.unbound) {
      const observedUpdate = sourceTimestamp(snapshot.updatedAt, snapshot.timezone);
      if (originalUpdate !== null && observedUpdate !== null && observedUpdate < originalUpdate) continue;
    }
    if (!snapshot.metadata || (bytes += Buffer.byteLength(snapshot.metadata)) > relatedArchiveByteLimit || snapshot.excluded ||
        snapshot.instanceKey !== binding.instanceKey || (!snapshot.unbound && snapshot.projectId !== issue.projectId)) return null;
    const metadata = JSON.parse(snapshot.metadata) as LegacyRecord['metadata'];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const key = typeof metadata.key === 'string' ? metadata.key : null;
    if (snapshot.unbound) {
      // A key match with a different unproven source ID could be an issue rename or a different issue.
      if (!aliases.has(snapshot.sourceId)) return null;
      if (key && !aliases.has(key)) {
        const bound = boundIssue.get(binding.instanceKey, key) as { issueId: string } | undefined;
        if (bound && bound.issueId !== issue.id) return null;
      }
    } else if (!aliases.has(snapshot.sourceId) && !(key && aliases.has(key))) return null;
    const record = { ...archive.record, sourceId: snapshot.sourceId, metadata };
    if (metadata.restricted === true || isRestrictedJiraHistoryOwner(record) || !agreesWithDeadline(record, sourceDueDate)) return null;
    evidence.update(JSON.stringify([snapshot.id, snapshot.instanceKey, snapshot.sourceId, snapshot.projectId,
      snapshot.metadata, snapshot.updatedAt, snapshot.timezone, snapshot.unbound]));
  }

  const currentDueDate = issue.dueDate ?? null;
  const status = reviewStatus(store, issue);
  const revision = createHash('sha256').update(JSON.stringify([workspaceRestoreGeneration(store), issue.id, issue.projectId,
    issue.version, issue.updatedAt, currentDueDate, receipt.id, receipt.version, archive.id, archive.packageSha256,
    sourceDueDate, [...aliases].sort(), evidence.digest('hex'), status])).digest('hex');
  const key = archive.record.metadata.key;
  return { sourceImportId: receipt.id, sourceRecordId: archive.id, sourceKey: typeof key === 'string' && key ? key : archive.record.sourceId,
    sourceDueDate, currentDueDate, issueVersion: issue.version, status, revision };
}
