import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMigrationOptions,buildMigrationPlan } from '../../server/migration-planner.js';
import { record } from '../../server/legacy-import-model.js';
import type { MigrationPackage,MigrationPlanningInput } from '../../server/migration-contracts.js';
import type { LegacyDataset,LegacyRecord,User } from '../../shared/types.js';
import { contentReferences } from '../../shared/document-nodes.js';
import { parseJira } from '../../server/legacy-import-jira.js';

const now='2026-11-19T12:00:00.000Z',created='2020-01-01T00:00:00.000Z',actor:User={id:'actor',name:'이관 작업자',email:'actor@example.test',color:'#668899'};
function pkg(id:string,product:'jira'|'confluence',records:LegacyRecord[],diagnostics:LegacyDataset['diagnostics']=[]):MigrationPackage{const source={product,format:product==='jira'?'jira-backup-xml' as const:'confluence-xml' as const,instanceKey:id,declaredVersion:'synthetic',timezone:null};return{summary:{id,filename:`${id}.zip`,sha256:createHash('sha256').update(id).digest('hex'),size:100,version:1,createdAt:now,actorId:actor.id,source,counts:{},errors:diagnostics.filter(item=>item.severity==='error').length,warnings:0,fileCount:1,expandedBytes:100,applySupported:false},dataset:{source,records,diagnostics,unsupported:[]}};}
const issue=(id:string,extra:Partial<LegacyRecord>={})=>record('issue',id,{title:`업무 ${id}`,containerId:'j',authorId:'alice',createdAt:created,updatedAt:created,text:'원본 업무 설명',textFormat:'plain',metadata:{key:`OLD-${id}`,fields:{status:{id:'open',name:'원본 열림'},issuetype:{id:'bug',name:'버그'}}},references:[{kind:'identity',sourceId:'alice',relation:'creator'}],...extra});
const page=(id:string,extra:Partial<LegacyRecord>={})=>record('page',id,{title:`문서 ${id}`,containerId:'s',authorId:'bob',createdAt:created,updatedAt:created,text:'<p>현재 본문</p>',textFormat:'confluence-storage',metadata:{version:'3'},references:[],...extra});
function jira(){return pkg('jira','jira',[record('project','j',{title:'기존 Jira',metadata:{key:'OLD'}}),record('identity','alice',{title:'원래 작성자'}),record('field','number',{title:'점수',metadata:{fieldType:'number'}}),record('field','flag',{title:'확인',metadata:{fieldType:'boolean'}}),record('field','choice',{title:'영향',metadata:{fieldType:'select'}}),record('option','high',{title:'높음',containerId:'choice'}),issue('1',{metadata:{key:'OLD-1',fields:{status:{id:'open',name:'원본 열림'},issuetype:{id:'bug',name:'버그'},number:0,flag:false,choice:{id:'high',value:'높음'}}}}),issue('2',{parentId:'1'}),record('comment','jc',{title:'댓글',containerId:'1',authorId:'alice',createdAt:created,text:'원래 댓글',textFormat:'plain',references:[{kind:'issue',sourceId:'1',relation:'commentOn'}]}),record('history','jh',{containerId:'1',authorId:'alice',createdAt:created,metadata:{items:[{field:'status',from:'Open',to:'Closed'}]},references:[{kind:'issue',sourceId:'1',relation:'historyOf'}]}),record('relation','blocks',{title:'Blocks',references:[{kind:'issue',sourceId:'1',relation:'source'},{kind:'issue',sourceId:'2',relation:'target'}]})]);}
function confluence(){return pkg('wiki','confluence',[record('project','s',{title:'기존 문서',metadata:{spaceKey:'TEAM'}}),record('identity','bob',{title:'원래 문서 작성자'}),page('10'),record('revision','old10',{title:'과거 문서',containerId:'s',authorId:'bob',createdAt:created,updatedAt:created,text:'<p>과거 본문</p>',textFormat:'confluence-storage',metadata:{version:'1',currentVersionId:'10'},references:[{kind:'page',sourceId:'10',relation:'current-version'}]}),record('comment','wc',{title:'댓글',containerId:'10',authorId:'bob',createdAt:created,text:'문서 댓글',textFormat:'plain',references:[{kind:'page',sourceId:'10',relation:'container-content'}]})]);}
function input(packages:MigrationPackage[]):MigrationPlanningInput{const configuration=buildMigrationOptions(packages).defaultConfiguration;configuration.projects=configuration.projects.map(value=>({...value,key:'NEW',name:'한 팀'}));return{id:'import-test',configuration,actorId:actor.id,users:[actor],existingProjectKeys:['EXISTING'],packages,now};}
const notices=(plan:ReturnType<typeof buildMigrationPlan>)=>new Set(plan.preview.notices.map(notice=>notice.code));

