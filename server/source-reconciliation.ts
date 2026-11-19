import { createHash } from 'node:crypto';
import { constants, statSync } from 'node:fs';
import fileSystem from 'node:fs/promises';
import type { Express } from 'express';
import type {
  Attachment, AttachmentVersion, LegacyRecordKind, SourceImport, SourceReconciliationAudit, SourceReconciliationAuditAttachment,
  SourceReconciliationAuditStatus, SourceReconciliationFileCheck, SourceReconciliationOwner,
  SourceReconciliationPage, SourceReconciliationRow, SourceReconciliationStatus, SourceReconciliationTarget,
} from '../shared/types.js';
import { MAX_FILE_BYTES, type AttachmentFiles } from './attachments.js';
import { isLegacyRecordKind, SourcePreservationError, type SourcePreservationService } from './source-preservation.js';
import type { Store } from './store.js';
import type { TrashArchive, TrashService } from './trash.js';

type TargetType = SourceReconciliationTarget['type'];
type SourceIdentity = Pick<SourceReconciliationRow, 'sourceRecordId' | 'kind' | 'sourceId' | 'sourceKey' | 'title' | 'product' | 'sourceInstance'>;
type MatchRow = SourceIdentity & {
  originalRecordId: string; packageSha256: string;
  targetType: TargetType | null; targetId: string | null;
  targetLabel: string | null; targetProjectId: string | null; linked: number;
  ownerType: SourceReconciliationOwner['type'] | null; ownerId: string | null;
  ownerLabel: string | null; ownerProjectId: string | null;
  trashId: string | null; trashTitle: string | null; trashIssueKey: string | null; trashProjectId: string | null;
};
type AuditMatchRow = MatchRow & {
  originalSize: string | number | null; originalSha: string | null; size: number | null; sha: string | null;
  originalOwnerId: string | null; originalOwnerType: SourceReconciliationOwner['type'] | null;
  ownerVersion: number | null; targetVersion: number | null; targetUpdatedAt: string | null;
  fileOwnerId: string | null; fileOwnerType: SourceReconciliationOwner['type'] | null;
};
type FileMetadata = Pick<Attachment, 'size' | 'sha256' | 'resourceId' | 'resourceType'>;
type AuditEntry = Omit<SourceReconciliationAuditAttachment, 'status'> & { status: SourceReconciliationAuditStatus | null };
type ReceiptQuery = { offset: number; limit: number; kind?: LegacyRecordKind; status?: SourceReconciliationStatus; q: string };
type Dependencies = { store: Store; files: AttachmentFiles; preservation: SourcePreservationService; trash: TrashService };
const statuses: readonly SourceReconciliationStatus[] = ['linked', 'trashed', 'missing', 'archive-only', 'excluded'];
const receiptKeys = new Set(['q', 'kind', 'status', 'offset', 'limit']);
const casefold = (value: string) => value.normalize('NFC').toLocaleLowerCase('ko-KR');

function failure(status: number, message: string): never { throw new SourcePreservationError(status, message); }

function parseQuery(input: Record<string, unknown>): ReceiptQuery {
  if (Object.keys(input).some(key => !receiptKeys.has(key))) failure(400, '지원하지 않는 이관 대조 조회 조건입니다.');
  function integer(name: 'offset' | 'limit', fallback: number, min: number, max: number) {
    const value = input[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
      failure(400, '이관 대조 페이지 범위를 확인해 주세요.');
    }
    return Number(value);
  }
  const { kind, status } = input;
  if (kind !== undefined && !isLegacyRecordKind(kind)) failure(400, '이관 대조 객체 종류를 확인해 주세요.');
  if (status !== undefined && (typeof status !== 'string' || !statuses.includes(status as SourceReconciliationStatus))) {
    failure(400, '이관 대조 상태를 확인해 주세요.');
  }
  const q = input.q === undefined ? '' : input.q;
  if (typeof q !== 'string' || q.length > 300 || [...q].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    failure(400, '이관 대조 검색어를 확인해 주세요.');
  }
  return { kind, status: status as ReceiptQuery['status'], offset: integer('offset', 0, 0, 1_000_000), limit: integer('limit', 30, 1, 100), q: casefold(q.trim()) };
}

