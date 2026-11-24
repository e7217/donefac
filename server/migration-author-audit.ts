import { createHash } from 'node:crypto';
import {
  MIGRATION_AUTHOR_DISPOSITIONS, MIGRATION_AUTHOR_KINDS,
  type MigrationAuthorDisposition, type MigrationAuthorKind, type MigrationAuthorPackageReview, type MigrationAuthorStatus,
  type SourceImport, type SourceReconciliationAuthorAudit, type SourceReconciliationAuthorFindingsPage, type SourceReconciliationAuthorRow,
} from '../shared/types.js';
import type { Store } from './store.js';
import type { TrashArchive, TrashService } from './trash.js';

type EvidenceRow = {
  sourceRecordId: string; sourceId: string; sourceKind: string; product: string; sourceInstance: string; packageSha256: string;
  sourceWorklog: string | null; excluded: 0 | 1 | null; originalRecordId: string;
  kind: MigrationAuthorKind; disposition: MigrationAuthorDisposition; targetId: string; expectedAuthorId: string;
  boundType: string | null; boundId: string | null; ownerType: 'issue' | 'document' | null; ownerId: string | null;
  liveOwner: 0 | 1; parentTrashId: string | null;
};
type Candidate = { authorId: string | null; bindingMatches: 0 | 1 | null };
type ArchivedCandidate = { authorId: string; ownerMatches: boolean; sourceImportId?: string | null; sourceRecordId?: string | null };
type FindingsWindow = Pick<SourceReconciliationAuthorFindingsPage, 'packageId' | 'kind' | 'status' | 'offset' | 'limit'>;

const sourceKinds: Record<MigrationAuthorKind, string> = {
  document: 'page', comment: 'comment', revision: 'revision', attachment: 'attachment', worklog: 'history',
};

const authorEvidenceSql = `
  SELECT r.id AS sourceRecordId, r.source_id AS sourceId, r.kind AS sourceKind,
    r.product, r.source_instance AS sourceInstance, r.target_type AS boundType, r.target_id AS boundId,
    r.owner_type AS ownerType, r.owner_id AS ownerId, p.id AS parentTrashId,
    (i.id IS NOT NULL OR d.id IS NOT NULL) AS liveOwner,
    json_extract(r.json,'$.packageSha256') AS packageSha256,
    json_extract(r.json,'$.record.metadata.kind') AS sourceWorklog,
    json_extract(r.json,'$.record.id') AS originalRecordId, json_type(r.json,'$.excluded')='true' AS excluded,
    CASE WHEN json_extract(r.json,'$.authorAttribution.kind') IN ('document','comment','revision','attachment','worklog')
      THEN json_extract(r.json,'$.authorAttribution.kind') ELSE coalesce(r.target_type,CASE WHEN w.id IS NOT NULL THEN 'worklog' END) END AS kind,
    CASE WHEN json_type(r.json,'$.authorAttribution.targetId')='text' THEN json_extract(r.json,'$.authorAttribution.targetId')
      ELSE coalesce(r.target_id,w.id,'') END AS targetId,
    json_extract(r.json,'$.authorAttribution.disposition') AS disposition,
    CASE WHEN json_type(r.json,'$.authorAttribution.expectedAuthorId')='text' THEN json_extract(r.json,'$.authorAttribution.expectedAuthorId') ELSE '' END AS expectedAuthorId
  FROM source_records r
  LEFT JOIN issues i ON r.owner_type='issue' AND i.id=r.owner_id
  LEFT JOIN documents d ON r.owner_type='document' AND d.id=r.owner_id
  LEFT JOIN trash_entries p ON p.resource_type=r.owner_type AND p.resource_id=r.owner_id
  LEFT JOIN worklogs w ON r.product='jira' AND r.kind='history' AND json_extract(w.json,'$.sourceRecordId')=+r.id
  WHERE r.import_id=? AND CASE WHEN json_valid(r.json) THEN (json_type(r.json,'$.authorAttribution')='object'
    OR r.target_type IN ('document','comment','revision','attachment') OR w.id IS NOT NULL) END
  ORDER BY r.owner_type,r.owner_id,r.id`;

