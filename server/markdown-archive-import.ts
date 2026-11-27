import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_MARKDOWN_ARCHIVE_BYTES,
  type DocumentMarkdownArchivePreview,
  type DocumentMarkdownArchiveResult,
  type DocumentMarkdownArchiveTarget,
} from '../shared/document-markdown-archive.js';
import type { DocPage, Project } from '../shared/types.js';
import type { AttachmentAppend } from './attachment-append.js';
import { creationRequestId } from './creation-request.js';
import { prepareMarkdownArchive } from './markdown-archive-content.js';
import type { Store } from './store.js';

const PREVIEW_LIFETIME_MS = 30 * 60 * 1000;
const RESULT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

type ImportHooks = {
  validateDocument: (document: DocPage) => void;
  validateBatch: (documents: DocPage[]) => void;
  record: (document: DocPage) => void;
};
type Reason = 'invalid_input' | 'archive_changed' | 'scope_missing' | 'scope_changed' |
  'preview_missing' | 'preview_expired' | 'actor_missing';
type StoredResult = Omit<DocumentMarkdownArchiveResult, 'duplicate'>;
type Receipt = DocumentMarkdownArchiveTarget & {
  size: number;
  digest: string;
  targetVersion: string;
  reviewVersion: string;
  expiresAt: number;
  result: string | null;
};
type Plan = Awaited<ReturnType<typeof prepareMarkdownArchive>>;

export class MarkdownArchiveImportError extends Error {
  readonly details: { reason: Reason };

  constructor(readonly status: number, message: string, reason: Reason) {
    super(message);
    this.details = { reason };
  }
}

const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const scopeChanged = () => new MarkdownArchiveImportError(409,
  '문서 공간이나 상위 문서가 변경되었습니다. 다시 미리 확인해 주세요.', 'scope_changed');
const archiveChanged = () => new MarkdownArchiveImportError(409,
  '미리 확인한 ZIP 파일과 일치하지 않습니다. 다시 미리 확인해 주세요.', 'archive_changed');

function reviewSummary(plan: Plan) {
  return { format: plan.format, pages: plan.pages, warnings: plan.warnings, attachmentCount: plan.attachments.length };
}

function nullableId(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value === value.trim() && !/\p{Cc}/u.test(value);
}

function checkBytes(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new MarkdownArchiveImportError(400, '가져올 Markdown ZIP 파일을 선택해 주세요.', 'invalid_input');
  }
  if (bytes.length > MAX_MARKDOWN_ARCHIVE_BYTES) {
    throw new MarkdownArchiveImportError(413, 'Markdown ZIP 파일은 64MiB까지 가져올 수 있습니다.', 'invalid_input');
  }
}

export class MarkdownArchiveImportService {
  private readonly readReceipt;
  private readonly insertPreview;
  private readonly saveResult;
  private readonly prune;

  constructor(private readonly store: Store, private readonly files: AttachmentAppend) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS markdown_archive_imports (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      project_id TEXT,
      parent_id TEXT,
      size INTEGER NOT NULL,
      digest TEXT NOT NULL,
      target_version TEXT NOT NULL,
      review_version TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      result TEXT
    )`);
    this.readReceipt = store.db.prepare(`SELECT project_id AS projectId, parent_id AS parentId, size, digest,
      target_version AS targetVersion, review_version AS reviewVersion, expires_at AS expiresAt, result
      FROM markdown_archive_imports WHERE id=? AND actor_id=?`);
    this.insertPreview = store.db.prepare(`INSERT INTO markdown_archive_imports
      (id, actor_id, project_id, parent_id, size, digest, target_version, review_version, expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    this.saveResult = store.db.prepare('UPDATE markdown_archive_imports SET result=?, expires_at=? WHERE id=?');
    this.prune = store.db.prepare('DELETE FROM markdown_archive_imports WHERE expires_at<=?');
  }

  private requireActor(actorId: string): void {
    if (!this.store.get('users', actorId)) {
      throw new MarkdownArchiveImportError(404, '작업자를 찾을 수 없습니다.', 'actor_missing');
    }
  }

  private targetVersion({ projectId, parentId }: DocumentMarkdownArchiveTarget, checked: boolean): string {
    const missing = (): never => {
      if (checked) throw scopeChanged();
      throw new MarkdownArchiveImportError(404, '가져올 문서 공간과 상위 문서를 확인해 주세요.', 'scope_missing');
    };
    const project = projectId === null ? null : this.store.get<Project>('projects', projectId) ?? missing();
    const ancestors: [id: string, parentId: string | null, version: number][] = [];
    const seen = new Set<string>();
    for (let id = parentId; id !== null;) {
      if (seen.has(id)) return missing();
      seen.add(id);
      const page = this.store.get<DocPage>('documents', id);
      if (!page || page.projectId !== projectId) return missing();
      ancestors.push([page.id, page.parentId, page.version]);
      id = page.parentId;
    }
    return digest(JSON.stringify([this.store.setting('attachmentImportGeneration'), project, ancestors]));
  }

