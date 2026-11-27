import { posix } from 'node:path';
import { MAX_MARKDOWN_ARCHIVE_BYTES, type DocumentMarkdownArchiveFormat, type DocumentMarkdownArchiveWarning } from '../shared/document-markdown-archive.js';
import { MAX_MARKDOWN_IMPORT_BYTES } from '../shared/document-markdown-import.js';
import { MAX_FILE_BYTES, safeFilename } from './attachments.js';
import { documentArchiveAttachmentFooter, documentArchiveAttachmentLink } from './document-export.js';
import { currentProductFormat, LEGACY_PRODUCT_ID } from '../shared/legacy-name.js';
import { LegacyArchiveError, readLegacyArchive } from './legacy-import-archive.js';

const MAX_DOCUMENTS = 500;
const MAX_ATTACHMENTS = 1500;
const MAX_DIAGNOSTICS = 10_000;
const donefacManifest = 'manifest.json';
const docmostManifest = 'docmost-metadata.json';
const donefacFormat = 'donefac-document-markdown';
const legacyDonefacFormat = `${LEGACY_PRODUCT_ID}-document-markdown`;
const markdownExtension = /\.md$/iu;
const docmostAttachmentId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;

export interface MarkdownArchivePage {
  path: string;
  parentPath: string | null;
  title?: string;
  icon?: string;
  markdown: string;
}

export interface MarkdownArchiveSource {
  format: DocumentMarkdownArchiveFormat;
  pages: MarkdownArchivePage[];
  files: Map<string, { name: string; bytes: Buffer; ownerPath?: string }>;
  warnings: DocumentMarkdownArchiveWarning[];
}

function fail(message: string, status = 400): never {
  throw new LegacyArchiveError(status, message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\p{Cc}/u.test(value);
}

function limitPages(count: number): void {
  if (count < 1) fail('가져올 Markdown 문서가 없습니다.');
  if (count > MAX_DOCUMENTS) fail(`한 번에 문서 ${MAX_DOCUMENTS}개까지 가져올 수 있습니다.`, 413);
}

function limitFiles(count: number): void {
  if (count > MAX_ATTACHMENTS) fail(`한 번에 첨부파일 ${MAX_ATTACHMENTS}개까지 가져올 수 있습니다.`, 413);
}

function utf8(bytes: Buffer, path: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail(`${path}: UTF-8 파일을 확인해 주세요.`); }
}

function markdownText(bytes: Buffer, path: string): string {
  if (bytes.length > MAX_MARKDOWN_IMPORT_BYTES) fail(`${path}: Markdown 문서는 512 KiB까지 가져올 수 있습니다.`, 413);
  const text = utf8(bytes, path);
  if (text.includes('\u0000')) fail(`${path}: Markdown 문자의 인코딩을 확인해 주세요.`);
  return text;
}

function namedFile(value: unknown): string {
  try { return safeFilename(value); }
  catch { return fail('ZIP 첨부파일의 파일명을 확인해 주세요.'); }
}

function pageOrder(pages: MarkdownArchivePage[]): MarkdownArchivePage[] {
  const siblings = new Map<string | null, MarkdownArchivePage[]>();
  for (const page of pages) {
    const group = siblings.get(page.parentPath);
    if (group) group.push(page);
    else siblings.set(page.parentPath, [page]);
  }
  const ordered: MarkdownArchivePage[] = [];
  const pending = [...(siblings.get(null) ?? [])].reverse();
  while (pending.length) {
    const page = pending.pop()!;
    ordered.push(page);
    const children = siblings.get(page.path) ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  if (pages.length !== ordered.length) fail('문서의 상위 경로가 없거나 계층에 순환 관계가 있습니다.');
  return ordered;
}

function markdownNamedPath(value: unknown): value is string {
  return typeof value === 'string' && markdownExtension.test(value);
}

function readDonefacManifest(bytes: Buffer | undefined): Record<string, unknown> | null {
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(utf8(bytes, donefacManifest)); }
  catch (error) {
    // "manifest.json" by itself is also an ordinary attachment name in a Markdown archive.
    if (bytes.includes(donefacFormat) || bytes.includes(legacyDonefacFormat)) throw error instanceof LegacyArchiveError ? error : new LegacyArchiveError(400, 'Donefac ZIP의 문서 목록을 확인해 주세요.');
    return null;
  }
  return record(value) && currentProductFormat(value.format) === donefacFormat ? value : null;
}

