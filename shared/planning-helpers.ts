import type { Issue, PlanningItem, PlanningKind, PlanningStatus, WorkspaceSnapshot } from './types.js';

export const PLANNING_FIELDS = {
  cycle: {idField:'cycleId',labelField:'cycle'},
  module: {idField:'moduleId',labelField:'module'},
  release: {idField:'releaseId',labelField:'release'},
} as const;
export const PLANNING_META:Record<PlanningKind,{label:string;pluralLabel:string;description:string}>={
  cycle:{label:'사이클',pluralLabel:'사이클',description:'정해진 기간 동안 집중할 업무를 묶습니다.'},
  module:{label:'모듈',pluralLabel:'모듈',description:'기능과 목표별로 관련 업무를 묶습니다.'},
  release:{label:'릴리스',pluralLabel:'릴리스',description:'배포 목표와 검증할 업무를 함께 관리합니다.'},
};
export const PLANNING_STATUS_META:Record<PlanningStatus,{label:string;color:string}>={
  planned:{label:'예정',color:'#7d8b9d'},active:{label:'진행 중',color:'#5778ef'},completed:{label:'완료',color:'#31a27e'},archived:{label:'보관됨',color:'#a2a8b4'},
};
export function planningFields<K extends PlanningKind>(kind:K){return PLANNING_FIELDS[kind];}
export function planningMeta(kind:PlanningKind){return PLANNING_META[kind];}
export function planningLabel(data:Pick<WorkspaceSnapshot,'planningItems'>,id:string|null|undefined){return data.planningItems?.find(item=>item.id===id)?.name||'';}
export function planningAssignmentBlock({ kind, status }: Pick<PlanningItem, 'kind' | 'status'>): 'archived' | 'completed' | null {
  if (status === 'archived') return 'archived';
  return kind === 'cycle' && status === 'completed' ? 'completed' : null;
}
export function projectPlanningItems(data:Pick<WorkspaceSnapshot,'planningItems'>,projectId:string,kind:PlanningKind,options:{includeArchived?:boolean}={}):PlanningItem[]{
  return(data.planningItems||[]).filter(item=>item.projectId===projectId&&item.kind===kind&&(options.includeArchived||item.status!=='archived')).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
}
export function issuePlanningLabel(data:Pick<WorkspaceSnapshot,'planningItems'>,issue:Issue,kind:PlanningKind){const fields=planningFields(kind);return planningLabel(data,issue[fields.idField])||issue[fields.labelField]||'';}
