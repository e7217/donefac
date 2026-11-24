import { createHash } from 'node:crypto';
import { isConfluencePageId } from '../shared/atlassian-links.js';
import type { ConfluenceMigrationPageAddress, MigratedConfluenceDocumentTarget } from '../shared/confluence-migration-address.js';
import { documentNodes } from '../shared/document-references.js';
import type { DocPage, SourceImport } from '../shared/types.js';
import { record } from './legacy-import-model.js';
import { confluenceSectionAliases } from './migration-confluence-sections.js';
import { convertLegacyContent } from './migration-content.js';
import { parseMigrationOriginBase } from './migration-origin-links.js';
import type { Store } from './store.js';

const MAX_ARCHIVES = 64;
const MAX_SECTION_BYTES = 16 * 1024 * 1024;

type Page = {
  id: string; importId: string; sourceId: string; instanceKey: string; packageSha: string; title: string;
  targetId: string; projectId: string | null; spaceId: string; parentId: string | null; bodyHash: string | null;
  bindingImportId: string; createdAt: string;
};
type VerifiedPage = { original: Page; matching: Page[] };
type SpaceClaim = { sourceId: string; instanceKey: string; packageSha: string; importId: string };
type UnboundPageClaim = SpaceClaim & { restricted: number; excluded: number };

const archiveColumns = `a.id, a.import_id AS importId, a.source_id AS sourceId, a.source_instance AS instanceKey,
  a.target_id AS targetId, json_extract(a.json,'$.targetProjectId') AS projectId,
  json_extract(a.json,'$.packageSha256') AS packageSha, json_extract(a.json,'$.record.title') AS title,
  json_extract(a.json,'$.record.containerId') AS spaceId, json_extract(a.json,'$.record.parentId') AS parentId,
  json_extract(a.json,'$.confluencePageBodySourceHash') AS bodyHash, b.import_id AS bindingImportId, json_extract(r.json,'$.createdAt') AS createdAt`;
const pageArchives = `FROM source_records a
  JOIN source_bindings b ON b.product=a.product AND b.source_instance=a.source_instance AND b.kind=a.kind
    AND b.source_alias=a.source_id AND b.target_type='document' AND b.target_id=a.target_id
  JOIN source_imports r ON r.id=a.import_id
  WHERE a.product='confluence' AND a.kind='page' AND a.target_type='document' AND json_valid(a.json)
    AND a.id=json_extract(a.json,'$.id') AND a.import_id=json_extract(a.json,'$.sourceImportId')
    AND a.source_instance=json_extract(a.json,'$.source.instanceKey') AND json_extract(a.json,'$.source.product')='confluence'
    AND json_extract(a.json,'$.source.format')='confluence-xml' AND a.source_id=json_extract(a.json,'$.record.sourceId')
    AND json_extract(a.json,'$.record.kind')='page' AND a.target_id=json_extract(a.json,'$.targetId')
    AND json_extract(a.json,'$.targetType')='document' AND a.owner_type='document' AND a.owner_id=a.target_id
    AND a.owner_type=json_extract(a.json,'$.ownerType') AND a.owner_id=json_extract(a.json,'$.ownerId')
    AND coalesce(json_extract(a.json,'$.excluded'),0)=0
    AND coalesce(json_extract(a.json,'$.record.metadata.sourceClass'),'Page')='Page'
    AND coalesce(json_extract(a.json,'$.record.metadata.restricted'),0)=0
    AND coalesce(json_extract(a.json,'$.record.metadata.hasRestrictions'),0)=0
    AND coalesce(json_array_length(a.json,'$.record.metadata.permissionSetIds'),0)=0
    AND coalesce(json_array_length(a.json,'$.record.metadata.permissions'),0)=0
    AND coalesce(json_array_length(a.json,'$.record.metadata.restrictions'),0)=0`;

function receiptPackage(receipt: SourceImport | undefined, page: Pick<Page, 'instanceKey' | 'packageSha'>) {
  const packages = receipt?.packages.filter(({ source, sha256 }) => sha256 === page.packageSha &&
    source.product === 'confluence' && source.instanceKey === page.instanceKey && source.format === 'confluence-xml');
  return packages?.length === 1 ? packages[0] : undefined;
}

