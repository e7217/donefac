import { createHash, type Hash } from 'node:crypto';
import { constants, statSync } from 'node:fs';
import fileSystem from 'node:fs/promises';
import type { Express } from 'express';
import { MIGRATION_AUTHOR_KINDS, MIGRATION_AUTHOR_STATUSES } from '../shared/types.js';
import type {
  Attachment, AttachmentVersion, LegacyRecordKind, SourceImport, SourceReconciliationAudit, SourceReconciliationAuditAttachment, SourceReconciliationAuthorFindingsPage,
  SourceReconciliationAuditStatus, SourceReconciliationFileCheck, SourceReconciliationIntegrity, SourceReconciliationIntegrityPackage,
  SourceReconciliationJiraFinding, SourceReconciliationJiraRelationFinding, SourceReconciliationJiraRelationFindingsPage,
  SourceReconciliationJiraStatusFindingsPage, SourceReconciliationOwner,
  SourceReconciliationPage, SourceReconciliationPrimaryRecords, SourceReconciliationRow, SourceReconciliationStatus,
  SourceReconciliationResourceLinkFinding, SourceReconciliationResourceLinkFindingsPage, SourceReconciliationTarget, SourceReconciliationTargetContent,
} from '../shared/types.js';
import { MAX_FILE_BYTES, type AttachmentFiles } from './attachments.js';
import { auditJiraStatusHistory, jiraStatusHistoryFindings } from './jira-status-history.js';
import { auditSourceAuthors } from './migration-author-audit.js';
import { auditJiraRelationProjections } from './migration-jira-relation-audit.js';
import { auditResourceLinkProjections } from './migration-resource-link-audit.js';
import { isLegacyRecordKind, SourcePreservationError, type SourcePreservationService } from './source-preservation.js';
import type { Store } from './store.js';
import type { TrashArchive, TrashService } from './trash.js';

type TargetType = SourceReconciliationTarget['type'];
type SourceIdentity = Pick<SourceReconciliationRow, 'sourceRecordId' | 'kind' | 'sourceId' | 'sourceKey' | 'title' | 'product' | 'sourceInstance'>;
type MatchRow = SourceIdentity & {
  originalRecordId: string; packageSha256: string; excluded: number | null;
  invalidSourceIdBinding: number; invalidJiraKeyBinding: number;
  targetType: TargetType | null; targetId: string | null;
  targetLabel: string | null; targetProjectId: string | null; linked: number;
  ownerType: SourceReconciliationOwner['type'] | null; ownerId: string | null;
  ownerLabel: string | null; ownerProjectId: string | null;
  trashId: string | null; trashTitle: string | null; trashIssueKey: string | null; trashProjectId: string | null;
  individualTrashId: string | null; individualTrashLabel: string | null;
};
type AuditMatchRow = MatchRow & {
  originalSize: string | number | null; originalSha: string | null; size: number | null; sha: string | null;
  originalOwnerId: string | null; originalOwnerType: SourceReconciliationOwner['type'] | null;
  ownerVersion: number | null; targetVersion: number | null; targetUpdatedAt: string | null;
  fileOwnerId: string | null; fileOwnerType: SourceReconciliationOwner['type'] | null;
};
type AuditTargetProjection = { auditRowOrder: number; targetPayload: string | null; targetColumns: string | null };
type ContentFingerprint = { count: number; hash: Hash };
type PrimaryRecordFingerprint = Pick<SourceReconciliationPrimaryRecords, 'kind' | 'counts' | 'invalidTargets'> & { hash: Hash };
type FileMetadata = Pick<Attachment, 'size' | 'sha256' | 'resourceId' | 'resourceType'>;
type AuditEntry = Omit<SourceReconciliationAuditAttachment, 'status'> & { status: SourceReconciliationAuditStatus | null };
type ReceiptPackage = SourceImport['packages'][number];
type ReceiptQuery = { offset: number; limit: number; kind?: LegacyRecordKind; status?: SourceReconciliationStatus; q: string;
  packageId?: string; finding?: 'invalid-primary-target' };
type Dependencies = { store: Store; files: AttachmentFiles; preservation: SourcePreservationService; trash: TrashService };
const statuses: readonly SourceReconciliationStatus[] = ['linked', 'trashed', 'missing', 'archive-only', 'excluded'];
const receiptKeys = new Set(['q', 'kind', 'status', 'offset', 'limit', 'packageId', 'finding']);
const jiraFindings: readonly SourceReconciliationJiraFinding[] = ['unavailable', 'restricted', 'excluded', 'unresolved-time', 'unresolved-author'];
const jiraFindingKeys = new Set(['expectedVersion', 'finding', 'offset', 'limit', 'expectedFingerprint']);
const jiraRelationFindings: readonly SourceReconciliationJiraRelationFinding[] = ['missing', 'mismatch', 'unavailable'];
const resourceLinkFindings: readonly SourceReconciliationResourceLinkFinding[] = ['missing', 'mismatch', 'unavailable'];
const projectionFindingKeys = new Set(['expectedVersion', 'expectedSha256', 'finding', 'offset', 'limit']);
const authorFindingKeys = new Set(['expectedVersion', 'packageId', 'kind', 'status', 'offset', 'limit', 'expectedFingerprint']);
const casefold = (value: string) => value.normalize('NFC').toLocaleLowerCase('ko-KR');

function failure(status: number, message: string): never { throw new SourcePreservationError(status, message); }

function pageInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
    return failure(400, '이관 대조 페이지 범위를 확인해 주세요.');
  }
  return Number(value);
}

function parseQuery(input: Record<string, unknown>): ReceiptQuery {
  if (Object.keys(input).some(key => !receiptKeys.has(key))) failure(400, '지원하지 않는 이관 대조 조회 조건입니다.');
  const { kind, status, packageId, finding } = input;
  if (kind !== undefined && !isLegacyRecordKind(kind)) failure(400, '이관 대조 객체 종류를 확인해 주세요.');
  if (status !== undefined && (typeof status !== 'string' || !statuses.includes(status as SourceReconciliationStatus))) {
    failure(400, '이관 대조 상태를 확인해 주세요.');
  }
  if (packageId !== undefined && (typeof packageId !== 'string' || !packageId.trim() || packageId.length > 200 || /[\x00-\x1f\x7f]/u.test(packageId))) {
    failure(400, '이관 대조 원본 패키지 ID를 확인해 주세요.');
  }
  if (finding !== undefined && (finding !== 'invalid-primary-target' || packageId === undefined)) {
    failure(400, '원본 패키지와 대상 연결 확인 조건을 확인해 주세요.');
  }
  const q = input.q === undefined ? '' : input.q;
  if (typeof q !== 'string' || q.length > 300 || [...q].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    failure(400, '이관 대조 검색어를 확인해 주세요.');
  }
  return { kind, status: status as ReceiptQuery['status'], packageId, finding, offset: pageInteger(input.offset, 0, 0, 1_000_000),
    limit: pageInteger(input.limit, 30, 1, 100), q: casefold(q.trim()) };
}

