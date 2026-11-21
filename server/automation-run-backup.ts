import { AUTOMATION_TRIGGERS } from '../shared/automation.js';
import type { AutomationRun, AutomationRunContext, Project, User } from '../shared/types.js';
import { AutomationError, isDeploymentAutomationContext } from './automation.js';
import type { Store } from './store.js';

const OUTCOMES: ReadonlySet<unknown> = new Set(['changed', 'no_op', 'blocked', 'ignored']);
const TRIGGERS: ReadonlySet<unknown> = new Set(AUTOMATION_TRIGGERS);
const RUN_FIELDS = new Set(['id', 'eventId', 'issueId', 'projectId', 'actorId', 'ruleId', 'key', 'title', 'fromStatus', 'toStatus',
  'outcome', 'reason', 'createdAt', 'occurredAt', 'context']);
const CONTEXT_FIELDS = new Set(['ruleName', 'trigger', 'gitlabBaseUrl', 'gitlabProjectId', 'objectKind', 'objectId', 'branch',
  'fromStatusLabel', 'toStatusLabel', 'environment']);

function invalidHistory(): never {
  throw new AutomationError(400, '백업의 GitLab 상태 자동화 실행 기록을 확인해 주세요.');
}

function record(value: unknown, fields: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.has(field))) {
    return invalidHistory();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max = Infinity): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function time(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function gitlabBase(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function validateContext(value: unknown): AutomationRunContext {
  const context = record(value, CONTEXT_FIELDS);
  const { ruleName, trigger, gitlabBaseUrl, gitlabProjectId, objectKind, objectId, branch, fromStatusLabel, toStatusLabel, environment } = context;
  if (!text(ruleName, 120) || typeof trigger !== 'string' || !TRIGGERS.has(trigger) ||
      !gitlabBase(gitlabBaseUrl) || typeof gitlabProjectId !== 'number' || !Number.isSafeInteger(gitlabProjectId) || gitlabProjectId < 1 ||
      typeof objectId !== 'string' || typeof branch !== 'string' || branch.length > 512 || !text(fromStatusLabel) || !text(toStatusLabel)) {
    return invalidHistory();
  }
  if (trigger === 'deployment.succeeded') {
    if (!isDeploymentAutomationContext({ objectKind, objectId, branch, environment })) return invalidHistory();
  } else if ((objectKind !== 'merge_request' && objectKind !== 'pipeline') || !trigger.startsWith(`${objectKind}.`) ||
      Object.hasOwn(context, 'environment')) {
    return invalidHistory();
  }
  return context as unknown as AutomationRunContext;
}

export function exportAutomationRunHistory(store: Store): AutomationRun[] {
  const rows = store.db.prepare('SELECT json FROM automation_runs ORDER BY rowid').all() as { json: string }[];
  return rows.map(row => JSON.parse(row.json) as AutomationRun);
}

export function validateAutomationRunHistory(input: unknown, projects: readonly Project[], users: readonly User[], exportedAt: unknown): AutomationRun[] {
  if (!Array.isArray(input) || (input.length > 0 && !time(exportedAt))) return invalidHistory();
  const projectIds = new Set(projects.map(project => project.id));
  const userIds = new Set(users.map(user => user.id));
  const ids = new Set<string>();
  const deliveries = new Set<string>();
  return input.map(value => {
    const row = record(value, RUN_FIELDS);
    const { id, eventId, issueId, projectId, actorId, ruleId, key, title, fromStatus, toStatus, outcome, reason, createdAt, occurredAt } = row;
    // A historical run can outlive its issue, rule, and workflow statuses.
    if (!text(id, 200) || ids.has(id) || !text(eventId, 300) || !text(issueId, 200) || typeof projectId !== 'string' || !projectIds.has(projectId) ||
        typeof actorId !== 'string' || !userIds.has(actorId) || !text(ruleId) || typeof key !== 'string' || !text(title) ||
        !text(fromStatus) || !text(toStatus) || !OUTCOMES.has(outcome) || !text(reason) || !time(createdAt) ||
        typeof exportedAt !== 'string' || createdAt > exportedAt || (occurredAt !== null && !time(occurredAt))) {
      return invalidHistory();
    }
    const delivery = JSON.stringify([eventId, issueId]);
    if (deliveries.has(delivery)) return invalidHistory();
    ids.add(id);
    deliveries.add(delivery);
    if (Object.hasOwn(row, 'context')) validateContext(row.context);
    return row as unknown as AutomationRun;
  });
}

/** Rules and previous runs have been replaced within the caller's workspace transaction. */
export function restoreAutomationRunHistory(store: Store, history: readonly AutomationRun[]): void {
  if (!store.db.isTransaction) throw new Error('Automation history restoration requires a transaction.');
  const insert = store.db.prepare('INSERT INTO automation_runs(id,event_id,issue_id,project_id,occurred_at,outcome,json) VALUES(?,?,?,?,?,?,?)');
  for (const run of history) insert.run(run.id, run.eventId, run.issueId, run.projectId, run.occurredAt, run.outcome, JSON.stringify(run));
}
