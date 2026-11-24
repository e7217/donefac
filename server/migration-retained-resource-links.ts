import { createHash } from 'node:crypto';
import { isConfluencePageId } from '../shared/atlassian-links.js';
import type { DocPage, Issue, LegacyRecord, MigrationConfiguration, Project, SourceImport, SourceRecordArchive } from '../shared/types.js';
import type { MigrationPackage } from './migration-contracts.js';
import { isJiraHierarchyIssueId } from './migration-jira-hierarchy.js';
import { isRestrictedJiraHistoryOwner } from './migration-jira-history.js';
import { confluenceMigrationPageAddress, confluenceMigrationPageKey, parseMigrationOriginBase, type ConfluenceMigrationPageAddress, type MigrationOriginBase } from './migration-origin-links.js';
import type { Store } from './store.js';

export interface RetainedResourcePage {
  origin: string;
  instanceKey: string;
  sourceId: string;
  sourceTitle: string;
  sourceSpaceId: string;
  sourceSpaceKey?: string;
  document: (Pick<DocPage, 'id' | 'projectId' | 'title' | 'version'> & { projectName: string }) | null;
}

export interface RetainedJiraResourceLink {
  instanceKey: string;
  sourceId: string;
  ownerSourceId: string;
  url: string;
  pageId?: string;
  applicationType?: string;
  conflict?: true;
  issue: (Pick<Issue, 'id' | 'projectId' | 'key' | 'title' | 'version'> & { projectName: string }) | null;
}

export interface MigrationRetainedResourceLinks {
  token: string;
  pages: RetainedResourcePage[];
  links: RetainedJiraResourceLink[];
  existingPairs: [string, string][];
  blockedPageKeys: string[];
}

type Binding = { id: string; importId: string };
type Scope = {
  requested: Map<string, ConfluenceMigrationPageAddress>;
  incomingPageKeys: Set<string>;
  incomingOrigins: Set<string>;
  incomingSpaces: Map<string, Set<string>>;
  incomingRemoteKeys: Set<string>;
  incomingRemoteIds: Set<string>;
};

const key = (...parts: string[]) => JSON.stringify(parts);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const originKey = ({ origin, contextPath }: MigrationOriginBase) => origin + contextPath;
const pageSpaceId = (record: LegacyRecord) => record.references.find(ref => ref.kind === 'project')?.sourceId ?? record.containerId ?? '';
const restrictedPage = ({ metadata }: LegacyRecord) => metadata.restricted === true || metadata.hasRestrictions === true ||
  ['restrictions', 'permissions', 'permissionSetIds'].some(field => Array.isArray(metadata[field]) && metadata[field].length > 0);
const spaceKeys = ({ metadata }: LegacyRecord) => [...new Set([metadata.spaceKey, metadata.key, metadata.pkey].map(text).filter(Boolean))];

const pageKey = (address: ConfluenceMigrationPageAddress) => confluenceMigrationPageKey(originKey(address), address.identity);

function addSpaceClaim(claims: Map<string, Set<string>>, locator: string, identity: string) {
  const values = claims.get(locator) ?? new Set<string>();
  values.add(identity);
  claims.set(locator, values);
}

function validRemoteAddress(record: LegacyRecord) {
  const { metadata, references, sourceId, containerId } = record;
  const owner = references[0];
  if (!sourceId.startsWith('remote:') || !isJiraHierarchyIssueId(sourceId.slice(7)) || !containerId ||
      !isJiraHierarchyIssueId(containerId) || metadata.jiraRemoteLinkConflict === true || references.length !== 1 ||
      owner?.kind !== 'issue' || owner.relation !== 'source' || owner.sourceId !== containerId) return null;
  const address = confluenceMigrationPageAddress(text(metadata.url));
  const pageId = metadata.remotePageId;
  return address && !address.hasExtraQuery && (pageId === undefined || isConfluencePageId(pageId) &&
    (!address.identity.sourceId || address.identity.sourceId === pageId)) ? address : null;
}

