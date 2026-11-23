import type { GitlabWebhookDelivery } from './types.js';

export type GitlabProjectWebhookAuthMode = 'secret' | 'signature';

export interface GitlabProjectWebhook {
  id: number;
  receiverExact?: false;
  pushEvents: boolean;
  mergeRequestEvents: boolean;
  pipelineEvents: boolean;
  deploymentEvents: boolean | null;
  sslVerification: boolean;
  unfilteredPush: boolean;
  standardPayload: boolean;
  active: boolean | null;
}

export interface GitlabProjectWebhookReview {
  settingsVersion: number;
  repositoryId: number;
  receiverUrl: string;
  authMode: GitlabProjectWebhookAuthMode | null;
  state: 'missing' | 'configured' | 'review' | 'unknown' | 'created';
  hooks: GitlabProjectWebhook[];
  reviewId?: string;
  configurationChanged?: true;
}

export interface GitlabProjectWebhookAttempt {
  id: number;
  event: GitlabWebhookDelivery['event'];
  status: number | null;
  sentAt: string | null;
  durationMs: number | null;
}

export interface GitlabProjectWebhookHistory {
  settingsVersion: number;
  repositoryId: number;
  hookId: number;
  attempts: GitlabProjectWebhookAttempt[];
  partial: boolean;
  localReceipt: GitlabWebhookDelivery | null;
}
