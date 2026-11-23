import type { JiraViewAliasField, JiraViewSourceAliasResolver } from '../shared/jira-view-query.js';
import { normalizeMigrationEmail } from '../shared/migration-identity-suggestions.js';
import type { JiraMigrationIssueField, LegacyRecord, MigrationConfiguration, SourceImport, SourceRecordArchive } from '../shared/types.js';
import { jiraIdentityEmailEvidence } from './migration-identity-email.js';
import {
  importedIssueTypeId, importedStatusId, jiraAssignee, jiraFieldDigest, jiraReporter, jiraSourceBuiltin,
  jiraSourceFieldHashes, migrationOptionId,
} from './migration-planner.js';
import type { Store } from './store.js';

type SourceRecordLookup = (kind: 'identity' | 'option', sourceId: string) => Pick<LegacyRecord, 'sourceId' | 'title' | 'metadata'> | undefined;

interface JiraSavedViewSource {
  archive: SourceRecordArchive;
  packageId: string;
  configuration: MigrationConfiguration;
  original: boolean;
  record: SourceRecordLookup;
  accepted: (field: JiraMigrationIssueField, targetId: string) => boolean;
}

interface JiraSavedViewAliasEvidence {
  sourceId: string;
  aliases: readonly string[];
  targetId: string | null;
  blockedAliases?: readonly string[];
}

interface AliasIndex {
  sourcesByAlias: Map<string, Set<string>>;
  targetsBySource: Map<string, Set<string | null>>;
  sourcesByTarget: Map<string, Set<string>>;
  blockedAliases: Set<string>;
}

function aliasIndex(): AliasIndex {
  return { sourcesByAlias: new Map(), targetsBySource: new Map(), sourcesByTarget: new Map(), blockedAliases: new Set() };
}

function addToIndex<T>(index: Map<string, Set<T>>, key: string, value: T) {
  const values = index.get(key) ?? new Set<T>();
  values.add(value);
  index.set(key, values);
}

function indexEvidence(index: AliasIndex, { sourceId, aliases, targetId, blockedAliases }: JiraSavedViewAliasEvidence) {
  for (const alias of aliases) addToIndex(index.sourcesByAlias, alias.toLowerCase(), sourceId);
  for (const alias of blockedAliases ?? []) index.blockedAliases.add(alias.toLowerCase());
  addToIndex(index.targetsBySource, sourceId, targetId);
  if (targetId) addToIndex(index.sourcesByTarget, targetId, sourceId);
}

function fieldEvidence(source: JiraSavedViewSource, field: 'status' | 'type'): JiraSavedViewAliasEvidence | undefined {
  const { archive, packageId, configuration } = source;
  const kind = field === 'status' ? 'status' : 'issuetype';
  const { value, label } = jiraSourceBuiltin(archive.record, kind);
  if (value === '__unspecified__') return;

  const optionId = migrationOptionId(packageId, kind, value);
  const append = configuration.appendTo;
  let targetId: string | undefined;
  if (field === 'status') {
    targetId = append ? append.statuses[optionId]
      : Object.hasOwn(configuration.statuses, optionId) ? importedStatusId(archive.source, value) : undefined;
  } else {
    targetId = append ? append.issueTypes[optionId]
      : Object.hasOwn(configuration.issueTypes, optionId)
        ? configuration.issueTypes[optionId] || importedIssueTypeId(archive.source, value) : undefined;
  }
  const acceptedTarget = targetId && source.accepted(field, targetId) ? targetId : null;
  if (!acceptedTarget && !source.original) return;

  const sourceLabel = label || source.record('option', `builtin:${kind}:${value}`)?.title;
  const aliases = sourceLabel?.trim() && sourceLabel !== value ? [value, sourceLabel] : [value];
  return { sourceId: value, aliases, targetId: acceptedTarget };
}

function memberEvidence(source: JiraSavedViewSource, field: 'assignee' | 'reporter'): JiraSavedViewAliasEvidence | undefined {
  const issue = source.archive.record;
  const sourceId = field === 'assignee' ? jiraAssignee(issue) : jiraReporter(issue);
  if (!sourceId) return;

  const mapped = source.configuration.users[migrationOptionId(source.packageId, 'identity', sourceId)];
  const issueField = field === 'assignee' ? 'assigneeId' : 'reporterId';
  const targetId = typeof mapped === 'string' && mapped && source.accepted(issueField, mapped) ? mapped : null;
  if (!targetId && !source.original) return;

  const identity = source.record('identity', sourceId);
  const metadata = identity?.metadata ?? {};
  const email = jiraIdentityEmailEvidence(identity)?.email;
  const aliases = [sourceId, metadata.accountId, metadata.key, metadata.name,
    metadata.username, metadata.userName, metadata.lowerUserName, email]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  // Old and contradictory email claims can flag a collision but cannot establish a mapping.
  const blockedAliases = [metadata.emailAddress, metadata.email].flatMap(value => {
    const claimed = typeof value === 'string' ? normalizeMigrationEmail(value) : null;
    return claimed && claimed !== email ? [claimed] : [];
  });
  return { sourceId, aliases, targetId, ...(blockedAliases.length ? { blockedAliases } : {}) };
}

function sourceFieldAccepted(archive: SourceRecordArchive, original: boolean, field: JiraMigrationIssueField, targetId: string) {
  const recordedTarget = archive.jiraIssueFieldHashes?.[field];
  if (original && recordedTarget === undefined) return true;
  if (recordedTarget !== jiraFieldDigest(field, targetId)) return false;
  if (original) return true;
  const recordedSource = archive.jiraIssueSourceFieldHashes?.[field];
  const incoming = jiraSourceFieldHashes(field, archive.record);
  return recordedSource?.length === incoming.length && incoming.every((digest, index) => digest === recordedSource[index]);
}

