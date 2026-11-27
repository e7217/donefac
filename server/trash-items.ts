import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type { Attachment, AttachmentVersion, Comment, DocPage, Issue, TrashItemPage, TrashItemSummary, TrashItemType, TrashResourceType, User } from '../shared/types.js';
import { attachmentId, MAX_FILE_BYTES, safeFilename, type AttachmentFiles } from './attachments.js';
import type { Store } from './store.js';
import { TrashError, trashPageBounds, type TrashArchive } from './trash.js';

type Owner = Issue | DocPage;
type ArchiveIdentity = Pick<TrashItemSummary, 'id' | 'ownerType' | 'ownerId' | 'title' | 'deletedAt' | 'deletedById'>;
export type ArchivedTrashItem = ArchiveIdentity & (
  { itemType: 'comment'; item: Comment; versions: []; replies?: Comment[] } |
  { itemType: 'attachment'; item: Attachment; versions: AttachmentVersion[] }
);
type BackupReferences = {
  users: User[]; issues: Issue[]; documents: DocPage[]; comments: Comment[]; attachments: Attachment[];
  attachmentVersions?: AttachmentVersion[]; trash: TrashArchive[];
};
type OwnerSummary = Pick<TrashItemSummary, 'ownerTitle' | 'ownerIssueKey' | 'ownerAvailable' | 'projectId'>;
type JoinedItem = Omit<OwnerSummary, 'ownerAvailable'> & { json: string; ownerAvailable: number };
type Hooks = {
  actor: (req: Request) => string;
  activity: (req: Request, type: string, id: string, action: string, detail?: string) => void;
};

const itemTypes = new Set<unknown>(['comment', 'attachment']);
const key = (type: TrashResourceType, id: string) => JSON.stringify([type, id]);
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validString = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const ownerTable = (type: TrashResourceType) => type === 'issue' ? 'issues' : 'documents';
const parseRows = <T>(rows: unknown[]) => (rows as { json: string }[]).map(row => JSON.parse(row.json) as T);
const itemLabel = (type: TrashItemType) => type === 'attachment' ? '첨부파일' : '댓글';

