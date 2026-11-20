import { ISSUE_TYPES,type CustomFieldDefinition,type CustomFieldValue,type Issue,type IssueRequiredField,type IssueTypeDefinition,type ProjectIssueSchema,type User,type WorkspaceSnapshot } from './types.js';

export const BASE_REQUIRED_FIELD_LABELS={title:'제목',description:'설명',assigneeId:'담당자',collaboratorIds:'참여자',startDate:'시작일',endDate:'종료일',dueDate:'목표 마감일',estimate:'예상 소요',labels:'라벨',parentId:'상위 업무',cycle:'사이클',module:'모듈',release:'릴리스'} as const;
const colors=['#8c70cb','#5879ed','#7792ab','#db775f','#b48a4b','#428eaf','#5b9b83','#a47b9a','#8d8e5a'];
type SchemaData=Pick<WorkspaceSnapshot,'issueSchemas'>;
export function defaultIssueSchema(projectId:string,updatedAt='1970-01-01T00:00:00.000Z'):ProjectIssueSchema{return{id:projectId,projectId,version:1,issueTypes:ISSUE_TYPES.map((id,index)=>({id,name:id,color:colors[index],archived:false})),fields:[],updatedAt};}
export function projectIssueSchema(data:SchemaData,projectId:string):ProjectIssueSchema{return data.issueSchemas?.find(schema=>schema.projectId===projectId)||defaultIssueSchema(projectId);}
export function projectIssueTypes(data:SchemaData,projectId:string,options:{includeArchived?:boolean}={}):IssueTypeDefinition[]{return projectIssueSchema(data,projectId).issueTypes.filter(type=>options.includeArchived||!type.archived);}
export function issueTypeMeta(data:SchemaData,projectId:string,typeId:string):IssueTypeDefinition{return projectIssueSchema(data,projectId).issueTypes.find(type=>type.id===typeId)||{id:typeId,name:typeId||'알 수 없는 유형',color:'#8b93a5',archived:true};}
export function fieldApplies(field:CustomFieldDefinition,typeId:string){return field.issueTypes.length===0||field.issueTypes.includes(typeId);}
export function fieldScopeCovers(source: CustomFieldDefinition, dependent: CustomFieldDefinition): boolean {
  return source.issueTypes.length === 0 || (dependent.issueTypes.length > 0 && dependent.issueTypes.every(type => fieldApplies(source, type)));
}

export function visibleIssueFieldIds(schema: ProjectIssueSchema, issue: Pick<Issue, 'type' | 'status' | 'customFields'>): Set<string> {
  const applicable = schema.fields.filter(field => !field.archived && fieldApplies(field, issue.type));
  const byId = new Map(applicable.map(field => [field.id, field]));
  const checked = new Map<string, boolean>();
  const values = issue.customFields ?? {};

  function matches(field: CustomFieldDefinition): boolean {
    if (checked.has(field.id)) return checked.get(field.id)!;
    // Set the result before visiting dependencies so invalid cycles cannot reveal fields.
    checked.set(field.id, false);
    const condition = field.visibleWhen;
    if (condition?.statusIds.length && !condition.statusIds.includes(issue.status)) return false;
    const match = condition?.fieldMatch;
    if (match) {
      const source = byId.get(match.fieldId);
      if (!source || !Object.hasOwn(values, source.id) || values[source.id] !== match.value || !matches(source)) return false;
    }
    checked.set(field.id, true);
    return true;
  }

  return new Set(applicable.filter(matches).map(field => field.id));
}

export function hasCustomValue(value:CustomFieldValue|undefined){return value!==null&&value!==undefined&&!(typeof value==='string'&&!value.trim())&&!(Array.isArray(value)&&value.length===0);}
export function fieldValueLabel(field:CustomFieldDefinition,value:CustomFieldValue|undefined,users:User[]=[]):string{
  if(!hasCustomValue(value))return'';
  if(field.kind==='checkbox')return value===true?'예':'아니요';
  if(field.kind==='user')return users.find(user=>user.id===value)?.name||String(value);
  if(field.kind==='select')return field.options.find(option=>option.id===value)?.name||String(value);
  if(field.kind==='multi_select')return(Array.isArray(value)?value:[]).map(id=>field.options.find(option=>option.id===id)?.name||id).join(', ');
  return String(value);
}
export function requiredFieldLabels(data:SchemaData,projectId:string):Record<string,string>;
export function requiredFieldLabels(data:SchemaData,projectId:string,fields:IssueRequiredField[]):string[];
export function requiredFieldLabels(data:SchemaData,projectId:string,fields?:IssueRequiredField[]):Record<string,string>|string[]{
  const labels:Record<string,string>={...BASE_REQUIRED_FIELD_LABELS};for(const field of projectIssueSchema(data,projectId).fields)labels[`custom:${field.id}`]=field.name;
  return fields?fields.map(id=>labels[id]||id):labels;
}
export function issueSearchText(data:Pick<WorkspaceSnapshot,'issueSchemas'|'users'>,issue:Issue):string{
  const schema=projectIssueSchema(data,issue.projectId),values:string[]=[];
  for(const [id,value]of Object.entries(issue.customFields||{})){const field=schema.fields.find(field=>field.id===id);if(field&&hasCustomValue(value))values.push(field.name,fieldValueLabel(field,value,data.users),...(Array.isArray(value)?value:[String(value)]));}
  return[issue.key,issue.title,issue.description,...issue.labels,issue.cycle||'',issue.module||'',issue.release||'',issueTypeMeta(data,issue.projectId,issue.type).name,issue.type,...values].join(' ');
}
