import type { Issue } from '../../shared/types';
import { test, expect } from '@playwright/test';

test('업무 생성과 상태·댓글·검색이 API에 저장된다', async ({ page, request }) => {
  const title = `브라우저 검사 ${Date.now()}`;
  let id = '';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/');
    await page.locator('.project-navigation').getByRole('button', { name: /^업무(?: [\d,]+)?$/u }).click();
    await page.getByRole('button', {name:'업무 만들기', exact:true}).first().click();
    const form = page.getByRole('dialog', {name:'새 업무 만들기'});
    await form.getByLabel('업무 제목').fill(title);
    await form.getByLabel('설명', {exact:true}).fill('실제 저장과 상태 변경을 검증하는 합성 업무');
    await form.getByLabel('시작일', {exact:true}).fill('2026-11-16');
    await form.getByLabel('종료일', {exact:true}).fill('2026-11-20');
    const createdResponse = page.waitForResponse(r => r.url().endsWith('/api/issues') && r.request().method() === 'POST');
    await form.getByRole('button',{name:'업무 만들기', exact:true}).click();
    const created = await (await createdResponse).json();
    id = created.id;
    expect(id).toBeTruthy();
    const panel = page.getByRole('dialog');
    await expect(panel.getByRole('heading', {name:title,exact:true})).toBeVisible();
    await panel.getByRole('combobox', {name:'상태', exact:true}).selectOption('in_progress');
    await panel.getByRole('button',{name:'변경사항 저장'}).click();
    await expect.poll(async () => {
      const snapshot = await (await request.get('/api/workspace')).json();
      return snapshot.issues.find((i: {id:string})=>i.id===id)?.status;
    }).toBe('in_progress');
    const commentDraft = panel.getByLabel('댓글 내용', {exact:true});
    await commentDraft.fill('UI에서 남긴 검증 댓글');
    const savedComment = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/comments');
    await panel.getByRole('button',{name:'댓글 등록'}).click();
    expect((await savedComment).status()).toBe(201);
    await expect(panel.getByRole('article').getByText('UI에서 남긴 검증 댓글',{exact:true})).toBeVisible();
    await expect(commentDraft).toHaveValue('');
    await expect(commentDraft).toBeEditable();
    await panel.getByRole('button',{name:'업무 상세 닫기'}).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button',{name:'통합 검색',exact:true}).click();
    await page.getByRole('dialog', { name: '통합 검색' }).getByRole('textbox', { name: '통합 검색어' }).fill(title);
    await expect(page.locator('.search-result').filter({hasText:title})).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByLabel('업무 검색',{exact:true}).fill(title);
    await expect(page.locator('.issue-title-button').filter({hasText:title})).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (id) await request.delete(`/api/issues/${id}`);
  }
});

test('간트의 여러 일정 이동은 미리보기 후 적용되고 되돌릴 수 있다', async ({page,request}) => {
  const snapshot=await (await request.get('/api/workspace')).json();
  const project=snapshot.projects[0];
  const created: Issue[]=[];
  try {
    for(let i=0;i<2;i++){
      const r=await request.post('/api/issues',{data:{projectId:project.id,title:`간트 브라우저 검사 ${Date.now()}-${i}`,startDate:'2026-11-16',endDate:'2026-11-18'}});
      expect(r.ok()).toBeTruthy();created.push(await r.json());
    }
    await page.goto(`/#/${project.id}/gantt`);
    await expect(page.getByRole('heading',{name:'일정 · 간트',exact:true})).toBeVisible();
    for(const issue of created) await page.getByRole('checkbox',{name:`${issue.key} 선택`,exact:true}).check();
    await page.getByRole('button',{name:'2개 일정 이동',exact:true}).click();
    await page.getByLabel('이동 일수').fill('2');
    await page.getByRole('button',{name:'변경 미리보기',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'일정 변경 미리보기'})).toBeVisible();
    const before=await (await request.get('/api/workspace')).json();
    expect(before.issues.find((i:{id:string})=>i.id===created[0].id).startDate).toBe('2026-11-16');
    await page.getByRole('button',{name:'변경 적용',exact:true}).click();
    await expect.poll(async()=>{
      const data=await (await request.get('/api/workspace')).json();
      return data.issues.find((i:{id:string})=>i.id===created[0].id).startDate;
    }).toBe('2026-11-18');
    await page.getByRole('button',{name:'되돌리기',exact:true}).click();
    await expect.poll(async()=>{
      const data=await (await request.get('/api/workspace')).json();
      return data.issues.find((i:{id:string})=>i.id===created[0].id).startDate;
    }).toBe('2026-11-16');
    await expect(page.getByLabel(`${created[0].key} 시작일`,{exact:true})).toHaveValue('2026-11-16');
  } finally { for(const issue of created)await request.delete(`/api/issues/${issue.id}`); }
});

test('작은 화면에서 메뉴를 열고 프로젝트 화면을 사용할 수 있다', async ({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await expect(page.getByRole('button',{name:'메뉴 열기',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'메뉴 열기',exact:true}).click();
  await expect(page.locator('.sidebar.is-open')).toBeVisible();
  await page.locator('.project-navigation').getByRole('button',{name:'개요',exact:true}).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);
  expect(await page.locator('body').evaluate(e=>e.scrollWidth)).toBeLessThanOrEqual(392);
});