test('options are stable opaque IDs scoped by package and include an explicit editable default configuration',()=>{
  const packages=[jira(),confluence()],a=buildMigrationOptions(packages),b=buildMigrationOptions([...packages].reverse());assert.deepEqual(a.statuses.map(item=>item.id),b.statuses.map(item=>item.id));assert.ok(a.statuses.every(item=>!item.id.includes(item.label)));assert.equal(a.containers[0].issueCount,2);assert.equal(a.containers[1].documentCount,1);assert.equal(a.defaultConfiguration.timezone,'UTC');assert.equal(a.defaultConfiguration.datePolicy,'block');assert.ok(Object.values(a.defaultConfiguration.users).every(value=>value===null));assert.equal(a.defaultConfiguration.fields[a.fields.find(field=>field.sourceValue==='flag')!.id],'checkbox');assert.equal(buildMigrationOptions([pkg('other','jira',[issue('1')])]).statuses[0].id===a.statuses[0].id,false);
});

test('pure planning merges selected containers, preserves typed zero/false and archives every original history/author exactly',()=>{
  const packages=[jira(),confluence()],original=structuredClone(packages),request=input(packages),options=buildMigrationOptions(packages);for(const identity of options.identities)request.configuration.users[identity.id]=actor.id;const plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true,JSON.stringify(plan.preview.notices));assert.equal(plan.projects.length,1);assert.equal(plan.issues.length,2);assert.equal(plan.documents.length,1);assert.equal(plan.comments.length,2);assert.equal(plan.revisions.length,2);assert.equal(plan.documents[0].version,3);assert.equal(plan.revisions.find(revision=>revision.title==='과거 문서')!.version,1);assert.equal(plan.sourceImport.id,request.id);assert.equal(plan.preview.id,request.id);assert.deepEqual(packages,original);
  const issue=plan.issues.find(issue=>issue.title==='업무 1')!,schema=plan.issueSchemas[0];assert.equal(issue.customFields![schema.fields.find(field=>field.name==='점수')!.id],0);assert.equal(issue.customFields![schema.fields.find(field=>field.name==='확인')!.id],false);assert.equal(plan.workflows[0].statuses[0].label,'원본 열림');assert.equal(plan.issues.find(issue=>issue.title==='업무 2')!.parentId,issue.id);assert.equal(plan.issueRelations[0].type,'Blocks');assert.ok(notices(plan).has('WORKFLOW_RULES_NOT_REPRODUCED'));assert.equal(plan.sourceRecords.length,packages.reduce((sum,pkg)=>sum+pkg.dataset.records.length,0));const history=plan.sourceRecords.find(row=>row.record.id==='history:jh')!;assert.equal(history.targetId,null);assert.equal(history.ownerType,'issue');assert.equal(history.ownerId,issue.id);assert.deepEqual(history.record,packages[0].dataset.records.find(row=>row.id==='history:jh'));assert.ok(plan.sourceRecords.every(row=>row.id!==row.record.id));
});

