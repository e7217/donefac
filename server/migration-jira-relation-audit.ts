import { createHash } from 'node:crypto';
import type {
  IssueRelation, SourceImport, SourceReconciliationJiraRelationFinding, SourceReconciliationJiraRelationFindingsPage,
  SourceReconciliationJiraRelationProjection, SourceReconciliationJiraRelationStatus, SourceRecordArchive,
} from '../shared/types.js';
import { attachmentId } from './attachments.js';
import { readIssueProjectHistory } from './issue-project-history.js';
import { jiraIssueRelationSource } from './migration-jira-relations.js';
import { jiraRelationMatchesEndpoints, jiraRelationProjectsAtReceipt, type SourcePreservationService } from './source-preservation.js';
import type { Store } from './store.js';

type FindingRow = SourceReconciliationJiraRelationFindingsPage['rows'][number];
type Findings = { finding: SourceReconciliationJiraRelationFinding; offset: number; limit: number };
type MarkedArchiveRow = FindingRow & { json: string; product: string; proofCount: number; targetType: string | null; targetId: string | null };
type EndpointRow = {
  activeId: string | null; activeProjectId: string | null; activeValid: number | null;
  trashId: string | null; trashProjectId: string | null; trashValid: number | null;
};
type RelationObservation = {
  location: 'active' | 'trash'; json: string;
  owner: string | null; trashId: string | null; sourceIssueId: string | null; targetIssueId: string | null;
};

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const packageIdentity = (source: SourceImport['packages'][number]['source'], sha256: string) =>
  JSON.stringify([source.product, source.instanceKey, source.format, sha256]);

function readMarker(row: MarkedArchiveRow, receiptId: string, packages: ReadonlyMap<string, number>) {
  const archive = JSON.parse(row.json) as SourceRecordArchive;
  const { source, record, packageSha256 } = archive;
  if (row.product !== 'jira' || archive.id !== row.sourceRecordId || archive.sourceImportId !== receiptId ||
      row.targetType !== null || row.targetId !== null || archive.targetType !== null || archive.targetId !== null || archive.excluded ||
      !source || source.product !== 'jira' || source.instanceKey !== row.sourceInstance ||
      packages.get(packageIdentity(source, packageSha256)) !== 1 ||
      record?.kind !== 'relation' || record.id !== `relation:${row.sourceId}` || record.sourceId !== row.sourceId ||
      !record.metadata || typeof record.title !== 'string' || !Array.isArray(record.references) ||
      record.references.some(ref => !ref || typeof ref.sourceId !== 'string')) return null;
  const link = jiraIssueRelationSource(record);
  if (!link) return null;
  let relationId: string;
  try { relationId = attachmentId(archive.jiraRelationId); }
  catch { return null; }
  const scope = { instanceKey: source.instanceKey, importId: receiptId, packageSha256 };
  return { relationId, link, sourceAlias: { ...scope, alias: link.sourceAlias }, targetAlias: { ...scope, alias: link.targetAlias } };
}

function readMarkers(store: Store, receipt: SourceImport) {
  const packages = new Map<string, number>();
  for (const { source, sha256 } of receipt.packages) {
    const key = packageIdentity(source, sha256);
    packages.set(key, (packages.get(key) ?? 0) + 1);
  }
  const rows = store.db.prepare(`SELECT r.id AS sourceRecordId,r.source_id AS sourceId,r.source_instance AS sourceInstance,
    r.product,r.target_type AS targetType,r.target_id AS targetId,r.json,
    (SELECT count(*) FROM source_records candidate
      WHERE candidate.product='jira' AND candidate.kind='relation' AND json_valid(candidate.json)
        AND json_type(candidate.json,'$.jiraRelationId')='text'
        AND json_extract(candidate.json,'$.jiraRelationId')=json_extract(r.json,'$.jiraRelationId')) AS proofCount
    FROM source_records r WHERE r.import_id=? AND r.kind='relation' AND json_valid(r.json)
      AND json_type(r.json,'$.jiraRelationId') IS NOT NULL
    ORDER BY r.id COLLATE BINARY`).iterate(receipt.id) as Iterable<MarkedArchiveRow>;
  return Array.from(rows, row => ({
    identity: { sourceRecordId: row.sourceRecordId, sourceId: row.sourceId, sourceInstance: row.sourceInstance },
    proofCount: row.proofCount, storedHash: digest(row.json), marker: readMarker(row, receipt.id, packages),
  }));
}

