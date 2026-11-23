import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseConfluence } from '../../server/legacy-import-confluence.js';
import type { LegacyDataset,LegacyRecord } from '../../shared/types.js';

const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const cdata=(value:string)=>`<![CDATA[${value.replaceAll(']]>',']]]]><![CDATA[>')}]]>`;
const p=(name:string,value:string)=>`<property name="${name}">${cdata(value)}</property>`;
const r=(name:string,type:string,id:string)=>`<property name="${name}" class="${type}"><id name="${type==='ConfluenceUserImpl'?'key':'id'}">${escape(id)}</id></property>`;
const list=(name:string,type:string,ids:string[])=>`<collection name="${name}" class="java.util.Collection">${ids.map(id=>`<element class="${type}"><id name="id">${escape(id)}</id></element>`).join('')}</collection>`;
const object=(type:string,id:string,body='')=>`<object class="${type}" package="synthetic.confluence"><id name="${type==='ConfluenceUserImpl'?'key':'id'}">${escape(id)}</id>${body}</object>`;
const body=(id:string,type:string,owner:string,text:string)=>object('BodyContent',id,p('body',text)+r('content',type,owner)+p('bodyType','2'));
const xml=(objects:string[])=>`<?xml version="1.0" encoding="UTF-8"?><hibernate-generic>${objects.join('')}</hibernate-generic>`;
const files=(objects:string[],extra:[string,Buffer][]=[],prefix='')=>new Map<string,Buffer>([[`${prefix}entities.xml`,Buffer.from(xml(objects))],...extra]);
const find=(data:LegacyDataset,kind:string,id:string):LegacyRecord=>{const row=data.records.find(value=>value.kind===kind&&value.sourceId===id);assert.ok(row,`${kind}:${id}`);return row;};
const codes=(data:LegacyDataset)=>data.diagnostics.map(item=>item.code);
const refHas=(row:LegacyRecord,kind:string,sourceId:string,relation:string)=>row.references.some(item=>item.kind===kind&&item.sourceId===sourceId&&item.relation===relation);
const page=(id:string,title:string,extra='')=>object('Page',id,p('title',title)+p('version','1')+p('contentStatus','current')+r('space','Space','42')+extra);
const space=object('Space','42',p('key','TEAM')+p('name','합성 공간'));

test('current-page hierarchy evidence distinguishes explicit roots from missing or contradictory XML', () => {
  const emptyParent = '<property name="parent"/>';
  const explicitNull = '<property name="parent"><null/></property>';
  const vendorParent = '<property name="parent" class="Page" package="com.atlassian.confluence.pages"><id name="id">100</id></property>';
  const ancestors = (ids: string[]) => list('ancestors', 'Page', ids);
  const data = parseConfluence(files([
    object('Space', '42', p('key', 'TEAM') + r('homePage', 'Page', '100')),
    page('100', '홈은 단독 증거가 아님'),
    page('101', '확인한 상위 문서', vendorParent + ancestors(['100'])),
    page('102', '상위 객체의 별도 파일', r('parent', 'Page', '999')),
    page('103', '비어 있는 상위 속성', emptyParent),
    page('104', '명시적인 null 상위 속성', explicitNull),
    page('105', '비어 있는 조상 목록', '<collection name="ancestors" class="java.util.List"/>'),
    page('106', '상위 속성의 종류가 틀림', r('parent', 'BlogPost', '100')),
    page('107', '상위와 조상 목록이 모순됨', vendorParent + ancestors(['102'])),
    page('108', '비어 있는 조상과 명시한 상위가 모순됨', vendorParent + ancestors([])),
    page('109', '명시한 최상위와 조상 목록이 모순됨', emptyParent + ancestors(['100'])),
    page('110', '상위가 비어 있다고 볼 수 없는 속성', '<property name="parent" class="Page"/>'),
    page('111', '조상 목록의 중복 ID', vendorParent + ancestors(['100', '100'])),
    page('112', '조상 목록의 부정확한 원소', vendorParent + '<collection name="ancestors"><element class="Page"/></collection>'),
    page('113', '조상 목록만 있는 문서', ancestors(['100'])),
    page('114', '다른 XML 종류에서 선언된 상위', ancestors([]) + '<collection name="parent"/>'),
    object('Page', '115', r('space', 'Space', '42') + p('contentStatus', 'draft') + emptyParent),
    object('Page', '116', r('space', 'Space', '42') + p('contentStatus', 'historical') + vendorParent),
    object('BlogPost', '117', r('space', 'Space', '42') + p('contentStatus', 'current') + emptyParent),
    object('Page', '118', r('space', 'Page', '42') + p('contentStatus', 'current') + vendorParent),
    page('119', '자기 자신을 가리키는 상위', r('parent', 'Page', '119')),
    page('120', '불완전한 조상 표식', '<collection name="ancestors" partial="true"/>'),
  ]), 'confluence-hierarchy-evidence');

  assert.deepEqual(Object.fromEntries(data.records.flatMap(row =>
    Object.hasOwn(row.metadata, 'confluenceParentSourceId') ? [[row.sourceId, row.metadata.confluenceParentSourceId]] : [])),
  { '101': '100', '102': '999', '103': null, '104': null, '105': null });
  assert.equal(find(data, 'page', '100').parentId, null);
  assert.equal(find(data, 'page', '106').parentId, '100', 'existing initial-import parsing remains unchanged');
  assert.deepEqual(find(data, 'page', '107').metadata.ancestorIds, ['102']);
  assert.throws(() => parseConfluence(files([
    space, page('100', '서로 다른 상위 선언', vendorParent + emptyParent),
  ]), 'confluence-duplicate-parent'), /같은 이름의 속성이 중복/);
});

