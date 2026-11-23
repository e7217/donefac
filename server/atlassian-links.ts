import { randomUUID } from 'node:crypto';
import { AtlassianReadError, parseAtlassianLink, type AtlassianLink, type AtlassianLinkTarget, type ParsedAtlassianLink } from '../shared/atlassian-links.js';
import { parseAtlassianSearchInput, sameAtlassianSearchAddress, type AtlassianSearchTarget } from '../shared/atlassian-search.js';
import type { Store } from './store.js';

type LinkTarget = Pick<AtlassianLink, 'targetType' | 'targetId'>;
type LinkReferences = { issueIds: ReadonlySet<string>; documentIds: ReadonlySet<string> };

const inputFields = ['targetType', 'targetId', 'product', 'url'];
const backupFields = ['id', ...inputFields, 'createdAt'];
const targetColumns = 'target_type AS targetType,target_id AS targetId';
const columns = `id,${targetColumns},product,url,created_at AS createdAt`;
const insert = 'INSERT INTO atlassian_links(id,target_type,target_id,product,url,created_at) VALUES(?,?,?,?,?,?)';
const activeTarget = `(
  (target_type='issue' AND EXISTS(SELECT 1 FROM issues WHERE issues.id=atlassian_links.target_id))
  OR (target_type='document' AND EXISTS(SELECT 1 FROM documents WHERE documents.id=atlassian_links.target_id))
)`;

export class AtlassianLinkError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) {
    throw new AtlassianLinkError(400, 'Jira·Confluence 링크 항목을 확인해 주세요.');
  }
  return input as Record<string, unknown>;
}

function linkTarget(targetType: unknown, targetId: unknown): LinkTarget {
  if ((targetType !== 'issue' && targetType !== 'document') || typeof targetId !== 'string' || !targetId.trim()) {
    throw new AtlassianLinkError(400, '링크를 연결할 업무 또는 문서를 확인해 주세요.');
  }
  return { targetType, targetId };
}

function linkAddress(product: unknown, url: unknown): Pick<AtlassianLink, 'product' | 'url'> {
  try {
    const parsed = parseAtlassianLink(product, url);
    return { product: parsed.product, url: parsed.url };
  } catch (error) {
    if (error instanceof AtlassianReadError) throw new AtlassianLinkError(400, error.message);
    throw error;
  }
}

function linkId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim()) throw new AtlassianLinkError(400, '연결된 링크 ID를 확인해 주세요.');
  return id;
}

function linkNotFound(): never {
  throw new AtlassianLinkError(404, '연결된 링크를 찾을 수 없습니다.');
}

