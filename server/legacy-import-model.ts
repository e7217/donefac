import { createHash } from 'node:crypto';
import type { LegacyDataset,LegacyDiagnostic,LegacyRecord,LegacyRecordKind,LegacySource,LegacyValue } from '../shared/types.js';

export const LEGACY_MAX_RECORDS=100000,LEGACY_MAX_DIAGNOSTICS=10000,LEGACY_MAX_TEXT_BYTES=16*1024*1024;
export class LegacyImportError extends Error { constructor(public status:number,message:string,public details?:unknown){super(message);} }
const fail=(message:string,status=400):never=>{throw new LegacyImportError(status,message);};
const identifier=(value:unknown,label:string):string=>typeof value==='string'&&value.length>0&&value.length<=500&&!/[\u0000-\u001f\u007f]/.test(value)?value:fail(`${label} 식별자를 확인해 주세요.`);
const kinds=new Set<LegacyRecordKind>(['identity','project','issue','page','comment','revision','history','attachment','relation','field','option','workflow']);
export function emptyDataset(source:LegacySource):LegacyDataset{return{source,records:[],diagnostics:[],unsupported:[]};}
export function record(kind:LegacyRecordKind,sourceId:string,partial:Partial<Omit<LegacyRecord,'id'|'kind'|'sourceId'>>={}):LegacyRecord{
  identifier(sourceId,'원본');if(!kinds.has(kind))fail('지원하지 않는 원본 객체 종류입니다.');
  return{id:`${kind}:${sourceId}`,kind,sourceId,title:'',containerId:null,parentId:null,authorId:null,createdAt:null,updatedAt:null,text:'',textFormat:'none',metadata:{},references:[],...partial};
}
function inspectValue(value:LegacyValue,depth=0):void{
  if(depth>32)fail('원본 메타데이터 구조가 너무 깊습니다.',413);
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('원본 메타데이터의 숫자가 올바르지 않습니다.');return;}
  if(typeof value==='string'){if(Buffer.byteLength(value)>LEGACY_MAX_TEXT_BYTES)fail('개별 원본 문자열은16MiB 이하여야 합니다.',413);return;}
  if(Array.isArray(value)){for(const item of value)inspectValue(item,depth+1);return;}
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)fail('원본 메타데이터는 JSON 값이어야 합니다.');
  for(const [key,item] of Object.entries(value)){if(key.length>500||['__proto__','prototype','constructor'].includes(key))fail('원본 메타데이터 키를 확인해 주세요.');inspectValue(item,depth+1);}
}
const indexes=new WeakMap<LegacyDataset,Set<string>>();
const diagnosticIndexes=new WeakMap<LegacyDataset,Set<string>>();
export function addRecord(dataset:LegacyDataset,value:LegacyRecord):LegacyRecord{
  if(dataset.records.length>=LEGACY_MAX_RECORDS)fail('한 패키지의 원본 객체는100000개 이하여야 합니다.',413);
  let ids=indexes.get(dataset);if(!ids){ids=new Set(dataset.records.map(row=>row.id));indexes.set(dataset,ids);}
  if(ids.has(value.id))fail(`중복된 원본 객체가 있습니다: ${value.kind}`);
  if(value.id!==`${value.kind}:${identifier(value.sourceId,'원본')}`||!kinds.has(value.kind))fail('원본 객체 식별자를 확인해 주세요.');
  if(typeof value.title!=='string'||Buffer.byteLength(value.title)>65536||typeof value.text!=='string'||Buffer.byteLength(value.text)>LEGACY_MAX_TEXT_BYTES)fail('원본 제목/본문이 분석 한도를 초과합니다.',413);
  if(!Array.isArray(value.references)||value.references.length>10000)fail('원본 객체의 관계 목록을 확인해 주세요.');
  for(const ref of value.references){if(!kinds.has(ref.kind))fail('원본 관계의 객체 종류를 확인해 주세요.');identifier(ref.sourceId,'관계 대상');if(typeof ref.relation!=='string'||!ref.relation||ref.relation.length>120)fail('원본 관계 이름을 확인해 주세요.');}
  for(const field of ['containerId','parentId','authorId'] as const)if(value[field]!==null)identifier(value[field],field);
  for(const field of ['createdAt','updatedAt'] as const)if(value[field]!==null&&(typeof value[field]!=='string'||value[field]!.length>100))fail('원본 시각 형식을 확인해 주세요.');
  inspectValue(value.metadata);ids.add(value.id);dataset.records.push(value);return value;
}
export function diagnostic(dataset:LegacyDataset,input:Omit<LegacyDiagnostic,'id'|'recordId'|'path'>&{recordId?:string|null;path?:string|null}):void{
  const item={...input,recordId:input.recordId??null,path:input.path??null};
  if(!['error','warning','info'].includes(item.severity)||typeof item.code!=='string'||!item.code||item.code.length>100||typeof item.message!=='string'||item.message.length>2000)fail('이관 진단 형식을 확인해 주세요.');
  const id=createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0,32);
  let ids=diagnosticIndexes.get(dataset);if(!ids){ids=new Set(dataset.diagnostics.map(value=>value.id));diagnosticIndexes.set(dataset,ids);}if(ids.has(id))return;
  if(dataset.diagnostics.length>=LEGACY_MAX_DIAGNOSTICS)fail('분석 진단이10000개를 넘어 패키지를 나누어야 합니다.',413);
  ids.add(id);dataset.diagnostics.push({...item,id});
}
export function classifyMissingReferences(dataset:LegacyDataset):void{
  const ids=new Set(dataset.records.map(value=>value.id));
  for(const value of dataset.records)for(const ref of value.references)if(!ids.has(`${ref.kind}:${ref.sourceId}`))diagnostic(dataset,{severity:'warning',code:'MISSING_REFERENCE',message:`원본 ${ref.relation} 관계의 대상이 패키지에 없습니다 (${ref.kind}: ${ref.sourceId}).`,recordId:value.id});
}
