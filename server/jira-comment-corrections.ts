import { createHash } from 'node:crypto';
import type { Comment, LegacyRecord, SourceImport, SourceRecordArchive } from '../shared/types.js';
import type { MigrationJiraCommentCandidate } from './migration-contracts.js';
import { convertLegacyContent } from './migration-content.js';
import { isRestrictedJiraHistory, isRestrictedJiraHistoryOwner, jiraHistoryOwnerAliases, jiraHistorySourceKey } from './migration-jira-history.js';
import { migrationOptionId } from './migration-option-id.js';
import { jiraHistoryReceiptPackage, jiraWorklogSourceUpdatedAt as jiraCommentSourceUpdatedAt } from './jira-worklog-corrections.js';
import type { Store } from './store.js';

export { jiraCommentSourceUpdatedAt };

type Baseline = NonNullable<MigrationJiraCommentCandidate['previous']>;
type Correction = NonNullable<SourceRecordArchive['jiraCommentCorrection']>;
type CommentAnchor = Pick<Comment, 'id' | 'resourceType' | 'resourceId' | 'authorId' | 'createdAt'>;
type ReceiptReader = (id: string) => SourceImport | undefined;
type OwnerReader = (instanceKey: string, issueId: string) => readonly SourceRecordArchive[];
type ArchivedVersion = { archive: SourceRecordArchive; baseline: Baseline };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const distinctOrigin = (archive: SourceRecordArchive) => JSON.stringify([archive.source.instanceKey, archive.record.sourceId]);

export function jiraCommentBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function projectBody(record: LegacyRecord, preserveCommentWebLinks: boolean): string | undefined {
  if (!['plain', 'jira-wiki', 'adf'].includes(record.textFormat)) return;
  const rendered = preserveCommentWebLinks && record.textFormat === 'plain' && record.metadata.bodyFormat === 'search-rendered-html' &&
    /<a(?=\s)[^<>]*?\shref\s*=/iu.test(record.text);
  if (rendered && record.text.replace(/\r\n?/gu, '\n').length > 20_000) return;
  const source = rendered ? { ...record, textFormat: 'confluence-storage' as const } : record;
  let usesCurrentReferences = false;
  const projected = convertLegacyContent(source, { legacyAnnotations: true, preserveCommentWebLinks, resolveReference: () => {
    usesCurrentReferences = true;
    return null;
  } });
  if (usesCurrentReferences || projected.diagnostics.length || !projected.plainText.trim() || projected.plainText.length > 20_000) return;
  return projected.plainText;
}

export function jiraCommentProjectedBody(record: LegacyRecord): string | undefined {
  return projectBody(record, true);
}

export function isJiraCommentCorrection(value: unknown): value is Correction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { commentId, originalRecordId, previousRecordId, bodySha256, editVersion, confirmed } = value as Partial<Correction>;
  return Object.keys(value).length === 5 + Number(Object.hasOwn(value, 'confirmed')) &&
    typeof commentId === 'string' && uuid.test(commentId) &&
    typeof originalRecordId === 'string' && uuid.test(originalRecordId) &&
    typeof previousRecordId === 'string' && uuid.test(previousRecordId) &&
    typeof bodySha256 === 'string' && sha256.test(bodySha256) &&
    typeof editVersion === 'number' && Number.isSafeInteger(editVersion) && editVersion >= 0 &&
    (!Object.hasOwn(value, 'confirmed') || confirmed === true);
}

function archiveMatchesComment(archive: SourceRecordArchive, comment: CommentAnchor): boolean {
  return comment.resourceType === 'issue' && archive.source?.product === 'jira' &&
    Boolean(archive.record?.metadata) && jiraHistorySourceKey(archive.record)?.kind === 'comment' &&
    jiraHistoryOwnerAliases(archive.record) !== null && !isRestrictedJiraHistory(archive.record) &&
    archive.ownerType === 'issue' && archive.ownerId === comment.resourceId && !archive.excluded;
}

function mappedAuthor(archive: SourceRecordArchive, receipt: SourceImport, stagingId: string): string | undefined {
  const identity = archive.record.authorId;
  if (!identity) return;
  const mapped = receipt.configuration.users?.[migrationOptionId(stagingId, 'identity', identity)];
  return typeof mapped === 'string' && mapped ? mapped : undefined;
}

function sourceCreatedAt(archive: SourceRecordArchive, receipt: SourceImport): string | null {
  return jiraCommentSourceUpdatedAt({ ...archive.record, updatedAt: archive.record.createdAt }, receipt.configuration.timezone);
}

