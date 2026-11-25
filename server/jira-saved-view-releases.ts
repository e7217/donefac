import type { JiraViewReleaseField } from '../shared/jira-view-query.js';
import type { LegacyRecord, PlanningItem, SourceImport, SourceRecordArchive } from '../shared/types.js';
import { jiraAdministratorFixAssociation, jiraArchivedIssueFixVersions, jiraReleasePlanningId, jiraReleaseVersionId } from './migration-jira-releases.js';
import type { Store } from './store.js';

const numericId = /^[1-9][0-9]{0,19}$/u;
const normalizedName = (name: string) => name.trim().normalize('NFC').toLowerCase();

function originalProjects(record: LegacyRecord): string[] {
  return record.references.filter(ref => ref.kind === 'project' && ref.relation === 'project').map(ref => ref.sourceId);
}

const administratorIssueKey = (archive: SourceRecordArchive, issueId: string) =>
  JSON.stringify([archive.sourceImportId, archive.packageSha256, issueId]);

function administratorFixVersions(store: Store, instanceKey: string) {
  const memberships = new Map<string, Set<string> | null>();
  const rows = store.db.prepare(`SELECT json FROM source_records WHERE product='jira' AND source_instance=? AND kind='relation'
    AND json_extract(json,'$.source.format')='jira-backup-xml' AND json_extract(json,'$.record.metadata.associationType')='IssueFixVersion'`);
  for (const { json } of rows.iterate(instanceKey)) {
    const archive = JSON.parse(String(json)) as SourceRecordArchive;
    const issue = archive.record.references.find(ref => ref.kind === 'issue' && ref.relation === 'source');
    if (!issue) continue;
    const key = administratorIssueKey(archive, issue.sourceId);
    const association = jiraAdministratorFixAssociation(archive.record);
    const previous = memberships.get(key);
    if (!association || previous === null) {
      memberships.set(key, null);
    } else {
      const ids = previous ?? new Set<string>();
      ids.add(association.versionId);
      memberships.set(key, ids);
    }
  }
  return memberships;
}

/** Prove an original Jira predicate can be carried by the workspace's representative release. */
export function jiraSavedViewReleases(store: Store, projectId: string, instanceKey: string, projectAliases: readonly string[],
  planningItems: readonly PlanningItem[], onMatch: (sourceId: string, targetId: string) => void): JiraViewReleaseField {
  const aliases = new Set(projectAliases);
  const releases = new Map(planningItems.filter(item => item.projectId === projectId && item.kind === 'release').map(item => [item.id, item]));
  const receipts = new Map<string, SourceImport | undefined>();
  const fromBoundPackage = ({ sourceImportId, packageSha256, source }: SourceRecordArchive) => {
    if (!receipts.has(sourceImportId)) receipts.set(sourceImportId, store.get<SourceImport>('source_imports', sourceImportId));
    const receipt = receipts.get(sourceImportId);
    return receipt?.projectIds.includes(projectId) && receipt.packages.some(pack => pack.sha256 === packageSha256 &&
      pack.source.product === 'jira' && pack.source.instanceKey === instanceKey && pack.source.format === source.format);
  };
  const idsByName = new Map<string, Set<string>>();
  const knownIds = new Set<string>();
  const mapped = new Set<string>();
  const ambiguous = new Set<string>();
  for (const { json } of store.db.prepare(`SELECT json FROM source_records
    WHERE product='jira' AND source_instance=? AND kind='option' AND source_id GLOB 'builtin:versions:*'`).iterate(instanceKey)) {
    const archive = JSON.parse(String(json)) as SourceRecordArchive;
    const { record } = archive;
    const sourceId = jiraReleaseVersionId(record);
    if (!sourceId || record.metadata.id !== undefined && String(record.metadata.id) !== sourceId ||
        typeof record.metadata.project !== 'string' || !aliases.has(record.metadata.project) ||
        originalProjects(record).some(project => !aliases.has(project)) || !fromBoundPackage(archive)) continue;
    knownIds.add(sourceId);
    const name = normalizedName(record.title);
    if (name && record.metadata.jiraVersionNameMissing !== true) {
      const ids = idsByName.get(name) ?? new Set<string>();
      ids.add(sourceId);
      idsByName.set(name, ids);
    }
    if (record.metadata.jiraVersionAmbiguous === true) ambiguous.add(sourceId);
    if (!archive.excluded && name && record.metadata.jiraVersionNameMissing !== true) mapped.add(sourceId);
  }

  return {
    resolve(value, quoted) {
      const asId = numericId.test(value) && knownIds.has(value);
      const ids = !quoted && numericId.test(value) ? (asId ? new Set([value]) : undefined) : idsByName.get(normalizedName(value));
      if (!ids?.size) return { kind: 'unmapped' };
      const [sourceId] = ids;
      if (ids.size > 1 || quoted && asId && sourceId !== value || ambiguous.has(sourceId)) return { kind: 'ambiguous' };
      const current = releases.get(jiraReleasePlanningId(instanceKey, sourceId, projectId));
      if (!mapped.has(sourceId) || !current) return { kind: 'unmapped' };
      onMatch(sourceId, current.id);
      return { kind: 'mapped', sourceId, targetId: current.id, label: current.name };
    },
    verify(matchesSource, matchesCurrent) {
      const rows = store.db.prepare(`SELECT issue.id, json_extract(issue.json,'$.releaseId') AS releaseId, archive.json
        FROM issues AS issue LEFT JOIN source_records AS archive
          ON archive.target_type='issue' AND archive.target_id=issue.id AND archive.product='jira' AND archive.kind='issue'
          AND archive.source_instance=?
        WHERE issue.project_id=? AND EXISTS (
          SELECT 1 FROM source_bindings AS origin WHERE origin.target_type='issue' AND origin.target_id=issue.id
            AND origin.product='jira' AND origin.kind='issue'
        )`).iterate(instanceKey, projectId);
      const covered = new Map<string, boolean>();
      let administrator: ReturnType<typeof administratorFixVersions> | undefined;
      for (const { id, releaseId, json } of rows) {
        const issueId = String(id);
        if (!covered.has(issueId)) covered.set(issueId, false);
        if (json === null) continue;
        const archive = JSON.parse(String(json)) as SourceRecordArchive;
        const { record } = archive;
        if (archive.excluded || archive.targetProjectId !== projectId || !record.containerId || !aliases.has(record.containerId) ||
            originalProjects(record).some(project => !aliases.has(project)) || !fromBoundPackage(archive)) continue;
        let ids = jiraArchivedIssueFixVersions(record, archive.source.format);
        if (archive.source.format === 'jira-backup-xml' && ids !== null) {
          administrator ??= administratorFixVersions(store, instanceKey);
          const associations = administrator.get(administratorIssueKey(archive, record.sourceId));
          if (associations === null || ids && associations && (ids.size !== associations.size || [...associations].some(id => !ids?.has(id)))) {
            return 'unknown';
          }
          ids = ids ?? associations ?? new Set<string>();
        }
        if (ids === null) return 'unknown';
        if (!ids) continue;
        covered.set(issueId, true);
        if (matchesSource(ids) !== matchesCurrent(typeof releaseId === 'string' ? releaseId : null)) return 'different';
      }
      return [...covered.values()].every(Boolean) ? 'exact' : 'unknown';
    },
  };
}
