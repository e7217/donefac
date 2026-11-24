import { createHash } from 'node:crypto';
import { isCalendarDate } from '../shared/calendar.js';
import type { LegacyRecord, SourceImport, SourceRecordArchive } from '../shared/types.js';
import type { MigrationJiraWorklogCandidate } from './migration-contracts.js';
import { convertLegacyContent } from './migration-content.js';
import { jiraHistoryOwnerAliases, jiraHistorySourceKey } from './migration-jira-history.js';
import { jiraEnglishDate, sourceTimestamp } from './migration-source-time.js';
import { isRestrictedJiraWorklog, parseJiraWorklog } from './migration-worklog.js';
import type { Store } from './store.js';

type Baseline = NonNullable<MigrationJiraWorklogCandidate['previous']>;
type WorklogAnchor = Pick<MigrationJiraWorklogCandidate['current'], 'id' | 'issueId' | 'authorId'>;
export type JiraWorklogCorrectionState = WorklogAnchor & {
  sourceRecordId?: string; jiraCorrectionRecordId?: string; version: number;
};
type RestorableWorklog = JiraWorklogCorrectionState &
  Pick<MigrationJiraWorklogCandidate['current'], 'workDate' | 'note' | 'deletedAt'> & { durationSeconds?: number };
type ReceiptReader = (id: string) => SourceImport | undefined;
type CorrectionMarker = NonNullable<SourceRecordArchive['jiraWorklogCorrection']>;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

export function jiraWorklogNoteHash(note: string): string {
  return createHash('sha256').update(note).digest('hex');
}

export function jiraWorklogSourceUpdatedAt(record: LegacyRecord, timezone: string): string | null {
  const raw = typeof record.updatedAt === 'string' ? record.updatedAt.trim() : '';
  if (!raw || !/[T ]\d{1,2}:\d{2}/u.test(raw)) return null;
  const english = jiraEnglishDate(raw);
  if (english) return english.century ? null : sourceTimestamp(english.local, timezone);
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):?(\d{2})| (?:UTC|GMT))?$/u.exec(raw);
  if (!match || !isCalendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 ||
      Number(match[4] ?? 0) > 59 || Number(match[5] ?? 0) > 23 || Number(match[6] ?? 0) > 59) return null;
  return sourceTimestamp(raw.replace(/ (?:UTC|GMT)$/u, 'Z'), timezone);
}

export function jiraWorklogProjectedNote(record: LegacyRecord): string | undefined {
  if (record.metadata.worklogNoteObserved === false) return undefined;
  if (!record.text || record.textFormat === 'adf' && record.text === 'null') {
    return record.metadata.worklogNoteObserved === true ? '' : undefined;
  }
  if (record.textFormat === 'plain' || record.textFormat === 'none') {
    const note = record.text.replace(/\r\n?/g, '\n').trim();
    return note.length <= 2000 ? note : undefined;
  }
  let dependsOnReferences = false;
  const converted = convertLegacyContent(record, { legacyAnnotations: true, resolveReference: () => {
    dependsOnReferences = true;
    return null;
  } });
  const note = converted.plainText.trim();
  return !dependsOnReferences && !converted.diagnostics.length && note.length <= 2000 ? note : undefined;
}

function memberPackage(record: SourceRecordArchive, receipt: SourceImport) {
  if (!record.source || !record.record || receipt.id !== record.sourceImportId || record.excluded ||
      !record.targetProjectId || !Array.isArray(receipt.projectIds) || !receipt.projectIds.includes(record.targetProjectId) ||
      !Array.isArray(receipt.packages) || !Array.isArray(receipt.configuration?.packageIds) || !Array.isArray(receipt.configuration.excludedRecords)) return;
  const packages = receipt.packages.filter(pkg => pkg?.sha256 === record.packageSha256 &&
    pkg.source?.product === record.source.product && pkg.source.instanceKey === record.source.instanceKey && pkg.source.format === record.source.format);
  if (packages.length !== 1) return;
  const [pkg] = packages;
  return receipt.configuration.packageIds.includes(pkg.stagingId) &&
    !receipt.configuration.excludedRecords.includes(`${pkg.stagingId}/${record.record.id}`) ? pkg : undefined;
}