function originalAnchor(archive: SourceRecordArchive, receipt: SourceImport | undefined): CommentAnchor | null {
  if (!receipt || archive.targetType !== 'comment' || !archive.targetId || !archive.ownerId || archive.jiraCommentCorrection) return null;
  const pkg = jiraHistoryReceiptPackage(archive, receipt);
  const authorId = pkg && mappedAuthor(archive, receipt, pkg.stagingId);
  const createdAt = pkg && sourceCreatedAt(archive, receipt);
  if (!authorId || !createdAt) return null;
  const anchor: CommentAnchor = { id: archive.targetId, resourceType: 'issue', resourceId: archive.ownerId, authorId, createdAt };
  const evidence = archive.authorAttribution;
  if (!archiveMatchesComment(archive, anchor) || evidence && (evidence.kind !== 'comment' || evidence.disposition !== 'mapped' ||
      evidence.targetId !== anchor.id || evidence.expectedAuthorId !== anchor.authorId)) return null;
  return anchor;
}

function originalBaseline(archive: SourceRecordArchive, receipt: SourceImport, anchor: CommentAnchor,
  preserveCommentWebLinks = true): Baseline | null {
  const updatedAt = jiraCommentSourceUpdatedAt(archive.record, receipt.configuration.timezone);
  const body = projectBody(archive.record, preserveCommentWebLinks);
  return updatedAt && updatedAt >= anchor.createdAt && body !== undefined
    ? { updatedAt, bodySha256: jiraCommentBodyHash(body), editVersion: 0 } : null;
}

function ownerMatches(archive: SourceRecordArchive, receipt: SourceImport, reads: ReceiptReader, owners: OwnerReader): boolean {
  const aliases = jiraHistoryOwnerAliases(archive.record);
  if (!aliases || !archive.ownerId || !archive.targetProjectId) return false;
  const known = new Set<string>();
  for (const owner of owners(archive.source.instanceKey, archive.ownerId)) {
    if (owner.record.kind !== 'issue' || owner.ownerType !== 'issue' || owner.ownerId !== archive.ownerId ||
        owner.targetType !== 'issue' || owner.targetId !== archive.ownerId || owner.targetProjectId !== archive.targetProjectId ||
        isRestrictedJiraHistoryOwner(owner.record) || !owner.record.containerId) continue;
    const prior = reads(owner.sourceImportId);
    if (!prior || prior.createdAt > receipt.createdAt || !jiraHistoryReceiptPackage(owner, prior)) continue;
    known.add(owner.record.sourceId);
    if (typeof owner.record.metadata.key === 'string') known.add(owner.record.metadata.key);
  }
  return aliases.every(alias => known.has(alias));
}

export function jiraCommentCorrectionBaseline(source: SourceRecordArchive, receipt: SourceImport, original: SourceRecordArchive,
  previous: SourceRecordArchive, previousReceipt: SourceImport | undefined, prior: Baseline, current: CommentAnchor): Baseline | null {
  const marker = source.jiraCommentCorrection;
  if (!isJiraCommentCorrection(marker) || marker.commentId !== current.id || marker.originalRecordId !== original.id ||
      marker.previousRecordId !== previous.id || source.id === original.id || source.id === previous.id ||
      source.jiraHistoryAppend || source.authorAttribution || source.targetType !== null || source.targetId !== null ||
      !archiveMatchesComment(source, current) || distinctOrigin(source) !== distinctOrigin(original) ||
      source.targetProjectId !== original.targetProjectId || !previousReceipt || previousReceipt.id === receipt.id ||
      previousReceipt.createdAt > receipt.createdAt || receipt.configuration.appendTo?.refreshComments !== true ||
      receipt.configuration.appendTo.projectId !== source.targetProjectId) return null;
  const pkg = jiraHistoryReceiptPackage(source, receipt);
  if (!pkg || mappedAuthor(source, receipt, pkg.stagingId) !== current.authorId ||
      sourceCreatedAt(source, receipt) !== current.createdAt) return null;
  const updatedAt = jiraCommentSourceUpdatedAt(source.record, receipt.configuration.timezone);
  const body = jiraCommentProjectedBody(source.record);
  if (!updatedAt || updatedAt <= prior.updatedAt || body === undefined) return null;
  const bodySha256 = jiraCommentBodyHash(body);
  const confirmed = prior.bodySha256 === bodySha256;
  return marker.bodySha256 === bodySha256 && (marker.confirmed === true) === confirmed &&
    marker.editVersion === prior.editVersion + Number(!confirmed) ? { updatedAt, bodySha256, editVersion: marker.editVersion } : null;
}

