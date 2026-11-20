import type { Issue, JiraIssueStatusHistoryEntry, JiraIssueStatusHistoryPage, SourceImport, SourceRecordArchive } from '../shared/types.js';
import { isRestrictedJiraHistoryOwner, jiraStatusHistoryOwnerAliases, jiraStatusTransitions } from './migration-jira-history.js';
import { jiraEnglishDate, sourceTimestamp } from './migration-source-time.js';
import type { Store } from './store.js';

interface ArchiveRow { json: string }
interface HistoryCandidate extends ArchiveRow { ordinal: number }
interface SourceProof {
  timezone: string;
  stagingId: string;
  centuryReview: Set<string>;
}
interface TimelineEvent {
  entry: JiraIssueStatusHistoryEntry;
  authorId: string | null;
  sourceInstance: string;
  packageSha256: string;
  ordinal: number;
  position: number;
}

const originalGroupId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function originalText(value: string | null, max: number): string | null {
  return value && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function historicalDate(archive: SourceRecordArchive, proof: SourceProof) {
  const raw = originalText(archive.record.createdAt, 100);
  // A day without a time, or an unreviewed two-digit year, is not an event timestamp.
  const hasTime = raw && /[T ]\d{1,2}:\d{2}/.test(raw);
  const centuryReviewed = raw && (!jiraEnglishDate(raw)?.century || proof.centuryReview.has(`${proof.stagingId}/${archive.record.id}`));
  const changedAt = hasTime && centuryReviewed ? sourceTimestamp(raw, proof.timezone) : null;
  return { changedAt, originalChangedAt: changedAt ? null : raw };
}

export function jiraIssueStatusHistory(store: Store, issue: Issue, offset: number, limit: number): JiraIssueStatusHistoryPage {
  const bindingRows = store.db.prepare(`SELECT source_instance AS instance,source_alias AS alias FROM source_bindings
    WHERE product='jira' AND kind='issue' AND target_type='issue' AND target_id=?`).all(issue.id) as { instance: string; alias: string }[];
  const aliases = new Map<string, Set<string>>();
  for (const { instance, alias } of bindingRows) {
    const instanceAliases = aliases.get(instance) ?? new Set<string>();
    instanceAliases.add(alias);
    aliases.set(instance, instanceAliases);
  }
  if (!aliases.size) return { entries: [], total: 0, offset, limit };

  // Removing the alias column's text affinity lets SQLite seek on the JSON owner expression as well as the instance.
  const candidates = store.db.prepare(`SELECT history.json,history.rowid AS ordinal FROM source_records AS history
    WHERE history.owner_type='issue' AND history.owner_id=? AND history.product='jira' AND history.kind='history'
      AND json_type(history.json,'$.record.metadata.items')='array'
    UNION ALL
    SELECT history.json,history.rowid AS ordinal
    FROM source_bindings AS binding CROSS JOIN source_records AS history INDEXED BY source_records_jira_unowned_change_owner
      ON history.source_instance=binding.source_instance AND json_extract(history.json,'$.record.containerId')=+binding.source_alias
    JOIN source_imports AS receipt ON receipt.id=history.import_id
    WHERE binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue' AND binding.target_id=?
      AND history.product='jira' AND history.kind='history' AND history.owner_type IS NULL AND history.owner_id IS NULL
      AND json_type(history.json,'$.record.metadata.items')='array'
      AND json_extract(receipt.json,'$.configuration.appendTo.projectId')=?
    ORDER BY ordinal`);
  const sourceIssues = store.db.prepare(`SELECT snapshot.json
    FROM source_bindings AS binding CROSS JOIN source_records AS snapshot
      ON snapshot.source_instance=binding.source_instance AND snapshot.source_id=binding.source_alias
    LEFT JOIN source_bindings AS project ON project.product='jira' AND project.kind='project' AND project.target_type='project'
      AND project.source_instance=snapshot.source_instance AND project.source_alias=json_extract(snapshot.json,'$.record.containerId')
    WHERE binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue' AND binding.target_id=?
      AND snapshot.import_id=? AND snapshot.product='jira' AND snapshot.source_instance=? AND snapshot.kind='issue'
      AND json_extract(snapshot.json,'$.packageSha256')=?
      AND ((snapshot.target_type='issue' AND snapshot.target_id=? AND snapshot.owner_type='issue' AND snapshot.owner_id=?)
        OR (? AND snapshot.target_type IS NULL AND snapshot.target_id IS NULL AND snapshot.owner_type IS NULL
          AND snapshot.owner_id IS NULL AND project.target_id=?))`);
  const sourceAuthor = store.db.prepare(`SELECT json FROM source_records
    WHERE import_id=? AND product='jira' AND source_instance=? AND kind='identity' AND source_id=?
      AND json_extract(json,'$.packageSha256')=? AND json_extract(json,'$.excluded') IS NULL
    ORDER BY rowid LIMIT 1`);
  const receipts = new Map<string, SourceImport | undefined>();
  const proven = new Map<string, SourceProof | null>();
  const seen = new Set<string>();
  const events: TimelineEvent[] = [];

  for (const candidate of candidates.iterate(issue.id, issue.id, issue.projectId) as Iterable<HistoryCandidate>) {
    const archive = JSON.parse(candidate.json) as SourceRecordArchive;
    if (archive.excluded || archive.targetType || archive.targetId) continue;
    const { record, source, sourceImportId, packageSha256 } = archive;
    const fallback = archive.ownerId === null;
    const ownerAliases = jiraStatusHistoryOwnerAliases(record);
    const instanceAliases = aliases.get(source.instanceKey);
    if (!instanceAliases || !ownerAliases?.every(alias => instanceAliases.has(alias))) continue;
    const transitions = jiraStatusTransitions(record);
    if (!transitions.length) continue;

    const proofKey = JSON.stringify([sourceImportId, source.instanceKey, packageSha256, fallback]);
    if (!proven.has(proofKey)) {
      if (!receipts.has(sourceImportId)) receipts.set(sourceImportId, store.get<SourceImport>('source_imports', sourceImportId));
      const receipt = receipts.get(sourceImportId);
      const sourcePackage = receipt?.packages.find(item => item.sha256 === packageSha256 && item.source.product === 'jira'
        && item.source.instanceKey === source.instanceKey && item.source.format === source.format);
      const snapshots = sourceIssues.all(issue.id, sourceImportId, source.instanceKey, packageSha256,
        issue.id, issue.id, Number(fallback), issue.projectId) as unknown as ArchiveRow[];
      // A standalone archive row cannot establish that the Jira issue was adopted into this Teamspace issue.
      const ownerVerified = snapshots.length > 0 && snapshots.every(({ json }) => {
        const snapshot = JSON.parse(json) as SourceRecordArchive;
        const key = snapshot.record.metadata.key;
        return !snapshot.excluded && !isRestrictedJiraHistoryOwner(snapshot.record) &&
          (typeof key !== 'string' || !key || instanceAliases.has(key));
      });
      proven.set(proofKey, receipt && sourcePackage && ownerVerified ? {
        stagingId: sourcePackage.stagingId,
        timezone: receipt.configuration.timezone,
        centuryReview: new Set(receipt.notices?.filter(notice => notice.code === 'DATE_TWO_DIGIT_CENTURY' && notice.recordId)
          .map(notice => notice.recordId!)),
      } : null);
    }
    const proof = proven.get(proofKey);
    if (!proof) continue;

    const date = historicalDate(archive, proof);
    const stable = record.metadata.syntheticId !== true && originalGroupId.test(record.sourceId);
    const occurrence = new Map<string, number>();
    for (const { position, from, to } of transitions) {
      const change = JSON.stringify([from.id ?? from.label, to.id ?? to.label]);
      const prior = occurrence.get(change) ?? 0;
      occurrence.set(change, prior + 1);
      const identity = JSON.stringify([source.instanceKey, record.sourceId, change, prior]);
      if (stable && seen.has(identity)) continue;
      if (stable) seen.add(identity);
      events.push({ authorId: record.authorId, sourceInstance: source.instanceKey, packageSha256, ordinal: candidate.ordinal, position, entry: {
        id: `${archive.id}:${position}`, sourceImportId, sourceRecordId: archive.id,
        ...date, originalAuthorName: null, from, to,
      } });
    }
  }

  events.sort((a, b) => (b.entry.changedAt ?? '').localeCompare(a.entry.changedAt ?? '') ||
    a.ordinal - b.ordinal || a.position - b.position);
  const authors = new Map<string, string | null>();
  const entries = events.slice(offset, offset + limit).map(({ authorId, sourceInstance, packageSha256, entry }) => {
    if (!authorId) return entry;
    const authorKey = JSON.stringify([entry.sourceImportId, sourceInstance, packageSha256, authorId]);
    if (!authors.has(authorKey)) {
      const row = sourceAuthor.get(entry.sourceImportId, sourceInstance, authorId, packageSha256) as ArchiveRow | undefined;
      const identity = row && (JSON.parse(row.json) as SourceRecordArchive).record;
      authors.set(authorKey, identity ? originalText(identity.title || identity.sourceId, 500) : null);
    }
    return { ...entry, originalAuthorName: authors.get(authorKey) ?? null };
  });
  return { entries, total: events.length, offset, limit };
}