export class MigratedConfluenceDocuments {
  constructor(private readonly store: Store, private readonly restrictions?: ReadonlyMap<string, ReadonlySet<string>>) {}

  origins(): string[] {
    const rows = this.store.db.prepare(`SELECT DISTINCT base.value FROM source_imports AS receipt
      JOIN json_each(receipt.json,'$.packages') AS source
      JOIN json_each(receipt.json,'$.configuration.sourceBaseUrls') AS base
        ON base.key=json_extract(source.value,'$.stagingId')
      WHERE json_extract(source.value,'$.source.product')='confluence'
        AND json_extract(source.value,'$.source.format')='confluence-xml' AND base.type='text'`).all() as { value: string }[];
    const origins = new Set<string>();
    for (const { value } of rows) {
      const base = parseMigrationOriginBase('confluence', value);
      if (base) origins.add(base.origin + base.contextPath);
    }
    return [...origins].sort();
  }

  resolve(address: ConfluenceMigrationPageAddress): MigratedConfluenceDocumentTarget | null {
    const page = this.page(address);
    if (!page) return null;
    const documentId = page.original.targetId;
    if (!address.fragment) return this.store.db.prepare('SELECT 1 FROM documents WHERE id=?').get(documentId) ? { documentId } : null;
    const document = this.store.get<DocPage>('documents', documentId);
    if (!document || document.id !== documentId) return null;
    const sectionId = this.section(document, page, address);
    return sectionId ? { documentId: document.id, sectionId } : null;
  }

  private origin(address: ConfluenceMigrationPageAddress, page: Page, required: boolean) {
    const receipt = this.store.get<SourceImport>('source_imports', page.importId);
    const pkg = receiptPackage(receipt, page);
    if (!receipt || !pkg || !page.projectId || !receipt.projectIds.includes(page.projectId)) return false;
    const configured = receipt.configuration.sourceBaseUrls?.[pkg.stagingId];
    if (!configured && !required) return true;
    const base = parseMigrationOriginBase('confluence', configured);
    return base?.origin === address.origin && base?.contextPath === address.contextPath;
  }

  private sourceRestricted(page: Page): boolean {
    const restricted = this.restrictions?.get(page.instanceKey);
    if (!restricted?.size) return false;
    const parentOf = this.store.db.prepare(`SELECT json_extract(json,'$.record.parentId') AS parentId FROM source_records
      WHERE import_id=? AND product='confluence' AND kind='page' AND source_instance=? AND source_id=?
        AND json_valid(json) AND json_extract(json,'$.packageSha256')=? LIMIT 2`);
    const visited = new Set<string>();
    let sourceId: string | null = page.sourceId;
    let parentId = page.parentId;
    while (sourceId) {
      if (restricted.has(sourceId) || (parentId && restricted.has(parentId)) || visited.has(sourceId) || visited.size >= MAX_ARCHIVES) return true;
      visited.add(sourceId);
      if (!parentId) return false;
      sourceId = parentId;
      const rows = parentOf.all(page.importId, page.instanceKey, parentId, page.packageSha) as { parentId: string | null }[];
      if (rows.length > 1) return true;
      parentId = rows[0]?.parentId ?? null;
    }
    return false;
  }

  private original(page: Page): Page | undefined {
    const rows = this.store.db.prepare(`SELECT ${archiveColumns} ${pageArchives}
      AND a.import_id=? AND a.source_instance=? AND a.source_id=? LIMIT 2`)
      .all(page.bindingImportId, page.instanceKey, page.sourceId) as Page[];
    if (rows.length === 1 && rows[0].targetId === page.targetId) return rows[0];
  }

  private matchesSpace(page: Page, key: string) {
    const rows = this.store.db.prepare(`SELECT json_extract(json,'$.record.metadata.spaceKey') AS spaceKey,
      json_extract(json,'$.record.metadata.key') AS legacyKey FROM source_records
      WHERE import_id=? AND product='confluence' AND kind='project' AND source_instance=? AND source_id=?
        AND json_valid(json) AND json_extract(json,'$.packageSha256')=? AND coalesce(json_extract(json,'$.excluded'),0)=0
        AND coalesce(json_extract(json,'$.record.metadata.sourceClass'),'Space')='Space' LIMIT 2`)
      .all(page.importId, page.instanceKey, page.spaceId, page.packageSha) as { spaceKey: string | null; legacyKey: string | null }[];
    const [space] = rows;
    return rows.length === 1 && (space.spaceKey || space.legacyKey) === key && (!space.legacyKey || space.legacyKey === key);
  }

