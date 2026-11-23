import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMigrationOptions,buildMigrationPlan } from '../../server/migration-planner.js';
import { convertLegacyContent } from '../../server/migration-content.js';
import { record } from '../../server/legacy-import-model.js';
import type { MigrationPackage,MigrationPlanningInput } from '../../server/migration-contracts.js';
import type { DocPage,LegacyDataset,LegacyRecord,LegacyValue,User } from '../../shared/types.js';
import { contentReferences } from '../../shared/document-nodes.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import { parseConfluence } from '../../server/legacy-import-confluence.js';
import { parseJira } from '../../server/legacy-import-jira.js';
import { allowedNextStatuses } from '../../shared/workflow-helpers.js';

const now='2026-11-19T12:00:00.000Z',created='2020-01-01T00:00:00.000Z',actor:User={id:'actor',name:'이관 작업자',email:'actor@example.test',color:'#668899'};
function pkg(id:string,product:'jira'|'confluence',records:LegacyRecord[],diagnostics:LegacyDataset['diagnostics']=[]):MigrationPackage{const source={product,format:product==='jira'?'jira-backup-xml' as const:'confluence-xml' as const,instanceKey:id,declaredVersion:'synthetic',timezone:null};return{summary:{id,filename:`${id}.zip`,sha256:createHash('sha256').update(id).digest('hex'),size:100,version:1,createdAt:now,actorId:actor.id,source,counts:{},errors:diagnostics.filter(item=>item.severity==='error').length,warnings:0,fileCount:1,expandedBytes:100,applySupported:false},dataset:{source,records,diagnostics,unsupported:[]}};}
const issue=(id:string,extra:Partial<LegacyRecord>={})=>record('issue',id,{title:`업무 ${id}`,containerId:'j',authorId:'alice',createdAt:created,updatedAt:created,text:'원본 업무 설명',textFormat:'plain',metadata:{key:`OLD-${id}`,fields:{status:{id:'open',name:'원본 열림'},issuetype:{id:'bug',name:'버그'}}},references:[{kind:'identity',sourceId:'alice',relation:'creator'}],...extra});
const page=(id:string,extra:Partial<LegacyRecord>={})=>record('page',id,{title:`문서 ${id}`,containerId:'s',authorId:'bob',createdAt:created,updatedAt:created,text:'<p>현재 본문</p>',textFormat:'confluence-storage',metadata:{version:'3'},references:[],...extra});
function jira(){return pkg('jira','jira',[record('project','j',{title:'기존 Jira',metadata:{key:'OLD'}}),record('identity','alice',{title:'원래 작성자'}),record('field','number',{title:'점수',metadata:{fieldType:'number'}}),record('field','flag',{title:'확인',metadata:{fieldType:'boolean'}}),record('field','choice',{title:'영향',metadata:{fieldType:'select'}}),record('option','high',{title:'높음',containerId:'choice'}),issue('1',{metadata:{key:'OLD-1',fields:{status:{id:'open',name:'원본 열림'},issuetype:{id:'bug',name:'버그'},number:0,flag:false,choice:{id:'high',value:'높음'}}}}),issue('2',{parentId:'1'}),record('comment','jc',{title:'댓글',containerId:'1',authorId:'alice',createdAt:created,text:'원래 댓글',textFormat:'plain',references:[{kind:'issue',sourceId:'1',relation:'commentOn'}]}),record('history','jh',{containerId:'1',authorId:'alice',createdAt:created,metadata:{items:[{field:'status',from:'Open',to:'Closed'}]},references:[{kind:'issue',sourceId:'1',relation:'historyOf'}]}),record('relation','blocks',{title:'Blocks',references:[{kind:'issue',sourceId:'1',relation:'source'},{kind:'issue',sourceId:'2',relation:'target'}]})]);}
function confluence(){return pkg('wiki','confluence',[record('project','s',{title:'기존 문서',metadata:{spaceKey:'TEAM'}}),record('identity','bob',{title:'원래 문서 작성자'}),page('10'),record('revision','old10',{title:'과거 문서',containerId:'s',authorId:'bob',createdAt:created,updatedAt:created,text:'<p>과거 본문</p>',textFormat:'confluence-storage',metadata:{version:'1',currentVersionId:'10'},references:[{kind:'page',sourceId:'10',relation:'current-version'}]}),record('comment','wc',{title:'댓글',containerId:'10',authorId:'bob',createdAt:created,text:'문서 댓글',textFormat:'plain',references:[{kind:'page',sourceId:'10',relation:'container-content'}]})]);}
function input(packages:MigrationPackage[]):MigrationPlanningInput{const configuration=buildMigrationOptions(packages).defaultConfiguration;configuration.projects=configuration.projects.map(value=>({...value,key:'NEW',name:'한 팀'}));return{id:'import-test',configuration,actorId:actor.id,users:[actor],existingProjectKeys:['EXISTING'],packages,now};}
const notices=(plan:ReturnType<typeof buildMigrationPlan>)=>new Set(plan.preview.notices.map(notice=>notice.code));
const adfStatus = (label: string) => ({ type: 'status', attrs: { text: label, color: 'yellow' } });
const storageStatus = (label: string) => `<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">${label}</ac:parameter><ac:parameter ac:name="colour">Yellow</ac:parameter></ac:structured-macro>`;

test('options are stable opaque IDs scoped by package and include an explicit editable default configuration',()=>{
  const packages=[jira(),confluence()],a=buildMigrationOptions(packages),b=buildMigrationOptions([...packages].reverse());assert.deepEqual(a.statuses.map(item=>item.id),b.statuses.map(item=>item.id));assert.ok(a.statuses.every(item=>!item.id.includes(item.label)));assert.equal(a.containers[0].issueCount,2);assert.equal(a.containers[1].documentCount,1);assert.equal(a.defaultConfiguration.timezone,'UTC');assert.equal(a.defaultConfiguration.datePolicy,'block');assert.ok(Object.values(a.defaultConfiguration.users).every(value=>value===null));assert.equal(a.defaultConfiguration.fields[a.fields.find(field=>field.sourceValue==='flag')!.id],'checkbox');assert.equal(buildMigrationOptions([pkg('other','jira',[issue('1')])]).statuses[0].id===a.statuses[0].id,false);
});

test('migration options distinguish source email consensus from legacy claims and preserve profile account identity', () => {
  const earlier = pkg('old-jira', 'jira', [
    record('identity', 'unchecked', { metadata: { emailAddress: 'Unchecked@Example.Test' } }),
    record('identity', 'no-email@example.test'),
  ]);
  const fresh = pkg('fresh-jira', 'jira', []);
  fresh.dataset = parseJira(new Map([['entities.xml', Buffer.from(`<entity-engine-xml>
    <User id="1" userName="checked" emailAddress=" Checked@Example.Test "/>
    <User id="2" userName="conflicted" emailAddress="first@example.test" email="second@example.test"/>
  </entity-engine-xml>`)]]), 'fresh-jira');

  const wiki = pkg('wiki-identities', 'confluence', []);
  wiki.dataset = parseConfluence(new Map([['entities.xml', Buffer.from(`<hibernate-generic>
    <object class="ConfluenceUserImpl"><id name="key">linked</id><property name="name">profile</property></object>
    <object class="UserInfo"><id name="id">1</id><property name="username">profile</property><property name="email"> Profile@Example.Test </property></object>
    <object class="ConfluenceUserImpl"><id name="key">conflicting</id><property name="name">older</property><property name="emailAddress">old@example.test</property></object>
    <object class="UserInfo"><id name="id">2</id><property name="username">older</property><property name="email">new@example.test</property></object>
    <object class="ConfluenceUserImpl"><id name="key">ambiguous-1</id><property name="name">same</property></object>
    <object class="ConfluenceUserImpl"><id name="key">ambiguous-2</id><property name="name">same</property></object>
    <object class="UserInfo"><id name="id">3</id><property name="username">same</property><property name="email">same@example.test</property></object>
    <object class="ConfluenceUserImpl"><id name="key">direct</id><property name="name">different</property><property name="email"> DIRECT@example.test </property><property name="emailAddress">direct@example.test</property></object>
  </hibernate-generic>`)]]), 'wiki-identities');

  const options = buildMigrationOptions([earlier, fresh, wiki]);
  const identities = new Map(options.identities.map(identity => [identity.sourceValue, identity]));
  assert.equal(identities.get('unchecked')!.email, 'Unchecked@Example.Test');
  assert.equal(identities.get('unchecked')!.emailEvidence, null);
  assert.equal(identities.get('no-email@example.test')!.emailEvidence, undefined);
  assert.deepEqual(identities.get('checked')!.emailEvidence, { email: 'checked@example.test' });
  assert.equal(identities.get('conflicted')!.emailEvidence, null);
  assert.equal(identities.get('linked')!.email, null);
  assert.deepEqual(identities.get('linked')!.emailEvidence, { email: 'profile@example.test', accountId: 'linked' });
  assert.deepEqual(identities.get('UserInfo:1')!.emailEvidence, identities.get('linked')!.emailEvidence);
  assert.deepEqual(identities.get('direct')!.emailEvidence, { email: 'direct@example.test', accountId: 'direct' });
  for (const id of ['conflicting', 'UserInfo:2', 'UserInfo:3']) assert.equal(identities.get(id)!.emailEvidence, null);
  for (const id of ['ambiguous-1', 'ambiguous-2']) assert.equal(identities.get(id)!.emailEvidence, undefined);
  assert.ok(Object.values(options.defaultConfiguration.users).every(value => value === null));
});

function workflowIssue(id: string, container: string, status: string, label: string): LegacyRecord {
  return issue(id, { containerId: container, metadata: {
    key: `OLD-${id}`, fields: { status: { id: status, name: label }, issuetype: { id: 'bug', name: '버그' } },
  } });
}

test('reviewed migration workflow uses stable statuses for merged Jira containers and leaves unrelated defaults intact', () => {
  const first = pkg('workflow-a', 'jira', [
    record('project', 'a', { title: '업무 A' }),
    workflowIssue('11', 'a', 'ready', '착수 가능'),
    workflowIssue('12', 'a', 'review', '팀 검토'),
  ]);
  const second = pkg('workflow-b', 'jira', [
    record('project', 'b', { title: '업무 B' }),
    workflowIssue('21', 'b', 'ready', '착수 가능'),
    workflowIssue('22', 'b', 'closed', '완료'),
  ]);
  second.dataset.source.instanceKey = first.dataset.source.instanceKey;
  const third = pkg('workflow-c', 'jira', [
    record('project', 'c', { title: '별도 업무' }),
    workflowIssue('31', 'c', 'ready', '착수 가능'),
    workflowIssue('32', 'c', 'closed', '완료'),
  ]);
  const packages = [first, second, third, confluence()];
  const options = buildMigrationOptions(packages);
  const imported = options.jiraWorkflowStatuses!;
  const groupedReady = imported.find(status => status.label === '착수 가능' && status.containerIds.length === 2)!;
  assert.deepEqual(groupedReady.containerIds, options.containers.filter(option => ['a', 'b'].includes(option.sourceProjectId)).map(option => option.id));
  assert.equal(imported.filter(status => status.label === '착수 가능').length, 2);
  const reviewed = imported.find(status => status.label === '팀 검토')!;
  const completed = imported.find(status => status.label === '완료' && status.containerIds.includes(groupedReady.containerIds[1]))!;
  const request = input(packages);
  const otherContainer = options.containers.find(option => option.sourceProjectId === 'c')!;
  request.configuration.projects = request.configuration.projects.map(project => project.containerId === otherContainer.id
    ? { ...project, key: 'OTHER', name: '별도 업무' } : project);
  const additional = { id: 's_new_1', label: ' 신규 접수 ', category: 'backlog' as const };
  const transitions = [{ from: additional.id, to: groupedReady.id }, { from: groupedReady.id, to: reviewed.id },
    { from: reviewed.id, to: completed.id }];
  request.configuration.jiraWorkflows = { NEW: { initialStatusId: additional.id, additionalStatuses: [additional], transitions } };

  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.ok(plan.preview.requiredAcknowledgements.includes('JIRA_WORKFLOW_REVIEW_REQUIRED'));
  assert.ok(plan.preview.requiredAcknowledgements.includes('WORKFLOW_RULES_NOT_REPRODUCED'));
  const mergedId = plan.projects.find(project => project.key === 'NEW')!.id;
  const merged = plan.workflows.find(workflow => workflow.projectId === mergedId)!;
  assert.equal(merged.initialStatusId, additional.id);
  assert.equal(merged.statuses.find(status => status.id === additional.id)?.label, '신규 접수');
  assert.deepEqual(merged.transitions, transitions.map(edge => ({ ...edge, issueTypes: [], requiredFields: [] })));
  assert.deepEqual(plan.preview.jiraWorkflows, [{
    projectKey: 'NEW', initialStatusId: additional.id, statuses: merged.statuses.map(({ id, label, category }) => ({ id, label, category })), transitions,
  }]);
  assert.deepEqual(plan.sourceImport.configuration.jiraWorkflows, request.configuration.jiraWorkflows);
  assert.equal(plan.documents[0].projectId, mergedId);
  const ready = plan.issues.find(row => row.title === '업무 11')!;
  assert.equal(ready.status, groupedReady.id);
  assert.equal(plan.issues.find(row => row.title === '업무 21')?.status, groupedReady.id);
  assert.equal(plan.issues.find(row => row.title === '업무 22')?.status, completed.id);
  assert.deepEqual(allowedNextStatuses({ workflows: plan.workflows }, ready).map(status => status.id), [groupedReady.id, reviewed.id]);
  const otherWorkflow = plan.workflows.find(workflow => workflow.projectId !== mergedId)!;
  assert.equal(otherWorkflow.transitions.length, 2);
});