test('complete label evidence needs an explicit, resolved and consistent collection on the current Page', () => {
  const labelling = (id: string, pageId: string, labelId: string) =>
    object('Labelling', id, r('content', 'Page', pageId) + r('label', 'Label', labelId));
  const data = parseConfluence(files([
    space,
    page('100', 'Only a reverse reference'),
    page('101', 'Explicit empty labels', list('labels', 'Label', [])),
    page('102', 'Explicit empty labellings', list('labellings', 'Labelling', [])),
    page('103', 'Complete associations', list('labellings', 'Labelling', ['203'])),
    page('104', 'Both complete projections', list('labels', 'Label', ['500']) + list('labellings', 'Labelling', ['204'])),
    page('105', 'Missing Label object', list('labels', 'Label', ['599'])),
    page('106', 'Missing association object', list('labellings', 'Labelling', ['299'])),
    page('107', 'Unresolved reverse relationship', list('labels', 'Label', [])),
    page('108', 'Association belongs elsewhere', list('labellings', 'Labelling', ['204'])),
    page('109', 'Two declarations disagree', list('labels', 'Label', ['500', '501']) + list('labellings', 'Labelling', ['209'])),
    page('110', 'Untrusted collection marker', '<collection name="labels" partial="true"/>'),
    page('111', 'Conflicting reverse owners', list('labels', 'Label', [])),
    page('112', 'Conflicting alternate reverse owner', list('labels', 'Label', [])),
    page('113', 'Reverse relationship lacks a matching owner class', list('labels', 'Label', [])),
    page('114', 'Unlisted association', list('labellings', 'Labelling', ['214'])),
    page('115', 'Empty declaration contradicts an association', list('labels', 'Label', [])),
    object('Page', '116', p('title', 'Draft page') + p('contentStatus', 'draft') + list('labels', 'Label', [])),
    object('Page', '999', p('title', 'Historical page') + p('contentStatus', 'historical') + list('labels', 'Label', [])),
    object('Label', '500', p('name', 'public') + p('namespace', 'global')),
    object('Label', '501', p('name', 'another') + p('namespace', 'global')),
    labelling('200', '100', '500'), labelling('203', '103', '500'), labelling('204', '104', '500'), labelling('209', '109', '500'),
    labelling('214', '114', '500'), labelling('314', '114', '500'), labelling('215', '115', '500'),
    object('Labelling', '207', r('content', 'Page', '107')),
    object('Labelling', '211', r('content', 'Page', '111') + r('contentEntity', 'Page', '112') + r('label', 'Label', '500')),
    object('ContentLabel', '213', r('contentEntity', 'ContentEntityObject', '113') + r('label', 'Label', '500')),
  ]), 'confluence-label-snapshots');

  assert.deepEqual(data.records.filter(row => row.metadata.labelSetComplete === true).map(row => row.sourceId), ['101', '102', '103', '104']);
  assert.deepEqual(find(data, 'page', '100').metadata.labels, ['public']);
  assert.deepEqual(find(data, 'page', '103').metadata.labels, ['public']);
  assert.deepEqual(find(data, 'page', '109').metadata.labels, ['public', 'another']);
  assert.deepEqual(find(data, 'page', '115').metadata.labels, ['public']);
  assert.equal(find(data, 'page', '102').metadata.labels, undefined);
  assert.ok(data.diagnostics.some(item => item.code === 'CONFLUENCE_LABEL_MISSING' && item.recordId === 'page:105'));
  assert.ok(data.diagnostics.some(item => item.code === 'CONFLUENCE_LABEL_RELATION_UNRESOLVED' && item.recordId === 'relation:Labelling:207'));
});