function isOriginalProjectRecord(record: LegacyRecord, projectAliases: ReadonlySet<string>) {
  const declared = record.references.filter(reference => reference.kind === 'project' && reference.relation === 'project')
    .map(reference => reference.sourceId);
  if (record.containerId) declared.push(record.containerId);
  return declared.length > 0 && declared.every(alias => projectAliases.has(alias));
}

/** Read the migration mappings for live issues in one proven Jira project. No source values are stored in the view. */
export function jiraSavedViewSourceAliases(store: Store, projectId: string, instanceKey: string,
  projectAliases: readonly string[], fields: readonly JiraViewAliasField[]): JiraViewSourceAliasResolver {
  const indexes = new Map<JiraViewAliasField, AliasIndex>();
  const memberFields = ['assignee', 'reporter'] as const;
  // A Jira user is the same account in both roles. Only proven assignee and reporter fields contribute.
  if (memberFields.some(field => fields.includes(field))) {
    const members = aliasIndex();
    for (const field of memberFields) indexes.set(field, members);
  }
  for (const field of fields) if (field === 'status' || field === 'type') indexes.set(field, aliasIndex());
  const aliases = new Set(projectAliases);
  const receipts = new Map<string, SourceImport>();
  const related = new Map<string, ReturnType<SourceRecordLookup>>();
  const findRelated = store.db.prepare(`SELECT json FROM source_records
    WHERE import_id=? AND product='jira' AND source_instance=? AND kind=? AND source_id=?
      AND json_extract(json,'$.packageSha256')=? LIMIT 2`);
  const findEarlierBinding = store.db.prepare(`SELECT 1 FROM source_records AS earlier
    JOIN source_imports AS receipt ON receipt.id=earlier.import_id
    WHERE earlier.target_type='issue' AND earlier.target_id=? AND earlier.kind='issue'
      AND earlier.product='jira' AND earlier.source_instance=? AND earlier.import_id<>?
      AND json_extract(earlier.json,'$.excluded') IS NOT 1
      AND julianday(json_extract(receipt.json,'$.createdAt'))<=julianday(?) LIMIT 1`);
  const issues = store.db.prepare(`SELECT r.json
    FROM issues AS issue CROSS JOIN source_records AS r
    JOIN source_bindings AS binding ON binding.product=r.product AND binding.source_instance=r.source_instance
      AND binding.kind='issue' AND binding.source_alias=r.source_id AND binding.target_type='issue' AND binding.target_id=issue.id
    WHERE issue.project_id=? AND r.target_type='issue' AND r.target_id=issue.id
      AND r.product='jira' AND r.source_instance=? AND r.kind='issue'`);
  for (const data of issues.iterate(projectId, instanceKey)) {
    const row = data as { json: string };
    const archive = JSON.parse(row.json) as SourceRecordArchive;
    if (archive.excluded || archive.targetProjectId !== projectId || !isOriginalProjectRecord(archive.record, aliases)) continue;
    const receiptId = archive.sourceImportId;
    const receipt = receipts.get(receiptId) ?? store.get<SourceImport>('source_imports', receiptId);
    if (!receipt?.projectIds.includes(projectId)) continue;
    receipts.set(receiptId, receipt);
    const pack = receipt.packages.find(item => item.sha256 === archive.packageSha256 && item.source.product === 'jira'
      && item.source.instanceKey === instanceKey && item.source.format === archive.source.format);
    if (!pack) continue;
    const append = receipt.configuration.appendTo;
    // An append in refresh mode can also create new issues. Receipt time keeps this proof stable after reordering a backup.
    const original = !archive.jiraIssueSourceFieldHashes && (!(append?.refreshExisting || append?.refreshCustomFields)
      || !findEarlierBinding.get(archive.targetId, instanceKey, receiptId, receipt.createdAt));
    const record: SourceRecordLookup = (kind, sourceId) => {
      const key = JSON.stringify([receiptId, pack.sha256, kind, sourceId]);
      if (!related.has(key)) {
        const candidates = findRelated.all(receiptId, instanceKey, kind, sourceId, pack.sha256) as { json: string }[];
        const found = candidates.length === 1 ? JSON.parse(candidates[0].json) as SourceRecordArchive : undefined;
        const summary = found && !found.excluded ? found.record : undefined;
        related.set(key, summary && { sourceId: summary.sourceId, title: summary.title, metadata: summary.metadata });
      }
      return related.get(key);
    };
    const source: JiraSavedViewSource = { archive, packageId: pack.stagingId, configuration: receipt.configuration, original, record,
      accepted: (field, targetId) => sourceFieldAccepted(archive, original, field, targetId) };
    for (const [field, index] of indexes) {
      const evidence = field === 'type' || field === 'status' ? fieldEvidence(source, field) : memberEvidence(source, field);
      if (evidence) indexEvidence(index, evidence);
    }
  }

  return (field, value) => {
    const index = indexes.get(field);
    if (!index) return undefined;
    const alias = value.toLowerCase();
    if (index.blockedAliases.has(alias)) return { kind: 'ambiguous' };
    const originals = index.sourcesByAlias.get(alias);
    if (!originals?.size) return undefined;
    if (originals.size !== 1) return { kind: 'ambiguous' };
    const [sourceId] = originals;
    const targets = index.targetsBySource.get(sourceId)!;
    if (targets.size !== 1) return { kind: 'ambiguous' };
    const [targetId] = targets;
    if (targetId === null) return { kind: 'unmapped' };
    if (index.sourcesByTarget.get(targetId)?.size !== 1) return { kind: 'ambiguous' };
    return { kind: 'mapped', sourceId, targetId };
  };
}
