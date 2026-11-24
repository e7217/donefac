import { createEditorSchema } from '../shared/editor-schema.js';
import { documentChildLists, MAX_DOCUMENT_CHILD_LISTS, normalizeDocumentChildListOptions } from '../shared/document-child-list.js';
import { documentLabelLists, MAX_DOCUMENT_LABEL_LISTS, normalizeDocumentLabelListOptions } from '../shared/document-label-list.js';
import { documentPropertyReportProjectIds, documentPropertyReports, MAX_DOCUMENT_PROPERTY_BLOCKS,
  normalizeDocumentPropertiesOptions, normalizeDocumentPropertyReportOptions } from '../shared/document-properties.js';
import {
  contentReferences, DOCUMENT_TOC_DEFAULTS, documentIssueBlocks, documentPlainText, documentRevisionIncludes,
  isCalloutVariant, isDocumentHeadingLevel, isDocumentTocLayout, isDocumentTocLevel, isIssueSummaryGroupBy, isLiveDocumentInclude, isStatusBadgeLabel, isStatusBadgeTone,
  MAX_CALLOUT_TITLE_LENGTH, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_ISSUE_BLOCKS, MAX_STATUS_BADGE_LABEL_LENGTH, normalizeDocumentColumnLayoutOptions, type DocumentIssueBlockTarget,
} from '../shared/document-nodes.js';
import { isDocumentSectionId } from '../shared/document-sections.js';
import { documentChecklistItemSelection, documentSelectionText } from '../shared/document-selection.js';
import type { DocPage,Issue,RichContent,SavedView } from '../shared/types.js';
import type { Store } from './store.js';
import { includeRevisionOwner } from './document-include-revisions.js';

export { MAX_DOCUMENT_BYTES };
const schema=createEditorSchema();
type SelectionDocument = ReturnType<typeof schema.nodeFromJSON>;
const selectionDocuments = new WeakMap<RichContent, SelectionDocument>();

function readSelectionDocument<Result>(content: RichContent, read: (document: SelectionDocument) => Result | null): Result | null {
  try {
    let document = selectionDocuments.get(content);
    if (!document) {
      document = schema.nodeFromJSON(content);
      selectionDocuments.set(content, document);
    }
    return document.type === schema.topNodeType ? read(document) : null;
  } catch {
    return null;
  }
}

export function readDocumentSelection(content: RichContent, from: number, to: number): string | null {
  return readSelectionDocument(content, document => documentSelectionText(document, from, to));
}

export function readDocumentChecklistItem(content: RichContent, from: number) {
  return readSelectionDocument(content, document => {
    const position = from - 2;
    if (!Number.isSafeInteger(position) || position < 0 || position >= document.content.size) return null;
    const item = document.nodeAt(position);
    return item ? documentChecklistItemSelection(document, item, position) : null;
  });
}

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

function canonicalizeNodeAttributes(node: RichContent) {
  if (node.type === 'heading' && node.attrs?.sectionId === undefined) {
    // ProseMirror's toJSON may share the attribute object with its node.
    const attributes: Record<string, unknown> = Object.assign(Object.create(null), node.attrs);
    delete attributes.sectionId;
    node.attrs = attributes;
  }
  if (node.type === 'taskItem' && node.attrs?.checklistItemId === undefined) {
    const attributes: Record<string, unknown> = Object.assign(Object.create(null), node.attrs);
    delete attributes.checklistItemId;
    node.attrs = attributes;
  }
  if (node.type === 'documentLabelList') node.attrs = { ...normalizeDocumentLabelListOptions(node.attrs)! };
  if (node.type === 'documentChildList') node.attrs = { ...normalizeDocumentChildListOptions(node.attrs)! };
  if (node.type === 'documentProperties') node.attrs = { ...normalizeDocumentPropertiesOptions(node.attrs)! };
  if (node.type === 'documentPropertyReport') node.attrs = { ...normalizeDocumentPropertyReportOptions(node.attrs)! };
  node.content?.forEach(canonicalizeNodeAttributes);
}