function packageKey(product: string, instance: string, sha256: string) {
  return JSON.stringify([product, instance, sha256]);
}

function countsByStatus(): Record<MigrationAuthorStatus, number> {
  return { mapped: 0, 'unmapped-fallback': 0, 'missing-fallback': 0, retained: 0, unavailable: 0, mismatch: 0 };
}

function validSourceBinding(row: EvidenceRow) {
  if (row.sourceKind !== sourceKinds[row.kind] || !row.ownerType || !row.ownerId || !row.targetId || !row.expectedAuthorId) return false;
  if (row.kind === 'worklog') return row.product === 'jira' && row.sourceWorklog === 'worklog' &&
    row.ownerType === 'issue' && row.boundType === null && row.boundId === null;
  if (row.boundType !== row.kind || row.boundId !== row.targetId) return false;
  if (row.kind === 'document') return row.product === 'confluence' && row.ownerType === 'document' && row.ownerId === row.targetId;
  if (row.kind === 'revision') return row.product === 'confluence' && row.ownerType === 'document';
  return true;
}

function currentCandidateReader(store: Store, receiptId: string) {
  const document = store.db.prepare(`SELECT json_extract(json,'$.authorId') AS authorId,
    (json_extract(json,'$.id') IS id AND json_extract(json,'$.authorId') IS author_id) AS bindingMatches
    FROM documents WHERE id=? AND json_valid(json)`);
  const comment = store.db.prepare(`SELECT json_extract(json,'$.authorId') AS authorId,
    (json_extract(json,'$.id') IS id AND author_id IS json_extract(json,'$.authorId') AND resource_type IS ? AND resource_id IS ?
      AND json_extract(json,'$.resourceType') IS resource_type AND json_extract(json,'$.resourceId') IS resource_id) AS bindingMatches
    FROM comments WHERE id=? AND json_valid(json)`);
  const revision = store.db.prepare(`SELECT json_extract(json,'$.authorId') AS authorId,
    (json_extract(json,'$.id') IS id AND document_id IS ? AND json_extract(json,'$.documentId') IS document_id) AS bindingMatches
    FROM revisions WHERE id=? AND json_valid(json)`);
  const version = store.db.prepare(`SELECT json_extract(v.json,'$.authorId') AS authorId,
    (json_extract(v.json,'$.id') IS v.id AND json_extract(v.json,'$.attachmentId') IS v.attachment_id
      AND a.resource_type IS ? AND a.resource_id IS ?
      AND json_extract(a.json,'$.id') IS a.id AND json_extract(a.json,'$.resourceType') IS a.resource_type
      AND json_extract(a.json,'$.resourceId') IS a.resource_id
      AND json_extract(v.json,'$.resourceType') IS a.resource_type AND json_extract(v.json,'$.resourceId') IS a.resource_id
      AND (? OR (json_extract(v.json,'$.sourceImportId') IS ? AND json_extract(v.json,'$.sourceRecordId') IS ?))) AS bindingMatches
    FROM attachment_versions v LEFT JOIN attachments a ON a.id=v.attachment_id WHERE v.id=? AND json_valid(v.json)`);
  const worklog = store.db.prepare(`SELECT json_extract(json,'$.authorId') AS authorId,
    (json_extract(json,'$.id') IS id AND author_id IS json_extract(json,'$.authorId') AND issue_id IS ?
      AND json_extract(json,'$.issueId') IS issue_id AND json_extract(json,'$.sourceRecordId') IS ?) AS bindingMatches
    FROM worklogs WHERE id=? AND json_valid(json)`);
  const trashedComment = store.db.prepare(`SELECT json_extract(json,'$.item.authorId') AS authorId,
    (json_extract(json,'$.item.id') IS item_id AND owner_type IS ? AND owner_id IS ?
      AND json_extract(json,'$.item.resourceType') IS owner_type AND json_extract(json,'$.item.resourceId') IS owner_id) AS bindingMatches
    FROM trash_items WHERE item_type='comment' AND item_id=? AND json_valid(json)`);
  // The indexed file copy must agree with the exact version in the restorable archive.
  const trashedVersion = store.db.prepare(`SELECT json_extract(v.value,'$.authorId') AS authorId,
    (v.key IS NOT NULL AND t.item_type='attachment' AND json_extract(f.json,'$.id') IS f.file_id
      AND json_extract(f.json,'$.attachmentId') IS t.item_id AND t.owner_type IS ? AND t.owner_id IS ?
      AND json_extract(f.json,'$.resourceType') IS t.owner_type AND json_extract(f.json,'$.resourceId') IS t.owner_id
      AND json_extract(v.value,'$.attachmentId') IS t.item_id AND json_extract(v.value,'$.resourceType') IS t.owner_type
      AND json_extract(v.value,'$.resourceId') IS t.owner_id AND json_extract(v.value,'$.authorId') IS json_extract(f.json,'$.authorId')
      AND json_extract(v.value,'$.sourceImportId') IS json_extract(f.json,'$.sourceImportId')
      AND json_extract(v.value,'$.sourceRecordId') IS json_extract(f.json,'$.sourceRecordId')
      AND (? OR (json_extract(v.value,'$.sourceImportId') IS ? AND json_extract(v.value,'$.sourceRecordId') IS ?))) AS bindingMatches
    FROM trash_item_files f JOIN trash_items t ON t.id=f.entry_id
    LEFT JOIN json_each(t.json,'$.versions') v ON json_extract(v.value,'$.id')=f.file_id
    WHERE f.file_id=? AND json_valid(f.json)`);

  return ({ kind, disposition, ownerType, ownerId, sourceRecordId, targetId }: EvidenceRow): Candidate | undefined => {
    switch (kind) {
      case 'document': return document.get(targetId) as Candidate | undefined;
      case 'comment': return (comment.get(ownerType, ownerId, targetId) ?? trashedComment.get(ownerType, ownerId, targetId)) as Candidate | undefined;
      case 'revision': return revision.get(ownerId, targetId) as Candidate | undefined;
      case 'attachment': {
        const parameters = [ownerType, ownerId, Number(disposition === 'retained'), receiptId, sourceRecordId, targetId] as const;
        return (version.get(...parameters) ?? trashedVersion.get(...parameters)) as Candidate | undefined;
      }
      case 'worklog': return worklog.get(ownerId, sourceRecordId, targetId) as Candidate | undefined;
    }
  };
}

