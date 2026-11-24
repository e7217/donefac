import { createHash } from 'node:crypto';
import type { Issue, JiraIssueStatusHistoryEntry, JiraIssueStatusHistoryPage, SourceImport, SourceReconciliationJiraFinding,
  SourceReconciliationJiraStatusFinding, SourceReconciliationJiraStatusHistory, SourceRecordArchive } from '../shared/types.js';
import { isJiraIssueKey } from '../shared/atlassian-links.js';
import { countJiraStatusTransitions, isRestrictedJiraHistoryOwner, isRestrictedJiraStatusHistory, jiraStatusHistoryOwnerAliases,
  jiraStatusTransitions } from './migration-jira-history.js';
import { jiraEnglishDate, sourceTimestamp } from './migration-source-time.js';
import { hasIssueProjectMove, issueProjectAt, readIssueProjectHistory, type IssueProjectHistory } from './issue-project-history.js';
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
interface RetainedOwner {
  issueId: string;
  projectId: string;
  receipt: SourceImport;
  proof: SourceProof;
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
type ResolveSourceProof = (archive: SourceRecordArchive) => SourceProof | null;
type ArchiveCategory = 'excluded' | 'restricted' | 'candidate';
type FindingReason = SourceReconciliationJiraStatusFinding['reason'];
interface ReceiptHistoryRow extends ArchiveRow {
  archiveId: string;
  ownerType: string | null;
  ownerId: string | null;
  sourceId: string;
  sourceInstance: string;
  boundIssueId: string | null;
  issueId: string | null;
  projectId: string | null;
  trashIssueId: string | null;
  trashProjectId: string | null;
}
interface ReceiptHistoryVisitor {
  archive: (row: SourceReconciliationJiraStatusFinding, category: ArchiveCategory) => void;
  projected?: (issueId: string, events: TimelineEvent[], withAuthor: (event: TimelineEvent) => JiraIssueStatusHistoryEntry) => void;
  duplicate?: (sourceRecordId: string) => void;
  resolveUnavailableReasons?: boolean;
}

const originalGroupId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const jiraNumericIssueId = /^[1-9]\d{0,199}$/u;

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

function receiptPackage(archive: SourceRecordArchive, receipt: SourceImport, requireUnique = false) {
  if (!Array.isArray(receipt.packages)) return;
  const matches = receipt.packages.filter(item => item?.sha256 === archive.packageSha256 && item.source?.product === 'jira' &&
    item.source.instanceKey === archive.source.instanceKey && item.source.format === archive.source.format);
  return !requireUnique || matches.length === 1 ? matches[0] : undefined;
}

function prepareTimeline(store: Store, auditedReceipt?: SourceImport, issueIds?: readonly string[]) {
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
      AND CASE WHEN json_valid(receipt.json)
        THEN json_type(receipt.json,'$.configuration.appendTo.projectId')='text' ELSE 0 END
    UNION ALL
    SELECT ${candidateFields}
    FROM source_bindings AS binding CROSS JOIN source_records AS snapshot INDEXED BY source_records_jira_unbound_issue_key
      ON snapshot.source_instance=binding.source_instance AND json_extract(snapshot.json,'$.record.metadata.key')=+binding.source_alias
    CROSS JOIN source_records AS history INDEXED BY source_records_jira_unowned_change_owner
      ON history.source_instance=snapshot.source_instance AND json_extract(history.json,'$.record.containerId')=+snapshot.source_id
    JOIN source_imports AS receipt ON receipt.id=history.import_id
    WHERE binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue' AND binding.target_id=?
      AND snapshot.product='jira' AND snapshot.kind='issue' AND snapshot.target_type IS NULL AND snapshot.target_id IS NULL
      AND history.product='jira' AND history.kind='history' AND history.owner_type IS NULL AND history.owner_id IS NULL
      AND history.import_id=snapshot.import_id AND json_extract(history.json,'$.packageSha256')=json_extract(snapshot.json,'$.packageSha256')
      AND json_type(history.json,'$.record.metadata.items')='array'
      AND CASE WHEN json_valid(receipt.json)
        THEN json_type(receipt.json,'$.configuration.appendTo.projectId')='text' ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM source_bindings AS direct WHERE direct.product='jira' AND direct.kind='issue'
        AND direct.source_instance=snapshot.source_instance AND direct.source_alias=snapshot.source_id)
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
  const retainedIssues = store.db.prepare(`SELECT id,owner_type,owner_id,target_type,target_id,json FROM source_records
    WHERE import_id=? AND product='jira' AND source_instance=? AND kind='issue' AND source_id=?
      AND CASE WHEN json_valid(json) THEN json_extract(json,'$.packageSha256')=? ELSE 0 END LIMIT 2`);
  const issueAlias = store.db.prepare(`SELECT target_id FROM source_bindings WHERE product='jira' AND source_instance=?
    AND kind='issue' AND source_alias=?`);
  const projectAlias = store.db.prepare(`SELECT target_id FROM source_bindings WHERE product='jira' AND source_instance=?
    AND kind='project' AND source_alias=? AND target_type='project'`);
  const originalKeyIssues = store.db.prepare(`SELECT original.id,original.import_id AS importId,binding.target_id AS issueId,original.json
    FROM source_bindings AS binding JOIN source_records AS original ON original.import_id=binding.import_id
      AND original.product=binding.product AND original.source_instance=binding.source_instance AND original.kind=binding.kind
      AND original.source_id=binding.source_alias AND original.owner_type='issue' AND original.owner_id=binding.target_id
      AND original.target_type='issue' AND original.target_id=binding.target_id
    WHERE binding.product='jira' AND binding.source_instance=? AND binding.kind='issue' AND binding.target_type='issue'
      AND binding.source_alias=? LIMIT 2`);
  const sourceAuthor = store.db.prepare(`SELECT json FROM source_records
    WHERE import_id=? AND product='jira' AND source_instance=? AND kind='identity' AND source_id=?
      AND CASE WHEN json_valid(json) THEN json_extract(json,'$.packageSha256')=? AND json_extract(json,'$.excluded') IS NULL ELSE 0 END
    ORDER BY rowid LIMIT 1`);
  const sourceReceipt = store.db.prepare('SELECT json FROM source_imports WHERE id=? AND json_valid(json)');
  const receipts = new Map<string, ReceiptContext | null>();
  if (auditedReceipt) receipts.set(auditedReceipt.id, receiptContext(auditedReceipt));
  const retainedOwners = new Map<string, RetainedOwner | null>();
  const authors = new Map<string, string | null>();
  let history: IssueProjectHistory | undefined;
  const projectHistory = () => history ??= readIssueProjectHistory(store, issueIds);

