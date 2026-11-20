import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMigrationOptions,buildMigrationPlan } from '../../server/migration-planner.js';
import { record } from '../../server/legacy-import-model.js';
import type { MigrationPackage,MigrationPlanningInput } from '../../server/migration-contracts.js';
import type { LegacyDataset,LegacyRecord,User } from '../../shared/types.js';
import { contentReferences } from '../../shared/document-nodes.js';
import { parseConfluence } from '../../server/legacy-import-confluence.js';
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

test('Jira refresh clears explicit blank CSV fields while protecting malformed values and source-unchanged mappings', () => {
  const snapshot = (id: string, extension: 'json' | 'csv', data: string): MigrationPackage => {
    const filename = `issues.${extension}`;
    const source = pkg(id, 'jira', []);
    source.dataset = parseJira(new Map([[filename, Buffer.from(data)]]), 'same-jira');
    source.summary = { ...source.summary, filename, source: source.dataset.source };
    return source;
  };
  const issueJson = (id: string, key: string, updated: string, summary: string, fields: object): object => ({ id, key, fields: {
    project: { id: '42', key: 'OLD' }, summary, updated, created,
    issuetype: { id: '3', name: 'Task' }, ...fields,
  } });
  const open = { id: '1', name: 'Open' }, done = { id: '2', name: 'Done' };
  const original = snapshot('original', 'json', JSON.stringify({ issues: [
    issueJson('1', 'OLD-1', created, '남길 제목', { status: open, description: '비울 설명', labels: ['alpha', 'beta'],
      assignee: { name: 'original-owner' }, priority: { id: '4', name: 'High' } }),
    issueJson('2', 'OLD-2', created, '보조 업무', { status: done }),
  ] }));
  const request = input([original]);
  for (const identity of buildMigrationOptions([original]).identities) request.configuration.users[identity.id] = actor.id;
  const baseline = buildMigrationPlan(request);
  assert.equal(baseline.preview.canApply, true, JSON.stringify(baseline.preview.notices));
  const canonical = baseline.issues[0];
  const archive = baseline.sourceRecords.find(row => row.targetId === canonical.id)!;
  const project = baseline.projects[0], workflow = baseline.workflows[0], schema = baseline.issueSchemas[0];
  const refresh = (source: MigrationPackage, current = canonical) => {
    const planned = input([source]);
    planned.configuration.appendTo = {
      projectId: project.id, refreshExisting: true,
      statuses: Object.fromEntries(buildMigrationOptions([source]).statuses.map(option => [option.id, workflow.statuses[1].id])),
      issueTypes: {}, fields: {},
    };
    planned.append = {
      project, workflow, schema, nextIssueNumber: 3, token: 'test-planner',
      knownIssues: [{ alias: '1', issueId: canonical.id, projectId: project.id }, { alias: 'OLD-1', issueId: canonical.id, projectId: project.id }],
      refreshIssues: [{ issue: current, previous: { archive, stagingId: original.summary.id, configuration: request.configuration } }],
    };
    return buildMigrationPlan(planned);
  };
  const csv = 'Issue id,Issue key,Project id,Project key,Summary,Updated,Description,Assignee,Labels,Labels,Priority,Status\n' +
    '1,OLD-1,42,OLD,남길 제목,2020-01-02T00:00:00Z,,,beta,alpha,Unrecognized,Open';
  const clear = refresh(snapshot('csv', 'csv', csv), { ...canonical, status: workflow.statuses[1].id });
  assert.equal(clear.preview.canApply, true, JSON.stringify(clear.preview.notices));
  assert.deepEqual(clear.issueUpdates?.[0].changes, { description: '', assigneeId: null });
  assert.deepEqual(clear.preview.issueRefresh?.[0].fields.map(field => field.field), ['description', 'assigneeId']);
  assert.equal(clear.sourceRecords.find(row => row.targetId === canonical.id)?.jiraIssueFieldHashes?.status, archive.jiraIssueFieldHashes?.status);
  assert.ok(notices(clear).has('JIRA_REFRESH_FIELD_UNAVAILABLE'));
  const bad = refresh(snapshot('malformed', 'json', JSON.stringify({ issues: [
    issueJson('1', 'OLD-1', '2020-01-02T00:00:00Z', '남길 제목', {
      status: open, description: { type: 'unrecognized' }, labels: { malformed: true }, priority: 'Unrecognized',
    }),
  ] })));
  assert.equal(bad.preview.canApply, false);
  assert.deepEqual(bad.issueUpdates, []);
  assert.ok(bad.preview.notices.some(notice => notice.code === 'JIRA_REFRESH_FIELD_UNAVAILABLE' && notice.message.includes('설명')));
  assert.ok(bad.preview.notices.some(notice => notice.code === 'JIRA_REFRESH_FIELD_UNAVAILABLE' && notice.message.includes('라벨')));
});

