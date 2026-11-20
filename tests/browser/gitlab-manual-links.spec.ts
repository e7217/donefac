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
    if (requestPath === projectPath) res.end(JSON.stringify({ id: repoId, path_with_namespace: 'team/subgroup/repo', web_url: projectUrl() }));
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
    const url = form.getByRole('textbox', { name: 'GitLab MR 또는 파이프라인 URL' });
    await expect(url).toBeFocused();
    await repository.selectOption(String(repoId));
    const copied = `${canonicalUrl()}?diff_id=7#note_80`;
    await url.fill(copied);
    const changed = await request.patch('/api/integrations/gitlab', { data: { expectedVersion: settings.version, projectIds: [repoId] } });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const waitForPost = () => page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'POST');
    const rejected = waitForPost();
    await form.getByRole('button', { name: 'GitLab 링크 연결', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(form.getByRole('alert')).toContainText('GitLab 연결 설정이 변경되었습니다');
    await expect(url).toHaveValue(copied);
    await expect(repository).toHaveValue(String(repoId));
    expect(calls).toEqual([]);

    const first = waitForPost();
    await form.getByRole('button', { name: 'GitLab 링크 연결', exact: true }).click();
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
    await expect(recheck.getByRole('textbox', { name: 'GitLab MR 또는 파이프라인 URL' })).toHaveValue(canonicalUrl());
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
    expect(calls).toEqual([`GET ${projectPath}`, `GET ${objectPath}`, `GET ${projectPath}`, `GET ${objectPath}`]);
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