// The whole-receipt audit reads migrated target payloads for hashing only. Original bodies and file bytes aren't projected.
const attachmentJson = 'coalesce(av.json,a.json,CASE WHEN archived_attachment.id IS NOT NULL THEN archived_file.json END)';
const auditProjection = `
    r.rowid AS auditRowOrder,
    CASE WHEN r.kind='attachment' THEN coalesce(json_extract(r.json,'$.record.metadata.actualSize'),json_extract(r.json,'$.record.metadata.size')) END AS originalSize,
    CASE WHEN r.kind='attachment' THEN json_extract(r.json,'$.record.metadata.sha256') END AS originalSha,
    json_extract(${attachmentJson},'$.size') AS size,
    json_extract(${attachmentJson},'$.sha256') AS sha,
    json_extract(${attachmentJson},'$.resourceId') AS fileOwnerId,
    json_extract(${attachmentJson},'$.resourceType') AS fileOwnerType,
    r.owner_id AS originalOwnerId, r.owner_type AS originalOwnerType,
    coalesce(json_extract(i.json,'$.version'),json_extract(d.json,'$.version')) AS ownerVersion,
    coalesce(json_extract(v.json,'$.version'),json_extract(w.json,'$.version')) AS targetVersion,
    coalesce(json_extract(c.json,'$.updatedAt'),json_extract(p.json,'$.updatedAt')) AS targetUpdatedAt,
    coalesce(c.json,archived_comment.json,v.json,w.json) AS targetPayload,
    CASE WHEN c.id IS NOT NULL THEN json_array('live',c.resource_type,c.resource_id,c.author_id)
      WHEN archived_comment.id IS NOT NULL THEN json_array('individual-archive',archived_comment.id,archived_comment.owner_type,archived_comment.owner_id,archived_comment.deleted_at)
      WHEN v.id IS NOT NULL THEN json_array('live',v.document_id)
      WHEN w.id IS NOT NULL THEN json_array('worklogs',w.issue_id,w.project_id,w.author_id,w.work_date,w.created_at,w.minutes,w.deleted_at)
    END AS targetColumns,`;
const packagePredicate = `AND r.product=? AND r.source_instance=?
    AND CASE WHEN json_valid(r.json) THEN json_extract(r.json,'$.packageSha256') END=?`;

function intactPrimaryRecord(record: 'r' | 'proof') {
  return `(CASE WHEN json_valid(${record}.json) THEN
    json_type(${record}.json,'$.excluded') IS NOT 'true'
    AND json_extract(${record}.json,'$.sourceImportId')=${record}.import_id
    AND json_extract(${record}.json,'$.source.product')=${record}.product
    AND json_extract(${record}.json,'$.source.instanceKey')=${record}.source_instance
    AND json_extract(${record}.json,'$.record.kind')=${record}.kind
    AND json_extract(${record}.json,'$.record.sourceId')=${record}.source_id
    AND json_extract(${record}.json,'$.targetType')=${record}.target_type
    AND json_extract(${record}.json,'$.targetId')=${record}.target_id
    AND json_extract(${record}.json,'$.ownerType')=${record}.owner_type
    AND json_extract(${record}.json,'$.ownerId')=${record}.owner_id
  END)`;
}

// Attribute alias failures only where the receipt still proves its indexed primary record.
const primaryBindingTarget = `r.target_id IS NOT NULL AND (
  (r.product='jira' AND r.kind='issue' AND r.target_type='issue') OR
  (r.product='confluence' AND r.kind='page' AND r.target_type='document')) AND ${intactPrimaryRecord('r')}`;

function archivedJiraKey(record: 'r' | 'proof') {
  return `CASE WHEN ${record}.product='jira' AND ${record}.kind='issue' AND json_valid(${record}.json) THEN
    CASE WHEN json_type(${record}.json,'$.record.metadata.key')='text'
      THEN nullif(json_extract(${record}.json,'$.record.metadata.key'),'') END END`;
}

// A later import can reuse an alias established by an earlier receipt. Check that the receipt named by
// the index can prove that alias for the same target, including a Jira key used as a CSV source ID.
function primaryBindingExists(alias: string) {
  return `EXISTS (
    SELECT 1 FROM source_bindings AS binding
    WHERE binding.product=r.product AND binding.source_instance=r.source_instance AND binding.kind=r.kind
      AND binding.source_alias=${alias} AND binding.target_type=r.target_type AND binding.target_id=r.target_id
      AND ((binding.import_id=r.import_id AND r.owner_type=r.target_type AND r.owner_id=r.target_id) OR EXISTS (
        SELECT 1 FROM source_records AS proof INDEXED BY source_records_target
        WHERE proof.target_type=binding.target_type AND proof.target_id=binding.target_id
          AND proof.import_id=binding.import_id AND proof.product=binding.product
          AND proof.source_instance=binding.source_instance AND proof.kind=binding.kind
          AND proof.owner_type=proof.target_type AND proof.owner_id=proof.target_id
          AND ${intactPrimaryRecord('proof')}
          AND (proof.source_id=binding.source_alias OR (${archivedJiraKey('proof')})=binding.source_alias)
      ))
  )`;
}

const jiraBindingKey = archivedJiraKey('r');
const primaryBindingsProjection = `
    CASE WHEN ${primaryBindingTarget} THEN NOT ${primaryBindingExists('r.source_id')} ELSE 0 END AS invalidSourceIdBinding,
    CASE WHEN ${primaryBindingTarget} AND (${jiraBindingKey})<>r.source_id
      THEN NOT ${primaryBindingExists(`(${jiraBindingKey})`)} ELSE 0 END AS invalidJiraKeyBinding,`;