function fail(status: number, message: string): never { throw new TrashError(status, message); }
function invalid(label: string): never { return fail(400, `백업의 개별 휴지통 ${label}을(를) 확인해 주세요.`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('데이터');
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  try { return attachmentId(value); } catch { return invalid('ID'); }
}

export function trashItemFiles(entry: ArchivedTrashItem): Attachment[] {
  if (entry.itemType === 'comment') return [];
  return [...new Map([entry.item, ...entry.versions].map(file => [file.id, file])).values()];
}

export function trashItemComments(entry: ArchivedTrashItem): Comment[] {
  return entry.itemType === 'comment' ? [entry.item, ...(entry.replies ?? [])] : [];
}

function isReplyTo(reply: Comment, parent: Comment | undefined): boolean {
  return reply.resourceType === 'document' && parent?.resourceType === 'document' && parent.id === reply.parentCommentId &&
    parent.resourceId === reply.resourceId && parent.parentCommentId === undefined && Boolean(parent.documentSource) &&
    !Object.hasOwn(reply, 'documentSource') && !Object.hasOwn(reply, 'resolution');
}

export function validateCommentReplyTopology(version: number, comments: Comment[], trash: TrashArchive[], items: ArchivedTrashItem[]): void {
  const active = new Map(comments.map(comment => [comment.id, comment]));
  const all = new Map(active);
  const validate = (comment: Comment, container: ReadonlyMap<string, Comment>) => {
    if (!Object.hasOwn(comment, 'parentCommentId')) return;
    if (version < 77) fail(400, '문장 댓글 답글을 포함한 백업은 schemaVersion 77이 필요합니다.');
    if (!validString(comment.parentCommentId) || !isReplyTo(comment, container.get(comment.parentCommentId))) {
      fail(400, '백업에 포함된 답글과 원래 문장 댓글의 연결을 확인해 주세요.');
    }
  };
  for (const comment of active.values()) validate(comment, active);
  for (const entry of trash) {
    const group = new Map(entry.comments.map(comment => [comment.id, comment]));
    for (const comment of entry.comments) {
      validate(comment, group);
      all.set(comment.id, comment);
    }
  }
  for (const item of items) if (item.itemType === 'comment') all.set(item.item.id, item.item);
  for (const item of items) if (item.itemType === 'comment') validate(item.item, all);
}

function itemSummary(entry: ArchivedTrashItem, owner: OwnerSummary): TrashItemSummary {
  const { id, itemType, ownerId, ownerType, title, deletedAt, deletedById } = entry;
  return { id, itemType, itemId: entry.item.id, ownerType, ownerId, title, deletedAt, deletedById,
    authorId: entry.item.authorId, versionCount: itemType === 'attachment' ? trashItemFiles(entry).length : null, ...owner };
}

const joinedOwners = `FROM trash_items c
  LEFT JOIN issues i ON c.owner_type='issue' AND i.id=c.owner_id
  LEFT JOIN documents d ON c.owner_type='document' AND d.id=c.owner_id
  LEFT JOIN trash_entries t ON t.resource_type=c.owner_type AND t.resource_id=c.owner_id`;
const ownerProject = 'CASE WHEN i.id IS NOT NULL THEN i.project_id WHEN d.id IS NOT NULL THEN d.project_id ELSE t.project_id END';

export class TrashItemsService {
  constructor(private readonly store: Store, private readonly files: AttachmentFiles) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS trash_items (
        id TEXT PRIMARY KEY, item_type TEXT NOT NULL CHECK(item_type IN ('attachment','comment')), item_id TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK(owner_type IN ('issue','document')), owner_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
        json TEXT NOT NULL, UNIQUE(item_type,item_id)
      );
      CREATE INDEX IF NOT EXISTS trash_items_owner ON trash_items(owner_type,owner_id);
      CREATE INDEX IF NOT EXISTS trash_items_order ON trash_items(item_type,deleted_at DESC,id);
      CREATE TABLE IF NOT EXISTS trash_item_files (
        file_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES trash_items(id) ON DELETE CASCADE, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trash_item_files_entry ON trash_item_files(entry_id);
      CREATE TABLE IF NOT EXISTS trash_file_cleanup (file_id TEXT PRIMARY KEY);
    `);
  }

  private insert(entry: ArchivedTrashItem): void {
    this.store.db.prepare('INSERT INTO trash_items(id,item_type,item_id,owner_type,owner_id,deleted_at,json) VALUES(?,?,?,?,?,?,?)')
      .run(entry.id, entry.itemType, entry.item.id, entry.ownerType, entry.ownerId, entry.deletedAt, JSON.stringify(entry));
    const insertFile = this.store.db.prepare('INSERT INTO trash_item_files(file_id,entry_id,json) VALUES(?,?,?)');
    for (const file of trashItemFiles(entry)) insertFile.run(file.id, entry.id, JSON.stringify(file));
  }

  private liveOwner(type: TrashResourceType, id: string): Owner | undefined {
    return this.store.get<Owner>(ownerTable(type), id);
  }

  private identity(item: Comment | Attachment, deletedById: string, title: string): ArchiveIdentity {
    if (!this.liveOwner(item.resourceType, item.resourceId)) fail(404, '원래 업무나 문서를 찾을 수 없습니다.');
    return { id: randomUUID(), ownerType: item.resourceType, ownerId: item.resourceId,
      title, deletedById, deletedAt: new Date().toISOString() };
  }

  archiveComment(item: Comment, deletedById: string): string {
    if (item.authorId !== deletedById) fail(403, '작성한 댓글만 휴지통에 보낼 수 있습니다.');
    const title = item.body.replace(/\s+/g, ' ').trim().slice(0, 120) || '댓글';
    const replies = item.resourceType === 'document' && item.documentSource
      ? this.store.commentsForResource('document', item.resourceId).filter(comment => comment.parentCommentId === item.id)
      : [];
    const entry: ArchivedTrashItem = {
      ...this.identity(item, deletedById, title), itemType: 'comment', item, versions: [], ...(replies.length ? { replies } : {}),
    };
    this.insert(entry);
    this.store.remove('comments', item.id);
    for (const reply of replies) this.store.remove('comments', reply.id);
    return entry.id;
  }

  archiveAttachment(item: Attachment, versions: AttachmentVersion[], deletedById: string, filename: string): string {
    const entry: ArchivedTrashItem = { ...this.identity(item, deletedById, filename), itemType: 'attachment', item, versions };
    this.insert(entry);
    this.store.remove('attachments', item.id);
    return entry.id;
  }

  list(query: Record<string, unknown>): TrashItemPage {
    if (Object.keys(query).some(name => !['scope', 'itemType', 'projectId', 'offset', 'limit'].includes(name))) fail(400, '휴지통 조회 조건을 확인해 주세요.');
    const { scope = 'all', itemType, projectId } = query;
    if (scope !== 'all' && scope !== 'project' && scope !== 'common' ||
        itemType !== undefined && !itemTypes.has(itemType) || (scope === 'project' ? !validString(projectId) : projectId !== undefined)) {
      fail(400, '휴지통 범위와 항목 종류를 확인해 주세요.');
    }
    if (scope === 'project' && !this.store.get('projects', projectId as string)) fail(404, '프로젝트를 찾을 수 없습니다.');
    const { offset, limit } = trashPageBounds(query);
    const conditions: string[] = [], params: string[] = [];
    if (scope === 'project') { conditions.push(`(${ownerProject})=?`); params.push(projectId as string); }
    if (scope === 'common') conditions.push(`c.owner_type='document' AND (${ownerProject}) IS NULL`);
    if (itemType) { conditions.push('c.item_type=?'); params.push(itemType as string); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { total } = this.store.db.prepare(`SELECT count(*) AS total ${joinedOwners} ${where}`).get(...params) as {total: number};
    const rows = this.store.db.prepare(`SELECT c.json, ${ownerProject} AS projectId,
      (i.id IS NOT NULL OR d.id IS NOT NULL) AS ownerAvailable,
      COALESCE(json_extract(i.json,'$.title'),json_extract(d.json,'$.title'),json_extract(t.summary,'$.title'),'원래 항목') AS ownerTitle,
      COALESCE(json_extract(i.json,'$.key'),json_extract(t.summary,'$.issueKey')) AS ownerIssueKey
      ${joinedOwners} ${where} ORDER BY c.deleted_at DESC,c.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as JoinedItem[];
    const items = rows.map(({ json, ownerAvailable, ...owner }) => itemSummary(JSON.parse(json), { ...owner, ownerAvailable: Boolean(ownerAvailable) }));
    return { items, offset, limit, total };
  }

  private get(id: string): ArchivedTrashItem {
    return this.store.get<ArchivedTrashItem>('trash_items', id) ?? fail(404, '휴지통에서 이 항목을 찾을 수 없습니다.');
  }

  private restore(entry: ArchivedTrashItem): TrashItemSummary {
    const owner = this.liveOwner(entry.ownerType, entry.ownerId);
    if (!owner) fail(409, '원래 업무나 문서를 먼저 복원해 주세요.');
    if (entry.itemType === 'comment') {
      const parentId = entry.item.parentCommentId;
      if (parentId !== undefined && !isReplyTo(entry.item, this.store.get<Comment>('comments', parentId))) {
        fail(409, '원래 문장 댓글을 먼저 복원해 주세요.');
      }
      const comments = trashItemComments(entry);
      if (comments.some(comment => this.store.get('comments', comment.id))) fail(409, '이미 같은 댓글 ID를 사용하고 있습니다.');
      // Historic comments must not trigger a new comment-created event.
      this.store.withMutationContext({ origin: 'import', actorId: null }, () => {
        for (const comment of comments) this.store.put('comments', comment);
      });
    } else {
      for (const file of trashItemFiles(entry)) {
        if (this.store.get('attachments', file.id) || this.store.get('attachment_versions', file.id)) fail(409, '이미 같은 파일 ID를 사용하고 있습니다.');
        try { this.files.read(file); } catch { fail(503, `휴지통의 ${file.filename} 파일 무결성을 확인하지 못했습니다.`); }
      }
      this.store.put('attachments', entry.item);
      const insert = this.store.db.prepare('INSERT INTO attachment_versions(id,attachment_id,json) VALUES(?,?,?)');
      for (const version of entry.versions) insert.run(version.id, version.attachmentId, JSON.stringify(version));
    }
    this.store.remove('trash_items', entry.id);
    return itemSummary(entry, { ownerAvailable: true, ownerTitle: owner.title, ownerIssueKey: 'key' in owner ? owner.key : null, projectId: owner.projectId });
  }

  queueCleanup(files: Attachment[]): void {
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO trash_file_cleanup(file_id) VALUES(?)');
    for (const file of files) insert.run(file.id);
  }

  finishCleanup(): void {
    const pending = this.store.db.prepare('SELECT file_id AS id FROM trash_file_cleanup').all() as { id: string }[];
    const completed = this.store.db.prepare('DELETE FROM trash_file_cleanup WHERE file_id=?');
    for (const { id } of pending) {
      try { this.files.remove(id); completed.run(id); }
      catch { console.error('[donefac attachments] deferred trash cleanup:', id); }
    }
  }

  purgeOwner(ownerType: TrashResourceType, ownerId: string): void {
    const files = parseRows<Attachment>(this.store.db.prepare(`SELECT f.json FROM trash_item_files f JOIN trash_items c ON c.id=f.entry_id
      WHERE c.owner_type=? AND c.owner_id=?`).all(ownerType, ownerId));
    this.queueCleanup(files);
    this.store.db.prepare('DELETE FROM trash_items WHERE owner_type=? AND owner_id=?').run(ownerType, ownerId);
  }

  hasLocalAttachmentVersion(id: string): boolean {
    return Boolean(this.store.db.prepare(`SELECT 1 FROM trash_item_files WHERE file_id=?
      AND json_type(json,'$.localRevision')='integer' AND json_extract(json,'$.localRevision')>=2`).get(id));
  }

  all(): ArchivedTrashItem[] { return this.store.all<ArchivedTrashItem>('trash_items'); }

  validateImport(raw: unknown, refs: BackupReferences, version: number): ArchivedTrashItem[] {
    if (!Array.isArray(raw) || raw.length > 100_000) invalid('목록');
    if (!raw.length) return [];
    const users = new Set(refs.users.map(item => item.id));
    const owners = new Set([...refs.issues.map(item => key('issue', item.id)), ...refs.documents.map(item => key('document', item.id)),
      ...refs.trash.map(entry => key(entry.resourceType, entry.resourceId))]);
    const comments = new Set([...refs.comments, ...refs.trash.flatMap(entry => entry.comments)].map(item => item.id));
    const occupiedFiles = new Set([...refs.attachments, ...(refs.attachmentVersions ?? []),
      ...refs.trash.flatMap(entry => [...entry.attachments, ...entry.attachmentVersions])].map(item => item?.id));
    const seen = new Set(refs.trash.map(entry => entry.id));
    return raw.map((candidate: unknown): ArchivedTrashItem => {
      const archived = record(candidate);
      const { id: entryId, itemType, ownerId, ownerType, title, deletedAt, deletedById, item: rawItem, versions, replies } = archived;
      const id = uuid(entryId);
      if (seen.has(id) || (ownerType !== 'issue' && ownerType !== 'document') || !validString(ownerId) || !owners.has(key(ownerType, ownerId)) ||
          !validString(title) || title.length > 300 || !validDate(deletedAt) || new Date(deletedAt).toISOString() !== deletedAt ||
          !validString(deletedById) || !users.has(deletedById) || !Array.isArray(versions) || versions.length > 100_000) invalid('항목·부모·삭제 이력');
      seen.add(id);
      const identity: ArchiveIdentity = { id, ownerType, ownerId, title, deletedAt, deletedById };
      const owned = (item: Record<string, unknown>) => item.resourceType === ownerType && item.resourceId === ownerId &&
        validString(item.authorId) && users.has(item.authorId) && validDate(item.createdAt);
      const item = record(rawItem);
      if (!owned(item) || !validString(item.id)) invalid('원본 소유자');
      if (itemType === 'comment') {
        if (versions.length) invalid('댓글');
        const readComment = (comment: Record<string, unknown>): Comment => {
          if (!owned(comment) || !validString(comment.id) || comments.has(comment.id) ||
              !validString(comment.body) || comment.body.length > 20_000) invalid('댓글');
          comments.add(comment.id);
          return comment as unknown as Comment;
        };
        const root = readComment(item);
        if (!Object.hasOwn(archived, 'replies')) return { ...identity, itemType, item: root, versions: [] };
        if (version < 77) fail(400, '문장 댓글 답글을 포함한 백업은 schemaVersion 77이 필요합니다.');
        if (!Array.isArray(replies) || !replies.length || replies.length > 100_000 || root.parentCommentId !== undefined || !root.documentSource) {
          invalid('문장 댓글 답글');
        }
        const thread = replies.map(value => readComment(record(value)));
        if (thread.some(reply => !isReplyTo(reply, root))) invalid('문장 댓글 답글');
        return { ...identity, itemType, item: root, versions: [], replies: thread };
      }
      if (itemType !== 'attachment' || Object.hasOwn(archived, 'replies')) invalid('종류');
      const validateFile = (file: Record<string, unknown>) => {
        const fileId = uuid(file.id);
        try { safeFilename(file.filename); } catch { invalid('파일명'); }
        if (!owned(file) || occupiedFiles.has(fileId) || typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(file.sha256) ||
            !validString(file.mimeType) || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES) invalid('첨부파일');
        return fileId;
      };
      const fileId = validateFile(item);
      const versionIds = new Set<string>();
      for (const rawVersion of versions) {
        const version = record(rawVersion), versionId = validateFile(version);
        if (version.attachmentId !== fileId || versionIds.has(versionId)) invalid('첨부 버전');
        versionIds.add(versionId);
      }
      for (const used of [fileId, ...versionIds]) occupiedFiles.add(used);
      return { ...identity, itemType, item: item as unknown as Attachment, versions };
    });
  }

  replaceImported(entries: ArchivedTrashItem[]): void {
    this.store.db.exec('DELETE FROM trash_items; DELETE FROM trash_file_cleanup;');
    for (const entry of entries) this.insert(entry);
  }

  registerRoutes(app: Express, hooks: Hooks): void {
    app.get('/api/trash/items', (req, res) => res.set('Cache-Control', 'no-store').json(this.list(req.query)));
    app.post('/api/trash/items/:id/restore', (req, res) => {
      hooks.actor(req);
      const restored = this.store.transaction(() => {
        const entry = this.get(req.params.id);
        const summary = this.restore(entry);
        hooks.activity(req, entry.ownerType, entry.ownerId, `${itemLabel(entry.itemType)} 복원`, entry.itemType === 'attachment' ? entry.title : undefined);
        return summary;
      });
      res.json(restored);
    });
    app.delete('/api/trash/items/:id', (req, res) => {
      hooks.actor(req);
      this.store.transaction(() => {
        const entry = this.get(req.params.id);
        this.queueCleanup(trashItemFiles(entry));
        if (entry.itemType === 'comment' && entry.ownerType === 'document' && entry.item.documentSource) {
          this.store.db.prepare(`DELETE FROM trash_items WHERE item_type='comment' AND owner_type='document' AND owner_id=?
            AND json_extract(json,'$.item.parentCommentId')=?`).run(entry.ownerId, entry.item.id);
        }
        this.store.remove('trash_items', entry.id);
        hooks.activity(req, entry.ownerType, entry.ownerId, `${itemLabel(entry.itemType)} 영구 삭제`, entry.itemType === 'attachment' ? entry.title : undefined);
      });
      this.finishCleanup();
      res.json({ ok: true });
    });
  }
}
