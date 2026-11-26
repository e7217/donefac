import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Issue, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

test('업무 편집 중 작업자 전환을 취소하면 보존하고 승인하면 제목·댓글을 실제로 비운다', async ({page,request}) => {
  const data=await(await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const issue=await(await request.post('/api/issues',{data:{projectId:data.projects[0].id,title:`작업자 전환 ${randomUUID()}`}})).json() as Issue;
  try {
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const actor=page.getByLabel('작업자 선택',{exact:true});
    const original=await actor.inputValue();
    const next=data.users.find(user=>user.id!==original)!.id;
    const panel=page.getByRole('dialog');
    await panel.getByLabel('제목',{exact:true}).fill('버리기 전 작성한 제목');
    await panel.getByLabel('댓글 내용',{exact:true}).fill('아직 보내지 않은 댓글');
    page.once('dialog',dialog=>dialog.dismiss());
    await actor.selectOption(next);
    await expect(actor).toHaveValue(original);
    await expect(panel.getByLabel('제목',{exact:true})).toHaveValue('버리기 전 작성한 제목');
    await expect(panel.getByLabel('댓글 내용',{exact:true})).toHaveValue('아직 보내지 않은 댓글');
    page.once('dialog',dialog=>dialog.accept());
    await actor.selectOption(next);
    await expect(actor).toHaveValue(next);
    await expect(panel.getByLabel('제목',{exact:true})).toHaveValue(issue.title);
    await expect(panel.getByLabel('댓글 내용',{exact:true})).toHaveValue('');
    await expect(panel.getByRole('button',{name:'변경사항 저장',exact:true})).toBeDisabled();
    await panel.getByRole('button',{name:'업무 상세 닫기',exact:true}).click();
    await expect(panel).toBeHidden();
    const stored=(await(await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.find(value=>value.id===issue.id)!;
    expect(stored.title).toBe(issue.title);expect(stored.version).toBe(issue.version);
    expect(await(await request.get(`/api/comments?resourceType=issue&resourceId=${issue.id}`)).json()).toEqual([]);
  } finally {await request.delete(`/api/issues/${issue.id}`);}
});

test('워크플로 편집의 작업자 전환과 검색 이동 승인은 남아 있는 설정 초안을 실제로 버린다',async({page,request})=>{
  const data=await(await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const project=data.projects[0];
  const baseline=await(await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
  const issue=await(await request.post('/api/issues',{data:{projectId:project.id,title:`설정에서 검색 이동 ${randomUUID()}`,cycleId:data.planningItems?.find(item=>item.projectId===project.id&&item.kind==='cycle')?.id}})).json() as Issue;
  try{
    await page.goto(`/#/${project.id}/settings?section=work`);
    const workflow=page.getByRole('region',{name:'프로젝트 워크플로 설정'});
    const name=workflow.getByLabel('상태 1 이름',{exact:true});
    await expect(name).toHaveValue(baseline.statuses[0].label);
    const actor=page.getByLabel('작업자 선택',{exact:true}),original=await actor.inputValue();
    const next=data.users.find(user=>user.id!==original)!.id;
    await name.fill('취소하면 남아야 할 설정');
    page.once('dialog',dialog=>dialog.dismiss());await actor.selectOption(next);
    await expect(actor).toHaveValue(original);await expect(name).toHaveValue('취소하면 남아야 할 설정');
    page.once('dialog',dialog=>dialog.accept());await actor.selectOption(next);
    await expect(actor).toHaveValue(next);await expect(name).toHaveValue(baseline.statuses[0].label);
    await name.fill('검색 이동으로 버릴 설정');
    await page.getByRole('button',{name:'통합 검색',exact:true}).click();
    const search=page.getByRole('dialog',{name:'통합 검색'});
    if(issue.cycle){await search.getByRole('textbox').fill(issue.cycle);await expect(search.getByText(data.issues[0].key,{exact:true})).toBeVisible();}
    await search.getByRole('textbox').fill(issue.title);
    page.once('dialog',dialog=>dialog.dismiss());await search.getByRole('button').filter({hasText:issue.title}).click();
    await expect(search).toBeVisible();await expect(name).toHaveValue('검색 이동으로 버릴 설정');
    page.once('dialog',dialog=>dialog.accept());await search.getByRole('button').filter({hasText:issue.title}).click();
    await expect(page).toHaveURL(new RegExp(`/issues\\?issue=${issue.id}$`));
    await page.getByRole('button',{name:'업무 상세 닫기',exact:true}).click();
    await page.getByRole('button',{name:'워크스페이스 설정',exact:true}).click();
    // The sidebar opens the default section; the workflow editor is in '업무 구성'.
    await page.getByRole('navigation',{name:'설정 섹션'}).getByRole('button',{name:'업무 구성',exact:true}).click();
    await expect(name).toHaveValue(baseline.statuses[0].label);
    const stored=await(await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
    expect(stored).toEqual(baseline);
  }finally{await request.delete(`/api/issues/${issue.id}`);}
});
