import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/app.js';
import { calculateFixedFollowUpSchedule } from '../../server/automatic-schedule.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { MAX_TEAM_FOLLOW_UP_RELATIONS } from '../../shared/types.js';
import { Store } from '../../server/store.js';
import { CalendarError, calculateWorkingDateRange, defaultCalendar, validateWorkCalendar, isWorkingDate, shiftWorkingDate,
  countWorkingDays, createCalendarMath, MAX_CALENDAR_DATE, MAX_WORKING_DURATION_DAYS, MIN_CALENDAR_DATE } from '../../shared/calendar.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';
import type { AutomaticSchedulePreview, Dependency, DependencyType, Issue, IssueRelation, ScheduleChange, TeamFollowUpScheduleInput, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

async function fixture(dir=mkdtempSync(join(tmpdir(),'donefac-calendar-')),createProject=true){
  const service=createApp({dataDir:dir}),server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}/api`;let closed=false;
  const request=async(path:string,method='GET',data?:unknown,headers:Record<string,string>={})=>{const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,data:await response.json() as any};};
  let projectId='';if(createProject){const response=await request('/projects','POST',{key:'CAL'+randomUUID().replaceAll('-','').slice(0,8).toUpperCase(),name:'달력·자동 일정 검증'});assert.equal(response.status,201);projectId=response.data.id;}
  return{dir,projectId,request,close:async()=>{if(closed)return;closed=true;service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));},remove:()=>rmSync(dir,{recursive:true,force:true})};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function makeIssue(f:Fixture,title:string,startDate:string|null,endDate:string|null,extra:Record<string,unknown>={}){const r=await f.request('/issues','POST',{projectId:f.projectId,title,startDate,endDate,...extra});assert.equal(r.status,201,JSON.stringify(r.data));return r.data as Issue;}
async function dep(f:Fixture,a:Issue,b:Issue,lagDays=0,type?:DependencyType){const r=await f.request('/dependencies','POST',{predecessorId:a.id,successorId:b.id,lagDays,...(type?{type}:{})});assert.equal(r.status,201);return r.data as Dependency;}
async function preview(f:Fixture,issueIds:string[],extra:Record<string,unknown>={}){const r=await f.request('/schedule/auto-preview','POST',{projectId:f.projectId,issueIds,...extra});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function getIssue(f:Fixture,id:string){return(await f.request('/workspace')).data.issues.find((i:Issue)=>i.id===id) as Issue;}
function editProposal(f:Fixture,id:string,update:(p:any)=>any){const store=new Store(f.dir);try{const value=store.get('automatic_schedule_previews',id);store.put('automatic_schedule_previews',update(value));}finally{store.db.close();}}

const teamReview = '/schedule/team-follow-up-preview';
const teamApply = '/schedule/team-follow-up-apply';
const teamResult = (id: string) => `/schedule/team-follow-up-result/${id}`;

async function blocks(f: Fixture, source: Issue, target: Issue): Promise<IssueRelation> {
  const result = await f.request(`/issues/${source.id}/relations`, 'POST', { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

async function handoffCalendar(f: Fixture, projectId: string, exceptions: WorkCalendar['exceptions']) {
  const path = `/projects/${projectId}/calendar`;
  const current = (await f.request(path)).data as WorkCalendar;
  const result = await f.request(path, 'PATCH', { ...current, expectedVersion: current.version, workingWeekdays: [1, 2, 3, 4, 5], exceptions });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data as WorkCalendar;
}

const scheduleState = async (f: Fixture) => (await f.request('/workspace')).data as WorkspaceSnapshot;

test('quick date completion counts project workdays and rejects apply after a calendar change', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const mondayOff = { date: '2026-11-23', isWorking: false, label: '월요일 휴무' };
  await handoffCalendar(f, f.projectId, [mondayOff]);
  const issue = await makeIssue(f, '근무일로 일정을 잡을 업무', null, null);
  const input = {
    changes: [{ id: issue.id, expectedVersion: issue.version, startDate: null, endDate: null }],
    fillMissingWorkdays: { startOnOrAfter: '2026-11-21', workingDays: 3 },
  };
  const manualPreview = (body: unknown = input) => f.request('/schedule/manual-preview', 'POST', body);
  const manualApply = (previewId: string) => f.request('/schedule/manual-apply', 'POST', { previewId });
  const dates = (result: { data: { changes: ScheduleChange[] } }) => result.data.changes.map(change => [change.toStart, change.toEnd]);
  const before = await manualPreview();
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.deepEqual(dates(before), [['2026-11-24', '2026-11-26']]);
  const backward = await manualPreview({ ...input, changes: [{ ...input.changes[0], endDate: '2026-11-23' }] });
  assert.deepEqual(dates(backward), [['2026-11-18', '2026-11-23']]);
  const explicit = await manualPreview({ ...input, changes: [{ ...input.changes[0], startDate: '2026-11-20', endDate: '2026-11-23' }] });
  assert.deepEqual(dates(explicit), [['2026-11-20', '2026-11-23']]);
  assert.equal((await manualPreview({ ...input, rescheduleSuccessors: true })).status, 400);
  assert.equal((await manualPreview({ ...input, fillMissingWorkdays: { ...input.fillMissingWorkdays, workingDays: 0 } })).status, 400);

  await handoffCalendar(f, f.projectId, [mondayOff, { date: '2026-11-21', isWorking: true, label: '토요일 근무' }]);
  assert.equal((await manualApply(before.data.previewId)).status, 409);
  assert.deepEqual(await getIssue(f, issue.id), issue);
  const refreshed = await manualPreview();
  assert.deepEqual(dates(refreshed), [['2026-11-21', '2026-11-25']]);
  const saved = await manualApply(refreshed.data.previewId);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await getIssue(f, issue.id)).endDate, '2026-11-25');
  assert.equal((await f.request('/schedule/undo', 'POST', { undoId: saved.data.undoId })).status, 200);
  assert.equal((await getIssue(f, issue.id)).startDate, null);
  assert.equal((await getIssue(f, issue.id)).endDate, null);
});

async function handoff(f: Fixture, relation: IssueRelation, anchorChange?: TeamFollowUpScheduleInput['anchorChange']): Promise<AutomaticSchedulePreview> {
  assert.ok(relation.version);
  const result = await f.request(teamReview, 'POST', { relationId: relation.id, expectedVersion: relation.version, anchorChange });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

test('cross-project handoff fences a mixed graph, uses each receiving calendar, and applies and undoes as one batch', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const secondProjectId = 'project-team', thirdProjectId = 'project-neo';
  const secondCalendar = await handoffCalendar(f, secondProjectId, [
    { date: '2026-11-21', isWorking: true, label: '둘째 프로젝트 토요일 근무' },
    { date: '2026-11-23', isWorking: false, label: '둘째 프로젝트 월요일 휴무' },
  ]);
  let thirdCalendar = await handoffCalendar(f, thirdProjectId, [
    { date: '2026-11-26', isWorking: false, label: '셋째 프로젝트 목요일 휴무' },
    { date: '2026-11-28', isWorking: true, label: '셋째 프로젝트 토요일 근무' },
  ]);
  const source = await makeIssue(f, '첫 프로젝트 고정 출발', '2026-11-19', '2026-11-20', { dueDate: '2026-11-24' });
  const target = await makeIssue(f, '둘째 프로젝트 변경 대상', '2026-11-16', '2026-11-17', { projectId: secondProjectId, dueDate: '2026-11-30' });
  const native = await makeIssue(f, '둘째 프로젝트 선후행 업무', '2026-11-16', '2026-11-16', { projectId: secondProjectId, dueDate: '2026-11-27' });
  const tail = await makeIssue(f, '셋째 프로젝트 간접 후행 업무', '2026-11-16', '2026-11-17', { projectId: thirdProjectId, dueDate: '2026-12-02' });
  const incoming = await makeIssue(f, '셋째 프로젝트 고정 선행 업무', '2026-11-27', '2026-11-27', { projectId: thirdProjectId });
  const stable = await makeIssue(f, '이미 충분히 늦은 열린 후행 업무', '2026-12-03', '2026-12-04', { projectId: thirdProjectId });
  const terminal = await makeIssue(f, '조건을 만족하는 완료 후행 업무', '2026-12-03', '2026-12-04', { projectId: thirdProjectId, status: 'done' });
  const relation = await blocks(f, source, target);
  const downstream = await blocks(f, native, tail);
  const local = await dep(f, target, native);
  await dep(f, incoming, tail);
  await dep(f, tail, stable);
  await dep(f, tail, terminal);

  const original = await scheduleState(f);
  const preview = await handoff(f, relation);
  assert.deepEqual(preview.blocking, []);
  assert.deepEqual(preview.teamFollowUp, { relationId: relation.id, expectedVersion: relation.version,
    sourceIssueId: source.id, targetIssueId: target.id, sourceEndDate: source.endDate,
    sourceSchedule: { version: source.version, startDate: source.startDate, endDate: source.endDate } });
  assert.equal(preview.calendarVersions?.[secondProjectId], secondCalendar.version);
  assert.equal(preview.calendarVersions?.[thirdProjectId], thirdCalendar.version);
  const expected = [[target.id, '2026-11-21', '2026-11-24'], [native.id, '2026-11-25', '2026-11-25'], [tail.id, '2026-11-28', '2026-11-30']];
  const planned = (proposal: AutomaticSchedulePreview) => proposal.changes.map(change => [change.id, change.toStart, change.toEnd]).sort();
  assert.deepEqual(planned(preview), [...expected].sort());
  assert.deepEqual(await scheduleState(f), original);
  assert.deepEqual(await f.request(teamResult(preview.previewId)), { status: 200, data: { applied: false } });
  for (const [path, method, body] of [[teamResult(preview.previewId), 'GET', undefined], [teamApply, 'POST', { previewId: preview.previewId }]] as const) {
    assert.equal((await f.request(path, method, body, { 'X-Actor-Id': 'user-seo' })).status, 409);
  }

  const relationPath = `/issues/${native.id}/relations/${downstream.id}`;
  const removed = await f.request(relationPath, 'PATCH', { expectedVersion: downstream.version, type: 'related', direction: 'outgoing' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const afterRelation = await scheduleState(f);
  assert.equal((await f.request(teamApply, 'POST', { previewId: preview.previewId })).status, 409);
  assert.deepEqual(await scheduleState(f), afterRelation);
  assert.deepEqual(await f.request(teamResult(preview.previewId)), { status: 200, data: { applied: false } });
  assert.equal((await f.request(relationPath, 'PATCH', { expectedVersion: removed.data.version, type: 'blocks', direction: 'outgoing' })).status, 200);

  const beforeCalendar = await handoff(f, relation);
  assert.deepEqual(planned(beforeCalendar), [...expected].sort());
  thirdCalendar = await handoffCalendar(f, thirdProjectId, [
    ...thirdCalendar.exceptions, { date: '2026-12-15', isWorking: false, label: '달력 버전 검증용 휴무' },
  ]);
  const afterCalendar = await scheduleState(f);
  assert.equal((await f.request(teamApply, 'POST', { previewId: beforeCalendar.previewId })).status, 409);
  assert.deepEqual(await scheduleState(f), afterCalendar);

  const rechecked = await handoff(f, relation);
  assert.notEqual(rechecked.previewId, beforeCalendar.previewId);
  assert.equal(rechecked.calendarVersions?.[thirdProjectId], thirdCalendar.version);
  assert.deepEqual(planned(rechecked), [...expected].sort());
  const applied = await f.request(teamApply, 'POST', { previewId: rechecked.previewId });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const updated = applied.data.updated as Issue[];
  assert.deepEqual(updated.map(issue => [issue.id, issue.startDate, issue.endDate]).sort(), [...expected].sort());
  const previous = new Map(original.issues.map(issue => [issue.id, issue]));
  for (const issue of updated) {
    assert.equal(issue.dueDate, previous.get(issue.id)?.dueDate);
    assert.equal(issue.version, previous.get(issue.id)!.version + 1);
  }
  const committed = await scheduleState(f);
  for (const reference of [source, incoming, stable, terminal]) assert.deepEqual(committed.issues.find(issue => issue.id === reference.id), reference);
  assert.deepEqual(await f.request(teamResult(rechecked.previewId)), applied);
  assert.deepEqual(await f.request(teamApply, 'POST', { previewId: rechecked.previewId }), applied);
  assert.deepEqual(await scheduleState(f), committed);

  const undo = await f.request('/schedule/undo', 'POST', { undoId: applied.data.undoId });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  const restored = await scheduleState(f);
  for (const reference of [target, native, tail]) {
    const value = restored.issues.find(issue => issue.id === reference.id)!;
    assert.deepEqual([value.startDate, value.endDate, value.dueDate, value.version],
      [reference.startDate, reference.endDate, reference.dueDate, reference.version + 2]);
  }
  assert.deepEqual(restored.dependencies.find(dependency => dependency.id === local.id), local);
  assert.deepEqual(restored.dependencies, original.dependencies);
});

test('cross-project handoff refuses to retime incomplete or terminal work and rejects a cycle with the fixed source', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const source = await makeIssue(f, '변경하지 않는 선행', '2026-11-19', '2026-11-20');
  const target = await makeIssue(f, '변경할 수 있는 대상', '2026-11-16', '2026-11-16', { projectId: 'project-team' });
  const partial = await makeIssue(f, '종료일이 없는 업무', '2026-11-16', null, { projectId: 'project-team' });
  const terminal = await makeIssue(f, '이미 완료된 업무', '2026-11-16', '2026-11-16', { projectId: 'project-team', status: 'done' });
  const relation = await blocks(f, source, target);
  await dep(f, target, partial);
  await dep(f, target, terminal);
  const original = await scheduleState(f);
  const blocked = await handoff(f, relation);
  assert.ok(blocked.blocking.some(item => item.includes(partial.key)));
  assert.ok(blocked.blocking.some(item => item.includes(terminal.key)));
  assert.ok(blocked.changes.every(change => change.id !== partial.id && change.id !== terminal.id && change.id !== source.id));
  assert.equal((await f.request(teamApply, 'POST', { previewId: blocked.previewId })).status, 422);
  assert.deepEqual(await scheduleState(f), original);

  await blocks(f, target, source);
  const beforeCycle = await scheduleState(f);
  const cycle = await handoff(f, relation);
  assert.ok(cycle.blocking.some(item => item.includes('순환')));
  assert.equal((await f.request(teamApply, 'POST', { previewId: cycle.previewId })).status, 422);
  assert.deepEqual(await scheduleState(f), beforeCycle);
});

test('selected handoff roots use their receiving calendars, merge shared successors once, and commit and undo as one batch', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const secondId = 'project-team', thirdId = 'project-neo';
  await handoffCalendar(f, secondId, [{ date: '2026-11-21', isWorking: true, label: '둘째 프로젝트 토요일 근무' }]);
  await handoffCalendar(f, thirdId, [{ date: '2026-11-23', isWorking: false, label: '셋째 프로젝트 월요일 휴무' }]);
  const source = await makeIssue(f, '여러 인계의 공통 원인', '2026-11-20', '2026-11-20');
  const second = await makeIssue(f, '선택한 둘째 프로젝트 인계', '2026-11-16', '2026-11-16', { projectId: secondId });
  const third = await makeIssue(f, '선택한 셋째 프로젝트 인계', '2026-11-16', '2026-11-16', { projectId: thirdId });
  const merged = await makeIssue(f, '두 인계가 합쳐지는 업무', '2026-11-16', '2026-11-16', { projectId: thirdId });
  const untouched = await makeIssue(f, '선택하지 않은 인계', '2026-11-16', '2026-11-16', { projectId: secondId });
  const secondRelation = await blocks(f, source, second);
  const thirdRelation = await blocks(f, source, third);
  const otherSource = await blocks(f, second, merged);
  await blocks(f, source, untouched);
  await dep(f, third, merged);
  const reference = (relation: IssueRelation) => ({ relationId: relation.id, expectedVersion: relation.version });
  const selected = { relations: [reference(thirdRelation), reference(secondRelation)] };
  const preview = async () => {
    const response = await f.request(teamReview, 'POST', selected);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data as AutomaticSchedulePreview;
  };
  for (const input of [
    { relations: [] }, { relations: 'invalid' }, { relations: [null] },
    { relations: [reference(secondRelation), reference(secondRelation)] },
    { relations: [reference(secondRelation), reference(otherSource)] },
    { relations: [{ ...reference(secondRelation), targetIssueId: merged.id }] },
    { ...reference(secondRelation), ...selected },
    { relations: Array.from({ length: MAX_TEAM_FOLLOW_UP_RELATIONS + 1 }, () => ({ relationId: randomUUID(), expectedVersion: 1 })) },
  ]) {
    const invalid = await f.request(teamReview, 'POST', input);
    assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
  }
  const wrongVersion = await f.request(teamReview, 'POST', { relations: [selected.relations[0],
    { ...selected.relations[1], expectedVersion: secondRelation.version! + 1 }] });
  assert.equal(wrongVersion.status, 409, JSON.stringify(wrongVersion.data));

  const initial = await scheduleState(f);
  const single = await handoff(f, thirdRelation);
  assert.ok(!single.changes.some(change => change.id === second.id));
  const reviewed = await preview();
  const expected = new Map([[second.id, '2026-11-21'], [third.id, '2026-11-24'], [merged.id, '2026-11-25']]);
  assert.deepEqual(reviewed.blocking, []);
  assert.deepEqual(reviewed.teamFollowUp, { ...reference(thirdRelation), sourceIssueId: source.id, targetIssueId: third.id,
    sourceEndDate: source.endDate, sourceSchedule: { version: source.version, startDate: source.startDate, endDate: source.endDate },
    relations: [{ ...reference(thirdRelation), targetIssueId: third.id }, { ...reference(secondRelation), targetIssueId: second.id }],
  });
  assert.equal(reviewed.changes.length, expected.size);
  assert.deepEqual(new Map(reviewed.changes.map(change => [change.id, change.toStart])), expected);
  assert.ok(reviewed.changes.every(change => change.toEnd === change.toStart));
  assert.deepEqual(await scheduleState(f), initial);

  await handoffCalendar(f, thirdId, [
    { date: '2026-11-23', isWorking: false, label: '셋째 프로젝트 월요일 휴무' },
    { date: '2026-12-01', isWorking: false, label: '변경된 달력 확인' },
  ]);
  const beforeApply = await scheduleState(f);
  assert.equal((await f.request(teamApply, 'POST', { previewId: reviewed.previewId })).status, 409);
  assert.deepEqual(await scheduleState(f), beforeApply);

  const fresh = await preview();
  const body = { previewId: fresh.previewId };
  const applied = await f.request(teamApply, 'POST', body);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const updated = applied.data.updated as Issue[];
  assert.equal(updated.length, expected.size);
  assert.deepEqual(new Map(updated.map(issue => [issue.id, issue.startDate])), expected);
  assert.deepEqual(await f.request(teamResult(fresh.previewId)), applied);
  assert.deepEqual(await f.request(teamApply, 'POST', body), applied);
  for (const unchanged of [source, untouched]) assert.deepEqual(await getIssue(f, unchanged.id), unchanged);
  assert.equal((await f.request('/schedule/undo', 'POST', { undoId: applied.data.undoId })).status, 200);
  for (const previous of [second, third, merged]) {
    const restored = await getIssue(f, previous.id);
    assert.deepEqual([restored.startDate, restored.endDate, restored.version], [previous.startDate, previous.endDate, previous.version + 2]);
  }
});

test('a proposed source change traverses all native branches and commits and restores every project together', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const secondId = 'project-team', thirdId = 'project-neo';
  const sourceCalendar = await handoffCalendar(f, f.projectId, [{ date: '2026-11-23', isWorking: false, label: '선행 프로젝트 휴무' }]);
  const secondCalendar = await handoffCalendar(f, secondId, [
    { date: '2026-11-26', isWorking: false, label: '후행 프로젝트 휴무' },
    { date: '2026-11-28', isWorking: true, label: '후행 프로젝트 토요일 근무' },
  ]);
  const fixed = await makeIssue(f, '원인 업무의 고정 선행', '2026-11-20', '2026-11-20');
  const source = await makeIssue(f, '원인 업무 날짜 변경', '2026-11-24', '2026-11-24', { dueDate: '2026-11-24' });
  const target = await makeIssue(f, '선택한 후행 업무', '2026-11-16', '2026-11-17', { projectId: secondId });
  const branch = await makeIssue(f, '다른 프로젝트의 갈래', '2026-11-16', '2026-11-16', { projectId: thirdId });
  const merge = await makeIssue(f, '합쳐진 후행 업무', '2026-11-16', '2026-11-17', { projectId: thirdId });
  const local = await makeIssue(f, '원인과 같은 프로젝트의 갈래', '2026-11-16', '2026-11-16');
  const relation = await blocks(f, source, target);
  await blocks(f, source, branch);
  await blocks(f, target, merge);
  await dep(f, fixed, source);
  await dep(f, branch, merge);
  const anchorChange = { id: source.id, expectedVersion: source.version, startDate: '2026-11-24', endDate: '2026-11-25' };

  const beforeLocal = await handoff(f, relation, anchorChange);
  assert.ok(!beforeLocal.changes.some(change => change.id === local.id));
  await dep(f, source, local);
  const withLocal = await scheduleState(f);
  const staleTopology = await f.request(teamApply, 'POST', { previewId: beforeLocal.previewId });
  assert.equal(staleTopology.status, 409, JSON.stringify(staleTopology.data));
  assert.deepEqual(await scheduleState(f), withLocal);

  const beforeFixedEdit = await handoff(f, relation, anchorChange);
  assert.deepEqual(beforeFixedEdit.blocking, []);
  const edited = await f.request(`/issues/${fixed.id}`, 'PATCH', { expectedVersion: fixed.version, title: '고정 선행 수정' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const current = await scheduleState(f);
  assert.equal((await f.request(teamApply, 'POST', { previewId: beforeFixedEdit.previewId })).status, 409);
  assert.deepEqual(await scheduleState(f), current);

  const preview = await handoff(f, relation, anchorChange);
  assert.deepEqual(preview.blocking, []);
  assert.deepEqual(preview.teamFollowUp, { relationId: relation.id, expectedVersion: relation.version, anchorChange,
    sourceIssueId: source.id, targetIssueId: target.id, sourceEndDate: anchorChange.endDate,
    sourceSchedule: { version: source.version, startDate: source.startDate, endDate: source.endDate } });
  assert.equal(preview.calendarVersions?.[f.projectId], sourceCalendar.version);
  assert.equal(preview.calendarVersions?.[secondId], secondCalendar.version);
  const expected = new Map([
    [source.id, ['2026-11-24', '2026-11-25']], [target.id, ['2026-11-27', '2026-11-28']],
    [branch.id, ['2026-11-26', '2026-11-26']], [merge.id, ['2026-11-30', '2026-12-01']],
    [local.id, ['2026-11-26', '2026-11-26']],
  ]);
  assert.equal(preview.changes[0]?.id, source.id);
  assert.deepEqual(new Map(preview.changes.map(change => [change.id, [change.toStart, change.toEnd]])), expected);
  assert.ok(preview.warnings.some(warning => warning.includes(source.key) && warning.includes('목표 마감일')));
  assert.deepEqual(await scheduleState(f), current);

  const store = new Store(f.dir);
  try {
    store.db.exec(`CREATE TRIGGER fail_team_anchor_tail BEFORE UPDATE ON issues
      WHEN json_extract(NEW.json,'$.title')='합쳐진 후행 업무'
      BEGIN SELECT RAISE(ABORT,'synthetic cross-project anchor tail write failure'); END`);
    const refused = await f.request(teamApply, 'POST', { previewId: preview.previewId });
    assert.equal(refused.status, 500);
    assert.deepEqual(await scheduleState(f), current);
    assert.deepEqual(await f.request(teamResult(preview.previewId)), { status: 200, data: { applied: false } });
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    store.db.exec('DROP TRIGGER fail_team_anchor_tail');
  } finally { store.db.close(); }

  const applied = await f.request(teamApply, 'POST', { previewId: preview.previewId });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const updated = applied.data.updated as Issue[];
  assert.deepEqual(new Map(updated.map(issue => [issue.id, [issue.startDate, issue.endDate]])), expected);
  assert.deepEqual(await f.request(teamResult(preview.previewId)), applied);
  assert.deepEqual(await f.request(teamApply, 'POST', { previewId: preview.previewId }), applied);
  const undo = await f.request('/schedule/undo', 'POST', { undoId: applied.data.undoId });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  const restored = await scheduleState(f);
  for (const previous of current.issues.filter(issue => expected.has(issue.id))) {
    const issue = restored.issues.find(value => value.id === previous.id)!;
    assert.deepEqual([issue.startDate, issue.endDate, issue.dueDate, issue.version],
      [previous.startDate, previous.endDate, previous.dueDate, previous.version + 2]);
  }
  assert.deepEqual(restored.dependencies, current.dependencies);
});

test('a proposed source change fences its version and blocks invalid anchors and fixed or cyclic successors', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const fixed = await makeIssue(f, '고정 선행', '2026-11-20', '2026-11-20');
  const source = await makeIssue(f, '날짜 변경 원인 업무', '2026-11-23', '2026-11-24');
  const target = await makeIssue(f, '차단 대상', '2026-11-16', '2026-11-16', { projectId: 'project-team' });
  const relation = await blocks(f, source, target);
  await dep(f, fixed, source);
  const anchorChange = { id: source.id, expectedVersion: source.version, startDate: '2026-11-24', endDate: '2026-11-25' };
  const input = { relationId: relation.id, expectedVersion: relation.version };
  for (const invalid of [{ ...anchorChange, id: target.id }, { ...anchorChange, endDate: '2026-11-31' }]) {
    const result = await f.request(teamReview, 'POST', { ...input, anchorChange: invalid });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
  const initial = await scheduleState(f);
  for (const invalid of [{ ...anchorChange, startDate: '2026-11-20' }, { ...anchorChange, endDate: null }, { ...anchorChange, endDate: '2026-11-23' }]) {
    const preview = await handoff(f, relation, invalid);
    assert.ok(preview.blocking.some(item => item.includes(source.key)), JSON.stringify(preview));
    assert.equal((await f.request(teamApply, 'POST', { previewId: preview.previewId })).status, 422);
    assert.deepEqual(await scheduleState(f), initial);
  }

  const proposal = await handoff(f, relation, anchorChange);
  assert.deepEqual(proposal.blocking, []);
  const saved = await f.request(`/issues/${source.id}`, 'PATCH', { expectedVersion: source.version, endDate: '2026-11-26' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const { version: currentVersion, startDate, endDate } = saved.data as Issue;
  const beforeStale = await scheduleState(f);
  for (const stale of [await f.request(teamReview, 'POST', { ...input, anchorChange }),
    await f.request(teamApply, 'POST', { previewId: proposal.previewId })]) {
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.deepEqual(stale.data.details, { reason: 'stale_team_follow_up_source', currentVersion, startDate, endDate });
  }
  assert.deepEqual(await scheduleState(f), beforeStale);

  const terminal = await makeIssue(f, '고정된 완료 후행', '2026-11-16', '2026-11-16', { projectId: 'project-team', status: 'done' });
  await dep(f, target, terminal);
  const fresh = { ...anchorChange, expectedVersion: currentVersion };
  const withTerminal = await scheduleState(f);
  const terminalPreview = await handoff(f, relation, fresh);
  assert.ok(terminalPreview.blocking.some(item => item.includes(terminal.key) && item.includes('고정 일정')));
  assert.equal((await f.request(teamApply, 'POST', { previewId: terminalPreview.previewId })).status, 422);
  assert.deepEqual(await scheduleState(f), withTerminal);

  await blocks(f, target, source);
  const withCycle = await scheduleState(f);
  const cycle = await handoff(f, relation, fresh);
  assert.ok(cycle.blocking.some(item => item.includes('순환')));
  assert.equal((await f.request(teamApply, 'POST', { previewId: cycle.previewId })).status, 422);
  assert.deepEqual(await scheduleState(f), withCycle);
});

test('working-calendar math honors exceptions, working weekends and full four-digit ISO bounds without day scans',()=>{
  const c=defaultCalendar('p');assert.equal(countWorkingDays(c,'2026-11-16','2026-11-20'),5);assert.equal(shiftWorkingDate('2026-11-20',1,c),'2026-11-23');
  const custom=validateWorkCalendar({...c,exceptions:[{date:'2026-11-23',isWorking:false,label:'팀 휴무'},{date:'2026-11-21',isWorking:true,label:'토요일 작업'}]});assert.equal(isWorkingDate(custom,'2026-11-21'),true);assert.equal(isWorkingDate('2026-11-23',custom),false);assert.equal(shiftWorkingDate(custom,'2026-11-20',1),'2026-11-21');assert.equal(shiftWorkingDate('2026-11-20',2,custom),'2026-11-24');assert.equal(shiftWorkingDate('2026-11-24',-2,custom),'2026-11-20');assert.equal(countWorkingDays('2026-11-20','2026-11-24',custom),3);
  assert.throws(()=>validateWorkCalendar({...c,workingWeekdays:[]}),CalendarError);assert.throws(()=>validateWorkCalendar({...c,workingWeekdays:[1,1]}),CalendarError);assert.throws(()=>validateWorkCalendar({...c,exceptions:[{date:'2026-02-30',isWorking:false,label:''}]}),CalendarError);assert.throws(()=>validateWorkCalendar({...c,exceptions:[{date:'2026-11-20',isWorking:false,label:''},{date:'2026-11-20',isWorking:true,label:''}]}),CalendarError);
  const math=createCalendarMath(c),all=math.count('0000-01-01','9999-12-31');assert.ok(all>2000000&&all<3660000);assert.equal(math.shift('0000-01-01',all),'9999-12-31');assert.equal(math.shift('9999-12-31',-(all-1)),'0000-01-03');assert.equal(math.count('2000-02-28','2000-03-01'),3);assert.throws(()=>math.shift('0000-01-01',-1),CalendarError);assert.throws(()=>math.shift('9999-12-31',1),CalendarError);
});

test('a working-day range counts working anchors and preserves nonworking anchors in either direction', () => {
  const math = createCalendarMath({ ...defaultCalendar('p'), exceptions: [
    { date: '2026-11-21', isWorking: true, label: '토요일 근무' },
    { date: '2026-11-23', isWorking: false, label: '월요일 휴무' },
  ] });
  const cases = [
    ['startDate', '2026-11-20', 3, '2026-11-20', '2026-11-24'],
    ['endDate', '2026-11-24', 3, '2026-11-20', '2026-11-24'],
    ['startDate', '2026-11-23', 1, '2026-11-23', '2026-11-24'],
    ['endDate', '2026-11-23', 2, '2026-11-20', '2026-11-23'],
    ['startDate', '2026-11-21', 1, '2026-11-21', '2026-11-21'],
    ['endDate', '2026-11-21', 1, '2026-11-21', '2026-11-21'],
  ] as const;
  for (const [anchor, date, duration, startDate, endDate] of cases) {
    assert.deepEqual(calculateWorkingDateRange(math, anchor, date, duration), { startDate, endDate });
    assert.equal(math.count(startDate, endDate), duration);
  }
  const longest = calculateWorkingDateRange(math, 'startDate', '2026-11-23', MAX_WORKING_DURATION_DAYS);
  assert.equal(math.count(longest.startDate, longest.endDate), MAX_WORKING_DURATION_DAYS);
  for (const duration of [0, -1, NaN, 1.5, MAX_WORKING_DURATION_DAYS + 1]) {
    assert.throws(() => calculateWorkingDateRange(math, 'startDate', '2026-11-23', duration), CalendarError);
  }
  assert.throws(() => calculateWorkingDateRange(math, 'startDate', '2026-02-30', 2), CalendarError);
  assert.throws(() => calculateWorkingDateRange(math, 'endDate', MIN_CALENDAR_DATE, 2), CalendarError);
  assert.throws(() => calculateWorkingDateRange(math, 'startDate', MAX_CALENDAR_DATE, 2), CalendarError);
});

test('calendar CAS guards manual workday previews; native backup preserves custom calendars and old formats receive defaults',async()=>{
  const f=await fixture(),target=await fixture();try{
    const path=`/projects/${f.projectId}/calendar`,initial=(await f.request(path)).data;assert.deepEqual(initial.workingWeekdays,[1,2,3,4,5]);
    const saved=await f.request(path,'PATCH',{expectedVersion:1,name:'우리 팀 달력',workingWeekdays:[1,2,3,4,5],exceptions:[{date:'2026-11-21',isWorking:true,label:'토요일 작업'},{date:'2026-11-23',isWorking:false,label:'휴무'}]});assert.equal(saved.status,200);assert.equal(saved.data.version,2);assert.equal((await f.request(path,'PATCH',{expectedVersion:1,name:'이전 버전'})).status,409);assert.equal((await f.request(path,'PATCH',{expectedVersion:2,workingWeekdays:[]})).status,400);
    const a=await makeIssue(f,'수동 달력 이동','2026-11-20','2026-11-20');const p=(await f.request('/schedule/preview','POST',{issueIds:[a.id],days:1,workingDays:true})).data;assert.equal(p.changes[0].toStart,'2026-11-21');assert.equal(p.calendarVersions[f.projectId],2);
    assert.equal((await f.request(path,'PATCH',{expectedVersion:2,exceptions:[]})).status,200);const changes=p.changes.map((c:any)=>({id:c.id,expectedVersion:c.version,startDate:c.toStart,endDate:c.toEnd}));assert.equal((await f.request('/schedule/apply','POST',{changes,calendarVersions:p.calendarVersions})).status,409);assert.equal((await getIssue(f,a.id)).startDate,a.startDate);
    const latest=(await f.request('/schedule/preview','POST',{issueIds:[a.id],days:1,workingDays:true})).data;assert.equal(latest.changes[0].toStart,'2026-11-23');const result=await f.request('/schedule/apply','POST',{changes:latest.changes.map((c:any)=>({id:c.id,expectedVersion:c.version,startDate:c.toStart,endDate:c.toEnd})),calendarVersions:latest.calendarVersions});assert.equal(result.status,200);assert.equal((await f.request('/schedule/undo','POST',{undoId:result.data.undoId})).status,200);assert.equal((await getIssue(f,a.id)).startDate,a.startDate);
    const current=(await f.request(path)).data;assert.equal((await f.request(path,'PATCH',{expectedVersion:current.version,workingWeekdays:[0,1,2,3,4],exceptions:[{date:'2026-11-20',isWorking:false,label:'배포 휴무'}]})).status,200);
    const exported=(await f.request('/export')).data;assert.equal(exported.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);assert.equal((await target.request('/import','POST',{data:exported})).status,200);assert.deepEqual((await target.request(path)).data.workingWeekdays,[0,1,2,3,4]);assert.equal((await target.request(path)).data.exceptions[0].label,'배포 휴무');
    const missing=structuredClone(exported);missing.calendars=missing.calendars.filter((c:any)=>c.projectId!==f.projectId);assert.equal((await target.request('/import','POST',{data:missing})).status,400);assert.deepEqual((await target.request(path)).data.workingWeekdays,[0,1,2,3,4]);
    for(const schemaVersion of[1,2,3,4]){const legacy={...exported,schemaVersion,issueChangeHistory:[]};assert.equal((await target.request('/import','POST',{data:legacy})).status,200);const calendar=(await target.request(path)).data;assert.deepEqual(calendar.workingWeekdays,[1,2,3,4,5]);assert.deepEqual(calendar.exceptions,[]);}
  }finally{for(const x of[f,target]){await x.close();x.remove();}}
});

test('automatic diamond FS scheduling preserves working durations, persists guarded proposals, retries idempotently and undoes atomically',async()=>{
  const f=await fixture();let reopened:Fixture|undefined;try{
    const calPath=`/projects/${f.projectId}/calendar`;assert.equal((await f.request(calPath,'PATCH',{expectedVersion:1,exceptions:[{date:'2026-11-21',isWorking:true,label:'토요일 작업'},{date:'2026-11-23',isWorking:false,label:'휴무'}]})).status,200);
    const a=await makeIssue(f,'A','2026-11-19','2026-11-20'),b=await makeIssue(f,'B','2026-11-19','2026-11-20'),c=await makeIssue(f,'C','2026-11-20','2026-11-20'),d=await makeIssue(f,'D','2026-11-16','2026-11-16');await dep(f,a,b);await dep(f,a,c,1);await dep(f,b,d);await dep(f,c,d);
    const p=await preview(f,[a.id],{anchorDate:'2030-01-01'});assert.deepEqual(p.blocking,[]);assert.equal(p.calendarVersions[f.projectId],2);const byId=new Map(p.changes.map((change:any)=>[change.id,change] as const));assert.ok(!byId.has(a.id));assert.equal((byId.get(b.id) as any).toStart,'2026-11-21');assert.equal((byId.get(b.id) as any).toEnd,'2026-11-24');assert.equal((byId.get(c.id) as any).toStart,'2026-11-24');assert.equal((byId.get(d.id) as any).toStart,'2026-11-25');
    assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:p.previewId},{'X-Actor-Id':'user-seo'})).status,409);const applied=await f.request('/schedule/auto-apply','POST',{previewId:p.previewId});assert.equal(applied.status,200);assert.equal(applied.data.updated.length,3);assert.ok(applied.data.updated.every((issue:Issue)=>issue.status==='todo'));assert.deepEqual((await f.request('/schedule/auto-apply','POST',{previewId:p.previewId})).data,applied.data);
    await f.close();reopened=await fixture(f.dir,false);assert.deepEqual((await reopened.request('/schedule/auto-apply','POST',{previewId:p.previewId})).data,applied.data);assert.equal((await reopened.request('/schedule/undo','POST',{undoId:applied.data.undoId})).status,200);assert.equal((await getIssue(reopened,b.id)).startDate,b.startDate);assert.equal((await getIssue(reopened,d.id)).endDate,d.endDate);
  }finally{if(reopened)await reopened.close();await f.close();f.remove();}
});

test('automatic scheduling treats missing/partial dates and negative lags explicitly, preserves terminal anchors and supports explicit seeds',async()=>{
  const f=await fixture();try{
    const unchanged=await makeIssue(f,'주말 종료 유지','2026-11-16','2026-11-22');assert.equal((await preview(f,[unchanged.id])).changes.length,0);
    const rolled=await makeIssue(f,'주말 시작','2026-11-21','2026-11-29');const rolledPreview=await preview(f,[rolled.id]);assert.equal(rolledPreview.changes[0].toStart,'2026-11-23');assert.equal(rolledPreview.changes[0].toEnd,'2026-11-29');assert.equal(countWorkingDays('2026-11-21','2026-11-29',defaultCalendar('p')),countWorkingDays(rolledPreview.changes[0].toStart,rolledPreview.changes[0].toEnd,defaultCalendar('p')));
    const undated=await makeIssue(f,'기간 미정',null,null,{estimate:99});assert.ok((await preview(f,[undated.id])).blocking.length);assert.ok((await preview(f,[undated.id],{defaultDuration:2})).blocking.length);const explicit=await preview(f,[undated.id,unchanged.id],{defaultDuration:3,anchorDate:'2026-11-22'});assert.deepEqual(explicit.blocking,[]);assert.equal(explicit.changes.length,1);assert.equal(explicit.changes[0].toStart,'2026-11-23');assert.equal(explicit.changes[0].toEnd,'2026-11-25');
    const partial=await makeIssue(f,'부분 일정','2026-11-16',null);assert.ok((await preview(f,[partial.id],{defaultDuration:3,anchorDate:'2026-11-16'})).blocking.length);
    const unknown=await makeIssue(f,'선행 미정',null,null),child=await makeIssue(f,'후속','2026-11-16','2026-11-17');await dep(f,unknown,child);const blocked=await preview(f,[child.id],{anchorDate:'2026-11-16',defaultDuration:3});assert.ok(blocked.blocking.some((message:string)=>message.includes(unknown.key)));assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:blocked.previewId})).status,422);
    const fixed=await makeIssue(f,'선행 종료만 확인',null,'2026-11-20'),next=await makeIssue(f,'고정 선행 후속','2026-11-16','2026-11-17');await dep(f,fixed,next);const fromFixed=await preview(f,[next.id]);assert.deepEqual(fromFixed.blocking,[]);assert.equal(fromFixed.changes[0].toStart,'2026-11-23');
    const terminal=await makeIssue(f,'완료 고정','2026-11-16','2026-11-17',{status:'done'});await dep(f,fixed,terminal);const terminalPreview=await preview(f,[terminal.id]);assert.ok(terminalPreview.blocking.some((message:string)=>message.includes('고정')));assert.equal(terminalPreview.changes.length,0);assert.equal((await getIssue(f,terminal.id)).startDate,terminal.startDate);
    const cancelled=await makeIssue(f,'취소 고정','2026-11-23','2026-11-24',{status:'cancelled'});const terminalSeed=await preview(f,[cancelled.id],{seedChanges:[{id:cancelled.id,expectedVersion:cancelled.version,startDate:'2026-11-24',endDate:'2026-11-25'}]});assert.ok(terminalSeed.blocking.length);assert.equal(terminalSeed.changes.length,0);
    const seed=await makeIssue(f,'초기 변경','2026-11-16','2026-11-17'),successor=await makeIssue(f,'초기 변경 후속','2026-11-16','2026-11-17');await dep(f,seed,successor);const seeded=await preview(f,[seed.id],{seedChanges:[{id:seed.id,expectedVersion:seed.version,startDate:'2026-11-18',endDate:'2026-11-19'}]});assert.equal(seeded.changes.find((change:any)=>change.id===seed.id).toStart,'2026-11-18');assert.equal(seeded.changes.find((change:any)=>change.id===successor.id).toStart,'2026-11-20');const earlier=await preview(f,[seed.id],{seedChanges:[{id:seed.id,expectedVersion:seed.version,startDate:'2026-11-12',endDate:'2026-11-13'}]});assert.equal(earlier.changes.length,1);assert.equal(earlier.changes[0].id,seed.id);
    assert.equal((await f.request('/schedule/auto-preview','POST',{projectId:f.projectId,issueIds:[seed.id],seedChanges:[{id:seed.id,expectedVersion:999,startDate:'2026-11-18',endDate:'2026-11-19'}]})).status,409);
    const negative=await makeIssue(f,'음수 연결','2026-11-16','2026-11-17');await dep(f,fixed,negative,-1);
    const overlap=await preview(f,[negative.id]);assert.deepEqual(overlap.blocking,[]);assert.equal(overlap.changes[0].toStart,'2026-11-20');assert.equal(overlap.changes[0].toEnd,'2026-11-23');
  }finally{await f.close();f.remove();}
});

test('a fixed anchor keeps the entered dates and commits all reachable schedules in one recoverable undo', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const anchor = await makeIssue(f, '기준 업무', '2026-11-16', '2026-11-17');
  const first = await makeIssue(f, '직접 후행', '2026-11-18', '2026-11-19');
  const second = await makeIssue(f, '간접 후행', '2026-11-20', '2026-11-20');
  const unrelated = await makeIssue(f, '독립 업무', null, null);
  await dep(f, anchor, first);
  await dep(f, first, second, 1, 'SS');

  const request = { projectId: f.projectId, anchorChange: {
    id: anchor.id, expectedVersion: anchor.version, startDate: null, endDate: '2026-11-21',
  } };
  const preview = await f.request('/schedule/auto-preview', 'POST', request);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const proposal = preview.data as AutomaticSchedulePreview;
  assert.deepEqual(proposal.blocking, []);
  const dates = (issue: Issue) => [issue.startDate, issue.endDate];
  const expected = [[null, '2026-11-21'], ['2026-11-23', '2026-11-24'], ['2026-11-24', '2026-11-24']];
  assert.deepEqual(proposal.changes.map(change => [change.id, change.toStart, change.toEnd]),
    [anchor, first, second].map((issue, index) => [issue.id, ...expected[index]]));
  assert.deepEqual(await Promise.all([anchor, first, second, unrelated].map(issue => getIssue(f, issue.id))), [anchor, first, second, unrelated]);

  const resultPath = `/schedule/auto-result/${proposal.previewId}`;
  assert.deepEqual(await f.request(resultPath), { status: 200, data: { applied: false } });
  assert.equal((await f.request(resultPath, 'GET', undefined, { 'X-Actor-Id': 'user-seo' })).status, 409);
  const applied = await f.request('/schedule/auto-apply', 'POST', { previewId: proposal.previewId });
  assert.equal(applied.status, 200);
  assert.deepEqual(await f.request(resultPath), applied);
  assert.deepEqual(await f.request('/schedule/auto-apply', 'POST', { previewId: proposal.previewId }), applied);
  const saved = await Promise.all([anchor, first, second].map(issue => getIssue(f, issue.id)));
  assert.deepEqual(saved.map(dates), expected);
  assert.deepEqual(saved.map(issue => issue.version), [anchor, first, second].map(item => item.version + 1));
  assert.deepEqual(await getIssue(f, unrelated.id), unrelated);

  const undo = await f.request('/schedule/undo', 'POST', { undoId: applied.data.undoId });
  assert.equal(undo.status, 200);
  assert.equal(undo.data.updated.length, 3);
  assert.deepEqual((await Promise.all([anchor, first, second].map(issue => getIssue(f, issue.id)))).map(dates), [anchor, first, second].map(dates));
});

test('pinned anchor conflicts and edits to a hidden successor cannot partially apply schedules', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const predecessor = await makeIssue(f, '보존할 선행', '2026-11-16', '2026-11-17');
  const anchor = await makeIssue(f, '고정 입력', '2026-11-18', '2026-11-18');
  const successor = await makeIssue(f, '연결된 후행', '2026-11-19', '2026-11-20');
  await dep(f, predecessor, anchor);
  await dep(f, anchor, successor);
  const anchored = { projectId: f.projectId, anchorChange: {
    id: anchor.id, expectedVersion: anchor.version, startDate: '2026-11-17', endDate: '2026-11-20',
  } };
  const conflict = await f.request('/schedule/auto-preview', 'POST', anchored);
  assert.equal(conflict.status, 200);
  const blocked = conflict.data as AutomaticSchedulePreview;
  assert.ok(blocked.blocking.some(message => message.includes('입력한 시작일 2026-11-17')));
  assert.ok(blocked.blocking.some(message => message.startsWith(successor.key)));
  assert.deepEqual(blocked.changes, []);
  assert.equal((await f.request('/schedule/auto-apply', 'POST', { previewId: blocked.previewId })).status, 422);
  assert.equal((await f.request('/schedule/auto-preview', 'POST', { ...anchored, issueIds: [anchor.id] })).status, 400);

  anchored.anchorChange.startDate = '2026-11-18';
  const ready = await f.request('/schedule/auto-preview', 'POST', anchored);
  assert.equal(ready.status, 200);
  assert.equal(ready.data.changes.length, 2);
  const edited = await f.request(`/issues/${successor.id}`, 'PATCH', { expectedVersion: successor.version, description: '다른 편집' });
  assert.equal(edited.status, 200);
  assert.equal((await f.request('/schedule/auto-apply', 'POST', { previewId: ready.data.previewId })).status, 409);
  assert.deepEqual(await f.request(`/schedule/auto-result/${ready.data.previewId}`), { status: 200, data: { applied: false } });
  assert.deepEqual(await getIssue(f, anchor.id), anchor);
  assert.deepEqual(await getIssue(f, successor.id), edited.data);
});

test('fixed date batches calculate shared successors once and preserve entered and already sufficient dates', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); f.remove(); });
  const first = await makeIssue(f, '첫 번째 기준 업무', '2026-11-19', '2026-11-19');
  const second = await makeIssue(f, '두 번째 기준 업무', '2026-11-20', '2026-11-20');
  const shared = await makeIssue(f, '두 업무의 공통 후행', '2026-11-20', '2026-11-23');
  const indirect = await makeIssue(f, '간접 후행', '2026-11-23', '2026-11-23');
  const sufficient = await makeIssue(f, '조건을 만족하는 후행', '2026-11-28', '2026-11-30');
  const unrelated = await makeIssue(f, '일정 미정인 별도 업무', null, null);
  const dependencies = [await dep(f, first, second), await dep(f, first, shared), await dep(f, second, shared, 1),
    await dep(f, shared, indirect, 2, 'SS'), await dep(f, second, sufficient, 0, 'FF')];
  const context = { issues: [first, second, shared, indirect, sufficient, unrelated], dependencies,
    calendar: defaultCalendar(f.projectId), workflow: defaultWorkflow(f.projectId) };
  const anchors = [
    { id: first.id, expectedVersion: first.version, startDate: first.startDate, endDate: '2026-11-20' },
    { id: second.id, expectedVersion: second.version, startDate: '2026-11-23', endDate: '2026-11-23' },
  ];

  const proposal = calculateFixedFollowUpSchedule({ ...context, anchors });
  assert.deepEqual(proposal.blocking, []);
  assert.deepEqual(proposal.warnings, []);
  assert.deepEqual(proposal.issueIds, [first.id, second.id, shared.id, indirect.id, sufficient.id].sort());
  assert.deepEqual(proposal.changes.map(change => [change.id, change.toStart, change.toEnd]), [
    [first.id, '2026-11-19', '2026-11-20'],
    [second.id, '2026-11-23', '2026-11-23'],
    [shared.id, '2026-11-25', '2026-11-26'],
    [indirect.id, '2026-11-27', '2026-11-27'],
  ]);

  const conflicting = calculateFixedFollowUpSchedule({ ...context,
    anchors: [anchors[0], { ...anchors[1], startDate: '2026-11-20', endDate: '2026-11-20' }] });
  assert.ok(conflicting.blocking.some(message => message.startsWith(`${second.key}: 입력한 시작일 2026-11-20`)));
  assert.ok(conflicting.blocking.some(message => message.startsWith(`${shared.key}: ${second.key}`)));
  assert.deepEqual(conflicting.changes.map(change => change.id), [first.id]);
  assert.throws(() => calculateFixedFollowUpSchedule({ ...context, anchors: [anchors[0], anchors[0]] }), /중복/);
});

test('all dependency types use their calendar anchors and keep working duration through mixed constraints and undo', async () => {
  const f = await fixture();
  const mon = '2026-11-23', tue = '2026-11-24', thu = '2026-11-26', fri = '2026-11-27', sat = '2026-11-28', next = '2026-11-30';
  try {
    const calendar = await f.request(`/projects/${f.projectId}/calendar`, 'PATCH', {expectedVersion:1,exceptions:[
      {date:'2026-11-25',isWorking:false,label:'중간 휴무'}, {date:sat,isWorking:true,label:'토요일 근무'},
    ]});
    assert.equal(calendar.status, 200);
    const anchor = await makeIssue(f, '선행 기준', mon, thu);
    const start = await makeIssue(f, '시작을 기다리는 업무', mon, mon);
    const finish = await makeIssue(f, '완료를 기다리는 업무', mon, tue);
    const handoff = await makeIssue(f, '착수 후 종료', mon, mon);
    const lead = await makeIssue(f, '끝나기 전 시작', mon, mon);
    const mixed = await makeIssue(f, '두 조건 적용', mon, tue);
    const fixedGood = await makeIssue(f, '종료 조건을 만족한 완료 업무', mon, fri, {status:'done'});
    await dep(f, anchor, start, 1, 'SS');
    const finishEdge = await dep(f, anchor, finish, 1, 'FF');
    await dep(f, anchor, handoff, 3, 'SF');
    await dep(f, anchor, lead, -2);
    await dep(f, anchor, mixed, 1, 'FF');
    await dep(f, start, mixed, 3, 'SS');
    await dep(f, anchor, fixedGood, 1, 'FF');
    assert.equal((await f.request('/dependencies','POST',{predecessorId:anchor.id,successorId:finish.id,type:'SS',lagDays:0})).status,409);
    assert.equal((await f.request('/dependencies','POST',{predecessorId:finish.id,successorId:anchor.id,type:'SF',lagDays:0})).status,400);

    const manual = await f.request('/schedule/preview', 'POST', {issueIds:[finish.id],days:0,workingDays:true});
    assert.equal(manual.status,200);
    assert.ok(manual.data.warnings.some((warning:string) => warning.includes(finish.key) && warning.includes('FF') && warning.includes(fri)));
    const pending = await preview(f,[anchor.id]);
    assert.deepEqual(pending.blocking,[]);
    const earlierVersion = finishEdge.version ?? 1;
    const changed = await f.request(`/dependencies/${finishEdge.id}`, 'PATCH', {expectedVersion:earlierVersion, type:'SS',lagDays:-1});
    assert.equal(changed.status,200);
    assert.equal(changed.data.version, earlierVersion+1);
    assert.equal((await f.request(`/dependencies/${finishEdge.id}`,'PATCH',{expectedVersion:earlierVersion,lagDays:1})).status,409);
    assert.equal((await f.request(`/dependencies/${finishEdge.id}?expectedVersion=${earlierVersion}`,'DELETE')).status,409);
    const reverted = await f.request(`/dependencies/${finishEdge.id}`, 'PATCH', {expectedVersion:changed.data.version,type:'FF',lagDays:1});
    assert.equal(reverted.status,200);
    assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:pending.previewId})).status,409);

    const fresh = await preview(f,[anchor.id]);
    assert.deepEqual(fresh.blocking,[]);
    assert.deepEqual(new Map(fresh.changes.map((change:ScheduleChange)=>[change.id,[change.toStart,change.toEnd]])),new Map([
      [start.id,[tue,tue]], [finish.id,[thu,fri]], [handoff.id,[fri,fri]], [lead.id,[tue,tue]], [mixed.id,[sat,next]],
    ]));
    const applied = await f.request('/schedule/auto-apply','POST',{previewId:fresh.previewId});
    assert.equal(applied.status,200);
    assert.deepEqual(applied.data.warnings,[]);
    assert.equal((await getIssue(f,finish.id)).endDate,fri);
    assert.equal((await getIssue(f,fixedGood.id)).version,fixedGood.version);
    assert.equal((await f.request('/schedule/undo','POST',{undoId:applied.data.undoId})).status,200);
    assert.equal((await getIssue(f,finish.id)).endDate,tue);

    const missingEnd = await makeIssue(f,'착수일만 있는 선행',tue,null);
    const sf = await makeIssue(f,'선행 착수 다음 근무일에 완료',mon,mon);
    await dep(f, missingEnd, sf,1,'SF');
    const startOnly = await preview(f,[sf.id]);
    assert.deepEqual(startOnly.blocking,[]);
    assert.equal(startOnly.changes[0].toEnd,thu);
  } finally { await f.close(); f.remove(); }
});

test('reversing a dependency validates the remaining graph and preserves issue dates and identity', async () => {
  const f = await fixture();
  try {
    const predecessor = await makeIssue(f, '첫 선행 업무', '2026-11-16', '2026-11-17');
    const successor = await makeIssue(f, '첫 후행 업무', '2026-11-18', '2026-11-19');
    const intermediate = await makeIssue(f, '간접 선후행 업무', '2026-11-17', '2026-11-18');
    const link = await dep(f, predecessor, successor);
    await dep(f, predecessor, intermediate);
    const finalIndirectLink = await dep(f, intermediate, successor);
    const path = `/dependencies/${link.id}`;
    const expectedVersion = link.version ?? 1;
    const reversal = { expectedVersion, reverse: true, type: 'SS', lagDays: -1 };
    const before = (await f.request('/workspace')).data;

    const invalidFlag = await f.request(path, 'PATCH', { ...reversal, reverse: 'true' });
    assert.equal(invalidFlag.status, 400);
    const cycle = await f.request(path, 'PATCH', reversal);
    assert.equal(cycle.status, 400);
    assert.match(cycle.data.error, /순환/);
    const unchanged = (await f.request('/workspace')).data;
    assert.deepEqual(unchanged.dependencies, before.dependencies);
    assert.deepEqual(unchanged.activities, before.activities);

    const remove = await f.request(`/dependencies/${finalIndirectLink.id}?expectedVersion=${finalIndirectLink.version}`, 'DELETE');
    assert.equal(remove.status, 200);
    const previousProposal = await preview(f, [predecessor.id]);
    const reverse = await f.request(path, 'PATCH', reversal);
    assert.equal(reverse.status, 200, JSON.stringify(reverse.data));
    assert.deepEqual(reverse.data, { ...link, predecessorId: successor.id, successorId: predecessor.id,
      version: expectedVersion + 1, type: 'SS', lagDays: -1 });
    assert.equal((await f.request(path, 'PATCH', reversal)).status, 409);
    assert.equal((await f.request(`${path}?expectedVersion=${expectedVersion}`, 'DELETE')).status, 409);
    assert.equal((await f.request('/schedule/auto-apply', 'POST', { previewId: previousProposal.previewId })).status, 409);

    const saved = (await f.request('/workspace')).data;
    assert.deepEqual(saved.dependencies.find((value: Dependency) => value.id === link.id), reverse.data);
    assert.deepEqual(saved.issues, before.issues);
    const audited = saved.activities.filter((value: { action: string }) => value.action === '선후행 방향 변경');
    assert.deepEqual(new Set(audited.map((value: { resourceId: string }) => value.resourceId)), new Set([predecessor.id, successor.id]));
    assert.equal(audited.length, 2);
    assert.equal((await f.request(`${path}?expectedVersion=${reverse.data.version}`, 'DELETE')).status, 200);
  } finally {
    await f.close();
    f.remove();
  }
});

test('schema21 backs up non-FS links and rejects older headers even when a link is only in trash', async () => {
  const f = await fixture();
  try {
    const a = await makeIssue(f,'복원할 연결 선행','2026-11-23','2026-11-26');
    const b = await makeIssue(f,'복원할 연결 후행','2026-11-23','2026-11-24');
    const link = await dep(f,a,b,-1,'FF');
    const backup = (await f.request('/export')).data;
    assert.equal(backup.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);
    assert.equal((await f.request('/import','POST',{data:{...backup,schemaVersion:20}})).status,400);
    assert.equal((await f.request(`/dependencies/${link.id}`,'PATCH',{expectedVersion:link.version??1,lagDays:-2})).status,200);
    assert.equal((await f.request('/import','POST',{data:backup})).status,200);
    let current = (await f.request('/workspace')).data.dependencies.find((value:Dependency)=>value.id===link.id) as Dependency;
    assert.equal(current.type,'FF'); assert.equal(current.lagDays,-1);
    assert.ok(current.version!>(link.version??1)+1);
    const beforeTrash = current.version!;
    const item = await getIssue(f,b.id);
    const removed = await f.request(`/issues/${b.id}`,'DELETE',{expectedVersion:item.version});
    assert.equal(removed.status,200);
    const archived = (await f.request('/export')).data;
    assert.ok(!archived.dependencies.some((value:Dependency)=>value.id===link.id));
    assert.equal((await f.request('/import','POST',{data:{...archived,schemaVersion:20}})).status,400);
    assert.equal((await f.request('/import','POST',{data:archived})).status,200);
    assert.equal((await f.request(`/trash/${removed.data.trashEntryId}/restore`,'POST',{})).status,200);
    current = (await f.request('/workspace')).data.dependencies.find((value:Dependency)=>value.id===link.id) as Dependency;
    assert.equal(current.type,'FF'); assert.equal(current.lagDays,-1); assert.ok(current.version!>beforeTrash);
    assert.equal((await f.request(`/dependencies/${link.id}`,'PATCH',{expectedVersion:beforeTrash,type:'SS'})).status,409);
  } finally { await f.close(); f.remove(); }
});

test('guards reject changed untouched anchors, calendar, dependencies, workflow, expiry and import reset',async()=>{
  const f=await fixture();try{
    const a=await makeIssue(f,'고정 선행',null,'2026-11-20'),b=await makeIssue(f,'이동 대상','2026-11-16','2026-11-17');const edge=await dep(f,a,b);
    const p=await preview(f,[b.id]);assert.equal((await f.request(`/issues/${a.id}`,'PATCH',{expectedVersion:a.version,endDate:'2026-11-23'})).status,200);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:p.previewId})).status,409);assert.equal((await getIssue(f,b.id)).startDate,b.startDate);
    const p2=await preview(f,[b.id]);assert.equal((await f.request(`/projects/${f.projectId}/calendar`,'PATCH',{expectedVersion:1,name:'변경된 달력'})).status,200);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:p2.previewId})).status,409);
    const p3=await preview(f,[b.id]);await f.request(`/dependencies/${edge.id}`,'DELETE');await dep(f,a,b,1);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:p3.previewId})).status,409);
    const p4=await preview(f,[b.id]),before=await getIssue(f,b.id),workflow=(await f.request(`/projects/${f.projectId}/workflow`)).data;assert.equal((await f.request(`/projects/${f.projectId}/workflow`,'PATCH',{...workflow,expectedVersion:workflow.version,statuses:workflow.statuses.map((status:any)=>status.id==='todo'?{...status,category:'cancelled'}:status)})).status,200);assert.equal((await getIssue(f,b.id)).version,before.version);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:p4.previewId})).status,409);assert.equal((await getIssue(f,b.id)).startDate,b.startDate);
    const current=(await f.request(`/projects/${f.projectId}/workflow`)).data;await f.request(`/projects/${f.projectId}/workflow`,'PATCH',{...current,expectedVersion:current.version,statuses:current.statuses.map((status:any)=>status.id==='todo'?{...status,category:'todo'}:status)});const expired=await preview(f,[b.id]);editProposal(f,expired.previewId,p=>({...p,expiresAt:new Date(Date.now()-1000).toISOString()}));assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:expired.previewId})).status,409);
    const pending=await preview(f,[b.id]),exported=(await f.request('/export')).data;assert.ok(!Object.hasOwn(exported,'automatic_schedule_previews'));assert.equal((await f.request('/import','POST',{data:exported})).status,200);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:pending.previewId})).status,404);
  }finally{await f.close();f.remove();}
});

test('workflow validation failure rolls back auto dates, audits, undo and used receipt; repaired proposal applies once and undoes',async()=>{
  const f=await fixture();try{
    const anchor=await makeIssue(f,'고정 선행',null,'2026-11-20'),a=await makeIssue(f,'A','2026-11-16','2026-11-17',{description:'준비됨'}),b=await makeIssue(f,'B','2026-11-16','2026-11-17');await dep(f,anchor,a);await dep(f,anchor,b);const workflow=(await f.request(`/projects/${f.projectId}/workflow`)).data;await f.request(`/projects/${f.projectId}/workflow`,'PATCH',{...workflow,expectedVersion:workflow.version,fieldRules:[{issueType:'*',statusId:'todo',requiredFields:['description']}]});
    const p=await preview(f,[a.id,b.id]),before=(await f.request('/workspace')).data;assert.deepEqual(p.blocking,[]);assert.equal(p.changes.length,2);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:p.previewId})).status,422);const after=(await f.request('/workspace')).data;assert.equal(after.activities.length,before.activities.length);assert.equal(after.issues.find((issue:Issue)=>issue.id===a.id).version,a.version);assert.equal(after.issues.find((issue:Issue)=>issue.id===b.id).startDate,b.startDate);const store=new Store(f.dir);try{assert.equal(store.get('automatic_schedule_previews',p.previewId).used,false);assert.equal(store.all('schedule_undos').length,0);}finally{store.db.close();}
    await f.request(`/issues/${b.id}`,'PATCH',{expectedVersion:b.version,description:'검증 완료'});assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:p.previewId})).status,409);const fresh=await preview(f,[a.id,b.id]),result=await f.request('/schedule/auto-apply','POST',{previewId:fresh.previewId});assert.equal(result.status,200);assert.deepEqual((await f.request('/schedule/auto-apply','POST',{previewId:fresh.previewId})).data,result.data);assert.equal((await f.request('/schedule/undo','POST',{undoId:result.data.undoId})).status,200);assert.equal((await getIssue(f,a.id)).startDate,a.startDate);assert.equal((await getIssue(f,b.id)).endDate,b.endDate);
  }finally{await f.close();f.remove();}
});

test('preview maintenance prunes expired unused work and old receipts while retaining active proposals and recent idempotent results',async()=>{
  const f=await fixture();try{
    const anchor=await makeIssue(f,'고정 선행',null,'2026-11-20'),a=await makeIssue(f,'대상','2026-11-16','2026-11-17');await dep(f,anchor,a);const active=await preview(f,[a.id]),expired=await preview(f,[a.id]),used=await preview(f,[a.id]);const result=await f.request('/schedule/auto-apply','POST',{previewId:used.previewId});assert.equal(result.status,200);
    editProposal(f,expired.previewId,p=>({...p,expiresAt:new Date(Date.now()-1000).toISOString()}));const store=new Store(f.dir);let oldId='';try{const recent=store.get('automatic_schedule_previews',used.previewId);oldId=randomUUID();store.put('automatic_schedule_previews',{...recent,id:oldId,appliedAt:new Date(Date.now()-8*24*60*60*1000).toISOString()});}finally{store.db.close();}
    await preview(f,[a.id]);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:expired.previewId})).status,404);assert.equal((await f.request('/schedule/auto-apply','POST',{previewId:oldId})).status,404);assert.deepEqual((await f.request('/schedule/auto-apply','POST',{previewId:used.previewId})).data,result.data);const inspect=new Store(f.dir);try{assert.ok(inspect.get('automatic_schedule_previews',active.previewId));}finally{inspect.db.close();}
  }finally{await f.close();f.remove();}
});