type Archive = Awaited<ReturnType<typeof readLegacyArchive>>;
type AttachmentLinkGroups = Map<string, Set<string>>;

function withoutGeneratedAttachmentFooter(markdown: string, links: AttachmentLinkGroups): string {
  const start = markdown.lastIndexOf(documentArchiveAttachmentFooter);
  if (start < 0 || !markdown.endsWith('\n')) return markdown;
  const body = markdown.slice(0, start);
  // Authored headings have a preceding HTML anchor. The generator appends its
  // separate heading after the trailing newline of the rendered document.
  if (!body.endsWith('\n') || /<a id="[a-zA-Z0-9_-]+" name="[a-zA-Z0-9_-]+"><\/a>\n$/u.test(body)) return markdown;
  const lines = markdown.slice(start + documentArchiveAttachmentFooter.length, -1).split('\n');
  const orderedIds = [...links.keys()].sort(compareText);
  if (lines.length !== orderedIds.length || !orderedIds.every((id, index) => links.get(id)?.has(lines[index]))) return markdown;
  return body;
}

function donefacSource(archive: Archive, manifest: Record<string, unknown>): MarkdownArchiveSource {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.documents) || !Array.isArray(manifest.attachments)) {
    return fail('지원하는 Donefac Markdown ZIP의 문서 목록을 확인해 주세요.');
  }
  limitPages(manifest.documents.length);
  limitFiles(manifest.attachments.length);

  const listedPaths = new Set([donefacManifest, 'README.md']);
  const pathsById = new Map<string, string>();
  const rawPages: { path: string; parentId: string | null; title: string; markdown: string }[] = [];
  for (const row of manifest.documents) {
    if (!record(row) || !identifier(row.id) || pathsById.has(row.id) || !markdownNamedPath(row.path) || listedPaths.has(row.path) ||
        (row.parentId !== null && !identifier(row.parentId)) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 300) {
      return fail('Donefac ZIP의 문서 항목을 확인해 주세요.');
    }
    const bytes = archive.files.get(row.path);
    if (!bytes) return fail(`${row.path}: 문서 목록에 포함된 파일을 찾을 수 없습니다.`);
    listedPaths.add(row.path);
    pathsById.set(row.id, row.path);
    rawPages.push({ path: row.path, parentId: row.parentId, title: row.title, markdown: markdownText(bytes, row.path) });
  }
  const pages = pageOrder(rawPages.map(({ parentId, ...page }) => {
    const parentPath = parentId === null ? null : pathsById.get(parentId);
    if (parentPath === undefined) return fail(`${page.path}: 문서 목록에 상위 문서가 없습니다.`);
    return { ...page, parentPath };
  }));

  const files: MarkdownArchiveSource['files'] = new Map();
  const checksums = new Map(archive.manifest.map(entry => [entry.path, entry.sha256]));
  const attachmentIds = new Set<string>();
  const attachmentLinkGroups = new Map<string, AttachmentLinkGroups>();
  const baseOwners = new Map<string, string>();
  const ambiguousOwners = new Set<string>();
  for (const row of manifest.attachments) {
    if (!record(row) || !identifier(row.id) || attachmentIds.has(row.id) || !identifier(row.attachmentId) ||
        !identifier(row.documentId) || typeof row.path !== 'string' || listedPaths.has(row.path) || typeof row.filename !== 'string' ||
        !Number.isSafeInteger(row.size) || typeof row.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(row.sha256)) {
      return fail('Donefac ZIP의 첨부파일 항목을 확인해 주세요.');
    }
    const bytes = archive.files.get(row.path);
    const ownerPath = pathsById.get(row.documentId);
    if (!ownerPath || !bytes?.length || bytes.length !== row.size || checksums.get(row.path) !== row.sha256) {
      return fail(`${row.path}: 첨부파일의 문서 소유권·크기·SHA-256을 확인해 주세요.`);
    }
    listedPaths.add(row.path);
    attachmentIds.add(row.id);
    const name = namedFile(row.filename);
    files.set(row.path, { name, bytes, ownerPath });
    if (manifest.source === 'saved') {
      const existingOwner = baseOwners.get(row.attachmentId);
      if (existingOwner && existingOwner !== ownerPath) {
        ambiguousOwners.add(existingOwner);
        ambiguousOwners.add(ownerPath);
      } else baseOwners.set(row.attachmentId, ownerPath);
      const groups = attachmentLinkGroups.get(ownerPath) ?? new Map<string, Set<string>>();
      const links = groups.get(row.attachmentId) ?? new Set<string>();
      links.add(documentArchiveAttachmentLink(ownerPath, row.path, row.filename));
      groups.set(row.attachmentId, links);
      attachmentLinkGroups.set(ownerPath, groups);
    }
  }
  for (const path of archive.files.keys()) {
    if (!listedPaths.has(path)) fail(`${path}: Donefac 문서 목록에 없는 ZIP 파일입니다.`);
  }
  for (const page of pages) {
    const groups = attachmentLinkGroups.get(page.path);
    if (groups && !ambiguousOwners.has(page.path)) page.markdown = withoutGeneratedAttachmentFooter(page.markdown, groups);
  }

  const warnings: MarkdownArchiveSource['warnings'] = [];
  if (manifest.diagnostics !== undefined) {
    if (!Array.isArray(manifest.diagnostics) || manifest.diagnostics.length > MAX_DIAGNOSTICS) return fail('Donefac ZIP 참조 진단 수를 확인해 주세요.');
    for (const row of manifest.diagnostics) {
      const path = record(row) && identifier(row.documentId) ? pathsById.get(row.documentId) : undefined;
      if (!record(row) || !path || typeof row.message !== 'string' || !row.message.trim() || row.message.length > 500) {
        return fail('Donefac ZIP의 참조 진단을 확인해 주세요.');
      }
      warnings.push({ path, message: row.message });
    }
  }
  return { format: 'donefac', pages, files, warnings };
}

