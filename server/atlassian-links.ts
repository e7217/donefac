import { randomUUID } from 'node:crypto';
import { AtlassianReadError, isConfluencePageId, parseAtlassianLink, type AtlassianLink, type AtlassianLinkTarget, type ParsedAtlassianLink } from '../shared/atlassian-links.js';
import { parseAtlassianSearchInput, sameAtlassianSearchAddress, type AtlassianSearchAddress, type AtlassianSearchTarget } from '../shared/atlassian-search.js';
import type { Comment, SourceImport, SourceRecordArchive } from '../shared/types.js';
import { isRestrictedJiraHistory, isRestrictedJiraHistoryOwner, jiraHistoryOwnerAliases, jiraHistorySourceKey } from './migration-jira-history.js';
import { migrationOriginLink, parseMigrationOriginBase } from './migration-origin-links.js';
import { confluenceHistoryPage, type SourcePreservationService } from './source-preservation.js';
import type { Store } from './store.js';

type LinkTarget = Pick<AtlassianLink, 'targetType' | 'targetId'>;
type LinkReferences = { issueIds: ReadonlySet<string>; documentIds: ReadonlySet<string> };
type JiraAddress = Extract<ParsedAtlassianLink, { product: 'jira' }>;
type ConfluenceAddress = Extract<ParsedAtlassianLink, { product: 'confluence' }>;
type ArchivedPage = { targetId: string; importId: string; instanceKey: string; packageSha: string; spaceId: string; sourceId: string; projectId: string | null };
type ArchivedSpace = { spaceKey: string | null; key: string | null; sourceClass: string | null };
type ArchiveRow = { json: string | null };
type JiraCommentArchiveRow = ArchiveRow & { archiveId: string; importId: string; instanceKey: string; issueId: string; commentId: string };

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
  constructor(private readonly store: Store, private readonly sources?: Pick<SourcePreservationService, 'jiraIssueOrigins'>) {
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

  resolve(address: AtlassianSearchAddress): AtlassianSearchTarget[] {
    if (address.commentId) return address.product === 'jira'
      ? this.resolveJiraComment(address, address.commentId) : this.resolveConfluenceComment(address, address.commentId);
    const order = 'ORDER BY targetType,targetId';
    if (address.product !== 'confluence' || !('pageId' in address)) {
      const exact = this.store.db.prepare(`SELECT ${targetColumns} FROM atlassian_links
        WHERE product=? AND url=? AND ${activeTarget} ${order}`).all(address.product, address.url) as unknown as AtlassianSearchTarget[];
      if (address.product === 'jira') return exact;
      const targets = new Map(exact.map(target => [`${target.targetType}:${target.targetId}`, target]));
      for (const { targetId } of this.archivedConfluencePages(address)) targets.set(`document:${targetId}`, { targetType: 'document', targetId });
      return [...targets.values()].sort((left, right) => left.targetType.localeCompare(right.targetType) || left.targetId.localeCompare(right.targetId));
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

  private jiraArchivePackage(archive: SourceRecordArchive) {
    if (archive.source?.product !== 'jira' || archive.excluded || !archive.targetProjectId) return;
    const receipt = this.store.get<SourceImport>('source_imports', archive.sourceImportId);
    if (!receipt?.projectIds.includes(archive.targetProjectId)) return;
    const packages = receipt.packages.filter(pkg => pkg.sha256 === archive.packageSha256 && pkg.source.product === 'jira' &&
      pkg.source.instanceKey === archive.source.instanceKey && pkg.source.format === archive.source.format);
    if (packages.length === 1) return { configuredBase: receipt.configuration.sourceBaseUrls?.[packages[0].stagingId] };
  }

  private resolveJiraComment(address: JiraAddress, sourceCommentId: string): AtlassianSearchTarget[] {
    const { sources } = this;
    if (!sources) return [];
    const issueUrl = `${address.origin}${address.contextPath}/browse/${address.issueKey}`;
    const db = this.store.db;
    const rows = db.prepare(`SELECT archive.id AS archiveId, archive.import_id AS importId, archive.source_instance AS instanceKey,
        live.resource_id AS issueId, live.id AS commentId,
        CASE WHEN json_valid(archive.json) THEN json_set(archive.json,'$.record.text','') END AS json
      FROM source_records AS archive
      JOIN comments AS live ON live.id=archive.target_id AND live.resource_type='issue' AND live.resource_id=archive.owner_id
      JOIN issues AS issue ON issue.id=live.resource_id
      JOIN atlassian_links AS link ON link.product='jira' AND link.target_type='issue' AND link.target_id=issue.id AND link.url=?
      WHERE archive.product='jira' AND archive.kind='comment' AND archive.source_id=? AND archive.target_type='comment'
        AND archive.owner_type='issue' AND NOT EXISTS (SELECT 1 FROM source_records AS duplicate
          WHERE duplicate.product='jira' AND duplicate.source_instance=archive.source_instance AND duplicate.kind='comment'
            AND duplicate.source_id=archive.source_id AND duplicate.target_type='comment' AND duplicate.id<>archive.id)
      `).iterate(issueUrl, sourceCommentId) as Iterable<JiraCommentArchiveRow>;
    const ownerById = db.prepare(`SELECT CASE WHEN json_valid(json) THEN json_set(json,'$.record.text','') END AS json FROM source_records WHERE id=?`);
    let found: AtlassianSearchTarget | undefined;
    for (const { json, archiveId, importId, instanceKey, issueId, commentId } of rows) {
      const archive = json ? JSON.parse(json) as SourceRecordArchive | null : null;
      if (!archive?.record || archive.id !== archiveId || archive.sourceImportId !== importId || archive.source?.instanceKey !== instanceKey ||
          archive.targetType !== 'comment' || archive.targetId !== commentId ||
          archive.ownerType !== 'issue' || archive.ownerId !== issueId || isRestrictedJiraHistory(archive.record)) continue;
      const recordKey = jiraHistorySourceKey(archive.record);
      if (recordKey?.kind !== 'comment' || recordKey.sourceId !== sourceCommentId) continue;
      const pkg = this.jiraArchivePackage(archive);
      if (!pkg) continue;
      if (pkg.configuredBase != null) {
        const origin = parseMigrationOriginBase('jira', pkg.configuredBase);
        if (origin?.origin !== address.origin || origin.contextPath !== address.contextPath) continue;
      }
      const ownerAliases = jiraHistoryOwnerAliases(archive.record);
      if (!ownerAliases) continue;
      const bindings = sources.jiraIssueOrigins(instanceKey, [issueId], 'issue');
      const aliases = new Set(bindings.map(binding => binding.alias));
      if (bindings.some(binding => binding.projectId !== archive.targetProjectId) || ownerAliases.some(alias => !aliases.has(alias))) continue;
      const ownerIds = new Set(bindings.map(binding => binding.archiveId));
      if (ownerIds.size !== 1) continue;
      const [ownerId] = ownerIds;
      const ownerRow = ownerById.get(ownerId) as ArchiveRow | undefined;
      const owner = ownerRow?.json ? JSON.parse(ownerRow.json) as SourceRecordArchive | null : null;
      if (owner?.record?.kind !== 'issue' || owner.id !== ownerId || owner.source?.instanceKey !== instanceKey ||
          owner.targetType !== 'issue' || owner.targetId !== issueId || owner.ownerType !== 'issue' || owner.ownerId !== issueId ||
          owner.targetProjectId !== archive.targetProjectId || owner.record.metadata.restricted === true || isRestrictedJiraHistoryOwner(owner.record)) continue;
      const originalKey = owner.record.metadata.key;
      if (typeof originalKey !== 'string' || !aliases.has(originalKey)) continue;
      const issueOrigin = parseMigrationOriginBase('jira', this.jiraArchivePackage(owner)?.configuredBase);
      if (!issueOrigin || migrationOriginLink(issueOrigin, 'jira', owner.record) !== issueUrl) continue;
      if (found) return [];
      found = { targetType: 'issue', targetId: issueId, commentId };
    }
    return found ? [found] : [];
  }

  private archivedConfluencePages(address: ConfluenceAddress): ArchivedPage[] {
    const db = this.store.db;
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_records'`).get()) return [];
    const base = `${address.origin}${address.contextPath}`;
    const numeric = 'pageId' in address;
    const locator = numeric ? `page.source_id=? AND page.import_id=binding.import_id` : `json_extract(page.json,'$.record.title')=?`;
    // Title aliases can come from later refresh receipts for the original bound page.
    const candidates = db.prepare(`SELECT DISTINCT page.target_id AS targetId, page.import_id AS importId,
      page.source_instance AS instanceKey, json_extract(page.json,'$.packageSha256') AS packageSha,
      json_extract(page.json,'$.record.containerId') AS spaceId, page.source_id AS sourceId,
      json_extract(page.json,'$.targetProjectId') AS projectId
      FROM source_records AS page
      JOIN source_bindings AS binding ON binding.product=page.product AND binding.source_instance=page.source_instance
        AND binding.kind=page.kind AND binding.source_alias=page.source_id AND binding.target_type=page.target_type
        AND binding.target_id=page.target_id
      JOIN documents AS document ON document.id=page.target_id
      JOIN atlassian_links AS link ON link.product='confluence' AND link.target_type='document'
        AND link.target_id=page.target_id AND link.url=? || page.source_id
      WHERE page.product='confluence' AND page.kind='page' AND page.target_type='document' AND json_valid(page.json)
        AND ${locator} AND json_type(page.json,'$.record.containerId')='text'
        AND coalesce(json_extract(page.json,'$.excluded'),0)=0
        AND coalesce(json_extract(page.json,'$.record.metadata.restricted'),0)=0
        AND coalesce(json_extract(page.json,'$.record.metadata.sourceClass'),'Page')='Page'`)
      .all(`${base}/pages/viewpage.action?pageId=`, numeric ? address.pageId : address.title) as unknown as ArchivedPage[];
    const spaceQuery = db.prepare(`SELECT json_extract(json,'$.record.metadata.spaceKey') AS spaceKey,
      json_extract(json,'$.record.metadata.key') AS key, json_extract(json,'$.record.metadata.sourceClass') AS sourceClass
      FROM source_records WHERE import_id=? AND product='confluence' AND source_instance=? AND kind='project' AND source_id=?
        AND json_valid(json) AND json_extract(json,'$.packageSha256')=? AND coalesce(json_extract(json,'$.excluded'),0)=0 LIMIT 2`);
    const receipts = new Map<string, SourceImport | undefined>();
    const pages: ArchivedPage[] = [];
    for (const candidate of candidates) {
      const { importId, instanceKey, packageSha, spaceId, sourceId } = candidate;
      if (!isConfluencePageId(sourceId)) continue;
      if (!receipts.has(importId)) receipts.set(importId, this.store.get<SourceImport>('source_imports', importId));
      const receipt = receipts.get(importId);
      const sourcePackage = this.confluenceSourcePackage(receipt, instanceKey, packageSha);
      if (!receipt || !sourcePackage) continue;
      const origin = parseMigrationOriginBase('confluence', receipt.configuration.sourceBaseUrls?.[sourcePackage.stagingId]);
      if (origin?.origin !== address.origin || origin.contextPath !== address.contextPath) continue;
      if (!numeric) {
        const [space, duplicate] = spaceQuery.all(importId, instanceKey, spaceId, packageSha) as unknown as ArchivedSpace[];
        if (!space || duplicate || (space.sourceClass !== null && space.sourceClass !== 'Space') ||
            (space.spaceKey || space.key) !== address.spaceKey || (space.key && space.key !== address.spaceKey)) continue;
      }
      pages.push(candidate);
    }
    return pages;
  }

  private confluenceSourcePackage(receipt: SourceImport | undefined, instanceKey: string, packageSha: string) {
    const packages = receipt?.packages.filter(pkg => pkg.sha256 === packageSha && pkg.source.product === 'confluence' &&
      pkg.source.instanceKey === instanceKey && pkg.source.format === 'confluence-xml');
    return packages?.length === 1 ? packages[0] : undefined;
  }

  private resolveConfluenceComment(address: ConfluenceAddress, sourceCommentId: string): AtlassianSearchTarget[] {
    const pages = this.archivedConfluencePages(address);
    if (!pages.length) return [];
    const db = this.store.db;
    // The original comment body is unnecessary for comparing page ownership.
    const withoutBody = `CASE WHEN json_valid(json) THEN json_set(json,'$.record.text','') END`;
    const comments = db.prepare(`SELECT ${withoutBody} AS json FROM source_records
      WHERE product='confluence' AND source_instance=? AND kind='comment' AND source_id=?
        AND target_type='comment' LIMIT 2`);
    const related = db.prepare(`SELECT ${withoutBody} AS json FROM source_records
      WHERE import_id=? AND product='confluence' AND source_instance=? AND kind=? AND source_id=?
        AND CASE WHEN json_valid(json) THEN json_extract(json,'$.packageSha256') END=? LIMIT 2`);
    const found = new Map<string, AtlassianSearchTarget>();
    for (const page of pages) {
      const [row, duplicate] = comments.all(page.instanceKey, sourceCommentId) as ArchiveRow[];
      if (!row?.json || duplicate) continue;
      const archive = JSON.parse(row.json) as SourceRecordArchive | null;
      if (!archive?.source || !archive.record || archive.excluded || archive.source.product !== 'confluence' || archive.source.format !== 'confluence-xml' ||
          archive.source.instanceKey !== page.instanceKey || archive.record.sourceId !== sourceCommentId ||
          archive.targetType !== 'comment' || typeof archive.targetId !== 'string' ||
          archive.ownerType !== 'document' || archive.ownerId !== page.targetId || archive.targetProjectId !== page.projectId) continue;
      const receipt = this.store.get<SourceImport>('source_imports', archive.sourceImportId);
      const sourcePackage = this.confluenceSourcePackage(receipt, page.instanceKey, archive.packageSha256);
      if (!receipt || !sourcePackage || !page.projectId || !receipt.projectIds.includes(page.projectId)) continue;
      const configuredBase = receipt.configuration.sourceBaseUrls?.[sourcePackage.stagingId];
      const origin = parseMigrationOriginBase('confluence', configuredBase);
      if (configuredBase && (origin?.origin !== address.origin || origin.contextPath !== address.contextPath)) continue;
      const owner = confluenceHistoryPage(archive.record, (kind, sourceId) => {
        const [value, extra] = related.all(archive.sourceImportId, page.instanceKey, kind, sourceId, archive.packageSha256) as ArchiveRow[];
        if (!value?.json || extra) return;
        const record = JSON.parse(value.json) as SourceRecordArchive | null;
        return record?.excluded ? undefined : record?.record;
      });
      if (owner !== page.sourceId || !this.activeDocumentComment(page.targetId, archive.targetId)) continue;
      const target = { targetType: 'document', targetId: page.targetId, commentId: archive.targetId } as const;
      found.set(JSON.stringify([page.instanceKey, page.sourceId, target.targetId, target.commentId]), target);
    }
    return found.size === 1 ? [...found.values()] : [];
  }

  private activeDocumentComment(documentId: string, commentId: string): boolean {
    const comment = this.store.get<Comment>('comments', commentId);
    if (!comment || comment.id !== commentId || comment.resourceType !== 'document' || comment.resourceId !== documentId) return false;
    if (comment.parentCommentId === undefined) return true;
    const root = this.store.get<Comment>('comments', comment.parentCommentId);
    return Boolean(root?.id === comment.parentCommentId && root.resourceType === 'document' && root.resourceId === documentId &&
      root.parentCommentId === undefined && root.documentSource && !comment.documentSource && !comment.resolution);
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
