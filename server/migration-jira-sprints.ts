import { createHash } from 'node:crypto';
import { isCalendarDate } from '../shared/calendar.js';
import type { Issue, LegacyRecord, MigrationJiraPlanningChoice, PlanningItem, PlanningStatus } from '../shared/types.js';

interface SprintSource {
  record: LegacyRecord;
  recordId: string;
  instanceKey: string;
}

interface SprintIssue extends SprintSource {
  issue: Issue;
}

type SprintNotice = (recordId: string, code: string, message: string, severity?: 'warning' | 'error') => void;
type SprintState = 'future' | 'active' | 'closed';
interface SprintDefinition {
  title: string;
  state: SprintState;
  goal: string;
  start: string;
  end: string;
}

const prefix = 'builtin:sprints:';
const sprintStatuses = { future: 'planned', active: 'active', closed: 'completed' } satisfies Record<SprintState, PlanningStatus>;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function sprintId(value: unknown): string | null {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return null;
  return /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : null;
}
function state(value: unknown): SprintState | null {
  const normalized = text(value).toLowerCase();
  return normalized === 'future' || normalized === 'active' || normalized === 'closed' ? normalized : null;
}
function sprintKey(instanceKey: string, id: string): string {
  return JSON.stringify([instanceKey, id]);
}
function planningId(source: SprintIssue, id: string): string {
  return 'jira_sprint_' + createHash('sha256').update(JSON.stringify([source.instanceKey, id, source.issue.projectId])).digest('hex');
}
function canonicalName(value: unknown): string {
  const name = text(value).trim();
  return name && !/[\u0000-\u001f\u007f]/.test(name) ? name : '';
}

export function jiraSprintCatalogId(record: LegacyRecord): string | null {
  return record.kind === 'option' && record.sourceId.startsWith(prefix) ? sprintId(record.sourceId.slice(prefix.length)) : null;
}

function catalogDefinition(record: LegacyRecord): SprintDefinition | null {
  const title = canonicalName(record.title);
  const phase = state(record.metadata.state);
  if (!title || !phase || record.metadata.jiraSprintAmbiguous === true || record.metadata.jiraSprintNameMissing === true) return null;
  return { title, state: phase, goal: record.text, start: text(record.metadata.startdate), end: text(record.metadata.enddate) };
}

// A previously staged Agile response may only contain the original structured Sprint field.
function oldAgileSprint(record: LegacyRecord) {
  if (record.metadata.dialect !== 'rest-json') return undefined;
  const fields = object(record.metadata.fields);
  if (!Object.hasOwn(fields, 'sprint')) return undefined;
  if (fields.sprint === null) return { id: null, unresolved: false };
  const raw = object(fields.sprint);
  const id = sprintId(raw.id);
  const title = canonicalName(raw.name);
  const phase = state(raw.state);
  const definition = title && phase ? { title, state: phase, goal: text(raw.goal), start: text(raw.startDate), end: text(raw.endDate) } : undefined;
  return { id, unresolved: !id, definition };
}

function membership(record: LegacyRecord) {
  const previous = oldAgileSprint(record);
  const present = record.metadata.jiraCurrentSprintIds;
  const history = record.metadata.jiraSprintIds;
  const hasProjected = Array.isArray(present) || Array.isArray(history) || record.metadata.jiraSprintUnresolved === true;
  const current = Array.isArray(present) ? present.map(sprintId) : !hasProjected && previous ? (previous.id ? [previous.id] : []) : undefined;
  const ids = new Set((Array.isArray(history) ? history.map(sprintId) : []).filter((id): id is string => id !== null));
  for (const id of current ?? []) if (id) ids.add(id);
  const unresolved = current === undefined
    ? record.metadata.jiraSprintUnresolved === true || Array.isArray(history) && history.some(value => !sprintId(value))
    : record.metadata.jiraCurrentSprintUnresolved === true || current.includes(null) || !hasProjected && previous?.unresolved === true;
  return { ids: [...ids], current: current?.filter((id): id is string => id !== null), unresolved,
    fallback: !hasProjected && previous?.id && previous.definition ? { id: previous.id, definition: previous.definition } : null };
}

