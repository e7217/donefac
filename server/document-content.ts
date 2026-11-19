import { createEditorSchema } from '../shared/editor-schema.js';
import { contentReferences, documentIssueLists, documentPlainText, MAX_DOCUMENT_ISSUE_LISTS, type DocumentIssueList } from '../shared/document-nodes.js';
import type { DocPage,Issue,RichContent,SavedView } from '../shared/types.js';
import type { Store } from './store.js';

export const MAX_DOCUMENT_BYTES=8*1024*1024;
const schema=createEditorSchema();
export class DocumentContentError extends Error{constructor(public status:number,message:string,public code='INVALID_SCHEMA'){super(message);}}
function invalid(message:string,status=422,code='INVALID_SCHEMA'):never{throw new DocumentContentError(status,message,code);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))invalid('문서 노드 구조가 올바르지 않습니다.');return value as Record<string,unknown>;}
function attrs(value:unknown,spec:Record<string,unknown>|undefined):Record<string,unknown>{if(value===undefined)return{};const result=object(value);if(Object.keys(result).some(key=>!Object.hasOwn(spec||{},key)))invalid('지원하지 않는 문서 속성입니다.');return result;}
function referenceId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}
function referenceLabel(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && value.length <= 300;
}

/** Shared canonical shape for manual writes, imported snapshots and live Yjs updates. */
export function normalizeDocumentContent(value:unknown):{content:RichContent;plainText:string}{
  let serialized:string|undefined;try{serialized=JSON.stringify(value);}catch{invalid('문서 내용이 JSON 형식이 아닙니다.');}
  if(!serialized)invalid('문서 내용이 필요합니다.');if(Buffer.byteLength(serialized)>MAX_DOCUMENT_BYTES)invalid('문서 내용이 크기 한도를 초과했습니다.',413,'DOCUMENT_TOO_LARGE');
  let count=0, issueListCount=0;
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
      if(!referenceId(id))invalid('참조 대상 ID는 1~200자여야 합니다.');
      if(!referenceLabel(attributes.label))invalid('참조 이름은 300자 이하여야 합니다.');
    }
    if (node.type === 'issueList') {
      if (++issueListCount > MAX_DOCUMENT_ISSUE_LISTS) invalid(`문서에 업무 목록을 최대 ${MAX_DOCUMENT_ISSUE_LISTS}개까지 넣을 수 있습니다.`);
      if (!referenceId(attributes.projectId)) invalid('업무 목록의 프로젝트 ID는 1~200자여야 합니다.');
      if (attributes.savedViewId != null && !referenceId(attributes.savedViewId)) invalid('업무 목록의 공유 보기 ID는 1~200자여야 합니다.');
      if (!referenceLabel(attributes.label)) invalid('업무 목록 이름은 300자 이하여야 합니다.');
    }
    if(node.content!==undefined){if(!Array.isArray(node.content))invalid('문서 블록 목록이 올바르지 않습니다.');for(const child of node.content)check(child,depth+1);}
  };
  check(value,0);
  try{const node=schema.nodeFromJSON(value);if(node.type!==schema.topNodeType)invalid('문서 루트가 올바르지 않습니다.');node.check();const content=node.toJSON() as RichContent;return{content,plainText:documentPlainText(content)};}
  catch(error){if(error instanceof DocumentContentError)throw error;return invalid('지원하지 않는 문서 노드·속성·서식입니다.');}
}

interface IssueListTargets {
  hasProject(projectId: string): boolean;
  viewProject(viewId: string): string | undefined;
}

const issueListKey = ({ projectId, savedViewId }: DocumentIssueList) => JSON.stringify([projectId, savedViewId]);

export function validateDocumentIssueLists(contents: Iterable<RichContent>, targets: IssueListTargets, {
  allowMissing = false, previousContent,
}: { allowMissing?: boolean; previousContent?: RichContent } = {}): void {
  const previous = new Set(previousContent ? documentIssueLists(previousContent).map(issueListKey) : []);
  const checked = new Set<string>();
  for (const content of contents) for (const list of documentIssueLists(content)) {
    const key = issueListKey(list);
    if (checked.has(key)) continue;
    checked.add(key);
    const viewProject = list.savedViewId === null ? undefined : targets.viewProject(list.savedViewId);
    if (viewProject !== undefined && viewProject !== list.projectId) {
      invalid('업무 목록의 공유 보기는 같은 프로젝트에 있어야 합니다.', 422, 'ISSUE_LIST_VIEW_PROJECT_MISMATCH');
    }
    if (allowMissing || previous.has(key)) continue;
    if (!targets.hasProject(list.projectId)) invalid('업무 목록의 프로젝트를 찾을 수 없습니다.', 422, 'REFERENCE_NOT_FOUND');
    if (list.savedViewId !== null && viewProject === undefined) invalid('업무 목록의 공유 보기를 찾을 수 없습니다.', 422, 'REFERENCE_NOT_FOUND');
  }
}

export interface DocumentValidationOptions{allowMissing?:boolean;documents?:DocPage[];issues?:Issue[];issueListTargets?:IssueListTargets}
export class DocumentContentService{
  constructor(private readonly store:Store){}
  normalize(value:unknown){return normalizeDocumentContent(value);}
  validate(documentId:string,content:RichContent,previousContent?:RichContent,options:DocumentValidationOptions={}):void{
    const documents=options.documents??this.store.all<DocPage>('documents'),issues=options.issues??this.store.all<Issue>('issues');
    const documentIds=new Set([...documents.map(document=>document.id),documentId]),issueIds=new Set(issues.map(issue=>issue.id));
    const previous=new Set(contentReferences(previousContent||{type:'doc'}).map(reference=>`${reference.type}:${reference.kind}:${reference.id}`));
    for(const reference of contentReferences(content))if(!(reference.type==='issue'?issueIds:documentIds).has(reference.id)&&!options.allowMissing&&!previous.has(`${reference.type}:${reference.kind}:${reference.id}`))invalid(`참조 대상을 찾을 수 없습니다: ${reference.id}`,422,'REFERENCE_NOT_FOUND');
    validateDocumentIssueLists([content], options.issueListTargets ?? {
      hasProject: id => Boolean(this.store.get('projects', id)),
      viewProject: id => this.store.get<SavedView>('saved_views', id)?.projectId,
    }, { allowMissing: options.allowMissing, previousContent });
    const contents=new Map(documents.map(document=>[document.id,document.content]));contents.set(documentId,content);
    const incoming=new Map([...contents.keys()].map(id=>[id,0])),edges=new Map<string,string[]>();
    for(const[id,body]of contents){const targets=[...new Set(contentReferences(body).filter(reference=>reference.kind==='include'&&contents.has(reference.id)).map(reference=>reference.id))];edges.set(id,targets);for(const target of targets)incoming.set(target,incoming.get(target)!+1);}
    const ready=[...incoming].filter(([,degree])=>degree===0).map(([id])=>id);let visited=0;
    for(let cursor=0;cursor<ready.length;cursor++){const id=ready[cursor];visited++;for(const target of edges.get(id)||[]){const degree=incoming.get(target)!-1;incoming.set(target,degree);if(degree===0)ready.push(target);}}
    if(visited!==contents.size)invalid('문서 포함 블록은 자기 자신이나 순환 관계를 포함할 수 없습니다.',422,'INCLUDE_CYCLE');
  }
}
