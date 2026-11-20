import type { Express, Request, Response } from 'express';
import { inlineAttachmentIdFromUrl } from '../shared/inline-attachment.js';
import type { Attachment, DocRevision, RichContent } from '../shared/types.js';
import type { Store } from './store.js';

const PAGE_SIZE = 25;
type RevisionSummary = Pick<DocRevision, 'id' | 'version' | 'title' | 'createdAt'>;
type RevisionOwner = Pick<DocRevision, 'documentId'>;
type RevisionRow = { json: string };

function validId(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasTrashArchive(store: Store) {
  return Boolean(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='trash_entries'").get());
}

/** Resolve ownership by revision ID, regardless of the requested source document. */
export function includeRevisionOwner(store: Store, revisionId: string): string | undefined {
  const live = store.db.prepare('SELECT document_id AS documentId FROM revisions WHERE id=?').get(revisionId) as RevisionOwner | undefined;
  if (live) return live.documentId;
  // Legacy rooms may be normalized before the trash service initializes its table.
  if (!hasTrashArchive(store)) return undefined;
  const archived = store.db.prepare(`
    SELECT entry.resource_id AS documentId
    FROM trash_entries AS entry, json_each(entry.json,'$.revisions') AS revision
    WHERE entry.resource_type='document' AND json_extract(revision.value,'$.id')=?
      AND json_extract(revision.value,'$.documentId')=entry.resource_id
    LIMIT 1
  `).get(revisionId) as RevisionOwner | undefined;
  return archived?.documentId;
}

function readRevision(store: Store, id: string, revisionId: string): DocRevision | undefined {
  let revision = store.db.prepare('SELECT json FROM revisions WHERE id=? AND document_id=?').get(revisionId, id) as RevisionRow | undefined;
  if (!revision && hasTrashArchive(store)) {
    revision = store.db.prepare(`
      SELECT revision.value AS json
      FROM trash_entries AS entry, json_each(entry.json,'$.revisions') AS revision
      WHERE entry.resource_type='document' AND entry.resource_id=?
        AND json_extract(revision.value,'$.id')=? AND json_extract(revision.value,'$.documentId')=entry.resource_id
      LIMIT 1
    `).get(id, revisionId) as RevisionRow | undefined;
  }
  return revision && JSON.parse(revision.json) as DocRevision;
}

function referencesImage(content: RichContent, fileId: string) {
  const pending = [content];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image' && inlineAttachmentIdFromUrl(node.attrs?.src) === fileId) return true;
    if (node.content) for (const child of node.content) pending.push(child);
  }
  return false;
}

function archivedImage(store: Store, documentId: string, fileId: string): Attachment | undefined {
  const hasIndividuallyArchivedFiles = store.db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='trash_item_files'",
  ).get();
  if (hasIndividuallyArchivedFiles) {
    const individual = store.db.prepare(`SELECT file.json FROM trash_item_files AS file
      JOIN trash_items AS entry ON entry.id=file.entry_id
      WHERE file.file_id=? AND entry.item_type='attachment' AND entry.owner_type='document' AND entry.owner_id=?
        AND json_extract(file.json,'$.resourceType')=entry.owner_type AND json_extract(file.json,'$.resourceId')=entry.owner_id`)
      .get(fileId, documentId) as RevisionRow | undefined;
    if (individual) return JSON.parse(individual.json) as Attachment;
  }
  if (!hasTrashArchive(store)) return undefined;
  const row = store.db.prepare(`
    SELECT file.value AS json
    FROM trash_entries AS entry, json_each('["$.attachments","$.attachmentVersions"]') AS section,
      json_each(entry.json,section.value) AS file
    WHERE entry.resource_type='document' AND entry.resource_id=?
      AND json_extract(file.value,'$.resourceType')='document' AND json_extract(file.value,'$.resourceId')=entry.resource_id
      AND json_extract(file.value,'$.id')=?
    LIMIT 1
  `).get(documentId, fileId) as RevisionRow | undefined;
  return row && JSON.parse(row.json) as Attachment;
}

export function registerDocumentIncludeRevisionRoutes(app: Express, store: Store,
  serveInline?: (attachment: Attachment, request: Request, response: Response) => void) {
  app.get('/api/documents/:id/include-revisions', (request, response) => {
    response.set('Cache-Control', 'no-store');
    const { id } = request.params;
    const { offset = '0' } = request.query;
    if (!validId(id) || typeof offset !== 'string' || !/^\d{1,9}$/.test(offset) ||
        Object.keys(request.query).some(key => key !== 'offset')) {
      return response.status(400).json({ error: '문서 저장본 목록의 조회 조건을 확인해 주세요.' });
    }
    if (!store.db.prepare('SELECT 1 FROM documents WHERE id=?').get(id)) {
      return response.status(404).json({ error: '문서를 찾을 수 없습니다.' });
    }
    const start = Number(offset);
    const rows = store.db.prepare(`
      SELECT id,json_extract(json,'$.version') AS version,json_extract(json,'$.title') AS title,
        json_extract(json,'$.createdAt') AS createdAt
      FROM revisions WHERE document_id=?
      ORDER BY version DESC,createdAt DESC,id
      LIMIT ? OFFSET ?
    `).all(id, PAGE_SIZE + 1, start) as unknown as RevisionSummary[];
    return response.json({ items: rows.slice(0, PAGE_SIZE), nextOffset: rows.length > PAGE_SIZE ? start + PAGE_SIZE : null });
  });

  app.get('/api/documents/:id/include-revisions/:revisionId', (request, response) => {
    response.set('Cache-Control', 'no-store');
    const { id, revisionId } = request.params;
    if (!validId(id) || !validId(revisionId) || Object.keys(request.query).length) {
      return response.status(400).json({ error: '포함할 문서 저장본을 확인해 주세요.' });
    }
    const revision = readRevision(store, id, revisionId);
    if (!revision) return response.status(404).json({ error: '이 문서의 저장본을 찾을 수 없습니다.' });
    return response.json(revision);
  });

  if (serveInline) app.get('/api/documents/:id/include-revisions/:revisionId/images/:fileId', (request, response) => {
    response.set('Cache-Control', 'no-store');
    const { id, revisionId, fileId } = request.params;
    if (!validId(id) || !validId(revisionId) || !validId(fileId) || Object.keys(request.query).length) {
      return response.status(400).json({ error: '저장본의 첨부 이미지를 확인해 주세요.' });
    }
    const revision = readRevision(store, id, revisionId);
    if (!revision || !referencesImage(revision.content, fileId)) {
      return response.status(404).json({ error: '이 저장본에서 첨부 이미지를 찾을 수 없습니다.' });
    }
    const attachment = store.get<Attachment>('attachments', fileId) ?? store.get<Attachment>('attachment_versions', fileId)
      ?? archivedImage(store, id, fileId);
    if (!attachment) return response.status(404).json({ error: '첨부 이미지 파일을 찾을 수 없습니다.' });
    serveInline(attachment, request, response);
  });
}