test('partial label evidence retains independently confirmed IDs separately from the legacy projection', () => {
  const data = parseConfluence(files([
    space,
    page('100', 'Partial direct collection', `<collection name="labels" partial="true">
      <element class="Label"><id name="id">501</id></element>
      <element class="Label"><id name="key">502</id></element>
      <element class="Label"><id name="id">599</id></element>
    </collection>`),
    page('101', 'Matching relation alongside a disputed relation'),
    page('102', 'Disputed alternate owner'),
    page('103', 'Malformed association ID'),
    page('104', 'Malformed label object ID', list('labels', 'Label', ['503'])),
    page('105', 'Explicit empty collection', list('labels', 'Label', [])),
    object('Page', '106', p('title', 'Draft') + p('contentStatus', 'draft') + list('labels', 'Label', ['501'])),
    object('Label', '501', p('name', 'confirmed') + p('namespace', 'global')),
    object('Label', '502', p('name', 'unproven') + p('namespace', 'global')),
    `<object class="Label"><id name="key">503</id>${p('name', 'invalid-id')}${p('namespace', 'global')}</object>`,
    object('Labelling', '201', r('content', 'Page', '101') + r('label', 'Label', '501')),
    object('Labelling', '202', r('content', 'Page', '101') + r('contentEntity', 'Page', '102') + r('label', 'Label', '502')),
    `<object class="Labelling"><id name="key">203</id>${r('content', 'Page', '103')}${r('label', 'Label', '502')}</object>`,
  ]), 'confluence-confirmed-labels');

  assert.deepEqual(data.records.filter(row => row.metadata.confirmedLabelIds).map(row => [row.sourceId, row.metadata.confirmedLabelIds]), [
    ['100', ['501']], ['101', ['501']],
  ]);
  assert.deepEqual(data.records.filter(row => row.metadata.labelSetComplete).map(row => row.sourceId), ['105']);
  assert.deepEqual(find(data, 'page', '100').metadata.labels, ['confirmed', 'unproven']);
  assert.deepEqual(find(data, 'page', '101').metadata.labels, ['confirmed', 'unproven']);
  assert.deepEqual(find(data, 'page', '103').metadata.labels, ['unproven']);
  assert.deepEqual(find(data, 'page', '104').metadata.labels, ['invalid-id']);
  assert.deepEqual(find(data, 'page', '106').metadata.labels, ['confirmed']);
});