function scopeFor(packages: MigrationPackage[], configuration: MigrationConfiguration): Scope {
  const requested = new Map<string, ConfluenceMigrationPageAddress>(), incomingPageKeys = new Set<string>(), incomingOrigins = new Set<string>();
  const incomingRemoteKeys = new Set<string>(), incomingRemoteIds = new Set<string>();
  const incomingSpaces = new Map<string, Set<string>>();
  const excluded = new Set(configuration.excludedRecords);
  for (const { summary, dataset } of packages) {
    if (dataset.source.product === 'jira') {
      for (const row of dataset.records) {
        if (row.kind !== 'relation' || row.metadata.jiraRestRemoteLink !== true || excluded.has(`${summary.id}/${row.id}`)) continue;
        incomingRemoteKeys.add(key(dataset.source.instanceKey, row.sourceId));
        incomingRemoteIds.add(row.sourceId);
        const address = validRemoteAddress(row);
        if (address) requested.set(pageKey(address), address);
      }
      continue;
    }
    const base = parseMigrationOriginBase('confluence', configuration.sourceBaseUrls[summary.id]);
    if (!base) continue;
    const origin = base.origin + base.contextPath;
    const spaces = new Map<string, string[]>();
    for (const row of dataset.records) {
      if (row.kind !== 'project') continue;
      const keys = spaceKeys(row);
      spaces.set(row.sourceId, keys);
      for (const spaceKey of keys) addSpaceClaim(incomingSpaces, key(origin, spaceKey), key(dataset.source.instanceKey, row.sourceId));
    }
    for (const row of dataset.records) {
      if (row.kind !== 'page' || restrictedPage(row) || excluded.has(`${summary.id}/${row.id}`)) continue;
      incomingOrigins.add(origin);
      if (isConfluencePageId(row.sourceId)) incomingPageKeys.add(confluenceMigrationPageKey(origin, { sourceId: row.sourceId }));
      for (const spaceKey of spaces.get(pageSpaceId(row)) ?? []) incomingPageKeys.add(confluenceMigrationPageKey(origin, { spaceKey, title: row.title }));
    }
  }
  return { requested, incomingPageKeys, incomingOrigins, incomingSpaces, incomingRemoteKeys, incomingRemoteIds };
}