test('pure planning merges selected containers, preserves typed zero/false and archives every original history/author exactly',()=>{
  const packages=[jira(),confluence()],original=structuredClone(packages),request=input(packages),options=buildMigrationOptions(packages);for(const identity of options.identities)request.configuration.users[identity.id]=actor.id;const plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true,JSON.stringify(plan.preview.notices));assert.equal(plan.projects.length,1);assert.equal(plan.issues.length,2);assert.equal(plan.documents.length,1);assert.equal(plan.comments.length,2);assert.equal(plan.revisions.length,2);assert.equal(plan.documents[0].version,3);assert.equal(plan.revisions.find(revision=>revision.title==='과거 문서')!.version,1);assert.equal(plan.sourceImport.id,request.id);assert.equal(plan.preview.id,request.id);assert.deepEqual(packages,original);
  const issue=plan.issues.find(issue=>issue.title==='업무 1')!,schema=plan.issueSchemas[0];assert.equal(issue.customFields![schema.fields.find(field=>field.name==='점수')!.id],0);assert.equal(issue.customFields![schema.fields.find(field=>field.name==='확인')!.id],false);assert.equal(plan.workflows[0].statuses[0].label,'원본 열림');assert.equal(plan.issues.find(issue=>issue.title==='업무 2')!.parentId,issue.id);assert.equal(plan.issueRelations[0].type,'Blocks');assert.ok(notices(plan).has('WORKFLOW_RULES_NOT_REPRODUCED'));assert.equal(plan.sourceRecords.length,packages.reduce((sum,pkg)=>sum+pkg.dataset.records.length,0));const history=plan.sourceRecords.find(row=>row.record.id==='history:jh')!;assert.equal(history.targetId,null);assert.equal(history.ownerType,'issue');assert.equal(history.ownerId,issue.id);assert.deepEqual(history.record,packages[0].dataset.records.find(row=>row.id==='history:jh'));assert.ok(plan.sourceRecords.every(row=>row.id!==row.record.id));
});

