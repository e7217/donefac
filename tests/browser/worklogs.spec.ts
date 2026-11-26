import {expect, test, type APIRequestContext} from '@playwright/test';
import type {Issue, IssueWorklogPage, WorkspaceSnapshot} from '../../shared/types';

async function fixture(request: APIRequestContext, label: string) {
  const workspace = (await (await request.get('/api/workspace')).json()) as WorkspaceSnapshot;
  const project = workspace.projects[0];
  const response = await request.post('/api/issues', {data:{projectId:project.id,title:`${label} ${Date.now()}`}});
  expect(response.ok()).toBeTruthy();
  return {issue:(await response.json()) as Issue,project,user:workspace.users[0]};
}
async function entries(request: APIRequestContext, issueId: string) {
  const response = await request.get(`/api/issues/${issueId}/worklogs`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as IssueWorklogPage;
}

test('티켓의 실제 작업 시간을 작성하고 작성자별 보고서에서 업무로 돌아간다', async ({page,request}) => {
  const {issue,project,user} = await fixture(request,'보고서 작업 시간 검사');
  const workDate = '2026-10-07';
  try {
    await page.setViewportSize({width:360,height:820});
    await page.addInitScript(() => {
      Object.defineProperty(Crypto.prototype,'randomUUID',{value:undefined});
    });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const drawer = page.getByRole('dialog',{name:issue.title,exact:true});
    await drawer.getByRole('button',{name:'작업 시간',exact:true}).click();
    const panel = drawer.getByRole('region',{name:'업무 작업 기록'});
    await expect(panel).toBeVisible();
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await panel.getByLabel('작업 기록 날짜',{exact:true}).fill(workDate);
    await panel.getByLabel('작업 기록 시간',{exact:true}).fill('1');
    await panel.getByLabel('작업 기록 분',{exact:true}).fill('20');
    await panel.getByLabel('작업 기록 내용',{exact:true}).fill('합성 작업 메모');
    await panel.getByRole('button',{name:'작업 기록 저장',exact:true}).click();
    await expect(panel.getByLabel('업무 총 작업 시간')).toHaveText('1시간 20분');
    const list = await entries(request,issue.id);
    expect(list.entries[0]).toMatchObject({workDate,minutes:80,note:'합성 작업 메모',authorId:user.id});
    const currentIssue = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.find(value => value.id===issue.id);
    expect(currentIssue?.version).toBe(issue.version);

    await drawer.getByRole('button',{name:'업무 상세 닫기'}).click();
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'더보기',exact:true}).click();
    await page.getByRole('button',{name:'보고서',exact:true}).click();
    await page.getByRole('tab',{name:'작업 시간',exact:true}).click();
    await page.getByLabel('작업 시간 시작일',{exact:true}).fill(workDate);
    await page.getByLabel('작업 시간 종료일',{exact:true}).fill(workDate);
    await page.getByLabel('작업 시간 작성자',{exact:true}).selectOption(user.id);
    await page.getByRole('button',{name:'작업 시간 조회',exact:true}).click();
    const result = page.getByRole('region',{name:'작업 시간 조회 결과'});
    await expect(result.getByRole('region',{name:'작성자별 작업 시간'})).toContainText(user.name);
    const breakdown = result.getByRole('region',{name:'업무별 작업 시간'});
    const link = breakdown.getByRole('button',{name:`${issue.key} ${issue.title} 업무 열기`});
    await expect(breakdown.getByRole('row',{name:new RegExp(issue.key)})).toContainText('1시간 20분');
    await link.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button',{name:'업무 상세 닫기'}).click();

    const removed = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
    expect(removed.ok()).toBeTruthy();
    await page.getByRole('button',{name:'작업 시간 조회',exact:true}).click();
    await expect(breakdown.getByRole('row',{name:new RegExp(issue.key)})).toContainText('삭제된 업무');
    await expect(link).toHaveCount(0);
    await expect(breakdown.getByRole('row',{name:new RegExp(issue.key)})).toContainText('1시간 20분');
  } finally { await request.delete(`/api/issues/${issue.id}`); }
});

test('이동 취소와 충돌 뒤 초안을 보존하고 저장 응답이 끊기면 같은 ID로 복구한다', async ({page,request}) => {
  const {issue,project,user} = await fixture(request,'작업 시간 복구 검사');
  const workDate = '2026-10-12';
  try {
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const drawer = page.getByRole('dialog',{name:issue.title,exact:true});
    await drawer.getByRole('button',{name:'작업 시간',exact:true}).click();
    const region = drawer.getByRole('region',{name:'업무 작업 기록'});
    const minutes = region.getByLabel('작업 기록 분',{exact:true});
    const note = region.getByLabel('작업 기록 내용',{exact:true});
    await region.getByLabel('작업 기록 날짜',{exact:true}).fill(workDate);
    await minutes.fill('35');
    await note.fill('보존할 입력');
    page.once('dialog',dialog => void dialog.dismiss());
    await drawer.getByRole('button',{name:'상세 정보',exact:true}).click();
    await expect(note).toHaveValue('보존할 입력');

    const attempts: string[] = [];
    await page.route('**/api/issues/*/worklogs',async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push((route.request().postDataJSON() as {requestId:string}).requestId);
      if (attempts.length === 1) {
        expect((await route.fetch()).ok()).toBeTruthy();
        await route.abort('failed');
      } else await route.continue();
    });
    await region.getByRole('button',{name:'작업 기록 저장',exact:true}).click();
    const retry = region.getByRole('button',{name:'기록 결과 다시 확인',exact:true});
    await expect(retry).toBeEnabled();
    await expect(note).toHaveValue('보존할 입력');
    await retry.click();
    await expect(region.getByLabel('업무 총 작업 시간')).toHaveText('35분');
    expect(attempts).toEqual([attempts[0],attempts[0]]);
    const recorded = await entries(request,issue.id);
    expect(recorded.totalEntries).toBe(1);

    await region.getByRole('button',{name:`${workDate} 작업 기록 수정`,exact:true}).click();
    await note.fill('저장하지 못한 수정본');
    const original = recorded.entries[0];
    const edited = await request.patch(`/api/issues/${issue.id}/worklogs/${original.id}`,{
      headers:{'X-Actor-Id':user.id},
      data:{expectedVersion:original.version,workDate,minutes:55,note:'다른 창의 수정본'},
    });
    expect(edited.ok()).toBeTruthy();
    await region.getByRole('button',{name:'기록 수정 저장',exact:true}).click();
    await expect(region.getByRole('alert')).toContainText('최신 기록');
    await expect(note).toHaveValue('저장하지 못한 수정본');
    expect((await entries(request,issue.id)).totalMinutes).toBe(55);

    const deletion = await request.delete(`/api/issues/${issue.id}/worklogs/${original.id}`,{
      headers:{'X-Actor-Id':user.id},
      data:{expectedVersion:original.version+1},
    });
    expect(deletion.ok()).toBeTruthy();
  } finally { await request.delete(`/api/issues/${issue.id}`); }
});
