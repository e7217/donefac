import { fieldApplies } from '../shared/issue-schema.js';
import type { JiraViewComponentField } from '../shared/jira-view-query.js';
import type { CustomFieldDefinition, LegacyRecord, ProjectIssueSchema, SourceImport, SourceRecordArchive } from '../shared/types.js';
import { JIRA_COMPONENTS_FIELD_ID, JIRA_RAW_COMPONENTS_FIELD_ID } from './legacy-import-jira-components.js';
import { jiraCustomRawField, jiraCustomValueDigest } from './migration-jira-fields.js';
import { migrationOptionId } from './migration-option-id.js';
import { importedCustomFieldId, importedCustomFieldOptionId } from './migration-planner.js';
import type { Store } from './store.js';

const numericId = /^[1-9][0-9]{0,19}$/u;
const labelOnlyId = /^label_[0-9a-f]{32}$/u;
const nameKey = (value: string) => value.normalize('NFC').toLowerCase();
const packageKey = (archive: SourceRecordArchive) => JSON.stringify([archive.sourceImportId, archive.packageSha256, archive.source.format]);
type ComponentPackageMapping = { projects: ReadonlySet<string>; options: ReadonlyMap<string, string>; append: boolean };

function projectReferences(record: LegacyRecord) {
  return record.references.filter(ref => ref.kind === 'project' && ref.relation === 'project').map(ref => ref.sourceId);
}

function index<T>(map: Map<string, Set<T>>, key: string, value: T) {
  const values = map.get(key) ?? new Set<T>();
  values.add(value);
  map.set(key, values);
}

function scopedComponentPackages(store: Store, projectId: string, instanceKey: string, projectAliases: readonly string[]) {
  const rows = store.db.prepare(`SELECT entry.json FROM source_records AS entry
    WHERE entry.product='jira' AND entry.source_instance=? AND entry.import_id IN (
      SELECT scope.import_id FROM source_records AS scope
      WHERE scope.target_type='project' AND scope.target_id=? AND scope.kind='project'
        AND scope.product='jira' AND scope.source_instance=?
    ) AND ((entry.kind='project' AND entry.target_type='project' AND entry.target_id=?)
      OR (entry.kind='field' AND entry.source_id=?)
      OR (entry.kind='option' AND (entry.source_id GLOB ? OR entry.source_id GLOB ?)))`)
    .iterate(instanceKey, projectId, instanceKey, projectId, JIRA_COMPONENTS_FIELD_ID,
      `${JIRA_COMPONENTS_FIELD_ID}:*`, `${JIRA_RAW_COMPONENTS_FIELD_ID}:*`);
  const allowed = new Set(projectAliases);
  const grouped = new Map<string, SourceRecordArchive[]>();
  for (const { json } of rows) {
    const archive = JSON.parse(String(json)) as SourceRecordArchive;
    const key = packageKey(archive);
    const archives = grouped.get(key) ?? [];
    archives.push(archive);
    grouped.set(key, archives);
  }

  const receipts = new Map<string, SourceImport | undefined>();
  return [...grouped].flatMap(([key, archives]) => {
    const declarations = archives.filter(({ record, excluded }) => record.kind === 'project' && !excluded &&
      record.metadata.jiraComponentProjectAmbiguous !== true && allowed.has(record.sourceId));
    const fieldRows = archives.filter(({ record }) => record.kind === 'field');
    if (!declarations.length || fieldRows.length !== 1 || fieldRows[0].excluded) return [];
    const sourceProjects = new Set(declarations.map(({ record }) => record.sourceId));
    const options = archives.filter(({ record }) => {
      if (record.kind !== 'option' || record.containerId !== JIRA_COMPONENTS_FIELD_ID) return false;
      const projects = projectReferences(record);
      return projects.length > 0 && projects.every(ref => sourceProjects.has(ref));
    });
    const excludedDefinitions = new Set(archives.filter(row => row.excluded).map(({ record }) => record.sourceId));
    const { sourceImportId, source, packageSha256 } = fieldRows[0];
    if (!receipts.has(sourceImportId)) receipts.set(sourceImportId, store.get<SourceImport>('source_imports', sourceImportId));
    const receipt = receipts.get(sourceImportId);
    const pack = receipt?.packages.find(pack => pack.sha256 === packageSha256 && pack.source.format === source.format &&
      pack.source.product === 'jira' && pack.source.instanceKey === instanceKey);
    if (!receipt?.projectIds.includes(projectId) || !pack) return [];
    const optionId = migrationOptionId(pack.stagingId, 'field', JIRA_COMPONENTS_FIELD_ID);
    const append = receipt.configuration.appendTo;
    const fieldId = append ? append.projectId === projectId && append.fields[optionId]
      : receipt.configuration.fields[optionId] === 'multi_select' && importedCustomFieldId(source, JIRA_COMPONENTS_FIELD_ID);
    return [{ key, sourceProjects, options, excludedDefinitions, fieldId, append: Boolean(append) }];
  });
}