function observedRelation(observation: RelationObservation, relationId: string, typeName: string,
  resolved: readonly string[]): IssueRelation | null {
  let value: IssueRelation;
  try { value = JSON.parse(observation.json) as IssueRelation; }
  catch { return null; }
  if (!value || value.id !== relationId || value.origin !== undefined || value.type !== typeName ||
      typeof value.sourceIssueId !== 'string' || typeof value.targetIssueId !== 'string' || value.sourceIssueId === value.targetIssueId ||
      !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      resolved.some(id => id !== value.sourceIssueId && id !== value.targetIssueId)) return null;
  if (observation.location === 'active'
    ? observation.sourceIssueId !== value.sourceIssueId || observation.targetIssueId !== value.targetIssueId
    : observation.owner !== value.sourceIssueId && observation.owner !== value.targetIssueId) return null;
  return value;
}

function jiraRelationObservationReaders(store: Store, trackedRelations: ReadonlySet<string>) {
  const endpointStatement = store.db.prepare(`SELECT i.id AS activeId,i.project_id AS activeProjectId,
    CASE WHEN json_valid(i.json) THEN json_extract(i.json,'$.id')=i.id AND json_extract(i.json,'$.projectId')=i.project_id END AS activeValid,
    t.id AS trashId,t.project_id AS trashProjectId,
    CASE WHEN json_valid(t.json) THEN json_extract(t.json,'$.id')=t.id
      AND json_extract(t.json,'$.resourceType')='issue'
      AND json_extract(t.json,'$.resourceId')=t.resource_id AND json_extract(t.json,'$.resource.id')=t.resource_id
      AND json_extract(t.json,'$.projectId')=t.project_id AND json_extract(t.json,'$.resource.projectId')=t.project_id END AS trashValid
    FROM (SELECT ? AS id) wanted LEFT JOIN issues i ON i.id=wanted.id
    LEFT JOIN trash_entries t ON t.resource_type='issue' AND t.resource_id=wanted.id`);
  const activeStatement = store.db.prepare(`SELECT 'active' AS location,json,NULL AS owner,NULL AS trashId,
    source_issue_id AS sourceIssueId,target_issue_id AS targetIssueId FROM issue_relations WHERE id=?`);
  const trashStatement = store.db.prepare(`SELECT json_extract(edge.value,'$.id') AS id,'trash' AS location,edge.value AS json,t.resource_id AS owner,
    t.id AS trashId,NULL AS sourceIssueId,NULL AS targetIssueId
    FROM trash_entries t CROSS JOIN json_each(CASE WHEN json_valid(t.json) THEN t.json END,'$.issueRelations') edge
    WHERE t.id=? AND t.resource_type='issue' AND t.resource_id=? AND edge.type='object' ORDER BY edge.key`);
  const endpoints = new Map<string, EndpointRow>();
  const archivedRelations = new Map<string, Map<string, RelationObservation[]>>();
  function endpoint(issueId: string) {
    const cached = endpoints.get(issueId);
    if (cached) return cached;
    const found = endpointStatement.get(issueId) as EndpointRow;
    endpoints.set(issueId, found);
    return found;
  }
  function archived(issueId: string, relationId: string): RelationObservation[] {
    const { trashId } = endpoint(issueId);
    if (!trashId) return [];
    let index = archivedRelations.get(issueId);
    if (!index) {
      index = new Map();
      const rows = trashStatement.iterate(trashId, issueId) as Iterable<RelationObservation & { id: string }>;
      for (const { id, ...observation } of rows) {
        if (!trackedRelations.has(id)) continue;
        const matches = index.get(id) ?? [];
        matches.push(observation);
        index.set(id, matches);
      }
      archivedRelations.set(issueId, index);
    }
    return index.get(relationId) ?? [];
  }
  function observations(relationId: string, first: string | undefined, second: string | undefined): RelationObservation[] {
    const active = activeStatement.get(relationId) as RelationObservation | undefined;
    const provenEndpoints = new Set([first, second]);
    const trashed = [...provenEndpoints].flatMap(id => id ? archived(id, relationId) : []);
    return active ? [active, ...trashed] : trashed;
  }
  return { endpoint, observations };
}

