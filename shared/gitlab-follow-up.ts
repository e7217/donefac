import { isBlockedGitlabMergeRequest, latestGitlabPipelineLinks } from './issue-gitlab-view.js';
import { GITLAB_REPOSITORY_ADDRESS_LIMIT, gitlabPipelineLinkIdentity } from './gitlab-links.js';
import { GITLAB_MERGE_READINESS_LABELS } from './gitlab-merge-readiness.js';
import { normalizeGitlabSearchInput } from './gitlab-search.js';
import type { GitlabLink, Issue } from './types.js';

export interface GitlabFollowUpEvidence {
  linkId: string;
  issueId: string;
  label: string;
  state: string;
  href: string;
  observedAt: string | null;
}

export interface GitlabFollowUpPreview {
  source: Pick<Issue, 'id' | 'key' | 'title' | 'projectId' | 'version'>;
  evidence: GitlabFollowUpEvidence;
  workflowVersion: number;
  schemaVersion: number;
  restoreGeneration: string;
  revision: string;
}

function followUpAddress(link: GitlabLink, route: string) {
  try {
    const input = new URL(link.webUrl);
    if (!['http:', 'https:'].includes(input.protocol) || input.username || input.password) return null;
    const normalized = normalizeGitlabSearchInput(input.href);
    if (!normalized || normalized.length > GITLAB_REPOSITORY_ADDRESS_LIMIT) return null;
    return new URL(normalized).pathname.endsWith(route) ? normalized : null;
  } catch {
    return null;
  }
}

function evidence(link: GitlabLink): GitlabFollowUpEvidence | null {
  let label: string, state: string, route: string;
  if (isBlockedGitlabMergeRequest(link)) {
    const identity = /^gitlab:[a-f0-9]{12}:([1-9]\d*):merge_request:([1-9]\d*):/u.exec(link.id);
    if (!identity || identity[1] !== String(link.projectId) || link.id.slice(identity[0].length) !== link.issueId ||
        !Number.isSafeInteger(Number(identity[2])) || !Number.isSafeInteger(link.iid) || link.iid < 1) return null;
    label = `GitLab MR !${link.iid}`;
    state = GITLAB_MERGE_READINESS_LABELS[link.mergeReadiness.state];
    route = `/-/merge_requests/${link.iid}`;
  } else if (link.kind === 'pipeline' && link.state === 'failed') {
    const identity = gitlabPipelineLinkIdentity(link);
    if (!identity) return null;
    label = `GitLab 파이프라인 #${identity.objectId}`;
    state = '실패';
    route = `/-/pipelines/${identity.objectId}`;
  } else return null;
  const href = followUpAddress(link, route);
  if (!href) return null;
  const time = Date.parse(link.updatedAt);
  return { linkId: link.id, issueId: link.issueId, label, state, href,
    observedAt: Number.isFinite(time) ? new Date(time).toISOString() : null };
}

export function gitlabFollowUpEvidence(links: readonly GitlabLink[]) {
  return new Map([...links.filter(value => value.kind === 'merge_request'), ...latestGitlabPipelineLinks(links)].flatMap(link => {
    const source = evidence(link);
    return source ? [[link.id, source] as const] : [];
  }));
}

export function gitlabFollowUpPath(issueId: string, linkId: string) {
  return `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/follow-up`;
}
