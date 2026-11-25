import { createHash } from 'node:crypto';
import type { LegacyDataset,LegacyRecord,LegacyRecordKind,LegacyValue } from '../shared/types.js';
import { decodeLegacyText,parseLegacyXml,type LegacyXmlNode } from './legacy-import-archive.js';
import { addRecord,diagnostic,emptyDataset,LEGACY_MAX_TEXT_BYTES,LegacyImportError,record } from './legacy-import-model.js';

/** Analysis only. Storage XML is never rendered, converted, fetched or executed here. */
type XmlObject={node:LegacyXmlNode;type:string;id:string};
const CONTENT_TYPES=new Set(['Page','BlogPost','Comment','Attachment','UserInfo','SpaceDescription']);
const RELATION_TYPES=new Set(['ContentPermissionSet','ContentPermission','SpacePermission','Labelling','ContentLabel','OutgoingLink','ReferralLink','ContentRelation','Relation']);
const inlineCommentPropertyNames = ['inline-comment', 'inline-marker-ref', 'inline-original-selection'] as const;
type InlineCommentPropertyName = typeof inlineCommentPropertyNames[number];
const KNOWN_MACROS=new Set(['include','excerpt-include','excerpt','jira','jiraissues','toc','anchor','children','contentbylabel','code','noformat','info','note','warning','tip','panel','expand','details','status','tasklist','section','column','html','widget','attachments','gallery','recently-updated','pagetree','page-properties','page-properties-report','viewpdf','viewdoc','viewxls','viewppt']);
const scalar=(node:LegacyXmlNode|undefined):string=>node?.text??'';
const child=(node:LegacyXmlNode,name:string,attribute?:string,value?:string)=>node.children.find(item=>item.name===name&&(attribute===undefined||item.attributes[attribute]===value));
const property=(node:LegacyXmlNode,name:string)=>child(node,'property','name',name);
const collection=(node:LegacyXmlNode,name:string)=>child(node,'collection','name',name);
const prop=(node:LegacyXmlNode,name:string):string=>scalar(property(node,name));
const idOf=(node:LegacyXmlNode|undefined):string=>node?scalar(child(node,'id')).trim():'';
const ref=(node:LegacyXmlNode,name:string):string=>idOf(property(node,name));
const refs=(node:LegacyXmlNode,name:string):string[]=>collection(node,name)?.children.map(idOf).filter(Boolean)??[];
const objectClass=(node:LegacyXmlNode):string=>(node.attributes.class??'').split('.').pop()??'';
const nullString=(value:string):string|null=>value||null;
const referenceIndexes=new WeakMap<LegacyRecord,Set<string>>();
function xmlObjects(root:LegacyXmlNode):LegacyXmlNode[]{
  const result:LegacyXmlNode[]=[],stack=[root];
  while(stack.length){const node=stack.pop()!;if(node.name==='object'){result.push(node);continue;}for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);}
  return result;
}
function walk(root:LegacyXmlNode,visit:(node:LegacyXmlNode)=>void):void{
  const stack=[root];while(stack.length){const node=stack.pop()!;visit(node);for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);}
}
function addReference(row:LegacyRecord,kind:LegacyRecordKind,sourceId:string,relation:string):void{
  if(!sourceId)return;let index=referenceIndexes.get(row);if(!index){index=new Set(row.references.map(item=>JSON.stringify([item.kind,item.sourceId,item.relation])));referenceIndexes.set(row,index);}const key=JSON.stringify([kind,sourceId,relation]);if(!index.has(key)){row.references.push({kind,sourceId,relation});index.add(key);}
}
function primitiveProperties(node:LegacyXmlNode,names:string[]):{[key:string]:LegacyValue}{
  const result:{[key:string]:LegacyValue}={};for(const name of names){const item=property(node,name);if(item&&!item.children.length)result[name]=item.text;}return result;
}
function exportProperties(files:Map<string,Buffer>,prefix:string):Map<string,string>{
  const result=new Map<string,string>();
  const descriptor=files.get(`${prefix}exportDescriptor.properties`);if(!descriptor)return result;
  // Only these source descriptors are inspected. Configuration and credentials are not copied.
  const allowed=new Set(['buildNumber','version','confluence.version','createdByBuildNumber','timezone','timeZone','serverTimeZone']);
  for(const line of decodeLegacyText(descriptor).split(/\r?\n/)){if(/^\s*[#!]/.test(line))continue;const match=/^\s*([^=:\s]+)\s*[:=]\s*(.*?)\s*$/.exec(line);if(match&&allowed.has(match[1])&&match[2].length<=100)result.set(match[1],match[2]);}
  return result;
}

export function parseConfluence(files:Map<string,Buffer>,instanceKey:string):LegacyDataset{
  const primary=[...files.keys()].filter(path=>/(^|\/)entities\.xml$/i.test(path));
  if(primary.length!==1)throw new LegacyImportError(400,primary.length?'entities.xml이 여러 개여서 분석 대상을 확정할 수 없습니다.':'Confluence 내보내기에 entities.xml이 없습니다.');
  const xmlPath=primary[0],prefix=xmlPath.slice(0,-'entities.xml'.length),descriptor=exportProperties(files,prefix);
  const data=emptyDataset({product:'confluence',format:'confluence-xml',instanceKey,declaredVersion:descriptor.get('confluence.version')??descriptor.get('version')??null,timezone:descriptor.get('timezone')??descriptor.get('timeZone')??descriptor.get('serverTimeZone')??null});
  const parsed=parseLegacyXml(decodeLegacyText(files.get(xmlPath)!));
  const rawObjects=xmlObjects(parsed);
  const objects:XmlObject[]=[],objectIndex=new Map<string,XmlObject>(),byType=new Map<string,XmlObject[]>(),unsupported=new Map<string,number>();
  for(const node of rawObjects){
    const type=objectClass(node)||'(missing class)',id=idOf(node);
    if(type==='ContentProperty'&&inlineCommentProperties(node).length)continue;
    if(type!=='ConfluenceUserImpl'&&type!=='Space'&&type!=='BodyContent'&&type!=='Label'&&!CONTENT_TYPES.has(type)&&!RELATION_TYPES.has(type)){unsupported.set(type,(unsupported.get(type)??0)+1);continue;}
    if(!id){diagnostic(data,{severity:'error',code:'CONFLUENCE_OBJECT_ID_MISSING',message:`${type} 객체의 원본 ID가 없습니다.`,path:xmlPath});continue;}
    const names=new Set<string>();for(const item of node.children){if(!['id','property','collection'].includes(item.name))continue;const name=`${item.name}:${item.attributes.name??''}`;if(names.has(name))throw new LegacyImportError(400,'Confluence 객체에 같은 이름의 속성이 중복되었습니다.');names.add(name);}
    const key=`${type}:${id}`;if(objectIndex.has(key))throw new LegacyImportError(400,'동일 클래스와 ID의 Confluence 객체가 중복되었습니다.');
    const object={node,type,id};objects.push(object);objectIndex.set(key,object);const list=byType.get(type)??[];list.push(object);byType.set(type,list);
  }
  if(!objects.length)throw new LegacyImportError(400,'entities.xml에서 Confluence 객체를 찾을 수 없습니다.');
  const rows=new Map<string,LegacyRecord>(),pageByTitle=new Map<string,string[]>(),currentByHistory=new Map<string,string>();
  const historyRecordId=(type:string,id:string)=>type==='Comment'?`comment:${id}`:type==='Attachment'?`attachment:${id}`:`revision:${id}`;
  const mapHistory=(type:string)=>{for(const item of byType.get(type)??[])for(const historyId of refs(item.node,'historicalVersions')){
    const key=`${type}:${historyId}`,previous=currentByHistory.get(key);
    if(previous&&previous!==item.id)diagnostic(data,{severity:'error',code:'CONFLUENCE_HISTORY_AMBIGUOUS',message:'과거 버전이 둘 이상의 현재 객체에 연결되어 있습니다.',recordId:historyRecordId(type,historyId),path:xmlPath});
    else currentByHistory.set(key,item.id);
  }};
  for(const type of CONTENT_TYPES)mapHistory(type);
  for(const item of objects){const original=ref(item.node,'originalVersion');if(original&&original!==item.id){const key=`${item.type}:${item.id}`,previous=currentByHistory.get(key);if(previous&&previous!==original)diagnostic(data,{severity:'error',code:'CONFLUENCE_HISTORY_AMBIGUOUS',message:'historicalVersions와 originalVersion의 연결 대상이 다릅니다. 원본 관계를 보존했으며 현재 버전을 임의로 합치지 않았습니다.',recordId:historyRecordId(item.type,item.id),path:xmlPath});else currentByHistory.set(key,original);}}
  const historyChecked=new Set<string>();for(const start of currentByHistory.keys()){
    const seen=new Set<string>();let key=start;while(currentByHistory.has(key)&&!historyChecked.has(key)){if(seen.has(key)){diagnostic(data,{severity:'error',code:'CONFLUENCE_HISTORY_CYCLE',message:'문서 또는 첨부의 버전 관계가 순환합니다. 원본 버전 연결을 검토해야 합니다.',path:xmlPath});break;}seen.add(key);key=`${key.slice(0,key.indexOf(':'))}:${currentByHistory.get(key)!}`;}for(const id of seen)historyChecked.add(id);
  }
  const kindFor=(type:string,id:string):LegacyRecordKind=>type==='ConfluenceUserImpl'||type==='UserInfo'?'identity':type==='Space'?'project':type==='Attachment'?'attachment':type==='Comment'?'comment':currentByHistory.has(`${type}:${id}`)||prop(objectIndex.get(`${type}:${id}`)?.node??parsed,'contentStatus')==='historical'?'revision':'page';
  const sourceIdFor=(type:string,id:string):string=>type==='UserInfo'?`UserInfo:${id}`:id;
  const contentRef=(row:LegacyRecord,type:string,id:string,relation:string)=>addReference(row,kindFor(type,id),sourceIdFor(type,id),relation);
  for(const item of objects){
    const {node,type,id}=item;
    if(type==='BodyContent'||type==='Label'||RELATION_TYPES.has(type))continue;
    const kind=kindFor(type,id),sourceId=sourceIdFor(type,id),spaceId=ref(node,'space'),parent=ref(node,'parent')||ref(node,'parentComment');
    const row=record(kind,sourceId,{title:prop(node,'title')||prop(node,'name')||prop(node,'username')||prop(node,'userName'),containerId:nullString(spaceId),parentId:nullString(parent),authorId:nullString(ref(node,'creator')||prop(node,'creatorName')),createdAt:nullString(prop(node,'creationDate')),updatedAt:nullString(prop(node,'lastModificationDate')),metadata:{sourceClass:type,originalId:id,...primitiveProperties(node,['version','contentStatus','versionComment','position','fileName','contentType','fileSize','mediaType','size','spaceType','key','name','username','userName','lowerName','displayName','email','emailAddress'])}});
    if (type === 'ConfluenceUserImpl') {
      row.title = prop(node, 'displayName') || prop(node, 'name');
      row.authorId = null;
      const ids = node.children.filter(value => value.name === 'id');
      const [account] = ids;
      if (exactClass(node, 'ConfluenceUserImpl') && ids.length === 1 && account.attributes.name === 'key' &&
          Object.keys(account.attributes).length === 1 && !account.children.length && account.text === id &&
          id.length <= 500 && id.isWellFormed() && !/\p{Cc}/u.test(id)) {
        row.metadata.migrationAccountKey = id;
        row.metadata.migrationAccountKind = 'confluence-user-key';
      }
    }
    if(type==='Attachment')row.title=prop(node,'title')||prop(node,'fileName');
    if(type==='Space'){row.title=prop(node,'name');row.metadata.spaceKey=prop(node,'key');row.containerId=null;const home=ref(node,'homePage');if(home)addReference(row,'page',home,'home-page');}
    if(type==='UserInfo'){row.title=prop(node,'username')||prop(node,'userName')||row.title;row.metadata.profileContent=true;}
    const modifier=ref(node,'lastModifier')||prop(node,'lastModifierName');if(modifier){row.metadata.lastModifierId=modifier;addReference(row,'identity',modifier,'last-modifier');}
    if(row.authorId)addReference(row,'identity',row.authorId,'creator');
    if(spaceId)addReference(row,'project',spaceId,'space');
    if(parent)contentRef(row,type==='Comment'?'Comment':'Page',parent,'parent');
    const current=currentByHistory.get(`${type}:${id}`);if(current){row.metadata.currentVersionId=current;contentRef(row,type,current,'current-version');}
    const original=ref(node,'originalVersion');if(original){row.metadata.originalVersionId=original;contentRef(row,type,original,'original-version');}
    const historicalIds=refs(node,'historicalVersions');if(historicalIds.length){row.metadata.historicalVersionIds=historicalIds;for(const historyId of historicalIds)contentRef(row,type,historyId,'historical-version');}
    const ancestors=refs(node,'ancestors');if(ancestors.length){row.metadata.ancestorIds=ancestors;for(const ancestor of ancestors)addReference(row,'page',ancestor,'ancestor');}
    if(type==='Page'&&kind==='page'){
      const parentEvidence=confluencePageParentEvidence(node,id);
      if(parentEvidence!==undefined)row.metadata.confluenceParentSourceId=parentEvidence;
    }
    if(type==='Comment'||type==='Attachment'){
      const ownerNode=property(node,'containerContent')??property(node,'content')??property(node,'page'),ownerId=idOf(ownerNode),ownerType=ownerNode?objectClass(ownerNode)||'Page':'Page';
      if(ownerId){row.containerId=ownerId;row.metadata.containerClass=ownerType;contentRef(row,ownerType,ownerId,'container-content');}
      else diagnostic(data,{severity:'error',code:'CONFLUENCE_CONTAINER_MISSING',message:'댓글 또는 첨부의 소유 콘텐츠를 확인할 수 없습니다.',recordId:row.id,path:xmlPath});
    }
    addRecord(data,row);rows.set(`${type}:${id}`,row);
    if((type==='Page'||type==='BlogPost')&&kind==='page'){const key=`${spaceId}\u0000${row.title}`,ids=pageByTitle.get(key)??[];ids.push(id);pageByTitle.set(key,ids);}
  }
  // The remainder resolves content bodies, labels, permissions, links and binary package paths.
  attachBodies(data,byType,rows,objectIndex,xmlPath);
  attachCommentParentEvidence(data,byType.get('Comment')??[],rows,objectIndex,xmlPath);
  attachInlineCommentProperties(data,rawObjects,rows,xmlPath);
  attachLabels(data,byType,rows,objectIndex,xmlPath);
  attachRelations(data,byType,rows,objectIndex,kindFor,sourceIdFor,xmlPath);
  attachBinaries(data,files,prefix,byType,rows,currentByHistory,xmlPath);
  linkProfiles(data,byType,rows,xmlPath);
  const context=storageContext(data.records,byType,pageByTitle);
  for(const row of data.records)if(row.textFormat==='confluence-storage'){
    if(Buffer.byteLength(row.text)>LEGACY_MAX_TEXT_BYTES)throw new LegacyImportError(413,'개별 Confluence 본문은16MiB 이하여야 합니다.');
    analyzeStorage(data,row,context,xmlPath);
  }
  data.unsupported=[...unsupported].map(([type,count])=>({type,count})).sort((a,b)=>a.type.localeCompare(b.type));
  for(const item of data.unsupported)diagnostic(data,{severity:'warning',code:'CONFLUENCE_UNSUPPORTED_OBJECT',message:`지원하지 않는 ${item.type} 객체 ${item.count}개는 종류와 개수만 분석했습니다.`,path:xmlPath});
  if(!data.source.timezone&&data.records.some(item=>item.createdAt||item.updatedAt))diagnostic(data,{severity:'warning',code:'CONFLUENCE_TIMEZONE_UNKNOWN',message:'내보내기에 시간대가 없어 원본 시각 문자열을 그대로 보존했습니다. 적용 전에 원본 서버 시간대를 지정해야 합니다.',path:xmlPath});
  diagnostic(data,{severity:'info',code:'CONFLUENCE_ANALYSIS_ONLY',message:'분석 전용입니다. 원본 storage XML을 보존했으며 문서·매크로·권한·사용자를 새 서비스에 적용하지 않았습니다.',path:xmlPath});
  // Resolution mutates records after their initial insertion; recheck final text/metadata/ref bounds.
  const checked=emptyDataset(data.source);for(const value of data.records)addRecord(checked,value);
  return data;
}

function attachBodies(data:LegacyDataset,byType:Map<string,XmlObject[]>,rows:Map<string,LegacyRecord>,objects:Map<string,XmlObject>,path:string):void{
  const owners=new Map<string,XmlObject[]>(),collectionOwners=new Map<string,XmlObject[]>();
  for(const item of objects.values())if(CONTENT_TYPES.has(item.type))for(const bodyId of refs(item.node,'bodyContents')){const values=collectionOwners.get(bodyId)??[];values.push(item);collectionOwners.set(bodyId,values);}
  for(const body of byType.get('BodyContent')??[]){
    const ownerNode=property(body.node,'content'),ownerId=idOf(ownerNode),ownerType=ownerNode?objectClass(ownerNode):'';
    let key=ownerType&&ownerId?`${ownerType}:${ownerId}`:'';
    if(!key){const candidates=collectionOwners.get(body.id)??[];if(candidates.length===1)key=`${candidates[0].type}:${candidates[0].id}`;}
    const declaredOwners=collectionOwners.get(body.id)??[];
    if(key&&declaredOwners.some(item=>`${item.type}:${item.id}`!==key))diagnostic(data,{severity:'error',code:'CONFLUENCE_BODY_RELATION_CONFLICT',message:'본문의 content 참조와 bodyContents 소유 관계가 서로 다릅니다. 본문을 임의로 다른 문서에 배정하지 않았습니다.',recordId:rows.get(key)?.id,path});
    const owner=rows.get(key);
    if(!owner){const orphan=record('revision',`BodyContent:${body.id}`,{text:prop(body.node,'body'),textFormat:'confluence-storage',metadata:{sourceClass:'BodyContent',originalId:body.id,ownerId:ownerId||null,ownerClass:ownerType||null,bodyType:prop(body.node,'bodyType'),orphan:true}});addRecord(data,orphan);diagnostic(data,{severity:'error',code:'CONFLUENCE_BODY_OWNER_MISSING',message:'본문의 소유 콘텐츠가 패키지에 없거나 관계가 불명확합니다. 원문을 별도로 보존했습니다.',recordId:orphan.id,path});continue;}
    const list=owners.get(key)??[];list.push(body);owners.set(key,list);
  }
  for(const [key,list]of owners){const row=rows.get(key)!;row.textFormat='confluence-storage';row.metadata.bodyContentIds=list.map(body=>body.id);
    if (list.length === 1) {
      const body = property(list[0].node, 'body');
      row.text = scalar(body);
      row.metadata.bodyType = prop(list[0].node, 'bodyType');
      if (body) row.metadata.bodyPresent = true;
    }
    else{row.metadata.bodyContents=list.map(body=>({id:body.id,bodyType:prop(body.node,'bodyType'),text:prop(body.node,'body')}));for(const body of list)addRecord(data,record('revision',`BodyContent:${body.id}`,{text:prop(body.node,'body'),textFormat:'confluence-storage',metadata:{sourceClass:'BodyContent',originalId:body.id,bodyType:prop(body.node,'bodyType'),bodyVariant:true},references:[{kind:row.kind,sourceId:row.sourceId,relation:'body-owner'}]}));diagnostic(data,{severity:'error',code:'CONFLUENCE_MULTIPLE_BODIES',message:'한 콘텐츠에 여러 본문 객체가 있어 원문들을 별도로 보존했습니다. 적용할 본문을 임의로 선택하지 않았습니다.',recordId:row.id,path});}
    for(const body of list)if(property(body.node,'body')?.children.length)diagnostic(data,{severity:'error',code:'CONFLUENCE_NON_SCALAR_BODY',message:'본문이 CDATA/문자열이 아닌 XML 자식 요소로 저장되어 원문 속성 값을 정확하게 복원할 수 없습니다.',recordId:row.id,path});
  }
  for(const [key,row]of rows){const type=key.slice(0,key.indexOf(':'));if(CONTENT_TYPES.has(type)&&type!=='Attachment'&&!owners.has(key))diagnostic(data,{severity:'warning',code:'CONFLUENCE_BODY_MISSING',message:'콘텐츠의 BodyContent 객체가 패키지에 없습니다.',recordId:row.id,path});}
}

const labelAssociationTypes = new Set(['Labelling', 'ContentLabel']);

function exactNamedId(id: LegacyXmlNode | undefined): string {
  return id?.name === 'id' && id.attributes.name === 'id' && Object.keys(id.attributes).length === 1 && !id.children.length ? id.text.trim() : '';
}

function exactObjectId(node: LegacyXmlNode): string {
  const ids = node.children.filter(item => item.name === 'id');
  return ids.length === 1 ? exactNamedId(ids[0]) : '';
}

function exactReferenceId(node: LegacyXmlNode | undefined): string {
  if (!node || node.text.trim() || node.children.length !== 1) return '';
  if (Object.keys(node.attributes).some(name => name !== 'class' && name !== 'package' && name !== 'name')) return '';
  return exactNamedId(node.children[0]);
}

const confluenceNumericId = /^[1-9]\d{0,18}$/u;
const confluenceCollectionClasses = new Set(['java.util.List', 'java.util.Collection', 'java.util.Set']);

function inlineCommentProperties(node: LegacyXmlNode): InlineCommentPropertyName[] {
  return node.children.flatMap(child => {
    if (child.name !== 'property' || child.attributes.name !== 'name') return [];
    return inlineCommentPropertyNames.filter(name => name === child.text.trim());
  });
}

const confluenceClassPackages = {
  BlogPost: 'com.atlassian.confluence.pages', Comment: 'com.atlassian.confluence.pages', Page: 'com.atlassian.confluence.pages',
  ContentProperty: 'com.atlassian.confluence.content', Space: 'com.atlassian.confluence.spaces', ConfluenceUserImpl: 'com.atlassian.confluence.user',
  ContentPermission: 'com.atlassian.confluence.security', ContentPermissionSet: 'com.atlassian.confluence.security',
};

function exactClass(node: LegacyXmlNode, type: keyof typeof confluenceClassPackages): boolean {
  const expectedPackage = confluenceClassPackages[type];
  const { class: sourceClass, package: sourcePackage } = node.attributes;
  return (sourceClass === type || sourceClass === `${expectedPackage}.${type}`) &&
    (sourcePackage === undefined || sourcePackage === expectedPackage);
}

function exactCommentContainer(comment: LegacyXmlNode): { type: 'Page' | 'BlogPost'; id: string } | undefined {
  const containers = comment.children.filter(child => ['containerContent', 'content', 'page'].includes(child.attributes.name));
  const owner = containers[0];
  if (!owner) return;
  const type = objectClass(owner), id = exactReferenceId(owner);
  if ((type === 'Page' || type === 'BlogPost') && confluenceNumericId.test(id) &&
    containers.every(container => container.name === 'property' && exactClass(container, type) && exactReferenceId(container) === id)) return { type, id };
}

function exactCurrentComment(node: LegacyXmlNode, row: LegacyRecord): boolean {
  const status = property(node, 'contentStatus');
  return exactClass(node, 'Comment') && confluenceNumericId.test(row.sourceId) && exactObjectId(node) === row.sourceId &&
    (!status || !status.children.length && ['', 'current'].includes(status.text.trim().toLowerCase())) &&
    !row.metadata.currentVersionId && (!row.metadata.originalVersionId || row.metadata.originalVersionId === row.sourceId);
}

function explicitNullReference(node: LegacyXmlNode): boolean {
  if (node.text.trim()) return false;
  const [value] = node.children;
  return !value || node.children.length === 1 && value.name === 'null' && !value.text.trim() &&
    !value.children.length && !Object.keys(value.attributes).length;
}

function explicitRootCommentParent(field: LegacyXmlNode): boolean {
  return field.name === 'property' && explicitNullReference(field) &&
    (Object.keys(field.attributes).length === 1 || exactClass(field, 'Comment') &&
      Object.keys(field.attributes).every(name => ['name', 'class', 'package'].includes(name)));
}

function attachCommentParentEvidence(data: LegacyDataset, comments: XmlObject[], rows: Map<string, LegacyRecord>,
  objects: Map<string, XmlObject>, path: string): void {
  for (const comment of comments) {
    const row = rows.get(`Comment:${comment.id}`);
    if (!row) continue;
    const owner = exactCurrentComment(comment.node, row) ? exactCommentContainer(comment.node) : undefined;
    if (owner) row.metadata.confluenceCommentPageSourceId = owner.id;
    const parentFields = comment.node.children.filter(child => child.attributes.name === 'parent' || child.attributes.name === 'parentComment');
    if (parentFields.every(explicitRootCommentParent)) continue;
    const parentId = exactReferenceId(parentFields[0]);
    const parentKey = `Comment:${parentId}`;
    const parent = objects.get(parentKey);
    const parentRow = rows.get(parentKey);
    const parentOwner = parent && exactCommentContainer(parent.node);
    if (owner && confluenceNumericId.test(parentId) &&
      parentId !== row.sourceId && parentId === row.parentId && parentFields.every(field =>
        field.name === 'property' && exactClass(field, 'Comment') && exactReferenceId(field) === parentId) &&
      (!parent || parentRow && exactCurrentComment(parent.node, parentRow) && parentOwner?.id === owner.id && parentOwner.type === owner.type)) {
      row.metadata.confluenceParentCommentSourceId = parentId;
    } else {
      row.metadata.confluenceCommentParentUnresolved = true;
      diagnostic(data, { severity: 'warning', code: 'CONFLUENCE_COMMENT_PARENT_EVIDENCE_UNRESOLVED',
        message: '답글의 원본 댓글과 소유 문서 관계를 확인할 수 없어 댓글 본문과 원본 관계만 보관합니다.', recordId: row.id, path });
    }
  }
}

function scalarInlineProperty(node: LegacyXmlNode, name: string): string | undefined | null {
  const values = node.children.filter(child => child.name === 'property' && child.attributes.name === name);
  if (!values.length) return undefined;
  const [value] = values;
  return values.length === 1 && !value.children.length && Object.keys(value.attributes).length === 1 ? value.text : null;
}

function inlineCommentPropertyValue(node: LegacyXmlNode, name: InlineCommentPropertyName): string | null {
  if (scalarInlineProperty(node, 'name') !== name) return null;
  const stringValue = scalarInlineProperty(node, 'stringValue');
  const longValue = scalarInlineProperty(node, 'longValue');
  if (stringValue === null || longValue === null) return null;
  if (name === 'inline-comment') {
    const status = (value: string) => ['1', 'true', 'inline'].includes(value.toLowerCase()) ? 'true'
      : ['0', 'false', 'footer'].includes(value.toLowerCase()) ? 'false' : null;
    const values = [stringValue, longValue].filter((value): value is string => Boolean(value)).map(status);
    return values.length && values.every(value => value === values[0]) ? values[0] : null;
  }
  if (!stringValue?.trim() || !stringValue.isWellFormed() || longValue) return null;
  if (name === 'inline-marker-ref') return stringValue.length <= 200 && !/[\s\p{Cc}\p{Cf}]/u.test(stringValue) ? stringValue : null;
  return stringValue.length <= 2_000 ? stringValue : null;
}

function attachInlineCommentProperties(data: LegacyDataset, objects: LegacyXmlNode[], rows: Map<string, LegacyRecord>, path: string): void {
  type Claim = { ownerKey: string; exact: boolean };
  const properties = new Map<string, LegacyXmlNode[]>();
  for (const node of objects) if (objectClass(node) === 'ContentProperty') {
    const id = idOf(node);
    const matches = properties.get(id) ?? [];
    matches.push(node);
    properties.set(id, matches);
  }
  const relevantIds = new Set([...properties].filter(([, nodes]) => nodes.some(node => inlineCommentProperties(node).length)).map(([id]) => id));
  if (!relevantIds.size) return;

  // Other content types can claim the same property ID. Include them in the ownership check.
  const claims = new Map<string, Claim[]>(), exactComments = new Set<string>();
  for (const owner of objects) {
    const collections = owner.children.filter(child => child.name === 'collection' && child.attributes.name === 'contentProperties');
    const ownerType = objectClass(owner);
    if (!collections.length && ownerType !== 'Comment') continue;
    const ownerId = idOf(owner);
    const ownerKey = `${ownerType}:${ownerId}`;
    const exactOwner = confluenceNumericId.test(ownerId) && exactObjectId(owner) === ownerId;
    if (ownerType === 'Comment' && exactOwner && exactClass(owner, 'Comment') && exactCommentContainer(owner)) exactComments.add(ownerId);
    for (const declared of collections) {
      const exactCollection = collections.length === 1 && !declared.text.trim() && !property(owner, 'contentProperties') &&
        Object.keys(declared.attributes).every(name => name === 'class' || name === 'name') &&
        (!declared.attributes.class || confluenceCollectionClasses.has(declared.attributes.class));
      for (const element of declared.children) {
        const propertyId = idOf(element);
        if (!relevantIds.has(propertyId)) continue;
        const exact = exactCollection && exactOwner && element.name === 'element' &&
          exactClass(element, 'ContentProperty') && exactReferenceId(element) === propertyId;
        const references = claims.get(propertyId) ?? [];
        references.push({ ownerKey, exact });
        claims.set(propertyId, references);
      }
    }
  }

  const evidence = new Map<LegacyRecord, Map<InlineCommentPropertyName, (string | null)[]>>();
  const unresolved = (row: LegacyRecord | undefined) => diagnostic(data, { severity: 'warning', code: 'CONFLUENCE_INLINE_COMMENT_EVIDENCE_UNRESOLVED',
    message: '문장 댓글의 원본 속성 또는 소유 관계를 확인할 수 없어 확인된 정보만 이관합니다.', recordId: row?.id, path });
  for (const id of relevantIds) {
    const nodes = properties.get(id)!;
    const forward = claims.get(id) ?? [];
    for (const node of nodes) {
      const names = inlineCommentProperties(node);
      if (!names.length) continue;
      const reverseNodes = node.children.filter(child => child.name === 'property' &&
        (child.attributes.name === 'contentEntity' || child.attributes.name === 'content'));
      const reverse = reverseNodes.map(child => {
        const ownerId = idOf(child);
        return { ownerKey: `${objectClass(child)}:${ownerId}`, exact: exactClass(child, 'Comment') &&
          confluenceNumericId.test(ownerId) && exactReferenceId(child) === ownerId };
      });
      const owners = new Set([...forward, ...reverse].map(claim => claim.ownerKey));
      const rowsClaimed = [...owners].filter(key => key.startsWith('Comment:')).flatMap(key => {
        const row = rows.get(key);
        return row ? [row] : [];
      });
      const exact = confluenceNumericId.test(id) && exactObjectId(node) === id && exactClass(node, 'ContentProperty') &&
        nodes.length === 1 && names.length === 1 && owners.size === 1 && forward.length <= 1 &&
        [...forward, ...reverse].every(claim => claim.exact) && new Set(reverseNodes.map(child => child.attributes.name)).size === reverseNodes.length;
      if (!rowsClaimed.length) {
        unresolved(undefined);
        continue;
      }
      for (const row of rowsClaimed) {
        const fields = evidence.get(row) ?? new Map<InlineCommentPropertyName, (string | null)[]>();
        for (const name of names) {
          const values = fields.get(name) ?? [];
          values.push(exact && exactComments.has(row.sourceId) ? inlineCommentPropertyValue(node, name) : null);
          fields.set(name, values);
        }
        evidence.set(row, fields);
      }
    }
  }

  for (const [row, fields] of evidence) {
    const value = (name: InlineCommentPropertyName) => {
      const values = fields.get(name);
      return values?.length === 1 ? values[0] : null;
    };
    const marker = value('inline-marker-ref');
    const inline = value('inline-comment');
    if (!marker || (fields.has('inline-comment') && inline !== 'true')) {
      if (inline !== 'false' || fields.has('inline-marker-ref') || fields.has('inline-original-selection')) unresolved(row);
      continue;
    }
    row.metadata.confluenceInlineMarkerRef = marker;
    const originalSelection = value('inline-original-selection');
    if (originalSelection !== null) row.metadata.confluenceInlineOriginalSelection = originalSelection;
    else if (fields.has('inline-original-selection')) unresolved(row);
  }
}

function exactHierarchyReference(node: LegacyXmlNode | undefined, type: 'Page' | 'Space'): string | undefined {
  if (!node || !exactClass(node, type)) return;
  const id = exactReferenceId(node);
  return confluenceNumericId.test(id) ? id : undefined;
}

function confluencePageParentEvidence(node: LegacyXmlNode, id: string): string | null | undefined {
  const status = property(node, 'contentStatus');
  if (!confluenceNumericId.test(id) || !exactHierarchyReference(property(node, 'space'), 'Space') ||
      status && (status.children.length || !['', 'current'].includes(status.text.trim().toLowerCase())) ||
      collection(node, 'parent') || property(node, 'parentComment') || property(node, 'ancestors')) return;

  const parent = property(node, 'parent');
  const declaredAncestors = collection(node, 'ancestors');
  const ancestorIds = new Set<string>();
  if (declaredAncestors) {
    const { class: sourceClass } = declaredAncestors.attributes;
    if (declaredAncestors.text.trim() || Object.keys(declaredAncestors.attributes).some(attribute => attribute !== 'name' && attribute !== 'class') ||
        sourceClass !== undefined && !confluenceCollectionClasses.has(sourceClass)) return;
    for (const ancestor of declaredAncestors.children) {
      const ancestorId = ancestor.name === 'element' && exactHierarchyReference(ancestor, 'Page');
      if (!ancestorId || ancestorId === id || ancestorIds.has(ancestorId)) return;
      ancestorIds.add(ancestorId);
    }
  }

  const parentId = exactHierarchyReference(parent, 'Page');
  if (parentId) {
    return parentId !== id && (!declaredAncestors || ancestorIds.has(parentId)) ? parentId : undefined;
  }
  if (ancestorIds.size) return;
  if (!parent) return declaredAncestors ? null : undefined;
  // An omitted parent can mean a partial export. Root requires an explicit empty property or ancestor collection.
  if (Object.keys(parent.attributes).length === 1 && explicitNullReference(parent)) return null;
}

function labelCollectionKeys(node: LegacyXmlNode, resolve: (element: LegacyXmlNode) => string): { keys: Set<string>; complete: boolean } {
  let complete = !node.text.trim() && Object.keys(node.attributes).every(name => name === 'class' || name === 'name');
  const keys = new Set<string>();
  for (const element of node.children) {
    const key = element.name === 'element' ? resolve(element) : '';
    if (!key || keys.has(key)) complete = false;
    if (key) keys.add(key);
  }
  return { keys, complete };
}

function attachLabels(data:LegacyDataset,byType:Map<string,XmlObject[]>,rows:Map<string,LegacyRecord>,objects:Map<string,XmlObject>,path:string):void{
  const labels=new Map<string,LegacyRecord>();
  const exactLabelObjects = new Set<string>();
  for (const item of byType.get('Label') ?? []) {
    const owner = property(item.node, 'owner');
    const row = record('option', item.id, {
      title: prop(item.node, 'name'),
      metadata: {
        sourceClass: 'Label', originalId: item.id, ...primitiveProperties(item.node, ['name', 'namespace', 'owner']),
        ...(owner?.children.length ? { ownerReference: idOf(owner) || null } : {}),
      },
    });
    addRecord(data, row);
    labels.set(item.id, row);
    if (exactObjectId(item.node) === item.id) exactLabelObjects.add(item.id);
  }
  const apply = (owner: LegacyRecord, labelId: string) => {
    addReference(owner, 'option', labelId, 'label');
    const label = labels.get(labelId);
    if (label) {
      const values = Array.isArray(owner.metadata.labels) ? owner.metadata.labels : [];
      if (!values.includes(label.title)) values.push(label.title);
      owner.metadata.labels = values;
    } else {
      diagnostic(data, { severity: 'warning', code: 'CONFLUENCE_LABEL_MISSING',
        message: '레이블 관계의 원본 Label 객체가 없습니다.', recordId: owner.id, path });
    }
  };
  const associations = new Map<string, Map<string, string>>();
  const uncertainOwners = new Set<string>();
  for (const type of labelAssociationTypes) for (const item of byType.get(type) ?? []) {
    const contents = [property(item.node, 'content'), property(item.node, 'contentEntity')]
      .filter((value): value is LegacyXmlNode => value !== undefined);
    const [content] = contents;
    const ownerKey = content && `${objectClass(content) || 'Page'}:${idOf(content)}`;
    const owner = ownerKey ? rows.get(ownerKey) : undefined;
    const labelNode = property(item.node, 'label');
    const labelId = idOf(labelNode);
    if (owner && labelId) apply(owner, labelId);
    else diagnostic(data, { severity: 'warning', code: 'CONFLUENCE_LABEL_RELATION_UNRESOLVED',
      message: '레이블과 콘텐츠의 연결을 확정할 수 없습니다.', recordId: `relation:${item.type}:${item.id}`, path });

    if (ownerKey && owner && exactObjectId(item.node) === item.id && labelNode && objectClass(labelNode) === 'Label' &&
        exactLabelObjects.has(exactReferenceId(labelNode)) &&
        contents.every(node => `${objectClass(node)}:${exactReferenceId(node)}` === ownerKey)) {
      const links = associations.get(ownerKey) ?? new Map<string, string>();
      links.set(`${item.type}:${item.id}`, labelId);
      associations.set(ownerKey, links);
    } else {
      for (const node of contents) {
        const id = idOf(node);
        const type = objectClass(node) || 'Page';
        uncertainOwners.add(`${type}:${id}`);
        if (!rows.has(`${type}:${id}`) && rows.has(`Page:${id}`)) uncertainOwners.add(`Page:${id}`);
      }
    }
  }

  for (const [key, row] of rows) {
    const object = objects.get(key);
    if (!object) continue;
    const direct = collection(object.node, 'labels');
    for (const element of direct?.children ?? []) if (objectClass(element) === 'Label') apply(row, idOf(element));

    const indirect = collection(object.node, 'labellings');
    const status = property(object.node, 'contentStatus');
    if (object.type !== 'Page' || row.kind !== 'page' || status && (status.children.length || status.text.trim() !== 'current') ||
        exactObjectId(object.node) !== object.id) continue;
    const proven = associations.get(key) ?? new Map<string, string>();
    const directIds = direct && labelCollectionKeys(direct, element => {
      const id = exactReferenceId(element);
      return objectClass(element) === 'Label' && exactLabelObjects.has(id) ? id : '';
    });
    const provenLabels = new Set(proven.values());
    const confirmedLabels = new Set([...provenLabels, ...(directIds?.keys ?? [])]);
    if (confirmedLabels.size) row.metadata.confirmedLabelIds = [...confirmedLabels].sort();

    if (!direct && !indirect || uncertainOwners.has(key)) continue;
    const indirectIds = indirect && labelCollectionKeys(indirect, element => {
      const type = objectClass(element);
      const key = `${type}:${exactReferenceId(element)}`;
      return labelAssociationTypes.has(type) && proven.has(key) ? key : '';
    });
    if (directIds?.complete === false || indirectIds?.complete === false || property(object.node, 'labels') || property(object.node, 'labellings')) continue;
    if (indirectIds && indirectIds.keys.size !== proven.size) continue;
    if (directIds && ([...provenLabels].some(id => !directIds.keys.has(id)) || indirectIds && directIds.keys.size !== provenLabels.size)) continue;
    row.metadata.labelSetComplete = true;
  }
}

const permissionOwnerFields = new Set(['owningContent', 'content', 'contentEntity', 'owningContentEntity']);
const permissionSetFields = new Set(['owningSet', 'contentPermissionSet', 'permissionSet']);
const permissionTypeFields = new Set(['type']);
const permissionMemberFields = new Set(['contentPermissions']);
const contentPermissionSetCollections = ['contentPermissionSets', 'permissionSets', 'restrictions'];

function permissionProperties(node: LegacyXmlNode, names: ReadonlySet<string>): LegacyXmlNode[] {
  return node.children.filter(field => names.has(field.attributes.name));
}

function exactEditPermission(object: XmlObject, type: 'ContentPermission' | 'ContentPermissionSet'): boolean {
  const [operation, extra] = permissionProperties(object.node, permissionTypeFields);
  return exactClass(object.node, type) && confluenceNumericId.test(object.id) && exactObjectId(object.node) === object.id &&
    Boolean(!extra && operation?.name === 'property' && !operation.children.length &&
      Object.keys(operation.attributes).length === 1 && operation.text === 'Edit');
}

function exactPermissionOwner(node: LegacyXmlNode): string | undefined {
  const type = objectClass(node), id = exactReferenceId(node);
  if (node.name === 'property' && (type === 'Page' || type === 'BlogPost') && exactClass(node, type) && confluenceNumericId.test(id)) {
    return `${type}:${id}`;
  }
}

function attachRelations(data:LegacyDataset,byType:Map<string,XmlObject[]>,rows:Map<string,LegacyRecord>,objects:Map<string,XmlObject>,kindFor:(type:string,id:string)=>LegacyRecordKind,sourceIdFor:(type:string,id:string)=>string,path:string):void{
  const restricted = new Set<string>();
  const permissionOwners = new Map<string, string[]>();
  for(const type of RELATION_TYPES)for(const item of byType.get(type)??[]){
    const row=record('relation',`${type}:${item.id}`,{title:type,authorId:nullString(ref(item.node,'creator')),createdAt:nullString(prop(item.node,'creationDate')),updatedAt:nullString(prop(item.node,'lastModificationDate')),metadata:{sourceClass:type,originalId:item.id,...primitiveProperties(item.node,['type','userName','groupName','permissionType','destinationSpaceKey','destinationPageTitle','linkDestination','linkType','relationName'])}});
    for(const field of item.node.children){const targets=field.name==='property'?[field]:field.name==='collection'?field.children:[];for(const node of targets){const target=idOf(node),targetType=objectClass(node);if(!target||!targetType)continue;const targetRow=rows.get(`${targetType}:${target}`);const targetKind=targetRow?.kind??(RELATION_TYPES.has(targetType)?'relation':targetType==='Label'?'option':kindFor(targetType,target));const targetId=targetRow?.sourceId??(RELATION_TYPES.has(targetType)?`${targetType}:${target}`:sourceIdFor(targetType,target));addReference(row,targetKind,targetId,field.attributes.name||'target');}}
    addRecord(data,row);
    if(type==='ContentPermissionSet'){
      const owners=row.references.filter(reference=>permissionOwnerFields.has(reference.relation));
      permissionOwners.set(item.id,owners.map(reference=>`${reference.kind}:${reference.sourceId}`));
      if(!owners.length)diagnostic(data,{severity:'error',code:'CONFLUENCE_RESTRICTION_OWNER_UNKNOWN',message:'접근 제한의 대상 콘텐츠가 불명확합니다. 권한을 재현하거나 명시적으로 제외하기 전에는 적용할 수 없습니다.',recordId:row.id,path});
    }
    if(type==='SpacePermission')diagnostic(data,{severity:'warning',code:'CONFLUENCE_SPACE_PERMISSION_REVIEW',message:'공간 권한 관계를 보존했습니다. 새 서비스의 팀 접근 정책과 별도로 대조해야 합니다.',recordId:row.id,path});
  }
  const setDeclarations = new Map<string, { objectKey: string; element: LegacyXmlNode }[]>();
  const setIdsByOwner = new Map<string, string[]>();
  for (const key of rows.keys()) {
    const object = objects.get(key);
    if (!object) continue;
    const assignedSetIds: string[] = [];
    for (const name of contentPermissionSetCollections) {
      for (const element of collection(object.node, name)?.children ?? []) {
        const id = idOf(element);
        if (!id) continue;
        assignedSetIds.push(id);
        const claims = setDeclarations.get(id) ?? [];
        claims.push({ objectKey: key, element });
        setDeclarations.set(id, claims);
      }
    }
    if (assignedSetIds.length) setIdsByOwner.set(key, assignedSetIds);
  }
  const memberPermissions = new Map<string, XmlObject[]>();
  for (const permission of byType.get('ContentPermission') ?? []) {
    const setIds = new Set(permissionProperties(permission.node, permissionSetFields).map(idOf).filter(Boolean));
    for (const setId of setIds) {
      const members = memberPermissions.get(setId) ?? [];
      members.push(permission);
      memberPermissions.set(setId, members);
    }
  }
  const editSets = new Map<string, string>();
  const editSetsByOwner = new Map<string, string[]>();
  for (const set of byType.get('ContentPermissionSet') ?? []) {
    const owners = permissionProperties(set.node, permissionOwnerFields);
    const owner = owners[0] && exactPermissionOwner(owners[0]);
    const declarations = setDeclarations.get(set.id) ?? [];
    const memberFields = permissionProperties(set.node, permissionMemberFields);
    const declaredMembers = memberFields[0]?.children ?? [];
    const allMembers = [...(memberPermissions.get(set.id) ?? []), ...declaredMembers.map(element => {
      const id = exactReferenceId(element);
      return element.name === 'element' && exactClass(element, 'ContentPermission') ? objects.get(`ContentPermission:${id}`) : undefined;
    })];
    const provenEdit = owner && rows.has(owner) && exactEditPermission(set, 'ContentPermissionSet') &&
      memberFields.length <= 1 && (!memberFields.length || memberFields[0].name === 'collection') &&
      owners.every(field => exactPermissionOwner(field) === owner) && declarations.every(({ objectKey, element }) =>
        objectKey === owner && element.name === 'element' && exactClass(element, 'ContentPermissionSet') && exactReferenceId(element) === set.id) &&
      allMembers.every(member => member && exactEditPermission(member, 'ContentPermission') &&
        permissionProperties(member.node, permissionSetFields).every(field =>
          field.name === 'property' && exactClass(field, 'ContentPermissionSet') && exactReferenceId(field) === set.id) &&
        permissionProperties(member.node, permissionOwnerFields).every(field => exactPermissionOwner(field) === owner));
    if (provenEdit && owner) {
      editSets.set(set.id, owner);
      const ownerSets = editSetsByOwner.get(owner) ?? [];
      ownerSets.push(set.id);
      editSetsByOwner.set(owner, ownerSets);
    } else {
      for (const ownerId of permissionOwners.get(set.id) ?? []) restricted.add(ownerId);
    }
  }
  for (const [owner, ids] of setIdsByOwner) {
    const row = rows.get(owner)!;
    for (const id of ids) addReference(row, 'relation', `ContentPermissionSet:${id}`, 'restriction');
    const readOrUnknown = ids.filter(id => editSets.get(id) !== owner);
    if (!readOrUnknown.length) continue;
    restricted.add(row.id);
    row.metadata.permissionSetIds = readOrUnknown;
  }
  const bySourceId=new Map<string,LegacyRecord[]>();for(const row of rows.values()){const values=bySourceId.get(row.sourceId)??[];values.push(row);bySourceId.set(row.sourceId,values);}
  for (const item of byType.get('ContentPermission') ?? []) {
    const setId = ref(item.node, 'owningSet') || ref(item.node, 'contentPermissionSet') || ref(item.node, 'permissionSet');
    const ownerId = ref(item.node, 'owningContent') || ref(item.node, 'content');
    if (ownerId && !editSets.has(setId)) for (const row of bySourceId.get(ownerId) ?? []) restricted.add(row.id);
    if (setId && !permissionOwners.has(setId)) diagnostic(data, { severity: 'error', code: 'CONFLUENCE_RESTRICTION_SET_MISSING',
      message: '권한 제한의 소유 집합을 찾을 수 없습니다. 권한 검토가 필요합니다.', recordId: `relation:ContentPermission:${item.id}`, path });
  }
  for (const [owner, ids] of editSetsByOwner) {
    const row = rows.get(owner)!;
    row.metadata.editPermissionSetIds = ids;
    diagnostic(data, { severity: 'warning', code: 'CONFLUENCE_EDIT_RESTRICTION_REVIEW', recordId: row.id, path,
      message: '원본 문서의 편집 제한이 확인되었습니다. 이관 후 팀의 편집 범위를 확인해 주세요.' });
  }
  // View restrictions can be inherited by descendants; carry this uncertainty to their comments/history.
  const descendants=new Map<string,string[]>();for(const row of data.records)for(const parent of row.references.filter(item=>['parent','container-content','current-version','ancestor','body-owner'].includes(item.relation))){const key=`${parent.kind}:${parent.sourceId}`,values=descendants.get(key)??[];values.push(row.id);descendants.set(key,values);}
  const pending=[...restricted];for(let i=0;i<pending.length;i++)for(const id of descendants.get(pending[i])??[])if(!restricted.has(id)){restricted.add(id);pending.push(id);}
  for(const row of data.records)if(restricted.has(row.id)){row.metadata.restricted=true;diagnostic(data,{severity:'error',code:'CONFLUENCE_RESTRICTED_CONTENT',message:'이 콘텐츠에는 직접 또는 상위 콘텐츠의 접근 제한이 있습니다. 권한을 재현하거나 명시적으로 제외하기 전에는 적용할 수 없습니다.',recordId:row.id,path});}
}

function attachBinaries(data:LegacyDataset,files:Map<string,Buffer>,prefix:string,byType:Map<string,XmlObject[]>,rows:Map<string,LegacyRecord>,history:Map<string,string>,path:string):void{
  const used=new Set<string>();
  for(const item of byType.get('Attachment')??[]){const row=rows.get(`Attachment:${item.id}`)!;const version=prop(item.node,'version'),current=history.get(`Attachment:${item.id}`),owners=[row.containerId].filter((id):id is string=>!!id),ids=[item.id,...(current?[current]:[])];const candidates=new Set<string>();
    for(const owner of owners){for(const id of ids)if(version&&files.has(`${prefix}attachments/${owner}/${id}/${version}`))candidates.add(`${prefix}attachments/${owner}/${id}/${version}`);if(files.has(`${prefix}attachments/${owner}/${item.id}`))candidates.add(`${prefix}attachments/${owner}/${item.id}`);}
    row.metadata.binaryCandidates=[...candidates];row.metadata.attachmentVersion=version||null;
    if(candidates.size===1){const filePath=[...candidates][0],bytes=files.get(filePath)!;row.metadata.packagePath=filePath;row.metadata.size=bytes.byteLength;row.metadata.sha256=createHash('sha256').update(bytes).digest('hex');used.add(filePath);}
    else if(!candidates.size)diagnostic(data,{severity:'error',code:'CONFLUENCE_ATTACHMENT_BYTES_MISSING',message:'첨부의 해당 버전에 대응하는 파일이 패키지에 없습니다. 원격 서버에서 파일을 가져오지 않았습니다.',recordId:row.id,path});
    else diagnostic(data,{severity:'error',code:'CONFLUENCE_ATTACHMENT_PATH_AMBIGUOUS',message:'첨부에 대응하는 파일 경로가 여러 개여서 해당 버전의 원본을 확정하지 않았습니다.',recordId:row.id,path});
  }
  const unlinked=[...files.keys()].filter(filePath=>filePath.startsWith(`${prefix}attachments/`)&&!used.has(filePath));
  if(unlinked.length)diagnostic(data,{severity:'warning',code:'CONFLUENCE_UNLINKED_ATTACHMENT_FILES',message:`첨부 객체/버전과 유일하게 연결되지 않은 파일 ${unlinked.length}개가 패키지에 있습니다.`,path});
}

function linkProfiles(data:LegacyDataset,byType:Map<string,XmlObject[]>,rows:Map<string,LegacyRecord>,path:string):void{
  const byName=new Map<string,string[]>();for(const user of byType.get('ConfluenceUserImpl')??[]){const name=prop(user.node,'name');if(name){const keys=byName.get(name)??[];keys.push(user.id);byName.set(name,keys);}}
  for(const profile of byType.get('UserInfo')??[]){const row=rows.get(`UserInfo:${profile.id}`)!,name=prop(profile.node,'username')||prop(profile.node,'userName'),keys=byName.get(name)??[];if(keys.length===1)addReference(row,'identity',keys[0],'profile-user');else diagnostic(data,{severity:'warning',code:'CONFLUENCE_PROFILE_IDENTITY_UNRESOLVED',message:'프로필과 사용자 키를 유일하게 연결할 수 없습니다. 이름이나 이메일로 사용자를 자동 병합하지 않았습니다.',recordId:row.id,path});}
}

interface StorageContext { byId:Map<string,LegacyRecord>; pagesById:Map<string,LegacyRecord>; spaceByKey:Map<string,string[]>; pageByTitle:Map<string,string[]>; spaceFor:(row:LegacyRecord)=>string|null }
function storageContext(records:LegacyRecord[],byType:Map<string,XmlObject[]>,pageByTitle:Map<string,string[]>):StorageContext{
  const byId=new Map(records.map(row=>[row.id,row])),pagesById=new Map<string,LegacyRecord>(),spaceByKey=new Map<string,string[]>(),spaceCache=new Map<string,string|null>();
  for(const row of records)if(['Page','BlogPost'].includes(String(row.metadata.sourceClass)))pagesById.set(row.sourceId,row);
  for(const space of byType.get('Space')??[]){const key=prop(space.node,'key'),ids=spaceByKey.get(key)??[];ids.push(space.id);spaceByKey.set(key,ids);}
  const spaceFor=(row:LegacyRecord):string|null=>{
    if(spaceCache.has(row.id))return spaceCache.get(row.id)!;
    const visited=new Set<string>(),pending=[row];let found:string|null=null;
    for(let i=0;i<pending.length&&!found;i++){const current=pending[i];if(visited.has(current.id))continue;visited.add(current.id);if(spaceCache.has(current.id)){found=spaceCache.get(current.id)!;continue;}const ownSpace=current.references.find(item=>item.kind==='project'&&item.relation==='space');if(ownSpace){found=ownSpace.sourceId;break;}for(const parent of current.references.filter(item=>['container-content','current-version','body-owner'].includes(item.relation))){const owner=byId.get(`${parent.kind}:${parent.sourceId}`);if(owner)pending.push(owner);}}
    for(const id of visited)spaceCache.set(id,found);return found;
  };
  return{byId,pagesById,spaceByKey,pageByTitle,spaceFor};
}
function analyzeStorage(data:LegacyDataset,row:LegacyRecord,context:StorageContext,path:string):void{
  if(!row.text)return;let root:LegacyXmlNode;
  try{root=parseLegacyXml(`<legacy-storage-root>${row.text}</legacy-storage-root>`);}catch{diagnostic(data,{severity:'warning',code:'CONFLUENCE_STORAGE_ANALYSIS_INCOMPLETE',message:'storage XML 내부 구조를 분석하지 못했습니다. 본문 원문은 그대로 보존했으며 매크로나 링크를 임의 변환하지 않았습니다.',recordId:row.id,path});return;}
  const spaceId=context.spaceFor(row);
  const macros=new Map<string,number>(),unknown=new Map<string,number>(),unresolved:LegacyValue[]=[],externalLinks:string[]=[];
  const pageTarget=(node:LegacyXmlNode,relation:string)=>{
    const contentId=node.attributes['ri:content-id']||node.attributes['ri:page-id'];if(contentId){const target=context.pagesById.get(contentId);addReference(row,target?.kind??'page',contentId,relation);return;}
    const title=node.attributes['ri:content-title']??'',spaceKey=node.attributes['ri:space-key']??'',spaces=spaceKey?context.spaceByKey.get(spaceKey)??[]:[],targetSpace=spaceKey?(spaces.length===1?spaces[0]:null):spaceId;
    const ids=targetSpace?context.pageByTitle.get(`${targetSpace}\u0000${title}`)??[]:[];
    if(ids.length===1)addReference(row,'page',ids[0],relation);else unresolved.push({kind:'page',title,spaceKey,reason:ids.length>1?'ambiguous':'not-in-package'});
  };
  walk(root,node=>{
    if(node.name==='ac:structured-macro'||node.name==='ac:macro'){
      const name=node.attributes['ac:name']??'(unnamed)';macros.set(name,(macros.get(name)??0)+1);if(!KNOWN_MACROS.has(name))unknown.set(name,(unknown.get(name)??0)+1);
      if(name==='jira'||name==='jiraissues')for(const parameter of node.children.filter(item=>item.name==='ac:parameter'&&['key','issueKey'].includes(item.attributes['ac:name']??''))){const key=parameter.text.trim();if(key)addReference(row,'issue',key,'jira-macro');}
      if (name === 'include' || name === 'excerpt-include') {
        const parameters = node.children.filter(item => (
          item.name === 'ac:parameter' && ['', 'page', 'pageTitle'].includes(item.attributes['ac:name'] ?? '')
        ) || (name === 'excerpt-include' && (item.name === 'ac:default-parameter' ||
          item.name === 'ac:parameter' && item.attributes['ac:name'] === 'default-parameter')));
        for (const parameter of parameters) {
          if (name === 'include' ? parameter.children.some(item => item.name === 'ri:page') : parameter.children.length > 0) continue;
          const value = parameter.text.trim();
          if (!value) continue;
          const colon = value.indexOf(':');
          const separator = name === 'include' || /^(?:[A-Za-z0-9]+|~[^\s:]+)$/u.test(value.slice(0, colon)) ? colon : -1;
          const spaceKey = separator > 0 ? value.slice(0, separator) : '';
          const title = separator > 0 ? value.slice(separator + 1) : value;
          if (title) pageTarget({ name: 'ri:page', attributes: {
            'ri:content-title': name === 'include' ? title : title.trim(), ...(spaceKey ? { 'ri:space-key': spaceKey } : {}),
          }, children: [], text: '' }, 'include-macro');
        }
      }
    }
    if(node.name==='ri:page')pageTarget(node,'page-link');
    if(node.name==='ri:attachment')unresolved.push({kind:'attachment',filename:node.attributes['ri:filename']??'',note:'storage reference retained; filename is not a unique attachment ID'});
    const href=node.name==='a'?node.attributes.href:node.name==='ri:url'?node.attributes['ri:value']:undefined;if(href&&!externalLinks.includes(href))externalLinks.push(href);
  });
  if(macros.size)row.metadata.macros=[...macros].map(([name,count])=>({name,count,converted:false}));
  if(unknown.size){row.metadata.unknownMacros=[...unknown].map(([name,count])=>({name,count}));diagnostic(data,{severity:'warning',code:'CONFLUENCE_UNKNOWN_MACROS',message:`알 수 없는 매크로 ${[...unknown.values()].reduce((a,b)=>a+b,0)}개(${unknown.size}종)를 원문으로 보존했습니다. 렌더링이나 변환은 수행하지 않았습니다.`,recordId:row.id,path});}
  if(unresolved.length){row.metadata.unresolvedStorageReferences=unresolved;diagnostic(data,{severity:'warning',code:'CONFLUENCE_STORAGE_REFERENCES_UNRESOLVED',message:'ID로 확정할 수 없는 문서 또는 첨부 참조가 있습니다. 원문 참조를 보존했으며 다른 대상으로 임의 연결하지 않았습니다.',recordId:row.id,path});}
  if(externalLinks.length)row.metadata.externalLinks=externalLinks;
}