function normalizeDocmostEntry(name: string): string {
  // JSZip prepends the folder path to Docmost's literal `/files/...` attachment names.
  // Only that shape can have a single redundant separator removed. The ZIP reader
  // then validates both the canonical path and collisions, before reading any bytes.
  const nested = name.indexOf('//files/');
  const atRoot = name.startsWith('/files/');
  if (!atRoot && nested < 1) return name;
  const rest = name.slice(atRoot ? '/files/'.length : nested + '//files/'.length);
  const segments = rest.split('/');
  if (rest && (segments.length !== 2 || !docmostAttachmentId.test(segments[0]))) return name;
  return atRoot ? name.slice(1) : `${name.slice(0, nested)}/files/${rest}`;
}

function decodeDocmostPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 3_072) return fail('Docmost ZIP의 문서 경로를 확인해 주세요.');
  let parts: string[];
  try { parts = value.split('/').map(part => decodeURIComponent(part)); }
  catch { return fail('Docmost ZIP의 문서 경로 인코딩을 확인해 주세요.'); }
  if (parts.some(part => !part || part === '.' || part === '..' || /[/\\\p{Cc}]/u.test(part))) {
    return fail('Docmost ZIP의 문서 경로를 확인해 주세요.');
  }
  return parts.join('/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function remainingFiles(archive: Archive, pagePaths: ReadonlySet<string>, metadataPath?: string): MarkdownArchiveSource['files'] {
  const files: MarkdownArchiveSource['files'] = new Map();
  for (const [path, bytes] of archive.files) {
    if (pagePaths.has(path) || path === metadataPath) continue;
    files.set(path, { name: namedFile(posix.basename(path)), bytes });
  }
  limitFiles(files.size);
  return files;
}