test('all available attachment versions retain distinct files and a missing newest version requires acknowledgement',()=>{
  const source=confluence(),sha1=createHash('sha256').update('one').digest('hex'),sha2=createHash('sha256').update('two').digest('hex');source.dataset.records.push(record('attachment','a3',{title:'image.png',containerId:'10',authorId:'bob',createdAt:created,metadata:{version:'3'},references:[{kind:'page',sourceId:'10',relation:'container-content'}]}),record('attachment','a2',{title:'image.png',containerId:'10',authorId:'bob',createdAt:created,metadata:{version:'2',currentVersionId:'a3',packagePath:'attachments/two',sha256:sha2,size:3,mimeType:'text/html'},references:[{kind:'page',sourceId:'10',relation:'container-content'}]}),record('attachment','a1',{title:'image.png',containerId:'10',authorId:'bob',createdAt:created,metadata:{version:'1',currentVersionId:'a3',packagePath:'attachments/one',sha256:sha1,size:3},references:[{kind:'page',sourceId:'10',relation:'container-content'}]}));source.dataset.records.find(row=>row.id==='page:10')!.text='<ac:image><ri:attachment ri:filename="image.png"/></ac:image>';const request=input([source]);request.fileInfo={wiki:{'attachments/one':{size:3,sha256:sha1,mimeType:'image/png'},'attachments/two':{size:3,sha256:sha2,mimeType:'image/png'}}};const plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true,JSON.stringify(plan.preview.notices));assert.equal(plan.attachments.length,1);assert.equal(plan.attachmentVersions.length,2);assert.equal(plan.fileCopies.length,2);const latest=plan.attachmentVersions.find(version=>version.versionLabel==='2')!;assert.equal(plan.attachments[0].id,latest.id);assert.equal(plan.attachments[0].mimeType,'image/png');assert.ok(plan.attachmentVersions.every(version=>version.attachmentId===latest.id));assert.equal(new Set(plan.fileCopies.map(file=>file.fileId)).size,2);assert.ok(plan.preview.requiredAcknowledgements.includes('ATTACHMENT_LATEST_MISSING'));const absent=plan.sourceRecords.find(row=>row.record.id==='attachment:a3')!;assert.equal(absent.targetId,null);assert.equal(absent.ownerId,plan.documents[0].id);assert.equal(plan.sourceRecords.find(row=>row.record.id==='attachment:a1')!.targetId,plan.attachmentVersions.find(version=>version.versionLabel==='1')!.id);assert.ok(JSON.stringify(plan.documents[0].content).includes(`attachments/${latest.id}/content?inline=1`));
});

test('restricted content blocks apply and explicit primary exclusion cascades descendants while preserving source archives',()=>{
  const source=confluence();source.dataset.records.find(row=>row.id==='page:10')!.metadata.restricted=true;source.dataset.diagnostics.push({id:'restricted',severity:'error',code:'CONFLUENCE_RESTRICTED_CONTENT',message:'restricted',recordId:'page:10',path:null});const request=input([source]),blocked=buildMigrationPlan(request);assert.equal(blocked.preview.canApply,false);assert.ok(notices(blocked).has('RESTRICTED_CONTENT'));request.configuration.excludedRecords=['wiki/page:10'];const allowed=buildMigrationPlan(request);assert.equal(allowed.preview.canApply,true,JSON.stringify(allowed.preview.notices));assert.equal(allowed.documents.length,0);assert.equal(allowed.comments.length,0);assert.equal(allowed.revisions.length,0);assert.equal(allowed.preview.counts.excludedRecords,3);for(const archive of allowed.sourceRecords.filter(row=>['page','comment','revision'].includes(row.record.kind))){assert.equal(archive.targetId,null);assert.equal(archive.ownerId,null);}assert.equal(allowed.sourceRecords.length,source.dataset.records.length);for(const[field,value]of [['security',{id:'private',name:'비공개'}],['Security Level','Internal']] as const){const source=jira();(source.dataset.records.find(row=>row.id==='issue:1')!.metadata.fields as Record<string,unknown>)[field]=value;assert.equal(buildMigrationPlan(input([source])).preview.canApply,false);}for(const internal of ['false','true']){const source=jira();source.dataset.records.find(row=>row.id==='comment:jc')!.metadata.visibility=[{key:'sd.public.comment',value:{internal}}];assert.equal(buildMigrationPlan(input([source])).preview.canApply,internal==='false');}
});

