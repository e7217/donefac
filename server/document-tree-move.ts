import { createHash } from 'node:crypto';
import type { DocPage, DocumentTreeMovePreview, Project } from '../shared/types.js';
import type { Store } from './store.js';
import type { ArchivedDocumentTreeMember, TrashService } from './trash.js';

type Destination = { projectId: string | null; parentId: string | null };
type DocumentTreeMember = Pick<DocPage, 'id' | 'projectId' | 'parentId' | 'version' | 'title'>;

export class DocumentTreeMoveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const stale = () => new DocumentTreeMoveError(409, '문서 또는 이동할 위치가 변경되었습니다. 다시 미리보기를 확인해 주세요.');
const nullableId = (value: unknown): value is string | null => value === null ||
  typeof value === 'string' && value.length <= 200 && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);

function moveRequest(body: unknown, applying: boolean) {
  const message = '이동할 공간과 상위 문서를 확인해 주세요.';
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DocumentTreeMoveError(400, message);
  const { projectId, parentId, token } = body as Record<string, unknown>;
  const fields = applying ? ['projectId', 'parentId', 'actorId', 'token'] : ['projectId', 'parentId', 'actorId'];
  if (!nullableId(projectId) || !nullableId(parentId) || Object.keys(body).some(key => !fields.includes(key))) {
    throw new DocumentTreeMoveError(400, message);
  }
  return { target: { projectId, parentId }, token };
}

export class DocumentTreeMoveService {
  private readonly findDocument;
  private readonly findChildren;

  constructor(private readonly store: Store, private readonly trash: TrashService) {
    const select = `SELECT id,project_id AS projectId,parent_id AS parentId,
      json_extract(json,'$.version') AS version,json_extract(json,'$.title') AS title FROM documents`;
    this.findDocument = store.db.prepare(`${select} WHERE id=?`);
    this.findChildren = store.db.prepare(`${select} WHERE parent_id=? ORDER BY id`);
  }

  private document(id: string): DocumentTreeMember | undefined {
    return this.findDocument.get(id) as DocumentTreeMember | undefined;
  }

  private plan(documentId: string, target: Destination, actorId: string, applying: boolean) {
    const invalid = (status: number, message: string): never => {
      throw applying ? stale() : new DocumentTreeMoveError(status, message);
    };
    const root = this.document(documentId) ?? invalid(404, '문서를 찾을 수 없습니다.');
    const targetProject = target.projectId === null ? null : this.store.get<Project>('projects', target.projectId) ??
      invalid(404, '이동할 프로젝트를 찾을 수 없습니다.');
    const sourceProject = root.projectId === null ? null : this.store.get<Project>('projects', root.projectId);
    const sourceParent = root.parentId === null ? null : this.document(root.parentId);
    const documents = [root];
    const archived: ArchivedDocumentTreeMember[] = [];
    const visited = new Set<string>();
    for (let index = 0; index < documents.length; index++) {
      const current = documents[index];
      if (visited.has(current.id) || current.projectId !== root.projectId) invalid(409, '이동할 문서의 트리 구조를 확인해 주세요.');
      visited.add(current.id);
      for (const child of this.findChildren.all(current.id) as DocumentTreeMember[]) documents.push(child);
      for (const child of this.trash.documentChildren(current.id)) archived.push(child);
    }
    for (let index = 0; index < archived.length; index++) {
      const current = archived[index];
      if (visited.has(current.resourceId)) invalid(409, '휴지통의 문서 트리 구조를 확인해 주세요.');
      visited.add(current.resourceId);
      for (const child of this.trash.documentChildren(current.resourceId)) archived.push(child);
    }
    const ancestors: DocumentTreeMember[] = [];
    for (let id = target.parentId; id !== null;) {
      if (visited.has(id)) invalid(409, '이동하는 문서나 하위 문서를 상위 문서로 선택할 수 없습니다.');
      const parent = this.document(id) ?? invalid(404, '이동할 상위 문서를 찾을 수 없습니다.');
      if (parent.projectId !== target.projectId) invalid(409, '상위 문서는 이동할 공간에 있어야 합니다.');
      visited.add(parent.id);
      ancestors.push(parent);
      id = parent.parentId;
    }
    const changesSpace = root.projectId !== target.projectId;
    const changed = changesSpace || root.parentId !== target.parentId;
    const affected = changesSpace ? documents : changed ? [root] : [];
    if (affected.some(document => !Number.isSafeInteger(document.version + 1))) {
      invalid(409, '이동할 문서의 버전 범위를 초과했습니다.');
    }
    const token = createHash('sha256').update(JSON.stringify([
      this.store.setting('attachmentImportGeneration'), actorId, target, sourceProject, sourceParent, targetProject,
      ancestors, documents, archived,
    ])).digest('hex');
    const preview: DocumentTreeMovePreview = {
      ...target, token, documentId, sourceProjectId: root.projectId, sourceParentId: root.parentId,
      destination: { projectName: targetProject?.name ?? null, parents: ancestors.toReversed().map(({ id, title }) => ({ id, title })) },
      documents: documents.map(({ id, title }) => ({ id, title })), archivedCount: archived.length, changed,
    };
    return { preview, affected, archived };
  }

  preview(documentId: string, actorId: string, body: unknown): DocumentTreeMovePreview {
    const { target } = moveRequest(body, false);
    return this.store.transaction(() => this.plan(documentId, target, actorId, false).preview);
  }

  move(documentId: string, actorId: string, body: unknown, record: (document: DocPage) => void) {
    const { target, token } = moveRequest(body, true);
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new DocumentTreeMoveError(400, '문서 이동 미리보기가 필요합니다.');
    }
    return this.store.transaction(() => {
      const { preview, affected, archived } = this.plan(documentId, target, actorId, true);
      if (preview.token !== token) throw stale();
      if (!preview.changed) return { preview, moved: [] };
      const updatedAt = new Date().toISOString();
      const moved = affected.map(({ id }) => {
        const current = this.store.get<DocPage>('documents', id)!;
        const document: DocPage = { ...current, projectId: target.projectId,
          parentId: id === documentId ? target.parentId : current.parentId, version: current.version + 1, updatedAt };
        this.store.put('documents', document);
        return document;
      });
      if (preview.sourceProjectId !== preview.projectId) this.trash.moveDocumentEntries(archived, preview.projectId);
      for (const document of moved) record(document);
      return { preview, moved };
    });
  }
}