test('6.x entities preserve exact storage, original versions, identities, labels, references and restrictions',()=>{
  const raw=' \r\n<p>본문 &amp; 링크</p>\r<ac:link><ri:page ri:content-title="대상" ri:space-key="TEAM"/></ac:link><ac:structured-macro ac:name="include"><ac:parameter ac:name="">TEAM:대상</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">NE25-42</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="vendor-private"><ac:parameter ac:name="secret">kept-only-in-raw-body</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="vendor-private"/><ac:plain-text-body><![CDATA[끝 & 그대로]]></ac:plain-text-body>  ';
  const historical='\n<p>이전 <strong>본문</strong></p>\r\n';
  const input=files([
    space,object('ConfluenceUserImpl','user-key',p('name','alice')+p('displayName','원본 작성자')+p('password','must-not-copy-password')),
    object('UserInfo','9',p('username','alice')),body('209','UserInfo','9','<p>프로필 원문</p>'),
    object('Page','100',p('title','현재 문서')+p('version','2')+r('space','Space','42')+r('creator','ConfluenceUserImpl','user-key')+r('lastModifier','ConfluenceUserImpl','user-key')+p('creationDate','2018-07-13 12:34:56.123')+p('lastModificationDate','2019-01-02 04:05:06.987')+p('versionComment','원본 변경 설명')+list('historicalVersions','Page',['101'])+list('bodyContents','BodyContent',['200'])+list('contentPermissionSets','ContentPermissionSet',['600'])),
    object('Page','101',p('title','이전 제목')+p('version','1')+p('contentStatus','historical')+r('space','Space','42')+r('originalVersion','Page','100')),
    page('102','대상'),body('200','Page','100',raw),body('201','Page','101',historical),body('202','Page','102','<p>참조 대상</p>'),
    object('Comment','300',p('title','댓글')+r('containerContent','Page','100')+r('creator','ConfluenceUserImpl','user-key')+p('creationDate','2019-01-02 04:10:00.000')),body('400','Comment','300','<p>댓글 원문</p>'),
    object('Label','500',p('name','팀 문서')+p('namespace','global')),object('Labelling','501',r('content','Page','100')+r('label','Label','500')),
    object('ContentPermissionSet','600',p('type','View')+r('owningContent','Page','100')),object('ContentPermission','601',p('type','View')+p('userName','alice')+r('owningSet','ContentPermissionSet','600')),
    object('OutgoingLink','800',r('sourceContent','Page','100')+p('destinationSpaceKey','TEAM')+p('destinationPageTitle','대상')),
    object('Bandana','900',p('value','do-not-copy-configuration-secret')),
  ],[['exportDescriptor.properties',Buffer.from('confluence.version=6.9.1\ntimeZone=Asia/Seoul\npassword=do-not-copy-descriptor-secret\n')]]);
  const data=parseConfluence(input,'confluence-synthetic');
  const current=find(data,'page','100'),revision=find(data,'revision','101'),comment=find(data,'comment','300');
  assert.equal(data.source.declaredVersion,'6.9.1');assert.equal(data.source.timezone,'Asia/Seoul');assert.equal(data.source.instanceKey,'confluence-synthetic');
  assert.equal(current.text,raw);assert.equal(current.textFormat,'confluence-storage');assert.equal(revision.text,historical);assert.equal(comment.text,'<p>댓글 원문</p>');
  assert.equal(current.authorId,'user-key');assert.equal(current.createdAt,'2018-07-13 12:34:56.123');assert.equal(current.updatedAt,'2019-01-02 04:05:06.987');assert.equal(current.metadata.version,'2');assert.equal(current.metadata.versionComment,'원본 변경 설명');
  assert.deepEqual(current.metadata.bodyContentIds,['200']);assert.deepEqual(current.metadata.historicalVersionIds,['101']);assert.equal(revision.metadata.currentVersionId,'100');
  assert.ok(refHas(current,'revision','101','historical-version'));assert.ok(refHas(revision,'page','100','current-version'));
  assert.deepEqual(current.metadata.labels,['팀 문서']);assert.ok(refHas(current,'option','500','label'));assert.equal(find(data,'relation','Labelling:501').metadata.originalId,'501');
  assert.ok(refHas(current,'page','102','page-link'));assert.ok(refHas(current,'page','102','include-macro'));assert.ok(refHas(current,'issue','NE25-42','jira-macro'));
  assert.deepEqual(current.metadata.unknownMacros,[{name:'vendor-private',count:2}]);assert.ok(codes(data).includes('CONFLUENCE_UNKNOWN_MACROS'));
  for(const row of [current,revision,comment]){assert.equal(row.metadata.restricted,true);assert.ok(data.diagnostics.some(item=>item.code==='CONFLUENCE_RESTRICTED_CONTENT'&&item.severity==='error'&&item.recordId===row.id));}
  assert.equal(find(data,'identity','UserInfo:9').text,'<p>프로필 원문</p>');assert.ok(refHas(find(data,'identity','UserInfo:9'),'identity','user-key','profile-user'));
  assert.deepEqual(data.unsupported,[{type:'Bandana',count:1}]);
  const serialized=JSON.stringify(data);for(const secret of ['must-not-copy-password','do-not-copy-configuration-secret','do-not-copy-descriptor-secret'])assert.ok(!serialized.includes(secret));
  assert.ok(codes(data).includes('CONFLUENCE_ANALYSIS_ONLY'));assert.ok(!codes(data).includes('CONFLUENCE_TIMEZONE_UNKNOWN'));
  assert.equal(input.size,2,'the parser does not mutate or replace original package files');
});

