import { createHash, randomUUID } from 'node:crypto';
import { isLiveDocumentInclude } from '../shared/document-nodes.js';
import { documentNodes } from '../shared/document-references.js';
import { documentSectionHash, isDocumentSectionId } from '../shared/document-sections.js';
import type { Attachment, DocPage, DocumentSiblingOrder, DocumentTreeCopyOptions, DocumentTreeCopyPreview, Project } from '../shared/types.js';
import { MAX_PACKAGE_BYTES } from './attachments.js';
import { creationRequestId } from './creation-request.js';
import { workspaceContentOrigins, workspaceContentUrl } from './document-content-urls.js';
import type { DocumentCopyAssets } from './document-copy-assets.js';
import type { DocumentOrderService } from './document-order.js';
import type { Store } from './store.js';

const MAX_COPY_DOCUMENTS = 100;
const documentRoute = /^#\/[^/?#]+\/documents\/([^/?#]+)(?:\?([^#]*))?$/u;
const optionsFields = ['title', 'projectId', 'parentId', 'includeDescendants', 'expectedSourceVersion', 'actorId'];
const applyFields = [...optionsFields, 'token', 'requestId'];
type Member = Pick<DocPage, 'id' | 'projectId' | 'parentId' | 'version' | 'title'>;

export class DocumentTreeCopyError extends Error {
  readonly details: { reason: string };

  constructor(readonly status: number, message: string, readonly reason: string) {
    super(message);
    this.details = { reason };
  }
}

const stale = () => new DocumentTreeCopyError(409, '원본 문서나 첨부 또는 복제할 위치가 변경되었습니다. 다시 미리 확인해 주세요.', 'copy_preview_stale');
const invalidInput = () => new DocumentTreeCopyError(400, '복제할 제목과 위치, 원본 버전을 확인해 주세요.', 'copy_invalid_input');
const nullableId = (value: unknown): value is string | null => value === null ||
  typeof value === 'string' && value.length <= 200 && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value);

function copyRequest(body: unknown, applying: boolean) {
  const fields = applying ? applyFields : optionsFields;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw invalidInput();
  const { title, projectId, parentId, includeDescendants, expectedSourceVersion, token, requestId } = body as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim() || title.length > 300 || !title.isWellFormed() ||
    !nullableId(projectId) || !nullableId(parentId) || typeof includeDescendants !== 'boolean' ||
    typeof expectedSourceVersion !== 'number' || !Number.isSafeInteger(expectedSourceVersion) || expectedSourceVersion < 1) {
    throw invalidInput();
  }
  if (applying && (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token) ||
    typeof requestId !== 'string' || !creationRequestId.test(requestId))) {
    throw new DocumentTreeCopyError(400, '문서 복제 미리보기와 저장 요청을 확인해 주세요.', 'copy_invalid_request');
  }
  const options: DocumentTreeCopyOptions = { title: title.trim(), projectId, parentId, includeDescendants, expectedSourceVersion };
  return { options, token };
}

function rewriteDocumentLink(href: string, copy: DocPage, sections: ReadonlySet<string>, ids: ReadonlyMap<string, string>, origins: ReadonlySet<string>): string | undefined {
  const url = workspaceContentUrl(href, origins);
  if (!url?.hash || url.username || url.password || url.pathname !== '/' || url.search) return;
  const fragment = url.hash;
  const match = documentRoute.exec(fragment);
  if (!match) {
    if (sections.has(fragment.slice(1))) return documentSectionHash(copy.id, fragment.slice(1));
    return;
  }
  let documentId: string;
  try { documentId = decodeURIComponent(match[1]); }
  catch { return; }
  const newId = ids.get(documentId);
  if (!newId) return;
  const query = new URLSearchParams(match[2]);
  if (query.size === 0) return `#/all/documents/${encodeURIComponent(newId)}`;
  const section = query.get('section');
  if (query.size === 1 && isDocumentSectionId(section)) return documentSectionHash(newId, section);
}

