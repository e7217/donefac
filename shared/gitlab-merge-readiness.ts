import type { GitlabMergeReadiness, GitlabMergeReadinessState } from './types.js';

const detailedMergeStates: Readonly<Record<string, GitlabMergeReadinessState>> = {
  mergeable: 'ready',
  approvals_syncing: 'checking',
  checking: 'checking',
  preparing: 'checking',
  unchecked: 'checking',
  draft_status: 'draft',
  conflict: 'conflict',
  not_approved: 'approval_required',
  requested_changes: 'changes_requested',
  discussions_not_resolved: 'discussions_unresolved',
  ci_must_pass: 'ci_required',
  ci_still_running: 'ci_running',
  need_rebase: 'rebase_required',
  merge_request_blocked: 'dependency',
  jira_association_missing: 'policy',
  merge_time: 'policy',
  security_policy_pipeline_check: 'policy',
  security_policy_violations: 'policy',
  status_checks_must_pass: 'policy',
  title_regex: 'policy',
  commits_status: 'blocked',
  locked_paths: 'blocked',
  locked_lfs_files: 'blocked',
};
const knownStates = new Set<unknown>([...Object.values(detailedMergeStates), 'unknown']);

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizedState(attributes: Record<string, unknown>): GitlabMergeReadinessState | undefined {
  if (attributes.draft === true || attributes.work_in_progress === true) return 'draft';
  if (attributes.has_conflicts === true) return 'conflict';
  const detailed = attributes.detailed_merge_status;
  if (typeof detailed === 'string' && detailed) return Object.hasOwn(detailedMergeStates, detailed) ? detailedMergeStates[detailed] : undefined;
  switch (attributes.merge_status) {
    case 'checking':
    case 'unchecked':
    case 'cannot_be_merged_recheck':
      return 'checking';
    case 'cannot_be_merged':
      return 'blocked';
  }
}

/** Called for a sampled or delivered open merge request. Legacy clean merges do not verify the other GitLab checks. */
export function parseGitlabMergeReadiness(
  attributes: Record<string, unknown>, observedAt: string, source: GitlabMergeReadiness['source'],
): GitlabMergeReadiness | undefined {
  const state = normalizedState(attributes);
  return state && isCanonicalTimestamp(observedAt) ? { state, observedAt, source } : undefined;
}

export function isGitlabMergeReadiness(value: unknown): value is GitlabMergeReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 3 && ['state', 'observedAt', 'source'].every(key => Object.hasOwn(fields, key)) &&
    knownStates.has(fields.state) && isCanonicalTimestamp(fields.observedAt) && (fields.source === 'read' || fields.source === 'webhook');
}

export function isGitlabMergeReadinessBlocked(state: GitlabMergeReadinessState | undefined): boolean {
  return knownStates.has(state) && state !== 'ready' && state !== 'checking' && state !== 'unknown';
}