  function getReceipt(importId: string): ReceiptContext | null {
    if (!receipts.has(importId)) {
      const row = sourceReceipt.get(importId) as ArchiveRow | undefined;
      const receipt = row ? JSON.parse(row.json) as SourceImport | null : null;
      receipts.set(importId, receipt ? receiptContext(receipt) : null);
    }
    return receipts.get(importId) ?? null;
  }

  function reviewedRecord(archive: SourceRecordArchive, context: ReceiptContext, stagingId: string): boolean {
    return !archive.excluded && !context.excluded.has(`${stagingId}/${archive.record.id}`);
  }

  function proveRetainedOwner(archive: SourceRecordArchive, numericId: string): RetainedOwner | null {
    const { sourceImportId, source, packageSha256 } = archive;
    const context = getReceipt(sourceImportId);
    const pkg = context && receiptPackage(archive, context.receipt, true);
    const projectId = context?.receipt.configuration?.appendTo?.projectId;
    const timezone = context?.receipt.configuration?.timezone;
    if (!context || !pkg || !projectId || typeof timezone !== 'string' || !Array.isArray(context.receipt.projectIds) ||
        !context.receipt.projectIds.includes(projectId) ||
        issueAlias.get(source.instanceKey, numericId)) return null;

    const rows = retainedIssues.all(sourceImportId, source.instanceKey, numericId, packageSha256);
    if (rows.length !== 1) return null;
    const [row] = rows;
    const snapshot = typeof row.json === 'string' && readArchive(row.json);
    if (!snapshot || row.owner_type !== null || row.owner_id !== null || row.target_type !== null || row.target_id !== null ||
        snapshot.id !== row.id || snapshot.sourceImportId !== sourceImportId || snapshot.source.instanceKey !== source.instanceKey ||
        snapshot.source.format !== source.format || snapshot.packageSha256 !== packageSha256 || snapshot.record.kind !== 'issue' ||
        snapshot.record.sourceId !== numericId || snapshot.ownerType !== null || snapshot.ownerId !== null ||
        snapshot.targetType !== null || snapshot.targetId !== null || !reviewedRecord(snapshot, context, pkg.stagingId) ||
        isRestrictedJiraHistoryOwner(snapshot.record)) return null;
    const key = snapshot.record.metadata.key;
    if (!isJiraIssueKey(key) || !snapshot.record.containerId ||
        projectAlias.get(source.instanceKey, snapshot.record.containerId)?.target_id !== projectId) return null;

    // Tie the durable key to the original key-only issue through its archived source.
    const originals = originalKeyIssues.all(source.instanceKey, key);
    if (originals.length !== 1) return null;
    const [binding] = originals;
    if (typeof binding.json !== 'string' || typeof binding.importId !== 'string' || typeof binding.issueId !== 'string') return null;
    const original = readArchive(binding.json);
    const prior = getReceipt(binding.importId);
    const priorPkg = original && prior && receiptPackage(original, prior.receipt, true);
    if (!original || !prior || !priorPkg || original.sourceImportId === sourceImportId || prior.receipt.createdAt > context.receipt.createdAt ||
        original.id !== binding.id || original.sourceImportId !== binding.importId || original.source.instanceKey !== source.instanceKey ||
        original.record.kind !== 'issue' || original.record.sourceId !== key || original.record.metadata.key !== key ||
        original.ownerType !== 'issue' || original.ownerId !== binding.issueId || original.targetType !== 'issue' ||
        original.targetId !== binding.issueId || original.targetProjectId !== projectId ||
        !reviewedRecord(original, prior, priorPkg.stagingId) || isRestrictedJiraHistoryOwner(original.record)) return null;
    return { issueId: binding.issueId, projectId, receipt: context.receipt,
      proof: { stagingId: pkg.stagingId, timezone, centuryReview: context.centuryReview, excluded: context.excluded } };
  }

