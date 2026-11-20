import { createHash } from 'node:crypto';
import type { Issue, JiraIssueStatusHistoryEntry, JiraIssueStatusHistoryPage, SourceImport, SourceReconciliationJiraStatusHistory,
  SourceRecordArchive } from '../shared/types.js';
import { countJiraStatusTransitions, isRestrictedJiraHistoryOwner, isRestrictedJiraStatusHistory, jiraStatusHistoryOwnerAliases,
  jiraStatusTransitions } from './migration-jira-history.js';
import { jiraEnglishDate, sourceTimestamp } from './migration-source-time.js';
import type { Store } from './store.js';

interface ArchiveRow { json: string }
interface HistoryCandidate extends ArchiveRow {
  archiveId: string;
  importId: string;
  ownerType: string | null;
  ownerId: string | null;
  sourceInstance: string;
  ordinal: number;
}
interface SourceProof {
  timezone: string;
  stagingId: string;
  centuryReview: Set<string>;
  excluded: Set<string>;
}
interface ReceiptContext {
  receipt: SourceImport;
  centuryReview: Set<string>;
  excluded: Set<string>;
}
interface TimelineEvent {
  entry: JiraIssueStatusHistoryEntry;
  authorId: string | null;
  sourceInstance: string;
  packageSha256: string;
  ordinal: number;
  position: number;
}
type HistoryIssue = Pick<Issue, 'id' | 'projectId'>;

const originalGroupId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function originalText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function readArchive(json: string): SourceRecordArchive | null {
  // The receipt audit reports malformed rows separately. A partial row cannot prove an owner or an identity.
  const archive = JSON.parse(json) as SourceRecordArchive | null;
  const { record, source } = archive ?? {};
  return archive && typeof archive.id === 'string' && typeof archive.sourceImportId === 'string' &&
    typeof archive.packageSha256 === 'string' && typeof source?.instanceKey === 'string' && source.product === 'jira' &&
    typeof record?.id === 'string' && typeof record.sourceId === 'string' && record.metadata && typeof record.metadata === 'object' &&
    Array.isArray(record.references) && record.references.every(reference => reference && typeof reference === 'object') ? archive : null;
}

function historicalDate(archive: SourceRecordArchive, proof: SourceProof) {
  const raw = originalText(archive.record.createdAt, 100);
  // A day without a time, or an unreviewed two-digit year, is not an event timestamp.
  const hasTime = raw && /[T ]\d{1,2}:\d{2}/.test(raw);
  const centuryReviewed = raw && (!jiraEnglishDate(raw)?.century || proof.centuryReview.has(`${proof.stagingId}/${archive.record.id}`));
  const changedAt = hasTime && centuryReviewed ? sourceTimestamp(raw, proof.timezone) : null;
  return { changedAt, originalChangedAt: changedAt ? null : raw };
}

function timelineOrder(a: TimelineEvent, b: TimelineEvent): number {
  return (b.entry.changedAt ?? '').localeCompare(a.entry.changedAt ?? '') || a.ordinal - b.ordinal || a.position - b.position;
}

function receiptContext(receipt: SourceImport): ReceiptContext {
  const notices = Array.isArray(receipt.notices) ? receipt.notices : [];
  const excluded = Array.isArray(receipt.configuration?.excludedRecords) ? receipt.configuration.excludedRecords : [];
  return { receipt, excluded: new Set(excluded), centuryReview: new Set(notices.flatMap(notice =>
    notice?.code === 'DATE_TWO_DIGIT_CENTURY' && notice.recordId ? [notice.recordId] : [])) };
}

function receiptPackage(archive: SourceRecordArchive, receipt: SourceImport) {
  return Array.isArray(receipt.packages) ? receipt.packages.find(item => item?.sha256 === archive.packageSha256 &&
    item.source?.product === 'jira' && item.source.instanceKey === archive.source.instanceKey &&
    item.source.format === archive.source.format) : undefined;
}