function commentMatchesAnchor(comment: Comment, anchor: CommentAnchor): boolean {
  return comment.id === anchor.id && comment.resourceType === anchor.resourceType && comment.resourceId === anchor.resourceId &&
    comment.authorId === anchor.authorId && comment.createdAt === anchor.createdAt;
}

function chainHead(original: SourceRecordArchive, records: readonly SourceRecordArchive[], readReceipt: ReceiptReader,
  readOwner: OwnerReader, current?: Comment): ArchivedVersion | null {
  const originalReceipt = readReceipt(original.sourceImportId);
  const anchor = originalAnchor(original, originalReceipt);
  if (!originalReceipt || !anchor || current && !commentMatchesAnchor(current, anchor) ||
      !ownerMatches(original, originalReceipt, readReceipt, readOwner)) return null;
  let baseline = originalBaseline(original, originalReceipt, anchor);
  if (!records.length && current && (current.editVersion ?? 0) === 0 && !current.mentions?.length) {
    const currentHash = jiraCommentBodyHash(current.body);
    if (baseline?.bodySha256 !== currentHash) {
      const former = originalBaseline(original, originalReceipt, anchor, false);
      if (former?.bodySha256 === currentHash) baseline = former;
    }
  }
  const nextRecords = new Map<string, SourceRecordArchive>();
  for (const archive of records) {
    const marker = archive.jiraCommentCorrection;
    if (!isJiraCommentCorrection(marker) || nextRecords.has(marker.previousRecordId)) return null;
    nextRecords.set(marker.previousRecordId, archive);
  }
  let previous = original;
  let previousReceipt = originalReceipt;
  for (let remaining = records.length; remaining > 0; remaining--) {
    const next = nextRecords.get(previous.id);
    const receipt = next && readReceipt(next.sourceImportId);
    if (!next || !receipt) return null;
    baseline = baseline && jiraCommentCorrectionBaseline(next, receipt, original, previous, previousReceipt, baseline, anchor);
    if (!baseline && previous === original) {
      // A first correction can come from a comment imported before links were materialized.
      const former = originalBaseline(original, originalReceipt, anchor, false);
      baseline = former && jiraCommentCorrectionBaseline(next, receipt, original, previous, previousReceipt, former, anchor);
    }
    if (!baseline) return null;
    // Each correction's aliases are independently proven on application and restore.
    previous = next;
    previousReceipt = receipt;
  }
  if (!baseline) return null;
  if (current) {
    const version = current.editVersion ?? 0;
    if (current.jiraCorrectionRecordId !== (records.length ? previous.id : undefined) ||
        !Number.isSafeInteger(version) || version < baseline.editVersion ||
        records.length && version === baseline.editVersion &&
          (jiraCommentBodyHash(current.body) !== baseline.bodySha256 || current.mentions?.length)) return null;
  }
  return { archive: previous, baseline };
}

export function validRestoredJiraCommentCorrections(comments: readonly Comment[],
  sources: ReadonlyMap<string, SourceRecordArchive>, imports: readonly SourceImport[]): boolean {
  const correctionsByComment = new Map<string, SourceRecordArchive[]>();
  const originalByComment = new Map<string, SourceRecordArchive[]>();
  const originalBySource = new Map<string, SourceRecordArchive[]>();
  const issueOwners = new Map<string, SourceRecordArchive[]>();
  const add = (index: Map<string, SourceRecordArchive[]>, key: string, archive: SourceRecordArchive) => {
    const matches = index.get(key) ?? [];
    matches.push(archive);
    index.set(key, matches);
  };
  for (const archive of sources.values()) {
    if (Object.hasOwn(archive, 'jiraCommentCorrection')) {
      if (!isJiraCommentCorrection(archive.jiraCommentCorrection)) return false;
      add(correctionsByComment, archive.jiraCommentCorrection.commentId, archive);
    } else if (archive.targetType === 'comment' && archive.targetId) {
      add(originalByComment, archive.targetId, archive);
      if (archive.source.product === 'jira') add(originalBySource, distinctOrigin(archive), archive);
    } else if (archive.source.product === 'jira' && archive.targetType === 'issue' && archive.targetId) {
      add(issueOwners, JSON.stringify([archive.source.instanceKey, archive.targetId]), archive);
    }
  }
  const currentById = new Map<string, Comment>();
  for (const comment of comments) {
    if (!correctionsByComment.has(comment.id) && !Object.hasOwn(comment, 'jiraCorrectionRecordId')) continue;
    if (currentById.has(comment.id) || !correctionsByComment.has(comment.id) || !uuid.test(comment.jiraCorrectionRecordId ?? '')) return false;
    currentById.set(comment.id, comment);
  }
  const receipts = new Map(imports.map(receipt => [receipt.id, receipt]));
  for (const [commentId, versions] of correctionsByComment) {
    const original = originalByComment.get(commentId);
    if (original?.length !== 1 || originalBySource.get(distinctOrigin(original[0]))?.length !== 1 ||
        !chainHead(original[0], versions, id => receipts.get(id), (instanceKey, issueId) =>
          issueOwners.get(JSON.stringify([instanceKey, issueId])) ?? [], currentById.get(commentId))) return false;
  }
  return true;
}

