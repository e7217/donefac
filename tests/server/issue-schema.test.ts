import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../server/store.js';
import { IssueSchemaError,IssueSchemaService } from '../../server/issue-schema.js';
import { WorkflowError,WorkflowService } from '../../server/workflows.js';
import { SavedViewService } from '../../server/saved-views.js';
import { defaultIssueSchema,fieldValueLabel,issueSearchText,projectIssueTypes,requiredFieldLabels } from '../../shared/issue-schema.js';
import type { CustomFieldDefinition,CustomFieldKind,Issue,Project,ProjectIssueSchema,SavedView,User } from '../../shared/types.js';

const now='2026-11-16T00:00:00.000Z';
const project:Project={id:'project-test',key:'SCHEMA',name:'속성 검증',description:'',color:'#668899',createdAt:now};
const user:User={id:'user-test',name:'속성 담당자',email:'schema@example.test',color:'#668899'};
function issue(customFields:Issue['customFields']={},type='incident'):Issue{return{id:'issue-test',key:'SCHEMA-1',projectId:project.id,title:'속성 예제',description:'',type,status:'todo',priority:'medium',assigneeId:null,collaboratorIds:[],parentId:null,labels:[],startDate:null,endDate:null,dueDate:null,estimate:null,cycle:null,module:null,release:null,version:1,createdAt:now,updatedAt:now,completedAt:null,customFields};}
function field(id:string,kind:CustomFieldKind,extra:Partial<CustomFieldDefinition>={}):CustomFieldDefinition{return{id,name:id,description:'',kind,required:false,issueTypes:[],options:kind==='select'||kind==='multi_select'?[{id:'old',name:'기존 선택',archived:false},{id:'new',name:'새 선택',archived:false}]:[],archived:false,...extra};}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'teamspace-issue-schema-'));const store=new Store(dir);store.put('projects',project);store.put('users',user);const schemas=new IssueSchemaService(store),workflows=new WorkflowService(store,schemas),views=new SavedViewService(store,schemas);return{store,schemas,workflows,views,save:(fields:CustomFieldDefinition[]=[])=>{const previous=schemas.get(project.id);return schemas.save(project.id,{...previous,issueTypes:[{id:'incident',name:'운영 장애',color:'#5588aa',archived:false},{id:'request',name:'지원 요청',color:'#aa8855',archived:false}],fields},previous.version);},close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});}};}
function rejects(action:()=>unknown,status=400){assert.throws(action,(error:unknown)=>error instanceof IssueSchemaError&&error.status===status);}
function edit(f:ReturnType<typeof fixture>,change:(value:ProjectIssueSchema)=>ProjectIssueSchema){const previous=f.schemas.get(project.id);return f.schemas.save(project.id,change(structuredClone(previous)),previous.version);}

test('all eight kinds preserve canonical values, required zero/false and strict validation without coercion',()=>{
  const f=fixture();try{
    const fields=[field('note','text'),field('risk','number',{required:true}),field('when','date'),field('severity','select'),field('services','multi_select'),field('checked','checkbox',{required:true}),field('owner','user'),field('evidence','url')];f.save(fields);
    const values={note:' 유지할 공백 ',risk:0,when:'2024-02-29',severity:'old',services:['old','new'],checked:false,owner:user.id,evidence:'https://example.test/path?q=a'};
    const valid=issue(values);f.schemas.validateIssue(valid);assert.deepEqual(valid.customFields,values);
    const invalid:[string,unknown][]=[['note',45],['note','a'.repeat(20001)],['risk','0'],['risk',NaN],['risk',Infinity],['when','2025-02-29'],['when','2026-1-01'],['severity','missing'],['severity',['old']],['services',['old','old']],['services',['missing']],['services','old'],['checked','false'],['owner','missing-user'],['evidence','javascript:alert(1)'],['evidence','/relative'],['evidence','https://name:password@example.test']];
    for(const[id,value]of invalid)rejects(()=>f.schemas.validateIssue(issue({...values,[id]:value} as Issue['customFields'])));
    rejects(()=>f.schemas.validateIssue(issue({...values,unknown:null})),400);
    rejects(()=>f.schemas.validateIssue(issue({...values,risk:null})),422);
    rejects(()=>f.schemas.validateIssue(issue({...values,checked:null})),422);
    rejects(()=>f.schemas.validateIssue({...issue(values),type:'missing'}));
    const empty=issue({...values,note:'   ',services:[]});f.schemas.validateIssue(empty);assert.equal(empty.customFields!.note,null);assert.deepEqual(empty.customFields!.services,[]);
  }finally{f.close();}
});