function rebindDocumentReferences(copy: DocPage, ids: ReadonlyMap<string, string>, origins: ReadonlySet<string>) {
  const sections = new Set<string>();
  for (const node of documentNodes(copy.content)) {
    if (node.type === 'heading' && isDocumentSectionId(node.attrs?.sectionId)) sections.add(node.attrs.sectionId);
  }
  for (const node of documentNodes(copy.content)) {
    const attrs = node.attrs;
    if (typeof attrs?.documentId === 'string' && (node.type === 'documentReference' || isLiveDocumentInclude(node.type) ||
      (node.type === 'documentChildList' && attrs.scope === 'document'))) {
      const target = ids.get(attrs.documentId);
      if (target) attrs.documentId = target;
    }
    for (const mark of node.marks ?? []) {
      if (mark.type !== 'link' || typeof mark.attrs?.href !== 'string') continue;
      const href = rewriteDocumentLink(mark.attrs.href, copy, sections, ids, origins);
      if (href) mark.attrs.href = href;
    }
  }
}

export class DocumentTreeCopyService {
  private readonly findMember;
  private readonly findChildren;

  constructor(private readonly store: Store, private readonly assets: DocumentCopyAssets, private readonly orders: DocumentOrderService) {
    this.findMember = store.db.prepare(`SELECT id,project_id AS projectId,parent_id AS parentId,
      json_extract(json,'$.version') AS version,json_extract(json,'$.title') AS title FROM documents WHERE id=?`);
    this.findChildren = store.db.prepare('SELECT id FROM documents WHERE parent_id=? ORDER BY rowid');
  }

  private plan(sourceDocumentId: string, actorId: string, options: DocumentTreeCopyOptions, origins: readonly string[], applying: boolean) {
    const invalid = (status: number, message: string, reason: string): never => {
      throw applying ? stale() : new DocumentTreeCopyError(status, message, reason);
    };
    const root = this.store.get<DocPage>('documents', sourceDocumentId) ?? invalid(404, '원본 문서를 찾을 수 없습니다.', 'copy_source_missing');
    if (root.version !== options.expectedSourceVersion) throw stale();
    const sourceProject = root.projectId === null ? null : this.store.get<Project>('projects', root.projectId) ??
      invalid(404, '원본 문서 공간을 찾을 수 없습니다.', 'copy_source_missing');
    const targetProject = options.projectId === null ? null : this.store.get<Project>('projects', options.projectId) ??
      invalid(404, '복제할 문서 공간을 찾을 수 없습니다.', 'copy_destination_missing');

    function hierarchyError(): never {
      return invalid(409, '원본 문서의 계층 또는 복제할 상위 문서를 확인해 주세요.', 'copy_invalid_hierarchy');
    }
    const ancestors = (parentId: string | null, projectId: string | null, excludedId?: string): Member[] => {
      const result: Member[] = [];
      const seen = new Set(excludedId ? [excludedId] : []);
      for (let id = parentId; id !== null;) {
        if (seen.has(id)) hierarchyError();
        const member = this.findMember.get(id) as Member | undefined;
        if (!member) return invalid(404, '상위 문서를 찾을 수 없습니다.', 'copy_parent_missing');
        if (member.projectId !== projectId) hierarchyError();
        seen.add(id);
        result.push(member);
        id = member.parentId;
      }
      return result;
    };
    const sourceAncestors = ancestors(root.parentId, root.projectId, root.id);
    const destinationAncestors = ancestors(options.parentId, options.projectId);
    const pending = [root.id];
    const discovered = new Set(pending);
    const documents: DocPage[] = [];
    const customOrders = new Map<string, string[]>();
    let contentBytes = 0;
    for (const id of pending) {
      const page = id === root.id ? root : this.store.get<DocPage>('documents', id) ?? hierarchyError();
      if (page.projectId !== root.projectId) hierarchyError();
      contentBytes += Buffer.byteLength(JSON.stringify(page.content));
      if (contentBytes > MAX_PACKAGE_BYTES) invalid(413, '한 번에 본문 64MiB까지 복제할 수 있습니다.', 'copy_limit_exceeded');
      documents.push(page);
      if (!options.includeDescendants) continue;
      const children: string[] = [];
      for (const { id: childId } of this.findChildren.iterate(id) as Iterable<{ id: string }>) {
        if (discovered.has(childId)) hierarchyError();
        if (pending.length + children.length === MAX_COPY_DOCUMENTS) invalid(413, `한 번에 문서 ${MAX_COPY_DOCUMENTS}개까지 복제할 수 있습니다.`, 'copy_limit_exceeded');
        discovered.add(childId);
        children.push(childId);
      }
      const order = this.orders.childOrder(id, children);
      if (order.custom) customOrders.set(id, order.documentIds);
      pending.push(...order.documentIds);
    }

    const authorizedOrigins = workspaceContentOrigins(origins);
    const assetPlan = this.assets.plan(documents, [...authorizedOrigins]);
    const token = createHash('sha256').update(JSON.stringify([
      'document-tree-copy', this.store.setting('attachmentImportGeneration'), actorId, options, sourceProject, targetProject,
      sourceAncestors, destinationAncestors, documents.map(({ id, parentId, projectId, version, title }) => [id, parentId, projectId, version, title]),
      [...authorizedOrigins].sort(), assetPlan.fingerprint, [...customOrders.keys()],
    ])).digest('hex');
    const preview: DocumentTreeCopyPreview = {
      ...options, sourceDocumentId, token, documents: documents.map(({ id, title, version }) => ({ id, title, version })),
      attachmentCount: assetPlan.attachmentCount, attachmentBytes: assetPlan.attachmentBytes, warnings: assetPlan.warnings,
    };
    return { preview, documents, assetPlan, authorizedOrigins, customOrders };
  }