test('IANA date conversion handles local offsets and rejects DST ambiguity/nonexistent dates unless fallback is acknowledged',()=>{
  const source=jira(),row=source.dataset.records.find(row=>row.id==='issue:1')!;row.createdAt='2020-01-01 09:15:00.125';let request=input([source]);request.configuration.timezone='Asia/Seoul';let plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true);assert.equal(plan.issues.find(issue=>issue.title==='업무 1')!.createdAt,'2020-01-01T00:15:00.125Z');
  for(const date of ['2024-11-03 01:30:00','2024-03-10 02:30:00','2024-02-31T12:00:00Z','10/11/2020 08:50']){row.createdAt=date;request=input([source]);request.configuration.timezone='America/New_York';plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,false,date);assert.ok(notices(plan).has('DATE_UNRESOLVED'));request.configuration.datePolicy='import-time';plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true,JSON.stringify(plan.preview.notices));assert.equal(plan.issues.find(issue=>issue.title==='업무 1')!.createdAt,now);assert.ok(plan.preview.requiredAcknowledgements.includes('DATE_IMPORT_TIME'));assert.equal(plan.sourceRecords.find(archive=>archive.record.id==='issue:1')!.record.createdAt,date);}
  const csv=pkg('csv','jira',[]);csv.dataset=parseJira(new Map([['issues.csv',Buffer.from('Issue key,Summary,Created\nOLD-1,날짜 원본,15/Oct/10 8:50 AM')]]),'csv');csv.summary.source=csv.dataset.source;request=input([csv]);request.configuration.timezone='Asia/Seoul';plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true,JSON.stringify(plan.preview.notices));assert.equal(plan.issues[0].createdAt,'2010-10-14T23:50:00.000Z');assert.ok(plan.preview.requiredAcknowledgements.includes('DATE_TWO_DIGIT_CENTURY'));assert.equal(plan.sourceRecords.find(archive=>archive.record.kind==='issue')!.record.createdAt,'15/Oct/10 8:50 AM');
  for(const[date,expected]of [['15/Oct/2010 12:50 PM','2010-10-15T03:50:00.000Z'],['15/Oct/2010 12:50 AM','2010-10-14T15:50:00.000Z']]){row.createdAt=date;request=input([source]);request.configuration.timezone='Asia/Seoul';plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true);assert.equal(plan.issues.find(issue=>issue.title==='업무 1')!.createdAt,expected);assert.ok(!plan.preview.requiredAcknowledgements.includes('DATE_TWO_DIGIT_CENTURY'));}
});

test('cross-package URLs must match configured source host and ambiguous unqualified IDs remain unresolved',()=>{
  const source=pkg('source','confluence',[record('project','s',{title:'원본 공간'}),page('10',{text:'<p><a href="https://wiki-a.test/wiki/pages/viewpage.action?pageId=20">올바른 주소</a></p><p><a href="https://evil.test/pages/viewpage.action?pageId=20">외부 주소</a></p><p><a href="https://wiki-a.test/wiki-other/pages/viewpage.action?pageId=20">다른 컨텍스트</a></p><ac:link><ri:page ri:content-id="20"/></ac:link>'})]),a=pkg('a','confluence',[record('project','s',{title:'공간 A'}),page('20',{title:'문서 A'})]),b=pkg('b','confluence',[record('project','s',{title:'공간 B'}),page('20',{title:'문서 B'})]),request=input([source,a,b]);request.configuration.sourceBaseUrls={source:'https://origin.test',a:'https://wiki-a.test/wiki',b:'https://wiki-b.test'};const plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true,JSON.stringify(plan.preview.notices));const document=plan.documents.find(document=>document.title==='문서 10')!,references=contentReferences(document.content);assert.equal(references.length,1);assert.equal(references[0].id,plan.documents.find(document=>document.title==='문서 A')!.id);assert.ok(document.plainText.includes('evil.test'));assert.ok(document.plainText.includes('wiki-other'));assert.ok(notices(plan).has('UNRESOLVED_REFERENCE'));
});