const rowsSql = (audit: boolean, scoped = false) => `
  SELECT r.id AS sourceRecordId, r.kind, r.source_id AS sourceId, r.product, r.source_instance AS sourceInstance,
    ${audit ? auditProjection : ''}
    ${primaryBindingsProjection}
    json_extract(r.json,'$.record.id') AS originalRecordId, json_extract(r.json,'$.packageSha256') AS packageSha256,
    json_type(r.json,'$.excluded')='true' AS excluded,
    coalesce(json_extract(r.json,'$.record.title'),'') AS title,
    CASE WHEN r.product='jira' THEN coalesce(
      CASE WHEN json_type(r.json,'$.record.metadata.key')='text' THEN nullif(json_extract(r.json,'$.record.metadata.key'),'') END,
      CASE WHEN json_type(r.json,'$.record.metadata.pkey')='text' THEN nullif(json_extract(r.json,'$.record.metadata.pkey'),'') END
    ) END AS sourceKey,
    coalesce(r.target_type,CASE WHEN w.id IS NOT NULL THEN 'worklog' END) AS targetType,
    coalesce(r.target_id,w.id) AS targetId,
    CASE r.target_type
      WHEN 'project' THEN p.id IS NOT NULL WHEN 'issue' THEN i.id IS NOT NULL WHEN 'document' THEN d.id IS NOT NULL
      WHEN 'comment' THEN c.id IS NOT NULL WHEN 'revision' THEN v.id IS NOT NULL
      WHEN 'attachment' THEN av.id IS NOT NULL OR a.id IS NOT NULL ELSE w.id IS NOT NULL AND w.deleted_at IS NULL
    END AS linked,
    CASE r.target_type
      WHEN 'project' THEN p.key || ' · ' || json_extract(p.json,'$.name')
      WHEN 'issue' THEN json_extract(i.json,'$.key') || ' · ' || json_extract(i.json,'$.title')
      WHEN 'document' THEN json_extract(d.json,'$.title')
      WHEN 'comment' THEN CASE WHEN c.id IS NOT NULL THEN '댓글' END
      WHEN 'revision' THEN '버전 ' || json_extract(v.json,'$.version')
      WHEN 'attachment' THEN coalesce(json_extract(av.json,'$.filename') || ' · ' || json_extract(av.json,'$.versionLabel'),json_extract(a.json,'$.filename'))
      ELSE '작업 시간 · ' || w.work_date
    END AS targetLabel,
    CASE WHEN r.target_type='project' THEN r.target_id WHEN i.id IS NOT NULL THEN i.project_id WHEN d.id IS NOT NULL THEN d.project_id
      WHEN w.id IS NOT NULL THEN w.project_id ELSE json_extract(r.json,'$.targetProjectId') END AS targetProjectId,
    CASE WHEN i.id IS NOT NULL THEN 'issue' WHEN d.id IS NOT NULL THEN 'document' END AS ownerType,
    coalesce(i.id,d.id) AS ownerId,
    coalesce(json_extract(i.json,'$.key') || ' · ' || json_extract(i.json,'$.title'),json_extract(d.json,'$.title')) AS ownerLabel,
    coalesce(i.project_id,d.project_id) AS ownerProjectId,
    t.id AS trashId, json_extract(t.summary,'$.title') AS trashTitle, json_extract(t.summary,'$.issueKey') AS trashIssueKey,
    t.project_id AS trashProjectId,
    coalesce(archived_comment.id,archived_attachment.id) AS individualTrashId,
    CASE WHEN archived_comment.id IS NOT NULL THEN '댓글'
      WHEN archived_attachment.id IS NOT NULL THEN coalesce(
        json_extract(archived_file.json,'$.filename') || ' · ' || json_extract(archived_file.json,'$.versionLabel'),
        json_extract(archived_file.json,'$.filename')) END AS individualTrashLabel
  FROM source_records r
  LEFT JOIN projects p ON r.target_type='project' AND p.id=r.target_id
  -- Unary + removes the column's TEXT affinity so SQLite can seek the expression index.
  LEFT JOIN worklogs w ON r.target_type IS NULL AND json_extract(w.json,'$.sourceRecordId')=+r.id
  LEFT JOIN issues i ON i.id=CASE WHEN r.target_type='issue' THEN r.target_id WHEN w.id IS NOT NULL THEN w.issue_id WHEN r.owner_type='issue' THEN r.owner_id END
  LEFT JOIN documents d ON d.id=CASE WHEN r.target_type='document' THEN r.target_id WHEN r.owner_type='document' THEN r.owner_id END
  LEFT JOIN comments c ON r.target_type='comment' AND c.id=r.target_id
  LEFT JOIN revisions v ON r.target_type='revision' AND v.id=r.target_id
  LEFT JOIN attachment_versions av ON r.target_type='attachment' AND av.id=r.target_id
  LEFT JOIN attachments a ON r.target_type='attachment' AND a.id=r.target_id
  LEFT JOIN trash_items archived_comment ON r.target_type='comment' AND archived_comment.item_type='comment'
    AND archived_comment.item_id=r.target_id AND archived_comment.owner_type=r.owner_type AND archived_comment.owner_id=r.owner_id
  LEFT JOIN trash_item_files archived_file ON r.target_type='attachment' AND archived_file.file_id=r.target_id
  LEFT JOIN trash_items archived_attachment ON archived_attachment.id=archived_file.entry_id AND archived_attachment.item_type='attachment'
    AND archived_attachment.owner_type=r.owner_type AND archived_attachment.owner_id=r.owner_id
  LEFT JOIN trash_entries t ON t.resource_type=CASE WHEN r.target_type IN ('issue','document') THEN r.target_type ELSE r.owner_type END
    AND t.resource_id=CASE WHEN r.target_type IN ('issue','document') THEN r.target_id ELSE r.owner_id END
  WHERE r.import_id=? AND json_valid(r.json) ${scoped ? packagePredicate : ''} ORDER BY ${audit ? 'r.id' : 'r.kind,r.rowid'}`;

function packageIdentity(product: string, instance: string, sha256: string) {
  return JSON.stringify([product, instance, sha256]);
}

function emptyRecordCounts(): SourceReconciliationPage['counts'] {
  return { linked: 0, trashed: 0, missing: 0, 'archive-only': 0, excluded: 0 };
}

function primaryRecordKind(product: ReceiptPackage['source']['product']): SourceReconciliationPrimaryRecords['kind'] {
  return product === 'jira' ? 'issue' : 'page';
}

function invalidPrimaryTarget(row: MatchRow, status: SourceReconciliationStatus): boolean {
  const kind = primaryRecordKind(row.product);
  const targetType = kind === 'issue' ? 'issue' : 'document';
  return row.kind === kind && (row.targetType !== null || row.targetId !== null) &&
    (status === 'excluded' || row.targetType !== targetType || !row.targetId);
}

function invalidPrimaryBinding(row: MatchRow, status: SourceReconciliationStatus): boolean {
  return status !== 'excluded' && (row.invalidSourceIdBinding === 1 || row.invalidJiraKeyBinding === 1);
}

function archiveProjection(archive: TrashArchive, audit: boolean) {
  const labels: Record<string, Map<string, string>> = {
    comment: new Map(archive.comments.map(value => [value.id, '댓글'])),
    revision: new Map(archive.revisions.map(value => [value.id, `버전 ${value.version}`])),
    attachment: new Map(archive.attachments.map(value => [value.id, value.filename])),
  };
  for (const version of archive.attachmentVersions) labels.attachment.set(version.id, `${version.filename} · ${version.versionLabel}`);
  const files = new Map<string, FileMetadata>();
  if (audit) for (const { id, size, sha256, resourceId, resourceType } of [...archive.attachments, ...archive.attachmentVersions]) {
    files.set(id, { size, sha256, resourceId, resourceType });
  }
  const contents = audit ? {
    comment: new Map(archive.comments.map(value => [value.id, contentSha256(JSON.stringify(value))])),
    revision: new Map(archive.revisions.map(value => [value.id, contentSha256(JSON.stringify(value))])),
  } : undefined;
  return { labels, files, contents };
}