test('reviewed migration workflows reject foreign, excluded and invalid graph elements and accept an empty graph', () => {
  const source = pkg('workflow-invalid', 'jira', [
    record('project', 'a', { title: '업무 A' }),
    record('project', 'b', { title: '업무 B' }),
    workflowIssue('11', 'a', 'ready', '착수 가능'),
    workflowIssue('12', 'a', 'review', '팀 검토'),
    workflowIssue('21', 'b', 'closed', '완료'),
  ]);
  const packages = [source, confluence()];
  const options = buildMigrationOptions(packages);
  const [ready, review, closed] = options.jiraWorkflowStatuses!;
  const makeInput = () => {
    const request = input(packages);
    const keys = new Map([['a', 'NEW'], ['b', 'OTHER'], ['s', 'DOCS']]);
    request.configuration.projects = options.containers.map(option => ({
      containerId: option.id, name: option.name, key: keys.get(option.sourceProjectId)!,
    }));
    return request;
  };
  const request = makeInput();
  request.configuration.jiraWorkflows = { NEW: { initialStatusId: ready.id, transitions: [] } };
  const emptyPlan = buildMigrationPlan(request);
  assert.equal(emptyPlan.preview.canApply, true, JSON.stringify(emptyPlan.preview.notices));
  assert.deepEqual(emptyPlan.preview.jiraWorkflows?.[0].transitions, []);
  request.configuration.jiraWorkflows.NEW.additionalStatuses = [{ id: 's_new_1', label: ' 팀 검토 ', category: 'review' }];
  const sharedNamePlan = buildMigrationPlan(request);
  assert.equal(sharedNamePlan.preview.canApply, true, JSON.stringify(sharedNamePlan.preview.notices));
  assert.deepEqual(sharedNamePlan.preview.jiraWorkflows?.[0].statuses.filter(status => status.label === '팀 검토')
    .map(status => status.id), [review.id, 's_new_1']);

  function reject(value: NonNullable<MigrationPlanningInput['configuration']['jiraWorkflows']>, code: string, excludedRecords: string[] = []) {
    const request = makeInput();
    request.configuration.jiraWorkflows = value;
    request.configuration.excludedRecords = excludedRecords;
    const plan = buildMigrationPlan(request);
    assert.equal(plan.preview.canApply, false);
    assert.ok(notices(plan).has(code), JSON.stringify(plan.preview.notices));
    assert.equal(plan.preview.jiraWorkflows, undefined);
  }
  reject({ NEW: { initialStatusId: closed.id, transitions: [] } }, 'JIRA_WORKFLOW_INITIAL_STATUS_INVALID');
  reject({ NEW: { initialStatusId: review.id, transitions: [] } }, 'JIRA_WORKFLOW_INITIAL_STATUS_INVALID', [`${source.summary.id}/issue:12`]);
  reject({ NEW: { initialStatusId: ready.id, transitions: [{ from: ready.id, to: closed.id }] } }, 'JIRA_WORKFLOW_TRANSITION_INVALID');
  reject({ NEW: { initialStatusId: ready.id, transitions: [{ from: ready.id, to: ready.id }] } }, 'JIRA_WORKFLOW_TRANSITION_INVALID');
  const edge = { from: ready.id, to: review.id };
  reject({ NEW: { initialStatusId: ready.id, transitions: [edge, edge] } }, 'JIRA_WORKFLOW_TRANSITION_INVALID');
  reject({ NEW: { initialStatusId: ready.id, transitions: [],
    additionalStatuses: [{ id: 's_new_1', label: '   ', category: 'review' }] } }, 'JIRA_WORKFLOW_ADDITIONAL_STATUS_INVALID');
  reject({ DOCS: { initialStatusId: 's_new_1', transitions: [],
    additionalStatuses: [{ id: 's_new_1', label: '접수', category: 'todo' }] } }, 'JIRA_WORKFLOW_PROJECT_INVALID');
  reject({ ABSENT: { initialStatusId: ready.id, transitions: [] } }, 'JIRA_WORKFLOW_PROJECT_INVALID');
});

test('Jira descriptions retain Markdown annotations while comments stay plain and documents retain native nodes', () => {
  const taskSource = jira(), documentSource = confluence();
  const adf = JSON.stringify({ type: 'doc', version: 1, content: [
    { type: 'panel', attrs: { panelType: 'warning' }, content: [
      { type: 'paragraph', content: [{ type: 'text', text: '업무 상태 ' }, adfStatus('진행 중')] },
    ] },
  ] });
  const storage = `<ac:structured-macro ac:name="note"><ac:parameter ac:name="title">운영</ac:parameter><ac:rich-text-body><p>${storageStatus('확인 완료')}</p></ac:rich-text-body></ac:structured-macro>`;
  for (const id of ['issue:1', 'comment:jc']) {
    Object.assign(taskSource.dataset.records.find(row => row.id === id)!, { text: adf, textFormat: 'adf' });
  }
  for (const id of ['page:10', 'revision:old10', 'comment:wc']) {
    Object.assign(documentSource.dataset.records.find(row => row.id === id)!, { text: storage, textFormat: 'confluence-storage' });
  }
  const plan = buildMigrationPlan(input([taskSource, documentSource]));
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  const taskText = '[warning]\n업무 상태 [상태: 진행 중]';
  const importedIssue = plan.issues.find(row => row.title === '업무 1');
  assert.equal(importedIssue?.descriptionFormat, 'markdown');
  assert.ok(importedIssue?.description.startsWith('> **경고**'));
  assert.ok(importedIssue?.description.includes('진행 중'));
  assert.equal(plan.issues.find(row => row.title === '업무 2')?.descriptionFormat, undefined);
  assert.equal(plan.comments.find(row => row.resourceType === 'issue')?.body, taskText);
  assert.equal(plan.comments.find(row => row.resourceType === 'document')?.body, '[note] 운영\n[상태: 확인 완료]');
  for (const document of [...plan.documents, ...plan.revisions]) {
    assert.equal(document.content.content?.[0].type, 'callout');
    assert.equal(document.plainText, '운영\n확인 완료');
  }
});

test('Jira history append verifies owner aliases, preserves stable source IDs, and accepts proven sparse backups', () => {
  const baseline = buildMigrationPlan(input([jira()]));
  const [first, second] = baseline.issues;
  const [project] = baseline.projects;
  const [workflow] = baseline.workflows;
  const [schema] = baseline.issueSchemas;
  const identity = record('identity', 'alice', { title: '기존 작성자' });
  const retained = issue('300', { metadata: { key: 'OLD-1' } });
  const restricted = issue('2', { metadata: { key: 'OLD-2', fields: { security: [{ id: 'private' }] } } });
  const comment = (id: string, owner = '300', extra: Partial<LegacyRecord> = {}) => record('comment', id, {
    containerId: owner, authorId: 'alice', createdAt: created, textFormat: 'plain', text: `원본 댓글 ${id}`,
    references: [{ kind: 'issue', sourceId: owner, relation: 'commentOn' }], ...extra,
  });
  const worklog = (id: string, owner = '300', extra: Partial<LegacyRecord> = {}) => record('history', `worklog:${id}`, {
    containerId: owner, authorId: 'alice', createdAt: created, textFormat: 'plain', text: '원본 작업 메모',
    metadata: { kind: 'worklog', started: created, timeSpentSeconds: 61 },
    references: [{ kind: 'issue', sourceId: owner, relation: 'worklogOf' }], ...extra,
  });
  const source = (id: string, rows: LegacyRecord[], diagnostics: LegacyDataset['diagnostics'] = []) => {
    const result = pkg(id, 'jira', rows, diagnostics);
    result.dataset.source.instanceKey = 'same-jira';
    return result;
  };
  const plan = (packages: MigrationPackage[], enabled = true) => {
    const request = input(packages);
    request.configuration.datePolicy = 'import-time';
    for (const option of buildMigrationOptions(packages).identities) {
      request.configuration.users[option.id] = option.sourceValue === 'alice' ? actor.id : null;
    }
    request.configuration.appendTo = { projectId: project.id, statuses: {}, issueTypes: {}, fields: {}, ...(enabled ? { refreshHistory: true } : {}) };
    request.append = { project, workflow, schema, nextIssueNumber: 3, token: 'jira-history',
      knownIssues: [{ alias: '1', issueId: first.id, projectId: project.id }, { alias: 'OLD-1', issueId: first.id, projectId: project.id },
        { alias: '2', issueId: second.id, projectId: project.id }, { alias: 'OLD-2', issueId: second.id, projectId: project.id },
        { alias: 'gone', issueId: 'purged-issue-id', projectId: null }],
      historyIssues: [first, second],
      knownHistory: [{ kind: 'comment', sourceId: '201', issueId: 'different-old-issue' },
        { kind: 'worklog', sourceId: 'worklog:501', issueId: first.id }],
    };
    return buildMigrationPlan(request);
  };

  const newComment = comment('200', '300', {
    references: [{ kind: 'issue', sourceId: 'OLD-1', relation: 'commentOn' }], textFormat: 'adf',
    text: JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [adfStatus('진행 중')] }] }),
  });
  const newWorklog = worklog('500');
  const rows = [identity, retained, restricted, newComment, newWorklog, comment('201'), worklog('501'),
    comment('csv:300:comment:2'), worklog('300:0'), comment('202', '300', { metadata: { internal: true } }),
    comment('203', '300', { metadata: { visibility: [], properties: [{ key: 'sd.public.comment', value: { internal: true } }] } }),
    comment('204', '300', { createdAt: null }), comment('205', '300', { authorId: null }), comment('206', '2'),
    comment('207', 'gone'), comment('208', '300', { references: [{ kind: 'issue', sourceId: '2', relation: 'commentOn' }] }),
    comment('209', '300', { metadata: { properties: { 'sd.public.comment': { internal: true } } } }),
    comment('210', '300', { metadata: { properties: [{ key: 'sd.public.comment', value: '{"internal":true}' }] } }),
    worklog('502', '300', { metadata: { kind: 'worklog', started: created, timeSpentSeconds: 58, roleLevel: 'private' } }),
  ];
  const initial = source('jira-first-history', rows);
  const overlap = source('jira-overlap-history', [identity, retained, newComment]);
  const added = plan([initial, overlap]);
  assert.equal(added.preview.canApply, true, JSON.stringify(added.preview.notices));
  assert.deepEqual(added.jiraHistoryOwners, [first.id]);
  assert.equal(added.preview.counts.issues, 0);
  assert.equal(added.preview.counts.newJiraComments, 1);
  assert.equal(added.preview.counts.newJiraWorklogs, 1);
  assert.deepEqual(added.comments.map(({ resourceId, authorId, createdAt, body }) => ({ resourceId, authorId, createdAt, body })),
    [{ resourceId: first.id, authorId: actor.id, createdAt: created, body: '[상태: 진행 중]' }]);
  assert.equal(added.worklogs[0].issueId, first.id);
  assert.equal(added.worklogs[0].issueKey, first.key);
  assert.equal(added.worklogs[0].durationSeconds, 61);
  assert.equal(added.worklogs[0].note, '원본 작업 메모');
  assert.ok(added.preview.requiredAcknowledgements.includes('JIRA_HISTORY_RAW_ONLY'));
  const supplemental = added.sourceRecords.filter(row => row.jiraHistoryAppend);
  assert.deepEqual(supplemental.map(row => row.record.sourceId).sort(), ['200', 'worklog:500']);
  assert.ok(supplemental.every(row => row.ownerType === 'issue' && row.ownerId === first.id && row.targetProjectId === project.id));
  assert.equal(supplemental.find(row => row.record.kind === 'comment')?.targetId, added.comments[0].id);
  assert.equal(supplemental.find(row => row.record.kind === 'history')?.id, added.worklogs[0].sourceRecordId);
  assert.equal(added.sourceRecords.filter(row => row.record.sourceId === '200' && row.targetType === null).length, 1);
  assert.equal(plan([initial], false).preview.canApply, false);

  const noPrimary = [{ id: 'no-primary', severity: 'error' as const, code: 'NO_PRIMARY_CONTENT', message: '업무 원문 없음', recordId: null, path: null }];
  const sparse = plan([source('jira-sparse', [identity, comment('211', 'OLD-1')], noPrimary)]);
  assert.equal(sparse.preview.canApply, true, JSON.stringify(sparse.preview.notices));
  assert.equal(sparse.comments[0].resourceId, first.id);
  const crossPackageAlias = plan([initial, source('jira-sparse-temporary-alias', [identity, comment('213', '300')], noPrimary)]);
  assert.equal(crossPackageAlias.preview.counts.newJiraComments, 1);
  assert.equal(crossPackageAlias.sourceRecords.find(row => row.record.sourceId === '213')?.targetId, null);
  const unverified = plan([source('jira-sparse-unknown', [identity, comment('212', 'unknown-owner')], noPrimary)]);
  assert.equal(unverified.preview.canApply, false);
  assert.ok(notices(unverified).has('SOURCE_NO_PRIMARY_CONTENT'));
});