test('source issue links remain typed relations and document links do not become scheduling dependencies',()=>{
  const source=jira(),wiki=confluence();source.dataset.records.push(record('relation','remote',{title:'문서 연결',metadata:{url:'https://wiki.test/pages/viewpage.action?pageId=10'},references:[{kind:'issue',sourceId:'1',relation:'source'},{kind:'page',sourceId:'10',relation:'externalDocument'}]}));wiki.dataset.records.find(row=>row.id==='page:10')!.text='<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">OLD-1</ac:parameter></ac:structured-macro>';const request=input([source,wiki]);request.configuration.sourceBaseUrls.wiki='https://wiki.test';const plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true);assert.equal(plan.issueRelations.length,1);assert.equal(plan.issueRelations[0].type,'Blocks');assert.equal(plan.resourceLinks.length,1);assert.ok(!Object.hasOwn(plan,'dependencies'));
});

test('migration origins use each package base and the original key or current page ID', () => {
  const issues = jira();
  const firstIssue = issues.dataset.records.find(row => row.id === 'issue:1')!;
  firstIssue.metadata.key = 'old-1';
  firstIssue.metadata.originalUrl = 'https://other.test/browse/OLD-1';
  const wiki = confluence();
  const firstPage = wiki.dataset.records.find(row => row.id === 'page:10')!;
  firstPage.metadata.originalUrl = 'https://other.test/pages/viewpage.action?pageId=10';
  firstPage.text = '<p><a href="https://wiki.test/%77iki-b/pages/viewpage.action?pageId=10">다른 원본 문서</a></p>';
  const wikiB = pkg('wiki-b', 'confluence', [record('project', 's', { title: '별도 공간' }), page('10', { title: '별도 문서', authorId: null })]);
  const request = input([issues, wiki, wikiB]);
  request.configuration.sourceBaseUrls = {
    jira: ' https://JIRA.test:443/tools/jira/ ',
    wiki: 'https://wiki.test/wiki-a///',
    'wiki-b': 'https://wiki.test/%77iki-b/',
  };
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.deepEqual(plan.preview.configuration.sourceBaseUrls, {
    jira: 'https://jira.test/tools/jira', wiki: 'https://wiki.test/wiki-a', 'wiki-b': 'https://wiki.test/wiki-b',
  });
  assert.equal(request.configuration.sourceBaseUrls['wiki-b'], 'https://wiki.test/%77iki-b/');
  const issue = plan.issues.find(value => value.key === 'NEW-1')!;
  const document = plan.documents.find(value => value.title === '문서 10')!;
  const secondDocument = plan.documents.find(value => value.title === '별도 문서')!;
  assert.deepEqual(contentReferences(document.content).map(reference => reference.id), [secondDocument.id]);
  assert.deepEqual(plan.atlassianLinks, [
    { targetType: 'issue', targetId: issue.id, product: 'jira', url: 'https://jira.test/tools/jira/browse/OLD-1' },
    { targetType: 'issue', targetId: plan.issues[1].id, product: 'jira', url: 'https://jira.test/tools/jira/browse/OLD-2' },
    { targetType: 'document', targetId: document.id, product: 'confluence', url: 'https://wiki.test/wiki-a/pages/viewpage.action?pageId=10' },
    { targetType: 'document', targetId: secondDocument.id, product: 'confluence', url: 'https://wiki.test/wiki-b/pages/viewpage.action?pageId=10' },
  ]);
  assert.equal(plan.preview.counts.atlassianLinks, 4);
  assert.equal(plan.preview.counts.unlinkedAtlassianRecords, 0);
  assert.deepEqual(plan.sourceImport.counts, plan.preview.counts);
  assert.deepEqual(plan.preview.samples.map(sample => sample.sourceUrl), plan.atlassianLinks.map(link => link.url));
});

