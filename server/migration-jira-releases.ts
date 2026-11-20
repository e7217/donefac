import { createHash } from 'node:crypto';
import type { Issue, LegacyRecord, MigrationPreview, PlanningItem } from '../shared/types.js';

interface ReleaseSource {
  record: LegacyRecord;
  recordId: string;
  instanceKey: string;
  sourceProjectId: string;
  projectId: string;
  excluded?: boolean;
}

interface ReleaseIssue extends ReleaseSource {
  issue: Issue;
  administratorIds?: readonly string[];
}

interface ReleaseNotice {
  code: string;
  message: string;
  severity: 'warning' | 'error';
  recordId: string;
}

const versionPrefix = 'builtin:versions:';
const versionId = (value: unknown): string | null =>
  (typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value) && value > 0) &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(String(value)) ? String(value) : null;
const details = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const truth = (value: unknown) => [true, 'true', 'Y', '1'].includes(value as string | boolean);
const text = (value: unknown) => typeof value === 'string' ? value : '';

export function jiraReleaseVersionId(row: LegacyRecord): string | null {
  return row.kind === 'option' && row.sourceId.startsWith(versionPrefix) ? versionId(row.sourceId.slice(versionPrefix.length)) : null;
}

export function jiraAdministratorFixAssociation(row: LegacyRecord): { issueId: string; versionId: string } | null {
  if (row.kind !== 'relation' || row.metadata.associationType !== 'IssueFixVersion' ||
      row.metadata.sourceNodeEntity !== 'Issue' || !['Version', 'ProjectVersion'].includes(text(row.metadata.sinkNodeEntity ?? row.metadata.destNodeEntity))) return null;
  const source = row.references.find(ref => ref.kind === 'issue' && ref.relation === 'source');
  const target = row.references.find(ref => ref.kind === 'option' && ref.relation === 'target');
  const id = versionId(target?.sourceId.replace(/^builtin:versions:/, ''));
  return source && id ? { issueId: source.sourceId, versionId: id } : null;
}

function originalIssueVersions(record: LegacyRecord): unknown[] {
  const fields = details(record.metadata.fields);
  const raw = fields.fixVersions ?? fields.fixedVersions ?? fields.fixVersion ?? fields['Fix Version/s'];
  return raw == null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
}

function references(source: ReleaseIssue): { ids: string[]; unresolved: boolean } {
  const normalized = source.record.metadata.jiraFixVersionIds;
  const unresolved = source.record.metadata.jiraFixVersionUnresolved === true;
  const declared = Array.isArray(normalized) ? normalized : undefined;
  let observed: readonly unknown[];
  if (source.administratorIds && declared) {
    const proven = new Set(declared);
    observed = source.administratorIds.filter(id => proven.has(id));
  } else if (source.administratorIds) {
    observed = unresolved ? [] : source.administratorIds;
  } else {
    observed = declared ?? originalIssueVersions(source.record).map(value => details(value).id);
  }
  const ids = [...new Set(observed.map(versionId).filter((id): id is string => id !== null))];
  return { ids, unresolved: unresolved || observed.some(id => !versionId(id)) };
}

function identity(source: ReleaseSource, id: string): string {
  return 'jira_release_' + createHash('sha256').update(JSON.stringify([source.instanceKey, id, source.projectId])).digest('hex');
}

function claimedProject(source: ReleaseSource, value: unknown): boolean {
  if (value == null) return true;
  const project = details(value);
  return versionId(project.id ?? project.key ?? value) === source.sourceProjectId;
}

function originalVersion(source: ReleaseIssue, id: string): LegacyRecord | undefined {
  // Older staged REST or RSS packages do not yet have standalone version records.
  const raw = originalIssueVersions(source.record).map(details).find(value => versionId(value.id) === id);
  const name = text(raw?.name ?? raw?.text);
  if (!raw || !name || !claimedProject(source, raw.projectId ?? raw.project)) return undefined;
  return { ...source.record, kind: 'option', sourceId: versionPrefix + id, title: name, text: text(raw.description), metadata: {
    archived: raw.archived === true, released: raw.released === true,
    startdate: text(raw.startDate), releasedate: text(raw.releaseDate),
  } };
}