function docmostSource(archive: Archive, bytes: Buffer): MarkdownArchiveSource {
  let value: unknown;
  try { value = JSON.parse(utf8(bytes, docmostManifest)); }
  catch { return fail('Docmost ZIP의 문서 목록을 확인해 주세요.'); }
  if (!record(value) || value.source !== 'docmost' || !record(value.pages)) return fail('Docmost ZIP의 문서 목록을 확인해 주세요.');
  const rows = Object.entries(value.pages);
  limitPages(rows.length);
  const candidates: { page: MarkdownArchivePage; position: string | null }[] = [];
  const pagePaths = new Set<string>();
  for (const [encodedPath, row] of rows) {
    const path = decodeDocmostPath(encodedPath);
    if (!markdownNamedPath(path)) return fail(`${path}: Markdown 형식의 Docmost ZIP을 선택해 주세요.`);
    if (!record(row) || pagePaths.has(path)) return fail('Docmost ZIP의 문서 목록에 중복되거나 올바르지 않은 항목이 있습니다.');
    const body = archive.files.get(path);
    if (!body) return fail(`${path}: 문서 목록에 포함된 파일을 찾을 수 없습니다.`);
    const parentPath = row.parentPath === null ? null : decodeDocmostPath(row.parentPath);
    const icon = typeof row.icon === 'string' && row.icon.length <= 100 && !/\p{Cc}/u.test(row.icon) ? row.icon : undefined;
    pagePaths.add(path);
    candidates.push({
      page: { path, parentPath, ...(icon ? { icon } : {}), markdown: markdownText(body, path) },
      position: typeof row.position === 'string' ? row.position : null,
    });
  }
  candidates.sort((left, right) => compareText(left.position ?? '', right.position ?? '') || compareText(left.page.path, right.page.path));
  const files = remainingFiles(archive, pagePaths, docmostManifest);
  for (const path of files.keys()) {
    if (markdownNamedPath(path) && !path.split('/').some((part, index, segments) => part === 'files' && docmostAttachmentId.test(segments[index + 1] ?? ''))) {
      return fail(`${path}: Docmost 문서 목록에 없는 Markdown 파일입니다.`);
    }
  }
  return { format: 'docmost', pages: pageOrder(candidates.map(({ page }) => page)), files, warnings: [] };
}

function genericSource(archive: Archive): MarkdownArchiveSource {
  const paths = [...archive.files.keys()].filter(markdownNamedPath).sort(compareText);
  limitPages(paths.length);
  const caseKey = (path: string) => path.normalize('NFC').toLowerCase();
  const byPath = new Map(paths.map(path => [caseKey(path), path]));
  function apparentParent(path: string): string | null {
    for (let directory = posix.dirname(path); directory !== '.'; directory = posix.dirname(directory)) {
      const parent = byPath.get(caseKey(`${directory}.md`)) ?? byPath.get(caseKey(`${directory}/index.md`)) ??
        byPath.get(caseKey(`${directory}/README.md`));
      if (parent && parent !== path) return parent;
    }
    return null;
  }
  const pages = pageOrder(paths.map(path => ({ path, parentPath: apparentParent(path), markdown: markdownText(archive.files.get(path)!, path) })));
  return { format: 'markdown', pages, files: remainingFiles(archive, new Set(paths)), warnings: [] };
}

export async function readMarkdownArchive(bytes: Buffer): Promise<MarkdownArchiveSource> {
  let normalizedDocmostPath = false;
  const archive = await readLegacyArchive(bytes, 'document-markdown.zip', {
    maxExpandedBytes: MAX_MARKDOWN_ARCHIVE_BYTES, maxFileBytes: MAX_FILE_BYTES,
    normalizeEntryName(path) {
      const normalized = normalizeDocmostEntry(path);
      normalizedDocmostPath ||= normalized !== path;
      return normalized;
    },
  });
  const docmost = archive.files.get(docmostManifest);
  const donefac = readDonefacManifest(archive.files.get(donefacManifest));
  if (normalizedDocmostPath && (!docmost || donefac)) return fail('ZIP 파일 경로를 확인해 주세요.');
  if (docmost && donefac) return fail('ZIP에 서로 다른 형식의 문서 목록이 있습니다.');
  if (donefac) return donefacSource(archive, donefac);
  if (docmost) return docmostSource(archive, docmost);
  return genericSource(archive);
}
