import { randomUUID } from 'node:crypto';
import type { Attachment, DocumentTemplate, RichContent } from '../shared/types.js';
import { attachmentId, hash, MAX_EXPORT_BYTES, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, safeFilename, sniffMime, type AttachmentFiles } from './attachments.js';
import { creationRequestId } from './creation-request.js';
import { MAX_DOCUMENT_BYTES } from './document-content.js';
import { attachmentContentPath, contentOriginPlaceholder, decodedContentPath, documentUrlReferences, isRelativeContentUrl, parseContentUrl,
  workspaceContentOrigins, workspaceContentUrl, type DocumentUrlReference } from './document-content-urls.js';
import { DocumentTemplateError } from './document-templates.js';
import type { Store } from './store.js';

export type TemplateAsset = Pick<Attachment, 'id' | 'filename' | 'mimeType' | 'size' | 'sha256'> & { bytes: Buffer };
type AssetBackup = Omit<TemplateAsset, 'bytes'> & { templateId: string; data: string };
type TemplateAssetSet = { templateId: string; assets: TemplateAsset[] };
type StoredAsset = Omit<TemplateAsset, 'bytes'> & { templateId: string; bytes: Uint8Array };

const markerBase = '/api/document-template-assets';
const markerPath = /^\/api\/document-template-assets(?:\/|$)/iu;
const markerUrl = /^\/api\/document-template-assets\/([a-f\d-]+)(\?inline=1)?$/u;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const backupFields = new Set(['id', 'templateId', 'filename', 'mimeType', 'size', 'sha256', 'data']);
const digest = /^[a-f\d]{64}$/u;
const storedColumns = 'id,template_id AS templateId,filename,mime_type AS mimeType,size,sha256,bytes';

function assetId(value: unknown): value is string {
  return typeof value === 'string' && value === value.toLowerCase() && creationRequestId.test(value);
}

function assetError(message: string, status = 422): never {
  throw new DocumentTemplateError(status, message, 'attachment_reference');
}

function invalidBackup(): never {
  throw new DocumentTemplateError(400, '백업의 문서 템플릿 첨부파일과 본문 참조를 확인해 주세요.', 'invalid_backup');
}

function storedAssetError(): never {
  return assetError('템플릿에 보관한 첨부파일을 읽거나 무결성을 확인할 수 없습니다.', 503);
}

function tooManyBytes(error: 'capture' | 'stored'): never {
  return error === 'capture'
    ? assetError('한 문서 템플릿의 첨부파일은 합계 64MiB 이하여야 합니다.', 413)
    : storedAssetError();
}

function attachmentHref(path: string, inline: boolean) {
  return `${path}${inline ? '?inline=1' : ''}`;
}

function decodeMarker(reference: DocumentUrlReference, fail: () => never) {
  // Absolute and protocol-relative external URLs can use the same path on their own server.
  if (!isRelativeContentUrl(reference.value)) return;
  const url = parseContentUrl(reference.value, contentOriginPlaceholder);
  if (!url || url.origin !== contentOriginPlaceholder) return;
  const path = decodedContentPath(url);
  if (attachmentContentPath.test(path)) return fail();
  if (!markerPath.test(path)) return;
  const marker = markerUrl.exec(reference.value);
  if (!marker || !assetId(marker[1]) || (reference.key === 'src' && !marker[2])) return fail();
  return { id: marker[1], inline: Boolean(marker[2]) };
}

function validateRefs(content: RichContent, assets: readonly TemplateAsset[], fail: () => never) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const used = new Set<string>();
  const resolved: { reference: DocumentUrlReference; id: string; inline: boolean }[] = [];
  for (const reference of documentUrlReferences(content)) {
    const marker = decodeMarker(reference, fail);
    if (!marker) continue;
    const asset = byId.get(marker.id);
    if (!asset || (marker.inline && !imageTypes.has(asset.mimeType))) return fail();
    used.add(marker.id);
    resolved.push({ reference, ...marker });
  }
  if (used.size !== assets.length) return fail();
  return resolved;
}

function checkMetadata(value: { filename: unknown; mimeType: unknown; size: unknown; sha256: unknown }): boolean {
  try {
    return safeFilename(value.filename) === value.filename && typeof value.mimeType === 'string' &&
      typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_FILE_BYTES &&
      typeof value.sha256 === 'string' && digest.test(value.sha256);
  } catch { return false; }
}

function checkBytes(asset: TemplateAsset) {
  return asset.bytes.length === asset.size && hash(asset.bytes) === asset.sha256 && sniffMime(asset.bytes) === asset.mimeType;
}