function scanReceipt(
  { store, trash }: Dependencies, receipt: SourceImport, audit: boolean,
  visit: (row: MatchRow, status: SourceReconciliationStatus, target: SourceReconciliationTarget | null,
    stagingId?: string, archivedFile?: FileMetadata, archivedContentSha256?: string) => void,
  scopedPackage?: ReceiptPackage,
): SourceReconciliationPage['counts'] {
  const packages = new Map(receipt.packages.map(value => [packageIdentity(value.source.product, value.source.instanceKey, value.sha256), value.stagingId]));
  const excluded = new Set(receipt.configuration.excludedRecords);
  const counts = emptyRecordCounts();
  const trashedChildren = new Map<string, ReturnType<typeof archiveProjection>>();

  function archivedChildren(trashId: string) {
    let children = trashedChildren.get(trashId);
    if (!children) {
      children = archiveProjection(trash.get(trashId), audit);
      if (trashedChildren.size >= 32) trashedChildren.delete(trashedChildren.keys().next().value!);
      trashedChildren.set(trashId, children);
    }
    return children;
  }

  const args = scopedPackage ? [receipt.id, scopedPackage.source.product, scopedPackage.source.instanceKey, scopedPackage.sha256] : [receipt.id];
  for (const raw of store.db.prepare(rowsSql(audit, Boolean(scopedPackage))).iterate(...args)) {
    const row = raw as unknown as MatchRow;
    const stagingId = packages.get(packageIdentity(row.product, row.sourceInstance, row.packageSha256));
    const excludedRecord = row.excluded === 1 || (stagingId && excluded.has(`${stagingId}/${row.originalRecordId}`));
    let status: SourceReconciliationStatus = excludedRecord ? 'excluded' : 'archive-only';
    let target: SourceReconciliationTarget | null = null;
    let archivedFile: FileMetadata | undefined;
    let archivedContentSha256: string | undefined;
    if (status !== 'excluded' && row.targetType && row.targetId) {
      let archived: string | null = null;
      if (!row.linked && row.individualTrashId) {
        archived = row.individualTrashLabel ?? row.targetId;
      } else if (!row.linked && row.trashId) {
        if (row.targetType === 'issue' || row.targetType === 'document') {
          archived = [row.trashIssueKey, row.trashTitle].filter(Boolean).join(' · ') || row.targetId;
        } else if (row.targetType === 'comment' || row.targetType === 'revision' || row.targetType === 'attachment') {
          const children = archivedChildren(row.trashId);
          archived = children.labels[row.targetType].get(row.targetId) ?? null;
          if (row.targetType === 'attachment') archivedFile = children.files.get(row.targetId);
          else archivedContentSha256 = children.contents?.[row.targetType].get(row.targetId);
        }
      }
      status = row.linked ? 'linked' : archived !== null ? 'trashed' : 'missing';
      const owner = row.ownerType && row.ownerId ? {
        type: row.ownerType, id: row.ownerId, label: row.ownerLabel ?? row.ownerId, projectId: row.ownerProjectId,
      } : null;
      target = {
        type: row.targetType, id: row.targetId, label: archived ?? row.targetLabel ?? row.targetId,
        projectId: archived !== null && row.trashId ? row.trashProjectId : row.targetProjectId, owner,
      };
    }
    counts[status]++;
    visit(row, status, target, stagingId, archivedFile, archivedContentSha256);
  }
  return counts;
}

function reconciliation(dependencies: Dependencies, importId: string, query: ReceiptQuery): SourceReconciliationPage {
  const receipt = dependencies.store.get<SourceImport>('source_imports', importId) ?? failure(404, '이관 영수증을 찾을 수 없습니다.');
  const scopedPackage = query.packageId === undefined ? undefined :
    receipt.packages.find(value => value.stagingId === query.packageId) ?? failure(404, '이관 영수증에서 원본 패키지를 찾을 수 없습니다.');
  const rows: SourceReconciliationRow[] = [];
  let total = 0;
  const counts = scanReceipt(dependencies, receipt, false, (row, status, target, stagingId) => {
    if ((query.status && status !== query.status) || (query.kind && row.kind !== query.kind)) return;
    const invalidTarget = Boolean(stagingId) && invalidPrimaryTarget(row, status);
    const invalidBinding = Boolean(stagingId) && invalidPrimaryBinding(row, status);
    if (query.finding && !invalidTarget && !invalidBinding) return;
    if (query.q && ![row.sourceId, row.sourceKey, row.title, row.sourceInstance, target?.label, target?.owner?.label]
      .some(value => value && casefold(value).includes(query.q))) return;
    if (total++ < query.offset || rows.length >= query.limit) return;
    const { sourceRecordId, kind, sourceId, sourceKey, title, product, sourceInstance } = row;
    rows.push({ sourceRecordId, kind, sourceId, sourceKey, title, product, sourceInstance, status, target,
      ...(invalidTarget ? { invalidPrimaryTarget: true } : {}), ...(invalidBinding ? { invalidPrimaryBinding: true } : {}) });
  }, scopedPackage);
  return { importId, receiptVersion: receipt.version, counts, rows, total, offset: query.offset, limit: query.limit };
}

function checkFile({store, files, preservation, trash}: Dependencies, importId: string, sourceRecordId: string): SourceReconciliationFileCheck {
  const source = preservation.record(importId, sourceRecordId);
  if (source.record.kind !== 'attachment') failure(400, '첨부 원본만 파일 무결성을 확인할 수 있습니다.');
  if (source.targetType !== 'attachment' || !source.targetId) return { sourceRecordId, status: 'unbound', fileId: null, size: null, sha256: null };
  const fileId = source.targetId;
  let file = store.get<AttachmentVersion>('attachment_versions', fileId) ?? store.get<Attachment>('attachments', fileId);
  if (!file && source.ownerType && source.ownerId) {
    const row = store.db.prepare(`SELECT file.json FROM trash_item_files AS file
      JOIN trash_items AS entry ON entry.id=file.entry_id
      WHERE file.file_id=? AND entry.item_type='attachment' AND entry.owner_type=? AND entry.owner_id=?`)
      .get(fileId, source.ownerType, source.ownerId) as {json: string} | undefined;
    if (row) file = JSON.parse(row.json) as Attachment;
    else {
      const archived = trash.find(source.ownerType, source.ownerId);
      file = archived?.attachmentVersions.find(value => value.id === fileId) ?? archived?.attachments.find(value => value.id === fileId);
    }
  }
  if (!file) return { sourceRecordId, status: 'missing', fileId, size: null, sha256: null };
  const details = { sourceRecordId, fileId, size: file.size, sha256: file.sha256 };
  try {
    const metadata = statSync(files.path(fileId));
    if (!metadata.isFile() || metadata.size !== file.size) return { ...details, status: 'corrupt' };
    files.read(file);
    return { ...details, status: 'verified' };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ENOENT') return { ...details, status: 'missing' };
      failure(503, '첨부파일을 읽을 수 없습니다. 잠시 후 다시 확인해 주세요.');
    }
    return { ...details, status: 'corrupt' };
  }
}