test('Confluence refresh preserves omitted and unsafe bodies, reviews formatting changes and protects mixed document graphs', () => {
  const space = record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } });
  const original = pkg('original-wiki', 'confluence', [space, page('10', { authorId: null })]);
  const baseline = buildMigrationPlan(input([original]));
  assert.equal(baseline.preview.canApply, true, JSON.stringify(baseline.preview.notices));
  const project = baseline.projects[0], canonical = baseline.documents[0];
  const archive = baseline.sourceRecords.find(row => row.targetId === canonical.id)!;
  assert.ok(archive.confluencePageFieldHashes?.title);
  assert.ok(archive.confluencePageFieldHashes.content);
  const olderArchive = { ...archive };
  delete olderArchive.confluencePageFieldHashes;
  const refresh = (rows: LegacyRecord[], document = canonical, previous = archive) => {
    const delta = pkg('delta-wiki', 'confluence', [{ ...space }, ...rows]);
    delta.dataset.source.instanceKey = original.dataset.source.instanceKey;
    const request = input([delta]);
    request.configuration.appendPagesTo = { projectId: project.id, refreshExisting: true };
    request.appendPages = {
      project, sourceSpaceId: 's', sourceSpaceKey: 'TEAM', token: 'append-documents',
      knownPages: [{ sourceId: '10', documentId: canonical.id, projectId: project.id, sourceSpaceId: 's', sourceTitle: canonical.title }],
      refreshDocuments: [{ document, previous, previousTimezone: 'UTC' }],
    };
    return buildMigrationPlan(request);
  };
  const next = (options: Partial<LegacyRecord> = {}) => page('10', { authorId: null, metadata: { version: '4' }, ...options });
  const previousWithoutHashes = refresh([next({ title: '새 원본 제목', text: '<p><strong>현재 본문</strong></p>' })],
    { ...canonical, version: 14, title: '팀이 바꾼 제목' }, olderArchive);
  assert.equal(previousWithoutHashes.preview.canApply, true, JSON.stringify(previousWithoutHashes.preview.notices));
  assert.deepEqual(previousWithoutHashes.preview.documentRefresh?.[0].fields.map(field => [field.field, field.decision, field.formatOnly]),
    [['title', 'conflict', undefined], ['content', 'apply', true]]);
  assert.equal(previousWithoutHashes.documentUpdates?.[0].expectedVersion, 14);
  assert.deepEqual(Object.keys(previousWithoutHashes.documentUpdates![0].changes), ['content']);
  assert.equal(previousWithoutHashes.revisions.length, 0);
  const checkpoint = previousWithoutHashes.sourceRecords.find(row => row.targetId === canonical.id)!;
  assert.equal(checkpoint.confluencePageFieldHashes?.title, archive.confluencePageFieldHashes.title);
  assert.notEqual(checkpoint.confluencePageFieldHashes?.content, archive.confluencePageFieldHashes.content);

  const parsedPage = (title: string, body: string) => {
    const xml = `<hibernate-generic><object class="Page"><id name="id">10</id><property name="title">${title}</property><property name="version">4</property><property name="space" class="Space"><id name="id">s</id></property></object>${body}</hibernate-generic>`;
    return parseConfluence(new Map([['entities.xml', Buffer.from(xml)]]), original.dataset.source.instanceKey).records.find(row => row.kind === 'page')!;
  };
  const bodyContent = (body: string) => `<object class="BodyContent"><id name="id">30</id><property name="content" class="Page"><id name="id">10</id></property>${body}</object>`;
  for (const body of ['', bodyContent('')]) {
    const omitted = refresh([parsedPage('새 원본 제목', body)]);
    assert.deepEqual(omitted.documentUpdates?.[0].changes, { title: '새 원본 제목' });
  }
  const blank = refresh([parsedPage(canonical.title, bodyContent('<property name="body"></property>'))]);
  assert.equal(blank.preview.documentRefresh?.[0].fields[0].field, 'content');
  assert.equal(blank.preview.documentRefresh?.[0].fields[0].incoming, '');
  assert.ok(blank.documentUpdates?.[0].changes.content);

  const unsafe = refresh([next({ title: '안전한 제목 변경', text: '<ac:image><ri:attachment ri:filename="retained.png"/></ac:image>' })]);
  assert.equal(unsafe.preview.canApply, true, JSON.stringify(unsafe.preview.notices));
  assert.deepEqual(unsafe.documentUpdates?.[0].changes, { title: '안전한 제목 변경' });
  assert.ok(unsafe.preview.requiredAcknowledgements.includes('CONFLUENCE_REFRESH_BODY_UNAVAILABLE'));
  const stale = refresh([next({ text: '<p>오래된 본문</p>', metadata: { version: '2' }, updatedAt: now })]);
  assert.equal(stale.preview.canApply, false);
  assert.ok(notices(stale).has('CONFLUENCE_REFRESH_SOURCE_NOT_NEWER'));
  const timed = refresh([next({ title: '버전 없이 시간 확인', metadata: {}, updatedAt: now })]);
  assert.equal(timed.documentUpdates?.[0].changes.title, '버전 없이 시간 확인');

  const include = (id: string) => `<ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ri:page ri:content-id="${id}"/></ac:parameter></ac:structured-macro>`;
  const mixed = refresh([next({ text: include('20') }), page('20', { authorId: null })]);
  assert.equal(mixed.preview.canApply, true, JSON.stringify(mixed.preview.notices));
  assert.deepEqual(contentReferences(mixed.documentUpdates![0].changes.content!).map(reference => reference.id), [mixed.documents[0].id]);
  const cycle = refresh([next({ text: include('20') }), page('20', { authorId: null, text: include('10') })]);
  assert.equal(cycle.preview.canApply, false);
  assert.ok(notices(cycle).has('DOCUMENT_INCLUDE_CYCLE'));
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