function storedReaders(store: Store) {
  const owners = store.db.prepare(`SELECT json FROM source_records WHERE product='jira' AND source_instance=?
    AND kind='issue' AND target_type='issue' AND target_id=?`);
  const corrections = store.db.prepare(`SELECT json FROM source_records WHERE product='jira' AND source_instance=?
    AND kind='comment' AND source_id=? AND json_type(json,'$.jiraCommentCorrection') IS NOT NULL`);
  const receipts = new Map<string, SourceImport | undefined>();
  return {
    receipt(id: string) {
      if (!receipts.has(id)) receipts.set(id, store.get<SourceImport>('source_imports', id));
      return receipts.get(id);
    },
    owners(instanceKey: string, issueId: string) {
      return owners.all(instanceKey, issueId).map(row => JSON.parse(String(row.json)) as SourceRecordArchive);
    },
    corrections(instanceKey: string, sourceId: string) {
      return corrections.all(instanceKey, sourceId).map(row => JSON.parse(String(row.json)) as SourceRecordArchive);
    },
  };
}

export function latestVerifiedJiraCommentSource(store: Store, original: SourceRecordArchive, current: Comment): LegacyRecord | null {
  if (!current.jiraCorrectionRecordId) return original.record;
  const reads = storedReaders(store);
  const chain = chainHead(original, reads.corrections(original.source.instanceKey, original.record.sourceId), reads.receipt, reads.owners, current);
  return chain?.archive.record ?? null;
}

export function readJiraCommentCorrectionCandidates(store: Store, instanceKey: string, selectedIds: readonly string[],
  projectId: string): MigrationJiraCommentCandidate[] {
  if (!selectedIds.length) return [];
  const rows = store.db.prepare(`SELECT s.id AS archiveId,s.source_id AS sourceId,s.import_id AS importId,s.json AS archiveJson,
    c.id AS commentId,c.json AS commentJson,i.id AS issueId FROM json_each(?) AS selected
    JOIN source_records AS s ON s.product='jira' AND s.source_instance=? AND s.kind='comment'
      AND s.source_id=+selected.value AND s.target_type='comment'
    JOIN comments AS c ON c.id=s.target_id AND c.resource_id=s.owner_id AND c.resource_type='issue'
    JOIN issues AS i ON i.id=c.resource_id AND i.project_id=?
    WHERE s.owner_type='issue' AND NOT EXISTS (SELECT 1 FROM source_records AS duplicate WHERE duplicate.id<>s.id
      AND duplicate.target_type='comment' AND (duplicate.target_id=s.target_id OR (duplicate.product=s.product
        AND duplicate.source_instance=s.source_instance AND duplicate.kind=s.kind AND duplicate.source_id=s.source_id)))`);
  const reads = storedReaders(store);
  const result: MigrationJiraCommentCandidate[] = [];
  for (const row of rows.iterate(JSON.stringify([...new Set(selectedIds)]), instanceKey, projectId)) {
    const original = JSON.parse(String(row.archiveJson)) as SourceRecordArchive;
    const current = JSON.parse(String(row.commentJson)) as Comment;
    if (original.id !== row.archiveId || original.sourceImportId !== row.importId || original.source?.instanceKey !== instanceKey ||
        original.record?.sourceId !== row.sourceId || original.targetProjectId !== projectId || original.targetId !== row.commentId ||
        current.id !== row.commentId || current.resourceId !== row.issueId || !archiveMatchesComment(original, current)) continue;
    const versions = reads.corrections(instanceKey, original.record.sourceId);
    const chain = chainHead(original, versions, reads.receipt, reads.owners, current);
    result.push({ sourceId: original.record.sourceId, originalRecordId: original.id,
      previousRecordId: current.jiraCorrectionRecordId ?? original.id, current: { ...current, projectId }, previous: chain?.baseline ?? null });
  }
  return result;
}