/** Shared canonical shape for manual writes, imported snapshots and live Yjs updates. */
export function normalizeDocumentContent(value:unknown):{content:RichContent;plainText:string}{
  let serialized:string|undefined;try{serialized=JSON.stringify(value);}catch{invalid('문서 내용이 JSON 형식이 아닙니다.');}
  if(!serialized)invalid('문서 내용이 필요합니다.');if(Buffer.byteLength(serialized)>MAX_DOCUMENT_BYTES)invalid('문서 내용이 크기 한도를 초과했습니다.',413,'DOCUMENT_TOO_LARGE');
  let count=0, issueBlockCount=0, labelListCount=0, childListCount=0, propertyBlockCount=0;
  const sectionIds = new Set<string>();
  const checklistIds = new Set<string>();
  const check=(value:unknown,depth:number)=>{
    if(++count>30000||depth>60)invalid('문서 블록 수 또는 중첩 한도를 초과했습니다.');
    const node=object(value);if(typeof node.type!=='string')invalid('문서 노드 종류가 필요합니다.');const type=schema.nodes[node.type];if(!type)invalid('지원하지 않는 문서 노드입니다.');
    const attributes=attrs(node.attrs,type.spec.attrs);
    if(node.marks!==undefined&&!Array.isArray(node.marks))invalid('문서 서식이 올바르지 않습니다.');
    for(const value of Array.isArray(node.marks)?node.marks:[]){const mark=object(value);if(typeof mark.type!=='string'||!schema.marks[mark.type])invalid('지원하지 않는 문서 서식입니다.');const attributes=attrs(mark.attrs,schema.marks[mark.type].spec.attrs);if(mark.type==='link'&&typeof attributes.href==='string'&&/^(?:javascript|vbscript|data):/i.test(attributes.href.trim()))invalid('지원하지 않는 링크 형식입니다.');}
    if(node.type==='image'&&typeof attributes.src==='string'&&!/^(?:https?:\/\/|\/)/i.test(attributes.src))invalid('이미지는 http(s) 또는 첨부파일 주소를 사용해 주세요.');
    if (node.type === 'heading') {
      if (!isDocumentHeadingLevel(attributes.level)) invalid('제목 단계는 1~6이어야 합니다.');
      const id = attributes.sectionId;
      if (id !== undefined) {
        if (!isDocumentSectionId(id)) invalid('문서 절 ID는 영문·숫자로 시작하며 영문·숫자·하이픈·밑줄을 사용해 80자 이내여야 합니다.');
        if (sectionIds.has(id)) invalid('한 문서에서 같은 절 ID를 두 번 사용할 수 없습니다.');
        sectionIds.add(id);
      }
    }
    if (node.type === 'taskItem' && attributes.checklistItemId !== undefined) {
      const id = attributes.checklistItemId;
      if (!isDocumentSectionId(id)) invalid('체크리스트 항목 ID는 영문·숫자·하이픈·밑줄로 80자 이내여야 합니다.');
      if (checklistIds.has(id)) invalid('한 문서에서 같은 체크리스트 항목 ID를 두 번 사용할 수 없습니다.');
      checklistIds.add(id);
    }
    if (isLiveDocumentInclude(node.type) || ['issueReference','documentReference','documentRevisionInclude'].includes(node.type)) {
      const key=node.type==='issueReference'?'issueId':'documentId',id=attributes[key];
      if(!referenceId(id))invalid('참조 대상 ID는 1~200자여야 합니다.');
      if(!referenceLabel(attributes.label))invalid('참조 이름은 300자 이하여야 합니다.');
      if(node.type==='documentRevisionInclude'&&!referenceId(attributes.revisionId))invalid('포함할 문서 저장본 ID는 1~200자여야 합니다.');
    }
    if (node.type === 'documentExcerpt' && attributes.hidden !== undefined && typeof attributes.hidden !== 'boolean') {
      invalid('원본 문서의 발췌 표시 설정을 확인해 주세요.');
    }
    if (node.type === 'documentExcerptInclude' && attributes.noPanel !== undefined && typeof attributes.noPanel !== 'boolean') {
      invalid('포함한 발췌의 원본 안내 표시 설정을 확인해 주세요.');
    }
    if (node.type === 'documentColumnLayout' &&
        !normalizeDocumentColumnLayoutOptions(attributes, Array.isArray(node.content) ? node.content.length : 0)) {
      invalid('문서 열의 개수와 너비 비율, 테두리 설정을 확인해 주세요.');
    }
    if (node.type === 'issueList' || node.type === 'issueSummary') {
      const label = node.type === 'issueList' ? '업무 목록' : '업무 현황';
      if (++issueBlockCount > MAX_DOCUMENT_ISSUE_BLOCKS) invalid(`문서에 업무 목록과 업무 현황을 합쳐 최대 ${MAX_DOCUMENT_ISSUE_BLOCKS}개까지 넣을 수 있습니다.`);
      if (!referenceId(attributes.projectId)) invalid(`${label}의 프로젝트 ID는 1~200자여야 합니다.`);
      if (attributes.savedViewId != null && !referenceId(attributes.savedViewId)) invalid(`${label}의 공유 보기 ID는 1~200자여야 합니다.`);
      if (!referenceLabel(attributes.label)) invalid(`${label} 이름은 300자 이하여야 합니다.`);
      if (node.type === 'issueSummary' && attributes.groupBy !== undefined && !isIssueSummaryGroupBy(attributes.groupBy)) invalid('업무 현황의 집계 기준을 확인해 주세요.');
    }
    if (node.type === 'callout') {
      if (attributes.variant !== undefined && !isCalloutVariant(attributes.variant)) invalid('안내 상자 유형을 확인해 주세요.');
      if (attributes.title !== undefined && (typeof attributes.title !== 'string' || attributes.title.length > MAX_CALLOUT_TITLE_LENGTH)) {
        invalid(`안내 상자 제목은 ${MAX_CALLOUT_TITLE_LENGTH}자 이하여야 합니다.`);
      }
    }
    if (node.type === 'statusBadge') {
      if (!isStatusBadgeLabel(attributes.label)) invalid(`상태 배지 이름은 1~${MAX_STATUS_BADGE_LABEL_LENGTH}자여야 합니다.`);
      if (attributes.tone !== undefined && !isStatusBadgeTone(attributes.tone)) invalid('상태 배지 색상을 확인해 주세요.');
    }
    if (node.type === 'documentToc') {
      const { minLevel = DOCUMENT_TOC_DEFAULTS.minLevel, maxLevel = DOCUMENT_TOC_DEFAULTS.maxLevel, layout = DOCUMENT_TOC_DEFAULTS.layout } = attributes;
      if (!isDocumentTocLevel(minLevel) || !isDocumentTocLevel(maxLevel) || minLevel > maxLevel || !isDocumentTocLayout(layout)) {
        invalid('본문 목차의 제목 단계나 표시 방식을 확인해 주세요.');
      }
    }
    if (node.type === 'documentLabelList') {
      if (++labelListCount > MAX_DOCUMENT_LABEL_LISTS) invalid(`문서에 라벨별 문서 목록은 최대 ${MAX_DOCUMENT_LABEL_LISTS}개까지 넣을 수 있습니다.`);
      if (!normalizeDocumentLabelListOptions(attributes)) invalid('라벨별 문서 목록의 범위·라벨·표시 조건을 확인해 주세요.');
    }
    if (node.type === 'documentChildList') {
      if (++childListCount > MAX_DOCUMENT_CHILD_LISTS) invalid(`문서에 하위 문서 목록은 최대 ${MAX_DOCUMENT_CHILD_LISTS}개까지 넣을 수 있습니다.`);
      if (!normalizeDocumentChildListOptions(attributes)) invalid('하위 문서 목록의 범위·깊이·표시 조건을 확인해 주세요.');
    }
    if (node.type === 'documentProperties' || node.type === 'documentPropertyReport') {
      if (++propertyBlockCount > MAX_DOCUMENT_PROPERTY_BLOCKS) invalid(`한 문서에 속성과 속성 보고서를 합쳐 최대 ${MAX_DOCUMENT_PROPERTY_BLOCKS}개까지 넣을 수 있습니다.`);
      if (node.type === 'documentProperties' && !normalizeDocumentPropertiesOptions(attributes)) {
        invalid('문서 속성의 그룹, 항목 이름과 값을 확인해 주세요.');
      }
      if (node.type === 'documentPropertyReport' && !normalizeDocumentPropertyReportOptions(attributes)) {
        invalid('문서 속성 보고서의 범위·라벨·열·표시 조건을 확인해 주세요.');
      }
    }
    if(node.content!==undefined){if(!Array.isArray(node.content))invalid('문서 블록 목록이 올바르지 않습니다.');for(const child of node.content)check(child,depth+1);}
  };
  check(value,0);
  try{const node=schema.nodeFromJSON(value);if(node.type!==schema.topNodeType)invalid('문서 루트가 올바르지 않습니다.');node.check();const content=node.toJSON() as RichContent;canonicalizeNodeAttributes(content);return{content,plainText:documentPlainText(content)};}
  catch(error){if(error instanceof DocumentContentError)throw error;return invalid('지원하지 않는 문서 노드·속성·서식입니다.');}
}

