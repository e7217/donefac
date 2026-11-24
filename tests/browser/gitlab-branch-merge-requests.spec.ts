import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import type { GitlabLink, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

test('360px 티켓과 개발 화면에서 연결 브랜치의 MR과 새 MR의 대상 브랜치를 확인한다', async ({ page, request, context }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 360, height: 820 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const original = await (await request.get('/api/integrations/gitlab')).json() as GitlabSettings;
  expect(original.projectIds).toEqual([]);
  const created = await request.post('/api/issues', { data: { projectId: workspace.projects[0].id, title: '배포 설정 검토' } });
  expect(created.status(), await created.text()).toBe(201);
  const issue = await created.json() as Issue;
  const repositoryId = 42;
  const sourceBranch = 'feature/deploy-config';
  const customBranch = 'release/17.4+rc';
  const branchShas = new Map([[sourceBranch, '1'.repeat(40)], ['main', '2'.repeat(40)], [customBranch, '3'.repeat(40)]]);
  const projectPath = `/forge/api/v4/projects/${repositoryId}`;
  const listPath = `${projectPath}/merge_requests`;
  const branchesPath = `${projectPath}/repository/branches/`;
  const token = 'synthetic-branch-mr-read-token';
  const timestamp = new Date(Date.now() - 20_000).toISOString();
  const calls: { method: string | undefined; url: URL; token: string | string[] | undefined }[] = [];
  let projectUrl = '';
  let hasExisting = true;
  const mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.test');
    calls.push({ method: req.method, url, token: req.headers['private-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === projectPath) {
      res.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/app', web_url: projectUrl, default_branch: 'main' }));
      return;
    }
    if (url.pathname === listPath) {
      const existing = { id: 811, iid: 11, source_project_id: repositoryId, target_project_id: repositoryId, source_branch: sourceBranch,
        target_branch: 'main', state: 'opened', title: 'Review deployment config', web_url: `${projectUrl}/-/merge_requests/11` };
      const fork = { ...existing, id: 812, iid: 12, source_project_id: 77, web_url: `${projectUrl}/-/merge_requests/12` };
      res.end(JSON.stringify(hasExisting ? [fork, existing] : [fork]));
      return;
    }
    if (url.pathname.startsWith(branchesPath)) {
      const name = decodeURIComponent(url.pathname.slice(branchesPath.length));
      const sha = branchShas.get(name);
      if (sha) {
        res.end(JSON.stringify({ name, commit: { id: sha, committed_date: timestamp } }));
        return;
      }
    }
    res.statusCode = 404;
    res.end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;
  projectUrl = `${baseUrl}/team/app`;
  const linksRoute = `/api/issues/${issue.id}/gitlab-links`;

  try {
    const configured = await request.patch('/api/integrations/gitlab', { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token,
    } });
    expect(configured.ok(), await configured.text()).toBeTruthy();
    const settings = await configured.json() as GitlabSettings;
    const attached = await request.post(linksRoute, { data: {
      repositoryId, expectedSettingsVersion: settings.version, url: `${projectUrl}/-/tree/${sourceBranch}?ref_type=heads`,
    } });
    expect(attached.status(), await attached.text()).toBe(201);
    const link = await attached.json() as GitlabLink;
    const attachedWorkspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const readPath = `${linksRoute}/${encodeURIComponent(link.id)}/branch-merge-requests`;
    const start = calls.length;
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const toggle = gitlab.getByRole('button', { name: '브랜치 MR 확인', exact: true });
    await expect(toggle).toBeVisible();
    expect(calls).toHaveLength(start);
    await title.fill('저장 전 제목 초안');
    await comment.fill('전송 전 검토 댓글');
    const initialRead = page.waitForResponse(response => new URL(response.url()).pathname === readPath);
    await toggle.click();
    const checked = await initialRead;
    expect(checked.ok(), await checked.text()).toBeTruthy();
    const lookup = gitlab.getByRole('region', { name: 'GitLab 브랜치 MR' });
    const launch = lookup.getByRole('link', { name: 'GitLab에서 새 MR 열기', exact: true });
    const existing = lookup.getByRole('link', { name: 'MR !11 열기' });
    await expect(existing).toHaveAttribute('href', `${projectUrl}/-/merge_requests/11`);
    await expect(existing).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(launch).toHaveCount(0);

    hasExisting = false;
    await lookup.getByRole('button', { name: '브랜치 MR 다시 확인', exact: true }).click();
    const assertLaunch = async (targetBranch: string) => {
      const expectedQuery = new URLSearchParams({ 'merge_request[source_branch]': sourceBranch,
        'merge_request[target_branch]': targetBranch, 'merge_request[source_project_id]': String(repositoryId),
        'merge_request[target_project_id]': String(repositoryId) });
      expectedQuery.sort();
      await expect(launch).toBeVisible();
      await expect.poll(async () => {
        const actual = new URL((await launch.getAttribute('href'))!);
        actual.searchParams.sort();
        return actual.href;
      }).toBe(`${projectUrl}/-/merge_requests/new?${expectedQuery.toString()}`);
      await expect(launch).toHaveAttribute('rel', 'noopener noreferrer');
    };
    await assertLaunch('main');
    await lookup.getByRole('textbox', { name: '대상 브랜치', exact: true }).fill(customBranch);
    await expect(launch).toHaveCount(0);
    await lookup.getByRole('button', { name: '대상 브랜치 확인', exact: true }).click();
    await assertLaunch(customBranch);
    await lookup.getByRole('button', { name: 'MR 제목 복사', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`[${issue.key}] ${issue.title}`);
    await expect(title).toHaveValue('저장 전 제목 초안');
    await expect(comment).toHaveValue('전송 전 검토 댓글');
    const current = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(current.gitlabLinks.filter(item => item.issueId === issue.id)).toEqual([link]);
    expect(current.issues.find(item => item.id === issue.id)).toEqual(attachedWorkspace.issues.find(item => item.id === issue.id));

    const development = await context.newPage();
    await development.setViewportSize({ width: 360, height: 820 });
    await development.goto(`/#/${issue.projectId}/development`);
    await development.getByRole('button', { name: '브랜치 MR 확인', exact: true }).click();
    await expect(development.getByRole('region', { name: 'GitLab 브랜치 MR' }).getByRole('link', { name: 'GitLab에서 새 MR 열기' })).toBeVisible();
    await development.close();
    const reads = calls.slice(start);
    expect(reads.every(call => call.method === 'GET' && call.token === token)).toBeTruthy();
    const listReads = reads.filter(call => call.url.pathname === listPath);
    expect(listReads).toHaveLength(4);
    for (const { url } of listReads) {
      expect(url.searchParams.get('scope')).toBe('all');
      expect(url.searchParams.get('state')).toBe('opened');
      expect(url.searchParams.get('source_branch')).toBe(sourceBranch);
    }
  } finally {
    const removed = await request.delete(`/api/issues/${issue.id}`);
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
    const current = await (await request.get('/api/integrations/gitlab')).json() as GitlabSettings;
    await request.patch('/api/integrations/gitlab', { data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '' } });
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
  }
});