function componentIssueEvidence(store: Store, projectId: string, instanceKey: string, field: CustomFieldDefinition,
  packages: ReadonlyMap<string, ComponentPackageMapping>) {
  const rows = store.db.prepare(`SELECT issue.id, archive.json
    FROM issues AS issue
    LEFT JOIN source_records AS archive ON archive.target_type='issue' AND archive.target_id=issue.id
      AND archive.product='jira' AND archive.source_instance=? AND archive.kind='issue'
    WHERE issue.project_id=? AND EXISTS (SELECT 1 FROM source_bindings AS origin
      WHERE origin.target_type='issue' AND origin.target_id=issue.id AND origin.product='jira' AND origin.kind='issue')`)
    .iterate(instanceKey, projectId);
  const imported = new Set<string>();
  const proven = new Set<string>();
  const provenAppendChoices = new Map<string, Set<string>>();
  const unresolvedAppendSources = new Set<string>();
  const emptyDigest = jiraCustomValueDigest(field, null);
  for (const { id, json } of rows) {
    const issueId = String(id);
    imported.add(issueId);
    if (json === null) continue;
    const archive = JSON.parse(String(json)) as SourceRecordArchive;
    const pack = packages.get(packageKey(archive));
    const checkpoint = archive.jiraCustomFieldHashes?.[field.id];
    const { record } = archive;
    if (archive.excluded || archive.targetProjectId !== projectId || !pack || !record.containerId || !pack.projects.has(record.containerId) ||
        projectReferences(record).some(project => !pack.projects.has(project))) continue;
    const raw = jiraCustomRawField(record, JIRA_COMPONENTS_FIELD_ID, true);
    const digest = checkpoint?.sourceFieldId === JIRA_COMPONENTS_FIELD_ID ? checkpoint.hash : undefined;
    if (raw === null && digest === emptyDigest) {
      proven.add(issueId);
    } else if (Array.isArray(raw) && raw.length) {
      const sourceIds = raw.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' ? [item.id] : []);
      const targets = sourceIds.map(sourceId => pack.options.get(sourceId));
      if (sourceIds.length === raw.length && targets.every(id => id !== undefined) && digest === jiraCustomValueDigest(field, targets)) {
        proven.add(issueId);
        if (pack.append) sourceIds.forEach((sourceId, indexInIssue) => index(provenAppendChoices, sourceId, targets[indexInIssue]));
      } else if (pack.append) {
        // An applied receipt may retain a conflicting snapshot or an earlier name-based mapping.
        for (const sourceId of sourceIds) unresolvedAppendSources.add(sourceId);
      }
    }
  }
  return { complete: imported.size === proven.size, provenAppendChoices, unresolvedAppendSources };
}