function sourceIsOwnedWorklog(source: SourceRecordArchive, current: WorklogAnchor): boolean {
  return source.source?.product === 'jira' && source.record?.metadata && jiraHistorySourceKey(source.record)?.kind === 'worklog' &&
    jiraHistoryOwnerAliases(source.record) !== null && !isRestrictedJiraWorklog(source.record) &&
    source.ownerType === 'issue' && source.ownerId === current.issueId && source.targetType === null && source.targetId === null;
}

function sourceFields(source: SourceRecordArchive, receipt: SourceImport): Omit<Baseline, 'noteSha256'> | null {
  const timezone = receipt.configuration.timezone;
  const updatedAt = jiraWorklogSourceUpdatedAt(source.record, timezone);
  const parsed = parseJiraWorklog(source.record, timezone);
  return updatedAt && !('code' in parsed) ? { updatedAt, workDate: parsed.workDate, durationSeconds: parsed.durationSeconds } : null;
}

function originalBaseline(source: SourceRecordArchive, receipt: SourceImport | undefined, current: WorklogAnchor): Baseline | null {
  if (!receipt || source.jiraWorklogCorrection || !sourceIsOwnedWorklog(source, current)) return null;
  if (source.authorAttribution && (source.authorAttribution.kind !== 'worklog' ||
      source.authorAttribution.targetId !== current.id || source.authorAttribution.expectedAuthorId !== current.authorId)) return null;
  const pkg = memberPackage(source, receipt);
  if (!pkg) return null;
  const fields = sourceFields(source, receipt);
  if (!fields) return null;
  const projectedNote = !source.record.text || source.record.text === 'null' ? '' : jiraWorklogProjectedNote(source.record);
  const archivedNote = receipt.notices?.some(notice => notice.code === 'WORKLOG_NOTE_ARCHIVED' &&
    notice.recordId === `${pkg.stagingId}/${source.record.id}`);
  const note = projectedNote ?? (archivedNote ? '' : undefined);
  return note === undefined ? null : { ...fields, noteSha256: jiraWorklogNoteHash(note) };
}

function correctionMarker(value: unknown): value is CorrectionMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { worklogId, originalRecordId, previousRecordId, noteSha256, confirmed } = value as Partial<CorrectionMarker>;
  return typeof worklogId === 'string' && uuid.test(worklogId) && typeof originalRecordId === 'string' && uuid.test(originalRecordId) &&
    typeof previousRecordId === 'string' && uuid.test(previousRecordId) && typeof noteSha256 === 'string' && sha256.test(noteSha256) &&
    (confirmed === undefined || confirmed === true);
}

export function jiraWorklogCorrectionBaseline(source: SourceRecordArchive, receipt: SourceImport,
  original: SourceRecordArchive, previous: SourceRecordArchive, previousReceipt: SourceImport | undefined,
  prior: Baseline, current: WorklogAnchor): Baseline | null {
  const marker = source.jiraWorklogCorrection;
  if (!correctionMarker(marker) || marker.worklogId !== current.id || marker.originalRecordId !== original.id ||
      marker.previousRecordId !== previous.id || source.id === original.id || source.id === previous.id ||
      source.jiraHistoryAppend || source.authorAttribution || !sourceIsOwnedWorklog(source, current) ||
      source.source.instanceKey !== original.source.instanceKey || source.record.sourceId !== original.record.sourceId ||
      source.targetProjectId !== original.targetProjectId || !memberPackage(source, receipt) || !previousReceipt ||
      previousReceipt.id === receipt.id || previousReceipt.createdAt > receipt.createdAt ||
      receipt.configuration.appendTo?.refreshWorklogs !== true || receipt.configuration.appendTo.projectId !== source.targetProjectId) return null;
  const fields = sourceFields(source, receipt);
  if (!fields || fields.updatedAt <= prior.updatedAt) return null;
  const note = jiraWorklogProjectedNote(source.record);
  const noteSha256 = note === undefined ? prior.noteSha256 : jiraWorklogNoteHash(note);
  const sameValues = fields.workDate === prior.workDate && fields.durationSeconds === prior.durationSeconds && noteSha256 === prior.noteSha256;
  return marker.noteSha256 === noteSha256 && (marker.confirmed === true) === sameValues ? { ...fields, noteSha256 } : null;
}