test('Jira supplemental attachments use stable IDs, verified bytes and the original live issue owner', () => {
  const baseline = buildMigrationPlan(input([jira()]));
  const [first, second] = baseline.issues;
  const [project] = baseline.projects;
  const [workflow] = baseline.workflows;
  const [schema] = baseline.issueSchemas;
  const identity = record('identity', 'alice', { title: '원래 작성자' });
  const retainedIssue = issue('300', { metadata: { key: 'OLD-1' } });
  const restrictedIssue = issue('2', { metadata: { key: 'OLD-2', fields: { security: [{ id: 'private' }] } } });
  const firstHash = createHash('sha256').update('x').digest('hex');
  const secondHash = createHash('sha256').update('y').digest('hex');
  const file = (id: string, owner = '300', metadata: Record<string, LegacyValue> = {}) => record('attachment', id, {
    containerId: owner, authorId: 'alice', createdAt: created, title: '같은 파일명.txt',
    metadata: { bytesPresent: true, actualSize: 1, size: '1', sha256: firstHash, path: `attachments/${owner}/${id}`, ...metadata },
    references: [{ kind: 'issue', sourceId: owner, relation: 'attachedTo' }],
  });
  const source = (id: string, rows: LegacyRecord[], diagnostics: LegacyDataset['diagnostics'] = []) => {
    const result = pkg(id, 'jira', rows, diagnostics);
    result.dataset.source.instanceKey = 'same-jira';
    return result;
  };
  const plan = (packages: MigrationPackage[], { enabled = true, verified = true } = {}) => {
    const request = input(packages);
    const options = buildMigrationOptions(packages);
    for (const user of options.identities) request.configuration.users[user.id] = actor.id;
    request.configuration.appendTo = {
      projectId: project.id, fields: {}, ...(enabled ? { refreshAttachments: true } : {}),
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, workflow.statuses[0].id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, schema.issueTypes[0].id])),
    };
    request.append = { project, workflow, schema, nextIssueNumber: 3, token: 'jira-attachments',
      knownIssues: [{ alias: '1', issueId: first.id, projectId: project.id }, { alias: 'OLD-1', issueId: first.id, projectId: project.id },
        { alias: '2', issueId: second.id, projectId: project.id }, { alias: 'OLD-2', issueId: second.id, projectId: project.id },
        { alias: 'gone', issueId: 'purged-issue-id', projectId: null }],
      attachmentIssues: [first, second], knownAttachments: [{ sourceId: '501', issueId: 'purged-issue-id' }],
    };
    if (verified) request.fileInfo = Object.fromEntries(packages.map(sourcePackage => [sourcePackage.summary.id,
      Object.fromEntries(sourcePackage.dataset.records.filter(row => row.kind === 'attachment' && row.sourceId !== '503').map(row => [
        row.metadata.path as string, { size: 1, sha256: row.sourceId === '502' ? secondHash : row.metadata.sha256 as string, mimeType: 'application/octet-stream' },
      ])),
    ]));
    return buildMigrationPlan(request);
  };
  const originalFile = file('500');
  const old = source('jira-original-files', [identity, retainedIssue, restrictedIssue, originalFile,
    file('501'), file('502'), file('503'), file('504', '2'), file('505', 'gone'), file('506', '300', { syntheticId: true }),
    file('507', '300', { size: '2' }), file('508', '300', { groupLevel: 'private' }), file('509'),
    file('512', '300', { sha256: secondHash }), file('514')]);
  const newer = source('jira-other-file-rows', [identity, retainedIssue, issue('3'), originalFile,
    file('513', '3'), file('501', '3'), file('512'), file('514', '3')]);
  const added = plan([old, newer]);
  assert.equal(added.preview.canApply, true, JSON.stringify(added.preview.notices));
  assert.equal(added.preview.counts.issues, 1);
  assert.equal(added.preview.counts.newJiraAttachments, 2);
  assert.deepEqual(added.jiraAttachmentOwners, [first.id]);
  assert.equal(added.fileCopies.length, 3);
  assert.ok(added.preview.requiredAcknowledgements.includes('JIRA_ATTACHMENT_RAW_ONLY'));
  assert.equal(new Set(added.attachments.map(attachment => attachment.id)).size, 3);
  assert.ok(added.attachmentVersions.every(version => version.attachmentId === version.id && version.sourceRevision === undefined));
  const supplemental = added.sourceRecords.filter(row => row.jiraAttachmentAppend);
  assert.deepEqual(supplemental.map(row => row.record.sourceId).sort(), ['500', '509']);
  assert.ok(supplemental.every(row => row.ownerType === 'issue' && row.ownerId === first.id && row.targetProjectId === project.id &&
    row.targetType === 'attachment' && added.attachments.some(attachment => attachment.id === row.targetId && attachment.resourceId === first.id)));
  assert.equal(added.sourceRecords.filter(row => row.record.sourceId === '500' && row.targetType === null).length, 1);
  assert.equal(added.sourceRecords.find(row => row.record.sourceId === '513')?.ownerId, added.issues[0].id);
  assert.equal(plan([old], { enabled: false }).preview.canApply, false);
  assert.equal(plan([source('jira-file-no-manifest', [identity, retainedIssue, originalFile])], { verified: false }).preview.canApply, false);

  const noPrimary = [{ id: 'no-primary', severity: 'error' as const, code: 'NO_PRIMARY_CONTENT', message: '업무 원문 없음', recordId: null, path: null }];
  const sparse = plan([source('jira-sparse-file', [identity, file('510', 'OLD-1')], noPrimary)]);
  assert.equal(sparse.preview.canApply, true, JSON.stringify(sparse.preview.notices));
  assert.equal(sparse.attachments[0].resourceId, first.id);
  const unverified = plan([source('jira-sparse-unverified-owner', [identity, file('511', '300')], noPrimary)]);
  assert.equal(unverified.preview.canApply, false);
  assert.ok(notices(unverified).has('SOURCE_NO_PRIMARY_CONTENT'));
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
  const description = (label: string) => ({ type: 'doc', version: 1, content: [
    { type: 'panel', attrs: { panelType: 'info' }, content: [{ type: 'paragraph', content: [adfStatus(label)] }] },
  ] });
  const open = { id: '1', name: 'Open' }, done = { id: '2', name: 'Done' };
  const original = snapshot('original', 'json', JSON.stringify({ issues: [
    issueJson('1', 'OLD-1', created, '남길 제목', { status: open, description: description('비울 설명'), labels: ['alpha', 'beta'],
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
  const refresh = (source: MigrationPackage, current = canonical, previousArchive = archive) => {
    const planned = input([source]);
    planned.configuration.appendTo = {
      projectId: project.id, refreshExisting: true,
      statuses: Object.fromEntries(buildMigrationOptions([source]).statuses.map(option => [option.id, workflow.statuses[1].id])),
      issueTypes: {}, fields: {},
    };
    planned.append = {
      project, workflow, schema, nextIssueNumber: 3, token: 'test-planner',
      knownIssues: [{ alias: '1', issueId: canonical.id, projectId: project.id }, { alias: 'OLD-1', issueId: canonical.id, projectId: project.id }],
      refreshIssues: [{ issue: current, previous: { archive: previousArchive, stagingId: original.summary.id, configuration: request.configuration } }],
    };
    return buildMigrationPlan(planned);
  };
  const csv = 'Issue id,Issue key,Project id,Project key,Summary,Updated,Description,Assignee,Labels,Labels,Priority,Status\n' +
    '1,OLD-1,42,OLD,남길 제목,2020-01-02T00:00:00Z,,,beta,alpha,Unrecognized,Open';
  const clear = refresh(snapshot('csv', 'csv', csv), { ...canonical, status: workflow.statuses[1].id });
  assert.equal(clear.preview.canApply, true, JSON.stringify(clear.preview.notices));
  assert.deepEqual(clear.issueUpdates?.[0].changes, { description: '', descriptionFormat: 'plain', assigneeId: null });
  assert.deepEqual(clear.preview.issueRefresh?.[0].fields.map(field => field.field), ['description', 'assigneeId']);
  assert.equal(clear.sourceRecords.find(row => row.targetId === canonical.id)?.jiraIssueFieldHashes?.status, archive.jiraIssueFieldHashes?.status);
  assert.ok(notices(clear).has('JIRA_REFRESH_FIELD_UNAVAILABLE'));
  const legacy = { ...archive };
  delete legacy.jiraIssueFieldHashes;
  const revision = snapshot('revised-description', 'json', JSON.stringify({ issues: [
    issueJson('1', 'OLD-1', '2020-01-02T00:00:00Z', '남길 제목', { status: open, description: description('변경한 설명') }),
  ] }));
  const annotated = refresh(revision, { ...canonical, description: '[info]\n[상태: 비울 설명]', descriptionFormat: undefined }, legacy);
  assert.equal(annotated.preview.issueRefresh?.[0].fields.find(field => field.field === 'description')?.decision, 'apply');
  assert.match(annotated.issueUpdates?.[0].changes.description ?? '', /^> \*\*정보\*\*[\s\S]*변경한 설명/u);
  assert.equal(annotated.issueUpdates?.[0].changes.descriptionFormat, 'markdown');
  const formatOnlyEdit = refresh(revision, { ...canonical, descriptionFormat: undefined });
  assert.equal(formatOnlyEdit.preview.issueRefresh?.[0].fields.find(field => field.field === 'description')?.decision, 'conflict');
  assert.equal(formatOnlyEdit.issueUpdates?.[0]?.changes.description, undefined);
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

test('Jira custom refresh uses proven initial mappings and the resulting field visibility', () => {
  const textField = (id: string, title: string) => record('field', id, { title, metadata: { fieldType: 'text' } });
  const numberField = (id: string) => record('field', id, { title: '점수', metadata: { fieldType: 'number' } });
  const flag = record('field', 'customfield_101', { title: '계속 진행', metadata: { fieldType: 'boolean' } });
  const date = record('field', 'customfield_102', { title: '확인일', metadata: { fieldType: 'date' } });
  const conditional = textField('customfield_103', '진행 설명');
  const local = textField('customfield_104', '검토 메모');
  const omitted = textField('customfield_105', '빠진 항목');
  const wrong = textField('customfield_106', '다른 원본');
  const sourceIssue = (at: string, fields: Record<string, LegacyValue>, title = 'Jira 업무') => issue('1', {
    title, updatedAt: at, metadata: { key: 'OLD-1', fields: { status: 'open', issuetype: 'bug', ...fields } },
  });
  const baselinePackage = pkg('jira', 'jira', [numberField('100'), flag, date, conditional, local, omitted,
    sourceIssue(created, { '100': 0, customfield_101: false, customfield_102: '2020-01-31', customfield_103: '첫 설명',
      customfield_104: '첫 메모', customfield_105: '초기 원문' })]);
  const original = input([baselinePackage]);
  const baseline = buildMigrationPlan(original);
  assert.equal(baseline.preview.canApply, true, JSON.stringify(baseline.preview.notices));
  const canonical = baseline.issues[0], project = baseline.projects[0], workflow = baseline.workflows[0];
  const schema = baseline.issueSchemas[0];
  const [points, enable, verifyAt, detail, memo, missing] = ['점수', '계속 진행', '확인일', '진행 설명', '검토 메모', '빠진 항목']
    .map(name => schema.fields.find(field => field.name === name)!.id);
  schema.fields.find(field => field.id === detail)!.visibleWhen = { statusIds: [], fieldMatch: { fieldId: enable, value: true } };
  const recorded = baseline.sourceRecords.find(row => row.targetId === canonical.id)!;
  assert.equal(recorded.jiraCustomFieldHashes?.[points].sourceFieldId, '100');
  const legacy = structuredClone(recorded);
  delete legacy.jiraCustomFieldHashes;
  const old = { archive: legacy, stagingId: baselinePackage.summary.id, configuration: original.configuration };
  const edited = { ...canonical, customFields: { ...canonical.customFields, [memo]: '팀 편집' } };
  const refresh = (name: string, incoming: LegacyRecord[], current = edited, previousCustom = old) => {
    const delta = pkg(name, 'jira', incoming);
    delta.dataset.source.instanceKey = baselinePackage.dataset.source.instanceKey;
    const preview = input([delta]);
    const maps: Record<string, string> = { customfield_100: points, customfield_101: enable, customfield_102: verifyAt,
      customfield_103: detail, customfield_104: memo, customfield_105: missing, customfield_106: missing };
    preview.configuration.appendTo = { projectId: project.id, refreshCustomFields: true, statuses: {}, issueTypes: {},
      fields: Object.fromEntries(buildMigrationOptions([delta]).fields.map(option => [option.id, maps[option.sourceValue]])) };
    preview.append = { project, workflow, schema, nextIssueNumber: 2, token: 'custom-preview',
      knownIssues: [{ alias: '1', issueId: canonical.id, projectId: project.id }],
      refreshIssues: [{ issue: current, previous: old, previousCustom }] };
    return { plan: buildMigrationPlan(preview), configuration: preview.configuration, stagingId: delta.summary.id };
  };
  const newer = '2020-02-01T00:00:00Z';
  const first = refresh('delta', [numberField('customfield_100'), flag, date, conditional, local, omitted, wrong,
    sourceIssue(newer, { customfield_100: null, customfield_101: true, customfield_102: '2020-02-31', customfield_103: '새 설명',
      customfield_104: 'Jira 새 메모', customfield_106: '반영하면 안 되는 값' }, 'Jira 변경 제목')]);
  assert.equal(first.plan.preview.canApply, true, JSON.stringify(first.plan.preview.notices));
  assert.deepEqual(first.plan.issueUpdates?.[0].changes, { customFields: { [points]: null, [enable]: true, [detail]: '새 설명' } });
  assert.equal(first.plan.preview.counts.updatedCustomFields, 3);
  assert.equal(first.plan.preview.counts.conflictingCustomFields, 1);
  assert.equal(first.plan.preview.counts.updatedFields, 0);
  assert.deepEqual(first.plan.preview.issueRefresh?.[0].customFields?.find(row => row.fieldId === memo),
    { fieldId: memo, label: '검토 메모', current: '팀 편집', incoming: 'Jira 새 메모', decision: 'conflict' });
  assert.ok(notices(first.plan).has('JIRA_REFRESH_CUSTOM_FIELD_ORIGIN_UNCONFIRMED'));
  assert.ok(notices(first.plan).has('JIRA_REFRESH_CUSTOM_FIELD_UNAVAILABLE'));
  const checkpoint = first.plan.sourceRecords.find(row => row.targetId === canonical.id)!;
  assert.equal(checkpoint.jiraIssueFieldHashes, undefined);
  assert.deepEqual(checkpoint.jiraCustomFieldHashes?.[missing], recorded.jiraCustomFieldHashes?.[missing]);
  assert.deepEqual(checkpoint.jiraCustomFieldHashes?.[memo], recorded.jiraCustomFieldHashes?.[memo]);
  const retryAt = '2020-02-02T00:00:00Z';
  const retry = refresh('retry', [local, omitted, sourceIssue(retryAt, { customfield_104: 'Jira 새 메모', customfield_105: '돌아온 항목' })],
    { ...canonical, customFields: { ...canonical.customFields, ...first.plan.issueUpdates?.[0].changes.customFields } },
    { archive: checkpoint, stagingId: first.stagingId, configuration: first.configuration });
  assert.deepEqual(retry.plan.issueUpdates?.[0].changes, { customFields: { [memo]: 'Jira 새 메모', [missing]: '돌아온 항목' } });
  const hidden = refresh('hidden', [conditional, sourceIssue(newer, { customfield_103: '숨겨진 변경분' })]);
  assert.equal(hidden.plan.preview.canApply, false);
  assert.deepEqual(hidden.plan.issueUpdates, []);
  assert.ok(notices(hidden.plan).has('JIRA_REFRESH_CUSTOM_FIELD_UNAVAILABLE'));
});

test('Jira CSV custom change review can populate and then clear an explicitly blank cell', () => {
  const id = 'csv:Custom field (점수)';
  const snapshot = (name: string, rows: string[]): MigrationPackage => {
    const filename = `${name}.csv`;
    const data = ['Issue id,Issue key,Project id,Project key,Summary,Created,Updated,Status,Issue Type,Custom field (점수)', ...rows].join('\r\n');
    const source = pkg(name, 'jira', []);
    source.dataset = parseJira(new Map([[filename, Buffer.from(data)]]), 'csv-custom');
    source.summary = { ...source.summary, filename, source: source.dataset.source };
    return source;
  };
  const one = (at: string, points: string) => `1,OLD-1,42,OLD,업무,${created},${at},Open,Task,${points}`;
  const initial = snapshot('initial-blank', [one(created, ''), `2,OLD-2,42,OLD,참고 업무,${created},${created},Open,Task,1`]);
  const configured = input([initial]);
  const option = buildMigrationOptions([initial]).fields.find(option => option.sourceValue === id)!;
  configured.configuration.fields[option.id] = 'number';
  const imported = buildMigrationPlan(configured);
  assert.equal(imported.preview.canApply, true, JSON.stringify(imported.preview.notices));
  const canonical = imported.issues[0], project = imported.projects[0], workflow = imported.workflows[0], schema = imported.issueSchemas[0];
  const field = schema.fields.find(field => field.name === option.label)!;
  assert.equal(Object.hasOwn(canonical.customFields!, field.id), false);
  const archive = imported.sourceRecords.find(row => row.targetId === canonical.id)!;
  assert.equal(archive.jiraCustomFieldHashes?.[field.id].sourceFieldId, id);
  const initialBaseline = { archive, stagingId: initial.summary.id, configuration: configured.configuration };
  const refresh = (source: MigrationPackage, current = canonical, previousCustom = initialBaseline) => {
    const next = input([source]);
    const option = buildMigrationOptions([source]).fields.find(option => option.sourceValue === id)!;
    next.configuration.appendTo = { projectId: project.id, refreshCustomFields: true,
      statuses: {}, issueTypes: {}, fields: { [option.id]: field.id } };
    next.append = { project, workflow, schema, nextIssueNumber: 3, token: 'csv-custom-preview',
      knownIssues: [{ alias: '1', issueId: canonical.id, projectId: project.id }],
      refreshIssues: [{ issue: current, previous: initialBaseline, previousCustom }] };
    return buildMigrationPlan(next);
  };
  const filledSource = snapshot('filled', [one('2020-02-01T00:00:00Z', '0')]);
  const filled = refresh(filledSource);
  assert.deepEqual(filled.issueUpdates?.[0].changes.customFields, { [field.id]: 0 });
  const checkpoint = filled.sourceRecords.find(row => row.targetId === canonical.id)!;
  const cleared = refresh(snapshot('cleared', [one('2020-02-02T00:00:00Z', '')]), { ...canonical, customFields: { [field.id]: 0 } },
    { archive: checkpoint, stagingId: filledSource.summary.id, configuration: filled.preview.configuration });
  assert.deepEqual(cleared.issueUpdates?.[0].changes.customFields, { [field.id]: null });
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
  delete olderArchive.confluencePageBodySourceHash;
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
  const callout = `<ac:structured-macro ac:name="note"><ac:rich-text-body><p>상태는 ${storageStatus('진행 중')}</p></ac:rich-text-body></ac:structured-macro>`;
  const rich = refresh([next({ text: callout })]);
  assert.equal(rich.preview.canApply, true, JSON.stringify(rich.preview.notices));
  const richCallout = rich.documentUpdates?.[0].changes.content?.content?.[0];
  assert.deepEqual({ ...richCallout?.attrs }, { variant: 'note', title: '' });
  assert.deepEqual({ ...richCallout?.content?.[0].content?.[1].attrs }, { label: '진행 중', tone: 'amber' });
  const previousAnnotations = { ...olderArchive, record: { ...olderArchive.record, text: callout } };
  const flat = { ...canonical, plainText: '[note]\n상태는 [상태: 진행 중]', content: { type: 'doc', content: [
    { type: 'blockquote', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '[note]' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '상태는 [상태: 진행 중]' }] },
    ] },
  ] } };
  const native = { ...canonical, plainText: '상태는 진행 중', content: rich.documentUpdates![0].changes.content! };
  const updatedAnnotation = next({ text: callout.replace('진행 중', '완료') });
  for (const untouched of [flat, native]) {
    const update = refresh([updatedAnnotation], untouched, previousAnnotations);
    assert.equal(update.preview.documentRefresh?.[0].fields[0].decision, 'apply');
    assert.equal(update.documentUpdates?.[0].changes.content?.content?.[0].content?.[0].content?.[1].attrs?.label, '완료');
  }
  const edited = { ...flat, plainText: '팀 편집', content: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '팀 편집' }] },
  ] } };
  const conflict = refresh([updatedAnnotation], edited, previousAnnotations);
  assert.equal(conflict.preview.documentRefresh?.[0].fields[0].decision, 'conflict');
  assert.deepEqual(conflict.documentUpdates, []);
  const anchored = '<p><ac:link ac:anchor="release"><ac:link-body>절 보기</ac:link-body></ac:link></p>' +
    '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">release</ac:parameter></ac:structured-macro><h2>Release notes</h2>';
  const previousAnchors = { ...olderArchive, record: { ...olderArchive.record, text: anchored } };
  const flattened = convertLegacyContent(previousAnchors.record, { resolveReference: () => null });
  const oldDocument = { ...canonical, content: flattened.content, plainText: flattened.plainText };
  const editedSource = next({ text: anchored.replace('Release notes', 'New release notes') });
  const upgraded = refresh([editedSource], oldDocument, previousAnchors);
  assert.equal(upgraded.preview.documentRefresh?.[0].fields[0].decision, 'apply');
  const upgradedContent = upgraded.documentUpdates?.[0].changes.content?.content;
  const upgradedId = upgradedContent?.[1].attrs?.sectionId as string;
  assert.equal(upgradedContent?.[0].content?.[0].marks?.[0].attrs?.href, documentSectionHash(canonical.id, upgradedId));
  const localAnchorConflict = refresh([editedSource], edited, previousAnchors);
  assert.equal(localAnchorConflict.preview.documentRefresh?.[0].fields[0].decision, 'conflict');
  const customBody = callout.replace('>Yellow<', '>#123456<');
  const custom = refresh([next({ title: '원본의 새 제목', text: customBody })]);
  assert.deepEqual(custom.documentUpdates?.[0].changes, { title: '원본의 새 제목' });
  assert.ok(notices(custom).has('STATUS_COLOR_UNSUPPORTED'));
  assert.ok(custom.preview.requiredAcknowledgements.includes('CONFLUENCE_REFRESH_BODY_UNAVAILABLE'));
  assert.equal(custom.sourceRecords.find(row => row.record.text === customBody)?.record.text, customBody);
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

