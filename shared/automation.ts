import type { AutomationRule,GitlabAutomationTrigger } from './types.js';

export const AUTOMATION_TRIGGER_LABELS:Record<GitlabAutomationTrigger,string>={
  'merge_request.opened':'Merge Request 열림',
  'merge_request.merged':'Merge Request 병합',
  'merge_request.closed':'Merge Request 닫힘',
  'pipeline.succeeded':'파이프라인 성공',
  'pipeline.failed':'파이프라인 실패',
};
export const AUTOMATION_TRIGGERS=Object.keys(AUTOMATION_TRIGGER_LABELS) as GitlabAutomationTrigger[];

/** Only * and ? are wildcards. Dynamic programming bounds matching work to 128×512. */
export function branchMatches(pattern:string,branch:string):boolean{
  if(!pattern.length||pattern.length>128||branch.length>512||/[\u0000-\u001f\u007f]/.test(pattern+branch))return false;
  const reference=[...branch];let previous=new Uint8Array(reference.length+1);previous[0]=1;
  for(const character of pattern){const next=new Uint8Array(reference.length+1);if(character==='*')next[0]=previous[0];for(let index=1;index<=reference.length;index++)next[index]=character==='*'?(previous[index]||next[index-1]):((character==='?'||character===reference[index-1])?previous[index-1]:0);previous=next;}
  return previous[reference.length]===1;
}
export function sortedAutomationRules(rules:AutomationRule[]):AutomationRule[]{return[...rules].sort((a,b)=>a.priority-b.priority||(a.id<b.id?-1:a.id>b.id?1:0));}