function chainBaseline(original: SourceRecordArchive, current: JiraWorklogCorrectionState,
  records: readonly SourceRecordArchive[], receipt: ReceiptReader): Baseline | null {
  const byPrevious = new Map<string, SourceRecordArchive>();
  for (const source of records) {
    const marker = source.jiraWorklogCorrection;
    if (!correctionMarker(marker) || byPrevious.has(marker.previousRecordId)) return null;
    byPrevious.set(marker.previousRecordId, source);
  }
  let previous = original;
  let previousReceipt = receipt(original.sourceImportId);
  let baseline = originalBaseline(original, previousReceipt, current);
  for (let remaining = records.length; remaining > 0; remaining--) {
    const next = byPrevious.get(previous.id);
    if (!next || !baseline) return null;
    const nextReceipt = receipt(next.sourceImportId);
    if (!nextReceipt) return null;
    baseline = jiraWorklogCorrectionBaseline(next, nextReceipt, original, previous, previousReceipt, baseline, current);
    previous = next;
    previousReceipt = nextReceipt;
  }
  return (current.jiraCorrectionRecordId ?? original.id) === previous.id && current.version > records.length ? baseline : null;
}

export function validRestoredJiraWorklogCorrections(worklogs: readonly RestorableWorklog[],
  sources: ReadonlyMap<string, SourceRecordArchive>, imports: readonly SourceImport[]): boolean {
  const corrections = new Map<string, SourceRecordArchive[]>();
  for (const source of sources.values()) if (Object.hasOwn(source, 'jiraWorklogCorrection')) {
    const marker = source.jiraWorklogCorrection;
    if (!correctionMarker(marker)) return false;
    const records = corrections.get(marker.worklogId) ?? [];
    records.push(source);
    corrections.set(marker.worklogId, records);
  }
  const receipts = new Map(imports.map(receipt => [receipt.id, receipt]));
  for (const worklog of worklogs) {
    const records = corrections.get(worklog.id);
    if (!records && worklog.jiraCorrectionRecordId === undefined) continue;
    const original = worklog.sourceRecordId && sources.get(worklog.sourceRecordId);
    if (!records?.length || !original || !worklog.jiraCorrectionRecordId) return false;
    const baseline = chainBaseline(original, worklog, records, id => receipts.get(id));
    if (!baseline || worklog.version === records.length + 1 && (
      worklog.deletedAt !== null || worklog.workDate !== baseline.workDate || worklog.durationSeconds !== baseline.durationSeconds ||
      jiraWorklogNoteHash(worklog.note) !== baseline.noteSha256)) return false;
    corrections.delete(worklog.id);
  }
  return corrections.size === 0;
}

type DatabaseRow = {
  id: string; issueId: string; projectId: string; authorId: string; workDate: string;
  deletedAt: string | null; worklogJson: string; archiveId: string; archiveImportId: string; archiveJson: string; sourceId: string;
};
type CandidateRecord = JiraWorklogCorrectionState & MigrationJiraWorklogCandidate['current'] & { minutes: number };