test('Confluence section references use source page scope and preserve verified URL fragments', () => {
  const pageLink = (fragment: string, label: string, targetId: string) =>
    `<p><ac:link ac:anchor="${fragment}"><ri:page ri:content-id="${targetId}"/><ac:link-body>${label}</ac:link-body></ac:link></p>`;
  const source = pkg('section-wiki', 'confluence', [
    record('project', 's', { title: 'Synthetic wiki', metadata: { spaceKey: 'TEAM' } }),
    page('100', { authorId: null, text: [
      pageLink('ReleaseNotes', 'Structured', '200'),
      '<p><a href="https://wiki.example.test/wiki/display/TEAM/Target+page#Targetpage-ReleaseNotes">Verified URL</a></p>',
      pageLink('Hidden', 'Excluded', '300'),
    ].join('') }),
    page('200', { title: 'Target page', authorId: null, text: '<h2>Release Notes</h2>' }),
    page('300', { authorId: null, text: '<h2>Hidden</h2>' }),
  ]);
  const request = input([source]);
  request.configuration.sourceBaseUrls = { 'section-wiki': 'https://wiki.example.test/wiki' };
  request.configuration.excludedRecords = ['section-wiki/page:300'];
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  const from = plan.documents.find(document => document.title === '문서 100')!;
  const target = plan.documents.find(document => document.title === 'Target page')!;
  const section = target.content.content?.[0].attrs?.sectionId as string;
  assert.equal(typeof section, 'string');
  for (const node of from.content.content!.slice(0, 2)) {
    assert.equal(node.content?.[0].marks?.[0].attrs?.href, documentSectionHash(target.id, section));
  }
  assert.ok(from.plainText.includes('Excluded (300#Hidden)'));
  assert.ok(notices(plan).has('SECTION_LINK_UNRESOLVED'));
});