  function retainedOwner(archive: SourceRecordArchive): RetainedOwner | null {
    const { record, source, sourceImportId, packageSha256 } = archive;
    const numericId = record.containerId;
    if (record.kind !== 'history' || source.format !== 'jira-json' || archive.excluded || archive.ownerType !== null || archive.ownerId !== null ||
        archive.targetType !== null || archive.targetId !== null || typeof numericId !== 'string' || !jiraNumericIssueId.test(numericId)) return null;
    const key = JSON.stringify([sourceImportId, source.instanceKey, packageSha256, numericId]);
    if (!retainedOwners.has(key)) retainedOwners.set(key, proveRetainedOwner(archive, numericId));
    const owner = retainedOwners.get(key);
    return owner && !owner.proof.excluded.has(`${owner.proof.stagingId}/${record.id}`) ? owner : null;
  }

  function observedInProject(issue: HistoryIssue, projectId: string, receipt: SourceImport): boolean {
    if (!Array.isArray(receipt.projectIds) || !receipt.projectIds.includes(projectId)) return false;
    const moves = projectHistory();
    if (issueProjectAt(moves, issue.id, issue.projectId, receipt.createdAt) === projectId) return true;
    // The receipt and its following move can share the same millisecond.
    if (Array.isArray(receipt.notices) && receipt.notices.some(notice => notice?.code === 'JIRA_MOVED_ISSUES_ARCHIVED')) return false;
    return moves.get(issue.id)?.some(move => move.occurredAt === receipt.createdAt && move.fromProjectId === projectId) === true &&
      hasIssueProjectMove(moves, issue.id, projectId, issue.projectId, receipt.createdAt);
  }

  const lastObservedProject = (issueId: string): string | undefined => projectHistory().get(issueId)?.at(-1)?.toProjectId;

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

