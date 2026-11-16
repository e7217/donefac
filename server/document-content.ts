import { createEditorSchema } from '../shared/editor-schema.js';
import { contentReferences,documentPlainText } from '../shared/document-nodes.js';
import type { DocPage,Issue,RichContent } from '../shared/types.js';
import type { Store } from './store.js';

export const MAX_DOCUMENT_BYTES=8*1024*1024;
const schema=createEditorSchema();
const versionTwoNodes=new Set(['issueReference','documentReference','documentInclude','details','detailsSummary','detailsContent']);
export class DocumentContentError extends Error{constructor(public status:number,message:string,public code='INVALID_SCHEMA'){super(message);}}
function invalid(message:string,status=422,code='INVALID_SCHEMA'):never{throw new DocumentContentError(status,message,code);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))invalid('문서 노드 구조가 올바르지 않습니다.');return value as Record<string,unknown>;}
function attrs(value:unknown,spec:Record<string,unknown>|undefined):Record<string,unknown>{if(value===undefined)return{};const result=object(value);if(Object.keys(result).some(key=>!Object.hasOwn(spec||{},key)))invalid('지원하지 않는 문서 속성입니다.');return result;}
export function hasVersionTwoNodes(value:RichContent):boolean{const pending=[value];while(pending.length){const node=pending.pop()!;if(versionTwoNodes.has(node.type))return true;pending.push(...(node.content||[]));}return false;}

/** Shared canonical shape for manual writes, imported snapshots and live Yjs updates. */
export function normalizeDocumentContent(value:unknown):{content:RichContent;plainText:string}{
  let serialized:string|undefined;try{serialized=JSON.stringify(value);}catch{invalid('문서 내용이 JSON 형식이 아닙니다.');}
  if(!serialized)invalid('문서 내용이 필요합니다.');if(Buffer.byteLength(serialized)>MAX_DOCUMENT_BYTES)invalid('문서 내용이 크기 한도를 초과했습니다.',413,'DOCUMENT_TOO_LARGE');
  let count=0;
  const check=(value:unknown,depth:number)=>{
    if(++count>30000||depth>60)invalid('문서 블록 수 또는 중첩 한도를 초과했습니다.');
    const node=object(value);if(typeof node.type!=='string')invalid('문서 노드 종류가 필요합니다.');const type=schema.nodes[node.type];if(!type)invalid('지원하지 않는 문서 노드입니다.');
    const attributes=attrs(node.attrs,type.spec.attrs);
    if(node.marks!==undefined&&!Array.isArray(node.marks))invalid('문서 서식이 올바르지 않습니다.');
    for(const value of Array.isArray(node.marks)?node.marks:[]){const mark=object(value);if(typeof mark.type!=='string'||!schema.marks[mark.type])invalid('지원하지 않는 문서 서식입니다.');const attributes=attrs(mark.attrs,schema.marks[mark.type].spec.attrs);if(mark.type==='link'&&typeof attributes.href==='string'&&/^(?:javascript|vbscript|data):/i.test(attributes.href.trim()))invalid('지원하지 않는 링크 형식입니다.');}
    if(node.type==='image'&&typeof attributes.src==='string'&&!/^(?:https?:\/\/|\/)/i.test(attributes.src))invalid('이미지는 http(s) 또는 첨부파일 주소를 사용해 주세요.');
    if(node.type==='heading'&&(typeof attributes.level!=='number'||![1,2,3].includes(attributes.level)))invalid('제목 단계는 1~3이어야 합니다.');
    if(['issueReference','documentReference','documentInclude'].includes(node.type)){
      const key=node.type==='issueReference'?'issueId':'documentId',id=attributes[key];
      if(typeof id!=='string'||!id.trim()||id.length>200||/[\u0000-\u001f\u007f]/.test(id))invalid('참조 대상 ID는 1~200자여야 합니다.');
      if(attributes.label!==undefined&&(typeof attributes.label!=='string'||attributes.label.length>300))invalid('참조 이름은 300자 이하여야 합니다.');
    }
    if(node.content!==undefined){if(!Array.isArray(node.content))invalid('문서 블록 목록이 올바르지 않습니다.');for(const child of node.content)check(child,depth+1);}
  };
  check(value,0);
  try{const node=schema.nodeFromJSON(value);if(node.type!==schema.topNodeType)invalid('문서 루트가 올바르지 않습니다.');node.check();const content=node.toJSON() as RichContent;return{content,plainText:documentPlainText(content)};}
  catch(error){if(error instanceof DocumentContentError)throw error;return invalid('지원하지 않는 문서 노드·속성·서식입니다.');}
}

export interface DocumentValidationOptions{allowMissing?:boolean;documents?:DocPage[];issues?:Issue[]}
export class DocumentContentService{
  constructor(private readonly store:Store){}
  normalize(value:unknown){return normalizeDocumentContent(value);}
  validate(documentId:string,content:RichContent,previousContent?:RichContent,options:DocumentValidationOptions={}):void{
    const documents=options.documents??this.store.all<DocPage>('documents'),issues=options.issues??this.store.all<Issue>('issues');
    const documentIds=new Set([...documents.map(document=>document.id),documentId]),issueIds=new Set(issues.map(issue=>issue.id));
    const previous=new Set(contentReferences(previousContent||{type:'doc'}).map(reference=>`${reference.type}:${reference.kind}:${reference.id}`));
    for(const reference of contentReferences(content))if(!(reference.type==='issue'?issueIds:documentIds).has(reference.id)&&!options.allowMissing&&!previous.has(`${reference.type}:${reference.kind}:${reference.id}`))invalid(`참조 대상을 찾을 수 없습니다: ${reference.id}`,422,'REFERENCE_NOT_FOUND');
    const contents=new Map(documents.map(document=>[document.id,document.content]));contents.set(documentId,content);
    const incoming=new Map([...contents.keys()].map(id=>[id,0])),edges=new Map<string,string[]>();
    for(const[id,body]of contents){const targets=[...new Set(contentReferences(body).filter(reference=>reference.kind==='include'&&contents.has(reference.id)).map(reference=>reference.id))];edges.set(id,targets);for(const target of targets)incoming.set(target,incoming.get(target)!+1);}
    const ready=[...incoming].filter(([,degree])=>degree===0).map(([id])=>id);let visited=0;
    for(let cursor=0;cursor<ready.length;cursor++){const id=ready[cursor];visited++;for(const target of edges.get(id)||[]){const degree=incoming.get(target)!-1;incoming.set(target,degree);if(degree===0)ready.push(target);}}
    if(visited!==contents.size)invalid('문서 포함 블록은 자기 자신이나 순환 관계를 포함할 수 없습니다.',422,'INCLUDE_CYCLE');
  }
}