  async preview(scope: DocumentMarkdownArchiveTarget, actorId: string, bytes: Buffer): Promise<DocumentMarkdownArchivePreview> {
    if (!nullableId(scope.projectId) || !nullableId(scope.parentId)) {
      throw new MarkdownArchiveImportError(400, '가져올 문서 공간과 상위 문서를 확인해 주세요.', 'invalid_input');
    }
    checkBytes(bytes);
    this.requireActor(actorId);
    const targetVersion = this.targetVersion(scope, false);
    const fileDigest = digest(bytes);
    const { projectId, parentId } = scope;
    const plan = await prepareMarkdownArchive(bytes, { projectId, parentId, actorId, timestamp: new Date().toISOString() });
    const summary = reviewSummary(plan);
    return this.store.transaction(() => {
      this.requireActor(actorId);
      if (targetVersion !== this.targetVersion({ projectId, parentId }, true)) throw scopeChanged();
      if (fileDigest !== digest(bytes)) throw archiveChanged();
      const timestamp = Date.now(), id = randomUUID();
      const expiresAt = timestamp + PREVIEW_LIFETIME_MS;
      this.prune.run(timestamp);
      this.insertPreview.run(id, actorId, projectId, parentId, bytes.length, fileDigest,
        targetVersion, digest(JSON.stringify(summary)), expiresAt);
      return { id, projectId, parentId, expiresAt: new Date(expiresAt).toISOString(), ...summary };
    });
  }

  private receipt(id: string, actorId: string, size: number, fileDigest: string): Receipt {
    this.requireActor(actorId);
    const receipt = this.readReceipt.get(id, actorId) as Receipt | undefined;
    if (!receipt) throw new MarkdownArchiveImportError(404, '가져오기 미리보기를 찾을 수 없습니다.', 'preview_missing');
    if (receipt.expiresAt <= Date.now()) {
      throw new MarkdownArchiveImportError(410, '미리보기 또는 적용 결과가 만료되었습니다. 문서 목록을 확인해 주세요.', 'preview_expired');
    }
    if (receipt.size !== size || receipt.digest !== fileDigest) throw archiveChanged();
    return receipt;
  }

  async apply(previewId: string, actorId: string, bytes: Buffer, hooks: ImportHooks): Promise<DocumentMarkdownArchiveResult> {
    if (!creationRequestId.test(previewId)) {
      throw new MarkdownArchiveImportError(400, '가져오기 미리보기 ID를 확인해 주세요.', 'invalid_input');
    }
    checkBytes(bytes);
    const id = previewId.toLowerCase(), fileDigest = digest(bytes);
    const receipt = this.receipt(id, actorId, bytes.length, fileDigest);
    if (receipt.result) return { ...JSON.parse(receipt.result) as StoredResult, duplicate: true };
    if (receipt.targetVersion !== this.targetVersion(receipt, true)) throw scopeChanged();

    const plan = await prepareMarkdownArchive(bytes, {
      projectId: receipt.projectId, parentId: receipt.parentId, actorId, timestamp: new Date().toISOString(),
    });
    const reviewVersion = digest(JSON.stringify(reviewSummary(plan)));
    let staged: ReturnType<AttachmentAppend['stage']> | undefined;
    let committed: DocumentMarkdownArchiveResult;
    try {
      committed = this.store.transaction(() => {
        const current = this.receipt(id, actorId, bytes.length, digest(bytes));
        if (current.result) return { ...JSON.parse(current.result) as StoredResult, duplicate: true };
        if (current.targetVersion !== this.targetVersion(current, true)) throw scopeChanged();
        if (reviewVersion !== current.reviewVersion) throw archiveChanged();

        const { documents, attachments } = plan;
        const documentIds = documents.map(document => document.id);
        const rootIds = documents.filter(document => document.parentId === current.parentId).map(document => document.id);
        const [firstRoot] = rootIds;
        if (!firstRoot) throw new Error('The prepared Markdown archive has no root documents.');
        for (const document of documents) {
          hooks.validateDocument(document);
          this.store.put('documents', document);
        }
        hooks.validateBatch(documents);
        if (attachments.length) {
          staged = this.files.stage(firstRoot, attachments.map(({ attachment, bytes: content }) => ({
            id: attachment.id, bytes: content, sha256: attachment.sha256, size: attachment.size,
          })));
          for (const { attachment } of attachments) this.store.put('attachments', attachment);
          staged.install();
        }
        for (const document of documents) hooks.record(document);
        const result: StoredResult = { documentIds, rootIds, attachmentCount: attachments.length };
        this.saveResult.run(JSON.stringify(result), Date.now() + RESULT_LIFETIME_MS, id);
        return { ...result, duplicate: false };
      });
    } catch (error) {
      try { staged?.rollback(); }
      catch { console.error('[donefac attachments] Markdown ZIP 첨부 복구 기록 정리가 필요합니다.'); }
      throw error;
    }
    try { staged?.commit(); }
    catch { console.error('[donefac attachments] Markdown ZIP 첨부 복구 기록 정리가 필요합니다.'); }
    return committed;
  }

  reset(): void {
    if (!this.store.db.isTransaction) throw new Error('Markdown archive import receipts must reset within the workspace import transaction.');
    this.store.db.exec('DELETE FROM markdown_archive_imports');
  }
}