test('archived types, scoped fields and options retain history while rejecting newly assigned historical values',()=>{
  const f=fixture();try{
    f.save([field('note','text'),field('services','multi_select'),field('severity','select')]);
    const previous=issue({note:'과거 기록',services:['old'],severity:'old'});f.schemas.validateIssue(previous);f.store.put('issues',previous);
    edit(f,schema=>({...schema,issueTypes:schema.issueTypes.map(type=>type.id==='incident'?{...type,archived:true}:type),fields:schema.fields.map(value=>value.id==='note'?{...value,archived:true}:({...value,options:value.options.map(option=>option.id==='old'?{...option,archived:true}:option)}))}));
    const retained={...previous,customFields:{...previous.customFields,services:['old','new']}};f.schemas.validateIssue(retained,previous);assert.deepEqual(retained.customFields!.services,['old','new']);
    rejects(()=>f.schemas.validateIssue(issue(previous.customFields)),422);
    rejects(()=>f.schemas.validateIssue({...retained,customFields:{...retained.customFields,note:'다른 기록'}},previous),422);
    rejects(()=>f.schemas.validateIssue(issue({services:['old']},'request')),422);
    const cleared={...previous,customFields:{note:null,services:['new'],severity:null}};f.schemas.validateIssue(cleared,previous);
    f.schemas.validateIssue({...previous,customFields:previous.customFields},undefined,{allowArchived:true,checkFields:false});
    edit(f,schema=>({...schema,fields:schema.fields.map(value=>value.id==='services'?{...value,issueTypes:['request']}:value)}));
    f.schemas.validateIssue({...previous,customFields:{...previous.customFields,services:['old']}},previous);
    rejects(()=>f.schemas.validateIssue({...previous,customFields:{...previous.customFields,services:['old','new']}},previous),422);
    f.schemas.validateIssue({...previous,customFields:{...previous.customFields,services:[]}},previous);
  }finally{f.close();}
});

test('schema CAS and stable IDs protect used values, names, kinds and active configuration',()=>{
  const f=fixture();try{
    const saved=f.save([field('risk','number'),field('checked','checkbox'),field('severity','select')]);
    f.store.put('issues',issue({risk:0,checked:false,severity:'old'}));
    rejects(()=>f.schemas.save(project.id,saved,1),409);
    for(const id of ['risk','checked'])rejects(()=>edit(f,schema=>({...schema,fields:schema.fields.filter(value=>value.id!==id)})),409);
    rejects(()=>edit(f,schema=>({...schema,fields:schema.fields.map(value=>value.id==='risk'?{...value,kind:'text'}:value)})));
    rejects(()=>edit(f,schema=>({...schema,fields:schema.fields.map(value=>value.id==='severity'?{...value,options:value.options.filter(option=>option.id!=='old')}:value)})),409);
    rejects(()=>edit(f,schema=>({...schema,issueTypes:schema.issueTypes.filter(type=>type.id!=='incident')})),409);
    for(const id of ['all','constructor','__proto__','prototype','*','A_b'])rejects(()=>edit(f,schema=>({...schema,issueTypes:[...schema.issueTypes,{id,name:'예약 유형',color:'#668899',archived:false}]})));
    rejects(()=>edit(f,schema=>({...schema,issueTypes:schema.issueTypes.map(type=>({...type,archived:true}))})));
    rejects(()=>edit(f,schema=>({...schema,fields:schema.fields.map(value=>value.id==='severity'?{...value,options:value.options.map(option=>({...option,archived:true}))}:value)})));
    rejects(()=>edit(f,schema=>({...schema,fields:[...schema.fields,field('another','text',{name:'risk'})]})));
    const renamed=edit(f,schema=>({...schema,issueTypes:schema.issueTypes.map(type=>type.id==='incident'?{...type,name:'운영 사건'}:type),fields:schema.fields.map(value=>value.id==='severity'?{...value,name:'영향 범위',options:value.options.map(option=>option.id==='old'?{...option,name:'전체 서비스'}:option)}:value)}));
    const current=f.store.get<Issue>('issues','issue-test')!;assert.equal(current.customFields!.severity,'old');const text=issueSearchText({issueSchemas:[renamed],users:[user]},current);assert.ok(text.includes('운영 사건'));assert.ok(text.includes('영향 범위'));assert.ok(text.includes('전체 서비스'));assert.ok(!text.includes('기존 선택'));
  }finally{f.close();}
});

