import { createHash } from 'node:crypto';
import type { LegacyDataset, LegacyRecord, LegacyValue } from '../shared/types.js';
import { addRecord, diagnostic, record } from './legacy-import-model.js';

export const JIRA_COMPONENTS_FIELD_ID = 'jira:components';
export const JIRA_RAW_COMPONENTS_FIELD_ID = 'builtin:components';
const componentIdPattern = /^[1-9][0-9]{0,19}$/;
const projectKeyPattern = /^[A-Z][A-Z0-9_]{0,199}$/;
type LegacyObject = Record<string, LegacyValue>;
type ProjectScope = { id: string; identity: string; key?: string };
type ComponentEvidence = {
  id: string;
  name: string;
  project: ProjectScope;
  labelOnly?: true;
  definitionSourceId?: string;
  membershipSourceId?: string;
};

function stableId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && componentIdPattern.test(id) ? id : undefined;
}

function projectKey(value: unknown): string | undefined {
  return typeof value === 'string' && projectKeyPattern.test(value) ? value : undefined;
}

function componentName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().normalize('NFC');
  return name && name.length <= 500 && name.isWellFormed() && !/\p{Cc}/u.test(name) ? name : undefined;
}

function object(value: unknown): LegacyObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as LegacyObject : undefined;
}

function csvProjectEvidence(fields: LegacyObject, label: string): LegacyValue | undefined {
  const entries = Object.entries(fields).filter(([name]) => name.toLowerCase() === label);
  return entries.length > 1 ? entries.map(([, value]) => value) : entries[0]?.[1];
}

function projectReferences(record: LegacyRecord): string[] {
  return [...new Set(record.references.filter(ref => ref.kind === 'project' && ref.relation === 'project')
    .map(ref => ref.sourceId))];
}

function projectScopes(projects: LegacyRecord[]): Map<string, ProjectScope> {
  const keysById = new Map<string, string>();
  const idsByKey = new Map<string, Set<string>>();
  for (const row of projects) {
    if (row.metadata.jiraComponentProjectAmbiguous === true) continue;
    const keys = [...new Set([row.metadata.key, row.metadata.pkey].filter(value => value !== undefined && value !== ''))];
    const key = keys.length === 1 ? projectKey(keys[0]) : keys.length === 0 ? projectKey(row.sourceId) : undefined;
    if (!key) continue;
    keysById.set(row.sourceId, key);
    if (!stableId(row.sourceId)) continue;
    const ids = idsByKey.get(key) ?? new Set();
    ids.add(row.sourceId);
    idsByKey.set(key, ids);
  }
  const scopes = new Map<string, ProjectScope>();
  for (const row of projects) {
    if (row.metadata.jiraComponentProjectAmbiguous === true) continue;
    const id = row.sourceId;
    const key = keysById.get(id);
    const aliases = key ? idsByKey.get(key) : undefined;
    const numericId = stableId(id);
    if (aliases && aliases.size > 1) {
      if (numericId) scopes.set(id, { id, identity: numericId });
    } else if (numericId || key && key === id) {
      scopes.set(id, { id, identity: numericId ?? (aliases?.values().next().value ?? id), key });
    }
  }
  return scopes;
}

function issueProject(issue: LegacyRecord, projects: Map<string, ProjectScope>): ProjectScope | undefined {
  const [ref, ...others] = projectReferences(issue);
  if (!ref || others.length || ref !== issue.containerId || issue.metadata.jiraComponentProjectAmbiguous === true) return;
  const project = projects.get(ref);
  const key = typeof issue.metadata.key === 'string' ? /^(.*)-[0-9]+$/.exec(issue.metadata.key)?.[1] : undefined;
  if (!project || project.key && key && key !== project.key) return;
  return project;
}

function sourceProjectMatches(value: LegacyValue, scope: ProjectScope, projects: Map<string, ProjectScope>): boolean {
  const id = stableId(value) ?? projectKey(value);
  return Boolean(id && (id === scope.id || id === scope.identity || id === scope.key ||
    projects.get(id)?.identity === scope.identity));
}