const confluenceBodyHref = (href: string, label: string) =>
  `<p><a href="${href.replaceAll('&', '&amp;')}">${label}</a></p>`;

test('Confluence page hrefs preserve verified mount, title encoding and page or section identity', () => {
  const origin = 'https://wiki.example.test';
  const mount = '/tools/wiki';
  const title = '배포 + 기록';
  const display = `display/TEAM/${encodeURIComponent(title).replaceAll('%20', '+')}`;
  const numeric = 'pages/viewpage.action?pageId=200';
  const modern = 'spaces/TEAM/pages/200/Release+notes';
  const tiny = 'x/y';
  const supported = [
    [`${origin}${mount}/${display}`, '절대 제목 링크'],
    [`${mount}/${display}`, '루트 기준 제목 링크'],
    [`./${display}`, '서비스 기준 제목 링크'],
    [`${origin}${mount}/${numeric}`, '절대 페이지 ID 링크'],
    [`${mount}/${numeric}`, '루트 기준 페이지 ID 링크'],
    [numeric, '서비스 기준 페이지 ID 링크'],
    ['viewpage.action?pageId=200', '페이지 화면의 상대 주소'],
    ['?pageId=200', '페이지 ID만 지정한 상대 주소'],
    [`${origin}${mount}/${modern}`, '절대 페이지 경로'],
    [`${mount}/${modern}`, '루트 기준 페이지 경로'],
    [`./${modern}`, '서비스 기준 페이지 경로'],
    [`${origin}${mount}/${tiny}`, '절대 짧은 주소'],
    [`${mount}/${tiny}`, '루트 기준 짧은 주소'],
    [`./${tiny}`, '서비스 기준 짧은 주소'],
  ];
  const avoided = [
    [`/${display}`, '서비스 밖 경로'],
    [`${origin}${mount}-other/${display}`, '혼동 가능한 서비스 경로'],
    [`${origin}${mount}/other/${display}`, '마운트 안의 다른 앱 경로'],
    [`${origin}${mount}/../wiki/${display}`, '정규화 때 같은 서비스가 되는 경로'],
    [`${origin}${mount}/${numeric}&pageId=200`, '중복 페이지 ID'],
    [`${origin}${mount}/${numeric}&focusedCommentId=9`, '특정 댓글 주소'],
    [`${origin}${mount}/${display}#comment-9`, '댓글 절 주소'],
    [`https://reviewer:synthetic-secret@wiki.example.test${mount}/${display}`, '자격 정보 포함 주소'],
    [`//wiki.example.test${mount}/${display}`, '프로토콜 생략 주소'],
  ];
  const externalLinks = [
    ['https://outside.example.test/pages/123', '일반 외부 링크'],
    [`https://outside.example.test/${tiny}`, '다른 원본의 짧은 주소'],
    [`${origin}/other/${tiny}`, '다른 설치의 짧은 주소'],
    [`${origin}${mount}/x/yA`, '덧붙인 식별자의 주소'],
  ];
  const source = pkg('wiki-hrefs', 'confluence', [
    record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } }),
    page('100', { title: '링크를 포함한 원본', authorId: null, text: [
      ...supported.map(([href, label]) => confluenceBodyHref(href, label)),
      confluenceBodyHref(`${mount}/${display}#ReleaseNotes`, '같은 문서의 절'),
      confluenceBodyHref(`${mount}/${tiny}#ReleaseNotes`, '짧은 주소로 연결한 절'),
      ...avoided.map(([href, label]) => confluenceBodyHref(href, label)),
      ...externalLinks.map(([href, label]) => confluenceBodyHref(href, label)),
    ].join('') }),
    page('200', { title, authorId: null, text: '<h2>Release Notes</h2>' }),
    page('201', { title: '배포   기록', authorId: null }),
  ]);
  const request = input([source]);
  request.configuration.sourceBaseUrls = { [source.summary.id]: `${origin}${mount}` };
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  const original = plan.documents.find(document => document.title === '링크를 포함한 원본')!;
  const target = plan.documents.find(document => document.title === title)!;
  assert.deepEqual(contentReferences(original.content).map(({ id, label }) => [id, label]),
    supported.map(([, label]) => [target.id, label]));
  const sectionId = target.content.content?.[0].attrs?.sectionId as string;
  for (const label of ['같은 문서의 절', '짧은 주소로 연결한 절']) {
    const linkedSection = original.content.content?.find(node => node.content?.[0].text === label);
    assert.equal(linkedSection?.content?.[0].marks?.[0].attrs?.href, documentSectionHash(target.id, sectionId));
  }
  for (const [href, label] of externalLinks) {
    const external = original.content.content?.find(node => node.content?.[0].text === label);
    assert.equal(external?.content?.[0].marks?.[0].attrs?.href, href);
  }
  for (const [, label] of avoided) {
    const paragraph = original.content.content?.find(node => node.content?.some(child => child.text?.includes(label)));
    assert.ok(paragraph, label);
    assert.ok(!paragraph.content?.some(child => child.marks?.some(mark => mark.type === 'link')), label);
  }
  assert.ok(plan.preview.notices.some(notice => notice.recordId === `${source.summary.id}/page:100` && notice.code === 'UNRESOLVED_REFERENCE'));
  const unconfigured = buildMigrationPlan(input([source]));
  const unresolvedBody = unconfigured.documents.find(document => document.title === original.title)!;
  assert.deepEqual(contentReferences(unresolvedBody.content), []);
  assert.ok(notices(unconfigured).has('UNRESOLVED_REFERENCE'));
});

test('absolute Confluence body hrefs cross configured sources only through an unambiguous source locator', () => {
  const home = 'https://wiki-home.example.test/wiki';
  const peer = 'https://wiki-peer.example.test/wiki';
  const source = pkg('wiki-home', 'confluence', [
    record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } }),
    page('100', { authorId: null, text: [
      confluenceBodyHref(`${peer}/display/QA/Peer+target`, '확인한 상대 서버의 문서 제목'),
      confluenceBodyHref(`${peer}/pages/viewpage.action?pageId=200`, '확인한 상대 서버의 문서 ID'),
      confluenceBodyHref(`${peer}/x/y`, '확인한 상대 서버의 짧은 주소'),
      confluenceBodyHref('display/QA/Peer+target', '현재 서버에 없는 상대 경로'),
      confluenceBodyHref('/wiki/pages/viewpage.action?pageId=200', '현재 서버에 없는 상대 ID'),
      confluenceBodyHref(`${peer}/display/QA/Shared+title`, '원본 제목이 중복된 문서'),
      confluenceBodyHref(`${peer}/display/QA/Excluded`, '제외한 원본 문서'),
      confluenceBodyHref(`${peer}/display/QA/Restricted`, '제한된 원본 문서'),
      confluenceBodyHref(`${peer}/x/z`, '제한된 원본 문서의 짧은 주소'),
    ].join('') }),
  ]);
  const peerSource = pkg('wiki-peer', 'confluence', [
    record('project', 'qa', { title: '상대 서버 공간', metadata: { spaceKey: 'QA' } }),
    page('200', { title: 'Peer target', containerId: 'qa', authorId: null }),
    page('201', { title: 'Shared title', containerId: 'qa', authorId: null }),
    page('202', { title: 'Shared title', containerId: 'qa', authorId: null }),
    page('203', { title: 'Excluded', containerId: 'qa', authorId: null }),
    page('204', { title: 'Restricted', containerId: 'qa', authorId: null, metadata: { version: '1', restricted: true } }),
  ]);
  const configured = (peers: MigrationPackage[], exclusions: string[]) => {
    const request = input([source, ...peers]);
    request.configuration.sourceBaseUrls = { [source.summary.id]: home, ...Object.fromEntries(peers.map(pkg => [pkg.summary.id, peer])) };
    request.configuration.excludedRecords = exclusions;
    return buildMigrationPlan(request);
  };
  const exclusions = ['wiki-peer/page:201', 'wiki-peer/page:203'];
  const restricted = configured([peerSource], exclusions);
  assert.equal(restricted.preview.canApply, false);
  assert.ok(notices(restricted).has('RESTRICTED_CONTENT'));

  const verified = configured([peerSource], [...exclusions, 'wiki-peer/page:204']);
  assert.equal(verified.preview.canApply, true, JSON.stringify(verified.preview.notices));
  const sourceContent = (plan: typeof verified) => plan.documents.find(document => document.title === '문서 100')!;
  const target = verified.documents.find(document => document.title === 'Peer target')!;
  assert.deepEqual(contentReferences(sourceContent(verified).content).map(({ id, label }) => [id, label]), [
    [target.id, '확인한 상대 서버의 문서 제목'], [target.id, '확인한 상대 서버의 문서 ID'],
    [target.id, '확인한 상대 서버의 짧은 주소'],
  ]);
  for (const label of ['현재 서버에 없는 상대 경로', '현재 서버에 없는 상대 ID', '원본 제목이 중복된 문서', '제외한 원본 문서', '제한된 원본 문서', '제한된 원본 문서의 짧은 주소']) {
    assert.ok(sourceContent(verified).plainText.includes(label));
  }
  assert.ok(notices(verified).has('UNRESOLVED_REFERENCE'));

  const otherInstance = pkg('wiki-peer-other', 'confluence', [
    record('project', 'qa-other', { title: '같은 주소의 다른 인스턴스', metadata: { spaceKey: 'QA' } }),
    page('200', { title: 'Peer target', containerId: 'qa-other', authorId: null }),
  ]);
  const ambiguous = configured([peerSource, otherInstance], [...exclusions, 'wiki-peer/page:204']);
  assert.deepEqual(contentReferences(sourceContent(ambiguous).content), []);
  assert.ok(notices(ambiguous).has('UNRESOLVED_REFERENCE'));
});