function declaredSize(value: AuditMatchRow['originalSize']): number | null {
  const size = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
  return size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function auditEntry(row: AuditMatchRow, recordStatus: SourceReconciliationStatus, archivedFile?: FileMetadata): AuditEntry {
  const { sourceRecordId, sourceId, title, product, sourceInstance, packageSha256 } = row;
  const identity = { sourceRecordId, sourceId, title, product, sourceInstance, packageSha256, recordStatus };
  if (recordStatus === 'excluded' || row.targetType !== 'attachment' || !row.targetId) {
    return { ...identity, status: recordStatus === 'excluded' ? 'excluded' : 'unbound', fileId: null, size: null, sha256: null };
  }
  if (recordStatus === 'missing') return { ...identity, status: 'missing', fileId: row.targetId, size: null, sha256: null };
  const size = archivedFile ? archivedFile.size : row.size;
  const sha256 = archivedFile ? archivedFile.sha256 : row.sha;
  const resourceId = archivedFile ? archivedFile.resourceId : row.fileOwnerId;
  const resourceType = archivedFile ? archivedFile.resourceType : row.fileOwnerType;
  const sourceSize = declaredSize(row.originalSize);
  const sourceSha = typeof row.originalSha === 'string' && /^[a-f\d]{64}$/i.test(row.originalSha) ? row.originalSha.toLowerCase() : null;
  const compatible = typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size <= MAX_FILE_BYTES &&
    typeof sha256 === 'string' && /^[a-f\d]{64}$/.test(sha256) &&
    (!row.originalOwnerId || resourceId === row.originalOwnerId && resourceType === row.originalOwnerType) &&
    (sourceSize === null || size === sourceSize) && (sourceSha === null || sha256 === sourceSha);
  return {
    ...identity, status: compatible ? null : 'corrupt', fileId: row.targetId,
    size: typeof size === 'number' ? size : null, sha256: typeof sha256 === 'string' ? sha256 : null,
  };
}

function receiptCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function compareArchive(receipt: SourceImport, measured: ReturnType<SourcePreservationService['measureArchive']>): SourceReconciliationIntegrity {
  const baselines = new Map(receipt.integrity?.packages.map(value => [value.stagingId, value]));
  const filenames = new Map(receipt.packages.map(value => [value.stagingId, value.filename]));
  const packages = measured.packages.map((actual): SourceReconciliationIntegrityPackage => {
    const baseline = baselines.get(actual.stagingId);
    const records = { expected: baseline?.recordCount ?? null, observed: actual.recordCount };
    const boundAttachments = { expected: baseline?.boundAttachmentCount ?? null, observed: actual.boundAttachmentCount };
    const recordsSha256 = { expected: baseline?.recordsSha256 ?? null, observed: actual.recordsSha256 };
    const matches = records.expected === records.observed && boundAttachments.expected === boundAttachments.observed
      && recordsSha256.expected === recordsSha256.observed;
    return {
      stagingId: actual.stagingId, filename: filenames.get(actual.stagingId) ?? actual.stagingId,
      status: baseline ? (matches ? 'verified' : 'mismatch') : 'unavailable', records, boundAttachments, recordsSha256,
    };
  });
  const records = {
    expected: receiptCount(receipt.counts.sourceRecords),
    observed: measured.packages.reduce((total, value) => total + value.recordCount, measured.unmatchedRecords),
  };
  const boundAttachments = {
    expected: receiptCount(receipt.counts.attachmentVersions),
    observed: measured.packages.reduce((total, value) => total + value.boundAttachmentCount, measured.unmatchedBoundAttachments),
  };
  const mismatched = measured.unmatchedRecords > 0 || measured.columnMismatches > 0
    || packages.some(value => value.status === 'mismatch')
    || (Boolean(receipt.integrity) && (baselines.size !== packages.length || packages.some(value => value.status === 'unavailable')))
    || [records, boundAttachments].some(value => value.expected !== null && value.expected !== value.observed);
  let status: SourceReconciliationIntegrity['status'] = 'unavailable';
  if (mismatched) status = 'mismatch';
  else if (receipt.integrity) status = 'verified';
  else if (records.expected !== null || boundAttachments.expected !== null) status = 'counts-only';
  return { status, records, boundAttachments, unmatchedRecords: measured.unmatchedRecords, columnMismatches: measured.columnMismatches, packages };
}

function contentSection(type: TargetType) {
  switch (type) {
    case 'comment': return 'comments';
    case 'revision': return 'revisions';
    case 'worklog': return 'worklogs';
    default: return null;
  }
}

function contentFingerprint(): ContentFingerprint {
  return { count: 0, hash: createHash('sha256') };
}

function contentSha256(json: string) {
  return createHash('sha256').update(json).digest('hex');
}

function addContent(fingerprint: ContentFingerprint, identity: unknown[], payloadSha256: string) {
  fingerprint.hash.update(JSON.stringify([...identity, payloadSha256])).update('\n');
  fingerprint.count++;
}

function finishContent({ count, hash }: ContentFingerprint) {
  return { count, sha256: hash.digest('hex') };
}

function issueRelationContent(store: Store, importId: string, linkedIssues: ReadonlySet<string>) {
  const fingerprint = contentFingerprint();
  // Anchor each lookup to receipt endpoints so SQLite uses the endpoint indexes instead of scanning unrelated relations.
  const rows = store.db.prepare(`
    WITH receipt_issues AS (
      SELECT DISTINCT i.id FROM source_records r JOIN issues i ON i.id=r.target_id
      WHERE r.import_id=? AND r.target_type='issue' AND json_valid(r.json)
    ), projected_relations AS (
      SELECT DISTINCT json_extract(r.json,'$.jiraRelationId') AS id FROM source_records r
      WHERE r.import_id=? AND r.product='jira' AND r.kind='relation' AND json_valid(r.json) AND json_type(r.json,'$.jiraRelationId')='text'
    ), receipt_relations AS (
      SELECT relation.id FROM receipt_issues i CROSS JOIN issue_relations relation ON relation.source_issue_id=i.id
      UNION
      SELECT relation.id FROM receipt_issues i CROSS JOIN issue_relations relation ON relation.target_issue_id=i.id
      UNION
      SELECT id FROM projected_relations
    )
    SELECT relation.id, relation.source_issue_id, relation.target_issue_id, relation.json,
      EXISTS(SELECT 1 FROM projected_relations WHERE projected_relations.id=relation.id) AS projected
    FROM receipt_relations matched CROSS JOIN issue_relations relation ON relation.id=matched.id
    ORDER BY relation.id
  `).iterate(importId, importId);
  for (const result of rows) {
    const row = result as { id: string; source_issue_id: string; target_issue_id: string; json: string; projected: number };
    if (!row.projected && !linkedIssues.has(row.source_issue_id) && !linkedIssues.has(row.target_issue_id)) continue;
    addContent(fingerprint, [row.id, row.source_issue_id, row.target_issue_id], contentSha256(row.json));
  }
  return finishContent(fingerprint);
}

function addDocumentRevisions(
  { store, trash }: Dependencies, importId: string, documents: ReadonlyMap<string, string | null>, observed: Set<string>,
  fingerprint: ContentFingerprint,
) {
  if (!documents.size) return;
  // The current migrated page snapshot can have no direct source-revision binding. Follow bound documents as well.
  const revisions = store.db.prepare(`
    WITH receipt_documents AS (
      SELECT DISTINCT d.id FROM source_records r JOIN documents d ON d.id=r.target_id
      WHERE r.import_id=? AND r.target_type='document' AND json_valid(r.json)
    )
    SELECT revision.id, revision.document_id FROM receipt_documents d
    CROSS JOIN revisions revision ON revision.document_id=d.id
    ORDER BY revision.id
  `).iterate(importId);
  const readRevision = store.db.prepare('SELECT json FROM revisions WHERE id=?');
  for (const result of revisions) {
    const { id, document_id: documentId } = result as { id: string; document_id: string };
    if (documents.get(documentId) !== null || observed.has(id)) continue;
    const row = readRevision.get(id) as { json: string };
    addContent(fingerprint, ['document-history', documentId, id], contentSha256(row.json));
    observed.add(id);
  }
  for (const [documentId, trashId] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
    if (trashId === null) continue;
    const archive = trash.get(trashId);
    for (const revision of archive.revisions.sort((left, right) => left.id.localeCompare(right.id))) {
      if (observed.has(revision.id)) continue;
      addContent(fingerprint, ['parent-archive', documentId, trashId, revision.id], contentSha256(JSON.stringify(revision)));
      observed.add(revision.id);
    }
  }
}

function auditSnapshot(dependencies: Dependencies, receipt: SourceImport, collect: boolean) {
  const integrity = compareArchive(receipt, dependencies.preservation.measureArchive(receipt));
  const fingerprint = createHash('sha256');
  fingerprint.update(JSON.stringify(integrity)).update('\n');
  const primaryByPackage = new Map<string, PrimaryRecordFingerprint>(receipt.packages.map(({ stagingId, source, sha256 }) => {
    const kind = primaryRecordKind(source.product);
    const hash = createHash('sha256').update(JSON.stringify([stagingId, source.product, source.instanceKey, sha256, kind])).update('\n');
    return [stagingId, { kind, counts: emptyRecordCounts(), invalidTargets: 0, hash }];
  }));
  const orderedEntries: { order: number; entry: AuditEntry }[] = [];
  const contents = { comments: contentFingerprint(), revisions: contentFingerprint(), worklogs: contentFingerprint() };
  const linkedIssues = new Set<string>();
  const boundDocuments = new Map<string, string | null>();
  const observedRevisions = new Set<string>();
  const recordCounts = scanReceipt(dependencies, receipt, true, (match, status, target, stagingId, archivedFile, archivedContentSha256) => {
    const { auditRowOrder, targetPayload, targetColumns, ...row } = match as AuditMatchRow & AuditTargetProjection;
    fingerprint.update(JSON.stringify([row, status, target, archivedFile ?? null])).update('\n');
    const primary = stagingId ? primaryByPackage.get(stagingId) : undefined;
    if (primary && row.kind === primary.kind) {
      primary.counts[status]++;
      const invalidBinding = invalidPrimaryBinding(row, status);
      if (invalidPrimaryTarget(row, status) || invalidBinding) primary.invalidTargets++;
      primary.hash.update(JSON.stringify([row.sourceRecordId, row.originalRecordId, status,
        row.targetType, row.targetId, target === null ? row.targetProjectId : target.projectId,
        ...(invalidBinding ? [row.invalidSourceIdBinding, row.invalidJiraKeyBinding] : [])])).update('\n');
    }
    if (collect && row.kind === 'attachment') orderedEntries.push({ order: auditRowOrder, entry: auditEntry(row, status, archivedFile) });
    if (!target) return;
    if (target.type === 'issue' && status === 'linked') linkedIssues.add(target.id);
    if (target.type === 'document') {
      if (status === 'linked') boundDocuments.set(target.id, null);
      else if (status === 'trashed' && row.trashId) boundDocuments.set(target.id, row.trashId);
    }
    const section = contentSection(target.type);
    if (!section || (targetPayload === null && !archivedContentSha256)) return;
    if (section === 'revisions') {
      if (observedRevisions.has(target.id)) return;
      observedRevisions.add(target.id);
    }
    if (targetPayload !== null) {
      addContent(contents[section], [row.sourceRecordId, target.id, status, targetColumns], contentSha256(targetPayload));
    } else if (archivedContentSha256) {
      addContent(contents[section], [row.sourceRecordId, target.id, status, 'parent-archive', row.trashId,
        row.originalOwnerType, row.originalOwnerId], archivedContentSha256);
    }
  });
  addDocumentRevisions(dependencies, receipt.id, boundDocuments, observedRevisions, contents.revisions);
  const targetContent: SourceReconciliationTargetContent = {
    version: 1, comments: finishContent(contents.comments), revisions: finishContent(contents.revisions),
    worklogs: finishContent(contents.worklogs), issueRelations: issueRelationContent(dependencies.store, receipt.id, linkedIssues),
  };
  const jiraStatusHistory = receipt.packages.some(packageInfo => packageInfo.source.product === 'jira')
    ? auditJiraStatusHistory(dependencies.store, receipt)
    : null;
  const jiraRelationProjection = auditJiraRelationProjections(dependencies, receipt)?.audit ?? null;
  const resourceLinkProjection = auditResourceLinkProjections(dependencies.store, receipt)?.audit ?? null;
  const authorAttribution = auditSourceAuthors(dependencies.store, dependencies.trash, receipt)?.audit ?? null;
  const primaryRecords: SourceReconciliationPrimaryRecords[] = [...primaryByPackage].map(([packageId, { kind, counts, invalidTargets, hash }]) => ({
    packageId, kind, counts, invalidTargets, dispositionSha256: hash.digest('hex'),
  }));
  fingerprint.update(JSON.stringify([primaryRecords, targetContent, jiraStatusHistory, jiraRelationProjection, resourceLinkProjection, authorAttribution]));
  const entries = orderedEntries.sort((left, right) => left.order - right.order).map(({ entry }) => entry);
  return { fingerprint: fingerprint.digest('hex'), entries, recordCounts, primaryRecords, integrity, targetContent,
    jiraStatusHistory, jiraRelationProjection, resourceLinkProjection, authorAttribution };
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : null;
}

async function auditFile(
  files: AttachmentFiles, fileId: string, size: number, sha256: string, buffer: Buffer, signal: AbortSignal,
): Promise<SourceReconciliationAuditStatus> {
  let path: string;
  try { path = files.path(fileId); }
  catch { return 'corrupt'; }
  try {
    // Open the identified file once. A replacement during the read must remain unverified.
    const file = await fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      signal.throwIfAborted();
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(size)) return 'corrupt';
      const digest = createHash('sha256');
      let offset = 0;
      while (offset < size) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) return 'corrupt';
        offset += bytesRead;
        digest.update(buffer.subarray(0, bytesRead));
      }
      signal.throwIfAborted();
      const current = await fileSystem.lstat(path, { bigint: true });
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino ||
        current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) return 'unreadable';
      return digest.digest('hex') === sha256 ? 'verified' : 'corrupt';
    } finally { await file.close(); }
  } catch (error) {
    signal.throwIfAborted();
    if (errorCode(error) === 'ENOENT') return 'missing';
    if (errorCode(error) === 'ELOOP') return 'corrupt';
    return 'unreadable';
  }
}