test('Confluence titles use the original page space for current documents, historical revisions, and comments', () => {
  const sourceLink = (title: string, space?: string) =>
    `<ac:link><ri:page ri:content-title="${title}"${space ? ` ri:space-key="${space}"` : ''}/></ac:link>`;
  const source = pkg('source', 'confluence', [
    record('project', '20', { title: '원본 업무 공간', metadata: { spaceKey: 'OPS' } }),
    page('100', {
      title: '링크가 있는 페이지', containerId: '20', authorId: null,
      text: [sourceLink('공통 제목'), sourceLink('공통 제목', 'QA'), sourceLink('타 공간의 제목'),
        sourceLink('제외 대상'), sourceLink('중복 제목'), sourceLink('다른 인스턴스 전용', 'OPS')].join(''),
    }),
    page('101', { title: '공통 제목', containerId: '20', authorId: null }),
    page('102', { title: '제외 대상', containerId: '20', authorId: null }),
    page('103', { title: '중복 제목', containerId: '20', authorId: null }),
    page('104', { title: '중복 제목', containerId: '20', authorId: null }),
    record('revision', '099', {
      title: '이전 문서 제목', createdAt: created, updatedAt: created, text: sourceLink('공통 제목'), textFormat: 'confluence-storage',
      metadata: { version: '1', currentVersionId: '100' }, references: [{ kind: 'page', sourceId: '100', relation: 'current-version' }],
    }),
    record('comment', '500', {
      title: '참조가 있는 댓글', createdAt: created, containerId: '100', textFormat: 'confluence-storage',
      text: `<p>참조 댓글</p>${sourceLink('공통 제목')}${sourceLink('타 공간의 제목')}`,
      references: [{ kind: 'page', sourceId: '100', relation: 'container-content' }],
    }),
  ]);
  const anotherSpace = pkg('another-space', 'confluence', [
    record('project', '30', { title: '원본 검증 공간', metadata: { spaceKey: 'QA' } }),
    page('201', { title: '공통 제목', containerId: '30', authorId: null }),
    page('202', { title: '타 공간의 제목', containerId: '30', authorId: null }),
    page('203', { title: '제외 대상', containerId: '30', authorId: null }),
  ]);
  anotherSpace.dataset.source.instanceKey = source.dataset.source.instanceKey;
  const anotherInstance = pkg('another-instance', 'confluence', [
    record('project', '40', { title: '다른 서버의 업무 공간', metadata: { spaceKey: 'OPS' } }),
    page('301', { title: '공통 제목', containerId: '40', authorId: null }),
    page('302', { title: '다른 인스턴스 전용', containerId: '40', authorId: null }),
  ]);
  const request = input([source, anotherSpace, anotherInstance]);
  request.configuration.sourceBaseUrls = {
    source: 'https://original.example.test/wiki', 'another-space': 'https://original.example.test/wiki',
    'another-instance': 'https://separate.example.test/wiki',
  };
  request.configuration.excludedRecords = ['source/page:102', 'source/page:103'];
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.equal(plan.projects.length, 1, 'Original space, not the merged Teamspace project, governs title matching.');
  const target = (packageId: string, recordId: string) => plan.sourceRecords.find(row =>
    row.packageSha256 === request.packages.find(pkg => pkg.summary.id === packageId)?.summary.sha256 && row.record.id === recordId)?.targetId;
  const sourcePageId = target('source', 'page:100');
  const ownSpacePage = target('source', 'page:101');
  const otherSpacePage = target('another-space', 'page:201');
  assert.ok(sourcePageId && ownSpacePage && otherSpacePage);
  const current = plan.documents.find(document => document.id === sourcePageId)!;
  const historical = plan.revisions.find(revision => revision.id === target('source', 'revision:099'))!;
  const comment = plan.comments.find(value => value.id === target('source', 'comment:500'))!;
  assert.deepEqual(contentReferences(current.content).map(reference => reference.id), [ownSpacePage, otherSpacePage]);
  assert.deepEqual(contentReferences(historical.content).map(reference => reference.id), [ownSpacePage]);
  assert.equal(comment.resourceId, sourcePageId);
  assert.ok(comment.body.includes(ownSpacePage));
  assert.match(comment.body, /\[문서 참조: 타 공간의 제목\]/);
  for (const label of ['타 공간의 제목', '제외 대상', '중복 제목', 'OPS:다른 인스턴스 전용']) {
    assert.ok(current.plainText.includes(`[문서 참조: ${label}]`));
  }
  assert.ok(plan.preview.notices.some(value => value.recordId === 'source/page:100' && value.code === 'UNRESOLVED_REFERENCE'));
  assert.ok(plan.preview.notices.some(value => value.recordId === 'source/comment:500' && value.code === 'UNRESOLVED_REFERENCE'));
});