// The projection keeps archived bodies, metadata values and file bytes outside the response and JS scan.
const auditProjection = `
    CASE WHEN r.kind='attachment' THEN coalesce(json_extract(r.json,'$.record.metadata.actualSize'),json_extract(r.json,'$.record.metadata.size')) END AS originalSize,
    CASE WHEN r.kind='attachment' THEN json_extract(r.json,'$.record.metadata.sha256') END AS originalSha,
    CASE WHEN av.id IS NOT NULL THEN json_extract(av.json,'$.size') ELSE json_extract(a.json,'$.size') END AS size,
    CASE WHEN av.id IS NOT NULL THEN json_extract(av.json,'$.sha256') ELSE json_extract(a.json,'$.sha256') END AS sha,
    CASE WHEN av.id IS NOT NULL THEN json_extract(av.json,'$.resourceId') ELSE json_extract(a.json,'$.resourceId') END AS fileOwnerId,
    CASE WHEN av.id IS NOT NULL THEN json_extract(av.json,'$.resourceType') ELSE json_extract(a.json,'$.resourceType') END AS fileOwnerType,
    r.owner_id AS originalOwnerId, r.owner_type AS originalOwnerType,
    coalesce(json_extract(i.json,'$.version'),json_extract(d.json,'$.version')) AS ownerVersion,
    coalesce(json_extract(v.json,'$.version'),json_extract(w.json,'$.version')) AS targetVersion,
    coalesce(json_extract(c.json,'$.updatedAt'),json_extract(p.json,'$.updatedAt')) AS targetUpdatedAt,`;
const rowsSql = (audit: boolean) => `
  SELECT r.id AS sourceRecordId, r.kind, r.source_id AS sourceId, r.product, r.source_instance AS sourceInstance,
    ${audit ? auditProjection : ''}
    json_extract(r.json,'$.record.id') AS originalRecordId, json_extract(r.json,'$.packageSha256') AS packageSha256,
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
    t.project_id AS trashProjectId
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
  LEFT JOIN trash_entries t ON t.resource_type=CASE WHEN r.target_type IN ('issue','document') THEN r.target_type ELSE r.owner_type END
    AND t.resource_id=CASE WHEN r.target_type IN ('issue','document') THEN r.target_id ELSE r.owner_id END
  WHERE r.import_id=? ORDER BY r.kind,r.rowid`;

function packageIdentity(product: string, instance: string, sha256: string) {
  return JSON.stringify([product, instance, sha256]);
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
  return { labels, files };
}

function scanReceipt(
  { store, trash }: Dependencies, receipt: SourceImport, audit: boolean,
  visit: (row: MatchRow, status: SourceReconciliationStatus, target: SourceReconciliationTarget | null, archivedFile?: FileMetadata) => void,
): SourceReconciliationPage['counts'] {
  const packages = new Map(receipt.packages.map(value => [packageIdentity(value.source.product, value.source.instanceKey, value.sha256), value.stagingId]));
  const excluded = new Set(receipt.configuration.excludedRecords);
  const counts: SourceReconciliationPage['counts'] = { linked: 0, trashed: 0, missing: 0, 'archive-only': 0, excluded: 0 };
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

  for (const raw of store.db.prepare(rowsSql(audit)).iterate(receipt.id)) {
    const row = raw as unknown as MatchRow;
    const stagingId = packages.get(packageIdentity(row.product, row.sourceInstance, row.packageSha256));
    let status: SourceReconciliationStatus = stagingId && excluded.has(`${stagingId}/${row.originalRecordId}`) ? 'excluded' : 'archive-only';
    let target: SourceReconciliationTarget | null = null;
    let archivedFile: FileMetadata | undefined;
    if (status !== 'excluded' && row.targetType && row.targetId) {
      let archived: string | null = null;
      if (!row.linked && row.trashId) {
        if (row.targetType === 'issue' || row.targetType === 'document') {
          archived = [row.trashIssueKey, row.trashTitle].filter(Boolean).join(' · ') || row.targetId;
        } else if (['comment', 'revision', 'attachment'].includes(row.targetType)) {
          const children = archivedChildren(row.trashId);
          archived = children.labels[row.targetType]?.get(row.targetId) ?? null;
          if (row.targetType === 'attachment') archivedFile = children.files.get(row.targetId);
        }
      }
      status = row.linked ? 'linked' : archived !== null ? 'trashed' : 'missing';
      const owner = row.ownerType && row.ownerId ? {
        type: row.ownerType, id: row.ownerId, label: row.ownerLabel ?? row.ownerId, projectId: row.ownerProjectId,
      } : null;
      target = {
        type: row.targetType, id: row.targetId, label: archived ?? row.targetLabel ?? row.targetId,
        projectId: archived !== null ? row.trashProjectId : row.targetProjectId, owner,
      };
    }
    counts[status]++;
    visit(row, status, target, archivedFile);
  }
  return counts;
}

