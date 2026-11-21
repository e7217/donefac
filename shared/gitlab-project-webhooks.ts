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