test('workflow and saved-view references share project schemas and protect removable IDs',()=>{
  const f=fixture();try{
    f.save([field('risk','number'),field('checked','checkbox'),field('specific','text',{issueTypes:['request']})]);
    const original=f.workflows.get(project.id);const workflow=f.workflows.save(project.id,{...original,fieldRules:[{issueType:'incident',statusId:'todo',requiredFields:['custom:risk','custom:checked','custom:specific']}]},original.version);
    const valid=issue({risk:0,checked:false});f.schemas.validateIssue(valid);f.workflows.validateIssue(valid);
    assert.throws(()=>f.workflows.validateIssue(issue({risk:0})),(error:unknown)=>error instanceof WorkflowError&&error.status===422);
    rejects(()=>edit(f,schema=>({...schema,fields:schema.fields.map(value=>value.id==='risk'?{...value,archived:true}:value)})),409);
    rejects(()=>edit(f,schema=>({...schema,fields:schema.fields.filter(value=>value.id!=='risk')})),409);
    rejects(()=>edit(f,schema=>({...schema,issueTypes:schema.issueTypes.filter(value=>value.id!=='incident')})),409);
    const view:SavedView={id:'view-test',projectId:project.id,name:'지원 요청 보기',authorId:user.id,layout:'list',filters:{query:'',status:'all',assigneeId:'all',type:'request'},version:1,createdAt:now,updatedAt:now};f.store.transaction(()=>f.views.replaceImported([view]));
    rejects(()=>edit(f,schema=>({...schema,issueTypes:schema.issueTypes.filter(value=>value.id!=='request'),fields:schema.fields.map(value=>({...value,issueTypes:[]}))})),409);
    const incoming=f.schemas.get(project.id);assert.equal(f.workflows.validateImport([workflow],[project],[],[incoming])[0].fieldRules[0].issueType,'incident');assert.equal(f.views.validateImport([view],[project],[user],[incoming])[0].filters.type,'request');
    f.workflows.save(project.id,{...workflow,fieldRules:[]},workflow.version);
    edit(f,schema=>({...schema,fields:schema.fields.map(value=>value.id==='risk'?{...value,archived:true}:value)}));
    const next=f.workflows.get(project.id);assert.throws(()=>f.workflows.save(project.id,{...next,fieldRules:[{issueType:'incident',statusId:'todo',requiredFields:['custom:risk']}]},next.version),WorkflowError);
  }finally{f.close();}
});

test('unused-field cleanup and audit are one transaction, with version bumps only after successful commit',()=>{
  const f=fixture();try{
    const schema=f.save([field('optional','text')]);const before=issue({optional:null});f.store.put('issues',before);
    assert.throws(()=>f.schemas.save(project.id,{...schema,fields:[]},schema.version,()=>{throw new Error('audit failed');}),/audit failed/);
    assert.deepEqual(f.schemas.get(project.id),schema);assert.deepEqual(f.store.get('issues',before.id),before);
    const saved=f.schemas.save(project.id,{...schema,fields:[]},schema.version);assert.equal(saved.version,schema.version+1);const after=f.store.get<Issue>('issues',before.id)!;assert.deepEqual(after.customFields,{});assert.equal(after.version,before.version+1);assert.equal(after.completedAt,before.completedAt);
    rejects(()=>f.schemas.save(project.id,schema,schema.version),409);
  }finally{f.close();}
});

test('pure imports validate incoming definitions and values, preserve archives and keep legacy defaults',()=>{
  const f=fixture();try{
    const schema=f.save([field('owner','user'),field('severity','select')]);const value=issue({owner:user.id,severity:'old'});
    const historical={...schema,issueTypes:schema.issueTypes.map(type=>type.id==='incident'?{...type,archived:true}:type),fields:schema.fields.map(definition=>definition.id==='severity'?{...definition,options:definition.options.map(option=>option.id==='old'?{...option,archived:true}:option)}:definition)};
    const original=structuredClone(value);const parsed=f.schemas.validateImport([historical],[project],[value],{users:[user]});assert.deepEqual(value,original);assert.equal(parsed[0].issueTypes[0].archived,true);
    rejects(()=>f.schemas.validateImport([historical],[project],[{...value,customFields:{owner:'missing'}}],{users:[user]}));
    rejects(()=>f.schemas.validateImport([historical],[project],[{...value,customFields:{unknown:null}}],{users:[user]}));
    rejects(()=>f.schemas.validateImport([],[project],[value],{users:[user]}));
    const legacy=f.schemas.validateImport([],[project],[issue({},'작업')],{legacy:true,users:[user]});assert.deepEqual(legacy[0],defaultIssueSchema(project.id,project.createdAt));assert.equal(legacy[0].issueTypes.length,9);
    rejects(()=>f.schemas.validateImport([],[project],[value],{legacy:true,users:[user]}));
    f.store.transaction(()=>f.schemas.replaceImported(parsed,new Map([[project.id,schema.version+5]])));assert.equal(f.schemas.get(project.id).version,schema.version+6);
    const data={issueSchemas:parsed};assert.equal(projectIssueTypes(data,project.id).length,1);assert.equal(projectIssueTypes(data,project.id,{includeArchived:true}).length,2);assert.equal(requiredFieldLabels(data,project.id)['custom:owner'],'owner');assert.deepEqual(requiredFieldLabels(data,project.id,['custom:owner','title']),['owner','제목']);assert.equal(fieldValueLabel(field('owner','user'),user.id,[user]),user.name);assert.equal(fieldValueLabel(field('checked','checkbox'),false),'아니요');
  }finally{f.close();}
});