function prepareTimeline(store: Store, auditedReceipt?: SourceImport) {
  const issueBindings = store.db.prepare(`SELECT source_instance AS instance,source_alias AS alias FROM source_bindings
    WHERE product='jira' AND kind='issue' AND target_type='issue' AND target_id=?`);

  // Removing the alias column's text affinity lets SQLite seek on the JSON owner expression as well as the instance.
  const candidateFields = `history.id AS archiveId,history.import_id AS importId,history.owner_type AS ownerType,
    history.owner_id AS ownerId,history.source_instance AS sourceInstance,history.json,history.rowid AS ordinal`;
  const candidates = store.db.prepare(`SELECT ${candidateFields} FROM source_records AS history
    WHERE history.owner_type='issue' AND history.owner_id=? AND history.product='jira' AND history.kind='history'
      AND CASE WHEN json_valid(history.json) THEN json_type(history.json,'$.record.metadata.items')='array' ELSE 0 END
    UNION ALL
    SELECT ${candidateFields}
    FROM source_bindings AS binding CROSS JOIN source_records AS history INDEXED BY source_records_jira_unowned_change_owner
      ON history.source_instance=binding.source_instance AND json_extract(history.json,'$.record.containerId')=+binding.source_alias
    JOIN source_imports AS receipt ON receipt.id=history.import_id
    WHERE binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue' AND binding.target_id=?
      AND history.product='jira' AND history.kind='history' AND history.owner_type IS NULL AND history.owner_id IS NULL
      AND json_type(history.json,'$.record.metadata.items')='array'
      AND CASE WHEN json_valid(receipt.json) THEN json_extract(receipt.json,'$.configuration.appendTo.projectId')=? ELSE 0 END
    ORDER BY ordinal`);
  const sourceIssues = store.db.prepare(`SELECT snapshot.json
    FROM source_bindings AS binding CROSS JOIN source_records AS snapshot
      ON snapshot.source_instance=binding.source_instance AND snapshot.source_id=binding.source_alias
    LEFT JOIN source_bindings AS project ON project.product='jira' AND project.kind='project' AND project.target_type='project'
      AND project.source_instance=snapshot.source_instance
      AND project.source_alias=CASE WHEN json_valid(snapshot.json) THEN json_extract(snapshot.json,'$.record.containerId') END
    WHERE binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue' AND binding.target_id=?
      AND snapshot.import_id=? AND snapshot.product='jira' AND snapshot.source_instance=? AND snapshot.kind='issue'
      AND CASE WHEN json_valid(snapshot.json) THEN json_extract(snapshot.json,'$.packageSha256')=? ELSE 0 END
      AND ((snapshot.target_type='issue' AND snapshot.target_id=? AND snapshot.owner_type='issue' AND snapshot.owner_id=?)
        OR (? AND snapshot.target_type IS NULL AND snapshot.target_id IS NULL AND snapshot.owner_type IS NULL
          AND snapshot.owner_id IS NULL AND project.target_id=?))`);
  const sourceAuthor = store.db.prepare(`SELECT json FROM source_records
    WHERE import_id=? AND product='jira' AND source_instance=? AND kind='identity' AND source_id=?
      AND CASE WHEN json_valid(json) THEN json_extract(json,'$.packageSha256')=? AND json_extract(json,'$.excluded') IS NULL ELSE 0 END
    ORDER BY rowid LIMIT 1`);
  const sourceReceipt = store.db.prepare('SELECT json FROM source_imports WHERE id=? AND json_valid(json)');
  const receipts = new Map<string, ReceiptContext | null>();
  if (auditedReceipt) receipts.set(auditedReceipt.id, receiptContext(auditedReceipt));
  const authors = new Map<string, string | null>();

  function withAuthor({ authorId, sourceInstance, packageSha256, entry }: TimelineEvent): JiraIssueStatusHistoryEntry {
    if (!authorId) return entry;
    const authorKey = JSON.stringify([entry.sourceImportId, sourceInstance, packageSha256, authorId]);
    if (!authors.has(authorKey)) {
      const row = sourceAuthor.get(entry.sourceImportId, sourceInstance, authorId, packageSha256) as ArchiveRow | undefined;
      const archive = row && readArchive(row.json);
      const identity = archive?.record.kind === 'identity' && archive.record.sourceId === authorId &&
        archive.sourceImportId === entry.sourceImportId && archive.source.instanceKey === sourceInstance &&
        archive.packageSha256 === packageSha256 ? archive.record : null;
      authors.set(authorKey, identity ? originalText(identity.title || identity.sourceId, 500) : null);
    }
    return { ...entry, originalAuthorName: authors.get(authorKey) ?? null };
  }

  function project(issue: HistoryIssue, add: (event: TimelineEvent) => void, duplicate?: (archive: SourceRecordArchive) => void) {
    const bindingRows = issueBindings.all(issue.id) as { instance: string; alias: string }[];
    const aliases = new Map<string, Set<string>>();
    for (const { instance, alias } of bindingRows) {
      const instanceAliases = aliases.get(instance) ?? new Set<string>();
      instanceAliases.add(alias);
      aliases.set(instance, instanceAliases);
    }
    if (!aliases.size) return;

    const proven = new Map<string, SourceProof | null>();
    const seen = new Set<string>();
    for (const candidate of candidates.iterate(issue.id, issue.id, issue.projectId) as unknown as Iterable<HistoryCandidate>) {
      const archive = readArchive(candidate.json);
      if (!archive || archive.id !== candidate.archiveId || archive.sourceImportId !== candidate.importId ||
          archive.ownerType !== candidate.ownerType || archive.ownerId !== candidate.ownerId ||
          archive.source.instanceKey !== candidate.sourceInstance || archive.excluded || archive.targetType || archive.targetId) continue;
      const { record, source, sourceImportId, packageSha256 } = archive;
      const fallback = archive.ownerId === null;
      const ownerAliases = jiraStatusHistoryOwnerAliases(record);
      const instanceAliases = aliases.get(source.instanceKey);
      if (!instanceAliases || !ownerAliases?.every(alias => instanceAliases.has(alias))) continue;
      const transitions = jiraStatusTransitions(record);
      if (!transitions.length) continue;

      const proofKey = JSON.stringify([sourceImportId, source.instanceKey, source.format, packageSha256, fallback]);
      if (!proven.has(proofKey)) {
        if (!receipts.has(sourceImportId)) {
          const row = sourceReceipt.get(sourceImportId) as ArchiveRow | undefined;
          const receipt = row ? JSON.parse(row.json) as SourceImport | null : null;
          receipts.set(sourceImportId, receipt ? receiptContext(receipt) : null);
        }
        const context = receipts.get(sourceImportId);
        const timezone = context?.receipt.configuration?.timezone;
        const sourcePackage = context && receiptPackage(archive, context.receipt);
        let proof: SourceProof | null = null;
        if (context && sourcePackage && typeof timezone === 'string') {
          const snapshots = sourceIssues.all(issue.id, sourceImportId, source.instanceKey, packageSha256,
            issue.id, issue.id, Number(fallback), issue.projectId) as unknown as ArchiveRow[];
          // A standalone archive row cannot establish that the Jira issue was adopted into this Teamspace issue.
          const ownerVerified = snapshots.length > 0 && snapshots.every(({ json }) => {
            const snapshot = readArchive(json);
            if (!snapshot || snapshot.excluded || context.excluded.has(`${sourcePackage.stagingId}/${snapshot.record.id}`) ||
                isRestrictedJiraHistoryOwner(snapshot.record)) return false;
            const key = snapshot.record.metadata.key;
            return typeof key !== 'string' || !key || instanceAliases.has(key);
          });
          if (ownerVerified) proof = { stagingId: sourcePackage.stagingId, timezone, centuryReview: context.centuryReview, excluded: context.excluded };
        }
        proven.set(proofKey, proof);
      }
      const proof = proven.get(proofKey);
      if (!proof || proof.excluded.has(`${proof.stagingId}/${record.id}`)) continue;

      const date = historicalDate(archive, proof);
      const stable = record.metadata.syntheticId !== true && originalGroupId.test(record.sourceId);
      const occurrence = new Map<string, number>();
      for (const { position, from, to } of transitions) {
        const change = JSON.stringify([from.id ?? from.label, to.id ?? to.label]);
        const prior = occurrence.get(change) ?? 0;
        occurrence.set(change, prior + 1);
        const identity = JSON.stringify([source.instanceKey, record.sourceId, change, prior]);
        if (stable && seen.has(identity)) {
          duplicate?.(archive);
          continue;
        }
        if (stable) seen.add(identity);
        add({ authorId: typeof record.authorId === 'string' ? record.authorId : null, sourceInstance: source.instanceKey,
          packageSha256, ordinal: candidate.ordinal, position, entry: {
            id: `${archive.id}:${position}`, sourceImportId, sourceRecordId: archive.id,
            ...date, originalAuthorName: null, from, to,
          } });
      }
    }
  }

  return { project, withAuthor };
}