/** Add the actionable field alongside preserved Jira source records, including already-staged packages. */
export function projectJiraComponents(dataset: LegacyDataset): void {
  if (dataset.source.product !== 'jira' || dataset.records.some(row => row.id === `field:${JIRA_COMPONENTS_FIELD_ID}`)) return;
  const projects = projectScopes(dataset.records.filter(row => row.kind === 'project'));
  const issues = new Map(dataset.records.filter(row => row.kind === 'issue').map(row => [row.sourceId, row]));
  const scopes = new Map([...issues].map(([id, row]) => [id, issueProject(row, projects)]));
  const csvProjectIds = new Map<string, Set<string>>();
  for (const issue of issues.values()) {
    if (issue.metadata.dialect !== 'search-csv') continue;
    const scope = scopes.get(issue.sourceId);
    const fields = object(issue.metadata.fields);
    const explicit = stableId(fields && csvProjectEvidence(fields, 'project id')) ?? stableId(scope?.identity);
    if (!scope?.key || !explicit) continue;
    const ids = csvProjectIds.get(scope.key) ?? new Set();
    ids.add(explicit);
    csvProjectIds.set(scope.key, ids);
  }
  const owners = new Map<string, Set<string>>();
  const definitions = new Map<string, ComponentEvidence>();
  const invalidDefinitions = new Set<string>();
  const memberships = new Map<LegacyRecord, ComponentEvidence[]>();
  const unresolved = new Set([...issues.values()].filter(row => row.metadata.jiraComponentAssociationAmbiguous === true));
  const clears = new Set<LegacyRecord>();
  let omittedDiagnostics = 0;
  const warn = (row: LegacyRecord) => {
    if (omittedDiagnostics++ >= 100) return;
    diagnostic(dataset, { severity: 'warning', code: 'JIRA_COMPONENT_EVIDENCE_UNRESOLVED',
      message: 'Jira 컴포넌트의 원본 ID·이름·프로젝트 관계를 확인하지 못해 Donefac 필드로 변환하지 않았습니다.',
      recordId: row.id });
  };
  const observe = (evidence: ComponentEvidence) => {
    const known = owners.get(evidence.id) ?? new Set();
    known.add(evidence.project.identity);
    owners.set(evidence.id, known);
  };

  for (const row of dataset.records) {
    if (row.kind !== 'option' || row.containerId !== JIRA_RAW_COMPONENTS_FIELD_ID) continue;
    const id = stableId(row.metadata.id);
    const name = componentName(row.title);
    const owner = stableId(row.metadata.project) ?? projectKey(row.metadata.project);
    const project = owner && projects.get(owner);
    const [ref, ...others] = projectReferences(row);
    const evidenceId = stableId(row.sourceId.slice(JIRA_RAW_COMPONENTS_FIELD_ID.length + 1));
    if (!id || !name || name === id && componentName(row.metadata.cname || row.metadata.name) !== name ||
        row.sourceId !== `${JIRA_RAW_COMPONENTS_FIELD_ID}:${id}` ||
        !project || ref !== owner || others.length || row.metadata.jiraComponentDefinitionAmbiguous === true) {
      if (evidenceId) invalidDefinitions.add(evidenceId);
      warn(row);
      continue;
    }
    const evidence = { id, name, project, definitionSourceId: row.sourceId };
    observe(evidence);
    definitions.set(id, evidence);
  }

  for (const row of dataset.records) {
    if (row.kind !== 'relation' || row.metadata.associationType !== 'IssueComponent') continue;
    const sources = row.references.filter(ref => ref.kind === 'issue' && ref.relation === 'source');
    const targets = row.references.filter(ref => ref.kind === 'option' && ref.relation === 'target');
    const [source] = sources;
    const issue = source && issues.get(source.sourceId);
    const project = source && scopes.get(source.sourceId);
    const id = stableId(targets[0]?.sourceId.slice(JIRA_RAW_COMPONENTS_FIELD_ID.length + 1));
    const definition = id && definitions.get(id);
    const entities = [row.metadata.sinkNodeEntity, row.metadata.destNodeEntity].filter(value => value !== undefined);
    const issueSource = row.metadata.sourceNodeEntity === 'Issue';
    const linkIdsMatch = (row.metadata.sourceNodeId === undefined || row.metadata.sourceNodeId === source?.sourceId) &&
      [row.metadata.sinkNodeId, row.metadata.destNodeId].every(value => value === undefined || value === id);
    const exactLink = issueSource && sources.length === 1 && targets.length === 1 && id && linkIdsMatch &&
      targets[0].sourceId === `${JIRA_RAW_COMPONENTS_FIELD_ID}:${id}` &&
      row.sourceId === `association:${source.sourceId}:Component:${id}:IssueComponent` &&
      entities.length && entities.every(entity => entity === 'Component') && row.metadata.jiraComponentAssociationAmbiguous !== true;
    if (!issue || !project || !exactLink || !definition || definition.project.identity !== project.identity) {
      if (issue && issueSource) unresolved.add(issue);
      else warn(row);
      continue;
    }
    const existing = memberships.get(issue) ?? [];
    existing.push({ ...definition, project, membershipSourceId: row.sourceId });
    memberships.set(issue, existing);
  }

  for (const issue of issues.values()) {
    const fields = object(issue.metadata.fields);
    if (!fields) continue;
    const rest = issue.metadata.dialect === 'rest-json';
    const csv = issue.metadata.dialect === 'search-csv';
    const rss = issue.metadata.dialect === 'rss-search-xml';
    const raw = rest ? fields.components : rss ? fields.component : csv ? Object.entries(fields)
      .filter(([name]) => /^Component\/s$/i.test(name)).flatMap(([, value]) => Array.isArray(value) ? value : [value]) : undefined;
    if (raw === undefined || csv && Array.isArray(raw) && !raw.length) continue;
    const project = scopes.get(issue.sourceId);
    const csvProjectId = csv ? csvProjectEvidence(fields, 'project id') : undefined;
    const csvProjectKey = csv ? csvProjectEvidence(fields, 'project key') : undefined;
    if (!project || !Array.isArray(raw) || csv && (!project.key || issue.metadata.jiraComponentCsvAmbiguous === true ||
        (csvProjectIds.get(project.key)?.size ?? 0) > 1 ||
        csvProjectId !== undefined && (!stableId(csvProjectId) || stableId(project.identity) && csvProjectId !== project.identity) ||
        csvProjectKey !== undefined && csvProjectKey !== project.key) ||
        rss && issue.metadata.jiraComponentRssAmbiguous === true) {
      unresolved.add(issue);
      continue;
    }
    if (rest && raw.length === 0) {
      clears.add(issue);
      continue;
    }
    const components: ComponentEvidence[] = [];
    for (const entry of raw) {
      const value = object(entry);
      const name = componentName(csv ? entry : rss ? value?.text : value?.name);
      const id = csv && name ? `label_${createHash('sha256').update(JSON.stringify([project.key, name])).digest('hex').slice(0, 32)}`
        : stableId(value?.id);
      if (!id || !name || value && [value.project, value.projectId].some(owner => owner !== undefined &&
          !sourceProjectMatches(owner, project, projects))) break;
      components.push({ id, name, project, ...(csv && { labelOnly: true }) });
    }
    if (components.length !== raw.length) unresolved.add(issue);
    else if (components.length) {
      for (const evidence of components) observe(evidence);
      memberships.set(issue, components);
    }
  }

  const options = new Map<string, { evidence: ComponentEvidence; projects: Set<string> }>();
  const valid = (evidence: ComponentEvidence) => !invalidDefinitions.has(evidence.id) && owners.get(evidence.id)?.size === 1;
  const include = (evidence: ComponentEvidence) => {
    const option = options.get(evidence.id);
    if (option) option.projects.add(evidence.project.id);
    else options.set(evidence.id, { evidence, projects: new Set([evidence.project.id]) });
  };
  for (const evidence of definitions.values()) if (valid(evidence)) include(evidence);
  for (const [issue, components] of memberships) {
    if (!components.every(valid)) unresolved.add(issue);
    if (unresolved.has(issue)) continue;
    const fields = object(issue.metadata.fields);
    if (!fields) continue;
    for (const evidence of components) include(evidence);
    fields[JIRA_COMPONENTS_FIELD_ID] = [...new Set(components.map(evidence => evidence.id))]
      .map(id => ({ id, name: options.get(id)!.evidence.name }));
    for (const { membershipSourceId } of components) {
      if (membershipSourceId) issue.references.push({ kind: 'relation', sourceId: membershipSourceId, relation: 'jiraComponentMembership' });
    }
  }
  for (const issue of clears) {
    if (unresolved.has(issue)) continue;
    const snapshot = issue.metadata.jiraSnapshotCustomFields;
    issue.metadata.jiraSnapshotCustomFields = [...new Set([...(Array.isArray(snapshot) ? snapshot : []), JIRA_COMPONENTS_FIELD_ID])];
  }
  for (const issue of unresolved) warn(issue);
  if (omittedDiagnostics > 100) {
    diagnostic(dataset, { severity: 'warning', code: 'JIRA_COMPONENT_EVIDENCE_ADDITIONAL',
      message: `컴포넌트 원본 증거를 확인하지 못한 항목이 ${omittedDiagnostics - 100}개 더 있습니다.` });
  }
  if (!options.size && !clears.size) return;
  addRecord(dataset, record('field', JIRA_COMPONENTS_FIELD_ID, {
    title: 'Jira 컴포넌트', metadata: { fieldType: 'multi_select' },
  }));
  for (const { evidence, projects: scopes } of options.values()) {
    addRecord(dataset, record('option', `${JIRA_COMPONENTS_FIELD_ID}:${evidence.id}`, {
      title: evidence.name, containerId: JIRA_COMPONENTS_FIELD_ID,
      metadata: { originalId: evidence.id, ...(evidence.labelOnly && { jiraComponentLabelOnly: true }) },
      references: [{ kind: 'field', sourceId: JIRA_COMPONENTS_FIELD_ID, relation: 'field' },
        ...(evidence.definitionSourceId ? [{ kind: 'option' as const, sourceId: evidence.definitionSourceId, relation: 'sourceDefinition' }] : []),
        ...[...scopes].map(sourceId => ({ kind: 'project' as const, sourceId, relation: 'project' }))],
    }));
  }
  if ([...options.values()].some(({ evidence }) => evidence.labelOnly)) {
    diagnostic(dataset, { severity: 'warning', code: 'JIRA_COMPONENT_LABEL_ONLY',
      message: 'CSV에 컴포넌트 원본 ID가 없어 같은 프로젝트의 동일한 이름만 같은 선택지로 이관합니다.' });
  }
}