test('versioned and pre-8.1 attachment layouts retain binary hashes, versions and missing-byte diagnostics',()=>{
  const first=Buffer.from('첫 버전'),second=Buffer.from('두 번째 버전'),legacy=Buffer.from([0,1,2,255]);
  const input=files([space,page('100','첨부 페이지'),body('200','Page','100','<p>첨부</p>'),
    object('Attachment','700',p('title','설계.bin')+p('version','2')+r('containerContent','Page','100')+list('historicalVersions','Attachment',['701'])),
    object('Attachment','701',p('title','설계.bin')+p('version','1')+r('containerContent','Page','100')+r('originalVersion','Attachment','700')),
    object('Attachment','702',p('fileName','legacy.dat')+p('version','3')+r('content','Page','100')),
    object('Attachment','703',p('title','missing.dat')+p('version','1')+r('containerContent','Page','100')),
    object('Attachment','704',p('title','legacy-history.dat')+p('version','2')+r('containerContent','Page','100')+list('historicalVersions','Attachment',['705'])),
    object('Attachment','705',p('title','legacy-history.dat')+p('version','1')+r('containerContent','Page','100')+r('originalVersion','Attachment','704')),
  ],[['export/attachments/100/700/1',first],['export/attachments/100/700/2',second],['export/attachments/100/702',legacy],['export/attachments/100/704',second]],'export/');
  const data=parseConfluence(input,'confluence-attachments');
  for(const [id,path,bytes,version]of [['700','export/attachments/100/700/2',second,'2'],['701','export/attachments/100/700/1',first,'1'],['702','export/attachments/100/702',legacy,'3']] as const){const row=find(data,'attachment',id);assert.equal(row.metadata.packagePath,path);assert.equal(row.metadata.size,bytes.length);assert.equal(row.metadata.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(row.metadata.attachmentVersion,version);}
  assert.ok(refHas(find(data,'attachment','700'),'attachment','701','historical-version'));
  assert.equal(find(data,'attachment','702').title,'legacy.dat');
  assert.ok(data.diagnostics.some(item=>item.code==='CONFLUENCE_ATTACHMENT_BYTES_MISSING'&&item.recordId==='attachment:703'&&item.severity==='error'));
  assert.ok(data.diagnostics.some(item=>item.code==='CONFLUENCE_ATTACHMENT_BYTES_MISSING'&&item.recordId==='attachment:705'),'a non-versioned current file must never stand in for historical bytes');assert.equal(find(data,'attachment','705').metadata.packagePath,undefined);
  assert.ok(!codes(data).includes('CONFLUENCE_UNLINKED_ATTACHMENT_FILES'));
});

test('ambiguous bodies, binary paths and title references are preserved without choosing an arbitrary target',()=>{
  const data=parseConfluence(files([space,page('100','시작'),page('101','중복'),page('102','중복'),body('200','Page','100','<ri:page ri:content-title="중복"/><ac:structured-macro ac:name="unknown"/>'),body('201','Page','100',' <p>두 번째 본문</p> '),
    body('202','Page','101','<p>첫 대상</p>'),body('203','Page','102','<p>둘째 대상</p>'),
    object('Attachment','700',p('title','ambiguous')+p('version','1')+r('containerContent','Page','100')),
  ],[['attachments/100/700',Buffer.from('legacy')],['attachments/100/700/1',Buffer.from('versioned')]]),'confluence-ambiguous');
  const current=find(data,'page','100');assert.equal(current.text,'');
  assert.deepEqual(current.metadata.bodyContents,[{id:'200',bodyType:'2',text:'<ri:page ri:content-title="중복"/><ac:structured-macro ac:name="unknown"/>'},{id:'201',bodyType:'2',text:' <p>두 번째 본문</p> '}]);
  assert.ok(codes(data).includes('CONFLUENCE_MULTIPLE_BODIES'));assert.ok(codes(data).includes('CONFLUENCE_ATTACHMENT_PATH_AMBIGUOUS'));assert.equal(find(data,'attachment','700').metadata.packagePath,undefined);
  assert.ok(!current.references.some(item=>item.relation==='page-link'));
  assert.ok(codes(data).includes('CONFLUENCE_UNKNOWN_MACROS'));assert.equal(find(data,'revision','BodyContent:200').textFormat,'confluence-storage');
});

test('ambiguous page titles, rich invalid fragments, orphan content and unresolved profiles remain explicit',()=>{
  const raw='<p>&unknown-entity;</p><ac:structured-macro ac:name="plugin"/>';
  const data=parseConfluence(files([space,page('100','시작'),page('101','중복'),page('102','중복'),body('200','Page','100','<ri:page ri:content-title="중복"/><ri:attachment ri:filename="design.pdf"/><a href="https://example.test/path">링크</a>'),body('201','Page','101',raw),body('202','Page','102',''),body('999','Page','not-exported',' \r\n<p>고아 본문</p> '),
    object('ConfluenceUserImpl','key-a',p('name','same')),object('ConfluenceUserImpl','key-b',p('name','same')),object('UserInfo','9',p('username','same')),
  ]),'confluence-unresolved');
  const row=find(data,'page','100');assert.ok(!row.references.some(item=>item.relation==='page-link'));assert.deepEqual(row.metadata.externalLinks,['https://example.test/path']);assert.ok(Array.isArray(row.metadata.unresolvedStorageReferences));
  assert.equal(find(data,'page','101').text,raw);assert.ok(codes(data).includes('CONFLUENCE_STORAGE_ANALYSIS_INCOMPLETE'));
  assert.equal(find(data,'revision','BodyContent:999').text,' \r\n<p>고아 본문</p> ');assert.ok(codes(data).includes('CONFLUENCE_BODY_OWNER_MISSING'));
  assert.ok(!find(data,'identity','UserInfo:9').references.some(item=>item.relation==='profile-user'));assert.ok(codes(data).includes('CONFLUENCE_PROFILE_IDENTITY_UNRESOLVED'));
});

test('restriction collections, missing permission owners and ancestor inheritance block affected pages and comments',()=>{
  const data=parseConfluence(files([space,page('100','제한',list('contentPermissionSets','ContentPermissionSet',['absent-set'])),page('101','자식',r('parent','Page','100')),body('200','Page','100','<p>제한</p>'),body('201','Page','101','<p>자식</p>'),
    object('Comment','300',r('containerContent','Page','101')),body('400','Comment','300','<p>댓글</p>'),object('ContentPermissionSet','600',p('type','View')),object('ContentPermission','601',r('owningSet','ContentPermissionSet','missing-set')),
  ]),'confluence-restrictions');
  for(const [kind,id]of [['page','100'],['page','101'],['comment','300']])assert.equal(find(data,kind,id).metadata.restricted,true);
  assert.ok(codes(data).includes('CONFLUENCE_RESTRICTION_OWNER_UNKNOWN'));assert.ok(codes(data).includes('CONFLUENCE_RESTRICTION_SET_MISSING'));
});

test('missing or ambiguous primary XML, malformed XML and duplicate source objects are rejected',()=>{
  assert.throws(()=>parseConfluence(new Map(),'x'),/entities.xml/);
  assert.throws(()=>parseConfluence(new Map([['entities.xml',Buffer.from('<x/>')],['nested/entities.xml',Buffer.from('<x/>')]]),'x'),/여러 개/);
  assert.throws(()=>parseConfluence(new Map([['entities.xml',Buffer.from('<hibernate-generic><object>')]]),'x'));
  assert.throws(()=>parseConfluence(files([space,space]),'x'),/중복/);
  assert.throws(()=>parseConfluence(files([space,page('100','중복 속성',p('title','두 번째 제목'))]),'x'),/속성이 중복/);
  assert.throws(()=>parseConfluence(new Map([['entities.xml',Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>')]]),'x'),/DTD|ENTITY/);
});

test('unknown configuration objects need no IDs and a large flat export resolves same-space comment links',()=>{
  const objects=[space,'<object class="UnknownConfiguration"><property name="secret">never-copy-this</property></object>'];
  for(let i=0;i<1200;i++){objects.push(page(String(1000+i),`문서 ${i}`));objects.push(body(String(10000+i),'Page',String(1000+i),`<p>${i}</p>`));}
  objects.push(object('Comment','300',r('containerContent','Page','1000')),body('400','Comment','300','<ri:page ri:content-title="문서 1199"/>'));
  const data=parseConfluence(files(objects),'confluence-flat');
  assert.equal(data.records.length,1202);assert.deepEqual(data.unsupported,[{type:'UnknownConfiguration',count:1}]);assert.ok(!JSON.stringify(data).includes('never-copy-this'));assert.ok(refHas(find(data,'comment','300'),'page','2199','page-link'));
});

test('a non-scalar body is a blocking diagnostic and CDATA declarations are kept as harmless text',()=>{
  const literal='<!DOCTYPE example [<!ENTITY marker "not-executed">]>';
  const data=parseConfluence(files([space,page('100','문서'),page('101','비표준'),body('200','Page','100',literal),object('BodyContent','201','<property name="body"><p>not a scalar export value</p></property>'+r('content','Page','101'))]),'confluence-nonscalar');
  assert.equal(find(data,'page','100').text,literal);assert.ok(codes(data).includes('CONFLUENCE_STORAGE_ANALYSIS_INCOMPLETE'));assert.ok(data.diagnostics.some(item=>item.code==='CONFLUENCE_NON_SCALAR_BODY'&&item.severity==='error'&&item.recordId==='page:101'));
});
