import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { Express, Request } from 'express';
import { documentNodes } from '../shared/document-references.js';
import { isDocumentSectionId } from '../shared/document-sections.js';
import type { Attachment, AttachmentVersion, DocPage } from '../shared/types.js';
import { attachmentId, MAX_PACKAGE_BYTES, type AttachmentFiles } from './attachments.js';
import type { AttachmentVersionsService } from './attachment-versions.js';
import { escapeMarkdownText, renderDocumentExportMarkdown, type DocumentMarkdownExportDiagnostic } from './document-export-markdown.js';
import type { DocumentPublicationService } from './document-publication.js';
import type { Store } from './store.js';

const MAX_DOCUMENTS = 500;
const MAX_ATTACHMENTS = 1500;
const MAX_DIAGNOSTICS = 10_000;
const inlineImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const zipTime = new Date(1980, 0, 1);

type Source = 'saved' | 'published';
type ExportScope = { kind: 'space'; projectId: string | null; documentId: null } | { kind: 'subtree'; projectId: string | null; documentId: string };
type DocumentTreeRow = { id: string; parentId: string | null };
type ManifestDocument = DocumentTreeRow & {
  originalParentId: string | null; title: string; path: string; version: number; revisionId: string | null; publishedAt: string | null;
};
type ManifestAttachment = Pick<Attachment, 'id' | 'filename' | 'size' | 'sha256' | 'mimeType'> & { attachmentId: string; documentId: string; path: string };
type ExportDocument = { metadata: ManifestDocument; content: DocPage['content']; sections: Set<string> };
type ExportAttachment = { metadata: ManifestAttachment; file: Attachment };
type Entry = { path: string; bytes: Buffer };
type ExportServices = {
  store: Store;
  files: Pick<AttachmentFiles, 'path' | 'read'>;
  publications: Pick<DocumentPublicationService, 'get' | 'snapshot'>;
  attachmentVersions: Pick<AttachmentVersionsService, 'head'>;
};
type ZipFile = {
  outputStream: Readable;
  on(event: 'error', listener: (error: Error) => void): void;
  addBuffer(bytes: Buffer, path: string, options: { mtime: Date }): void;
  end(): void;
};
const { ZipFile } = createRequire(import.meta.url)('yazl') as { ZipFile: new () => ZipFile };

class DocumentExportError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function fail(status: number, message: string): never { throw new DocumentExportError(status, message); }
function tooLarge(): never { return fail(413, '문서 ZIP은 최대 64MiB까지 내보낼 수 있습니다. 더 작은 범위를 선택해 주세요.'); }

function queryId(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= 200 && value === value.trim() && !/\p{Cc}/u.test(value);
}

function exportSelection(store: Store, query: Record<string, unknown>): { scope: ExportScope; source: Source } {
  const { scope, source, projectId, documentId } = query;
  const invalid = () => fail(400, '문서 ZIP의 내보내기 범위와 저장본 종류를 확인해 주세요.');
  if (Object.keys(query).some(key => !['scope', 'source', 'projectId', 'documentId'].includes(key)) || (source !== 'saved' && source !== 'published')) {
    return invalid();
  }
  if (scope === 'space' && documentId === undefined && (projectId === undefined || queryId(projectId))) {
    if (projectId !== undefined && !store.get('projects', projectId)) fail(404, '문서 공간을 찾을 수 없습니다.');
    return { scope: { kind: 'space', projectId: projectId ?? null, documentId: null }, source };
  }
  if (scope === 'subtree' && projectId === undefined && queryId(documentId)) {
    const root = store.db.prepare('SELECT project_id AS projectId FROM documents WHERE id=?').get(documentId) as { projectId: string | null } | undefined;
    if (!root) fail(404, '선택한 문서를 찾을 수 없습니다.');
    return { scope: { kind: 'subtree', projectId: root.projectId, documentId }, source };
  }
  return invalid();
}