function receiptVersion(value: unknown, invalidMessage: string): number {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    return failure(400, invalidMessage);
  }
  return Number(value);
}

function auditVersion(query: Record<string, unknown>): number {
  const message = '이관 전체 검증에 사용할 영수증 버전을 확인해 주세요.';
  if (Object.keys(query).length !== 1) return failure(400, message);
  return receiptVersion(query.expectedVersion, message);
}

function jiraFindingsPage(store: Store, importId: string, query: Record<string, unknown>): SourceReconciliationJiraStatusFindingsPage {
  if (Object.keys(query).some(key => !jiraFindingKeys.has(key))) failure(400, '지원하지 않는 Jira 상태 변경 조회 조건입니다.');
  const { expectedFingerprint } = query;
  const finding = jiraFindings.find(value => value === query.finding) ?? failure(400, 'Jira 상태 변경의 확인 항목을 선택해 주세요.');
  if (expectedFingerprint !== undefined && (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint))) {
    return failure(400, 'Jira 상태 변경 목록의 검증값을 확인해 주세요.');
  }
  const expectedVersion = receiptVersion(query.expectedVersion, 'Jira 상태 변경 조회에 사용할 영수증 버전을 확인해 주세요.');
  const offset = pageInteger(query.offset, 0, 0, 1_000_000);
  const limit = pageInteger(query.limit, 30, 1, 100);
  const receipt = store.get<SourceImport>('source_imports', importId);
  if (!receipt?.packages.some(packageInfo => packageInfo.source.product === 'jira')) return failure(404, 'Jira 이관 영수증을 찾을 수 없습니다.');
  if (receipt.version !== expectedVersion) return failure(409, '이관 영수증이 변경되었습니다. 새로고침하고 다시 확인해 주세요.');
  const page = jiraStatusHistoryFindings(store, receipt, finding, offset, limit);
  if (expectedFingerprint !== undefined && expectedFingerprint !== page.fingerprint) {
    return failure(409, 'Jira 상태 변경 목록이 변경되었습니다. 첫 페이지부터 다시 확인해 주세요.');
  }
  return { importId, receiptVersion: receipt.version, finding, offset, limit, ...page };
}

