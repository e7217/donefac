import { test,expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AutomationRule,GitlabSettings,Issue,WorkspaceSnapshot } from '../../shared/types';

test('자동화 미리보기는 업무를 유지하고 명시적으로 활성화한 규칙은 인증된 새 MR 이벤트를 적용한다',async({page,request})=>{
  const initial=await(await request.get('/api/workspace')).json() as WorkspaceSnapshot,project=initial.projects[0];
  let calls=0,ruleId='';const mock=createServer((_req,res)=>{calls++;res.writeHead(404);res.end();});mock.listen(0,'127.0.0.1');await once(mock,'listening');
  const base=`http://127.0.0.1:${(mock.address() as {port:number}).port}`,secret='synthetic-browser-automation-secret';
  const original=await(await request.get('/api/integrations/gitlab')).json() as GitlabSettings;expect(original.baseUrl).toBe('');
  const issue=await(await request.post('/api/issues',{data:{projectId:project.id,title:`MR 자동화 검증 ${Date.now()}`}})).json() as Issue;
  try{
    expect((await request.patch('/api/integrations/gitlab',{data:{expectedVersion:original.version,baseUrl:base,projectIds:[42],webhookSecret:secret}})).ok()).toBeTruthy();
    await page.goto(`/#/${project.id}/development`);const settings=page.getByRole('region',{name:'GitLab 상태 자동화 설정',exact:true});
    await settings.getByRole('button',{name:'규칙 만들기',exact:true}).click();const editor=settings.getByRole('region',{name:'자동화 규칙 편집',exact:true});
    const name=`MR 병합 완료 ${Date.now()}`;await editor.getByLabel('자동화 규칙 이름',{exact:true}).fill(name);await editor.getByLabel('자동화 브랜치 패턴',{exact:true}).fill('feature/*');
    await editor.getByLabel('자동화 저장소 42',{exact:true}).check();await editor.getByLabel('자동화 출발 상태 할 일',{exact:true}).check();await editor.getByLabel('자동화 도착 상태',{exact:true}).selectOption('done');await editor.getByLabel('자동화 실행 작업자',{exact:true}).selectOption(initial.users[1].id);
    await editor.getByLabel('미리보기 브랜치',{exact:true}).fill(`feature/${issue.key}`);await editor.getByLabel(`${issue.key} 자동화 미리보기 선택`,{exact:true}).check();await editor.getByRole('button',{name:'변경 없이 미리보기',exact:true}).click();
    await expect(editor.locator('.automation-preview-outcome')).toContainText('변경 예정');let snapshot=await(await request.get('/api/workspace')).json() as WorkspaceSnapshot;expect(snapshot.issues.find(value=>value.id===issue.id)?.status).toBe('todo');expect(await(await request.get('/api/automation-runs')).json()).toHaveLength(0);
    const created=page.waitForResponse(response=>response.url().endsWith('/api/automation-rules')&&response.request().method()==='POST');await editor.getByRole('button',{name:'규칙 저장',exact:true}).click();const rule=await(await created).json() as AutomationRule;ruleId=rule.id;expect(rule.enabled).toBe(false);
    await expect(editor.getByLabel('자동화 규칙 활성화',{exact:true})).toBeEnabled();await editor.getByLabel('자동화 규칙 활성화',{exact:true}).check();const enabled=page.waitForResponse(response=>response.url().endsWith(`/api/automation-rules/${ruleId}`)&&response.request().method()==='PATCH');await editor.getByRole('button',{name:'규칙 저장',exact:true}).click();expect((await(await enabled).json() as AutomationRule).enabled).toBe(true);await expect(editor.getByRole('button',{name:'규칙 저장',exact:true})).toBeDisabled();
    const body={object_kind:'merge_request',project:{id:42},object_attributes:{id:773,iid:773,action:'merge',state:'merged',title:`${issue.key} synthetic MR`,source_branch:`feature/${issue.key}`,url:`${base}/-/merge_requests/773`,updated_at:new Date().toISOString()}};
    const eventId=randomUUID(),headers={'X-Gitlab-Token':secret,'webhook-id':eventId};const hook=await request.post('/api/integrations/gitlab/webhook',{data:body,headers});expect(hook.ok()).toBeTruthy();
    await settings.getByRole('button',{name:'자동화 설정 새로고침',exact:true}).click();const log=settings.getByRole('region',{name:'자동화 실행 기록',exact:true});await expect(log.locator('tbody tr').filter({hasText:issue.key})).toContainText('변경됨');snapshot=await(await request.get('/api/workspace')).json() as WorkspaceSnapshot;const changed=snapshot.issues.find(value=>value.id===issue.id)!;expect(changed.status).toBe('done');expect(changed.version).toBe(issue.version+1);expect(snapshot.activities.filter(activity=>activity.resourceId===issue.id).at(-1)?.actorId).toBe(initial.users[1].id);
    expect((await(await request.post('/api/integrations/gitlab/webhook',{data:body,headers})).json()).duplicate).toBe(true);expect(await(await request.get('/api/automation-runs')).json()).toHaveLength(1);expect(calls).toBe(0);
    await editor.getByRole('button',{name:'자동화 규칙 편집 닫기',exact:true}).click();const toast=page.getByRole('button',{name:'알림 닫기',exact:true});if(await toast.isVisible())await toast.click();mkdirSync('docs/screenshots',{recursive:true});await page.screenshot({path:'docs/screenshots/gitlab-automation.png',fullPage:true});
  }finally{
    if(ruleId){const rules=await(await request.get('/api/automation-rules')).json() as AutomationRule[],current=rules.find(rule=>rule.id===ruleId);if(current)await request.delete(`/api/automation-rules/${ruleId}?expectedVersion=${current.version}`);}
    await request.delete(`/api/issues/${issue.id}`);const current=await(await request.get('/api/integrations/gitlab')).json() as GitlabSettings;await request.patch('/api/integrations/gitlab',{data:{expectedVersion:current.version,baseUrl:'',projectIds:[],webhookSecret:'',signingToken:'',token:''}});await new Promise<void>(resolve=>mock.close(()=>resolve()));
  }
});