function scopedRows(store: Store, scope: ExportScope): DocumentTreeRow[] {
  const limit = MAX_DOCUMENTS + 1;
  const rows = (scope.kind === 'space' ? store.db.prepare(`
    SELECT id,parent_id AS parentId FROM documents WHERE project_id IS ? LIMIT ?
  `).all(scope.projectId, limit) : store.db.prepare(`
    WITH RECURSIVE tree(id) AS (
      VALUES (?)
      UNION
      SELECT d.id FROM documents d JOIN tree t ON d.parent_id=t.id WHERE d.project_id IS ? LIMIT ?
    )
    SELECT d.id,d.parent_id AS parentId FROM tree JOIN documents d ON d.id=tree.id
  `).all(scope.documentId, scope.projectId, limit)) as DocumentTreeRow[];
  if (rows.length > MAX_DOCUMENTS) fail(413, `한 번에 문서 ${MAX_DOCUMENTS}개까지 내보낼 수 있습니다. 더 작은 범위를 선택해 주세요.`);
  return rows;
}

function filenamePart(value: string, fallback: string, maxBytes = 104): string {
  const clean = value.toWellFormed().normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '-').trim();
  let part = '', length = 0;
  for (const character of clean) {
    length += Buffer.byteLength(character);
    if (length > maxBytes) break;
    part += character;
  }
  return part.replace(/[. ]+$/g, '') || fallback;
}

const pathKey = (id: string) => createHash('sha256').update(id).digest('hex');

function documentPath(id: string, title: string): string {
  return `documents/${pathKey(id)}-${filenamePart(title, 'document')}.md`;
}