export function readJiraWorklogCorrectionCandidates(store: Store, instanceKey: string, selectedIds: readonly string[],
  projectId: string): MigrationJiraWorklogCandidate[] {
  if (!selectedIds.length) return [];
  const read = store.db.prepare(`SELECT w.id,w.issue_id AS issueId,w.project_id AS projectId,w.author_id AS authorId,
    w.work_date AS workDate,w.deleted_at AS deletedAt,w.json AS worklogJson,s.id AS archiveId,s.import_id AS archiveImportId,s.json AS archiveJson,s.source_id AS sourceId
    FROM json_each(?) AS selected
    JOIN source_records AS s ON s.product='jira' AND s.source_instance=? AND s.kind='history' AND s.source_id=+selected.value
    JOIN worklogs AS w ON json_extract(w.json,'$.sourceRecordId')=s.id AND w.issue_id=s.owner_id
    JOIN issues AS i ON i.id=w.issue_id AND i.project_id=w.project_id
    WHERE s.owner_type='issue' AND w.project_id=? ORDER BY s.source_id,w.id`);
  const revisions = store.db.prepare(`SELECT id,import_id AS importId,json FROM source_records WHERE product='jira' AND source_instance=?
    AND kind='history' AND source_id=? AND json_type(json,'$.jiraWorklogCorrection') IS NOT NULL`);
  const receipts = new Map<string, SourceImport | undefined>();
  const receipt = (id: string) => {
    if (!receipts.has(id)) receipts.set(id, store.get<SourceImport>('source_imports', id));
    return receipts.get(id);
  };
  const candidates = new Map<string, MigrationJiraWorklogCandidate>();
  const ambiguous = new Set<string>();
  for (const row of read.iterate(JSON.stringify([...new Set(selectedIds)]), instanceKey, projectId) as unknown as Iterable<DatabaseRow>) {
    if (ambiguous.has(row.sourceId)) continue;
    if (candidates.has(row.sourceId)) {
      candidates.delete(row.sourceId);
      ambiguous.add(row.sourceId);
      continue;
    }
    const original = JSON.parse(row.archiveJson) as SourceRecordArchive;
    const worklog = JSON.parse(row.worklogJson) as CandidateRecord;
    if (original.id !== row.archiveId || original.sourceImportId !== row.archiveImportId || original.source?.instanceKey !== instanceKey ||
        original.record?.sourceId !== row.sourceId || original.targetProjectId !== projectId || original.excluded ||
        worklog.id !== row.id || worklog.issueId !== row.issueId || worklog.projectId !== row.projectId || worklog.authorId !== row.authorId ||
        worklog.sourceRecordId !== row.archiveId || worklog.workDate !== row.workDate || worklog.deletedAt !== row.deletedAt ||
        !isCalendarDate(worklog.workDate) || typeof worklog.note !== 'string' || !Number.isSafeInteger(worklog.version) || worklog.version < 1 ||
        !Number.isSafeInteger(worklog.durationSeconds) || worklog.durationSeconds < 1 || worklog.minutes !== worklog.durationSeconds / 60 ||
        !sourceIsOwnedWorklog(original, worklog)) continue;
    const previousRecordId = worklog.jiraCorrectionRecordId ?? original.id;
    const revisionRows = revisions.all(instanceKey, row.sourceId);
    const records = revisionRows.flatMap(record => {
      const archive = typeof record.json === 'string' ? JSON.parse(record.json) as SourceRecordArchive : null;
      return archive && archive.id === record.id && archive.sourceImportId === record.importId ? [archive] : [];
    });
    const { id, issueId, authorId, workDate, note, version, durationSeconds, deletedAt } = worklog;
    candidates.set(row.sourceId, { sourceId: row.sourceId, originalRecordId: original.id, previousRecordId,
      current: { id, issueId, projectId, authorId, workDate, note, version, durationSeconds, deletedAt },
      previous: records.length === revisionRows.length ? chainBaseline(original, worklog, records, receipt) : null,
    });
  }
  return [...candidates.values()];
}
