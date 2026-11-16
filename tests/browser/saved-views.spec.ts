import { test, expect, request as playwrightRequest } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Issue, SavedView, WorkspaceSnapshot } from '../../shared/types';

test('공유 업무 보기는 검색·필터·레이아웃을 서버에 저장하고 다시 열어도 적용된다', async ({page,baseURL}) => {
  const requests = await playwrightRequest.newContext({baseURL});
  const prefix = `보기검증-${randomUUID()}`;
  let issue: Issue | null = null;
  let savedId = '';
  try {
    const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    const projectId = snapshot.projects[0].id;
    const response = await requests.post('/api/issues',{data:{projectId,title:prefix+' 업무',type:'버그'}});
    expect(response.ok()).toBeTruthy();issue = await response.json() as Issue;
    await page.goto(`/#/${projectId}/issues`);
    await page.getByLabel('업무 검색',{exact:true}).fill(prefix);
    await page.getByLabel('유형 필터',{exact:true}).selectOption('버그');
    await page.getByRole('button',{name:'보드',exact:true}).click();
    await page.getByRole('button',{name:'현재 보기 저장',exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'업무 보기 저장',exact:true});
    await dialog.getByLabel('보기 이름',{exact:true}).fill(prefix);
    const createdResponse = page.waitForResponse(response=>response.url().endsWith('/api/views') && response.request().method()==='POST');
    await dialog.getByRole('button',{name:'저장',exact:true}).click();
    const saved = await (await createdResponse).json() as SavedView;savedId=saved.id;
    await expect(dialog).toBeHidden();
    expect(saved.layout).toBe('board');expect(saved.filters.query).toBe(prefix);expect(saved.filters.type).toBe('버그');
    await page.getByLabel('업무 검색',{exact:true}).fill('없는 검색 조건');
    await page.getByLabel('유형 필터',{exact:true}).selectOption('all');
    await page.getByRole('button',{name:'목록',exact:true}).click();
    await page.getByLabel('저장된 업무 보기',{exact:true}).selectOption(savedId);
    await expect(page.getByLabel('업무 검색',{exact:true})).toHaveValue(prefix);
    await expect(page.getByLabel('유형 필터',{exact:true})).toHaveValue('버그');
    await expect(page.locator('.issue-board-card').filter({hasText:prefix})).toBeVisible();
    await page.reload();
    await page.getByLabel('저장된 업무 보기',{exact:true}).selectOption(savedId);
    await expect(page.locator('.issue-board-card').filter({hasText:prefix})).toBeVisible();
    await page.getByRole('button',{name:'보기 수정',exact:true}).click();
    const editing = page.getByRole('dialog',{name:'저장된 보기 수정',exact:true});
    await editing.getByLabel('보기 이름',{exact:true}).fill(prefix+' 내 수정');
    const remoteName = prefix+' 팀 수정';
    const remote = await requests.patch(`/api/views/${savedId}`,{data:{expectedVersion:saved.version,name:remoteName}});
    expect(remote.ok()).toBeTruthy();
    await editing.getByRole('button',{name:'저장',exact:true}).click();
    await expect(editing.getByRole('alert')).toContainText('다른 작업자');
    await expect(editing.getByLabel('보기 이름',{exact:true})).toHaveValue(prefix+' 내 수정');
    await expect(editing.getByRole('button',{name:'저장',exact:true})).toBeDisabled();
    page.once('dialog',dialog=>dialog.accept());
    await editing.getByRole('button',{name:'최신 보기 불러오기',exact:true}).click();
    await expect(editing.getByLabel('보기 이름',{exact:true})).toHaveValue(remoteName);
    await editing.getByRole('button',{name:'취소',exact:true}).click();
    await page.getByRole('button',{name:'현재 보기 저장',exact:true}).click();
    const duplicate = page.getByRole('dialog',{name:'업무 보기 저장',exact:true});
    await duplicate.getByLabel('보기 이름',{exact:true}).fill(remoteName);
    await duplicate.getByRole('button',{name:'저장',exact:true}).click();
    await expect(duplicate.getByRole('alert')).toContainText('같은 이름');
    await duplicate.getByRole('button',{name:'취소',exact:true}).click();
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'선택한 보기 삭제',exact:true}).click();
    await expect.poll(async()=>{
      const list=await(await requests.get(`/api/views?projectId=${projectId}`)).json() as SavedView[];
      return list.some(view=>view.id===savedId);
    }).toBe(false);
  } finally {
    if(savedId){const current=await(await requests.get(`/api/views?projectId=${issue?.projectId || 'project-neo'}`)).json().catch(()=>[]) as SavedView[];const remaining=current.find(view=>view.id===savedId);if(remaining)await requests.delete(`/api/views/${savedId}?expectedVersion=${remaining.version}`);}
    if(issue)await requests.delete(`/api/issues/${issue.id}`);
    await requests.dispose();
  }
});