/** Resolve original scoped Jira values to the same choices that migration wrote. */
export function jiraSavedViewComponents(store: Store, schema: ProjectIssueSchema, instanceKey: string,
  projectAliases: readonly string[], onMatch: (sourceId: string, targetId: string) => void): JiraViewComponentField | undefined {
  const packages = scopedComponentPackages(store, schema.projectId, instanceKey, projectAliases);
  const mappings = new Set(packages.flatMap(pack => pack.fieldId ? [pack.fieldId] : []));
  if (mappings.size !== 1) return undefined;
  const [fieldId] = mappings;
  const field = schema.fields.find(field => field.id === fieldId && field.kind === 'multi_select');
  if (!field) return undefined;
  const choices = new Map(field.options.map(option => [option.id, option.name]));
  const idsByName = new Map<string, Set<string>>();
  const choicesById = new Map<string, Set<string>>();
  const idsByChoice = new Map<string, Set<string>>();
  const knownIds = new Set<string>();
  const coveragePackages = new Map<string, ComponentPackageMapping>();
  const addTarget = (sourceId: string, target: string) => {
    index(choicesById, sourceId, target);
    index(idsByChoice, target, sourceId);
  };
  let hasAppend = false;
  let sawLabelOnly = false;
  for (const pack of packages) {
    const mapped = new Map<string, string>();
    for (const { record, excluded } of pack.options) {
      const originalId = record.metadata.originalId;
      const labelOnly = record.metadata.jiraComponentLabelOnly === true;
      if (typeof originalId !== 'string' || !(labelOnly ? labelOnlyId : numericId).test(originalId) ||
          record.sourceId !== `${JIRA_COMPONENTS_FIELD_ID}:${originalId}` || !record.title.trim()) continue;
      index(idsByName, nameKey(record.title), originalId);
      knownIds.add(originalId);
      if (labelOnly) sawLabelOnly = true;
      if (pack.fieldId !== fieldId || excluded || record.references.some(ref => ref.kind === 'option' &&
        ref.relation === 'sourceDefinition' && pack.excludedDefinitions.has(ref.sourceId))) continue;
      const generated = importedCustomFieldOptionId(fieldId, originalId);
      const targets = (pack.append ? [generated, originalId] : [generated]).filter(id => choices.has(id));
      if (targets.length !== 1) continue;
      mapped.set(originalId, targets[0]);
      if (!pack.append) addTarget(originalId, targets[0]);
    }
    if (pack.fieldId === fieldId) {
      coveragePackages.set(pack.key, { projects: pack.sourceProjects, options: mapped, append: pack.append });
      hasAppend ||= pack.append;
    }
  }
  let evidence: ReturnType<typeof componentIssueEvidence> | undefined;
  const readEvidence = () => evidence ??= componentIssueEvidence(store, schema.projectId, instanceKey, field, coveragePackages);
  if (hasAppend) {
    for (const [sourceId, targets] of readEvidence().provenAppendChoices) {
      for (const target of targets) addTarget(sourceId, target);
    }
  }
  return {
    fieldId, name: field.name,
    get hasCompleteCoverage() { return schema.issueTypes.every(type => fieldApplies(field, type.id)) && readEvidence().complete; },
    resolve(value, quoted) {
      const asId = !quoted && numericId.test(value);
      const asKnownId = numericId.test(value) && knownIds.has(value);
      const sources = asId ? asKnownId && new Set([value]) : idsByName.get(nameKey(value));
      if (!sources || !sources.size) return { kind: 'unmapped' };
      if (sources.size !== 1 || asId && sawLabelOnly) return { kind: 'ambiguous' };
      const [sourceId] = sources;
      if (quoted && asKnownId && sourceId !== value) return { kind: 'ambiguous' };
      if (evidence?.unresolvedAppendSources.has(sourceId)) return { kind: 'unmapped' };
      const targets = choicesById.get(sourceId);
      if (!targets?.size) return { kind: 'unmapped' };
      const [targetId] = targets;
      if (targets.size !== 1 || idsByChoice.get(targetId)?.size !== 1) return { kind: 'ambiguous' };
      onMatch(sourceId, targetId);
      return { kind: 'mapped', targetId, label: choices.get(targetId)! };
    },
  };
}
