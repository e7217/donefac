import { createHash } from 'node:crypto';
import type {
  SourceImport, SourceImportResourceLink, SourceReconciliationResourceLinkFinding, SourceReconciliationResourceLinkProjection,
  SourceReconciliationResourceLinkRow, SourceReconciliationResourceLinkStatus,
} from '../shared/types.js';
import { parseResourceLinkProof, SourcePreservationError } from './source-preservation.js';
import type { Store } from './store.js';

type EndpointKind = 'issue' | 'document';
type Findings = { finding: SourceReconciliationResourceLinkFinding; offset: number; limit: number };
type EndpointRow = {
  activeId: string | null; activeProjectId: string | null; activeValid: number | null; activeTitle: string | null; activeKey: string | null;
  trashId: string | null; trashProjectId: string | null; trashValid: number | null; trashTitle: string | null; trashKey: string | null;
};
type Observation = { json: string } & (
  { location: 'active'; issueId: string; documentId: string } |
  { location: 'trash'; ownerType: EndpointKind; ownerId: string; trashId: string }
);

function receiptProof(receipt: SourceImport, expected: number | null): SourceImportResourceLink[] {
  try {
    const proof = parseResourceLinkProof(receipt.resourceLinkProof, expected ?? undefined) ?? [];
    return proof.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  } catch (error) {
    if (!(error instanceof SourcePreservationError)) throw error;
    throw new SourcePreservationError(409, '이관 영수증의 업무·문서 연결 검증 기준이 손상되었습니다.');
  }
}

function observationMatches(value: Observation, proof: SourceImportResourceLink): boolean {
  let link: unknown;
  try { link = JSON.parse(value.json); }
  catch { return false; }
  if (!link || typeof link !== 'object' || Array.isArray(link)) return false;
  const { id, issueId, documentId, kind } = link as Record<string, unknown>;
  if (id !== proof.id || issueId !== proof.issueId || documentId !== proof.documentId || kind !== 'related') return false;
  return value.location === 'active' ? value.issueId === issueId && value.documentId === documentId
    : value.ownerId === (value.ownerType === 'issue' ? issueId : documentId);
}

function endpointReader(store: Store, kind: EndpointKind) {
  const isIssue = kind === 'issue';
  const statement = store.db.prepare(`SELECT target.id AS activeId,target.project_id AS activeProjectId,
    CASE WHEN json_valid(target.json) THEN json_extract(target.json,'$.id')=target.id
      AND json_extract(target.json,'$.projectId') IS target.project_id
      AND json_type(target.json,'$.title')='text' ${isIssue ? "AND json_type(target.json,'$.key')='text'" : ''} END AS activeValid,
    CASE WHEN json_valid(target.json) THEN json_extract(target.json,'$.title') END AS activeTitle,
    ${isIssue ? "CASE WHEN json_valid(target.json) THEN json_extract(target.json,'$.key') END" : 'NULL'} AS activeKey,
    archive.id AS trashId,archive.project_id AS trashProjectId,
    CASE WHEN json_valid(archive.json) THEN json_extract(archive.json,'$.id')=archive.id
      AND json_extract(archive.json,'$.resourceType')=archive.resource_type
      AND json_extract(archive.json,'$.resourceId')=archive.resource_id AND json_extract(archive.json,'$.resource.id')=archive.resource_id
      AND json_extract(archive.json,'$.projectId') IS archive.project_id
      AND json_extract(archive.json,'$.resource.projectId') IS archive.project_id
      AND json_type(archive.json,'$.resourceLinks')='array'
      AND json_type(archive.json,'$.resource.title')='text' AND json_extract(archive.json,'$.title')=json_extract(archive.json,'$.resource.title')
      ${isIssue ? "AND json_type(archive.json,'$.resource.key')='text' AND json_extract(archive.json,'$.issueKey')=json_extract(archive.json,'$.resource.key')" : ''}
    END AS trashValid,
    CASE WHEN json_valid(archive.json) THEN json_extract(archive.json,'$.resource.title') END AS trashTitle,
    ${isIssue ? "CASE WHEN json_valid(archive.json) THEN json_extract(archive.json,'$.resource.key') END" : 'NULL'} AS trashKey
    FROM (SELECT ? AS id) wanted LEFT JOIN ${isIssue ? 'issues' : 'documents'} target ON target.id=wanted.id
    LEFT JOIN trash_entries archive ON archive.resource_type=? AND archive.resource_id=wanted.id`);
  const endpoints = new Map<string, EndpointRow>();

  return (id: string): EndpointRow => {
    const saved = endpoints.get(id);
    if (saved) return saved;
    const row = statement.get(id, kind) as EndpointRow;
    endpoints.set(id, row);
    return row;
  };
}