test('only migrated primary rows count toward aggregated unavailable origin notices', () => {
  const issues = jira();
  issues.dataset.records.push(issue('MIS-9', { metadata: { key: '', originalUrl: 'https://jira.test/browse/MIS-9' } }));
  const wiki = confluence();
  wiki.dataset.records.push(
    page('11'),
    page('bad-page-id', { metadata: { sourceClass: 'Page' } }),
    page('13', { metadata: { sourceClass: 'BlogPost' } }),
  );
  const withoutBase = pkg('missing-base', 'confluence', [record('project', 's', { title: '원본 공간' }), page('30', { authorId: null })]);
  const request = input([issues, wiki, withoutBase]);
  request.configuration.excludedRecords = ['wiki/page:11'];
  request.configuration.sourceBaseUrls.jira = 'https://jira.test';
  request.configuration.sourceBaseUrls.wiki = 'https://wiki.test';
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.equal(plan.preview.counts.atlassianLinks, 3);
  assert.equal(plan.preview.counts.unlinkedAtlassianRecords, 4);
  assert.ok(!plan.atlassianLinks.some(link => link.url.includes('MIS-9') || link.url.includes('pageId=11') || link.url.includes('pageId=13')));
  assert.equal(plan.preview.samples.find(sample => sample.recordId === 'jira/issue:MIS-9')?.sourceUrl, undefined);
  const skipped = plan.preview.notices.filter(notice => notice.code.startsWith('SOURCE_LINK_'));
  assert.deepEqual(skipped.map(({ code, severity, recordId, requiresAcknowledgement }) => ({ code, severity, recordId, requiresAcknowledgement })), [
    { code: 'SOURCE_LINK_LOCATOR_UNAVAILABLE', severity: 'warning', recordId: 'jira/issue:MIS-9', requiresAcknowledgement: false },
    { code: 'SOURCE_LINK_LOCATOR_UNAVAILABLE', severity: 'warning', recordId: 'wiki/page:bad-page-id', requiresAcknowledgement: false },
    { code: 'SOURCE_LINK_BASE_MISSING', severity: 'info', recordId: 'missing-base/page:30', requiresAcknowledgement: false },
  ]);
  assert.match(skipped[1].message, /wiki\.zip.*2개/u);
});

test('invalid, item-level and unknown-package bases are blocked and absent from the generated plan', () => {
  const request = input([jira(), confluence()]);
  const invalid = [
    'https://user:sensitive-value@jira.test/jira',
    'https://jira.test/jira?sensitive-value',
    'https://jira.test/jira#sensitive-value',
    'https://jira.test/jira?',
    'https://jira.test/jira#',
    'https://jira.test/jira%2fsensitive-value',
    'https://jira.test/jira/browse/OLD-1',
    `https://jira.test/jira/${'a'.repeat(2048)}`,
    'ftp://jira.test/jira',
  ];
  for (const base of invalid) {
    request.configuration.sourceBaseUrls.jira = base;
    const plan = buildMigrationPlan(request);
    assert.equal(plan.preview.canApply, false, base);
    assert.ok(notices(plan).has('SOURCE_BASE_URL_INVALID'), base);
    assert.equal(plan.preview.configuration.sourceBaseUrls.jira, null);
    assert.equal(plan.sourceImport.configuration.sourceBaseUrls.jira, null);
    assert.equal(plan.preview.counts.atlassianLinks, 0);
    assert.equal(plan.preview.counts.unlinkedAtlassianRecords, 0);
    assert.ok(!JSON.stringify(plan).includes(base));
  }
  request.configuration.sourceBaseUrls = {
    jira: 'https://jira.test',
    wiki: 'https://wiki.test/wiki/spaces/TEAM/pages/10/Document',
    'unselected-sensitive-id': 'https://other.test/sensitive-value',
  };
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, false);
  assert.ok(notices(plan).has('SOURCE_BASE_URL_INVALID'));
  assert.ok(notices(plan).has('SOURCE_BASE_URL_UNKNOWN_PACKAGE'));
  assert.deepEqual(plan.preview.configuration.sourceBaseUrls, { jira: 'https://jira.test', wiki: null });
  assert.ok(!JSON.stringify(plan).includes('sensitive'));
});

