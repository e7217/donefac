import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import type { GitlabLink, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

test('360px 티켓에서 번호 없는 GitLab MR을 검증하고 설정 충돌부터 연결 해제까지 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const initial = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const created = await request.post('/api/issues', { data: { projectId: initial.projects[0].id, title: `개발 활동 첨부 ${randomUUID().slice(0, 8)}` } });
  expect(created.status(), await created.text()).toBe(201);
  const issue = await created.json() as Issue;
  const original = await (await request.get('/api/integrations/gitlab')).json() as GitlabSettings;
  expect(original.projectIds).toEqual([]);
  const repoId = 42;
  const title = 'Refine configuration schema';
  const renamed = 'Configuration schema ready';
  const route = `/api/issues/${issue.id}/gitlab-links`;
  const projectPath = `/lab/api/v4/projects/${repoId}`;
  const projectByPath = `/lab/api/v4/projects/${encodeURIComponent('team/subgroup/repo')}`;
  const objectPath = `${projectPath}/merge_requests/11`;
  const calls: string[] = [];
  let baseUrl = '';
  let merged = false;
  const projectUrl = () => `${baseUrl}/team/subgroup/repo`;
  const canonicalUrl = () => `${projectUrl()}/-/merge_requests/11`;
  const epoch = Date.now() - 30_000;
  const mock = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const requestPath = new URL(req.url ?? '/', 'http://fixture.test').pathname;
    res.setHeader('Content-Type', 'application/json');
    if (requestPath === projectPath || requestPath === projectByPath) res.end(JSON.stringify({ id: repoId, path_with_namespace: 'team/subgroup/repo', web_url: projectUrl() }));
    else if (requestPath === objectPath) res.end(JSON.stringify({ id: 444, iid: 11, project_id: repoId, target_project_id: repoId,
      title: merged ? renamed : title, state: merged ? 'merged' : 'opened', updated_at: new Date(epoch + (merged ? 1000 : 0)).toISOString(),
      source_branch: 'feature/configuration', web_url: canonicalUrl(), sha: '3'.repeat(40) }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/lab`;

  try {
    const config = await request.patch('/api/integrations/gitlab', { data: { expectedVersion: original.version, baseUrl, projectIds: [repoId, 77] } });
    expect(config.ok(), await config.text()).toBeTruthy();
    const settings = await config.json() as GitlabSettings;
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
    const issueTitle = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const add = gitlab.getByRole('button', { name: 'GitLab 링크 추가', exact: true });
    await issueTitle.fill('저장 중인 티켓 제목 초안');
    await comment.fill('전송 전 댓글 초안');
    await add.click();
    const form = gitlab.getByRole('form', { name: 'GitLab 링크 추가', exact: true });
    const repository = form.getByRole('combobox', { name: 'GitLab 저장소' });
    const url = form.getByRole('textbox', { name: 'GitLab URL', exact: true });
    await expect(url).toBeFocused();
    const copied = `${canonicalUrl()}?diff_id=7#note_80`;
    await url.fill(copied);
    const connect = form.getByRole('button', { name: 'GitLab 링크 연결', exact: true });
    await expect(repository).toHaveValue('');
    await expect(connect).toBeEnabled();
    const changed = await request.patch('/api/integrations/gitlab', { data: { expectedVersion: settings.version, projectIds: [repoId, 78] } });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const waitForPost = () => page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'POST');
    const rejected = waitForPost();
    await connect.click();
    expect((await rejected).status()).toBe(409);
    await expect(form.getByRole('alert')).toContainText('GitLab 연결 설정이 변경되었습니다');
    await expect(url).toHaveValue(copied);
    await expect(repository).toHaveValue('');
    expect(calls).toEqual([]);

    const first = waitForPost();
    await connect.click();
    const attached = await first;
    expect(attached.status(), await attached.text()).toBe(201);
    const link = await attached.json() as GitlabLink;
    expect(link.webUrl).toBe(canonicalUrl());
    await expect(form).toHaveCount(0);
    await expect(add).toBeFocused();
    const row = gitlab.locator('.gitlab-activity-row').filter({ hasText: title });
    await expect(row.getByRole('link', { name: new RegExp(title) })).toHaveAttribute('href', canonicalUrl());
    await expect(row.getByText('수동 연결', { exact: true })).toBeVisible();

    merged = true;
    await row.getByRole('button', { name: '수동 연결 다시 확인', exact: true }).click();
    const recheck = gitlab.getByRole('form', { name: 'GitLab 링크 다시 확인', exact: true });
    await expect(recheck.getByRole('textbox', { name: 'GitLab URL', exact: true })).toHaveValue(canonicalUrl());
    const second = waitForPost();
    await recheck.getByRole('button', { name: 'GitLab 링크 연결', exact: true }).click();
    const checked = await second;
    expect(checked.status(), await checked.text()).toBe(200);
    expect(await checked.json()).toMatchObject({ id: link.id, manualLinkId: link.manualLinkId, state: 'merged' });
    const current = gitlab.locator('.gitlab-activity-row').filter({ hasText: renamed });
    await expect(current).toHaveAttribute('data-gitlab-state', 'merged');
    await current.getByRole('button', { name: '수동 연결 해제', exact: true }).click();
    const confirm = gitlab.getByRole('group', { name: 'GitLab 연결 해제', exact: true });
    const deleting = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.startsWith(`${route}/`));
    await confirm.getByRole('button', { name: '연결 해제', exact: true }).click();
    const deleted = await deleting;
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect(new URL(deleted.url()).searchParams.get('expectedManualLinkId')).toBe(link.manualLinkId);
    await expect(current).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(issueTitle).toHaveValue('저장 중인 티켓 제목 초안');
    await expect(comment).toHaveValue('전송 전 댓글 초안');
    expect(calls).toEqual([`GET ${projectByPath}`, `GET ${objectPath}`, `GET ${projectPath}`, `GET ${objectPath}`]);

    await add.click();
    await url.fill(copied);
    const attachedAgain = waitForPost();
    await connect.click();
    const newAttachment = await attachedAgain;
    expect(newAttachment.status()).toBe(201);
    const currentLink = await newAttachment.json() as GitlabLink;
    await current.getByRole('button', { name: '수동 연결 다시 확인', exact: true }).click();
    const recheckSubmit = recheck.getByRole('button', { name: 'GitLab 링크 연결', exact: true });
    await expect(recheckSubmit).toBeEnabled();
    const readCount = calls.length;
    const coworkerRemoved = await request.delete(`${route}/${encodeURIComponent(currentLink.id)}`, {
      params: { expectedManualLinkId: currentLink.manualLinkId! }, headers: { 'X-Actor-Id': initial.users[1].id },
    });
    expect(coworkerRemoved.ok()).toBeTruthy();
    const stale = waitForPost();
    await recheckSubmit.click();
    const refusal = await stale;
    expect(refusal.status()).toBe(409);
    expect(refusal.request().postDataJSON()).toMatchObject({ expectedLinkId: currentLink.id, expectedManualLinkId: currentLink.manualLinkId });
    await expect(recheck.getByRole('alert')).toContainText('GitLab 수동 연결이 변경되었습니다');
    await expect(current).toHaveCount(0);
    await expect(recheck).toHaveAttribute('aria-busy', 'false');
    await expect(recheckSubmit).toBeDisabled();
    expect(calls).toHaveLength(readCount);
    await recheck.getByRole('button', { name: '취소', exact: true }).click();
    await expect(add).toBeFocused();
    await expect(issueTitle).toHaveValue('저장 중인 티켓 제목 초안');
    await expect(comment).toHaveValue('전송 전 댓글 초안');
  } finally {
    const removed = await request.delete(`/api/issues/${issue.id}`);
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
    const settings = await (await request.get('/api/integrations/gitlab')).json() as GitlabSettings;
    await request.patch('/api/integrations/gitlab', { data: { expectedVersion: settings.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '' } });
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
  }
});

