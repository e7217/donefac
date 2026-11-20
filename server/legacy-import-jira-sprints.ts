import { isCalendarDate } from '../shared/calendar.js';
import type { LegacyDataset, LegacyRecord, LegacyValue } from '../shared/types.js';
import type { LegacyXmlNode } from './legacy-import-archive.js';
import { addRecord, record } from './legacy-import-model.js';

// https://support.atlassian.com/jira/kb/how-to-update-the-dates-of-a-closed-sprint-in-jira/
// https://support.atlassian.com/jira/kb/project-import-fails-with-numberformatexception-in-jira-server-data-center/
// https://developer.atlassian.com/server/jira/platform/rest/v10000/api-group-issue/
// https://developer.atlassian.com/cloud/jira/software/rest/intro/#sprint-custom-field
export const JIRA_SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';
const sprintFieldId = 'builtin:sprints';
const sprintOptionId = (id: string) => `${sprintFieldId}:${id}`;

type SprintState = 'future' | 'active' | 'closed';
type Definition = {
  id: string;
  name?: string;
  state?: SprintState;
  boardId?: string;
  goal?: string;
  startdate?: string;
  enddate?: string;
  completeDate?: string;
  activatedDate?: string;
  invalidDates?: true;
};
type Diagnostic = (code: string, message: string, recordId: string | null, path: string | null) => void;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function id(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value === '<null>' || !value.trim() || value.length > limit) return undefined;
  return value;
}
function state(value: unknown): SprintState | undefined {
  const normalized = typeof value === 'string' ? value.toLowerCase() : undefined;
  return normalized === 'future' || normalized === 'active' || normalized === 'closed' ? normalized : undefined;
}
function bool(value: unknown): boolean | undefined {
  if (/^(?:true|1|t)$/i.test(String(value))) return true;
  if (/^(?:false|0|f)$/i.test(String(value))) return false;
}
function date(value: unknown, epoch = false): string | undefined {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (epoch && /^\d{10}(?:\d{3})?$/.test(raw)) {
    const millis = Number(raw) * (raw.length === 10 ? 1000 : 1);
    return new Date(millis).toISOString();
  }
  if (raw.length === 10 && isCalendarDate(raw)) return raw;
  if (!isCalendarDate(raw.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ||
      !Number.isFinite(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}
function legacySprint(value: string): Record<string, unknown> | undefined {
  const body = /^com\.atlassian\.greenhopper\.service\.sprint\.Sprint@[a-f\d]+\[([^\r\n]*)\]$/i.exec(value)?.[1];
  if (!body || !body.startsWith('id=') || body.length > 24_000) return undefined;
  const keys = new Set(['id', 'rapidViewId', 'state', 'name', 'goal', 'startDate', 'endDate', 'completeDate', 'activatedDate',
    'createdDate', 'sequence', 'synced', 'autoStartStop', 'incompleteIssuesDestinationId']);
  const result: Record<string, unknown> = Object.create(null);
  for (const field of body.split(/,(?=[a-z]\w*=)/i)) {
    const equals = field.indexOf('=');
    const key = field.slice(0, equals);
    if (equals < 1 || !keys.has(key) || Object.hasOwn(result, key)) return undefined;
    result[key] = field.slice(equals + 1);
  }
  return result;
}
function definition(values: Record<string, unknown>, epoch = false): Definition | undefined {
  const sprintId = id(values.id);
  if (!sprintId) return undefined;
  const day = (key: string) => date(values[key], epoch);
  const startdate = day('startDate'), enddate = day('endDate'), completeDate = day('completeDate'), activatedDate = day('activatedDate');
  const invalidDates = ([['startDate', startdate], ['endDate', enddate], ['completeDate', completeDate], ['activatedDate', activatedDate]] as const)
    .some(([key, parsed]) => !parsed && values[key] !== null && values[key] !== undefined && values[key] !== '' && values[key] !== '<null>');
  return { id: sprintId, name: text(values.name, 2000), state: state(values.state), boardId: id(values.originBoardId ?? values.rapidViewId),
    goal: text(values.goal, 20_000), startdate, enddate, completeDate, activatedDate, ...(invalidDates ? { invalidDates: true } : {}) };
}

export class JiraSprintProjection {
  private readonly definitions = new Map<string, Definition>();
  private readonly ambiguous = new Set<string>();

  constructor(private readonly warn: Diagnostic) {}

  private declare(next: Definition) {
    const previous = this.definitions.get(next.id);
    if (!previous) { this.definitions.set(next.id, next); return; }
    for (const key of ['name', 'state', 'boardId', 'goal', 'startdate', 'enddate', 'completeDate', 'activatedDate'] as const) {
      const old = previous[key], value = next[key];
      if (old !== undefined && value !== undefined && old !== value) this.ambiguous.add(next.id);
    }
    for (const [key, value] of Object.entries(next)) if (value !== undefined) Object.assign(previous, { [key]: value });
  }

  readActiveObjects(node: LegacyXmlNode, path: string): boolean {
    if (node.name !== 'data' || node.attributes.tableName !== 'AO_60DB71_SPRINT') return false;
    const columns = node.children.filter(child => child.name === 'column').map(child => child.attributes.name);
    const fail = () => this.warn('JIRA_SPRINT_TABLE_UNRESOLVED', '스프린트 테이블의 열 또는 행을 확인할 수 없어 일부 원본을 보류했습니다.', null, path);
    if (columns.some(column => !column) || new Set(columns).size !== columns.length || !columns.includes('ID') || !columns.includes('NAME')) {
      fail(); return true;
    }
    const indexes = new Map(columns.map((name, position) => [name, position]));
    for (const row of node.children.filter(child => child.name === 'row')) {
      if (row.children.length !== columns.length || row.text.trim() || row.children.some(cell => cell.children.length)) {
        fail(); continue;
      }
      const get = (name: string) => {
        const position = indexes.get(name);
        const cell = position === undefined ? undefined : row.children[position];
        return cell?.attributes['xsi:nil'] === 'true' ? undefined : cell?.text;
      };
      const started = bool(get('STARTED')), closed = bool(get('CLOSED'));
      const sprint = definition({ id: get('ID'), name: get('NAME'),
        state: closed === true ? 'closed' : closed === false && started !== undefined ? started ? 'active' : 'future' : undefined,
        startDate: get('START_DATE'), endDate: get('END_DATE'), completeDate: get('COMPLETE_DATE'), activatedDate: get('ACTIVATED_DATE'),
        rapidViewId: get('RAPID_VIEW_ID'), goal: get('GOAL') }, true);
      if (sprint) this.declare(sprint);
      else fail();
    }
    return true;
  }

  apply(dataset: LegacyDataset): void {
    const sprintFields = new Set(dataset.records.filter(row => row.kind === 'field' &&
      (row.metadata.fieldType ?? row.metadata.customfieldtypekey ?? row.metadata.fieldtype) === JIRA_SPRINT_FIELD_TYPE &&
      row.metadata.jiraSprintFieldAmbiguous !== true).map(row => row.sourceId));
    const ambiguousFields = new Set(dataset.records.filter(row => row.kind === 'field' && row.metadata.jiraSprintFieldAmbiguous === true).map(row => row.sourceId));
    const referenced = new Set<string>();
    const memberships: Array<{ issue: LegacyRecord; candidates: Set<string> }> = [];
    for (const issue of dataset.records) {
      if (issue.kind !== 'issue') continue;
      const fields = object(issue.metadata.fields);
      const candidates = new Set<string>();
      const current = new Set<string>();
      let unresolved = issue.metadata.jiraSprintUnresolved === true, currentUnresolved = false;
      const add = (raw: unknown, role: 'current' | 'closed' | 'unknown') => {
        const fail = () => { unresolved = true; if (role !== 'closed') currentUnresolved = true; };
        if (role === 'closed' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) { fail(); return; }
        const sprintId = id(raw);
        const values = typeof raw === 'string' && !sprintId ? legacySprint(raw) : object(raw);
        const administrative = dataset.source.format === 'jira-backup-xml';
        const observed = administrative ? [values?.stringvalue, values?.numbervalue, values?.textvalue]
          .filter(value => value !== null && value !== undefined && value !== '') : [];
        const sourceIds = [...new Set(observed.map(id))];
        if (sourceIds.length > 1) { fail(); return; }
        const [referenceId] = sourceIds;
        const sprint = referenceId || sprintId ? { id: referenceId ?? sprintId! } : values && definition(values);
        if (!sprint) { fail(); return; }
        if (role === 'current' && sprint.state === 'closed') { unresolved = true; currentUnresolved = true; }
        else if (role === 'closed' && sprint.state && sprint.state !== 'closed') { fail(); return; }
        else if (role === 'current') current.add(sprint.id);
        if (role === 'closed' && !sprint.state) sprint.state = 'closed';
        candidates.add(sprint.id);
        this.declare(sprint);
      };
      const agileCurrent = Object.hasOwn(fields, 'sprint') && issue.metadata.dialect === 'rest-json';
      if (agileCurrent && fields.sprint != null) {
        if (Array.isArray(fields.sprint) || typeof fields.sprint !== 'object') { unresolved = true; currentUnresolved = true; }
        else add(fields.sprint, 'current');
      }
      if (Object.hasOwn(fields, 'closedSprints')) {
        if (Array.isArray(fields.closedSprints)) for (const value of fields.closedSprints) add(value, 'closed');
        else if (fields.closedSprints !== null) unresolved = true;
      }
      const typed = Object.keys(fields).filter(key => sprintFields.has(key) && fields[key] !== null);
      for (const key of typed) {
        const values = fields[key];
        for (const value of Array.isArray(values) ? values : [values]) add(value, 'unknown');
      }
      if (typed.length > 1) { unresolved = true; if (!agileCurrent) currentUnresolved = true; }
      if (Object.keys(fields).some(key => ambiguousFields.has(key) && fields[key] !== null)) {
        unresolved = true;
        if (!agileCurrent) currentUnresolved = true;
      }
      if (dataset.source.format === 'jira-csv' && Object.entries(fields).some(([key, value]) =>
        /^(?:Sprint|Custom field \(Sprint\))$/i.test(key) && (Array.isArray(value) || typeof value === 'string' && value.trim()))) {
        unresolved = true;
        currentUnresolved = true;
      }
      if (candidates.size || agileCurrent || unresolved || typed.length) issue.metadata.jiraSprintIds = [...candidates];
      if (agileCurrent) issue.metadata.jiraCurrentSprintIds = [...current];
      if (unresolved) {
        issue.metadata.jiraSprintUnresolved = true;
        this.warn('JIRA_SPRINT_MEMBERSHIP_UNRESOLVED', 'Jira 스프린트 관계의 일부를 확인하기 어려워 원본 값을 보관했습니다.', issue.id, null);
      }
      if (currentUnresolved && (!agileCurrent || (fields.sprint != null && !current.size))) issue.metadata.jiraCurrentSprintUnresolved = true;
      for (const sprintId of candidates) referenced.add(sprintId);
      if (candidates.size) memberships.push({ issue, candidates });
    }
    if (!referenced.size) return;
    const defined = [...referenced].flatMap(sprintId => {
      const sprint = this.definitions.get(sprintId);
      return sprint?.name ? [sprint] : [];
    });
    if (!defined.length) return;
    const definedIds = new Set(defined.map(sprint => sprint.id));
    for (const { issue, candidates } of memberships) for (const sprintId of candidates) {
      if (definedIds.has(sprintId)) issue.references.push({ kind: 'option', sourceId: sprintOptionId(sprintId), relation: 'sprint' });
    }
    addRecord(dataset, record('field', sprintFieldId, { title: 'Sprint', metadata: { fieldType: 'jira-builtin' } }));
    for (const { id: sprintId, name, goal, invalidDates, ...values } of defined) {
      const metadata = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, LegacyValue>;
      metadata.id = sprintId;
      if (this.ambiguous.has(sprintId)) metadata.jiraSprintAmbiguous = true;
      const option = addRecord(dataset, record('option', sprintOptionId(sprintId), { title: name, containerId: sprintFieldId,
        text: goal ?? '', textFormat: goal ? 'plain' : 'none', metadata,
        references: [{ kind: 'field', sourceId: sprintFieldId, relation: 'field' }] }));
      if (metadata.jiraSprintAmbiguous) this.warn('JIRA_SPRINT_DEFINITION_AMBIGUOUS', '같은 Jira 스프린트 ID의 여러 정의가 달라 원본 확인이 필요합니다.', option.id, null);
      if (invalidDates) this.warn('JIRA_SPRINT_DATE_UNRESOLVED', 'Jira 스프린트 날짜의 일부를 확인하기 어려워 원본 값의 검토가 필요합니다.', option.id, null);
    }
  }
}
