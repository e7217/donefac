import { createCalendarMath } from '../shared/calendar.js';
import { deliveryBlockerGitlabCount } from '../shared/delivery-blocker-gitlab.js';
import { gitlabPipelineLinkIdentity, GITLAB_REPOSITORY_ADDRESS_LIMIT } from '../shared/gitlab-links.js';
import { gitlabPipelineSource } from '../shared/gitlab-pipeline-source.js';
import { normalizeGitlabSearchInput } from '../shared/gitlab-search.js';
import { isBlockedGitlabMergeRequest, latestGitlabPipelineLinks, summarizeIssueGitlabLinks } from '../shared/issue-gitlab-view.js';
import { issueDeadline } from '../shared/my-work.js';
import { checkDependencySchedule } from '../shared/schedule-dependencies.js';
import {
  PRIORITY, type DeliveryBlockerCounts, type DeliveryBlockerGitlabEvidence, type DeliveryBlockerIssue, type DeliveryBlockerRelease, type DeliveryBlockerRow, type DeliveryScheduleConflict,
  type Dependency, type GitlabLink, type Issue, type Priority, type TeamScheduleBlocker, type WorkCalendar, type WorkflowStatus,
  type WorkspaceSnapshot,
} from '../shared/types.js';
import { statusMeta } from '../shared/workflow-helpers.js';

interface DeliveryBlockersInput {
  targets: readonly Issue[];
  sources: readonly Issue[];
  blockers: readonly TeamScheduleBlocker[];
  dependencies: readonly Dependency[];
  gitlabLinks: readonly GitlabLink[];
  calendar: WorkCalendar;
  release?: DeliveryBlockerRelease;
  data: Pick<WorkspaceSnapshot, 'users' | 'workflows' | 'issueSchemas'>;
}

const detailLimit = 20;
const gitlabDetailLimitPerCategory = 5;
const priorityOrder = Object.keys(PRIORITY) as Priority[];
const issueKeys = new Intl.Collator('ko', { numeric: true });

function compareIssue(a: DeliveryBlockerIssue, b: DeliveryBlockerIssue): number {
  return issueKeys.compare(a.key, b.key) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id);
}

function compareRow(a: DeliveryBlockerRow, b: DeliveryBlockerRow): number {
  const dateOrder = a.deadline === null ? Number(b.deadline !== null)
    : b.deadline === null ? -1 : a.deadline.value.localeCompare(b.deadline.value);
  return dateOrder || priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority) || compareIssue(a.issue, b.issue);
}

function compareConflict(a: DeliveryScheduleConflict, b: DeliveryScheduleConflict): number {
  return compareIssue(a.predecessor, b.predecessor) || a.type.localeCompare(b.type) || a.lagDays - b.lagDays ||
    a.endpoint.localeCompare(b.endpoint) || a.scheduledDate.localeCompare(b.scheduledDate) || a.requiredDate.localeCompare(b.requiredDate);
}

export function hasGitlabDeliveryBlocker(gitlab: DeliveryBlockerRow['gitlab']): boolean {
  return deliveryBlockerGitlabCount(gitlab) > 0;
}