test('360px 티켓에서 번호 없는 브랜치와 커밋을 연결하고 브랜치의 삭제·복원을 확인한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const initial = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const created = await request.post('/api/issues', { data: { projectId: initial.projects[0].id, title: `기존 코드 연결 ${randomUUID().slice(0, 8)}` } });
  expect(created.status(), await created.text()).toBe(201);
  const issue = await created.json() as Issue;
  const original = await (await request.get('/api/integrations/gitlab')).json() as GitlabSettings;
  expect(original.projectIds).toEqual([]);

  const repoId = 42;
  const repo = 'team/subgroup/product';
  const branch = 'feature/existing/work';
  const commitTitle = 'Keep the initial behavior';
  const originalSha = 'abc123ef'.repeat(5);
  const restoredSha = '345678fe'.repeat(5);
  const zero = '0'.repeat(40);
  const webhookSecret = `synthetic-branch-${randomUUID()}`;
  const route = `/api/issues/${issue.id}/gitlab-links`;
  const projectPath = `/lab/api/v4/projects/${repoId}`;
  const branchPath = `${projectPath}/repository/branches/${encodeURIComponent(branch)}`;
  const commitPath = `${projectPath}/repository/commits/${originalSha}`;
  const branchWebPath = `/lab/${repo}/-/tree/${encodeURIComponent(branch)}`;
  const commitWebPath = `/lab/${repo}/-/commit/${originalSha}`;
  const stamped = new Date(Date.now() - 30_000).toISOString();
  const calls: string[] = [];
  let origin = '';
  let branchHead: string | null = originalSha;
  const mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.test');
    const path = url.pathname;
    if (path === branchWebPath || path === commitWebPath) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (path === commitWebPath) res.end(commitTitle);
      else res.end(url.searchParams.get('ref_type') === 'heads' ? branch : 'Tag of the same name');
      return;
    }
    calls.push(`${req.method} ${path}`);
    res.setHeader('Content-Type', 'application/json');
    if (path === projectPath) res.end(JSON.stringify({ id: repoId, path_with_namespace: repo, web_url: `${origin}/lab/${repo}` }));
    else if (path === branchPath && branchHead) res.end(JSON.stringify({ name: branch, commit: { id: branchHead, committed_date: stamped } }));
    else if (path === commitPath) res.end(JSON.stringify({ id: originalSha, title: commitTitle, committed_date: stamped }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  origin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const baseUrl = `${origin}/lab`;
  const branchUrl = `${origin}${branchWebPath}`;
  const branchVisitUrl = `${branchUrl}?ref_type=heads`;
  const commitUrl = `${origin}${commitWebPath}`;
  const push = async (before: string, after: string) => {
    const response = await request.post('/api/integrations/gitlab/webhook', {
      headers: { 'X-Gitlab-Token': webhookSecret, 'X-Gitlab-Event': 'Push Hook', 'webhook-id': randomUUID() },
      data: { object_kind: 'push', project_id: repoId, ref: `refs/heads/${branch}`, before, after, checkout_sha: after === zero ? null : after,
        commits: [], total_commits_count: 0, project: { id: repoId, web_url: `${baseUrl}/${repo}`, path_with_namespace: repo } },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };

  try {
    const configured = await request.patch('/api/integrations/gitlab', {
      data: { expectedVersion: original.version, baseUrl, projectIds: [repoId], webhookSecret },
    });
    expect(configured.ok(), await configured.text()).toBeTruthy();
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
    const add = gitlab.getByRole('button', { name: 'GitLab 링크 추가', exact: true });
    const refresh = gitlab.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true });
    const waitForPost = () => page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'POST');
    const addLink = async (url: string) => {
      await add.click();
      const form = gitlab.getByRole('form', { name: 'GitLab 링크 추가', exact: true });
      const input = form.getByRole('textbox', { name: 'GitLab URL', exact: true });
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleDescription(/브랜치, 전체 SHA가 포함된 커밋/);
      await expect(form.getByRole('combobox', { name: 'GitLab 저장소' })).toHaveValue(String(repoId));
      await input.fill(url);
      const response = waitForPost();
      await form.getByRole('button', { name: 'GitLab 링크 연결', exact: true }).click();
      const attached = await response;
      expect(attached.status(), await attached.text()).toBe(201);
      await expect(form).toHaveCount(0);
      await expect(add).toBeFocused();
      return await attached.json() as GitlabLink;
    };

    const manualBranch = await addLink(`${baseUrl}/${repo}/-/tree/${branch}?ref_type=heads`);
    const manualCommit = await addLink(`${commitUrl}#notes`);
    expect(manualBranch).toMatchObject({ kind: 'branch', sourceBranch: branch, sourceSha: originalSha, state: 'active', webUrl: branchUrl });
    expect(manualCommit).toMatchObject({ kind: 'commit', sourceSha: originalSha, state: 'committed', webUrl: commitUrl });
    expect(manualBranch.originalJiraKey).toBeUndefined();
    expect(manualCommit.originalJiraKey).toBeUndefined();
    expect(manualBranch.manualLinkId).toBeTruthy();
    expect(manualCommit.manualLinkId).toBeTruthy();
    expect(calls).toEqual([`GET ${projectPath}`, `GET ${branchPath}`, `GET ${projectPath}`, `GET ${commitPath}`]);

    const branches = gitlab.getByRole('region', { name: '브랜치', exact: true });
    const commits = gitlab.getByRole('region', { name: '커밋', exact: true });
    const branchLink = branches.getByRole('link', { name: new RegExp(branch) });
    const commitLink = commits.getByRole('link', { name: new RegExp(commitTitle) });
    await expect(branches.getByText('수동 연결', { exact: true })).toBeVisible();
    await expect(commits.getByText('수동 연결', { exact: true })).toBeVisible();
    await expect(branchLink).toHaveAttribute('href', branchVisitUrl);
    await expect(commitLink).toHaveAttribute('href', commitUrl);
    await expect(commits.locator('code')).toHaveText(originalSha.slice(0, 8));
    const bounds = await gitlab.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
    for (const [link, url, title] of [[branchLink, branchVisitUrl, branch], [commitLink, commitUrl, commitTitle]] as const) {
      const opened = page.waitForEvent('popup');
      await link.click();
      const popup = await opened;
      await expect(popup).toHaveURL(url);
      await expect(popup.locator('body')).toContainText(title);
      await popup.close();
    }

    branchHead = null;
    await push(originalSha, zero);
    await refresh.click();
    await expect(branches.getByText('삭제됨', { exact: true })).toBeVisible();
    await expect(branches.getByText('수동 연결', { exact: true })).toBeVisible();
    await expect(branches.getByRole('link')).toHaveCount(0);
    await expect(commitLink).toHaveAttribute('href', commitUrl);
    await branches.getByRole('button', { name: '수동 연결 다시 확인', exact: true }).click();
    const recheck = gitlab.getByRole('form', { name: 'GitLab 링크 다시 확인', exact: true });
    await expect(recheck.getByRole('textbox', { name: 'GitLab URL', exact: true })).toHaveValue(branchUrl);
    const missing = waitForPost();
    await recheck.getByRole('button', { name: 'GitLab 링크 연결', exact: true }).click();
    expect((await missing).status()).toBe(404);
    await expect(recheck.getByRole('alert')).toBeVisible();
    await recheck.getByRole('button', { name: '취소', exact: true }).click();

    branchHead = restoredSha;
    await push(zero, restoredSha);
    await refresh.click();
    await expect(branches.getByText('활성', { exact: true })).toBeVisible();
    await expect(branchLink).toHaveAttribute('href', branchVisitUrl);
    await expect(branches.locator('code')).toHaveText(restoredSha.slice(0, 8));

    branchHead = originalSha;
    await branches.getByRole('button', { name: '수동 연결 다시 확인', exact: true }).click();
    await expect(recheck.getByRole('textbox', { name: 'GitLab URL', exact: true })).toHaveValue(branchUrl);
    const staleHead = waitForPost();
    await recheck.getByRole('button', { name: 'GitLab 링크 연결', exact: true }).click();
    expect((await staleHead).status()).toBe(409);
    await expect(recheck.getByRole('alert')).toContainText('푸시 기록과 다릅니다');
    await expect(branches.locator('code')).toHaveText(restoredSha.slice(0, 8));
    await recheck.getByRole('button', { name: '취소', exact: true }).click();
    await expect(branches.getByRole('button', { name: '수동 연결 다시 확인', exact: true })).toBeFocused();

    const saved = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(saved.issues.find(value => value.id === issue.id)).toMatchObject({ status: issue.status, version: issue.version });
    expect(saved.gitlabLinks.find(value => value.id === manualBranch.id)).toMatchObject({ manualLinkId: manualBranch.manualLinkId, sourceSha: restoredSha });

    for (const [region, link] of [[branches, manualBranch], [commits, manualCommit]] as const) {
      await region.getByRole('button', { name: '수동 연결 해제', exact: true }).click();
      const confirm = gitlab.getByRole('group', { name: 'GitLab 연결 해제', exact: true });
      const deleting = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.startsWith(`${route}/`));
      await confirm.getByRole('button', { name: '연결 해제', exact: true }).click();
      const deleted = await deleting;
      expect(deleted.status(), await deleted.text()).toBe(200);
      expect(new URL(deleted.url()).searchParams.get('expectedManualLinkId')).toBe(link.manualLinkId);
      await expect(region).toHaveCount(0);
      await expect(add).toBeFocused();
    }
  } finally {
    const removed = await request.delete(`/api/issues/${issue.id}`);
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
    const current = await (await request.get('/api/integrations/gitlab')).json() as GitlabSettings;
    if (current.baseUrl === baseUrl) await request.patch('/api/integrations/gitlab', {
      data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '' },
    });
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
  }
});
