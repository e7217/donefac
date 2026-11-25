import { isGitlabDeploymentEnvironment } from '../../shared/automation';
import { GITLAB_DEPLOYMENT_STATES, type GitlabDeploymentFilters } from '../../shared/types';

export type GitlabDeploymentListing = GitlabDeploymentFilters & { offset: number };
export type GitlabDeploymentView = GitlabDeploymentListing & { repositoryId?: number };
export type ChangeGitlabDeploymentView = (view: GitlabDeploymentView, mode: 'push' | 'replace', expected?: GitlabDeploymentView) => void;
export const DEFAULT_GITLAB_DEPLOYMENT_VIEW: GitlabDeploymentView = { offset: 0 };

function singleParameter(parameters: URLSearchParams, name: string) {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d{0,15}$/u.test(value)) return;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function readGitlabDeploymentView(parameters: URLSearchParams): GitlabDeploymentView {
  const environment = singleParameter(parameters, 'deploymentEnvironment');
  const status = singleParameter(parameters, 'deploymentStatus');
  return {
    repositoryId: positiveInteger(singleParameter(parameters, 'deploymentRepository')),
    environment: isGitlabDeploymentEnvironment(environment) ? environment : undefined,
    status: GITLAB_DEPLOYMENT_STATES.find(candidate => candidate === status),
    offset: positiveInteger(singleParameter(parameters, 'deploymentOffset')) ?? 0,
  };
}

export function appendGitlabDeploymentView(parameters: URLSearchParams, view: GitlabDeploymentView) {
  if (view.repositoryId) parameters.set('deploymentRepository', String(view.repositoryId));
  if (view.environment) parameters.set('deploymentEnvironment', view.environment);
  if (view.status) parameters.set('deploymentStatus', view.status);
  if (view.offset) parameters.set('deploymentOffset', String(view.offset));
}

export function sameGitlabDeploymentView(left: GitlabDeploymentView, right: GitlabDeploymentView): boolean {
  return left.repositoryId === right.repositoryId && left.environment === right.environment &&
    left.status === right.status && left.offset === right.offset;
}