export function planJiraSprints(input: {
  catalog: readonly (SprintSource & { excluded: boolean })[];
  issues: readonly SprintIssue[];
  existing: readonly PlanningItem[];
  selections: Readonly<Record<string, string | null>>;
  now: string;
  calendarDate: (value: string) => string | null;
  notice: SprintNotice;
}) {
  const { catalog, issues, existing, selections, now, calendarDate, notice } = input;
  const observed = new Set<string>();
  const bySource = new Map<string, SprintDefinition>();
  const ambiguous = new Set<string>();
  function addDefinition(key: string, candidate: SprintDefinition | null) {
    observed.add(key);
    if (!candidate) return;
    const prior = bySource.get(key);
    if (!prior) { bySource.set(key, candidate); return; }
    for (const field of ['title', 'state', 'goal', 'start', 'end'] as const) {
      if (prior[field] && candidate[field] && prior[field] !== candidate[field]) ambiguous.add(key);
    }
    if (!ambiguous.has(key)) {
      bySource.set(key, { ...prior, goal: prior.goal || candidate.goal, start: prior.start || candidate.start, end: prior.end || candidate.end });
    }
  }
  for (const entry of catalog) {
    const id = jiraSprintCatalogId(entry.record);
    if (!id) continue;
    const key = sprintKey(entry.instanceKey, id);
    if (!entry.excluded && entry.record.metadata.jiraSprintAmbiguous === true) ambiguous.add(key);
    addDefinition(key, entry.excluded ? null : catalogDefinition(entry.record));
  }
  const catalogKeys = new Set(observed);
  const memberships = issues.map(source => ({ source, ...membership(source.record) }));
  for (const { source, fallback } of memberships) {
    if (!fallback) continue;
    const key = sprintKey(source.instanceKey, fallback.id);
    if (!catalogKeys.has(key)) addDefinition(key, fallback.definition);
  }
  const planningItems: PlanningItem[] = [];
  const destinationItems = new Map(existing.map(item => [item.id, item]));
  const usedNames = new Set(existing.map(item => JSON.stringify([item.projectId, item.name])));
  const planned = new Map<string, { source: SprintIssue; sourceId: string; definition: SprintDefinition }>();
  for (const { source, ids } of memberships) for (const sourceId of ids) {
    const key = sprintKey(source.instanceKey, sourceId);
    const definition = bySource.get(key);
    if (!definition || ambiguous.has(key)) continue;
    const id = planningId(source, sourceId);
    if (!destinationItems.has(id) && !planned.has(id)) planned.set(id, { source, sourceId, definition });
  }
  const sameNames = new Map<string, number>();
  for (const { source, definition } of planned.values()) {
    const key = JSON.stringify([source.issue.projectId, definition.title.slice(0, 120).trimEnd()]);
    sameNames.set(key, (sameNames.get(key) ?? 0) + 1);
  }
  for (const [id, { source, sourceId, definition }] of [...planned].sort(([a], [b]) => a.localeCompare(b))) {
    const { projectId } = source.issue;
    const fits = (candidate: string) => JSON.stringify([projectId, candidate]);
    let name = definition.title.slice(0, 120).trimEnd();
    if (usedNames.has(fits(name)) || (sameNames.get(fits(name)) ?? 0) > 1) {
      let suffix = ` (#${sourceId})`;
      name = definition.title.slice(0, 120 - suffix.length).trimEnd() + suffix;
      for (let index = 1; usedNames.has(fits(name)); index++) {
        suffix = ` (#${sourceId} · ${index + 1})`;
        name = definition.title.slice(0, 120 - suffix.length).trimEnd() + suffix;
      }
    }
    usedNames.add(fits(name));
    let startDate = definition.start ? calendarDate(definition.start) : null;
    let endDate = definition.end ? calendarDate(definition.end) : null;
    if (definition.start && !startDate || definition.end && !endDate || startDate && endDate && startDate > endDate) {
      notice(source.recordId, 'JIRA_SPRINT_DATES_UNAVAILABLE', '스프린트의 계획 기간을 확인할 수 없어 원본 날짜를 보관합니다.');
      if (startDate && endDate && startDate > endDate) { startDate = null; endDate = null; }
    }
    const item: PlanningItem = { id, projectId, kind: 'cycle', name, description: definition.goal.slice(0, 20_000),
      status: sprintStatuses[definition.state], ownerId: null, startDate: isCalendarDate(startDate) ? startDate : null,
      endDate: isCalendarDate(endDate) ? endDate : null, targetDate: null, createdAt: now, updatedAt: now, version: 1 };
    destinationItems.set(id, item);
    planningItems.push(item);
  }
  const choices: MigrationJiraPlanningChoice[] = [];
  let links = 0;
  let unassigned = 0;
  let historyOnly = 0;
  for (const { source, ids, current, unresolved } of memberships) {
    const { recordId, record, issue } = source;
    const reviewed = Object.hasOwn(selections, recordId);
    if (!ids.length && !unresolved && !reviewed) continue;
    const unavailable = (id: string) => ambiguous.has(sprintKey(source.instanceKey, id)) || !bySource.has(sprintKey(source.instanceKey, id));
    const considered = current ?? ids;
    const open = (id: string) => {
      const phase = bySource.get(sprintKey(source.instanceKey, id))?.state;
      return phase === 'active' || phase === 'future';
    };
    const openIds = considered.filter(open);
    const matching = current ? openIds : openIds.length ? openIds : considered;
    const candidates = matching.flatMap(sourceId => {
      const item = destinationItems.get(planningId(source, sourceId));
      return item && item.status !== 'archived' && !unavailable(sourceId) ? [{ sourceId, item }] : [];
    });
    const backlog = current?.length === 0 && !unresolved;
    const missing = considered.some(unavailable) || matching.length > candidates.length ||
      (current !== undefined && current.length !== openIds.length);
    const mayChoose = !backlog && (unresolved || missing || matching.length > 1 || reviewed);
    const selected = reviewed ? candidates.find(candidate => candidate.sourceId === selections[recordId])
      : !backlog && !mayChoose ? candidates[0] : undefined;
    if (mayChoose && candidates.length || reviewed) choices.push({
      recordId, sourceKey: text(record.metadata.key) || record.sourceId, title: issue.title,
      candidates: candidates.map(({ sourceId, item }) => ({ sourceId, name: item.name })), selected: selected?.sourceId ?? null,
    });
    if (reviewed && selections[recordId] !== null && !selected) {
      notice(recordId, 'JIRA_SPRINT_SELECTION_INVALID', '선택한 대표 사이클이 현재 업무의 연결 후보에 없습니다.', 'error');
    } else if (selected) {
      issue.cycleId = selected.item.id;
      issue.cycle = selected.item.name;
      links++;
      continue;
    } else if (backlog && ids.length) {
      historyOnly++;
      continue;
    } else if (!reviewed) {
      notice(recordId, candidates.length ? 'JIRA_SPRINT_REVIEW_REQUIRED' : 'JIRA_SPRINT_LINK_UNRESOLVED', candidates.length
        ? '현재 스프린트를 하나로 확인할 수 없습니다. 대표 사이클을 선택할 수 있습니다.'
        : '원본 스프린트와 현재 업무의 연결을 확인할 수 없어 원본을 보관합니다.');
    }
    unassigned++;
  }
  return { planningItems, choices, links, unassigned, historyOnly };
}