function attachmentPath(file: Attachment): string {
  const extension = posix.extname(file.filename);
  const base = extension ? file.filename.slice(0, -extension.length) : file.filename;
  const suffix = /^[.][a-z0-9]{1,12}$/i.test(extension) ? extension : '';
  return `attachments/${pathKey(attachmentId(file.id))}-${filenamePart(base, 'file')}${suffix}`;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function packageHref(from: string, to: string, fragment?: string): string {
  const path = from === to && fragment ? '' : posix.relative(posix.dirname(from), to).split('/').map(encodeSegment).join('/');
  return `${path}${fragment ? `#${encodeSegment(fragment)}` : ''}`;
}

export const documentArchiveAttachmentFooter = '\n## 첨부파일\n\n';

export function documentArchiveAttachmentLink(documentPath: string, filePath: string, filename: string): string {
  return `- [${escapeMarkdownText(filename)}](${packageHref(documentPath, filePath)})`;
}

function selectedDocuments(services: ExportServices, rows: DocumentTreeRow[], source: Source): Map<string, ExportDocument> {
  const selected = new Map<string, ExportDocument>();
  // Bound the retained page bodies even when markup renders to little or no Markdown.
  let sourceBytes = 0;
  for (const row of rows) {
    const published = source === 'published' ? services.publications.get(row.id).published : null;
    if (source === 'published' && !published) continue;
    const snapshot = published ? services.publications.snapshot(row.id, 'published', published.revisionId) : services.store.get<DocPage>('documents', row.id);
    if (!snapshot) fail(503, '선택한 문서 저장본을 읽을 수 없습니다.');
    sourceBytes += Buffer.byteLength(JSON.stringify(snapshot.content));
    if (sourceBytes > MAX_PACKAGE_BYTES) tooLarge();
    const sections = new Set<string>();
    for (const node of documentNodes(snapshot.content)) {
      if (node.type === 'heading' && isDocumentSectionId(node.attrs?.sectionId)) sections.add(node.attrs.sectionId);
    }
    const { title, content, version } = snapshot;
    selected.set(row.id, { metadata: {
      id: row.id, parentId: null, originalParentId: row.parentId, title, path: documentPath(row.id, title), version,
      revisionId: published?.revisionId ?? null, publishedAt: published?.publishedAt ?? null,
    }, content, sections });
  }
  if (!selected.size) fail(404, source === 'published' ? '선택한 범위에 승인된 발행본이 없습니다.' : '선택한 범위에 저장된 문서가 없습니다.');
  const parents = new Map(rows.map(row => [row.id, row.parentId]));
  for (const {metadata} of selected.values()) {
    const visited = new Set([metadata.id]);
    let parent = metadata.originalParentId;
    while (parent && !selected.has(parent)) {
      if (visited.has(parent)) fail(503, '문서 계층을 읽을 수 없습니다.');
      visited.add(parent);
      parent = parents.get(parent) ?? null;
    }
    metadata.parentId = parent;
  }
  return selected;
}

function documentTree(selected: Map<string, ExportDocument>) {
  const children = new Map<string | null, ManifestDocument[]>();
  const order: ManifestDocument[] = [];
  const lines: string[] = [];
  for (const { metadata } of selected.values()) {
    const siblings = children.get(metadata.parentId);
    if (siblings) siblings.push(metadata);
    else children.set(metadata.parentId, [metadata]);
  }
  function visit(parentId: string | null, depth: number) {
    const siblings = children.get(parentId) ?? [];
    siblings.sort((left, right) => left.title.localeCompare(right.title, 'ko') || left.path.localeCompare(right.path));
    for (const document of siblings) {
      order.push(document);
      const title = escapeMarkdownText(document.title.replace(/\s+/gu, ' ').trim());
      lines.push(`${'  '.repeat(depth)}- [${title}](${packageHref('README.md', document.path)})`);
      visit(document.id, depth + 1);
    }
  }
  visit(null, 0);
  if (order.length !== selected.size) fail(503, '문서 계층을 읽을 수 없습니다.');
  return { order, lines };
}

function resolveAttachment(store: Store, id: string, versionFirst: boolean): Attachment | AttachmentVersion | undefined {
  return versionFirst
    ? store.get<AttachmentVersion>('attachment_versions', id) ?? store.get<Attachment>('attachments', id)
    : store.get<Attachment>('attachments', id) ?? store.get<AttachmentVersion>('attachment_versions', id);
}

function captureArchive(services: ExportServices, query: Record<string, unknown>, browserOrigin: string | undefined): Entry[] {
  const { store, files, attachmentVersions } = services;
  const { scope, source } = exportSelection(store, query);
  const selected = selectedDocuments(services, scopedRows(store, scope), source);
  const tree = documentTree(selected);
  const entries: Entry[] = [];
  const attachments = new Map<string, ExportAttachment>();
  const diagnostics: (DocumentMarkdownExportDiagnostic & { documentId: string })[] = [];
  let bytesTotal = 0;
  function count(size: number) {
    bytesTotal += size;
    if (bytesTotal > MAX_PACKAGE_BYTES) tooLarge();
  }
  function addText(path: string, text: string) {
    const bytes = Buffer.from(text);
    count(bytes.length);
    entries.push({ path, bytes });
  }
  function addAttachment(file: Attachment, baseId: string, document: ManifestDocument) {
    const existing = attachments.get(file.id);
    if (existing) {
      if (existing.metadata.documentId !== document.id || existing.metadata.attachmentId !== baseId ||
          existing.file.sha256 !== file.sha256 || existing.file.size !== file.size) fail(503, '첨부파일의 문서 소유권 또는 버전을 확인할 수 없습니다.');
      return existing.metadata.path;
    }
    if (attachments.size === MAX_ATTACHMENTS) fail(413, `한 번에 첨부파일 ${MAX_ATTACHMENTS}개까지 내보낼 수 있습니다.`);
    count(file.size);
    const { id, filename, size, sha256, mimeType } = file;
    const path = attachmentPath(file);
    attachments.set(id, { file, metadata: { id, filename, size, sha256, mimeType, path, attachmentId: baseId, documentId: document.id } });
    return path;
  }
  const owned = (file: Attachment | undefined, documentId: string) => file?.resourceType === 'document' && file.resourceId === documentId;

  for (const metadata of tree.order) {
    const document = selected.get(metadata.id)!;
    const referenceCache = new Map<string, string | undefined>();
    const result = renderDocumentExportMarkdown({ id: metadata.id, title: metadata.title, content: document.content }, {
      browserOrigin,
      document(id, target) {
        const targetPage = selected.get(id);
        if (!targetPage || (target?.revisionId && targetPage.metadata.revisionId !== target.revisionId) ||
            (target?.sectionId && !targetPage.sections.has(target.sectionId))) return undefined;
        return packageHref(metadata.path, targetPage.metadata.path, target?.sectionId);
      },
      attachment(id, kind) {
        const key = `${kind}:${id}`;
        if (referenceCache.has(key)) return referenceCache.get(key);
        const file = resolveAttachment(store, id, kind === 'attachment-version');
        const baseId = file && ('attachmentId' in file ? file.attachmentId : file.id);
        const base = baseId && store.get<Attachment>('attachments', baseId);
        const href = file && baseId && base && owned(file, metadata.id) && owned(base, metadata.id) &&
          (kind !== 'inline-image' || inlineImageTypes.has(file.mimeType))
          ? packageHref(metadata.path, addAttachment(file, baseId, metadata)) : undefined;
        referenceCache.set(key, href);
        return href;
      },
    });
    if (diagnostics.length + result.diagnostics.length > MAX_DIAGNOSTICS) fail(413, '문서 ZIP의 참조 진단이 너무 많습니다. 더 작은 범위를 선택해 주세요.');
    for (const diagnostic of result.diagnostics) diagnostics.push({ documentId: metadata.id, ...diagnostic });
    let markdown = result.markdown;
    if (source === 'saved') {
      const rows = store.db.prepare(`SELECT json FROM attachments WHERE resource_type='document' AND resource_id=? ORDER BY id LIMIT ?`)
        .all(metadata.id, MAX_ATTACHMENTS + 1) as { json: string }[];
      if (rows.length > MAX_ATTACHMENTS) fail(413, `한 번에 첨부파일 ${MAX_ATTACHMENTS}개까지 내보낼 수 있습니다.`);
      const links = rows.map(row => {
        const base = JSON.parse(row.json) as Attachment;
        const head = attachmentVersions.head(base);
        const path = addAttachment({ ...head, id: head.currentVersionId }, base.id, metadata);
        return documentArchiveAttachmentLink(metadata.path, path, head.filename);
      });
      if (links.length) markdown += `${documentArchiveAttachmentFooter}${links.join('\n')}\n`;
    }
    addText(metadata.path, markdown);
  }
  const byPath = [...attachments.values()].sort((left, right) => left.metadata.path.localeCompare(right.metadata.path));
  addText('manifest.json', `${JSON.stringify({
    format: 'teamspace-document-markdown', schemaVersion: 1, exportedAt: new Date().toISOString(), source, scope,
    documents: tree.order, attachments: byPath.map(file => file.metadata), diagnostics,
  }, null, 2)}\n`);
  addText('README.md', `# Teamspace 문서\n\n${source === 'published' ? '최신 승인 저장본' : '서버에 저장된 최신 문서'} · ${tree.order.length}개\n\n${tree.lines.join('\n')}\n\n[내보내기 목록과 참조 진단](manifest.json)\n`);
  for (const { metadata, file } of byPath) {
    const unreadable = '첨부파일을 읽거나 무결성을 확인하지 못해 문서 ZIP을 만들지 못했습니다.';
    try {
      const info = statSync(files.path(file.id));
      if (!info.isFile() || info.size !== file.size) fail(503, unreadable);
      entries.push({ path: metadata.path, bytes: files.read(file) });
    } catch { fail(503, unreadable); }
  }
  return entries;
}

async function zipBytes(entries: Entry[]): Promise<Buffer> {
  const zip = new ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.path, { mtime: zipTime });
  zip.end();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PACKAGE_BYTES) tooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function directRequestOrigin(request: Request): string | undefined {
  const host = request.get('host');
  if (!host || /[/\\?#@%\s\p{Cc}]/u.test(host) || !['http', 'https'].includes(request.protocol)) return undefined;
  try { return new URL(`${request.protocol}://${host}`).origin; }
  catch { return undefined; }
}

export function registerDocumentExportRoutes(app: Express, services: ExportServices, browserOrigin?: string): void {
  app.get('/api/document-exports/markdown.zip', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      // Capture both row metadata and verified bytes before releasing the snapshot or sending any data.
      const origin = browserOrigin ?? directRequestOrigin(request);
      const entries = services.store.transaction(() => captureArchive(services, request.query, origin));
      const bytes = await zipBytes(entries);
      const filename = encodeSegment('Teamspace 문서.zip');
      response.set({
        'Content-Type': 'application/zip', 'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="teamspace-documents.zip"; filename*=UTF-8''${filename}`,
        'X-Content-Type-Options': 'nosniff',
      }).end(bytes);
    } catch (cause) {
      if (cause instanceof DocumentExportError) {
        response.status(cause.status).json({ error: cause.message });
        return;
      }
      throw cause;
    }
  });
}
