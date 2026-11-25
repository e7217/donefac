import { GITLAB_MERGE_READINESS_LABELS } from './gitlab-merge-readiness.js';
import { gitlabPipelineSourceLabel } from './gitlab-pipeline-source.js';
import type { DeliveryBlockerGitlabEvidence, DeliveryBlockerRow } from './types.js';

export const DELIVERY_BLOCKER_DRAFT_GITLAB_EXAMPLES = 3;

export function deliveryBlockerGitlabCount({ blockedMergeRequests, failedPipelines, manualPipelines }: DeliveryBlockerRow['gitlab']): number {
  return blockedMergeRequests + failedPipelines + (manualPipelines ?? 0);
}

export function deliveryBlockerGitlabLabel(evidence: DeliveryBlockerGitlabEvidence): string {
  const { repository, repositoryId, number, kind } = evidence;
  const identity = kind === 'merge_request'
    ? (number === null ? 'MR' : `MR !${number}`)
    : (number === null ? '파이프라인' : `파이프라인 #${number}`);
  return `${identity} · ${repository ?? `저장소 ${repositoryId}`}`;
}

export function deliveryBlockerGitlabState(evidence: DeliveryBlockerGitlabEvidence): string {
  if (evidence.kind === 'merge_request') return GITLAB_MERGE_READINESS_LABELS[evidence.state];
  const state = evidence.state === 'failed' ? '실패' : '수동 실행 대기';
  return evidence.source || evidence.tag
    ? `${state} · ${gitlabPipelineSourceLabel(evidence.source, evidence.tag)}` : state;
}