test('project collisions, invalid field casts, parent/include cycles and unsafe file metadata block rather than silently drop',()=>{
  const request=input([jira()]);request.existingProjectKeys=['NEW'];let plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,false);assert.ok(notices(plan).has('PROJECT_KEY_CONFLICT'));request.existingProjectKeys=[];const row=request.packages[0].dataset.records.find(row=>row.id==='issue:1')!;(row.metadata.fields as Record<string,unknown>).number='not a number';plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,false);assert.ok(notices(plan).has('FIELD_VALUE_INVALID'));
  const source=confluence();source.dataset.records.find(row=>row.id==='page:10')!.text='<ac:structured-macro ac:name="include"><ac:parameter ac:name="page"><ri:page ri:content-id="20"/></ac:parameter></ac:structured-macro>';source.dataset.records.push(page('20',{text:'<ac:structured-macro ac:name="include"><ac:parameter ac:name="page"><ri:page ri:content-id="10"/></ac:parameter></ac:structured-macro>'}));plan=buildMigrationPlan(input([source]));assert.equal(plan.preview.canApply,false);assert.ok(notices(plan).has('DOCUMENT_INCLUDE_CYCLE'));source.dataset.records.find(row=>row.id==='page:10')!.text='<p>본문</p>';source.dataset.records.find(row=>row.id==='page:20')!.text='<p>본문</p>';source.dataset.records.find(row=>row.id==='page:10')!.parentId='20';source.dataset.records.find(row=>row.id==='page:20')!.parentId='10';plan=buildMigrationPlan(input([source]));assert.equal(plan.preview.canApply,false);assert.ok(notices(plan).has('DOCUMENT_PARENT_CYCLE'));
});

test('zero-byte and absent files stay source-only, and compact samples never truncate private canonical contents',()=>{
  const source=confluence(),text='본문 '.repeat(2000);source.dataset.records.find(row=>row.id==='page:10')!.text=`<p>${text}</p>`;source.dataset.records.push(record('attachment','empty',{title:'empty.txt',containerId:'10',createdAt:created,metadata:{packagePath:'attachments/empty',size:0,sha256:createHash('sha256').update('').digest('hex')},references:[{kind:'page',sourceId:'10',relation:'container-content'}]}));const request=input([source]);request.fileInfo={wiki:{'attachments/empty':{size:0,sha256:createHash('sha256').update('').digest('hex'),mimeType:'application/octet-stream'}}};const plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true);assert.equal(plan.attachments.length,0);assert.equal(plan.fileCopies.length,0);assert.ok(plan.preview.requiredAcknowledgements.includes('ATTACHMENT_EMPTY_ARCHIVED'));assert.ok(plan.preview.samples[0].plainText.length<3100);assert.ok(plan.preview.samples[0].plainText.includes('일부만 표시'));assert.ok(plan.documents[0].plainText.length>5000);assert.ok(!plan.preview.samples[0].content);
});
