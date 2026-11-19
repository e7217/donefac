import type { Express } from 'express';
import { statSync } from 'node:fs';
import type {
  Attachment, AttachmentVersion, LegacyRecordKind, SourceImport, SourceReconciliationFileCheck, SourceReconciliationOwner,
  SourceReconciliationPage, SourceReconciliationRow, SourceReconciliationStatus, SourceReconciliationTarget,
} from '../shared/types.js';
import type { AttachmentFiles } from './attachments.js';
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
const rowsSql = `
  SELECT r.id AS sourceRecordId, r.kind, r.source_id AS sourceId, r.product, r.source_instance AS sourceInstance,
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

function archiveLabels(archive: TrashArchive) {
  const labels: Record<string, Map<string, string>> = {
    comment: new Map(archive.comments.map(value => [value.id, '댓글'])),
    revision: new Map(archive.revisions.map(value => [value.id, `버전 ${value.version}`])),
    attachment: new Map(archive.attachments.map(value => [value.id, value.filename])),
  };
  for (const version of archive.attachmentVersions) labels.attachment.set(version.id, `${version.filename} · ${version.versionLabel}`);
  return labels;
}

function reconciliation({store, trash}: Dependencies, importId: string, query: ReceiptQuery): SourceReconciliationPage {
  const receipt = store.get<SourceImport>('source_imports', importId) ?? failure(404, '이관 영수증을 찾을 수 없습니다.');
  const packages = new Map(receipt.packages.map(value => [packageIdentity(value.source.product, value.source.instanceKey, value.sha256), value.stagingId]));
  const excluded = new Set(receipt.configuration.excludedRecords);
  const counts: SourceReconciliationPage['counts'] = { linked: 0, trashed: 0, missing: 0, 'archive-only': 0, excluded: 0 };
  const rows: SourceReconciliationRow[] = [];
  const trashedChildren = new Map<string, ReturnType<typeof archiveLabels>>();
  let total = 0;

  function archivedLabel(row: MatchRow, type: TargetType, targetId: string) {
    if (!row.trashId) return null;
    if (type === 'issue' || type === 'document') {
      return [row.trashIssueKey, row.trashTitle].filter(Boolean).join(' · ') || targetId;
    }
    if (!['comment', 'revision', 'attachment'].includes(type)) return null;
    let labels = trashedChildren.get(row.trashId);
    if (!labels) {
      labels = archiveLabels(trash.get(row.trashId));
      if (trashedChildren.size >= 32) trashedChildren.delete(trashedChildren.keys().next().value!);
      trashedChildren.set(row.trashId, labels);
    }
    return labels[type]?.get(targetId) ?? null;
  }

  for (const raw of store.db.prepare(rowsSql).iterate(importId)) {
    const row = raw as unknown as MatchRow;
    const stagingId = packages.get(packageIdentity(row.product, row.sourceInstance, row.packageSha256));
    let status: SourceReconciliationStatus = stagingId && excluded.has(`${stagingId}/${row.originalRecordId}`) ? 'excluded' : 'archive-only';
    let target: SourceReconciliationTarget | null = null;
    if (status !== 'excluded' && row.targetType && row.targetId) {
      const archived = row.linked ? null : archivedLabel(row, row.targetType, row.targetId);
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
    if ((query.status && status !== query.status) || (query.kind && row.kind !== query.kind)) continue;
    if (query.q && ![row.sourceId, row.sourceKey, row.title, row.sourceInstance, target?.label, target?.owner?.label]
      .some(value => value && casefold(value).includes(query.q))) continue;
    if (total++ < query.offset || rows.length >= query.limit) continue;
    const { sourceRecordId, kind, sourceId, sourceKey, title, product, sourceInstance } = row;
    rows.push({ sourceRecordId, kind, sourceId, sourceKey, title, product, sourceInstance, status, target });
  }
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

export function registerSourceReconciliationRoutes(app: Express, dependencies: Dependencies) {
  app.get('/api/source-imports/:id/reconciliation', (request, response) => {
    response.set('Cache-Control', 'no-store').json(reconciliation(dependencies, String(request.params.id), parseQuery(request.query)));
  });
  app.get('/api/source-imports/:id/records/:recordId/check-file', (request, response) => {
    if (Object.keys(request.query).length) failure(400, '지원하지 않는 파일 확인 조건입니다.');
    response.set('Cache-Control', 'no-store').json(checkFile(dependencies, String(request.params.id), String(request.params.recordId)));
  });
}
