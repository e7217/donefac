import { createHash, randomUUID } from 'node:crypto';
import type { DocPage, DocumentSiblingOrder } from '../shared/types.js';
import type { Store, StoreChange } from './store.js';

type Scope = Pick<DocumentSiblingOrder, 'projectId' | 'parentId'>;
type OrderGroup = { scope: Scope; documentIds: string[] };
type StoredOrder = { scope_key: string; document_ids: string | null; revision: string };
type OrderErrorReason = 'document_order_source_missing' | 'document_order_invalid_input' | 'document_order_stale' |
  'document_order_membership_changed' | 'document_order_invalid_backup';

export class DocumentOrderError extends Error {
  readonly details: { reason: OrderErrorReason; currentVersion?: string };

  constructor(readonly status: number, message: string, reason: OrderErrorReason, currentVersion?: string) {
    super(message);
    this.details = currentVersion === undefined ? { reason } : { reason, currentVersion };
  }
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isNullableId = (value: unknown): value is string | null => value === null || isId(value);
const isVersion = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const parentKey = (id: string) => JSON.stringify(['parent', id]);

function scopeKey({ projectId, parentId }: Scope): string {
  return parentId === null ? JSON.stringify(['root', projectId]) : parentKey(parentId);
}

function sameOrder(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((id, index) => second[index] === id);
}

function arranged(documentIds: readonly string[], stored: StoredOrder | undefined): string[] {
  if (!stored?.document_ids) return [...documentIds];
  const remaining = new Set(documentIds);
  const ranked = (JSON.parse(stored.document_ids) as string[]).filter(id => remaining.delete(id));
  return [...ranked, ...remaining];
}

function grouped(documents: readonly DocPage[]): Map<string, OrderGroup> {
  const groups = new Map<string, OrderGroup>();
  for (const { id, projectId, parentId } of documents) {
    const scope = { projectId, parentId };
    const key = scopeKey(scope);
    const group = groups.get(key);
    if (group) group.documentIds.push(id);
    else groups.set(key, { scope, documentIds: [id] });
  }
  return groups;
}

function invalidBackup(): never {
  throw new DocumentOrderError(400, '백업의 형제 문서 순서와 현재 문서의 위치를 확인해 주세요.', 'document_order_invalid_backup');
}

export class DocumentOrderService {
  private readonly findOrder;
  private readonly findSiblings;
  private readonly saveOrder;

  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_sibling_orders (
      scope_key TEXT PRIMARY KEY,
      document_ids TEXT,
      revision TEXT NOT NULL
    )`);
    this.findOrder = store.db.prepare('SELECT scope_key, document_ids, revision FROM document_sibling_orders WHERE scope_key=?');
    this.findSiblings = store.db.prepare('SELECT id FROM documents WHERE parent_id IS ? AND project_id IS ? ORDER BY rowid');
    this.saveOrder = store.db.prepare(`INSERT INTO document_sibling_orders(scope_key, document_ids, revision) VALUES(?,?,?)
      ON CONFLICT(scope_key) DO UPDATE SET document_ids=excluded.document_ids,revision=excluded.revision`);
    store.onChange(change => this.track(change), ['documents']);
  }

  private stored(key: string): StoredOrder | undefined {
    return this.findOrder.get(key) as StoredOrder | undefined;
  }

  private members({ parentId, projectId }: Scope): string[] {
    return (this.findSiblings.all(parentId, projectId) as { id: string }[]).map(({ id }) => id);
  }

  private put(key: string, baseline: string[], documentIds: string[]): void {
    this.saveOrder.run(key, sameOrder(baseline, documentIds) ? null : JSON.stringify(documentIds), randomUUID());
  }

  private track({ before, after, context }: StoreChange): void {
    if (context.origin === 'import') return;
    const old = before as DocPage | undefined;
    const next = after as DocPage | undefined;
    const oldKey = old && scopeKey(old), nextKey = next && scopeKey(next);
    // The parent's own ID identifies its children before and after moving a subtree to another space.
    if (oldKey === nextKey) return;
    if (old && oldKey) {
      const stored = this.stored(oldKey);
      if (stored?.document_ids) {
        const baseline = this.members(old);
        this.put(oldKey, baseline, arranged(baseline, stored));
      } else this.saveOrder.run(oldKey, null, randomUUID());
    }
    if (next && nextKey) {
      const stored = this.stored(nextKey);
      // New rows already enter the default order at the end of their group.
      if (!old && !stored?.document_ids) this.saveOrder.run(nextKey, null, randomUUID());
      else {
        const baseline = this.members(next);
        const rest = baseline.filter(id => id !== next.id);
        this.put(nextKey, baseline, [...arranged(rest, stored), next.id]);
      }
    }
    if (old && !next) this.store.db.prepare('DELETE FROM document_sibling_orders WHERE scope_key=?').run(parentKey(old.id));
  }

  private resolve({ scope, documentIds }: OrderGroup, stored: StoredOrder | undefined, generation: unknown): DocumentSiblingOrder {
    const ids = arranged(documentIds, stored);
    const version = createHash('sha256').update(JSON.stringify([scope.projectId, scope.parentId, generation, stored?.revision ?? null, ids])).digest('hex');
    return { ...scope, documentIds: ids, version };
  }

  private requireDocument(documentId: string): DocPage {
    const document = this.store.get<DocPage>('documents', documentId);
    if (!document) throw new DocumentOrderError(404, '순서를 변경할 문서를 찾을 수 없습니다.', 'document_order_source_missing');
    return document;
  }

  get(documentId: string): DocumentSiblingOrder {
    const { projectId, parentId } = this.requireDocument(documentId);
    const scope = { projectId, parentId };
    return this.resolve({ scope, documentIds: this.members(scope) }, this.stored(scopeKey(scope)), this.store.setting('attachmentImportGeneration'));
  }

  save(documentId: string, body: unknown, record: (document: DocPage) => void): DocumentSiblingOrder {
    if (!isRecord(body) || Object.keys(body).some(key => !['expectedVersion', 'documentIds', 'actorId'].includes(key)) ||
      !isVersion(body.expectedVersion) || !Array.isArray(body.documentIds) || ![...body.documentIds].every(isId) ||
      new Set(body.documentIds).size !== body.documentIds.length) {
      throw new DocumentOrderError(400, '확인한 순서 버전과 중복 없는 형제 문서 목록을 보내 주세요.', 'document_order_invalid_input');
    }
    const { expectedVersion, documentIds } = body;
    return this.store.transaction(() => {
      const document = this.requireDocument(documentId);
      const scope = { projectId: document.projectId, parentId: document.parentId };
      const key = scopeKey(scope), baseline = this.members(scope), generation = this.store.setting('attachmentImportGeneration');
      const group = { scope, documentIds: baseline };
      const current = this.resolve(group, this.stored(key), generation);
      if (current.version !== expectedVersion) {
        throw new DocumentOrderError(409, '문서의 위치나 순서가 변경되었습니다. 다시 확인해 주세요.', 'document_order_stale', current.version);
      }
      const members = new Set(baseline);
      if (documentIds.length !== baseline.length || documentIds.some(id => !members.has(id))) {
        throw new DocumentOrderError(409, '같은 공간과 상위 문서에 있는 모든 형제 문서의 순서를 확인해 주세요.',
          'document_order_membership_changed', current.version);
      }
      if (sameOrder(documentIds, current.documentIds)) return current;
      this.put(key, baseline, documentIds);
      record(document);
      return this.resolve(group, this.stored(key), generation);
    });
  }

  /** The caller supplies all live children in insertion order. */
  orderChildren(parentId: string, childIds: readonly string[]): string[] {
    if (childIds.length < 2) return [...childIds];
    return arranged(childIds, this.stored(parentKey(parentId)));
  }

  private orders(documents: DocPage[], customOnly: boolean): DocumentSiblingOrder[] {
    const rows = this.store.db.prepare('SELECT scope_key, document_ids, revision FROM document_sibling_orders').all() as StoredOrder[];
    const byKey = new Map(rows.map(row => [row.scope_key, row]));
    const generation = this.store.setting('attachmentImportGeneration');
    const result: DocumentSiblingOrder[] = [];
    for (const [key, group] of grouped(documents)) {
      const stored = byKey.get(key);
      if (customOnly && !stored?.document_ids) continue;
      const order = this.resolve(group, stored, generation);
      if (!customOnly || !sameOrder(order.documentIds, group.documentIds)) result.push(order);
    }
    return result;
  }

  snapshot(documents: DocPage[]): DocumentSiblingOrder[] { return this.orders(documents, false); }

  forBackup(documents: DocPage[]): DocumentSiblingOrder[] { return this.orders(documents, true); }

  validateImport(value: unknown, documents: DocPage[]): DocumentSiblingOrder[] {
    if (!Array.isArray(value)) return invalidBackup();
    const groups = grouped(documents);
    if (value.length > groups.size) return invalidBackup();
    const byId = new Map(documents.map(document => [document.id, document]));
    const seen = new Set<string>();
    return value.map((item: unknown) => {
      if (!isRecord(item) || Object.keys(item).length !== 4) return invalidBackup();
      const { projectId, parentId, documentIds, version } = item;
      if (!isNullableId(projectId) || !isNullableId(parentId) || !Array.isArray(documentIds) || !isVersion(version)) return invalidBackup();
      const key = scopeKey({ projectId, parentId });
      const group = groups.get(key);
      if (!group || group.scope.projectId !== projectId || seen.has(key) || documentIds.length !== group.documentIds.length) return invalidBackup();
      if (parentId !== null && byId.get(parentId)?.projectId !== projectId) return invalidBackup();
      seen.add(key);
      const remaining = new Set(group.documentIds);
      if (documentIds.some(id => !isId(id) || !remaining.delete(id) || byId.get(id)?.projectId !== projectId) || remaining.size) return invalidBackup();
      return { projectId, parentId, documentIds, version };
    });
  }

  replaceImported(orders: DocumentSiblingOrder[]): void {
    if (!this.store.db.isTransaction) throw new Error('Document order restore requires a transaction.');
    this.store.db.exec('DELETE FROM document_sibling_orders');
    for (const order of orders) this.put(scopeKey(order), this.members(order), order.documentIds);
  }
}
