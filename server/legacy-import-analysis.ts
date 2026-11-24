import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { LegacyDataset,LegacyFile } from '../shared/types.js';
import { decodeLegacyText,isJiraAttachmentPath,readLegacyArchive } from './legacy-import-archive.js';
import { parseJira } from './legacy-import-jira.js';
import { parseConfluence } from './legacy-import-confluence.js';
import { classifyMissingReferences,diagnostic,LegacyImportError } from './legacy-import-model.js';

export interface LegacyAnalysis { dataset:LegacyDataset; files:LegacyFile[]; expandedBytes:number }
function detect(files:Map<string,Buffer>):'jira'|'confluence'{
  const entries=[...files].filter(([path])=>!isJiraAttachmentPath(path)),entities=entries.filter(([path])=>basename(path).toLowerCase()==='entities.xml');
  const xml=entities.length?entities:entries.filter(([path])=>/\.xml$/i.test(path));
  const products=new Set<'jira'|'confluence'>();
  for(const [,bytes]of xml){const text=decodeLegacyText(bytes).slice(0,65536);if(/<entity-engine-xml(?:\s|>)/.test(text)||/<rss(?:\s|>)/.test(text))products.add('jira');if(/<hibernate-generic(?:\s|>)/.test(text))products.add('confluence');}
  if(products.size===1)return[...products][0];
  if(products.size>1)throw new LegacyImportError(400,'Jira와 Confluence 원본은 별도 패키지로 분석해 주세요.');
  if(entries.some(([path])=>/\.(csv|json)$/i.test(path)))return'jira';
  throw new LegacyImportError(400,'원본 형식을 찾지 못했습니다. 제품을 직접 선택하거나 XML/CSV/JSON 내보내기 파일을 확인해 주세요.');
}
export async function analyzeLegacyPackage(input:{path:string;filename:string;instanceKey:string;product:'auto'|'jira'|'confluence'}):Promise<LegacyAnalysis>{
  return analyzeLegacyPackageBytes({bytes:readFileSync(input.path),filename:input.filename,instanceKey:input.instanceKey,product:input.product});
}
export async function analyzeLegacyPackageBytes(input:{bytes:Buffer;filename:string;instanceKey:string;product:'auto'|'jira'|'confluence'}):Promise<LegacyAnalysis>{
  const archive=await readLegacyArchive(input.bytes,input.filename),product=input.product==='auto'?detect(archive.files):input.product;
  const dataset=product==='jira'?parseJira(archive.files,input.instanceKey):parseConfluence(archive.files,input.instanceKey);
  classifyMissingReferences(dataset);
  if(!dataset.records.some(value=>['issue','page'].includes(value.kind)))diagnostic(dataset,{severity:'error',code:'NO_PRIMARY_CONTENT',message:'업무나 현재 문서 객체를 찾지 못했습니다. 올바른 전체 내보내기 파일인지 확인해 주세요.'});
  diagnostic(dataset,{severity:'info',code:'ANALYSIS_ONLY',message:'원본 분석 결과입니다. 현재 업무·문서는 변경하지 않았으며 적용·매핑·변환 검증은 후속 단계입니다.'});
  if(Buffer.byteLength(JSON.stringify(dataset))>128*1024*1024)throw new LegacyImportError(413,'분석 결과가128MiB를 초과했습니다. 원본을 나누어 분석해 주세요.');
  return{dataset,files:archive.manifest,expandedBytes:archive.expandedBytes};
}