function gitlabEvidenceAddress(link: GitlabLink, objectNumber: number | null): Pick<DeliveryBlockerGitlabEvidence, 'repository' | 'href'> {
  if (objectNumber === null || typeof link.webUrl !== 'string' || !/^https?:\/\//iu.test(link.webUrl)) return {};
  try {
    const original = new URL(link.webUrl);
    if (original.username || original.password) return {};
    const href = normalizeGitlabSearchInput(link.webUrl);
    if (!href || href.length > GITLAB_REPOSITORY_ADDRESS_LIMIT) return {};
    const url = new URL(href);
    const suffix = `/-/${link.kind === 'merge_request' ? 'merge_requests' : 'pipelines'}/${objectNumber}`;
    if (!url.pathname.endsWith(suffix)) return {};
    return { href, repository: `${url.host}${decodeURIComponent(url.pathname.slice(0, -suffix.length))}` };
  } catch {
    return {};
  }
}

const gitlabCategory = (evidence: DeliveryBlockerGitlabEvidence) =>
  evidence.kind === 'merge_request' ? 0 : evidence.state === 'failed' ? 1 : 2;
function compareGitlabEvidence(a: DeliveryBlockerGitlabEvidence, b: DeliveryBlockerGitlabEvidence): number {
  return gitlabCategory(a) - gitlabCategory(b) || (a.repository ?? '').localeCompare(b.repository ?? '') ||
    a.repositoryId - b.repositoryId || (a.number ?? 0) - (b.number ?? 0) || a.id.localeCompare(b.id);
}

function gitlabEvidenceByIssue(links: GitlabLink[]): Map<string, DeliveryBlockerGitlabEvidence[]> {
  const evidence = new Map<string, DeliveryBlockerGitlabEvidence[]>();
  function add(issueId: string, item: DeliveryBlockerGitlabEvidence) {
    const matches = evidence.get(issueId);
    if (matches) matches.push(item);
    else evidence.set(issueId, [item]);
  }
  const iid = (link: GitlabLink) => Number.isSafeInteger(link.iid) && link.iid > 0 ? link.iid : null;
  for (const link of links.filter(isBlockedGitlabMergeRequest)) {
    const number = iid(link);
    add(link.issueId, { id: link.id, repositoryId: link.projectId, kind: 'merge_request', state: link.mergeReadiness.state,
      number, ...gitlabEvidenceAddress(link, number) });
  }
  for (const link of latestGitlabPipelineLinks(links)) {
    if (link.state !== 'failed' && link.state !== 'manual') continue;
    const objectNumber = gitlabPipelineLinkIdentity(link)?.objectId ?? null;
    const source = gitlabPipelineSource(link.pipelineSource);
    add(link.issueId, { id: link.id, repositoryId: link.projectId, kind: 'pipeline', state: link.state, number: objectNumber ?? iid(link),
      ...gitlabEvidenceAddress(link, objectNumber), ...(source ? { source } : {}), ...(link.pipelineTag === true ? { tag: true } : {}) });
  }
  for (const [issueId, items] of evidence) {
    const counts = [0, 0, 0];
    evidence.set(issueId, items.sort(compareGitlabEvidence).filter(item => counts[gitlabCategory(item)]++ < gitlabDetailLimitPerCategory));
  }
  return evidence;
}

/** Sources can be outside the saved view. The caller supplies confirmed blockers and readable issues. */
export function buildDeliveryBlockers(input: DeliveryBlockersInput): { rows: DeliveryBlockerRow[]; counts: DeliveryBlockerCounts } {
  const { targets, sources, blockers, dependencies, gitlabLinks, calendar, release, data } = input;
  const statusCache = new Map<string, WorkflowStatus>();
  const usersById = new Map(data.users.map(user => [user.id, user.name]));
  function statusOf(issue: Issue) {
    let status = statusCache.get(issue.id);
    if (!status) {
      status = statusMeta(data, issue.projectId, issue.status);
      statusCache.set(issue.id, status);
    }
    return status;
  }
  function active(issue: Issue) {
    const { category } = statusOf(issue);
    return category !== 'done' && category !== 'cancelled';
  }
  function summarize(issue: Issue): DeliveryBlockerIssue {
    const { id, projectId, key, title, status, assigneeId, version } = issue;
    return {
      id, projectId, key, title, status, assigneeId, version,
      statusLabel: statusOf(issue).label, assigneeName: assigneeId ? usersById.get(assigneeId) ?? null : null,
    };
  }

  const sourcesById = new Map([...sources, ...targets].map(issue => [issue.id, issue]));
  const activeTargets = new Map(targets
    .filter(issue => issue.projectId === calendar.projectId && (!release || issue.releaseId === release.id) && active(issue))
    .map(issue => [issue.id, issue]));
  const rowsById = new Map<string, DeliveryBlockerRow>();
  function rowFor(issue: Issue) {
    let row = rowsById.get(issue.id);
    if (!row) {
      row = {
        issue: summarize(issue), priority: issue.priority, deadline: issueDeadline(issue),
        blockers: { total: 0, items: [] }, scheduleConflicts: { total: 0, items: [] },
        gitlab: { blockedMergeRequests: 0, failedPipelines: 0, manualPipelines: 0 },
      };
      rowsById.set(issue.id, row);
    }
    return row;
  }

  if (release) {
    for (const issue of activeTargets.values()) {
      const startDate = issue.startDate ?? null;
      const endDate = issue.endDate ?? null;
      const missing: ('startDate' | 'endDate')[] = [];
      if (startDate === null) missing.push('startDate');
      if (endDate === null) missing.push('endDate');
      const afterDeadline = endDate !== null && release.deadline !== null && endDate > release.deadline;
      if (missing.length || afterDeadline) rowFor(issue).releaseSchedule = { startDate, endDate, missing, afterDeadline };
    }
  }

  const seenBlocks = new Set<string>();
  for (const { sourceIssueId, targetIssueId, origin } of blockers) {
    const target = activeTargets.get(targetIssueId);
    const source = sourcesById.get(sourceIssueId);
    if (!target || !source || source.id === target.id || !active(source)) continue;
    const pair = JSON.stringify([source.id, target.id]);
    if (seenBlocks.has(pair)) continue;
    seenBlocks.add(pair);
    rowFor(target).blockers.items.push({ ...summarize(source), ...(origin === 'jira' ? { origin } : {}) });
  }

  const math = createCalendarMath(calendar);
  const seenConflicts = new Set<string>();
  for (const dependency of dependencies) {
    const target = activeTargets.get(dependency.successorId);
    const source = sourcesById.get(dependency.predecessorId);
    if (!target || !source || source.id === target.id || source.projectId !== target.projectId ||
        seenConflicts.has(dependency.id)) continue;
    const check = checkDependencySchedule(dependency, source, target, math);
    if (check.kind !== 'conflict') continue;
    seenConflicts.add(dependency.id);
    rowFor(target).scheduleConflicts.items.push({
      predecessor: summarize(source), type: dependency.type, lagDays: dependency.lagDays,
      endpoint: check.successorEndpoint, scheduledDate: check.successorDate, requiredDate: check.requiredDate,
    });
  }

  const activeLinks = gitlabLinks.filter(link => activeTargets.has(link.issueId));
  const gitlab = summarizeIssueGitlabLinks(activeLinks);
  const gitlabEvidence = gitlabEvidenceByIssue(activeLinks);
  for (const [id, issue] of activeTargets) {
    const summary = gitlab.get(id);
    if (!summary || !hasGitlabDeliveryBlocker(summary)) continue;
    const { blockedMergeRequests, failedPipelines, manualPipelines } = summary;
    const row = rowFor(issue);
    row.gitlab = { blockedMergeRequests, failedPipelines, manualPipelines };
    row.gitlabEvidence = gitlabEvidence.get(id);
  }

  const rows = [...rowsById.values()].sort(compareRow);
  const counts: DeliveryBlockerCounts = { open: activeTargets.size, affected: rows.length,
    reasons: { issue_block: 0, schedule_conflict: 0, gitlab: 0 } };
  const releaseCounts = { missing_schedule: 0, after_release_date: 0 };
  for (const { blockers, scheduleConflicts, gitlab, releaseSchedule } of rows) {
    blockers.total = blockers.items.length;
    blockers.items = blockers.items.sort(compareIssue).slice(0, detailLimit);
    scheduleConflicts.total = scheduleConflicts.items.length;
    scheduleConflicts.items = scheduleConflicts.items.sort(compareConflict).slice(0, detailLimit);
    counts.reasons.issue_block += Number(blockers.total > 0);
    counts.reasons.schedule_conflict += Number(scheduleConflicts.total > 0);
    counts.reasons.gitlab += Number(hasGitlabDeliveryBlocker(gitlab));
    if (releaseSchedule) {
      releaseCounts.missing_schedule += Number(releaseSchedule.missing.length > 0);
      releaseCounts.after_release_date += Number(releaseSchedule.afterDeadline);
    }
  }
  if (release) Object.assign(counts.reasons, releaseCounts);
  return { rows, counts };
}