function parentArchiveProjection(archive: TrashArchive) {
  const { resourceType, resourceId } = archive;
  const belongs = (value: { resourceType: string; resourceId: string }) => value.resourceType === resourceType && value.resourceId === resourceId;
  const document = new Map<string, ArchivedCandidate>();
  if (resourceType === 'document') document.set(archive.resource.id, { authorId: archive.resource.authorId, ownerMatches: archive.resource.id === resourceId });
  const parents = new Map(archive.attachments.map(file => [file.id, file]));
  return {
    document,
    comment: new Map(archive.comments.map(value => [value.id, { authorId: value.authorId, ownerMatches: belongs(value) }])),
    revision: new Map(archive.revisions.map(value => [value.id, {
      authorId: value.authorId, ownerMatches: resourceType === 'document' && value.documentId === resourceId,
    }])),
    attachment: new Map(archive.attachmentVersions.map(value => {
      const parent = parents.get(value.attachmentId);
      return [value.id, { authorId: value.authorId, ownerMatches: belongs(value) && !!parent && belongs(parent),
        sourceImportId: value.sourceImportId, sourceRecordId: value.sourceRecordId }];
    })),
  } satisfies Record<Exclude<MigrationAuthorKind, 'worklog'>, Map<string, ArchivedCandidate>>;
}