  private uniqueSpaceClaim(address: ConfluenceMigrationPageAddress, key: string, match: VerifiedPage) {
    const rows = this.store.db.prepare(`SELECT import_id AS importId, source_id AS sourceId, source_instance AS instanceKey,
      json_extract(json,'$.packageSha256') AS packageSha FROM source_records
      WHERE product='confluence' AND kind='project' AND json_valid(json)
        AND coalesce(json_extract(json,'$.record.metadata.sourceClass'),'Space')='Space'
        AND ? IN (json_extract(json,'$.record.metadata.spaceKey'),json_extract(json,'$.record.metadata.key')) LIMIT ?`)
      .all(key, MAX_ARCHIVES + 1) as SpaceClaim[];
    if (rows.length > MAX_ARCHIVES) return false;
    const actual = match.matching[0];
    if (match.matching.some(row => row.spaceId !== actual.spaceId)) return false;
    for (const claim of rows) {
      if (claim.instanceKey === actual.instanceKey && claim.sourceId === actual.spaceId) continue;
      const receipt = this.store.get<SourceImport>('source_imports', claim.importId);
      const pkg = receiptPackage(receipt, claim);
      const base = pkg && parseMigrationOriginBase('confluence', receipt?.configuration.sourceBaseUrls?.[pkg.stagingId]);
      if (base?.origin === address.origin && base.contextPath === address.contextPath) return false;
    }
    return true;
  }

  private unboundPageContradicts(address: ConfluenceMigrationPageAddress, page: Page): boolean {
    const rows = this.store.db.prepare(`SELECT import_id AS importId, source_id AS sourceId, source_instance AS instanceKey,
      json_extract(json,'$.packageSha256') AS packageSha,
      coalesce(json_extract(json,'$.excluded'),0) AS excluded,
      (coalesce(json_extract(json,'$.record.metadata.restricted'),0)=1
        OR coalesce(json_extract(json,'$.record.metadata.hasRestrictions'),0)=1
        OR coalesce(json_array_length(json,'$.record.metadata.permissionSetIds'),0)>0
        OR coalesce(json_array_length(json,'$.record.metadata.permissions'),0)>0
        OR coalesce(json_array_length(json,'$.record.metadata.restrictions'),0)>0) AS restricted
      FROM source_records WHERE product='confluence' AND kind='page' AND target_type IS NULL AND target_id IS NULL
        AND source_id=? AND json_valid(json) AND import_id=json_extract(json,'$.sourceImportId')
        AND source_instance=json_extract(json,'$.source.instanceKey') AND source_id=json_extract(json,'$.record.sourceId')
        AND json_extract(json,'$.source.product')='confluence' AND json_extract(json,'$.source.format')='confluence-xml'
        AND coalesce(json_extract(json,'$.record.metadata.sourceClass'),'Page')='Page' LIMIT ?`)
      .all(page.sourceId, MAX_ARCHIVES + 1) as UnboundPageClaim[];
    if (rows.length > MAX_ARCHIVES) return true;
    for (const row of rows) {
      const sameInstance = row.instanceKey === page.instanceKey;
      if (sameInstance ? !row.restricted : !address.identity.sourceId || (!row.restricted && !row.excluded)) continue;
      const receipt = this.store.get<SourceImport>('source_imports', row.importId);
      const pkg = receiptPackage(receipt, row);
      if (!receipt || !pkg) continue;
      const configured = receipt.configuration.sourceBaseUrls?.[pkg.stagingId];
      if (!configured && sameInstance) return true;
      const base = parseMigrationOriginBase('confluence', configured);
      if (base?.origin === address.origin && base.contextPath === address.contextPath) return true;
    }
    return false;
  }