test('Confluence hrefs verify the sibling package mount even within the same instance', () => {
  const base = 'https://wiki.example.test/tools/wiki';
  const source = pkg('wiki-href-source', 'confluence', [
    record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } }),
    page('100', { authorId: null, text: [
      confluenceBodyHref(`${base}/display/QA/Target`, '확인된 주소의 제목 경로'),
      confluenceBodyHref('/tools/wiki/pages/viewpage.action?pageId=200', '확인된 주소의 페이지 ID'),
      confluenceBodyHref('display/QA/Target', '서비스 기준 제목 경로'),
      '<ac:link><ri:page ri:space-key="QA" ri:content-title="Target"/><ac:link-body>원본의 구조화된 참조</ac:link-body></ac:link>',
    ].join('') }),
  ]);
  const sibling = pkg('wiki-href-sibling', 'confluence', [
    record('project', 'qa', { title: '같은 인스턴스의 검토 공간', metadata: { spaceKey: 'QA' } }),
    page('200', { title: 'Target', containerId: 'qa', authorId: null }),
  ]);
  sibling.dataset.source.instanceKey = source.dataset.source.instanceKey;
  const request = input([source, sibling]);
  request.configuration.sourceBaseUrls[source.summary.id] = base;
  const unverified = buildMigrationPlan(request);
  assert.equal(unverified.preview.canApply, true, JSON.stringify(unverified.preview.notices));
  const refs = (plan: typeof unverified) => contentReferences(plan.documents.find(document => document.title === '문서 100')!.content);
  assert.deepEqual(refs(unverified).map(({ label }) => label), ['원본의 구조화된 참조']);
  assert.ok(notices(unverified).has('UNRESOLVED_REFERENCE'));

  request.configuration.sourceBaseUrls[sibling.summary.id] = base;
  const verified = buildMigrationPlan(request);
  assert.equal(verified.preview.canApply, true, JSON.stringify(verified.preview.notices));
  const targetId = verified.documents.find(document => document.title === 'Target')!.id;
  assert.deepEqual(refs(verified).map(({ id, label }) => [id, label]), [
    [targetId, '확인된 주소의 제목 경로'], [targetId, '확인된 주소의 페이지 ID'],
    [targetId, '서비스 기준 제목 경로'], [targetId, '원본의 구조화된 참조'],
  ]);
  assert.ok(!notices(verified).has('UNRESOLVED_REFERENCE'));
});

test('Confluence append and refresh resolve hrefs to an already imported page absent from incoming records', () => {
  const base = 'https://wiki.example.test/tools/wiki';
  const space = record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } });
  const writer = page('100', { title: '이미 옮긴 원본 문서', authorId: null });
  const target = page('200', { title: 'Retained target', authorId: null });
  const baselineSource = pkg('wiki-href-initial', 'confluence', [space, writer, target]);
  const initial = input([baselineSource]);
  initial.configuration.sourceBaseUrls[baselineSource.summary.id] = base;
  const baseline = buildMigrationPlan(initial);
  assert.equal(baseline.preview.canApply, true, JSON.stringify(baseline.preview.notices));
  const project = baseline.projects[0];
  const current = baseline.documents.find(document => document.title === writer.title)!;
  const retained = baseline.documents.find(document => document.title === target.title)!;
  const previous = baseline.sourceRecords.find(row => row.targetId === current.id)!;
  assert.ok(previous.confluencePageFieldHashes?.content);

  const refresh = (local = current) => {
    const delta = pkg('wiki-href-delta', 'confluence', [{ ...space },
      { ...writer, text: confluenceBodyHref('display/TEAM/Retained+target', '기존 원본 제목으로 연결'), metadata: { version: '4' } },
      page('300', { title: '새로 옮길 원본 문서', authorId: null,
        text: confluenceBodyHref('/tools/wiki/pages/viewpage.action?pageId=200', '기존 원본 ID로 연결') }),
    ]);
    delta.dataset.source.instanceKey = baselineSource.dataset.source.instanceKey;
    const request = input([delta]);
    request.configuration.sourceBaseUrls[delta.summary.id] = base;
    request.configuration.appendPagesTo = { projectId: project.id, refreshExisting: true };
    request.appendPages = {
      project, sourceSpaceId: 's', sourceSpaceKey: 'TEAM', token: 'append-wiki-hrefs',
      knownPages: ([[writer, local], [target, retained]] as const).map(([source, document]) => ({
        sourceId: source.sourceId, sourceTitle: source.title, documentId: document.id, projectId: document.projectId, sourceSpaceId: 's',
      })),
      refreshDocuments: [{ document: local, previous, previousTimezone: 'UTC' }],
    };
    return buildMigrationPlan(request);
  };
  const incoming = refresh();
  assert.equal(incoming.preview.canApply, true, JSON.stringify(incoming.preview.notices));
  assert.equal(incoming.documents.length, 1);
  assert.deepEqual(contentReferences(incoming.documents[0].content).map(({ id, label }) => [id, label]), [[retained.id, '기존 원본 ID로 연결']]);
  assert.equal(incoming.documentUpdates?.[0].documentId, current.id);
  assert.equal(incoming.documentUpdates?.[0].expectedVersion, current.version);
  const content = incoming.documentUpdates?.[0].changes.content;
  assert.ok(content);
  assert.deepEqual(contentReferences(content).map(({ id, label }) => [id, label]), [[retained.id, '기존 원본 제목으로 연결']]);

  const local = { ...current, version: current.version + 1, plainText: '팀에서 편집한 본문', content: {
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '팀에서 편집한 본문' }] }],
  } };
  const conflicted = refresh(local);
  assert.equal(conflicted.preview.canApply, true, JSON.stringify(conflicted.preview.notices));
  assert.equal(conflicted.preview.documentRefresh?.[0].fields.find(field => field.field === 'content')?.decision, 'conflict');
  assert.deepEqual(conflicted.documentUpdates, []);
  assert.deepEqual(contentReferences(conflicted.documents[0].content).map(({ id }) => id), [retained.id]);
});

test('reviewed Confluence refresh repairs only untouched full-page checklist fallback, even at the same source revision', () => {
  const space = record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } });
  const original = page('10', { authorId: null, text: '<h2>확인 절차</h2><ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status>' +
    '<ac:task-body><ac:link><ri:user ri:userkey="source-reviewer"/></ac:link> 검토하기 <time datetime="2026-11-28"/>' +
    '</ac:task-body></ac:task></ac:task-list><p>다음 단계</p>' });
  const initialSource = pkg('original-checklist', 'confluence', [space, original]);
  const initial = buildMigrationPlan(input([initialSource]));
  assert.equal(initial.preview.canApply, true, JSON.stringify(initial.preview.notices));
  const [project] = initial.projects;
  const [current] = initial.documents;
  const sourceRecord = initial.sourceRecords.find(item => item.targetId === current.id)!;
  const fallback: DocPage = { ...current, plainText: original.text, content: { type: 'doc', content: [
    { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: original.text }] },
  ] } };
  const legacyReceipt = { ...sourceRecord };
  delete legacyReceipt.confluencePageFieldHashes;
  delete legacyReceipt.confluencePageBodySourceHash;
  const fallbackReceipt = { ...legacyReceipt, confluencePageFieldHashes: { ...sourceRecord.confluencePageFieldHashes,
    content: createHash('sha256').update(JSON.stringify(['content', JSON.stringify(fallback.content)])).digest('hex') } };
  const refresh = (local = fallback, previous = legacyReceipt, source = original) => {
    const next = pkg('checklist-refresh', 'confluence', [space, source]);
    next.dataset.source.instanceKey = initialSource.dataset.source.instanceKey;
    const request = input([next]);
    request.configuration.appendPagesTo = { projectId: project.id, refreshExisting: true };
    request.appendPages = { project, sourceSpaceId: 's', sourceSpaceKey: 'TEAM', token: 'checklist-refresh',
      knownPages: [{ sourceId: original.sourceId, documentId: current.id, projectId: project.id, sourceSpaceId: 's', sourceTitle: current.title }],
      refreshDocuments: [{ document: local, previous, previousTimezone: 'UTC' }] };
    return buildMigrationPlan(request);
  };

  for (const receipt of [legacyReceipt, fallbackReceipt]) {
    const repaired = refresh(fallback, receipt);
    assert.equal(repaired.preview.canApply, true, JSON.stringify(repaired.preview.notices));
    assert.equal(repaired.documents.length, 0);
    assert.ok(repaired.preview.requiredAcknowledgements.includes('CONFLUENCE_REFRESH_CHECKLIST_RESTORED'));
    assert.deepEqual(repaired.preview.documentRefresh?.[0].fields.map(({ field, decision }) => [field, decision]), [['content', 'apply']]);
    const update = repaired.documentUpdates?.[0];
    assert.equal(update?.documentId, current.id);
    assert.equal(update?.expectedVersion, fallback.version);
    assert.deepEqual(update?.changes.content?.content?.map(block => block.type), ['heading', 'taskList', 'paragraph']);
    const checkpoint = repaired.sourceRecords.find(item => item.targetId === current.id)!;
    assert.equal(checkpoint.record.text, original.text);
    assert.equal(checkpoint.confluencePageFieldHashes?.content, sourceRecord.confluencePageFieldHashes?.content);
    assert.deepEqual(refresh({ ...current, version: current.version + 1 }, checkpoint).documentUpdates, []);
  }

  const locallyEdited = { ...fallback, version: fallback.version + 1, content: { type: 'doc', content: [
    { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: `${original.text}\n팀의 메모` }] },
  ] } };
  assert.deepEqual(refresh(locallyEdited, fallbackReceipt).documentUpdates, []);
  const changedInSameSourceRevision = { ...original, text: original.text.replace('다음 단계', '다른 단계') };
  assert.deepEqual(refresh(fallback, fallbackReceipt, changedInSameSourceRevision).documentUpdates, []);
  const newerSameBody = { ...original, metadata: { version: '4' } };
  assert.ok(refresh(fallback, fallbackReceipt, newerSameBody).documentUpdates?.[0].changes.content);
  const laterChanged = { ...changedInSameSourceRevision, metadata: { version: '4' } };
  assert.equal(refresh(locallyEdited, fallbackReceipt, laterChanged).preview.documentRefresh?.[0].fields[0].decision, 'conflict');
});

