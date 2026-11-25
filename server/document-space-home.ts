import type { DocPage, DocumentSpaceHome, Project } from '../shared/types.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

export class DocumentSpaceHomeError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { reason: 'home_changed' | 'workspace_changed' }) {
    super(message);
  }
}

const scope = (projectId: string | null) => projectId ?? '';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export class DocumentSpaceHomeService {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS document_space_homes(
        scope TEXT PRIMARY KEY,
        document_id TEXT UNIQUE,
        version INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS clear_document_space_home_on_delete
        AFTER DELETE ON documents
        BEGIN UPDATE document_space_homes SET document_id=NULL,version=version+1 WHERE document_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS clear_document_space_home_on_move
        AFTER UPDATE OF project_id ON documents WHEN OLD.project_id IS NOT NEW.project_id
        BEGIN UPDATE document_space_homes SET document_id=NULL,version=version+1 WHERE document_id=OLD.id; END;
    `);
  }

  space(value: unknown): string | null {
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw new DocumentSpaceHomeError(400, '문서 공간을 확인해 주세요.');
    }
    if (!this.store.get<Project>('projects', value)) throw new DocumentSpaceHomeError(404, '문서 공간을 찾을 수 없습니다.');
    return value;
  }

  get(projectId: string | null): DocumentSpaceHome {
    const row = this.store.db.prepare('SELECT document_id AS documentId,version FROM document_space_homes WHERE scope=?')
      .get(scope(projectId)) as Omit<DocumentSpaceHome, 'projectId'> | undefined;
    return { projectId, ...(row ?? { documentId: null, version: 0 }) };
  }

  snapshot(): DocumentSpaceHome[] {
    return this.store.db.prepare('SELECT NULLIF(scope,\'\') AS projectId,document_id AS documentId,version FROM document_space_homes ORDER BY scope')
      .all() as unknown as DocumentSpaceHome[];
  }

  private put({ projectId, documentId, version }: DocumentSpaceHome) {
    this.store.db.prepare(`INSERT INTO document_space_homes(scope,document_id,version) VALUES (?,?,?)
      ON CONFLICT(scope) DO UPDATE SET document_id=excluded.document_id,version=excluded.version`).run(scope(projectId), documentId, version);
  }

  save(projectId: string | null, value: unknown): DocumentSpaceHome {
    if (!isRecord(value) || Object.keys(value).some(key => !['documentId', 'expectedVersion', 'restoreGeneration'].includes(key)) ||
        !isVersion(value.expectedVersion) || (value.documentId !== null && (typeof value.documentId !== 'string' || !value.documentId)) ||
        typeof value.restoreGeneration !== 'string' || !value.restoreGeneration) {
      throw new DocumentSpaceHomeError(400, '문서 공간 홈과 확인한 버전을 보내 주세요.');
    }
    const { documentId, expectedVersion, restoreGeneration } = value;
    return this.store.transaction(() => {
      if (restoreGeneration !== workspaceRestoreGeneration(this.store)) {
        throw new DocumentSpaceHomeError(409, '워크스페이스가 복원되었습니다. 공간의 최신 홈을 확인해 주세요.', { reason: 'workspace_changed' });
      }
      if (projectId !== null) this.space(projectId);
      const previous = this.get(projectId);
      if (expectedVersion !== previous.version) {
        throw new DocumentSpaceHomeError(409, '다른 작업자가 공간 홈을 변경했습니다. 최신 홈을 확인해 주세요.', { reason: 'home_changed' });
      }
      if (documentId !== null) {
        const document = this.store.get<DocPage>('documents', documentId);
        if (!document || document.projectId !== projectId) {
          throw new DocumentSpaceHomeError(422, '현재 공간에 저장된 문서를 홈으로 선택해 주세요.');
        }
      }
      if (documentId === previous.documentId) return previous;
      const home = { projectId, documentId, version: previous.version + 1 };
      this.put(home);
      return home;
    });
  }

  validateImport(value: unknown, projects: Project[], documents: DocPage[]): DocumentSpaceHome[] {
    const invalid = () => new DocumentSpaceHomeError(400, '백업의 문서 공간 홈과 저장된 문서 위치를 확인해 주세요.');
    if (!Array.isArray(value) || value.length > projects.length + 1) throw invalid();
    const projectIds = new Set(projects.map(project => project.id));
    const positions = new Map(documents.map(document => [document.id, document.projectId]));
    const seen = new Set<string | null>();
    return value.map(entry => {
      if (!isRecord(entry) || Object.keys(entry).length !== 3) throw invalid();
      const { projectId, documentId, version } = entry;
      if ((projectId !== null && (typeof projectId !== 'string' || !projectIds.has(projectId))) ||
          (documentId !== null && (typeof documentId !== 'string' || !positions.has(documentId) || positions.get(documentId) !== projectId)) ||
          !isVersion(version) || version === 0 || version >= Number.MAX_SAFE_INTEGER || seen.has(projectId)) throw invalid();
      seen.add(projectId);
      return { projectId, documentId, version };
    });
  }

  replaceImported(homes: DocumentSpaceHome[]) {
    this.store.db.exec('DELETE FROM document_space_homes');
    for (const home of homes) this.put(home);
  }
}