  private page(address: ConfluenceMigrationPageAddress): VerifiedPage | undefined {
    const { sourceId, title, spaceKey } = address.identity;
    const locator = sourceId ? 'a.source_id=? AND a.import_id=b.import_id' : `json_extract(a.json,'$.record.title')=?`;
    const rows = this.store.db.prepare(`SELECT ${archiveColumns} ${pageArchives} AND ${locator} LIMIT ?`)
      .all(sourceId ?? title ?? '', MAX_ARCHIVES + 1) as Page[];
    if (rows.length > MAX_ARCHIVES) return;
    const matches = new Map<string, VerifiedPage>();
    for (const candidate of rows) {
      if (!isConfluencePageId(candidate.sourceId)) continue;
      const original = this.original(candidate);
      if (!original || !this.origin(address, original, true) || !this.origin(address, candidate, false)) continue;
      if (spaceKey && (!candidate.spaceId || !this.matchesSpace(candidate, spaceKey))) continue;
      if (this.sourceRestricted(original) || this.sourceRestricted(candidate)) return;
      const key = JSON.stringify([candidate.instanceKey, candidate.sourceId, candidate.targetId]);
      const match = matches.get(key) ?? { original, matching: [] };
      match.matching.push(candidate);
      matches.set(key, match);
    }
    if (matches.size !== 1) return;
    const match = matches.values().next().value!;
    if (this.unboundPageContradicts(address, match.original)) return;
    if (!spaceKey || this.uniqueSpaceClaim(address, spaceKey, match)) return match;
  }

  private section(document: DocPage, { original, matching }: VerifiedPage, address: ConfluenceMigrationPageAddress) {
    const headings = new Set<string>();
    for (const node of documentNodes(document.content)) {
      const sectionId = node.type === 'heading' ? node.attrs?.sectionId : undefined;
      if (typeof sectionId !== 'string') continue;
      if (headings.has(sectionId)) return;
      headings.add(sectionId);
    }
    if (!headings.size) return;
    const rows = this.store.db.prepare(`SELECT ${archiveColumns} ${pageArchives}
      AND a.source_instance=? AND a.source_id=? AND a.target_id=?
      ORDER BY createdAt DESC, a.id LIMIT ?`)
      .all(original.instanceKey, original.sourceId, original.targetId, MAX_ARCHIVES + 1) as Page[];
    if (rows.length > MAX_ARCHIVES) return;
    const eligible = rows.filter(row => this.origin(address, row, false));
    if (eligible.some(row => this.sourceRestricted(row))) return;
    const latest = eligible.find(row => row.bodyHash);
    if (latest && eligible.some(row => row.createdAt === latest.createdAt && row.bodyHash && row.bodyHash !== latest.bodyHash)) return;
    const readBody = this.store.db.prepare(`SELECT json_extract(json,'$.record.textFormat') AS format,
      json_extract(json,'$.record.text') AS text FROM source_records WHERE id=?
      AND length(CAST(json_extract(json,'$.record.text') AS BLOB)) <= ?`);
    let remaining = MAX_SECTION_BYTES;
    for (const row of latest ? eligible.filter(row => row.bodyHash === latest.bodyHash) : [original]) {
      const body = readBody.get(row.id, remaining) as { format: string; text: string } | undefined;
      if (body?.format !== 'confluence-storage' || !body.text) continue;
      remaining -= Buffer.byteLength(body.text);
      if (latest && createHash('sha256').update(JSON.stringify(['confluence-source-body', body.text])).digest('hex') !== latest.bodyHash) continue;
      const source = record('page', row.sourceId, { title: row.title, text: body.text, textFormat: 'confluence-storage' });
      const converted = convertLegacyContent(source, { resolveReference: () => null, sectionLinks: { documentId: document.id } });
      if (converted.diagnostics.some(item => item.severity === 'error' || item.code === 'RAW_CONTENT_FALLBACK')) return;
      const aliases = new Set([original, ...matching, ...eligible].map(candidate => candidate.title)
        .flatMap(title => confluenceSectionAliases(address.fragment!, title)));
      const targetIds = new Set([...aliases].flatMap(alias => {
        const id = converted.sectionTargets?.get(alias);
        return id ? [id] : [];
      }));
      if (targetIds.size !== 1) return;
      const [id] = targetIds;
      return headings.has(id) ? id : undefined;
    }
  }
}