test('all available attachment versions retain distinct files and a missing newest version requires acknowledgement',()=>{
  const source=confluence(),sha1=createHash('sha256').update('one').digest('hex'),sha2=createHash('sha256').update('two').digest('hex');source.dataset.records.push(record('attachment','a3',{title:'image.png',containerId:'10',authorId:'bob',createdAt:created,metadata:{version:'3'},references:[{kind:'page',sourceId:'10',relation:'container-content'}]}),record('attachment','a2',{title:'image.png',containerId:'10',authorId:'bob',createdAt:created,metadata:{version:'2',currentVersionId:'a3',packagePath:'attachments/two',sha256:sha2,size:3,mimeType:'text/html'},references:[{kind:'page',sourceId:'10',relation:'container-content'}]}),record('attachment','a1',{title:'image.png',containerId:'10',authorId:'bob',createdAt:created,metadata:{version:'1',currentVersionId:'a3',packagePath:'attachments/one',sha256:sha1,size:3},references:[{kind:'page',sourceId:'10',relation:'container-content'}]}));source.dataset.records.find(row=>row.id==='page:10')!.text='<ac:image><ri:attachment ri:filename="image.png"/></ac:image>';const request=input([source]);request.fileInfo={wiki:{'attachments/one':{size:3,sha256:sha1,mimeType:'image/png'},'attachments/two':{size:3,sha256:sha2,mimeType:'image/png'}}};const plan=buildMigrationPlan(request);assert.equal(plan.preview.canApply,true,JSON.stringify(plan.preview.notices));assert.equal(plan.attachments.length,1);assert.equal(plan.attachmentVersions.length,2);assert.equal(plan.fileCopies.length,2);const latest=plan.attachmentVersions.find(version=>version.versionLabel==='2')!;assert.equal(plan.attachments[0].id,latest.id);assert.equal(plan.attachments[0].mimeType,'image/png');assert.ok(plan.attachmentVersions.every(version=>version.attachmentId===latest.id));assert.equal(new Set(plan.fileCopies.map(file=>file.fileId)).size,2);assert.ok(plan.preview.requiredAcknowledgements.includes('ATTACHMENT_LATEST_MISSING'));const absent=plan.sourceRecords.find(row=>row.record.id==='attachment:a3')!;assert.equal(absent.targetId,null);assert.equal(absent.ownerId,plan.documents[0].id);assert.equal(plan.sourceRecords.find(row=>row.record.id==='attachment:a1')!.targetId,plan.attachmentVersions.find(version=>version.versionLabel==='1')!.id);assert.ok(JSON.stringify(plan.documents[0].content).includes(`attachments/${latest.id}/content?inline=1`));
});

test('Confluence history appends original rows with proven owners and leaves repeats and unsafe bodies in the archive', () => {
  const space = record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } });
  const current = page('10', { authorId: null, metadata: { version: '8' } });
  const anchor = page('20', { authorId: null });
  const initial = pkg('initial-history', 'confluence', [space, current, anchor]);
  const baseline = buildMigrationPlan(input([initial]));
  const project = baseline.projects[0], [owner, other] = baseline.documents;
  const revision = (id: string, version: number, text: string, extra: Partial<LegacyRecord> = {}) => record('revision', id, {
    title: `과거 문서 ${id}`, text, textFormat: 'confluence-storage', updatedAt: created,
    references: [{ kind: 'page', sourceId: '10', relation: 'current-version' }],
    metadata: { sourceClass: 'Page', currentVersionId: '10', version: String(version) }, ...extra,
  });
  const comment = (id: string, text: string, sourcePage = '10', extra: Partial<LegacyRecord> = {}) => record('comment', id, {
    text, textFormat: 'confluence-storage', createdAt: created, containerId: sourcePage,
    references: [{ kind: 'page', sourceId: sourcePage, relation: 'container-content' }], metadata: { sourceClass: 'Comment' }, ...extra,
  });
  const link = (reference: string) => `<p><ac:link><ri:attachment ${reference}><ri:page ri:content-id="10"/></ri:attachment></ac:link></p>`;
  const source = pkg('additional-history', 'confluence', [space,
    comment('reply', `<p><strong>새</strong> 댓글 ${storageStatus('검토 중')}</p>`, '10', { parentId: 'deleted', references: [
      { kind: 'page', sourceId: '10', relation: 'container-content' }, { kind: 'comment', sourceId: 'deleted', relation: 'parent' },
    ] }),
    comment('deleted', '<p>수정된 원본 댓글</p>', '20'),
    comment('restricted', '<p>접근 제한 댓글</p>', '10', { metadata: { sourceClass: 'Comment', restricted: true } }),
    comment('restricted-reply', '<p>다른 패키지에 제한된 상위 댓글이 있습니다.</p>', '10', { parentId: 'restricted-parent', references: [
      { kind: 'page', sourceId: '10', relation: 'container-content' }, { kind: 'comment', sourceId: 'restricted-parent', relation: 'parent' },
    ] }),
    revision('old-2', 2, '<p>저장된 본문</p>'),
    revision('old-3', 3, link('ri:content-id="historical-file"')),
    revision('old-4', 4, link('ri:filename="image.png"')),
    revision('old-5', 5, link('ri:content-id="file"')),
    revision('old-6a', 6, '<p>버전 중복 A</p>'), revision('old-6b', 6, '<p>버전 중복 B</p>'),
    revision('old-7', 7, '<p>제목 길이 제한</p>', { title: 'a'.repeat(301) }),
    revision('unsafe-version', Number.MAX_SAFE_INTEGER, '<p>버전 번호 범위 초과</p>'),
    revision('current-alias', 8, '<p>이미 저장된 현재 버전</p>'),
    revision('orphan', 1, '<p>고아 원본 본문</p>', { metadata: { sourceClass: 'BodyContent', orphan: true } }),
  ], [{ id: 'missing-primary', severity: 'error', code: 'NO_PRIMARY_CONTENT', message: '현재 문서 객체가 없습니다.', path: 'entities.xml', recordId: null }]);
  const upstream = pkg('upstream-restrictions', 'confluence', [space,
    comment('restricted-parent', '<p>접근 제한 상위 댓글</p>', '10', { metadata: { sourceClass: 'Comment', restricted: true } }),
  ]);
  for (const pack of [source, upstream]) pack.dataset.source.instanceKey = initial.dataset.source.instanceKey;
  const attachment = { id: 'prior-file-version', attachmentId: 'primary-file', resourceType: 'document' as const,
    resourceId: owner.id, filename: 'image.png', mimeType: 'image/png', size: 3, sha256: 'a'.repeat(64),
    authorId: actor.id, createdAt: created, versionLabel: '1', sourceImportId: 'first-import', sourceRecordId: 'first-file-record' };
  const request = input([source, upstream]);
  request.configuration.appendPagesTo = { projectId: project.id, refreshHistory: true };
  request.appendPages = { project, sourceSpaceId: 's', sourceSpaceKey: 'TEAM', token: 'append-history',
    knownPages: [{ sourceId: '10', documentId: owner.id }, { sourceId: '20', documentId: other.id }].map(row => ({
      ...row, projectId: project.id, sourceSpaceId: 's', sourceTitle: `문서 ${row.sourceId}`,
    })),
    knownHistory: [
      { kind: 'revision', sourceId: '10', sourcePageId: '10', documentId: owner.id, sourceVersion: 8 },
      { kind: 'comment', sourceId: 'deleted', sourcePageId: '10', documentId: owner.id, sourceVersion: null },
    ],
    knownAttachments: [{ sourcePageId: '10', sourceRootId: 'file', sourceId: 'historical-file', sourceRevision: 1,
      documentId: owner.id, filename: 'image.png', version: attachment, hasLocalVersions: false },
      { sourcePageId: '10', sourceRootId: 'file', sourceId: 'file', sourceRevision: 2,
        documentId: owner.id, filename: 'image.png', version: { ...attachment, id: 'primary-file', versionLabel: '2' }, hasLocalVersions: false }],
  };
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.deepEqual(plan.confluenceHistoryOwners, [owner.id]);
  assert.deepEqual(plan.documents, []);
  assert.equal(plan.documentUpdates, undefined);
  assert.deepEqual(plan.comments.map(row => [row.resourceId, row.body]), [[owner.id, '새 댓글 [상태: 검토 중]']]);
  assert.deepEqual(plan.revisions.map(row => [row.documentId, row.version, row.confluenceSourceVersion]), [[owner.id, 2, 2], [owner.id, 3, 3]]);
  assert.equal(plan.preview.counts.newConfluenceComments, 1);
  assert.equal(plan.preview.counts.newConfluenceRevisions, 2);
  assert.deepEqual(plan.reusedAttachmentVersions, [attachment]);
  assert.match(JSON.stringify(plan.revisions[1].content), /\/api\/attachments\/prior-file-version\/content/);
  assert.equal(plan.sourceRecords.find(row => row.record.sourceId === 'reply')?.ownerId, owner.id);
  assert.equal(plan.sourceRecords.find(row => row.record.sourceId === 'reply')?.record.parentId, 'deleted');
  assert.deepEqual(plan.sourceRecords.filter(row => ['comment', 'revision'].includes(row.record.kind) && row.targetId).map(row => row.record.sourceId), ['reply', 'old-2', 'old-3']);
  assert.ok(notices(plan).has('CONFLUENCE_HISTORY_RAW_ONLY'));
  assert.ok(!notices(plan).has('SOURCE_NO_PRIMARY_CONTENT'));

  request.appendPages.knownHistory!.push(
    { kind: 'comment', sourceId: 'reply', sourcePageId: '10', documentId: owner.id, sourceVersion: null },
    { kind: 'revision', sourceId: 'old-2', sourcePageId: '10', documentId: owner.id, sourceVersion: 2 },
    { kind: 'revision', sourceId: 'old-3', sourcePageId: '10', documentId: owner.id, sourceVersion: 3 },
  );
  const repeat = buildMigrationPlan(request);
  assert.equal(repeat.preview.canApply, false);
  assert.ok(notices(repeat).has('SOURCE_NO_PRIMARY_CONTENT'));

  request.configuration.appendPagesTo = { projectId: project.id };
  const defaultPlan = buildMigrationPlan(request);
  assert.deepEqual(defaultPlan.comments, []);
  assert.deepEqual(defaultPlan.revisions, []);
});