function jiraRelationFindingsPage(dependencies: Dependencies, importId: string,
  query: Record<string, unknown>): SourceReconciliationJiraRelationFindingsPage {
  if (Object.keys(query).some(key => !projectionFindingKeys.has(key))) failure(400, '지원하지 않는 Jira 업무 관계 조회 조건입니다.');
  const finding = jiraRelationFindings.find(value => value === query.finding) ?? failure(400, 'Jira 업무 관계의 확인 항목을 선택해 주세요.');
  const { expectedSha256 } = query;
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    return failure(400, 'Jira 업무 관계 목록의 검증값을 확인해 주세요.');
  }
  const expectedVersion = receiptVersion(query.expectedVersion, 'Jira 업무 관계 조회에 사용할 영수증 버전을 확인해 주세요.');
  const offset = pageInteger(query.offset, 0, 0, 1_000_000);
  const limit = pageInteger(query.limit, 20, 1, 100);
  const receipt = dependencies.store.get<SourceImport>('source_imports', importId) ?? failure(404, '이관 영수증을 찾을 수 없습니다.');
  if (receipt.version !== expectedVersion) return failure(409, '이관 영수증이 변경되었습니다. 새로고침하고 다시 확인해 주세요.');
  const result = auditJiraRelationProjections(dependencies, receipt, { finding, offset, limit });
  if (!result) return failure(404, 'Jira 이관 영수증을 찾을 수 없습니다.');
  const { audit: { sha256 }, rows, total } = result;
  if (expectedSha256 !== sha256) return failure(409, 'Jira 업무 관계 목록이 변경되었습니다. 전체 이관 검증을 다시 실행해 주세요.');
  return { importId, receiptVersion: receipt.version, finding, sha256, total, offset, limit, rows };
}

function resourceLinkFindingsPage(store: Store, importId: string, query: Record<string, unknown>): SourceReconciliationResourceLinkFindingsPage {
  if (Object.keys(query).some(key => !projectionFindingKeys.has(key))) failure(400, '지원하지 않는 업무·문서 연결 조회 조건입니다.');
  const finding = resourceLinkFindings.find(value => value === query.finding) ?? failure(400, '업무·문서 연결의 확인 항목을 선택해 주세요.');
  const { expectedSha256 } = query;
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    return failure(400, '업무·문서 연결 목록의 검증값을 확인해 주세요.');
  }
  const expectedVersion = receiptVersion(query.expectedVersion, '업무·문서 연결 조회에 사용할 영수증 버전을 확인해 주세요.');
  const offset = pageInteger(query.offset, 0, 0, 1_000_000);
  const limit = pageInteger(query.limit, 20, 1, 100);
  const receipt = store.get<SourceImport>('source_imports', importId) ?? failure(404, '이관 영수증을 찾을 수 없습니다.');
  if (receipt.version !== expectedVersion) return failure(409, '이관 영수증이 변경되었습니다. 새로고침하고 다시 확인해 주세요.');
  const result = auditResourceLinkProjections(store, receipt, { finding, offset, limit });
  if (!result) return failure(404, '이관 당시의 업무·문서 연결 검증 기준이 없습니다.');
  const { audit: { sha256 }, rows, total } = result;
  if (expectedSha256 !== sha256) return failure(409, '업무·문서 연결 목록이 변경되었습니다. 전체 이관 검증을 다시 실행해 주세요.');
  return { importId, receiptVersion: receipt.version, finding, sha256, total, offset, limit, rows };
}

