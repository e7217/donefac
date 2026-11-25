import { gitlabPipelineSourceLabel } from './gitlab-pipeline-source.js';
import type { AutomationRule, GitlabAutomationTrigger, GitlabPipelineRefKind } from './types.js';

export const AUTOMATION_TRIGGER_LABELS:Record<GitlabAutomationTrigger,string>={
  'merge_request.opened':'Merge Request 열림',
  'merge_request.merged':'Merge Request 병합',
  'merge_request.closed':'Merge Request 닫힘',
  'pipeline.succeeded':'파이프라인 성공',
  'pipeline.failed':'파이프라인 실패',
  'deployment.succeeded':'배포 성공',
};
export const AUTOMATION_TRIGGERS=Object.keys(AUTOMATION_TRIGGER_LABELS) as GitlabAutomationTrigger[];
export const PIPELINE_REF_KIND_LABELS: Record<GitlabPipelineRefKind, string> = { branch: '브랜치', tag: '태그' };

export function isPipelineAutomationTrigger(trigger: unknown): trigger is 'pipeline.succeeded' | 'pipeline.failed' {
  return trigger === 'pipeline.succeeded' || trigger === 'pipeline.failed';
}

export function isMergeRequestAutomationTrigger(trigger: unknown): trigger is Extract<GitlabAutomationTrigger, `merge_request.${string}`> {
  return trigger === 'merge_request.opened' || trigger === 'merge_request.merged' || trigger === 'merge_request.closed';
}

export function automationPipelineContextLabel(source?: string, tag?: boolean): string | undefined {
  if (source === undefined && tag === undefined) return;
  const refKind = tag === undefined ? '참조 유형 미확인' : PIPELINE_REF_KIND_LABELS[tag ? 'tag' : 'branch'];
  return `${refKind} · ${gitlabPipelineSourceLabel(source)}`;
}

export const MAX_GITLAB_DEPLOYMENT_ENVIRONMENT_LENGTH = 255;

export function isGitlabDeploymentEnvironment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_GITLAB_DEPLOYMENT_ENVIRONMENT_LENGTH && value.trim() === value &&
    value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Only * and ? are wildcards. Dynamic programming bounds matching work to 128×512. */
export function branchMatches(pattern:string,branch:string):boolean{
  if(!pattern.length||pattern.length>128||branch.length>512||/[\u0000-\u001f\u007f]/.test(pattern+branch))return false;
  const reference=[...branch];let previous=new Uint8Array(reference.length+1);previous[0]=1;
  for(const character of pattern){const next=new Uint8Array(reference.length+1);if(character==='*')next[0]=previous[0];for(let index=1;index<=reference.length;index++)next[index]=character==='*'?(previous[index]||next[index-1]):((character==='?'||character===reference[index-1])?previous[index-1]:0);previous=next;}
  return previous[reference.length]===1;
}
export function sortedAutomationRules(rules:AutomationRule[]):AutomationRule[]{return[...rules].sort((a,b)=>a.priority-b.priority||(a.id<b.id?-1:a.id>b.id?1:0));}