test('attachment owner and filename ambiguity remain unresolved even when exclusions leave one imported candidate', () => {
  const attachmentLink = (owner: string, label: string) =>
    `<p><ac:link><ri:attachment ri:filename="report.bin"><ri:page ri:content-title="${owner}" ri:space-key="QA"/></ri:attachment><ac:link-body>${label}</ac:link-body></ac:link></p>`;
  const binarySha = createHash('sha256').update('bytes').digest('hex');
  const attachment = (id: string, owner: string) => record('attachment', id, {
    title: 'report.bin', containerId: owner, createdAt: created,
    metadata: { version: '1', packagePath: `attachments/${owner}/${id}`, size: 5, sha256: binarySha },
    references: [{ kind: 'page', sourceId: owner, relation: 'container-content' }],
  });
  const source = pkg('wiki', 'confluence', [
    record('project', '20', { title: '업무 공간', metadata: { spaceKey: 'OPS' } }),
    record('project', '30', { title: '검토 공간', metadata: { spaceKey: 'QA' } }),
    page('100', { title: '첨부 참조 원본', containerId: '20', authorId: null, text: [
      attachmentLink('중복 페이지', '중복 소유'), attachmentLink('제외 페이지', '제외된 소유'), attachmentLink('첨부 페이지', '중복 이름'),
    ].join('') }),
    page('200', { title: '중복 페이지', containerId: '30', authorId: null }),
    page('201', { title: '중복 페이지', containerId: '30', authorId: null }),
    page('202', { title: '제외 페이지', containerId: '30', authorId: null }),
    page('203', { title: '첨부 페이지', containerId: '30', authorId: null }),
    attachment('700', '100'), attachment('710', '200'), attachment('711', '201'),
    attachment('712', '202'), attachment('713', '203'), attachment('714', '203'),
  ]);
  const request = input([source]);
  request.configuration.excludedRecords = ['wiki/page:200', 'wiki/page:202', 'wiki/attachment:713'];
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.equal(plan.attachments.length, 3);
  const converted = plan.documents.find(document => document.title === '첨부 참조 원본')!;
  for (const label of ['중복 소유', '제외된 소유', '중복 이름']) assert.ok(converted.plainText.includes(`[첨부: ${label}]`));
  assert.doesNotMatch(JSON.stringify(converted.content), /\/api\/attachments\//);
  assert.ok(plan.preview.notices.some(value => value.recordId === 'wiki/page:100' && value.code === 'UNRESOLVED_ATTACHMENT'));
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
