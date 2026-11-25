import type { Project } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type Failure = 'invalid_request' | 'request_conflict' | 'result_unavailable' | 'workspace_changed' | 'duplicate_key';
type Receipt = { actorId: string; fingerprint: string; projectId: string | null };

export class ProjectCreationError extends Error {
  readonly details: { reason: Failure };

  constructor(readonly status: number, message: string, reason: Failure) {
    super(message);
    this.details = { reason };
  }
}

export class ProjectCreationService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_creation_requests (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      project_id TEXT
    )`);
  }

  create(input: Record<string, unknown>, actorId: () => string, project: () => Project,
    recordCreation: (project: Project, actorId: string) => void): { project: Project; duplicate: boolean } {
    const requestId = input.requestId;
    const generation = input.restoreGeneration;
    if ((Object.hasOwn(input, 'requestId') && (typeof requestId !== 'string' || !creationRequestId.test(requestId))) ||
        (Object.hasOwn(input, 'restoreGeneration') && (typeof generation !== 'string' || !generation))) {
      throw new ProjectCreationError(400, '프로젝트 생성 요청 ID와 워크스페이스 정보를 확인해 주세요.', 'invalid_request');
    }
    const id = typeof requestId === 'string' ? requestId.toLowerCase() : undefined;
    return this.store.transaction(() => {
      if (generation !== undefined && generation !== workspaceRestoreGeneration(this.store)) {
        throw new ProjectCreationError(409, '워크스페이스가 복원되었습니다. 프로젝트 목록을 새로 확인해 주세요.', 'workspace_changed');
      }
      const author = actorId();
      const fingerprint = id ? creationRequestFingerprint(input) : '';
      const receipt = id ? this.store.db.prepare(`SELECT actor_id AS actorId, fingerprint, project_id AS projectId
        FROM project_creation_requests WHERE id=?`).get(id) as Receipt | undefined : undefined;
      if (receipt) {
        if (receipt.actorId !== author || receipt.fingerprint !== fingerprint) {
          throw new ProjectCreationError(409, '이미 사용한 프로젝트 생성 요청입니다. 저장된 프로젝트를 확인해 주세요.', 'request_conflict');
        }
        const saved = receipt.projectId ? this.store.get<Project>('projects', receipt.projectId) : undefined;
        if (!saved) {
          throw new ProjectCreationError(409, '이 요청의 프로젝트를 현재 확인할 수 없습니다. 프로젝트 목록을 새로 확인해 주세요.', 'result_unavailable');
        }
        return { project: saved, duplicate: true };
      }

      const created = project();
      if (this.store.db.prepare('SELECT 1 FROM projects WHERE key=?').get(created.key)) {
        throw new ProjectCreationError(409, '이미 사용 중인 티켓 접두어입니다. 다른 접두어를 입력해 주세요.', 'duplicate_key');
      }
      this.store.put('projects', created);
      this.store.db.prepare('INSERT INTO issue_sequences VALUES(?,1)').run(created.id);
      recordCreation(created, author);
      if (id) this.store.db.prepare('INSERT INTO project_creation_requests(id,actor_id,fingerprint,project_id) VALUES(?,?,?,?)')
        .run(id, author, fingerprint, created.id);
      return { project: created, duplicate: false };
    });
  }

  invalidateForImport(): void {
    if (!this.store.db.isTransaction) throw new Error('Project creation receipts must be invalidated in the import transaction.');
    this.store.db.exec('UPDATE project_creation_requests SET project_id=NULL WHERE project_id IS NOT NULL');
  }
}