function resourceLinkReader(store: Store, tracked: ReadonlySet<string>) {
  const active = store.db.prepare(`SELECT 'active' AS location,json,issue_id AS issueId,document_id AS documentId FROM resource_links WHERE id=?`);
  const archived = store.db.prepare(`SELECT json_extract(CASE WHEN link.type='object' THEN link.value END,'$.id') AS id,
    'trash' AS location,link.value AS json,archive.resource_type AS ownerType,archive.resource_id AS ownerId,archive.id AS trashId
    FROM trash_entries archive CROSS JOIN json_each(CASE WHEN json_valid(archive.json) THEN archive.json END,'$.resourceLinks') link
    WHERE archive.id=? AND link.type='object' ORDER BY link.key`);
  const linksByArchive = new Map<string, Map<string, Observation[]>>();

  function fromArchive(trashId: string, linkId: string): Observation[] {
    let index = linksByArchive.get(trashId);
    if (!index) {
      index = new Map();
      for (const { id, ...value } of archived.iterate(trashId) as Iterable<Observation & { id: string }>) {
        if (!tracked.has(id)) continue;
        const matches = index.get(id) ?? [];
        matches.push(value);
        index.set(id, matches);
      }
      linksByArchive.set(trashId, index);
    }
    return index.get(linkId) ?? [];
  }

  return (id: string, owners: EndpointRow[]): Observation[] => {
    const current = active.get(id) as Observation | undefined;
    const trashed = owners.flatMap(owner => owner.trashId && owner.trashValid === 1 ? fromArchive(owner.trashId, id) : []);
    return current ? [current, ...trashed] : trashed;
  };
}

function endpointState(row: EndpointRow): 'active' | 'trash' | 'unavailable' {
  if (row.activeId && !row.trashId && row.activeValid === 1) return 'active';
  if (row.trashId && !row.activeId && row.trashValid === 1) return 'trash';
  return 'unavailable';
}

export function auditResourceLinkProjections(store: Store, receipt: SourceImport, findings?: Findings) {
  const count = receipt.counts.resourceLinks;
  const expected = Number.isSafeInteger(count) && count >= 0 ? count : null;
  if (expected === null && receipt.resourceLinkProof === undefined) return null;
  const proof = receiptProof(receipt, expected);
  const counts: SourceReconciliationResourceLinkProjection['counts'] = { linked: 0, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 };
  const hash = createHash('sha256').update(JSON.stringify([1, expected])).update('\n');
  const issueEndpoint = endpointReader(store, 'issue');
  const documentEndpoint = endpointReader(store, 'document');
  const observationsFor = resourceLinkReader(store, new Set(proof.map(link => link.id)));
  const rows: SourceReconciliationResourceLinkRow[] = [];
  let total = 0;

  for (const link of proof) {
    const { id, issueId, documentId } = link;
    const issue = issueEndpoint(issueId);
    const document = documentEndpoint(documentId);
    const issueState = endpointState(issue);
    const documentState = endpointState(document);
    const observations = observationsFor(id, [issue, document]);
    const observed = observations[0];
    let status: SourceReconciliationResourceLinkStatus;
    if (observations.length > 1 || observed && !observationMatches(observed, link)) status = 'mismatch';
    else if (issueState === 'unavailable' || documentState === 'unavailable') status = 'unavailable';
    else if (!observed) status = 'missing';
    else if (observed.location === 'trash') status = 'trashed';
    else status = issueState === 'active' && documentState === 'active' ? 'linked' : 'mismatch';

    counts[status]++;
    hash.update(JSON.stringify([id, issueId, documentId, issue, document, status, observations.map(({ json, ...location }) =>
      [location, createHash('sha256').update(json).digest('hex')])])).update('\n');
    if (findings?.finding !== status) continue;
    if (total >= findings.offset && rows.length < findings.limit) {
      const issueTitle = issueState === 'active' ? issue.activeTitle : issue.trashTitle;
      const issueKey = issueState === 'active' ? issue.activeKey : issue.trashKey;
      const documentTitle = documentState === 'active' ? document.activeTitle : document.trashTitle;
      rows.push({ id, issueId, documentId,
        issue: issueState !== 'unavailable' && issueTitle !== null && issueKey !== null ? { id: issueId, key: issueKey, title: issueTitle } : null,
        document: documentState !== 'unavailable' && documentTitle !== null ? { id: documentId, title: documentTitle } : null });
    }
    total++;
  }

  const audit: SourceReconciliationResourceLinkProjection = { version: 1, expected, counts, sha256: hash.digest('hex') };
  return { audit, rows, total };
}
