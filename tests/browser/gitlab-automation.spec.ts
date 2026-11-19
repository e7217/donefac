import { test,expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AutomationRule,GitlabSettings,GitlabSyncPreview,Issue,WorkspaceSnapshot } from '../../shared/types';

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

test('저장 전 GitLab 연결에서 저장소별 결과와 티켓 후보를 확인하고 저장 후 같은 링크를 동기화한다',async({page,request})=>{
  const workspace = async () => await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const before = await workspace();
  const project = before.projects[0];
  const created = await request.post('/api/issues',{data:{projectId:project.id,title:`GitLab 연결 검증 ${randomUUID()}`}});
  expect(created.status()).toBe(201);
  const issue = await created.json() as Issue;
  const settings = async () => await (await request.get('/api/integrations/gitlab')).json() as GitlabSettings;
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const token = `synthetic-browser-read-${randomUUID()}`;
  const received: { method:string|undefined; token:string|string[]|undefined }[] = [];
  const at = new Date(Date.now()-5_000).toISOString();
  const mock = createServer((req,res) => {
    received.push({method:req.method,token:req.headers['private-token']});
    res.setHeader('Content-Type','application/json');
    if (req.url?.includes('/projects/99/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({message:'synthetic access denial'}));
    } else if (req.url?.includes('/merge_requests?')) {
      res.end(JSON.stringify([{id:701,iid:1,title:`${issue.key} MR 연결`,source_branch:'feature/reused',sha:'head-new',state:'opened',updated_at:at,web_url:'https://git.example.test/mr/1'}]));
    } else {
      res.end(JSON.stringify([
        {id:801,ref:'feature/reused',sha:'head-new',status:'success',updated_at:at,web_url:'https://git.example.test/pipelines/801'},
        {id:802,ref:'feature/reused',sha:'head-old',status:'failed',updated_at:at,web_url:'https://git.example.test/pipelines/802'},
      ]));
    }
  });
  mock.listen(0,'127.0.0.1');
  await once(mock,'listening');
  const url = `http://127.0.0.1:${(mock.address() as {port:number}).port}`;
  try {
    await page.setViewportSize({width:360,height:820});
    await page.goto(`/#/${project.id}/development`);
    const address = page.getByLabel('GitLab 주소',{exact:true});
    const ids = page.getByLabel(/GitLab 프로젝트 ID/);
    const privateToken = page.getByLabel(/읽기 API 토큰/);
    await address.fill(url);
    await ids.fill('42, 99');
    await privateToken.fill(token);
    await page.getByLabel('웹훅 Secret Token',{exact:true}).fill('synthetic-inbound-only');
    expect(received).toHaveLength(0);
    const checked = page.waitForResponse(response=>new URL(response.url()).pathname==='/api/integrations/gitlab/sync-preview');
    await page.getByRole('button',{name:'연결 미리보기',exact:true}).click();
    const response = await checked;
    expect(response.ok(),await response.text()).toBeTruthy();
    const postData = response.request().postDataJSON() as Record<string,unknown>;
    expect(postData).not.toHaveProperty('webhookSecret');
    expect(postData).not.toHaveProperty('signingToken');
    const preview = await response.json() as GitlabSyncPreview;
    expect(preview.counts.create).toBe(2);
    const result = page.getByRole('region',{name:'GitLab 연결 미리보기',exact:true});
    await expect(result.getByRole('region',{name:'저장소 42',exact:true})).toContainText('조회 가능');
    await expect(result.getByRole('region',{name:'저장소 99',exact:true})).toContainText('조회 실패');
    const candidates = result.getByRole('region',{name:'티켓 연결 후보',exact:true});
    await expect(candidates).toContainText(`${issue.key} MR 연결`);
    await expect(candidates.getByRole('button',{name:`업무 ${issue.key} 열기`,exact:true})).toHaveCount(2);
    expect(await settings()).toEqual(original);
    expect((await workspace()).gitlabLinks.filter(link=>link.issueId===issue.id)).toHaveLength(0);
    expect(received.every(value=>value.method==='GET' && value.token===token)).toBeTruthy();

    page.once('dialog',dialog=>dialog.dismiss());
    await candidates.getByRole('button',{name:`업무 ${issue.key} 열기`,exact:true}).first().click();
    await expect(result).toBeVisible();
    await expect(address).toHaveValue(url);
    await expect(privateToken).toHaveValue(token);
    await ids.fill('42');
    await expect(result).toHaveCount(0);
    const saved = page.waitForResponse(value=>new URL(value.url()).pathname==='/api/integrations/gitlab' && value.request().method()==='PATCH');
    await page.getByRole('button',{name:'연결 설정 저장',exact:true}).click();
    expect((await saved).ok()).toBeTruthy();
    const synced = page.waitForResponse(value=>new URL(value.url()).pathname==='/api/integrations/gitlab/sync');
    await page.getByRole('button',{name:'지금 동기화',exact:true}).click();
    const applied = await synced;
    expect(applied.ok(),await applied.text()).toBeTruthy();
    expect(await applied.json()).toMatchObject({scanned:3,linked:2});
    const snapshot = await workspace();
    expect(snapshot.gitlabLinks.filter(link=>link.issueId===issue.id).map(link=>link.kind).sort()).toEqual(['merge_request','pipeline']);
    expect(snapshot.gitlabLinks.some(link=>link.issueId===issue.id && link.iid===802)).toBe(false);
    expect(snapshot.issues.find(item=>item.id===issue.id)).toMatchObject({status:issue.status,version:issue.version});
  } finally {
    try {
      const current = await settings();
      if(current.baseUrl) expect((await request.patch('/api/integrations/gitlab',{data:{expectedVersion:current.version,baseUrl:'',projectIds:[],token:'',webhookSecret:'',signingToken:''}})).ok()).toBeTruthy();
      await request.delete(`/api/issues/${issue.id}`);
    } finally {
      await new Promise<void>(resolve=>mock.close(()=>resolve()));
    }
  }
});

test('360px 티켓에서 MR 전에 GitLab 브랜치와 커밋을 확인하고 브랜치 삭제 뒤에도 커밋 링크를 유지한다', async ({ page, request }) => {
  const workspace = async () => (await (await request.get('/api/workspace')).json()) as WorkspaceSnapshot;
  const settings = async () => (await (await request.get('/api/integrations/gitlab')).json()) as GitlabSettings;
  const project = (await workspace()).projects[0];
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const created = await request.post('/api/issues', { data: { projectId: project.id, title: `푸시 연결 검증 ${randomUUID()}` } });
  expect(created.status()).toBe(201);
  const issue = await created.json() as Issue;
  const secret = `synthetic-push-${randomUUID()}`;
  const baseUrl = 'https://git.example.test/forge';
  const projectUrl = `${baseUrl}/team/engine`;
  const branch = `feature/${issue.key}-integration`;
  const zero = '0'.repeat(40);
  const initialHead = 'a'.repeat(40);
  const pushedHead = 'b'.repeat(40);
  const commitTitle = 'Improve first-run status panel';
  const branchUrl = `${projectUrl}/-/tree/${encodeURIComponent(branch)}`;
  const commitUrl = `${projectUrl}/-/commit/${pushedHead}`;
  const externalRequests: string[] = [];
  page.on('request', item => { if (new URL(item.url()).hostname === 'git.example.test') externalRequests.push(item.url()); });
  const push = async (before: string, after: string, commits: Record<string, string>[] = []) => {
    const response = await request.post('/api/integrations/gitlab/webhook', {
      headers: { 'X-Gitlab-Token': secret, 'X-Gitlab-Event': 'Push Hook', 'webhook-id': randomUUID() },
      data: { object_kind: 'push', project_id: 42, ref: `refs/heads/${branch}`, before, after,
        checkout_sha: after === zero ? null : after, commits, total_commits_count: commits.length,
        project: { id: 42, web_url: projectUrl, path_with_namespace: 'team/engine' } },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  try {
    const configured = await request.patch('/api/integrations/gitlab', { data: { expectedVersion: original.version, baseUrl, projectIds: [42], webhookSecret: secret } });
    expect(configured.ok(), await configured.text()).toBeTruthy();
    await push(zero, initialHead);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const dialog = page.getByRole('dialog');
    const gitlab = dialog.getByRole('region', { name: 'GitLab', exact: true });
    const branches = gitlab.getByRole('region', { name: '브랜치', exact: true });
    const commits = gitlab.getByRole('region', { name: '커밋', exact: true });
    const refresh = gitlab.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true });
    await expect(branches).toBeVisible({ timeout: 24_000 });
    await expect(branches.locator('[data-gitlab-kind="branch"]')).toHaveAttribute('data-gitlab-state', 'active');
    await expect(branches.getByRole('link', { name: new RegExp(issue.key) })).toHaveAttribute('href', branchUrl);
    await expect(branches.locator('code')).toHaveText(initialHead.slice(0, 8));
    await expect(commits).toHaveCount(0);
    await expect(gitlab.getByRole('region', { name: 'MR', exact: true })).toHaveCount(0);
    const bounds = await gitlab.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);

    const draft = dialog.getByRole('textbox', { name: '제목', exact: true });
    const unsavedTitle = `${issue.title} 작성 중`;
    await draft.fill(unsavedTitle);
    await push(initialHead, pushedHead, [{ id: pushedHead, title: commitTitle, message: commitTitle, url: commitUrl }]);
    await refresh.click();
    await expect(branches.locator('code')).toHaveText(pushedHead.slice(0, 8));
    await expect(commits.getByRole('link', { name: new RegExp(commitTitle) })).toHaveAttribute('href', commitUrl);
    await expect(commits.locator('code')).toHaveText(pushedHead.slice(0, 8));
    await expect(commits).toContainText(branch);
    await expect(commits).not.toContainText('#0');
    await expect(draft).toHaveValue(unsavedTitle);
    await draft.fill(issue.title);

    await push(pushedHead, zero);
    await refresh.click();
    await expect(branches.locator('[data-gitlab-kind="branch"]')).toHaveAttribute('data-gitlab-state', 'deleted');
    await expect(branches).toContainText('삭제됨');
    await expect(branches.getByRole('link')).toHaveCount(0);
    await expect(commits.getByRole('link', { name: new RegExp(commitTitle) })).toHaveAttribute('href', commitUrl);
    await expect(gitlab.getByRole('region', { name: 'MR', exact: true })).toHaveCount(0);
    const saved = await workspace();
    expect(saved.issues.find(value => value.id === issue.id)).toMatchObject({ title: issue.title, version: issue.version, status: issue.status });
    expect(externalRequests).toEqual([]);

    await page.goto(`/#/${project.id}/development`);
    const activity = page.getByRole('region', { name: '연결된 개발 활동', exact: true });
    await expect(activity.getByRole('region', { name: '브랜치', exact: true })).toContainText('삭제됨');
    await expect(activity.getByRole('region', { name: '커밋', exact: true }).getByRole('link', { name: new RegExp(commitTitle) })).toHaveAttribute('href', commitUrl);
  } finally {
    await request.delete(`/api/issues/${issue.id}`);
    const current = await settings();
    if (current.baseUrl === baseUrl) {
      const cleared = await request.patch('/api/integrations/gitlab', { data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '' } });
      expect(cleared.ok(), await cleared.text()).toBeTruthy();
    }
  }
});
