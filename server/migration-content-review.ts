import { MAX_DOCUMENT_BYTES } from '../shared/document-nodes.js';
import type { MigrationContentReviewDetail, MigrationContentReviewPage, MigrationContentReviewRow } from '../shared/types.js';
import { LegacyImportError } from './legacy-import-model.js';
import type { PreparedMigration } from './migration-contracts.js';
import type { Store } from './store.js';

const casefold = (value: string) => value.normalize('NFC').toLocaleLowerCase('ko-KR');
const fail = (status: number, message: string): never => { throw new LegacyImportError(status, message); };
const queryError = '이관 내용 조회 조건을 확인해 주세요.';
const missingContent = '이 미리보기에서 확인할 이관 내용을 찾을 수 없습니다.';
const projections = ['issues', 'documents', 'issueUpdates', 'documentUpdates'] as const;
type ReviewTarget = { title: string; projection: string; change: MigrationContentReviewRow['change']; sourceUrl?: string };

const packageKey = (sha256: string, product: string, instanceKey: string) => JSON.stringify([sha256, product, instanceKey]);

export function installMigrationContentReview(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS migration_preview_content_header (
    preview_id TEXT PRIMARY KEY REFERENCES migration_previews(id) ON DELETE CASCADE,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS migration_preview_content (
    preview_id TEXT NOT NULL REFERENCES migration_previews(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    record_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    search_text TEXT NOT NULL,
    row_json TEXT NOT NULL,
    projection TEXT NOT NULL,
    source_url TEXT,
    PRIMARY KEY (preview_id, position),
    UNIQUE (preview_id, record_id)
  )`);
}

export function storeMigrationContentReview(store: Store, prepared: PreparedMigration) {
  const packages = new Map(prepared.sourceImport.packages.map(({ stagingId, sha256, source }) =>
    [packageKey(sha256, source.product, source.instanceKey), stagingId]));
  const links = new Map((prepared.atlassianLinks ?? []).map(({ targetId, url }) => [targetId, url]));
  const newTargets = new Map<string, ReviewTarget>();
  for (const [projection, items] of [['issues', prepared.issues], ['documents', prepared.documents]] as const) {
    items.forEach(({ id, title }, index) => newTargets.set(id, { title, change: 'new',
      projection: `$.${projection}[${index}]`, sourceUrl: links.get(id) }));
  }
  const updates = new Map<string, ReviewTarget & { targetId: string }>();
  prepared.issueUpdates?.forEach(({ issueId, changes, contentReview }, index) => {
    if (contentReview && changes.description !== undefined) updates.set(contentReview.recordId, {
      title: contentReview.title, targetId: issueId, change: 'update', projection: `$.issueUpdates[${index}].changes`,
    });
  });
  prepared.documentUpdates?.forEach(({ documentId, changes, contentReview }, index) => {
    if (contentReview && changes.content !== undefined) updates.set(contentReview.recordId, {
      title: contentReview.title, targetId: documentId, change: 'update', projection: `$.documentUpdates[${index}].changes`,
    });
  });
  const insert = store.db.prepare(`INSERT INTO migration_preview_content
    (preview_id,position,record_id,package_id,search_text,row_json,projection,source_url)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const [position, { excluded, targetId, targetType, record, packageSha256, source }] of prepared.sourceRecords.entries()) {
    if (excluded || !targetId || !(record.kind === 'issue' && source.product === 'jira' && targetType === 'issue' ||
        record.kind === 'page' && source.product === 'confluence' && targetType === 'document')) continue;
    const packageId = packages.get(packageKey(packageSha256, source.product, source.instanceKey));
    if (!packageId) continue;
    const recordId = `${packageId}/${record.id}`;
    const update = updates.get(recordId);
    const target = newTargets.get(targetId) ?? (update?.targetId === targetId ? update : undefined);
    if (!target) continue;
    const key = record.metadata.key;
    const sourceKey = record.kind === 'issue' && typeof key === 'string' && key.length > 0 && key.length <= 500 &&
      key.isWellFormed() && !/\p{Cc}/u.test(key) ? key : undefined;
    const review: MigrationContentReviewRow = { recordId, packageId, targetType, sourceId: record.sourceId,
      title: target.title, change: target.change, ...(sourceKey ? { sourceKey } : {}) };
    insert.run(prepared.preview.id, position, recordId, packageId, casefold([target.title, record.sourceId, sourceKey].join('\n')),
      JSON.stringify(review), target.projection, target.sourceUrl ?? null);
  }
}

export function migrationContentReviewNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value) || Number(value) < min || Number(value) > max) return fail(400, queryError);
  return Number(value);
}