export class AtlassianLinksService {
  constructor(private readonly store: Store) {
    // Keep the link when its owner moves to the trash. The purge removes it explicitly.
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS atlassian_links (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK(target_type IN ('issue','document')),
        target_id TEXT NOT NULL,
        product TEXT NOT NULL CHECK(product IN ('jira','confluence')),
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(target_type,target_id,product,url)
      );
      CREATE INDEX IF NOT EXISTS atlassian_links_product_url ON atlassian_links(product,url);
    `);
  }

  private assertActive({ targetType, targetId }: LinkTarget): void {
    const table = targetType === 'issue' ? 'issues' : 'documents';
    if (!this.store.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(targetId)) {
      throw new AtlassianLinkError(404, '링크를 연결할 업무 또는 문서를 찾을 수 없습니다.');
    }
  }

  list(targetType: unknown, targetId: unknown): AtlassianLink[] {
    const target = linkTarget(targetType, targetId);
    this.assertActive(target);
    const rows = this.store.db.prepare(`SELECT ${columns} FROM atlassian_links
      WHERE target_type=? AND target_id=? AND ${activeTarget} ORDER BY created_at,id`)
      .all(target.targetType, target.targetId) as unknown as AtlassianLink[];
    return rows.map(row => ({ ...row }));
  }

  resolve(address: ParsedAtlassianLink): AtlassianSearchTarget[] {
    const order = 'ORDER BY targetType,targetId';
    if (address.product !== 'confluence' || !('pageId' in address)) {
      return this.store.db.prepare(`SELECT ${targetColumns} FROM atlassian_links
        WHERE product=? AND url=? AND ${activeTarget} ${order}`).all(address.product, address.url) as unknown as AtlassianSearchTarget[];
    }

    const base = `${address.origin}${address.contextPath}`;
    const classic = `${base}/pages/viewpage.action?pageId=${address.pageId}`;
    // Numeric page URLs can have different space names and slugs. Narrow the index scan to this installation's /spaces/ paths.
    const candidates = this.store.db.prepare(`SELECT ${targetColumns},url FROM atlassian_links
      WHERE product='confluence' AND url=? AND ${activeTarget}
      UNION ALL
      SELECT ${targetColumns},url FROM atlassian_links
      WHERE product='confluence' AND url>=? AND url<? AND ${activeTarget}
      ${order}`).all(classic, `${base}/spaces/`, `${base}/spaces0`) as unknown as (AtlassianSearchTarget & { url: string })[];
    const targets = new Map<string, AtlassianSearchTarget>();
    for (const { targetType, targetId, url } of candidates) {
      const candidate = parseAtlassianSearchInput(url);
      if (candidate && sameAtlassianSearchAddress(address, candidate)) targets.set(`${targetType}:${targetId}`, { targetType, targetId });
    }
    return [...targets.values()];
  }

  create(input: unknown): AtlassianLink {
    const data = record(input, inputFields);
    const target = linkTarget(data.targetType, data.targetId);
    const { product, url } = linkAddress(data.product, data.url);
    const createLink = () => {
      this.assertActive(target);
      const link = { id: randomUUID(), ...target, product, url, createdAt: new Date().toISOString() };
      const result = this.store.db.prepare(`${insert} ON CONFLICT(target_type,target_id,product,url) DO NOTHING`)
        .run(link.id, link.targetType, link.targetId, product, url, link.createdAt);
      if (result.changes) return link;
      const existing = this.store.db.prepare(`SELECT ${columns} FROM atlassian_links
        WHERE target_type=? AND target_id=? AND product=? AND url=?`)
        .get(link.targetType, link.targetId, product, url) as AtlassianLink | undefined;
      if (!existing) throw new AtlassianLinkError(500, '저장한 Jira·Confluence 링크를 읽지 못했습니다.');
      return { ...existing };
    };
    return this.store.db.isTransaction ? createLink() : this.store.transaction(createLink);
  }

  get(id: unknown): AtlassianLink {
    const row = this.store.db.prepare(`SELECT ${columns} FROM atlassian_links WHERE id=? AND ${activeTarget}`)
      .get(linkId(id)) as AtlassianLink | undefined;
    return row ? { ...row } : linkNotFound();
  }

  remove(id: unknown): void {
    const result = this.store.db.prepare(`DELETE FROM atlassian_links WHERE id=? AND ${activeTarget}`).run(linkId(id));
    if (!result.changes) linkNotFound();
  }

  removeTarget(targetType: AtlassianLinkTarget, targetId: string): void {
    this.store.db.prepare('DELETE FROM atlassian_links WHERE target_type=? AND target_id=?').run(targetType, targetId);
  }

  all(): AtlassianLink[] {
    const rows = this.store.db.prepare(`SELECT ${columns} FROM atlassian_links ORDER BY target_type,target_id,created_at,id`)
      .all() as unknown as AtlassianLink[];
    return rows.map(row => ({ ...row }));
  }

  /** Validate the entire replacement before writing inside the native-backup transaction. */
  restore(raw: unknown, refs: LinkReferences): void {
    if (!this.store.db.isTransaction) throw new AtlassianLinkError(500, '링크 복원에는 트랜잭션이 필요합니다.');
    if (!Array.isArray(raw)) throw new AtlassianLinkError(400, '백업의 Jira·Confluence 링크 목록을 확인해 주세요.');
    const seenIds = new Set<string>();
    const seenLinks = new Set<string>();
    const rows = Array.from(raw, entry => {
      const data = record(entry, backupFields);
      const id = linkId(data.id);
      const target = linkTarget(data.targetType, data.targetId);
      const { product, url } = linkAddress(data.product, data.url);
      const { createdAt } = data;
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
        throw new AtlassianLinkError(400, '백업 링크의 등록 시각을 확인해 주세요.');
      }
      if (!(target.targetType === 'issue' ? refs.issueIds : refs.documentIds).has(target.targetId)) {
        throw new AtlassianLinkError(400, '백업에 링크를 연결할 업무 또는 문서가 없습니다.');
      }
      const key = JSON.stringify([target.targetType, target.targetId, product, url]);
      if (seenIds.has(id) || seenLinks.has(key)) throw new AtlassianLinkError(400, '백업에 중복된 Jira·Confluence 링크가 있습니다.');
      seenIds.add(id);
      seenLinks.add(key);
      return { id, ...target, product, url, createdAt };
    });
    this.store.db.exec('DELETE FROM atlassian_links');
    const persist = this.store.db.prepare(insert);
    for (const row of rows) persist.run(row.id, row.targetType, row.targetId, row.product, row.url, row.createdAt);
  }
}