  preview(sourceId: string, actorId: string, body: unknown, origins: readonly string[]): DocumentTreeCopyPreview {
    const { options } = copyRequest(body, false);
    return this.store.transaction(() => this.plan(sourceId, actorId, options, origins, false).preview);
  }

  prepareCopy(sourceId: string, actorId: string, body: unknown, origins: readonly string[], timestamp: string): {
    documents: DocPage[];
    originals: DocPage[];
    files: { attachment: Attachment; bytes: Buffer }[];
    orders: Omit<DocumentSiblingOrder, 'version'>[];
  } {
    if (!this.store.db.isTransaction) throw new Error('Document copy must be prepared inside a transaction.');
    const { options, token } = copyRequest(body, true);
    const { preview, documents: originals, assetPlan, authorizedOrigins, customOrders } = this.plan(sourceId, actorId, options, origins, true);
    if (token !== preview.token) throw stale();
    const ids = new Map(originals.map(original => [original.id, randomUUID()]));
    const documents = originals.map((original): DocPage => {
      const root = original.id === sourceId;
      const copy: DocPage = {
        id: ids.get(original.id)!, projectId: options.projectId, parentId: root ? options.parentId : ids.get(original.parentId!)!,
        title: root ? options.title : original.title, content: structuredClone(original.content), plainText: original.plainText,
        icon: original.icon, status: 'draft', version: 1, authorId: actorId, createdAt: timestamp, updatedAt: timestamp,
        ...(original.labels ? { labels: [...original.labels] } : {}),
      };
      rebindDocumentReferences(copy, ids, authorizedOrigins);
      return copy;
    });
    const files = assetPlan.materialize(documents, ids, actorId, timestamp);
    const orders = [...customOrders].map(([parentId, children]) => ({
      projectId: options.projectId, parentId: ids.get(parentId)!, documentIds: children.map(id => ids.get(id)!),
    }));
    return { documents, originals, files, orders };
  }
}