export interface IssueBlockTargets {
  hasProject(projectId: string): boolean;
  viewProject(viewId: string): string | undefined;
}

export function validateDocumentListProjects(contents: Iterable<RichContent>, hasProject: (id: string) => boolean): void {
  const checked = new Set<string>();
  const checkProject = (projectId: string | null, name: string) => {
    if (projectId === null || checked.has(projectId)) return;
    if (!hasProject(projectId)) invalid(`${name}의 프로젝트를 찾을 수 없습니다.`, 422, 'REFERENCE_NOT_FOUND');
    checked.add(projectId);
  };
  for (const content of contents) {
    for (const { projectId } of documentLabelLists(content)) checkProject(projectId, '라벨별 문서 목록');
    for (const report of documentPropertyReports(content)) {
      for (const projectId of documentPropertyReportProjectIds(report)) checkProject(projectId, '문서 속성 보고서');
    }
    for (const { scope, projectId } of documentChildLists(content)) {
      if (scope === 'space') checkProject(projectId, '하위 문서 목록');
    }
  }
}

const issueBlockKey = ({ type, projectId, savedViewId }: DocumentIssueBlockTarget) => JSON.stringify([type, projectId, savedViewId]);

export function validateDocumentIssueBlocks(contents: Iterable<RichContent>, targets: IssueBlockTargets, {
  allowMissing = false, previousContent,
}: { allowMissing?: boolean; previousContent?: RichContent } = {}): void {
  const previous = new Set(previousContent ? documentIssueBlocks(previousContent).map(issueBlockKey) : []);
  const checked = new Set<string>();
  for (const content of contents) for (const block of documentIssueBlocks(content)) {
    const key = issueBlockKey(block);
    if (checked.has(key)) continue;
    checked.add(key);
    const viewProject = block.savedViewId === null ? undefined : targets.viewProject(block.savedViewId);
    const isList = block.type === 'issueList';
    const label = isList ? '업무 목록' : '업무 현황';
    if (viewProject !== undefined && viewProject !== block.projectId) {
      invalid(`${label}의 공유 보기는 같은 프로젝트에 있어야 합니다.`, 422, isList ? 'ISSUE_LIST_VIEW_PROJECT_MISMATCH' : 'ISSUE_SUMMARY_VIEW_PROJECT_MISMATCH');
    }
    if (allowMissing || previous.has(key)) continue;
    if (!targets.hasProject(block.projectId)) invalid(`${label}의 프로젝트를 찾을 수 없습니다.`, 422, 'REFERENCE_NOT_FOUND');
    if (block.savedViewId !== null && viewProject === undefined) invalid(`${label}의 공유 보기를 찾을 수 없습니다.`, 422, 'REFERENCE_NOT_FOUND');
  }
}