export function jiraIssueStatusHistory(store: Store, issue: Issue, offset: number, limit: number): JiraIssueStatusHistoryPage {
  const timeline = prepareTimeline(store);
  const events: TimelineEvent[] = [];
  timeline.project(issue, event => events.push(event));
  events.sort(timelineOrder);
  return { entries: events.slice(offset, offset + limit).map(timeline.withAuthor), total: events.length, offset, limit };
}

export function auditJiraStatusHistory(store: Store, receipt: SourceImport): SourceReconciliationJiraStatusHistory {
  // Find only issues reached by recognized status changes in this receipt. Their timeline may use earlier receipts for deduplication.
  const rows = store.db.prepare(`SELECT history.id AS archiveId,history.json,issue.id AS issueId,issue.project_id AS projectId
    FROM source_records AS history
    LEFT JOIN source_bindings AS binding ON history.owner_type IS NULL AND history.owner_id IS NULL AND
      binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue' AND binding.source_instance=history.source_instance AND
      binding.source_alias=CASE WHEN json_valid(history.json) THEN json_extract(history.json,'$.record.containerId') END
    LEFT JOIN issues AS issue ON issue.id=CASE WHEN history.owner_type='issue' THEN history.owner_id ELSE binding.target_id END
      AND (history.owner_type='issue' OR issue.project_id=?)
    WHERE history.import_id=? AND history.product='jira' AND history.kind='history'
      AND CASE WHEN json_valid(history.json) THEN json_type(history.json,'$.record.metadata.items')='array' ELSE 0 END`);
  const stats = { sourceChanges: 0, duplicate: 0, excluded: 0, restricted: 0, unavailable: 0, unresolvedTime: 0, unresolvedAuthor: 0 };
  const issueProjects = new Map<string, string>();
  const candidateIds = new Set<string>();
  const { excluded } = receiptContext(receipt);
  for (const row of rows.iterate(receipt.configuration.appendTo?.projectId ?? null, receipt.id) as unknown as
      Iterable<ArchiveRow & { archiveId: string; issueId: string | null; projectId: string | null }>) {
    const archive = readArchive(row.json);
    if (!archive) continue;
    const count = countJiraStatusTransitions(archive.record);
    if (!count) continue;
    stats.sourceChanges += count;
    const sourcePackage = receiptPackage(archive, receipt);
    if (archive.excluded || (sourcePackage && excluded.has(`${sourcePackage.stagingId}/${archive.record.id}`))) stats.excluded += count;
    else if (isRestrictedJiraStatusHistory(archive.record)) stats.restricted += count;
    else if (row.issueId && row.projectId && archive.id === row.archiveId && archive.sourceImportId === receipt.id) {
      issueProjects.set(row.issueId, row.projectId);
      candidateIds.add(row.archiveId);
    }
  }

  const hash = createHash('sha256');
  let projected = 0;
  if (issueProjects.size) {
    const timeline = prepareTimeline(store, receipt);
    for (const id of [...issueProjects.keys()].sort()) {
      const events: TimelineEvent[] = [];
      timeline.project({ id, projectId: issueProjects.get(id)! }, event => {
        if (event.entry.sourceImportId === receipt.id && candidateIds.has(event.entry.sourceRecordId)) events.push(event);
      }, archive => {
        if (archive.sourceImportId === receipt.id && candidateIds.has(archive.id)) stats.duplicate++;
      });
      for (const event of events.sort(timelineOrder)) {
        const entry = timeline.withAuthor(event);
        hash.update(JSON.stringify([id, entry.id, entry.sourceImportId, entry.sourceRecordId, entry.from.id, entry.from.label,
          entry.to.id, entry.to.label, entry.changedAt, entry.originalChangedAt, entry.originalAuthorName])).update('\n');
        projected++;
        if (entry.changedAt === null) stats.unresolvedTime++;
        if (entry.originalAuthorName === null) stats.unresolvedAuthor++;
      }
    }
  }
  stats.unavailable = stats.sourceChanges - projected - stats.duplicate - stats.excluded - stats.restricted;
  return { ...stats, projected: { count: projected, sha256: hash.digest('hex') } };
}