function authorFindingsPage({ store, trash }: Dependencies, importId: string, query: Record<string, unknown>): SourceReconciliationAuthorFindingsPage {
  if (Object.keys(query).some(key => !authorFindingKeys.has(key))) failure(400, '지원하지 않는 이관 작성자 조회 조건입니다.');
  const { packageId, expectedFingerprint } = query;
  if (typeof packageId !== 'string' || !packageId.trim() || packageId.length > 200 || /[\x00-\x1f\x7f]/u.test(packageId)) {
    return failure(400, '이관 작성자를 확인할 원본 패키지를 선택해 주세요.');
  }
  const kind = MIGRATION_AUTHOR_KINDS.find(value => value === query.kind) ?? failure(400, '이관 작성자를 확인할 객체 종류를 선택해 주세요.');
  const status = MIGRATION_AUTHOR_STATUSES.find(value => value === query.status) ?? failure(400, '이관 작성자의 확인 상태를 선택해 주세요.');
  if (expectedFingerprint !== undefined && (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint))) {
    return failure(400, '이관 작성자 목록의 검증값을 확인해 주세요.');
  }
  const expectedVersion = receiptVersion(query.expectedVersion, '이관 작성자 조회에 사용할 영수증 버전을 확인해 주세요.');
  const offset = pageInteger(query.offset, 0, 0, 1_000_000);
  const limit = pageInteger(query.limit, 30, 1, 100);
  const receipt = store.get<SourceImport>('source_imports', importId) ?? failure(404, '이관 영수증을 찾을 수 없습니다.');
  if (receipt.version !== expectedVersion) return failure(409, '이관 영수증이 변경되었습니다. 새로고침하고 다시 확인해 주세요.');
  if (!receipt.packages.some(packageInfo => packageInfo.stagingId === packageId)) return failure(404, '이관 영수증에서 원본 패키지를 찾을 수 없습니다.');
  const findings = auditSourceAuthors(store, trash, receipt, { packageId, kind, status, offset, limit });
  if (!findings) return failure(404, '이관 당시의 작성자 대조 기준이 없습니다.');
  const { audit: { fingerprint }, rows, total } = findings;
  if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) {
    return failure(409, '이관 작성자 목록이 변경되었습니다. 전체 이관 검증을 다시 실행해 주세요.');
  }
  return { importId, receiptVersion: receipt.version, packageId, kind, status, offset, limit, total, fingerprint, rows };
}

async function auditReceipt(dependencies: Dependencies, importId: string, expectedVersion: number, signal: AbortSignal): Promise<SourceReconciliationAudit> {
  const { store, files } = dependencies;
  const receipt = store.get<SourceImport>('source_imports', importId) ?? failure(404, '이관 영수증을 찾을 수 없습니다.');
  const conflict = () => failure(409, '검증 중 이관 영수증이나 현재 대상이 변경되었습니다. 결과를 새로고침하고 다시 검증해 주세요.');
  if (receipt.version !== expectedVersion) conflict();
  const startedAt = new Date().toISOString();
  const generation = store.setting('attachmentImportGeneration');
  const before = auditSnapshot(dependencies, receipt, true);
  const attachmentCounts: SourceReconciliationAudit['attachmentCounts'] = { verified: 0, missing: 0, corrupt: 0, unbound: 0, excluded: 0, unreadable: 0 };
  const attachments: SourceReconciliationAuditAttachment[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const entry of before.entries) {
    signal.throwIfAborted();
    const status = entry.status ?? await auditFile(files, entry.fileId!, entry.size!, entry.sha256!, buffer, signal);
    attachmentCounts[status]++;
    attachments.push({ ...entry, status });
  }
  signal.throwIfAborted();
  if (store.setting('attachmentImportGeneration') !== generation) conflict();
  const current = store.get<SourceImport>('source_imports', importId);
  if (!current || current.version !== expectedVersion || auditSnapshot(dependencies, current, false).fingerprint !== before.fingerprint) conflict();
  return {
    importId, receiptVersion: receipt.version, startedAt, completedAt: new Date().toISOString(),
    integrity: before.integrity, recordCounts: before.recordCounts, primaryRecords: before.primaryRecords, targetContent: before.targetContent,
    jiraStatusHistory: before.jiraStatusHistory, jiraRelationProjection: before.jiraRelationProjection,
    resourceLinkProjection: before.resourceLinkProjection,
    authorAttribution: before.authorAttribution, attachmentCounts, attachments,
  };
}

export function registerSourceReconciliationRoutes(app: Express, dependencies: Dependencies) {
  let auditing = false;
  app.get('/api/source-imports/:id/reconciliation', (request, response) => {
    response.set('Cache-Control', 'no-store').json(reconciliation(dependencies, String(request.params.id), parseQuery(request.query)));
  });
  app.get('/api/source-imports/:id/reconciliation/jira-status-findings', (request, response) => {
    response.set('Cache-Control', 'no-store').json(jiraFindingsPage(dependencies.store, String(request.params.id), request.query));
  });
  app.get('/api/source-imports/:id/reconciliation/jira-relation-findings', (request, response) => {
    response.set('Cache-Control', 'no-store').json(jiraRelationFindingsPage(dependencies, String(request.params.id), request.query));
  });
  app.get('/api/source-imports/:id/reconciliation/resource-link-findings', (request, response) => {
    response.set('Cache-Control', 'no-store').json(resourceLinkFindingsPage(dependencies.store, String(request.params.id), request.query));
  });
  app.get('/api/source-imports/:id/reconciliation/author-findings', (request, response) => {
    response.set('Cache-Control', 'no-store').json(authorFindingsPage(dependencies, String(request.params.id), request.query));
  });
  app.get('/api/source-imports/:id/records/:recordId/check-file', (request, response) => {
    if (Object.keys(request.query).length) failure(400, '지원하지 않는 파일 확인 조건입니다.');
    response.set('Cache-Control', 'no-store').json(checkFile(dependencies, String(request.params.id), String(request.params.recordId)));
  });
  app.get('/api/source-imports/:id/reconciliation/audit', async (request, response) => {
    const expectedVersion = auditVersion(request.query);
    if (auditing) failure(429, '다른 이관 전체 검증이 진행 중입니다. 완료 후 다시 시도해 주세요.');
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    response.once('close', disconnected);
    auditing = true;
    try {
      const report = await auditReceipt(dependencies, String(request.params.id), expectedVersion, controller.signal);
      if (!controller.signal.aborted) response.set('Cache-Control', 'no-store').json(report);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      auditing = false;
      response.off('close', disconnected);
    }
  });
}