type RevisionOwnerLookup = (revisionId: string) => string | undefined;
const pinnedRevisionKey = (pin: { documentId: string; revisionId: string }) => JSON.stringify([pin.documentId, pin.revisionId]);

export function validatePinnedDocumentRevisions(contents: Iterable<RichContent>, ownerOf: RevisionOwnerLookup, {
  allowMissing = false, previousContent,
}: { allowMissing?: boolean; previousContent?: RichContent } = {}): void {
  const previous = new Set(previousContent ? documentRevisionIncludes(previousContent).map(pinnedRevisionKey) : []);
  const owners = new Map<string, string | undefined>();
  for (const content of contents) for (const pin of documentRevisionIncludes(content)) {
    if (!owners.has(pin.revisionId)) owners.set(pin.revisionId, ownerOf(pin.revisionId));
    const owner = owners.get(pin.revisionId);
    if (owner !== undefined && owner !== pin.documentId) invalid('포함하려는 저장본이 해당 문서의 버전이 아닙니다.', 422, 'INCLUDE_REVISION_MISMATCH');
    if (owner === undefined && !allowMissing && !previous.has(pinnedRevisionKey(pin))) {
      invalid('포함할 문서 저장본을 찾을 수 없습니다.', 422, 'REFERENCE_NOT_FOUND');
    }
  }
}

