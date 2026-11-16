import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

test('한국 시간의 오늘부터 일정 입력은 UTC 전날 대신 브라우저의 현재 날짜를 저장한다',async({browser,request,baseURL})=>{
  const data=await(await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const created=await request.post('/api/issues',{data:{projectId:data.projects[0].id,title:`현지 날짜 ${randomUUID()}`}});
  expect(created.status()).toBe(201);
  const issue=await created.json() as Issue;
  const context=await browser.newContext({baseURL,timezoneId:'Asia/Seoul'});
  try{
    const page=await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-16T16:30:00.000Z'));
    await page.goto(`/#/${issue.projectId}/gantt`);
    const row=page.locator('.gantt-unscheduled-row').filter({hasText:issue.title});
    await expect(row).toBeVisible();
    await row.getByRole('button',{name:'오늘부터 3일',exact:true}).click();
    await expect.poll(async()=>{
      const current=await(await request.get('/api/workspace')).json() as WorkspaceSnapshot;
      const saved=current.issues.find(value=>value.id===issue.id)!;
      return [saved.startDate,saved.endDate];
    }).toEqual(['2026-11-17','2026-11-19']);
    await expect(page.getByLabel(`${issue.key} 시작일`,{exact:true})).toHaveValue('2026-11-17');
  }finally{await context.close();await request.delete(`/api/issues/${issue.id}`);}
});