function parentArchiveReader(trash: TrashService, receiptId: string) {
  const archives = new Map<string, ReturnType<typeof parentArchiveProjection>>();
  return (row: EvidenceRow): Candidate | undefined => {
    if (!row.parentTrashId || row.kind === 'worklog') return;
    let archive = archives.get(row.parentTrashId);
    if (!archive) {
      archive = parentArchiveProjection(trash.get(row.parentTrashId));
      if (archives.size >= 32) archives.delete(archives.keys().next().value!);
      archives.set(row.parentTrashId, archive);
    }
    const candidate: ArchivedCandidate | undefined = archive[row.kind].get(row.targetId);
    if (!candidate) return;
    const sourceMatches = row.kind !== 'attachment' || row.disposition === 'retained' ||
      (candidate.sourceImportId === receiptId && candidate.sourceRecordId === row.sourceRecordId);
    return { authorId: candidate.authorId, bindingMatches: candidate.ownerMatches && sourceMatches ? 1 : 0 };
  };
}

function authorStatus(row: EvidenceRow, candidate: Candidate | undefined): MigrationAuthorStatus {
  if (!candidate) return 'unavailable';
  if (candidate.bindingMatches !== 1 || candidate.authorId !== row.expectedAuthorId) return 'mismatch';
  return row.liveOwner || row.parentTrashId ? row.disposition : 'unavailable';
}

export function auditSourceAuthors(
  store: Store, trash: TrashService, receipt: SourceImport, window?: FindingsWindow,
): { audit: SourceReconciliationAuthorAudit; rows: SourceReconciliationAuthorRow[]; total: number } | null {
  if (receipt.authorAttributionVersion !== 1) return null;
  const packageIds = new Map(receipt.packages.map(({ stagingId, source, sha256 }) => [packageKey(source.product, source.instanceKey, sha256), stagingId]));
  const excluded = new Set(receipt.configuration.excludedRecords);
  const packageCounts = new Map<string, Map<MigrationAuthorKind, Record<MigrationAuthorStatus, number>>>(
    receipt.packages.map(({ stagingId }) => [stagingId, new Map()]),
  );
  const hash = createHash('sha256').update(JSON.stringify([1, receipt.id, [...packageIds]])).update('\n');
  const readCurrent = currentCandidateReader(store, receipt.id);
  const readParentArchive = parentArchiveReader(trash, receipt.id);
  const rows: SourceReconciliationAuthorRow[] = [];
  let total = 0;
  for (const raw of store.db.prepare(authorEvidenceSql).iterate(receipt.id)) {
    const row = raw as unknown as EvidenceRow;
    const packageId = packageIds.get(packageKey(row.product, row.sourceInstance, row.packageSha256));
    const countsByKind = packageId && packageCounts.get(packageId);
    if (!countsByKind || !MIGRATION_AUTHOR_KINDS.includes(row.kind)) continue;
    const valid = !row.excluded && !excluded.has(`${packageId}/${row.originalRecordId}`) &&
      MIGRATION_AUTHOR_DISPOSITIONS.includes(row.disposition) && validSourceBinding(row);
    const candidate = valid ? readCurrent(row) ?? readParentArchive(row) : undefined;
    const status = valid ? authorStatus(row, candidate) : 'mismatch';
    const actualAuthorId = typeof candidate?.authorId === 'string' ? candidate.authorId : null;
    const counts = countsByKind.get(row.kind) ?? countsByStatus();
    counts[status]++;
    countsByKind.set(row.kind, counts);
    hash.update(JSON.stringify([packageId, row.sourceRecordId, row.sourceId, row.kind, row.targetId,
      row.disposition, row.expectedAuthorId, status, actualAuthorId])).update('\n');
    if (window?.packageId === packageId && window.kind === row.kind && window.status === status) {
      if (total >= window.offset && rows.length < window.limit) {
        rows.push({ sourceRecordId: row.sourceRecordId, sourceId: row.sourceId, kind: row.kind, status,
          targetId: row.targetId, expectedAuthorId: row.expectedAuthorId, actualAuthorId });
      }
      total++;
    }
  }
  const packages: MigrationAuthorPackageReview[] = [...packageCounts].map(([packageId, kinds]) => ({ packageId,
    kinds: MIGRATION_AUTHOR_KINDS.flatMap(kind => kinds.has(kind) ? [{ kind, counts: kinds.get(kind)! }] : []),
  }));
  return { audit: { version: 1, packages, fingerprint: hash.digest('hex') }, rows, total };
}