export function planJiraReleases(input: {
  catalog: readonly ReleaseSource[];
  issues: readonly ReleaseIssue[];
  existing: readonly PlanningItem[];
  selections: Readonly<Record<string, string | null>>;
  append: boolean;
  now: string;
  calendarDate: (value: string) => string | null;
  notice: (notice: ReleaseNotice) => void;
}) {
  const { catalog, issues, existing, selections, append, now, calendarDate, notice } = input;
  const warn = (recordId: string, code: string, message: string) => notice({ code, message, recordId, severity: 'warning' });
  const wanted = new Set<string>();
  const memberships = issues.map(source => {
    const { ids, unresolved } = references(source);
    for (const id of ids) wanted.add(identity(source, id));
    return { source, ids, unresolved };
  });
  const byId = new Map(existing.map(item => [item.id, item]));
  const reserved = new Set(existing.map(item => JSON.stringify([item.projectId, item.name])));
  const observed = new Set<string>();
  const proposed = new Map<string, { item: PlanningItem; source: ReleaseSource }>();
  const invalid = new Set<string>();
  const scoped = new Set<string>();
  const scope = (source: ReleaseSource, id: string) => JSON.stringify([source.instanceKey, source.projectId, source.sourceProjectId, id]);
  function add(source: ReleaseSource, id: string) {
    const { record, recordId, projectId } = source;
    const key = identity(source, id);
    observed.add(key);
    if (source.excluded || record.metadata.jiraVersionAmbiguous === true) return;
    scoped.add(scope(source, id));
    if (append && !wanted.has(key) || byId.has(key)) return;
    const name = record.title.trim();
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name) ||
        record.metadata.jiraVersionNameMissing === true) {
      invalid.add(key);
      warn(recordId, 'JIRA_RELEASE_DEFINITION_UNRESOLVED', 'Jira 릴리스 이름이나 정의를 확인할 수 없어 원본을 보관합니다.');
      return;
    }
    const date = (raw: unknown, name: string) => {
      const value = text(raw).trim();
      if (!value) return null;
      const day = calendarDate(value);
      if (!day) warn(recordId, 'JIRA_RELEASE_DATE_UNRESOLVED', `Jira 릴리스의 ${name}을 확인할 수 없어 날짜 원본을 보관합니다.`);
      return day;
    };
    const item: PlanningItem = {
      id: key, projectId, kind: 'release', name, description: record.text.slice(0, 20_000),
      status: truth(record.metadata.archived) ? 'archived' : truth(record.metadata.released) ? 'completed' : 'planned',
      ownerId: null, startDate: date(record.metadata.startdate, '시작일'), endDate: null,
      targetDate: date(record.metadata.releasedate, '목표일'), createdAt: now, updatedAt: now, version: 1,
    };
    const prior = proposed.get(key);
    if (prior && (prior.source.sourceProjectId !== source.sourceProjectId || JSON.stringify(prior.item) !== JSON.stringify(item))) {
      invalid.add(key);
      warn(recordId, 'JIRA_RELEASE_DEFINITION_UNRESOLVED', '같은 Jira 릴리스 ID의 서로 다른 정의를 찾았습니다. 원본을 보관합니다.');
    }
    if (!prior) proposed.set(key, { item, source });
  }
  for (const source of catalog) {
    const id = jiraReleaseVersionId(source.record);
    if (id) add(source, id);
  }
  const evidence = new Set(observed);
  for (const { source, ids, unresolved } of memberships) {
    if (unresolved) continue;
    for (const id of ids) if (!evidence.has(identity(source, id))) {
      const record = originalVersion(source, id);
      if (record) add({ ...source, record }, id);
    }
  }
  const proposedNames = new Map<string, number>();
  for (const { item } of proposed.values()) {
    if (invalid.has(item.id)) continue;
    const key = JSON.stringify([item.projectId, item.name]);
    proposedNames.set(key, (proposedNames.get(key) ?? 0) + 1);
  }
  const planningItems: PlanningItem[] = [];
  for (const { item, source } of proposed.values()) {
    if (invalid.has(item.id)) continue;
    const name = JSON.stringify([item.projectId, item.name]);
    if (reserved.has(name) || (proposedNames.get(name) ?? 0) > 1) {
      warn(source.recordId, 'JIRA_RELEASE_NAME_CONFLICT', '대상 프로젝트에 같은 이름의 다른 릴리스가 있어 원본을 보관합니다.');
      continue;
    }
    byId.set(item.id, item);
    planningItems.push(item);
  }
  const existingIds = new Set(existing.map(item => item.id));
  const choices: NonNullable<MigrationPreview['jiraReleaseChoices']> = [];
  let links = 0, unassigned = 0;
  for (const { source, ids, unresolved } of memberships) {
    const { recordId, issue } = source;
    const reviewed = Object.hasOwn(selections, recordId);
    if (!ids.length && !unresolved && !reviewed) continue;
    const candidates = ids.flatMap(sourceId => {
      const item = byId.get(identity(source, sourceId));
      return item && scoped.has(scope(source, sourceId)) && (!existingIds.has(item.id) || item.status !== 'archived') ? [{ sourceId, item }] : [];
    });
    const multiple = ids.length > 1 || unresolved;
    const selected = reviewed ? candidates.find(candidate => candidate.sourceId === selections[recordId]) : multiple ? undefined : candidates[0];
    if ((multiple || reviewed) && (candidates.length || reviewed)) choices.push({
      recordId, title: issue.title, sourceKey: text(source.record.metadata.key) || source.record.sourceId,
      candidates: candidates.map(({ sourceId, item }) => ({ sourceId, name: item.name })), selected: selected?.sourceId ?? null,
    });
    if (reviewed && selections[recordId] !== null && !selected) {
      notice({ recordId, code: 'JIRA_RELEASE_SELECTION_INVALID', message: '선택한 대표 릴리스가 현재 업무의 연결 후보에 없습니다.', severity: 'error' });
    } else if (selected) {
      issue.releaseId = selected.item.id;
      issue.release = selected.item.name;
      links++;
      continue;
    } else if (!reviewed) {
      const choice = multiple && candidates.length > 0;
      warn(recordId, choice ? 'JIRA_RELEASE_REVIEW_REQUIRED' : 'JIRA_RELEASE_LINK_UNRESOLVED',
        choice ? '원본 수정 버전이 여러 개이거나 일부를 확인할 수 없습니다. 대표 릴리스를 선택할 수 있습니다.' :
          '원본 수정 버전과 현재 프로젝트의 릴리스 연결을 확인할 수 없어 원본을 보관합니다.');
    }
    unassigned++;
  }
  return { planningItems, choices, links, unassigned };
}
