import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { MAX_MARKDOWN_ARCHIVE_BYTES, type DocumentMarkdownArchiveTarget } from '../shared/document-markdown-archive.js';
import { readArchiveMarkdown } from '../shared/document-markdown-import.js';
import { documentSectionHash } from '../shared/document-sections.js';
import type { Attachment, DocPage } from '../shared/types.js';
import { hash, sniffMime } from './attachments.js';
import { normalizeDocumentContent } from './document-content.js';
import { LegacyArchiveError } from './legacy-import-archive.js';
import { readMarkdownArchive } from './markdown-archive-format.js';

type ImportOptions = DocumentMarkdownArchiveTarget & { actorId: string; timestamp: string };
type ImportedAttachment = { attachment: Attachment; bytes: Buffer };

const rasterImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function archiveDestination(sourcePath: string, address: string): { path: string; fragment: string } | null {
  if (!address || address.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(address)) return null;
  try {
    const at = address.indexOf('#');
    const pathname = (at < 0 ? address : address.slice(0, at)).split('?', 1)[0];
    const decodedPath = decodeURIComponent(pathname);
    const fragment = at < 0 ? '' : decodeURIComponent(address.slice(at + 1));
    if (/[\\\x00-\x1f\x7f]/.test(decodedPath) || /[\x00-\x1f\x7f]/.test(fragment) || decodedPath.startsWith('//')) return null;
    if (!decodedPath) return { path: sourcePath, fragment };
    const path = decodedPath.startsWith('/') ? posix.normalize(decodedPath.slice(1)) : posix.join(posix.dirname(sourcePath), decodedPath);
    if (path === '..' || path.startsWith('../') || path === '.') return null;
    return { path, fragment };
  } catch {
    return null;
  }
}

export async function prepareMarkdownArchive(bytes: Buffer, { projectId, parentId, actorId, timestamp }: ImportOptions) {
  const source = await readMarkdownArchive(bytes);
  const ids = new Map(source.pages.map(page => [page.path, randomUUID()]));
  const readers = new Map<string, ReturnType<typeof readArchiveMarkdown>>();
  const attachments = new Map<string, ImportedAttachment>();
  const warnings = [...source.warnings];
  const routeSpace = projectId ?? 'all';

  function attach(path: string, ownerPath: string) {
    const existing = attachments.get(path);
    if (existing) return existing.attachment;
    const file = source.files.get(path);
    if (!file?.bytes.length) return undefined;
    const owner = ids.get(file.ownerPath ?? ownerPath);
    if (!owner) return undefined;
    const attachment: Attachment = {
      id: randomUUID(), resourceType: 'document', resourceId: owner, filename: file.name, mimeType: sniffMime(file.bytes),
      size: file.bytes.length, sha256: hash(file.bytes), authorId: actorId, createdAt: timestamp,
    };
    attachments.set(path, { attachment, bytes: file.bytes });
    return attachment;
  }

  for (const [path, file] of source.files) {
    if (file.ownerPath) attach(path, file.ownerPath);
  }

  for (const page of source.pages) {
    try {
      readers.set(page.path, readArchiveMarkdown(page.markdown, {
        exportedTitle: source.format === 'teamspace',
        sectionMarkers: source.format === 'teamspace',
        resolve(address) {
          const target = archiveDestination(page.path, address);
          if (!target) return undefined;
          const documentId = ids.get(target.path);
          if (documentId) {
            const section = target.fragment ? readers.get(target.path)?.sectionId(target.fragment) : undefined;
            if (target.fragment && !section) return undefined;
            return { href: section ? documentSectionHash(documentId, section, routeSpace) :
              `#/${encodeURIComponent(routeSpace)}/documents/${documentId}` };
          }
          const attachment = attach(target.path, page.path);
          if (!attachment) return undefined;
          const href = `/api/attachments/${attachment.id}/content`;
          return { href, ...(rasterImages.has(attachment.mimeType) ? { imageSrc: `${href}?inline=1` } : {}) };
        },
      }));
    } catch (error) {
      throw new LegacyArchiveError(400, `${page.path}: ${error instanceof Error ? error.message : 'Markdown을 읽을 수 없습니다.'}`);
    }
  }

  let contentBytes = 0;
  const documents: DocPage[] = source.pages.map(page => {
    try {
      const parsed = readers.get(page.path)!.build();
      const { content, plainText } = normalizeDocumentContent(parsed.content);
      contentBytes += Buffer.byteLength(JSON.stringify(content));
      if (contentBytes > MAX_MARKDOWN_ARCHIVE_BYTES) throw new LegacyArchiveError(413, '변환한 문서 본문의 합계가 64 MiB를 넘습니다. ZIP을 나누어 주세요.');
      for (const warning of parsed.warnings) {
        warnings.push({ path: page.path, message: `${warning.message}${warning.count > 1 ? ` (${warning.count}건)` : ''}` });
      }
      const fallback = posix.basename(page.path).replace(/\.md$/iu, '').trim();
      return {
        id: ids.get(page.path)!, projectId, parentId: page.parentPath ? ids.get(page.parentPath)! : parentId,
        title: page.title || parsed.suggestedTitle || fallback.slice(0, 300).toWellFormed() || '제목 없는 문서',
        icon: page.icon || '📄', status: 'draft', version: 1, content, plainText, authorId: actorId,
        createdAt: timestamp, updatedAt: timestamp,
      };
    } catch (error) {
      if (error instanceof LegacyArchiveError) throw error;
      throw new LegacyArchiveError(400, `${page.path}: ${error instanceof Error ? error.message : 'Markdown을 변환할 수 없습니다.'}`);
    }
  });

  const counts = new Map<string, number>();
  for (const { attachment } of attachments.values()) {
    const owner = attachment.resourceId;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  for (const path of source.files.keys()) {
    if (!attachments.has(path)) warnings.push({ path, message: '연결할 문서가 확인되지 않거나 비어 있는 파일입니다.' });
  }

  return {
    format: source.format, documents, warnings,
    pages: source.pages.map(({ path, parentPath }, index) => ({
      path, parentPath, title: documents[index].title, attachmentCount: counts.get(documents[index].id) ?? 0,
    })),
    attachments: [...attachments.values()],
  };
}