export function readMigrationRetainedResourceLinks(store: Store, packages: MigrationPackage[], configuration: MigrationConfiguration,
  restrictedConfluencePages?: ReadonlyMap<string, ReadonlySet<string>>): MigrationRetainedResourceLinks | undefined {
  const scope = scopeFor(packages, configuration);
  if (!scope.requested.size && !scope.incomingPageKeys.size && !scope.incomingRemoteKeys.size) return;
  const db = store.db, receipts = new Map<string, SourceImport | undefined>(), projectNames = new Map<string, string>();
  const receiptFor = (id: string) => {
    if (!receipts.has(id)) receipts.set(id, store.get<SourceImport>('source_imports', id));
    return receipts.get(id);
  };
  const projectName = (id: string | null) => {
    if (id === null) return '팀 공통';
    if (!projectNames.has(id)) projectNames.set(id, store.get<Project>('projects', id)?.name ?? '');
    return projectNames.get(id)!;
  };
  const packageFor = (archive: SourceRecordArchive) => {
    const source = archive.source;
    const receipt = receiptFor(archive.sourceImportId);
    const candidates = receipt?.packages.filter(pkg => pkg.sha256 === archive.packageSha256 && pkg.source.product === source.product &&
      pkg.source.instanceKey === source.instanceKey && pkg.source.format === source.format && pkg.source.declaredVersion === source.declaredVersion &&
      pkg.source.timezone === source.timezone);
    return candidates?.length === 1 ? { receipt: receipt!, package: candidates[0] } : undefined;
  };
  const pageOrigin = (archive: SourceRecordArchive) => {
    const proof = packageFor(archive);
    const base = proof && parseMigrationOriginBase('confluence', proof.receipt.configuration.sourceBaseUrls[proof.package.stagingId]);
    return base ? originKey(base) : '';
  };

  const findArchives = db.prepare(`SELECT json_remove(json,'$.record.text') AS json FROM source_records
    WHERE import_id=? AND product=? AND source_instance=? AND kind=? AND source_id=?
      AND json_extract(json,'$.packageSha256')=? ORDER BY id LIMIT 2`);
  const archiveFor = (record: SourceRecordArchive, kind: string, id: string) => {
    const rows = findArchives.all(record.sourceImportId, record.source.product, record.source.instanceKey, kind, id, record.packageSha256) as { json: string }[];
    return rows.length === 1 ? JSON.parse(rows[0].json) as SourceRecordArchive : undefined;
  };
  const findBinding = db.prepare(`SELECT target_id AS id,import_id AS importId FROM source_bindings
    WHERE product=? AND source_instance=? AND kind=? AND source_alias=? AND target_type=?`);
  const bindingFor = (archive: SourceRecordArchive, kind: string, id: string, type: string) =>
    findBinding.get(archive.source.product, archive.source.instanceKey, kind, id, type) as Binding | undefined;

  const restrictionCache = new Map<string, boolean>();
  const knownRestricted = (archive: SourceRecordArchive): boolean => {
    const restrictions = restrictedConfluencePages?.get(archive.source.instanceKey);
    if (!restrictions?.size) return false;
    const visited = new Set<string>();
    let candidate: SourceRecordArchive | undefined = archive;
    let restricted = false;
    while (candidate) {
      const record: LegacyRecord = candidate.record;
      const identity = key(candidate.sourceImportId, candidate.packageSha256, record.sourceId);
      if (restrictionCache.has(identity)) { restricted = restrictionCache.get(identity)!; break; }
      if (visited.has(identity)) { restricted = true; break; }
      visited.add(identity);
      if (restrictions.has(record.sourceId) || record.parentId && restrictions.has(record.parentId)) { restricted = true; break; }
      candidate = record.parentId ? archiveFor(candidate, 'page', record.parentId) : undefined;
    }
    for (const identity of visited) restrictionCache.set(identity, restricted);
    return restricted;
  };

  const pages: RetainedResourcePage[] = [];
  const pageEvidence: unknown[] = [];
  const blockedPageKeys: string[] = [];
  const readPages = () => {
    if (!scope.requested.size) return;
    const pageOrigins = db.prepare(`SELECT json_remove(json,'$.record.text') AS json FROM source_records
      WHERE import_id=? AND product='confluence' AND source_instance=? AND kind='page' AND source_id=?
        AND target_type='document' AND target_id=? ORDER BY id LIMIT 2`);
    const ids = new Set<string>(), titles = new Set<string>(), requestedSpaces = new Set<string>(), requestedSpaceKeys = new Set<string>();
    for (const address of scope.requested.values()) {
      const { identity } = address;
      if (identity.sourceId) ids.add(identity.sourceId);
      if (identity.title) titles.add(identity.title);
      if (identity.spaceKey) {
        requestedSpaces.add(key(originKey(address), identity.spaceKey));
        requestedSpaceKeys.add(identity.spaceKey);
      }
    }
    const spaceClaims = new Map<string, Set<string>>();
    if (requestedSpaceKeys.size) {
      for (const locator of requestedSpaces) {
        for (const identity of scope.incomingSpaces.get(locator) ?? []) addSpaceClaim(spaceClaims, locator, identity);
      }
      const spaces = db.prepare(`SELECT json_remove(space.json,'$.record.text') AS json FROM source_records AS space
        WHERE space.product='confluence' AND space.kind='project' AND EXISTS (SELECT 1 FROM json_each(?) AS requested
          WHERE requested.value IN (json_extract(space.json,'$.record.metadata.spaceKey'),
            json_extract(space.json,'$.record.metadata.key'),json_extract(space.json,'$.record.metadata.pkey'))) ORDER BY space.id`)
        .iterate(JSON.stringify([...requestedSpaceKeys])) as Iterable<{ json: string }>;
      for (const { json } of spaces) {
        const archive = JSON.parse(json) as SourceRecordArchive;
        const origin = pageOrigin(archive);
        if (!origin) continue;
        for (const spaceKey of spaceKeys(archive.record)) {
          const locator = key(origin, spaceKey);
          if (!requestedSpaces.has(locator)) continue;
          addSpaceClaim(spaceClaims, locator, key(archive.source.instanceKey, archive.record.sourceId));
        }
      }
      for (const [locator, identities] of spaceClaims) pageEvidence.push([locator, [...identities].sort()]);
      for (const [locator, address] of scope.requested) {
        const { spaceKey } = address.identity;
        if (spaceKey && (spaceClaims.get(key(originKey(address), spaceKey))?.size ?? 0) > 1) blockedPageKeys.push(locator);
      }
    }
    const rows = db.prepare(`SELECT json_remove(json,'$.record.text') AS json FROM source_records
      WHERE product='confluence' AND kind='page' AND (source_id IN (SELECT value FROM json_each(?))
        OR json_extract(json,'$.record.title') IN (SELECT value FROM json_each(?))) ORDER BY id`)
      .iterate(JSON.stringify([...ids]), JSON.stringify([...titles])) as Iterable<{ json: string }>;
    for (const { json } of rows) {
      const archive = JSON.parse(json) as SourceRecordArchive;
      const origin = pageOrigin(archive), { record, source: { instanceKey } } = archive;
      if (!origin) continue;
      const sourceSpaceId = pageSpaceId(record);
      const space = sourceSpaceId && archiveFor(archive, 'project', sourceSpaceId);
      const allSpaceKeys = space ? spaceKeys(space.record) : [];
      const numeric = scope.requested.has(confluenceMigrationPageKey(origin, { sourceId: record.sourceId }));
      const exactSpaceKeys = allSpaceKeys.filter(spaceKey => scope.requested.has(confluenceMigrationPageKey(origin, { spaceKey, title: record.title })));
      if (!numeric && !exactSpaceKeys.length) continue;
      const verifiedSpaceKey = (spaceKey: string) => spaceClaims.get(key(origin, spaceKey))?.size === 1;
      const binding = bindingFor(archive, 'page', record.sourceId, 'document');
      const historicalOrigin = binding?.importId === archive.sourceImportId ? archive : binding && (() => {
        const origins = pageOrigins.all(binding.importId, instanceKey, record.sourceId, binding.id) as { json: string }[];
        return origins.length === 1 ? JSON.parse(origins[0].json) as SourceRecordArchive : undefined;
      })();
      const active = binding && historicalOrigin && pageOrigin(historicalOrigin) === origin && archive.targetId === binding.id &&
        archive.targetType === 'document' && archive.ownerType === 'document' && archive.ownerId === binding.id && !archive.excluded &&
        !restrictedPage(record) && !knownRestricted(archive) && !historicalOrigin.excluded && !restrictedPage(historicalOrigin.record) &&
        !knownRestricted(historicalOrigin) ? store.get<DocPage>('documents', binding.id) : undefined;
      const document = active ? { id: active.id, projectId: active.projectId, projectName: projectName(active.projectId),
        title: active.title, version: active.version } : null;
      const confirmedAliases = exactSpaceKeys.filter(verifiedSpaceKey);
      const aliases = confirmedAliases.length ? confirmedAliases : numeric ? [undefined] : exactSpaceKeys;
      for (const sourceSpaceKey of aliases) pages.push({ origin, instanceKey, sourceId: record.sourceId, sourceTitle: record.title,
        sourceSpaceId, ...(sourceSpaceKey ? { sourceSpaceKey } : {}),
        document: !sourceSpaceKey || verifiedSpaceKey(sourceSpaceKey) ? document : null });
      pageEvidence.push([archive.id, binding?.importId, binding?.id, origin, record.sourceId, document?.id]);
    }
  };

  const remoteRows = db.prepare(`SELECT relation.source_instance AS instanceKey, relation.source_id AS sourceId,
      json_extract(relation.json,'$.record.metadata.url') AS url FROM source_records AS relation
    WHERE relation.product='jira' AND relation.kind='relation' AND json_extract(relation.json,'$.record.metadata.jiraRestRemoteLink')=1
      AND (relation.source_id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(?) AS site
        WHERE substr(json_extract(relation.json,'$.record.metadata.url'),1,length(site.value)+1)=site.value||'/'))`);
  const selectedRemoteIdentities = new Map<string, [string, string]>();
  for (const { instanceKey, sourceId, url } of remoteRows.iterate(JSON.stringify([...scope.incomingRemoteIds]), JSON.stringify([...scope.incomingOrigins])) as
    Iterable<{ instanceKey: string; sourceId: string; url: string | null }>) {
    const identity = key(instanceKey, sourceId);
    const address = confluenceMigrationPageAddress(url ?? '');
    if (scope.incomingRemoteKeys.has(identity) || address && scope.incomingPageKeys.has(pageKey(address))) {
      selectedRemoteIdentities.set(identity, [instanceKey, sourceId]);
    }
  }

  const links: RetainedJiraResourceLink[] = [];
  const linkEvidence: unknown[] = [];
  const matchingRemotes = db.prepare(`SELECT json_remove(json,'$.record.text') AS json FROM source_records
    WHERE product='jira' AND source_instance=? AND kind='relation' AND source_id=?
      AND json_extract(json,'$.record.metadata.jiraRestRemoteLink')=1 ORDER BY id`);
  for (const [instanceKey, sourceId] of selectedRemoteIdentities.values()) {
    for (const { json } of matchingRemotes.iterate(instanceKey, sourceId) as Iterable<{ json: string }>) {
      const archive = JSON.parse(json) as SourceRecordArchive;
      const { record, ownerId } = archive;
      const ownerSourceId = record.containerId ?? '';
      const address = validRemoteAddress(record);
      const owner = ownerSourceId ? archiveFor(archive, 'issue', ownerSourceId) : undefined;
      const binding = bindingFor(archive, 'issue', ownerSourceId, 'issue');
      const sourceProject = owner && owner.record.containerId && bindingFor(owner, 'project', owner.record.containerId, 'project');
      const active = address && packageFor(archive) && !archive.excluded && archive.ownerType === 'issue' && ownerId &&
        owner && owner.targetType === 'issue' && owner.targetId === ownerId && owner.ownerType === 'issue' && owner.ownerId === ownerId &&
        !owner.excluded && owner.record.metadata.restricted !== true && !isRestrictedJiraHistoryOwner(owner.record) &&
        binding?.id === ownerId && sourceProject && owner.targetProjectId === sourceProject.id && archive.targetProjectId === sourceProject.id
        ? store.get<Issue>('issues', ownerId) : undefined;
      const issue = active ? { id: active.id, projectId: active.projectId, projectName: projectName(active.projectId), key: active.key,
        title: active.title, version: active.version } : null;
      if (issue && address && scope.incomingPageKeys.has(pageKey(address))) scope.requested.set(pageKey(address), address);
      const url = text(record.metadata.url), pageId = text(record.metadata.remotePageId), applicationType = text(record.metadata.remoteApplicationType);
      links.push({ instanceKey, sourceId, ownerSourceId, url, ...(pageId ? { pageId } : {}), ...(applicationType ? { applicationType } : {}),
        ...(record.metadata.jiraRemoteLinkConflict === true ? { conflict: true } : {}), issue });
      linkEvidence.push([archive.id, owner?.id, binding?.importId, binding?.id, issue?.id]);
    }
  }
  readPages();

  const pagesByDestination = new Map<string, RetainedResourcePage[]>();
  for (const page of pages.filter(({ document }) => document)) {
    const { origin, sourceId, sourceSpaceKey, sourceTitle } = page;
    const destinations = [confluenceMigrationPageKey(origin, { sourceId })];
    if (sourceSpaceKey) destinations.push(confluenceMigrationPageKey(origin, { spaceKey: sourceSpaceKey, title: sourceTitle }));
    for (const destination of destinations) {
      const values = pagesByDestination.get(destination) ?? [];
      values.push(page);
      pagesByDestination.set(destination, values);
    }
  }
  const candidatePairs = new Map<string, [string, string]>();
  for (const link of links) {
    if (!link.issue) continue;
    const address = confluenceMigrationPageAddress(link.url);
    if (!address) continue;
    for (const page of pagesByDestination.get(pageKey(address)) ?? []) {
      if (page.document && (!link.pageId || link.pageId === page.sourceId)) {
        candidatePairs.set(key(link.issue.id, page.document.id), [link.issue.id, page.document.id]);
      }
    }
  }
  const pairs = new Map<string, [string, string]>();
  let pairEvidence: unknown[] = [];
  if (candidatePairs.size) {
    const observed = db.prepare(`WITH scoped AS (
      SELECT json_extract(value,'$[0]') AS issueId,json_extract(value,'$[1]') AS documentId FROM json_each(?)
    ) SELECT 'live' AS origin,link.id,link.issue_id AS issueId,link.document_id AS documentId
      FROM scoped JOIN resource_links AS link ON link.issue_id=scoped.issueId AND link.document_id=scoped.documentId
      UNION ALL SELECT receipt.id AS origin,json_extract(proof.value,'$.id'),json_extract(proof.value,'$.issueId'),json_extract(proof.value,'$.documentId')
      FROM source_imports AS receipt,json_each(receipt.json,'$.resourceLinkProof') AS proof JOIN scoped
       ON scoped.issueId=json_extract(proof.value,'$.issueId') AND scoped.documentId=json_extract(proof.value,'$.documentId') ORDER BY origin,id`);
    const rows = observed.all(JSON.stringify([...candidatePairs.values()])) as
      { origin: string; id: string; issueId: string; documentId: string }[];
    for (const { issueId, documentId } of rows) pairs.set(key(issueId, documentId), [issueId, documentId]);
    pairEvidence = rows;
  }

  const ordered = <T>(values: T[]): T[] => values.sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : Number(left > right);
  });
  const distinct = <T>(values: T[]): T[] => ordered([...new Map(values.map(value => [JSON.stringify(value), value])).values()]);
  const result = { pages: distinct(pages), links: distinct(links), existingPairs: ordered([...pairs.values()]), blockedPageKeys: blockedPageKeys.sort() };
  const token = createHash('sha256').update(JSON.stringify([result, ordered(pageEvidence), ordered(linkEvidence), pairEvidence])).digest('hex');
  return { token, ...result };
}