function reconciliation(dependencies: Dependencies, importId: string, query: ReceiptQuery): SourceReconciliationPage {
  const receipt = dependencies.store.get<SourceImport>('source_imports', importId) ?? failure(404, '이관 영수증을 찾을 수 없습니다.');
  const rows: SourceReconciliationRow[] = [];
  let total = 0;
  const counts = scanReceipt(dependencies, receipt, false, (row, status, target) => {
    if ((query.status && status !== query.status) || (query.kind && row.kind !== query.kind)) return;
    if (query.q && ![row.sourceId, row.sourceKey, row.title, row.sourceInstance, target?.label, target?.owner?.label]
      .some(value => value && casefold(value).includes(query.q))) return;
    if (total++ < query.offset || rows.length >= query.limit) return;
    const { sourceRecordId, kind, sourceId, sourceKey, title, product, sourceInstance } = row;
    rows.push({ sourceRecordId, kind, sourceId, sourceKey, title, product, sourceInstance, status, target });
  });
  return { importId, receiptVersion: receipt.version, counts, rows, total, offset: query.offset, limit: query.limit };
}

function checkFile({store, files, preservation, trash}: Dependencies, importId: string, sourceRecordId: string): SourceReconciliationFileCheck {
  const source = preservation.record(importId, sourceRecordId);
  if (source.record.kind !== 'attachment') failure(400, '첨부 원본만 파일 무결성을 확인할 수 있습니다.');
  if (source.targetType !== 'attachment' || !source.targetId) return { sourceRecordId, status: 'unbound', fileId: null, size: null, sha256: null };
  const fileId = source.targetId;
  let file = store.get<AttachmentVersion>('attachment_versions', fileId) ?? store.get<Attachment>('attachments', fileId);
  if (!file && source.ownerType && source.ownerId) {
    const archived = trash.find(source.ownerType, source.ownerId);
    file = archived?.attachmentVersions.find(value => value.id === fileId) ?? archived?.attachments.find(value => value.id === fileId);
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

function auditSnapshot(dependencies: Dependencies, receipt: SourceImport, collect: boolean) {
  const fingerprint = createHash('sha256');
  const entries: AuditEntry[] = [];
  const recordCounts = scanReceipt(dependencies, receipt, true, (row, status, target, archivedFile) => {
    fingerprint.update(JSON.stringify([row, status, target, archivedFile ?? null])).update('\n');
    if (collect && row.kind === 'attachment') entries.push(auditEntry(row as AuditMatchRow, status, archivedFile));
  });
  return { fingerprint: fingerprint.digest('hex'), entries, recordCounts };
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

function auditVersion(query: Record<string, unknown>): number {
  const { expectedVersion } = query;
  if (Object.keys(query).length !== 1 || typeof expectedVersion !== 'string' || !/^\d{1,16}$/.test(expectedVersion) ||
    !Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
    return failure(400, '이관 전체 검증에 사용할 영수증 버전을 확인해 주세요.');
  }
  return Number(expectedVersion);
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
    recordCounts: before.recordCounts, attachmentCounts, attachments,
  };
}

export function registerSourceReconciliationRoutes(app: Express, dependencies: Dependencies) {
  let auditing = false;
  app.get('/api/source-imports/:id/reconciliation', (request, response) => {
    response.set('Cache-Control', 'no-store').json(reconciliation(dependencies, String(request.params.id), parseQuery(request.query)));
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