export function auditJiraRelationProjections({ store, preservation }: { store: Store; preservation: SourcePreservationService },
  receipt: SourceImport, findings?: Findings) {
  if (!receipt.packages.some(pkg => pkg.source.product === 'jira')) return null;
  const markers = readMarkers(store, receipt);
  const resolver = preservation.jiraRelationAliasResolver(markers.flatMap(({ marker }) => marker ? [marker.sourceAlias, marker.targetAlias] : []));
  const resolved = markers.map(({ marker }) => marker ? [resolver(marker.sourceAlias), resolver(marker.targetAlias)] as const : [undefined, undefined] as const);
  const history = readIssueProjectHistory(store, [...new Set(resolved.flatMap(pair => pair.filter((id): id is string => id !== undefined)))]);
  const receiptScope = { projectIds: receipt.projectIds, createdAt: receipt.createdAt,
    ...(receipt.configuration.appendTo ? { anchor: receipt.configuration.appendTo.projectId } : {}) };
  const priorCount = receipt.counts.issueRelations;
  const expected = Number.isSafeInteger(priorCount) && priorCount >= 0 ? priorCount : null;
  const counts: SourceReconciliationJiraRelationProjection['counts'] = { linked: 0, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 };
  const hash = createHash('sha256').update(JSON.stringify([1, expected])).update('\n');
  const lookup = jiraRelationObservationReaders(store, new Set(markers.flatMap(({ marker }) => marker ? [marker.relationId] : [])));
  const rows: FindingRow[] = [];
  let total = 0;

  markers.forEach(({ identity, proofCount, storedHash, marker }, index) => {
    const [first, second] = resolved[index];
    const left = first ? lookup.endpoint(first) : null;
    const right = second ? lookup.endpoint(second) : null;
    const observations = marker ? lookup.observations(marker.relationId, first, second) : [];
    const related = marker && observations[0] && observedRelation(observations[0], marker.relationId, marker.link.typeName,
      [first, second].filter((id): id is string => id !== undefined));
    const malformedEndpoint = (row: EndpointRow | null) => row &&
      ((row.activeId && (row.activeValid !== 1 || row.trashId)) || (row.trashId && row.trashValid !== 1));
    const leftProject = left?.activeProjectId ?? left?.trashProjectId;
    const rightProject = right?.activeProjectId ?? right?.trashProjectId;
    const projects = first && second && leftProject && rightProject
      ? jiraRelationProjectsAtReceipt(receiptScope, { issueId: first, projectId: leftProject }, { issueId: second, projectId: rightProject }, history)
      : undefined;
    let status: SourceReconciliationJiraRelationStatus;
    if (!marker || proofCount !== 1 || observations.length > 1 || (observations.length === 1 && !related) ||
        (first && first === second) || malformedEndpoint(left) || malformedEndpoint(right) ||
        (related && first && second && !jiraRelationMatchesEndpoints(marker.link, first, second, related))) status = 'mismatch';
    else if (!leftProject || !rightProject) status = 'unavailable';
    else if (!projects || (observations[0]?.location === 'active' && (!left?.activeId || !right?.activeId))) status = 'mismatch';
    else if (!related) status = 'missing';
    else status = observations[0].location === 'active' ? 'linked' : 'trashed';

    counts[status]++;
    hash.update(JSON.stringify([identity.sourceRecordId, identity.sourceId, identity.sourceInstance, storedHash, proofCount,
      first, second, left, right, projects ?? null, status, observations.map(({ json, ...location }) => [location, digest(json)])])).update('\n');
    if (findings?.finding === status) {
      if (total >= findings.offset && rows.length < findings.limit) rows.push(identity);
      total++;
    }
  });

  const audit: SourceReconciliationJiraRelationProjection = { version: 1, expected, counts, sha256: hash.digest('hex') };
  return { audit, rows, total };
}
