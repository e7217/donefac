import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse } from '@playwright/test';
import type { GitlabIssueBranchResult, GitlabIssueBranchReview, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

test('360px 티켓에서 GitLab 브랜치 응답 유실을 확인하고 삭제 후 같은 이름으로 다시 만든다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const original = await json<GitlabSettings>(await request.get('/api/integrations/gitlab'));
  expect(original.projectIds).toEqual([]);
  const issue = await json<Issue>(await request.post('/api/issues', {
    headers, data: { projectId: project.id, title: `브랜치 생성 업무 ${randomUUID().slice(0, 8)}` },
  }), 201);

  const repoId = 42;
  const repositoryPath = 'team/subgroup/product';
  const defaultBranch = 'main';
  const branch = `feature/${issue.key}`;
  const sha = 'ab12cd34'.repeat(5);
  let defaultHead = sha;
  const readToken = `synthetic-read-${randomUUID()}`;
  const writeToken = `synthetic-write-${randomUUID()}`;
  const webhookSecret = `synthetic-push-${randomUUID()}`;
  const projectPath = `/lab/api/v4/projects/${repoId}`;
  const branchCollection = `${projectPath}/repository/branches`;
  const targetBranchPath = `${branchCollection}/${encodeURIComponent(branch)}`;
  const calls: { method?: string; path: string; credential: 'read' | 'write' | 'unknown'; input?: unknown }[] = [];
  let baseUrl = '';
  let remoteHead: string | null = null;
  let disconnectAfterCreate = true;
  const mock = createServer(async (req, res) => {
    const { pathname: path } = new URL(req.url ?? '/', 'http://fixture.test');
    const token = req.headers['private-token'];
    const credential = token === readToken ? 'read' : token === writeToken ? 'write' : 'unknown';
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'POST' && path === branchCollection) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { branch?: string; ref?: string };
      calls.push({ method: req.method, path, credential, input });
      if (credential !== 'write') return send({}, 403);
      if (input.branch !== branch || input.ref !== (disconnectAfterCreate ? sha : defaultHead) || remoteHead !== null) return send({}, 400);
      remoteHead = input.ref;
      if (disconnectAfterCreate) res.destroy();
      else send({ name: branch, commit: { id: remoteHead } }, 201);
      return;
    }
    calls.push({ method: req.method, path, credential });
    if (req.method !== 'GET' || credential === 'unknown') return send({}, 403);
    if (path === projectPath) return send({ id: repoId, path_with_namespace: repositoryPath, web_url: `${baseUrl}/${repositoryPath}`, default_branch: defaultBranch });
    if (path === `${projectPath}/merge_requests`) return send([]);
    if (path === `${branchCollection}/${defaultBranch}`) return send({ name: defaultBranch, commit: { id: defaultHead } });
    if (path === targetBranchPath && remoteHead) return send({ name: branch, commit: { id: remoteHead } });
    return send({}, 404);
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/lab`;
  const branchUrl = `${baseUrl}/${repositoryPath}/-/tree/${encodeURIComponent(branch)}`;

  try {
    const settings = await json<GitlabSettings>(await request.patch('/api/integrations/gitlab', {
      headers, data: { expectedVersion: original.version, baseUrl, projectIds: [repoId], token: readToken, webhookSecret },
    }));
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const query = new URLSearchParams({ boardQuery: issue.title });
    await page.goto(`/#/${project.id}/teamboard?${query}`);
    const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
    await board.getByRole('button', { name: `${issue.key} 업무 열기`, exact: true }).click({ timeout: 35_000 });
    const ticketLocation = page.url();
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const issueTitle = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const titleDraft = `${issue.title} 수정 중`;
    const commentDraft = '브랜치 연결과 함께 작성 중인 댓글';
    await issueTitle.fill(titleDraft);
    await comment.fill(commentDraft);

    const gitlab = ticket.getByRole('region', { name: 'GitLab', exact: true });
    const opener = gitlab.getByRole('button', { name: 'GitLab 브랜치 만들기', exact: true });
    await opener.click();
    const form = gitlab.getByRole('form', { name: 'GitLab 브랜치 만들기', exact: true });
    await expect(form.getByRole('combobox', { name: 'GitLab 저장소', exact: true })).toHaveValue(String(repoId));
    await expect(form.getByRole('textbox', { name: '브랜치 이름', exact: true })).toHaveValue(branch);
    await expect(form.getByRole('textbox', { name: '기준 브랜치 또는 커밋', exact: true })).toHaveValue('');

    const waitForAction = (action: 'preview' | 'apply' | 'reconcile') => page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/issues/${issue.id}/gitlab-branch/${action}`);
    const previewResponse = waitForAction('preview');
    await form.getByRole('button', { name: '브랜치 미리보기', exact: true }).click();
    const reviewedHttp = await previewResponse;
    const review = await json<GitlabIssueBranchReview>(reviewedHttp);
    const target = { repositoryId: repoId, repositoryPath, branch, ref: defaultBranch, sourceSha: sha, webUrl: branchUrl };
    expect(review).toMatchObject({ state: 'ready', target });
    await expect(form.getByText(repositoryPath, { exact: true })).toBeVisible();
    await expect(form.getByText(defaultBranch, { exact: true })).toBeVisible();
    await expect(form.getByText(sha, { exact: true })).toBeVisible();
    expect(reviewedHttp.request().postDataJSON()).toEqual({ expectedSettingsVersion: settings.version, repositoryId: repoId, branch });
    expect(calls.every(call => call.method === 'GET' && call.credential === 'read')).toBe(true);
    expect(calls.some(call => call.path === targetBranchPath)).toBe(true);
    expect(remoteHead).toBeNull();

    await page.route(`**/api/issues/${issue.id}/gitlab-branch/apply`, route => route.abort('connectionreset'), { times: 1 });
    await form.getByLabel('GitLab API 토큰', { exact: true }).fill(writeToken);
    await form.getByRole('button', { name: 'GitLab 브랜치 만들기', exact: true }).click();
    const unavailable = waitForAction('reconcile');
    await form.getByRole('button', { name: '생성 결과 다시 확인', exact: true }).click();
    expect((await unavailable).status()).toBe(404);
    await expect(form.getByRole('alert')).toContainText('저장한 생성 요청이 없습니다');
    await expect(form.getByRole('textbox', { name: '브랜치 이름', exact: true })).toBeEnabled();
    expect(calls.some(call => call.method === 'POST')).toBe(false);
    const refreshPreview = waitForAction('preview');
    await form.getByRole('button', { name: '브랜치 미리보기', exact: true }).click();
    const reviewedAgain = await json<GitlabIssueBranchReview>(await refreshPreview);
    expect(reviewedAgain).toMatchObject({ state: 'ready', target });
    await expect(form.getByText(sha, { exact: true })).toBeVisible();
    defaultHead = 'bc23de45'.repeat(5);

    await form.getByLabel('GitLab API 토큰', { exact: true }).fill(writeToken);
    const applyResponse = waitForAction('apply');
    await form.getByRole('button', { name: 'GitLab 브랜치 만들기', exact: true }).click();
    const appliedHttp = await applyResponse;
    const pending = await json<GitlabIssueBranchResult>(appliedHttp);
    expect(pending).toMatchObject({ state: 'pending', target });
    expect(pending.link).toBeUndefined();
    expect(appliedHttp.request().postDataJSON()).toEqual({ previewId: 'previewId' in reviewedAgain ? reviewedAgain.previewId : undefined, writeToken });
    await expect(form.getByLabel('GitLab API 토큰', { exact: true })).toHaveCount(0);
    expect(remoteHead).toBe(sha);
    const beforeReconcile = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(beforeReconcile.gitlabLinks.filter(link => link.issueId === issue.id)).toEqual([]);

    const reconcileResponse = waitForAction('reconcile');
    await form.getByRole('button', { name: '생성 결과 다시 확인', exact: true }).click();
    const reconciledHttp = await reconcileResponse;
    const found = await json<GitlabIssueBranchResult>(reconciledHttp);
    expect(found).toMatchObject({ state: 'found', target, observedSha: sha, link: {
      issueId: issue.id, projectId: repoId, kind: 'branch', sourceBranch: branch, sourceSha: sha, webUrl: branchUrl,
    } });
    expect(reconciledHttp.request().postDataJSON()).toEqual({ expectedSettingsVersion: settings.version, repositoryId: repoId, branch });
    expect(JSON.stringify([review, pending, found])).not.toContain(writeToken);
    expect(calls.filter(call => call.method === 'POST')).toEqual([
      { method: 'POST', path: branchCollection, credential: 'write', input: { branch, ref: sha } },
    ]);
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: targetBranchPath, credential: 'read' });
    await expect(form.getByRole('link', { name: 'GitLab에서 브랜치 열기', exact: true })).toHaveAttribute('href', `${branchUrl}?ref_type=heads`);

    await form.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(opener).toBeFocused();
    const branchActivity = gitlab.getByRole('region', { name: '브랜치', exact: true });
    await expect(branchActivity.getByRole('link', { name: `${branch} GitLab에서 새 탭으로 열기`, exact: true }))
      .toHaveAttribute('href', `${branchUrl}?ref_type=heads`);
    await expect(issueTitle).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    expect(page.url()).toBe(ticketLocation);
    const snapshot = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(snapshot.issues.find(value => value.id === issue.id)).toMatchObject({ title: issue.title, status: issue.status });
    expect(snapshot.gitlabLinks.filter(link => link.issueId === issue.id)).toEqual([found.link]);

    remoteHead = null;
    disconnectAfterCreate = false;
    const deleted = await json<{ linked: number }>(await request.post('/api/integrations/gitlab/webhook', {
      headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() },
      data: { object_kind: 'push', project_id: repoId, ref: `refs/heads/${branch}`, before: sha, after: '0'.repeat(40), commits: [],
        project: { id: repoId, web_url: `${baseUrl}/${repositoryPath}`, path_with_namespace: repositoryPath } },
    }));
    expect(deleted.linked).toBe(1);
    const activityScope = gitlab.getByRole('combobox', { name: 'GitLab 활동 범위', exact: true });
    const activitySearch = gitlab.getByRole('searchbox', { name: 'GitLab 활동 검색', exact: true });
    await activityScope.selectOption('pipeline');
    await activitySearch.fill('existing pipeline query');
    await gitlab.getByRole('button', { name: '검색', exact: true }).click();
    await expect(branchActivity).toHaveCount(0);
    await opener.click();
    await expect(form.getByRole('textbox', { name: '브랜치 이름', exact: true })).toHaveValue(branch);
    const replacementResponse = waitForAction('preview');
    await form.getByRole('button', { name: '브랜치 미리보기', exact: true }).click();
    const replacement = await json<GitlabIssueBranchReview>(await replacementResponse);
    expect(replacement).toMatchObject({ state: 'ready', target: { ...target, sourceSha: defaultHead } });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);

    await form.getByLabel('GitLab API 토큰', { exact: true }).fill(writeToken);
    const recreateResponse = waitForAction('apply');
    await form.getByRole('button', { name: 'GitLab 브랜치 만들기', exact: true }).click();
    const recreated = await json<GitlabIssueBranchResult>(await recreateResponse, 201);
    expect(recreated).toMatchObject({ state: 'created', link: { id: found.link?.id, state: 'active', sourceSha: defaultHead } });
    expect(calls.filter(call => call.method === 'POST').map(call => call.input)).toEqual([
      { branch, ref: sha }, { branch, ref: defaultHead },
    ]);
    const callsBeforeHandoff = calls.length;
    await form.getByRole('button', { name: '티켓에서 연결한 브랜치 보기', exact: true }).click();
    await expect(form).toHaveCount(0);
    const revealedBranch = branchActivity.locator(`[data-gitlab-link-id="${recreated.link?.id}"]`);
    await expect(revealedBranch).toBeFocused();
    await expect(revealedBranch.getByRole('link', { name: `${branch} GitLab에서 새 탭으로 열기`, exact: true }))
      .toHaveAttribute('href', `${branchUrl}?ref_type=heads`);
    await expect(gitlab.getByText('현재 활동 필터 범위 밖의 브랜치를 함께 표시했습니다.', { exact: true })).toBeVisible();
    await expect(activityScope).toHaveValue('pipeline');
    await expect(activitySearch).toHaveValue('existing pipeline query');
    expect(calls).toHaveLength(callsBeforeHandoff);
    await revealedBranch.getByRole('button', { name: '브랜치 MR 확인', exact: true }).click();
    await expect(revealedBranch.getByRole('region', { name: 'GitLab 브랜치 MR', exact: true }))
      .toContainText('이 브랜치에 열린 MR이 없습니다.');
    expect(calls.slice(callsBeforeHandoff).every(call => call.method === 'GET' && call.credential === 'read')).toBeTruthy();
    await expect(issueTitle).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    expect(page.url()).toBe(ticketLocation);
    await activityScope.selectOption('commit');
    await expect(branchActivity).toHaveCount(0);
  } finally {
    try {
      const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
      const settings = await json<GitlabSettings>(await request.get('/api/integrations/gitlab'));
      await request.patch('/api/integrations/gitlab', { headers, data: { expectedVersion: settings.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '' } });
    } finally {
      mock.closeAllConnections();
      await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
    }
  }
});
