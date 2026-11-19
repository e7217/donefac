import { randomUUID } from 'node:crypto';
import type { Attachment, AttachmentHead, AttachmentVersion } from '../shared/types.js';
import { AttachmentAppend } from './attachment-append.js';
import { hash, sniffMime } from './attachments.js';
import type { Store } from './store.js';

export class AttachmentVersionError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { currentVersionId: string }) {
    super(message);
  }
}

interface VersionFile {
  filename: string;
  bytes: Buffer;
  authorId: string;
}

export class AttachmentVersionsService {
  private readonly files: AttachmentAppend;
  private readonly summary;
  private readonly insert;

  constructor(private readonly store: Store, dataDir: string) {
    this.files = new AttachmentAppend(dataDir);
    this.summary = store.db.prepare(`SELECT (
      SELECT json FROM attachment_versions WHERE attachment_id=? AND json_type(json,'$.localRevision')='integer'
      ORDER BY json_extract(json,'$.localRevision') DESC LIMIT 1
    ) AS latest, COUNT(*) AS stored, COUNT(*) FILTER (WHERE id=?) AS storedAnchor
      FROM attachment_versions WHERE attachment_id=?`);
    this.insert = store.db.prepare('INSERT INTO attachment_versions(id,attachment_id,json) VALUES(?,?,?)');
  }

  private headState(attachment: Attachment): { head: AttachmentHead; localRevision: number } {
    const { latest, stored, storedAnchor } = this.summary.get(attachment.id, attachment.id, attachment.id) as {
      latest: string | null; stored: number; storedAnchor: number;
    };
    const local: AttachmentVersion | null = latest ? JSON.parse(latest) : null;
    const { filename, mimeType, size, sha256, authorId, createdAt } = local ?? attachment;
    const head: AttachmentHead = {
      ...attachment, filename, mimeType, size, sha256, authorId, createdAt,
      currentVersionId: local?.id ?? attachment.id, versionCount: stored + 1 - storedAnchor, hasVersionHistory: stored > 0,
    };
    return { head, localRevision: local?.localRevision ?? 1 };
  }

  head(attachment: Attachment): AttachmentHead {
    return this.headState(attachment).head;
  }

  /** Every version gets its own binary ID. Existing links can keep resolving the exact bytes they referenced. */
  append(attachmentId: string, expectedVersionId: string, file: VersionFile, onAdded: (version: AttachmentVersion) => void): AttachmentHead {
    let staged: ReturnType<AttachmentAppend['stage']> | undefined;
    let result: AttachmentHead;
    try {
      result = this.store.transaction(() => {
        const attachment = this.store.get<Attachment>('attachments', attachmentId);
        if (!attachment || !this.store.get(attachment.resourceType === 'issue' ? 'issues' : 'documents', attachment.resourceId)) {
          throw new AttachmentVersionError(404, '첨부파일을 찾을 수 없습니다.');
        }
        const current = this.headState(attachment);
        if (current.head.currentVersionId !== expectedVersionId) {
          throw new AttachmentVersionError(409, '다른 작업자가 첨부 버전을 변경했습니다. 최신 파일을 확인해 주세요.', { currentVersionId: current.head.currentVersionId });
        }
        if (!this.store.get('users', file.authorId)) throw new AttachmentVersionError(400, '작업자를 찾을 수 없습니다.');
        const id = randomUUID(), localRevision = current.localRevision + 1;
        if (this.store.get('attachments', id)) throw new AttachmentVersionError(409, '같은 첨부 파일 ID가 이미 존재합니다.');
        const version: AttachmentVersion = {
          id, attachmentId, resourceType: attachment.resourceType, resourceId: attachment.resourceId,
          filename: file.filename, mimeType: sniffMime(file.bytes), size: file.bytes.length, sha256: hash(file.bytes),
          authorId: file.authorId, createdAt: new Date().toISOString(), versionLabel: `v${localRevision}`,
          sourceImportId: null, sourceRecordId: null, localRevision,
        };
        staged = this.files.stage(id, [{ id, bytes: file.bytes, size: version.size, sha256: version.sha256 }]);
        this.insert.run(id, attachmentId, JSON.stringify(version));
        staged.install();
        onAdded(version);
        return this.head(attachment);
      });
    } catch (error) {
      try { staged?.rollback(); } catch { console.error('[teamspace attachments] 버전 추가 복구 기록 정리가 필요합니다.'); }
      throw error;
    }
    try { staged?.commit(); } catch { console.error('[teamspace attachments] 버전 추가 복구 기록 정리가 필요합니다.'); }
    return result;
  }
}