test('Confluence attachment refresh preserves source pins and guards ambiguous or unavailable versions', () => {
  const space = record('project', 's', { title: '원본 공간', metadata: { spaceKey: 'TEAM' } });
  const asset = (id: string, revision: number, bytes?: string, root?: string, sourcePage = '10') => record('attachment', id, {
    title: 'image.png', containerId: sourcePage, createdAt: created,
    references: [{ kind: 'page', sourceId: sourcePage, relation: 'container-content' }],
    metadata: { attachmentVersion: String(revision), ...(root ? { currentVersionId: root } : {}), ...(bytes ? {
      packagePath: `attachments/${id}/${revision}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: Buffer.byteLength(bytes),
    } : {}) },
  });
  const initial = pkg('first-wiki', 'confluence', [space, page('10', { authorId: null }), asset('file', 1, 'old')]);
  const baseline = buildMigrationPlan(input([initial]));
  assert.equal(baseline.preview.canApply, true, JSON.stringify(baseline.preview.notices));
  const project = baseline.projects[0], document = baseline.documents[0], firstFile = baseline.attachmentVersions[0];
  const archive = baseline.sourceRecords.find(row => row.targetId === document.id)!;
  const knownFile = {
    sourcePageId: '10', sourceRootId: 'file', sourceId: 'file', sourceRevision: 1, filename: 'image.png',
    documentId: document.id, version: firstFile, hasLocalVersions: true,
  };
  const known = [knownFile];
  const delta = (rows: LegacyRecord[], prior: NonNullable<MigrationPlanningInput['appendPages']>['knownAttachments'] = known) => {
    const source = pkg('next-wiki', 'confluence', [space, ...rows]);
    source.dataset.source.instanceKey = initial.dataset.source.instanceKey;
    const request = input([source]);
    request.configuration.appendPagesTo = { projectId: project.id, refreshExisting: true, refreshAttachments: true };
    request.appendPages = {
      project, sourceSpaceId: 's', sourceSpaceKey: 'TEAM', token: 'append-files', knownAttachments: prior,
      knownPages: [{ sourceId: '10', sourceSpaceId: 's', projectId: project.id, documentId: document.id, sourceTitle: document.title }],
      refreshDocuments: [{ document, previous: archive, previousTimezone: 'UTC' }],
    };
    return buildMigrationPlan(request);
  };
  const use = (id?: string) => `<ac:link><ri:attachment ${id ? `ri:content-id="${id}"` : 'ri:filename="image.png"'}><ri:page ri:content-id="10"/></ri:attachment></ac:link>`;
  const update = (text: string) => page('10', { authorId: null, text, metadata: { version: '4' } });
  const next = delta([update(`<p>${use()} ${use('old-alias')}</p>`), asset('file', 2, 'new'), asset('old-alias', 1, 'old', 'file')]);
  assert.equal(next.preview.canApply, true, JSON.stringify(next.preview.notices));
  assert.deepEqual(next.confluenceAttachmentOwners, [document.id]);
  assert.equal(next.preview.counts.newConfluenceAttachmentVersions, 1);
  assert.equal(next.preview.counts.newConfluenceAttachments, 0);
  assert.equal(next.attachments.length, 0);
  assert.equal(next.fileCopies.length, 1);
  const extended = next.attachmentVersions[0];
  assert.equal(extended.attachmentId, firstFile.attachmentId);
  assert.equal(extended.sourceRevision, 2);
  assert.equal(next.sourceRecords.find(row => row.record.id === 'attachment:old-alias')?.targetId, null);
  assert.deepEqual(next.reusedAttachmentVersions?.map(file => file.id), [firstFile.id]);
  const body = JSON.stringify(next.documentUpdates?.[0].changes.content);
  assert.ok(body.includes(`${firstFile.id}/content`));
  assert.ok(body.includes(`${extended.id}/content`));

  const absent = delta([update(`<p>${use()}</p>`), asset('file', 2)]);
  assert.equal(absent.preview.canApply, false);
  assert.equal(absent.documentUpdates?.length, 0);
  assert.ok(notices(absent).has('CONFLUENCE_REFRESH_BODY_UNAVAILABLE'));
  assert.equal(absent.reusedAttachmentVersions?.length, 0);
  const changedBytes = delta([update(`<p>${use()}</p>`), asset('file', 1, 'unexpected')]);
  assert.equal(changedBytes.preview.canApply, false);
  assert.ok(notices(changedBytes).has('CONFLUENCE_ATTACHMENT_VERSION_CONFLICT'));
  const tombstoned = delta([page('10', { authorId: null }), asset('file', 2, 'new')], [{ ...knownFile, version: null }]);
  assert.equal(tombstoned.preview.canApply, false);
  assert.equal(tombstoned.attachmentVersions.length, 0);

  const historyOnly = { ...knownFile, sourceId: 'historical-newer', sourceRevision: 2, version: extended };
  const borrower = delta([page('20', { authorId: null, text: `<p>${use()} ${use('historical-newer')}</p>` })], [knownFile, historyOnly]);
  assert.equal(borrower.preview.canApply, true, JSON.stringify(borrower.preview.notices));
  assert.ok(notices(borrower).has('UNRESOLVED_ATTACHMENT'));
  assert.deepEqual(borrower.reusedAttachmentVersions?.map(file => file.id), [extended.id]);
  assert.ok(!JSON.stringify(borrower.documents[0].content).includes(`${firstFile.id}/content`));

  const moved = delta([page('20', { authorId: null }), asset('file', 2, 'unexpected', undefined, '20')]);
  assert.equal(moved.preview.canApply, true, JSON.stringify(moved.preview.notices));
  assert.equal(moved.attachmentVersions.length, 0);
  assert.ok(notices(moved).has('CONFLUENCE_ATTACHMENT_OWNER_CONFLICT'));
});

test('restricted content blocks apply and explicit primary exclusion cascades descendants while preserving source archives',()=>{
  const source=confluence();source.dataset.records.find(row=>row.id==='page:10')!.metadata.restricted=true;source.dataset.diagnostics.push({id:'restricted',severity:'error',code:'CONFLUENCE_RESTRICTED_CONTENT',message:'restricted',recordId:'page:10',path:null});const request=input([source]),blocked=buildMigrationPlan(request);assert.equal(blocked.preview.canApply,false);assert.ok(notices(blocked).has('RESTRICTED_CONTENT'));request.configuration.excludedRecords=['wiki/page:10'];const allowed=buildMigrationPlan(request);assert.equal(allowed.preview.canApply,true,JSON.stringify(allowed.preview.notices));assert.equal(allowed.documents.length,0);assert.equal(allowed.comments.length,0);assert.equal(allowed.revisions.length,0);assert.equal(allowed.preview.counts.excludedRecords,3);for(const archive of allowed.sourceRecords.filter(row=>['page','comment','revision'].includes(row.record.kind))){assert.equal(archive.targetId,null);assert.equal(archive.ownerId,null);}assert.equal(allowed.sourceRecords.length,source.dataset.records.length);for(const[field,value]of [['security',{id:'private',name:'비공개'}],['Security Level','Internal']] as const){const source=jira();(source.dataset.records.find(row=>row.id==='issue:1')!.metadata.fields as Record<string,unknown>)[field]=value;assert.equal(buildMigrationPlan(input([source])).preview.canApply,false);}for(const internal of ['false','true']){const source=jira();source.dataset.records.find(row=>row.id==='comment:jc')!.metadata.visibility=[{key:'sd.public.comment',value:{internal}}];assert.equal(buildMigrationPlan(input([source])).preview.canApply,internal==='false');}
});

test('confirmed Confluence restrictions follow ownership across ZIPs from the same instance', () => {
  const original = confluence();
  const space = record('project', 's', { title: '같은 원본 공간', metadata: { spaceKey: 'TEAM' } });
  const nested = page('20', { parentId: '10', authorId: null });
  const comment = record('comment', 'cross', {
    text: '하위 문서 댓글', textFormat: 'plain', createdAt: created, containerId: '20',
    references: [{ kind: 'page', sourceId: '20', relation: 'container-content' }],
  });
  const related = pkg('related', 'confluence', [nested, comment]);
  related.dataset.source.instanceKey = original.dataset.source.instanceKey;
  const separate = pkg('separate', 'confluence', [space, page('10', { authorId: null }), nested, comment]);
  const request = input([original, related, separate]);
  const restricted = new Map([[original.dataset.source.instanceKey, new Set(['10'])]]);

  const blocked = buildMigrationPlan(request, restricted);
  assert.equal(blocked.preview.canApply, false);
  const failures = blocked.preview.notices.filter(notice => notice.code === 'RESTRICTED_CONTENT');
  assert.ok(failures.some(notice => notice.recordId === 'wiki/page:10' && notice.severity === 'error'));
  assert.ok(failures.some(notice => notice.recordId === 'related/page:20'));
  assert.ok(failures.every(notice => !notice.recordId?.startsWith('separate/')));
  assert.deepEqual(blocked.documents, []);

  request.configuration.excludedRecords = ['wiki/page:10'];
  const allowed = buildMigrationPlan(request, restricted);
  assert.equal(allowed.preview.canApply, true, JSON.stringify(allowed.preview.notices));
  assert.equal(allowed.preview.counts.explicitExcludedRecords, 1);
  assert.equal(allowed.preview.counts.excludedDescendants, 4);
  assert.deepEqual(allowed.documents.map(document => document.title), ['문서 10', '문서 20']);
  assert.deepEqual(allowed.comments.map(row => row.body), ['하위 문서 댓글']);
  for (const archive of allowed.sourceRecords.filter(row => row.source.instanceKey === original.dataset.source.instanceKey &&
      ['page', 'comment', 'revision'].includes(row.record.kind))) {
    assert.equal(archive.excluded, true);
    assert.equal(archive.targetId, null);
    assert.equal(archive.ownerId, null);
  }
});

test('sparse Confluence append blocks proven restricted page owners absent from the selected ZIP', () => {
  const space = record('project', 's', { title: '원본 공간' });
  const prior = pkg('prior', 'confluence', [space, page('10', { authorId: null, metadata: { version: '3' } })]);
  const previous = buildMigrationPlan(input([prior]));
  const project = previous.projects[0], owner = previous.documents[0];
  const comment = record('comment', 'sparse', {
    text: '기존 문서의 새 댓글', textFormat: 'plain', createdAt: created, containerId: '10',
    references: [{ kind: 'page', sourceId: '10', relation: 'container-content' }], metadata: { sourceClass: 'Comment' },
  });
  const revision = record('revision', 'sparse', {
    title: '기존 문서의 과거 본문', text: '<p>이전 본문</p>', textFormat: 'confluence-storage', updatedAt: created,
    references: [{ kind: 'page', sourceId: '10', relation: 'current-version' }],
    metadata: { sourceClass: 'Page', currentVersionId: '10', version: '2' },
  });
  const attachment = record('attachment', 'sparse', {
    title: 'manual.png', createdAt: created, containerId: '10',
    references: [{ kind: 'page', sourceId: '10', relation: 'container-content' }],
    metadata: { version: '1', packagePath: 'attachments/manual', sha256: 'a'.repeat(64), size: 3 },
  });
  const source = pkg('sparse', 'confluence', [space, page('20', { authorId: null }), comment, revision, attachment]);
  source.dataset.source.instanceKey = prior.dataset.source.instanceKey;
  const request = input([source]);
  request.configuration.appendPagesTo = { projectId: project.id, refreshHistory: true, refreshAttachments: true };
  request.appendPages = { project, sourceSpaceId: 's', token: 'append',
    knownPages: [{ sourceId: '10', documentId: owner.id, projectId: project.id, sourceSpaceId: 's', sourceTitle: owner.title }] };
  const unrestricted = buildMigrationPlan(request);
  assert.equal(unrestricted.preview.canApply, true, JSON.stringify(unrestricted.preview.notices));
  assert.equal(unrestricted.comments.length, 1);
  assert.equal(unrestricted.revisions.filter(row => row.documentId === owner.id).length, 1);
  assert.equal(unrestricted.attachments.length, 1);

  const restricted = new Map([[prior.dataset.source.instanceKey, new Set(['10'])]]);
  const blocked = buildMigrationPlan(request, restricted);
  assert.equal(blocked.preview.canApply, false);
  const excludedRecords = blocked.preview.notices.filter(notice => notice.code === 'RESTRICTED_CONTENT').map(notice => notice.recordId!);
  assert.deepEqual(new Set(excludedRecords), new Set(['sparse/comment:sparse', 'sparse/revision:sparse', 'sparse/attachment:sparse']));
  request.configuration.excludedRecords = excludedRecords;
  const allowed = buildMigrationPlan(request, restricted);
  assert.equal(allowed.preview.canApply, true, JSON.stringify(allowed.preview.notices));
  assert.deepEqual(allowed.documents.map(document => document.title), ['문서 20']);
  assert.deepEqual(allowed.comments, []);
  assert.deepEqual(allowed.revisions.filter(row => row.documentId === owner.id), []);
  assert.deepEqual(allowed.attachments, []);
  assert.deepEqual(allowed.fileCopies, []);
  for (const archive of allowed.sourceRecords.filter(row => row.record.sourceId === 'sparse')) {
    assert.equal(archive.excluded, true);
    assert.equal(archive.targetId, null);
    assert.equal(archive.ownerId, null);
  }
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

test('Jira remote Confluence relations only link a page consistent with the declared source ID', () => {
  const source = jira(), wiki = confluence();
  const base = 'https://wiki.example.test/wiki';
  wiki.dataset.records.find(row => row.id === 'page:10')!.title = 'Declared target';
  wiki.dataset.records.push(page('20', { authorId: null, title: 'Different target' }));
  const relation = (id: string, issueId: string, path: string) => record('relation', id, {
    title: '원본 문서 관계', metadata: { url: `${base}/${path}` }, references: [
      { kind: 'issue', sourceId: issueId, relation: 'source' }, { kind: 'page', sourceId: '10', relation: 'externalDocument' },
    ],
  });
  source.dataset.records.push(
    relation('remote-number-matches', '1', 'pages/viewpage.action?pageId=10'),
    relation('remote-title-matches', '2', 'display/TEAM/Declared+target'),
    relation('remote-number-conflict', '1', 'pages/viewpage.action?pageId=20'),
    relation('remote-title-conflict', '2', 'display/TEAM/Different+target'),
  );
  const request = input([source, wiki]);
  request.configuration.sourceBaseUrls.wiki = base;
  const plan = buildMigrationPlan(request);
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  const targetId = plan.documents.find(document => document.title === 'Declared target')!.id;
  assert.deepEqual(plan.resourceLinks.map(({ issueId, documentId }) => [issueId, documentId]),
    plan.issues.map(({ id }) => [id, targetId]));
  assert.deepEqual(plan.preview.notices.filter(notice => notice.code === 'DOCUMENT_ISSUE_LINK_UNRESOLVED').map(notice => notice.recordId),
    ['jira/relation:remote-number-conflict', 'jira/relation:remote-title-conflict']);
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