function fromStored({ id, filename, mimeType, size, sha256, bytes }: StoredAsset): TemplateAsset {
  const metadata = { id, filename, mimeType, size, sha256 };
  if (!assetId(id) || !checkMetadata(metadata) || !(bytes instanceof Uint8Array)) return storedAssetError();
  const asset = { ...metadata, bytes: Buffer.from(bytes) };
  if (!checkBytes(asset)) return storedAssetError();
  return asset;
}

export class DocumentTemplateAssetsService {
  constructor(private readonly store: Store, private readonly files: AttachmentFiles) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS document_template_assets (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size BETWEEN 1 AND ${MAX_FILE_BYTES}),
        sha256 TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes)=size)
      );
      CREATE INDEX IF NOT EXISTS document_template_asset_owner ON document_template_assets (template_id);
    `);
  }

  capture(content: RichContent, sourceDocumentId: string, origins: readonly string[]): { content: RichContent; assets: TemplateAsset[] } {
    const workspaceOrigins = workspaceContentOrigins(origins);
    const rewritten = structuredClone(content);
    const byFile = new Map<string, TemplateAsset>();
    let total = 0;
    for (const reference of documentUrlReferences(rewritten)) {
      const url = workspaceContentUrl(reference.value, workspaceOrigins);
      if (!url) continue;
      const path = decodedContentPath(url);
      if (markerPath.test(path)) assetError('문서에 첨부된 원본 파일 주소를 사용해 주세요.');
      const match = attachmentContentPath.exec(path);
      if (!match) continue;
      let id: string;
      try { id = attachmentId(match[1] ?? match[2]); }
      catch { return assetError('문서의 첨부파일 주소를 확인해 주세요.'); }
      if (url.username || url.password) return assetError('문서의 첨부파일 주소를 확인해 주세요.');
      let asset = byFile.get(id);
      if (!asset) {
        const tables = match[2] === undefined ? ['attachments', 'attachment_versions'] : ['attachment_versions', 'attachments'];
        const file = this.store.get<Attachment>(tables[0], id) ?? this.store.get<Attachment>(tables[1], id);
        if (!file || file.id !== id || file.resourceType !== 'document' || file.resourceId !== sourceDocumentId) {
          return assetError('원본 문서에서 이 첨부파일을 찾을 수 없습니다.');
        }
        let filename: string;
        try { filename = safeFilename(file.filename); }
        catch { return assetError('원본 문서의 첨부파일 정보를 확인해 주세요.'); }
        if (!checkMetadata({ ...file, filename })) return assetError('원본 문서의 첨부파일 정보를 확인해 주세요.');
        total += file.size;
        if (total > MAX_PACKAGE_BYTES) return tooManyBytes('capture');
        let bytes: Buffer;
        try { bytes = this.files.read(file); }
        catch { return assetError('원본 문서의 첨부파일을 읽거나 무결성을 확인할 수 없습니다.'); }
        if (sniffMime(bytes) !== file.mimeType) return assetError('원본 문서의 첨부파일 형식이 일치하지 않습니다.');
        asset = { id: randomUUID(), filename, mimeType: file.mimeType, size: file.size, sha256: file.sha256, bytes };
        byFile.set(id, asset);
      }
      const isImage = imageTypes.has(asset.mimeType);
      if (reference.key === 'src' && !isImage) assetError('템플릿에 표시할 첨부 이미지의 파일 형식을 확인해 주세요.');
      const inline = reference.key === 'src' || (isImage && url.searchParams.get('inline') === '1');
      reference.attrs[reference.key] = attachmentHref(`${markerBase}/${asset.id}`, inline);
    }
    if (byFile.size && Buffer.byteLength(JSON.stringify(rewritten)) > MAX_DOCUMENT_BYTES) {
      return assetError('첨부파일 참조를 포함한 템플릿 본문이 크기 한도를 초과했습니다.', 413);
    }
    return { content: rewritten, assets: [...byFile.values()] };
  }

  replace(templateId: string, assets: readonly TemplateAsset[]): void {
    this.assertTransaction();
    this.store.db.prepare('DELETE FROM document_template_assets WHERE template_id=?').run(templateId);
    this.insert(templateId, assets);
  }

  forDraft(templateId: string, content: RichContent, documentId: string, authorId: string, createdAt: string):
  { content: RichContent; files: { attachment: Attachment; bytes: Buffer }[] } {
    const { total } = this.store.db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM document_template_assets WHERE template_id=?')
      .get(templateId) as { total: number };
    if (total > MAX_PACKAGE_BYTES) return tooManyBytes('stored');
    const rows = this.store.db.prepare(`SELECT ${storedColumns} FROM document_template_assets WHERE template_id=? ORDER BY rowid`)
      .all(templateId) as unknown as StoredAsset[];
    const assets = rows.map(fromStored);
    const rewritten = structuredClone(content);
    const markers = validateRefs(rewritten, assets, storedAssetError);
    const copies = new Map(assets.map(({ id, bytes, ...metadata }) => [id, {
      attachment: { ...metadata, id: randomUUID(), resourceType: 'document', resourceId: documentId, authorId, createdAt } satisfies Attachment,
      bytes,
    }]));
    for (const { reference, id, inline } of markers) {
      const copy = copies.get(id);
      if (!copy) return storedAssetError();
      reference.attrs[reference.key] = attachmentHref(`/api/attachments/${copy.attachment.id}/content`, inline);
    }
    return { content: rewritten, files: [...copies.values()] };
  }

  /** Estimate encoded binary bytes without loading any BLOBs. */
  exportBytes(): number {
    const { total } = this.store.db.prepare('SELECT COALESCE(SUM(((length(bytes)+2)/3)*4),0) AS total FROM document_template_assets')
      .get() as { total: number };
    return total;
  }

  export(): AssetBackup[] {
    if (this.exportBytes() > MAX_EXPORT_BYTES) return assetError('템플릿 첨부파일을 포함한 전체 내보내기 파일은 64MiB 미만이어야 합니다. 운영 파일 백업을 사용해 주세요.', 413);
    const statement = this.store.db.prepare(`SELECT ${storedColumns} FROM document_template_assets ORDER BY template_id,id`);
    const result: AssetBackup[] = [];
    for (const row of statement.iterate() as Iterable<unknown>) {
      const stored = row as StoredAsset;
      const { bytes, ...metadata } = fromStored(stored);
      result.push({ ...metadata, templateId: stored.templateId, data: bytes.toString('base64') });
    }
    return result;
  }

  validateRestore(raw: unknown, templates: readonly DocumentTemplate[]): readonly TemplateAssetSet[] {
    if (!Array.isArray(raw)) return invalidBackup();
    const byTemplate = new Map(templates.map(template => [template.id, { total: 0, assets: [] as TemplateAsset[] }]));
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !backupFields.has(key))) return invalidBackup();
      const { id, templateId, data, filename, mimeType, size, sha256 } = entry as Record<string, unknown>;
      if (!assetId(id) || seen.has(id) || typeof templateId !== 'string' || typeof filename !== 'string' ||
          typeof mimeType !== 'string' || typeof size !== 'number' || typeof sha256 !== 'string' ||
          !checkMetadata({ filename, mimeType, size, sha256 }) || typeof data !== 'string' || data.length !== Math.ceil(size / 3) * 4) return invalidBackup();
      const group = byTemplate.get(templateId);
      if (!group || group.total + size > MAX_PACKAGE_BYTES) return invalidBackup();
      const asset = { id, filename, mimeType, size, sha256, bytes: Buffer.from(data, 'base64') };
      if (asset.bytes.toString('base64') !== data || !checkBytes(asset)) return invalidBackup();
      group.total += size;
      group.assets.push(asset);
      seen.add(id);
    }
    const restored: TemplateAssetSet[] = [];
    for (const template of templates) {
      const assets = byTemplate.get(template.id)?.assets ?? [];
      if ((template.attachmentCount ?? 0) !== assets.length) return invalidBackup();
      validateRefs(template.content, assets, invalidBackup);
      if (assets.length) restored.push({ templateId: template.id, assets });
    }
    return restored;
  }

  restore(restored: readonly TemplateAssetSet[]): void {
    this.assertTransaction();
    this.store.db.exec('DELETE FROM document_template_assets;');
    for (const { templateId, assets } of restored) this.insert(templateId, assets);
  }

  private assertTransaction() {
    if (!this.store.db.isTransaction) throw new Error('Document template asset writes require a transaction.');
  }

  private insert(templateId: string, assets: readonly TemplateAsset[]) {
    const insert = this.store.db.prepare('INSERT INTO document_template_assets (id,template_id,filename,mime_type,size,sha256,bytes) VALUES (?,?,?,?,?,?,?)');
    for (const asset of assets) insert.run(asset.id, templateId, asset.filename, asset.mimeType, asset.size, asset.sha256, asset.bytes);
  }
}
