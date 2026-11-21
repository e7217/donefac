import { createHash, randomUUID } from 'node:crypto';
import type { Attachment, DocPage } from '../shared/types.js';
import { attachmentId, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, safeFilename, sniffMime, type AttachmentFiles } from './attachments.js';
import type { AttachmentVersionsService } from './attachment-versions.js';
import { attachmentContentPath, decodedContentPath, documentUrlReferences, workspaceContentOrigins, workspaceContentUrl } from './document-content-urls.js';
import type { Store } from './store.js';

const MAX_COPY_ATTACHMENTS = 1500;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type CopiedFile = { attachment: Attachment; bytes: Buffer };
export interface DocumentCopyAssetPlan {
  fingerprint: string;
  attachmentCount: number;
  attachmentBytes: number;
  warnings: string[];
  materialize(copies: readonly DocPage[], ids: ReadonlyMap<string, string>, authorId: string, createdAt: string): CopiedFile[];
}

export class DocumentCopyAssetError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class DocumentCopyAssets {
  constructor(private readonly store: Store, private readonly files: AttachmentFiles, private readonly versions: AttachmentVersionsService) {}

  plan(documents: readonly DocPage[], origins: readonly string[]): DocumentCopyAssetPlan {
    const documentIds = new Set(documents.map(document => document.id));
    const files = new Map<string, Attachment>();
    const references = new Map<string, { id: string; inline: boolean }>();
    const warnings: string[] = [];
    let attachmentBytes = 0;

    function add(file: Attachment) {
      if (files.has(file.id)) return;
      let filename: string;
      try { attachmentId(file.id); filename = safeFilename(file.filename); }
      catch { throw new DocumentCopyAssetError(422, '복제할 첨부파일의 이름과 식별자를 확인해 주세요.'); }
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES || !/^[a-f\d]{64}$/u.test(file.sha256)) {
        throw new DocumentCopyAssetError(422, '복제할 첨부파일의 크기와 해시를 확인해 주세요.');
      }
      attachmentBytes += file.size;
      files.set(file.id, { ...file, filename });
      if (files.size > MAX_COPY_ATTACHMENTS || attachmentBytes > MAX_PACKAGE_BYTES) {
        throw new DocumentCopyAssetError(413, `문서 복제는 첨부파일 ${MAX_COPY_ATTACHMENTS.toLocaleString('ko-KR')}개와 합계 64MiB까지 지원합니다.`);
      }
    }

    const visible = this.store.db.prepare("SELECT json FROM attachments WHERE resource_type='document' AND resource_id=? ORDER BY rowid");
    for (const page of documents) {
      for (const row of visible.iterate(page.id) as Iterable<{ json: string }>) {
        const attachment = JSON.parse(row.json) as Attachment;
        const head = this.versions.head(attachment);
        const current = head.currentVersionId === attachment.id ? attachment : this.store.get<Attachment>('attachment_versions', head.currentVersionId);
        if (!current || current.resourceType !== 'document' || current.resourceId !== page.id) {
          throw new DocumentCopyAssetError(422, '복제할 문서의 최신 첨부파일을 확인할 수 없습니다.');
        }
        add(current);
      }
    }

    const workspaceOrigins = workspaceContentOrigins(origins);
    const metadata = new Map<string, Attachment | undefined>();
    for (const page of documents) {
      const unavailable = new Set<string>();
      for (const reference of documentUrlReferences(page.content)) {
        const url = workspaceContentUrl(reference.value, workspaceOrigins);
        if (!url || url.username || url.password) continue;
        const match = attachmentContentPath.exec(decodedContentPath(url));
        if (!match) continue;
        let id: string;
        try { id = attachmentId(match[1] ?? match[2]); }
        catch { unavailable.add(reference.value); continue; }
        const versionPath = match[2] !== undefined;
        const lookup = versionPath ? `version:${id}` : id;
        if (!metadata.has(lookup)) {
          const tables = versionPath ? ['attachment_versions', 'attachments'] : ['attachments', 'attachment_versions'];
          metadata.set(lookup, this.store.get<Attachment>(tables[0], id) ?? this.store.get<Attachment>(tables[1], id));
        }
        const file = metadata.get(lookup);
        if (!file) { unavailable.add(reference.value); continue; }
        if (file.resourceType !== 'document' || !documentIds.has(file.resourceId)) continue;
        if (reference.key === 'src' && !INLINE_IMAGE_TYPES.has(file.mimeType)) { unavailable.add(reference.value); continue; }
        add(file);
        references.set(JSON.stringify([reference.key, reference.value]), {
          id: file.id, inline: reference.key === 'src' || url.searchParams.get('inline') === '1' && INLINE_IMAGE_TYPES.has(file.mimeType),
        });
      }
      if (unavailable.size) warnings.push(`${page.title} · 확인이 필요한 첨부 주소 ${unavailable.size}개`);
    }

    const fingerprint = createHash('sha256').update(JSON.stringify({ files: [...files.values()], references: [...references], warnings })).digest('hex');
    return {
      fingerprint, attachmentCount: files.size, attachmentBytes, warnings,
      materialize: (copies, ids, authorId, createdAt) => {
        const bySource = new Map<string, CopiedFile>();
        for (const file of files.values()) {
          const resourceId = ids.get(file.resourceId);
          if (!resourceId) throw new Error('Missing copied document for attachment.');
          let bytes: Buffer;
          try { bytes = this.files.read(file); }
          catch { throw new DocumentCopyAssetError(422, `첨부파일을 읽거나 무결성을 확인할 수 없습니다. ${file.filename}`); }
          const { filename, size, sha256 } = file;
          bySource.set(file.id, { attachment: {
            id: randomUUID(), resourceType: 'document', resourceId, filename, mimeType: sniffMime(bytes), size, sha256, authorId, createdAt,
          }, bytes });
        }
        for (const page of copies) for (const reference of documentUrlReferences(page.content)) {
          const mapped = references.get(JSON.stringify([reference.key, reference.value]));
          if (!mapped) continue;
          const copied = bySource.get(mapped.id);
          if (!copied) throw new Error('Missing copied attachment for body reference.');
          if (mapped.inline && !INLINE_IMAGE_TYPES.has(copied.attachment.mimeType)) {
            throw new DocumentCopyAssetError(422, `첨부 이미지의 형식을 확인해 주세요. ${copied.attachment.filename}`);
          }
          reference.attrs[reference.key] = `/api/attachments/${copied.attachment.id}/content${mapped.inline ? '?inline=1' : ''}`;
        }
        return [...bySource.values()];
      },
    };
  }
}