  function prepareOwner(issue: HistoryIssue): ResolveSourceProof | null {
    const bindingRows = issueBindings.all(issue.id) as { instance: string; alias: string }[];
    const aliases = new Map<string, Set<string>>();
    for (const { instance, alias } of bindingRows) {
      const instanceAliases = aliases.get(instance) ?? new Set<string>();
      instanceAliases.add(alias);
      aliases.set(instance, instanceAliases);
    }
    if (!aliases.size) return null;

    const proven = new Map<string, SourceProof | null>();
    return (archive: SourceRecordArchive): SourceProof | null => {
      if (archive.excluded || archive.targetType || archive.targetId) return null;
      const { record, source, sourceImportId, packageSha256 } = archive;
      const fallback = archive.ownerId === null;
      const ownerAliases = jiraStatusHistoryOwnerAliases(record);
      const instanceAliases = aliases.get(source.instanceKey);
      if (!instanceAliases || !ownerAliases) return null;
      if (!ownerAliases.every(alias => instanceAliases.has(alias))) {
        const retained = fallback && ownerAliases.every(alias => alias === record.containerId || instanceAliases.has(alias)) && retainedOwner(archive);
        return retained && retained.issueId === issue.id && observedInProject(issue, retained.projectId, retained.receipt) ? retained.proof : null;
      }

      const proofKey = JSON.stringify([sourceImportId, source.instanceKey, source.format, packageSha256, fallback]);
      if (!proven.has(proofKey)) {
        const context = getReceipt(sourceImportId);
        const timezone = context?.receipt.configuration?.timezone;
        const sourcePackage = context && receiptPackage(archive, context.receipt);
        const appendProject = fallback && context?.receipt.configuration?.appendTo?.projectId;
        let proof: SourceProof | null = null;
        if (context && sourcePackage && typeof timezone === 'string' &&
            (!fallback || typeof appendProject === 'string' && observedInProject(issue, appendProject, context.receipt))) {
          const snapshots = sourceIssues.all(issue.id, sourceImportId, source.instanceKey, packageSha256,
            issue.id, issue.id, Number(fallback), appendProject || issue.projectId) as unknown as ArchiveRow[];
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
      return proof && !proof.excluded.has(`${proof.stagingId}/${record.id}`) ? proof : null;
    };
  }

  function project(issue: HistoryIssue, add: (event: TimelineEvent) => void, duplicate?: (archive: SourceRecordArchive) => void) {
    const owner = prepareOwner(issue);
    if (!owner) return;
    const seen = new Set<string>();
    for (const candidate of candidates.iterate(issue.id, issue.id, issue.id) as unknown as Iterable<HistoryCandidate>) {
      const archive = readArchive(candidate.json);
      if (!archive || archive.id !== candidate.archiveId || archive.sourceImportId !== candidate.importId ||
          archive.ownerType !== candidate.ownerType || archive.ownerId !== candidate.ownerId ||
          archive.source.instanceKey !== candidate.sourceInstance) continue;
      const { record, source, sourceImportId, packageSha256 } = archive;
      const transitions = jiraStatusTransitions(record);
      if (!transitions.length) continue;
      const proof = owner(archive);
      if (!proof) continue;

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

  return { project, withAuthor, prepareOwner, lastObservedProject, observedInProject, retainedOwner };
}

export function jiraIssueStatusHistory(store: Store, issue: Issue, offset: number, limit: number): JiraIssueStatusHistoryPage {
  const timeline = prepareTimeline(store, undefined, [issue.id]);
  const events: TimelineEvent[] = [];
  timeline.project(issue, event => events.push(event));
  events.sort(timelineOrder);
  return { entries: events.slice(offset, offset + limit).map(timeline.withAuthor), total: events.length, offset, limit };
}

function inspectReceiptHistory(store: Store, receipt: SourceImport, visitor: ReceiptHistoryVisitor): void {
  // Find only issues reached by recognized status changes in this receipt. Their timeline may use earlier receipts for deduplication.
  const ownerId = `CASE WHEN history.owner_type='issue' THEN history.owner_id ELSE binding.target_id END`;
  const withTrash = visitor.resolveUnavailableReasons === true;
  const rows = store.db.prepare(`SELECT history.id AS archiveId,history.json,history.owner_type AS ownerType,
    history.owner_id AS ownerId,history.source_id AS sourceId,history.source_instance AS sourceInstance,
    ${ownerId} AS boundIssueId,issue.id AS issueId,issue.project_id AS projectId,
    ${withTrash ? 'trash.resource_id AS trashIssueId,trash.project_id AS trashProjectId' : 'NULL AS trashIssueId,NULL AS trashProjectId'}
    FROM source_records AS history
    LEFT JOIN source_bindings AS binding ON history.owner_type IS NULL AND history.owner_id IS NULL AND
      binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue' AND binding.source_instance=history.source_instance AND
      binding.source_alias=CASE WHEN json_valid(history.json) THEN json_extract(history.json,'$.record.containerId') END
    LEFT JOIN issues AS issue ON issue.id=${ownerId}
    ${withTrash ? `LEFT JOIN trash_entries AS trash ON trash.resource_type='issue' AND trash.resource_id=${ownerId}` : ''}
    WHERE history.import_id=? AND history.product='jira' AND history.kind='history'
      AND CASE WHEN json_valid(history.json) THEN json_type(history.json,'$.record.metadata.items')='array' ELSE 0 END`);
  const appendProjectId = receipt.configuration.appendTo?.projectId;
  const issueProjects = new Map<string, string>();
  const candidateIds = new Set<string>();
  const { excluded } = receiptContext(receipt);
  const timeline = visitor.projected || visitor.duplicate || withTrash ? prepareTimeline(store, receipt) : null;
  const archiveOwners = new Map<string, ResolveSourceProof | null>();
  const liveOwner = store.db.prepare('SELECT id,project_id AS projectId FROM issues WHERE id=?');
  const trashedOwner = withTrash ? store.db.prepare("SELECT resource_id AS id,project_id AS projectId FROM trash_entries WHERE resource_type='issue' AND resource_id=?") : null;
  const retainedTargets = new Map<string, Pick<ReceiptHistoryRow, 'boundIssueId' | 'issueId' | 'projectId' | 'trashIssueId' | 'trashProjectId'>>();

  function targetForRetainedOwner(issueId: string) {
    if (!retainedTargets.has(issueId)) {
      const live = liveOwner.get(issueId);
      const trash = !live && trashedOwner?.get(issueId);
      retainedTargets.set(issueId, {
        boundIssueId: issueId,
        issueId: live ? issueId : null,
        projectId: typeof live?.projectId === 'string' ? live.projectId : null,
        trashIssueId: trash ? issueId : null,
        trashProjectId: trash && typeof trash.projectId === 'string' ? trash.projectId : null,
      });
    }
    return retainedTargets.get(issueId)!;
  }

  function missingReason(row: ReceiptHistoryRow, archive: SourceRecordArchive, identityMatches: boolean): FindingReason {
    const projectId = row.ownerType === 'issue' ? archive.targetProjectId : appendProjectId;
    if (row.issueId || !timeline || !row.boundIssueId || !projectId || !receipt.projectIds.includes(projectId) ||
        (row.trashIssueId && !row.trashProjectId) ||
        !identityMatches || archive.ownerId !== row.ownerId || archive.ownerType !== row.ownerType) {
      return 'ownership-unverified';
    }
    const issue = { id: row.boundIssueId, projectId: row.trashProjectId ?? timeline.lastObservedProject(row.boundIssueId) ?? projectId };
    if (!timeline.observedInProject(issue, projectId, receipt)) return 'ownership-unverified';
    const key = JSON.stringify([issue.id, issue.projectId]);
    if (!archiveOwners.has(key)) archiveOwners.set(key, timeline.prepareOwner(issue));
    if (!archiveOwners.get(key)?.(archive)) return 'ownership-unverified';
    return row.trashIssueId ? 'issue-in-trash' : 'issue-unavailable';
  }

  for (const stored of rows.iterate(receipt.id) as unknown as Iterable<ReceiptHistoryRow>) {
    const archive = readArchive(stored.json);
    if (!archive) continue;
    const changeCount = countJiraStatusTransitions(archive.record);
    if (!changeCount) continue;
    const sourcePackage = receiptPackage(archive, receipt);
    const category = archive.excluded || (sourcePackage && excluded.has(`${sourcePackage.stagingId}/${archive.record.id}`))
      ? 'excluded' : isRestrictedJiraStatusHistory(archive.record) ? 'restricted' : 'candidate';
    const identityMatches = archive.id === stored.archiveId && archive.sourceImportId === receipt.id &&
      archive.record.sourceId === stored.sourceId && archive.source.instanceKey === stored.sourceInstance;
    const retained = !stored.boundIssueId && stored.ownerType === null && stored.ownerId === null &&
      category === 'candidate' && identityMatches ? timeline?.retainedOwner(archive) : null;
    const row = retained ? { ...stored, ...targetForRetainedOwner(retained.issueId) } : stored;
    visitor.archive({ sourceRecordId: row.archiveId, sourceId: row.sourceId, sourceInstance: row.sourceInstance,
      sourceIssueId: identityMatches ? originalText(archive.record.containerId, 500) : null,
      changeCount, reason: withTrash && category === 'candidate' ? missingReason(row, archive, identityMatches) : null }, category);
    if (timeline && category === 'candidate' && row.issueId && row.projectId && (row.ownerType === 'issue' || appendProjectId) &&
        archive.id === row.archiveId && archive.sourceImportId === receipt.id) {
      issueProjects.set(row.issueId, row.projectId);
      candidateIds.add(row.archiveId);
    }
  }

  if (!timeline) return;
  for (const [id, projectId] of [...issueProjects].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const events: TimelineEvent[] = [];
    timeline.project({ id, projectId }, event => {
      if (event.entry.sourceImportId === receipt.id && candidateIds.has(event.entry.sourceRecordId)) events.push(event);
    }, archive => {
      if (archive.sourceImportId === receipt.id && candidateIds.has(archive.id)) visitor.duplicate?.(archive.id);
    });
    visitor.projected?.(id, events, timeline.withAuthor);
  }
}

export function auditJiraStatusHistory(store: Store, receipt: SourceImport): SourceReconciliationJiraStatusHistory {
  const stats = { sourceChanges: 0, duplicate: 0, excluded: 0, restricted: 0, unavailable: 0, unresolvedTime: 0, unresolvedAuthor: 0 };
  const hash = createHash('sha256');
  let projected = 0;
  inspectReceiptHistory(store, receipt, {
    archive({ changeCount }, category) {
      stats.sourceChanges += changeCount;
      if (category !== 'candidate') stats[category] += changeCount;
    },
    duplicate() { stats.duplicate++; },
    projected(id, events, withAuthor) {
      for (const event of events.sort(timelineOrder)) {
        const entry = withAuthor(event);
        hash.update(JSON.stringify([id, entry.id, entry.sourceImportId, entry.sourceRecordId, entry.from.id, entry.from.label,
          entry.to.id, entry.to.label, entry.changedAt, entry.originalChangedAt, entry.originalAuthorName])).update('\n');
        projected++;
        if (entry.changedAt === null) stats.unresolvedTime++;
        if (entry.originalAuthorName === null) stats.unresolvedAuthor++;
      }
    },
  });
  stats.unavailable = stats.sourceChanges - projected - stats.duplicate - stats.excluded - stats.restricted;
  return { ...stats, projected: { count: projected, sha256: hash.digest('hex') } };
}

export function jiraStatusHistoryFindings(
  store: Store, receipt: SourceImport, finding: SourceReconciliationJiraFinding, offset: number, limit: number,
): { rows: SourceReconciliationJiraStatusFinding[]; total: number; totalChanges: number; fingerprint: string } {
  const selected = new Map<string, SourceReconciliationJiraStatusFinding>();
  const unresolved = finding === 'unresolved-time' || finding === 'unresolved-author';
  const unavailable = finding === 'unavailable';
  function updateCount(sourceRecordId: string, delta: number): void {
    const row = selected.get(sourceRecordId);
    if (row) row.changeCount += delta;
  }

  inspectReceiptHistory(store, receipt, {
    archive(row, category) {
      if (category === finding || (category === 'candidate' && (unavailable || unresolved))) {
        selected.set(row.sourceRecordId, unresolved ? { ...row, changeCount: 0 } : row);
      }
    },
    resolveUnavailableReasons: unavailable,
    duplicate: unavailable ? id => updateCount(id, -1) : undefined,
    projected: unavailable || unresolved ? (_issueId, events, withAuthor) => {
      for (const event of events) {
        if (unavailable) updateCount(event.entry.sourceRecordId, -1);
        else if (finding === 'unresolved-time' ? event.entry.changedAt === null : withAuthor(event).originalAuthorName === null) {
          updateCount(event.entry.sourceRecordId, 1);
        }
      }
    } : undefined,
  });

  const rows = [...selected.values()].filter(row => row.changeCount > 0)
    .sort((left, right) => left.sourceRecordId < right.sourceRecordId ? -1 : left.sourceRecordId > right.sourceRecordId ? 1 : 0);
  const hash = createHash('sha256').update(JSON.stringify([receipt.id, finding])).update('\n');
  let totalChanges = 0;
  for (const row of rows) {
    totalChanges += row.changeCount;
    hash.update(JSON.stringify([row.sourceRecordId, row.sourceId, row.sourceInstance, row.sourceIssueId, row.changeCount, row.reason])).update('\n');
  }
  return { rows: rows.slice(offset, offset + limit), total: rows.length, totalChanges, fingerprint: hash.digest('hex') };
}