export interface DocumentValidationOptions{allowMissing?:boolean;documents?:DocPage[];issues?:Issue[];issueBlockTargets?:IssueBlockTargets;revisionOwner?:RevisionOwnerLookup}
interface DocumentContentEdit { id: string; content: RichContent; previousContent?: RichContent }
export class DocumentContentService{
  constructor(private readonly store:Store){}
  normalize(value:unknown){return normalizeDocumentContent(value);}
  validate(documentId:string,content:RichContent,previousContent?:RichContent,options:DocumentValidationOptions={}):void{
    this.validateBatch([{ id: documentId, content, previousContent }], options);
  }
  validateBatch(edits: DocumentContentEdit[], options: DocumentValidationOptions = {}): void {
    const documents = options.documents ?? this.store.all<DocPage>('documents');
    const issues = options.issues ?? this.store.all<Issue>('issues');
    const contents = new Map(documents.map(document => [document.id, document.content]));
    const issueIds = new Set(issues.map(issue => issue.id));
    const revisionOwner = options.revisionOwner ?? (id => includeRevisionOwner(this.store, id));
    const issueBlockTargets = options.issueBlockTargets ?? {
      hasProject: id => Boolean(this.store.get('projects', id)),
      viewProject: id => this.store.get<SavedView>('saved_views', id)?.projectId,
    };
    validateDocumentListProjects(edits.map(edit => edit.content), issueBlockTargets.hasProject);
    for (const { id, content } of edits) contents.set(id, content);
    for (const { content, previousContent } of edits) {
      const previous = new Set(contentReferences(previousContent ?? { type: 'doc' })
        .filter(reference => !reference.revisionId).map(reference => `${reference.type}:${reference.kind}:${reference.id}`));
      for (const reference of contentReferences(content)) {
        const targets = reference.type === 'issue' ? issueIds : contents;
        if (!reference.revisionId && !targets.has(reference.id) && !options.allowMissing && !previous.has(`${reference.type}:${reference.kind}:${reference.id}`)) {
          invalid(`참조 대상을 찾을 수 없습니다: ${reference.id}`, 422, 'REFERENCE_NOT_FOUND');
        }
      }
      const previousOptions = { allowMissing: options.allowMissing, previousContent };
      validatePinnedDocumentRevisions([content], revisionOwner, previousOptions);
      validateDocumentIssueBlocks([content], issueBlockTargets, previousOptions);
    }
    const incoming=new Map([...contents.keys()].map(id=>[id,0])),edges=new Map<string,string[]>();
    for(const[id,body]of contents){const targets=[...new Set(contentReferences(body).filter(reference=>reference.kind==='include'&&!reference.revisionId&&contents.has(reference.id)).map(reference=>reference.id))];edges.set(id,targets);for(const target of targets)incoming.set(target,incoming.get(target)!+1);}
    const ready=[...incoming].filter(([,degree])=>degree===0).map(([id])=>id);let visited=0;
    for(let cursor=0;cursor<ready.length;cursor++){const id=ready[cursor];visited++;for(const target of edges.get(id)||[]){const degree=incoming.get(target)!-1;incoming.set(target,degree);if(degree===0)ready.push(target);}}
    if(visited!==contents.size)invalid('문서 포함 블록은 자기 자신이나 순환 관계를 포함할 수 없습니다.',422,'INCLUDE_CYCLE');
  }
}