export function migrationContentReviewList(store: Store, previewId: string, version: number, packageId: string | undefined,
  query: Record<string, unknown>): MigrationContentReviewPage {
  if (Object.keys(query).some(key => !['expectedVersion', 'packageId', 'q', 'offset', 'limit'].includes(key))) fail(400, queryError);
  const { q, offset, limit } = query;
  if (q !== undefined && (typeof q !== 'string' || q.length > 200 || !q.isWellFormed() || /\p{Cc}/u.test(q))) fail(400, queryError);
  const start = offset === undefined ? 0 : migrationContentReviewNumber(offset, 0, 100_000);
  const size = limit === undefined ? 25 : migrationContentReviewNumber(limit, 1, 50);
  const search = typeof q === 'string' ? casefold(q.trim()) : '';
  const match = `FROM migration_preview_content WHERE preview_id=? AND (? IS NULL OR package_id=?) AND (?='' OR instr(search_text, ?)>0)`;
  const params = [previewId, packageId ?? null, packageId ?? null, search, search];
  const { total } = store.db.prepare(`SELECT COUNT(*) AS total ${match}`).get(...params) as { total: number };
  const rows = store.db.prepare(`SELECT row_json ${match} ORDER BY position LIMIT ? OFFSET ?`)
    .all(...params, size, start) as { row_json: string }[];
  return { previewId, version, total, offset: start, limit: size, rows: rows.map(({ row_json }) => JSON.parse(row_json) as MigrationContentReviewRow) };
}

export function migrationContentReviewDetail(store: Store, previewId: string, recordId: string): MigrationContentReviewDetail {
  const indexed = store.db.prepare(`SELECT row_json, projection, source_url FROM migration_preview_content WHERE preview_id=? AND record_id=?`)
    .get(previewId, recordId) as { row_json: string; projection: string; source_url: string | null } | undefined;
  if (!indexed) return fail(404, missingContent);
  const row = JSON.parse(indexed.row_json) as MigrationContentReviewRow;
  const path = indexed.projection;
  const expected = row.targetType === 'issue' ? row.change === 'new' ? projections[0] : projections[2]
    : row.change === 'new' ? projections[1] : projections[3];
  if (!path.startsWith(`$.${expected}[`)) return fail(404, missingContent);
  const fields = row.targetType === 'issue'
    ? row.change === 'new' ? ['description', 'descriptionFormat', 'startDate', 'endDate'] : ['description', 'descriptionFormat']
    : ['content'];
  const projection = fields.map(field => `'${field}', json_extract(json, ?)`).join(', ');
  const detail = store.db.prepare(`SELECT json_object(${projection}) AS body FROM migration_previews WHERE id=?`)
    .get(...fields.map(field => `${path}.${field}`), previewId) as { body: string } | undefined;
  if (!detail) return fail(404, missingContent);
  if (Buffer.byteLength(detail.body) > MAX_DOCUMENT_BYTES + 1024) return fail(413, '변환한 본문이 조회 한도를 초과했습니다.');
  const { description, descriptionFormat, content, startDate, endDate } = JSON.parse(detail.body) as
    Pick<MigrationContentReviewDetail, 'description' | 'descriptionFormat' | 'content'> & { startDate?: string; endDate?: string };
  const source = indexed.source_url ? { sourceUrl: indexed.source_url } : {};
  if (row.targetType === 'document') {
    if (!content) return fail(404, missingContent);
    return { ...row, ...source, content };
  }
  if (typeof description !== 'string') return fail(404, missingContent);
  if (description.length > 200_000) return fail(413, '변환한 설명이 조회 한도를 초과했습니다.');
  const schedule = startDate || endDate ? { startDate: startDate ?? null, endDate: endDate ?? null } : undefined;
  return { ...row, ...source, description, descriptionFormat: descriptionFormat ?? 'plain', ...(schedule ? { schedule } : {}) };
}
