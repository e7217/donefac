import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Locator } from '@playwright/test';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type { GitlabSettings, Issue, Project, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const repositoryId = 42;
const button = (parent: Locator, name: string) => parent.getByRole('button', { name, exact: true });

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

test('360px 개발 활동에서 최신 실패 연결만 골라 티켓을 검토하고 같은 목록으로 돌아온다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 8);
  const refMarker = `ci-triage-${suffix}`;
  const repoName = `review-repository-${suffix}`;
  const secret = `synthetic-development-${randomUUID()}`;
  const token = `synthetic-development-read-${randomUUID()}`;
  const remoteCalls: string[] = [];
  const remote = createServer((incoming, response) => {
    remoteCalls.push(`${incoming.method} ${incoming.url}`);
    response.writeHead(503).end();
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const baseUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/gitlab`;
  const projectUrl = `${baseUrl}/team/${repoName}`;
  const snapshot = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const settings = () => request.get(settingsPath).then(response => json<GitlabSettings>(response));
  const issueIds = new Set<string>();
  async function createIssue(project: Project, label: string) {
    const issue = await json<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `개발 활동 ${label} ${suffix}`,
    } }), 201);
    issueIds.add(issue.id);
    return issue;
  }
  const at = Date.now() - 90_000;
  const timestamp = (index: number) => new Date(at + index * 1000).toISOString();
  const ref = (issue: Issue, group: string) => `feature/${issue.key}/${refMarker}-${group}`;
  const send = async (kind: 'pipeline' | 'merge_request', attributes: object) => {
    const result = await json<{ duplicate: boolean; linked: number }>(await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Event': kind === 'pipeline' ? 'Pipeline Hook' : 'Merge Request Hook',
        'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
      data: { object_kind: kind, project: { id: repositoryId, web_url: projectUrl }, object_attributes: attributes },
    }));
    expect(result).toMatchObject({ duplicate: false, linked: 1 });
  };
  const pipeline = (id: number, branch: string, status: string, index: number) => send('pipeline', {
    id, ref: branch, status, source: 'push', tag: false, sha: 'a'.repeat(40), updated_at: timestamp(index),
  });

  try {
    const { projects: [project, previousProject] } = await snapshot();
    const originalSettings = await settings();
    expect(originalSettings.baseUrl).toBe('');
    const configured = await json<GitlabSettings>(await request.patch(settingsPath, { data: {
      expectedVersion: originalSettings.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    const first = await createIssue(project, '여러 브랜치 확인');
    const former = await createIssue(previousProject, '이동한 업무');
    const last = await createIssue(project, '다음 업무');
    const recovered = await createIssue(project, '복구된 업무');
    const movePath = `/api/issues/${former.id}/project-move`;
    const move: IssueProjectMoveInput = { expectedVersion: former.version, projectId: project.id, includeConnected: false, mappings: [] };
    const preview = await json<IssueProjectMovePreview>(await request.post(`${movePath}/preview`, { data: move }));
    expect(preview.token, JSON.stringify(preview.blockers)).toBeTruthy();
    const { issues: [moved] } = await json<IssueProjectMoveResult>(await request.post(`${movePath}/apply`, { data: { ...move, token: preview.token } }));
    expect(moved.key).not.toBe(former.key);

    await pipeline(1001, ref(last, 'last'), 'failed', 1);
    await pipeline(1002, ref(moved, 'moved'), 'failed', 2);
    for (let index = 3; index <= 14; index++) await pipeline(1000 + index, ref(first, `first-${index}`), 'failed', index);
    await pipeline(1092, ref(recovered, 'replaced'), 'success', 30);
    await pipeline(1091, ref(recovered, 'replaced'), 'failed', 31);
    await pipeline(1093, ref(first, 'manual'), 'manual', 32);
    await send('merge_request', {
      id: 1101, iid: 71, title: `${first.key} 합성 검토`, state: 'opened', action: 'open',
      target_project_id: repositoryId, source_branch: ref(first, 'mr'), detailed_merge_status: 'not_approved',
      url: `${projectUrl}/-/merge_requests/71`, updated_at: timestamp(33),
    });
    const before = await snapshot();
    expect(before.issueAliases?.[moved.id]).toContainEqual({ key: former.key, source: 'move' });
    expect(before.gitlabLinks.filter(link => link.issueId === recovered.id).map(link => [link.iid, link.state]).sort())
      .toEqual([[1091, 'failed'], [1092, 'success']]);
    expect(before.gitlabLinks.find(link => link.kind === 'merge_request' && link.issueId === first.id)?.mergeReadiness?.state)
      .toBe('approval_required');

    const prompts: string[] = [];
    const unexpectedRequests: string[] = [];
    page.on('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); });
    page.on('request', sent => {
      const url = new URL(sent.url());
      if (url.origin === new URL(baseUrl).origin || url.pathname.startsWith('/api/') &&
          (!['GET', 'HEAD'].includes(sent.method()) || /^\/api\/issues\/[^/]+\/gitlab-links\//u.test(url.pathname))) {
        unexpectedRequests.push(`${sent.method()} ${url.pathname}`);
      }
    });
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/development`);
    const feed = page.getByRole('region', { name: '연결된 개발 활동', exact: true });
    const scope = feed.getByRole('combobox', { name: '개발 활동 범위', exact: true });
    const query = feed.getByRole('searchbox', { name: '개발 활동 검색', exact: true });
    const pipelineGroup = feed.getByRole('region', { name: '파이프라인', exact: true });
    const rows = pipelineGroup.locator('.gitlab-activity-row');
    const row = (iid: number) => rows.filter({ has: page.getByText(`#${iid}`, { exact: true }) });
    const pages = pipelineGroup.getByRole('navigation', { name: '파이프라인 페이지 이동', exact: true });
    const draft = page.getByLabel('읽기 API 토큰', { exact: true });
    const search = async (value: string) => { await query.fill(value); await query.press('Enter'); };

    await page.getByRole('button', { name: '연결 설정으로 이동', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'GitLab 연결', exact: true })).toBeFocused();
    await expect(draft).toBeEnabled();
    await expect(scope).toHaveValue('all');
    await expect(row(1091)).toBeVisible();
    await draft.fill('저장하지 않은 연결 초안');
    await search(repoName);
    await scope.selectOption('manual_pipelines');
    await expect(rows).toHaveCount(1);
    await expect(row(1093)).toBeVisible();
    await scope.selectOption('blocked_merge_requests');
    await expect(feed.locator('.gitlab-activity-row')).toHaveCount(1);
    await expect(feed.getByText('승인 대기', { exact: true })).toBeVisible();
    await scope.selectOption('failed_pipelines');
    await search(former.key.toLowerCase());
    await expect(rows).toHaveCount(1);
    await expect(button(row(1002), moved.key)).toBeVisible();
    await search(last.key);
    await expect(rows).toHaveCount(1);
    await expect(row(1001)).toBeVisible();
    await search(refMarker);
    await expect(rows).toHaveCount(12);
    await expect(row(1014)).toBeVisible();
    await expect(row(1091)).toHaveCount(0);
    await expect(row(1092)).toHaveCount(0);
    await button(pages, '다음').click();
    await expect(rows).toHaveCount(2);
    await expect(row(1002)).toBeVisible();
    await expect(row(1001)).toBeVisible();
    await expect(draft).toHaveValue('저장하지 않은 연결 초안');
    const feedHash = new URL(page.url()).hash;
    const params = new URLSearchParams(feedHash.split('?')[1]);
    expect(params.get('activityScope')).toBe('failed_pipelines');
    expect(params.get('activityQ')).toBe(refMarker);
    expect(params.get('activityPipelinePage')).toBe('2');
    await draft.fill('');
    await page.reload();
    await expect(page).toHaveURL(url => url.hash === feedHash);
    await expect(scope).toHaveValue('failed_pipelines');
    await expect(query).toHaveValue(refMarker);
    await expect(row(1002)).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(draft).toBeEnabled();
    await draft.fill('티켓 검토 중 보존할 연결 초안');

    const opener = button(row(1002), moved.key);
    await opener.click();
    const movedPanel = page.getByRole('dialog', { name: moved.title, exact: true });
    const review = (panel: Locator) => panel.getByRole('navigation', { name: '업무 검토 순서', exact: true });
    await expect(review(movedPanel).getByRole('status')).toHaveText('3개 중 2번째');
    await expect(button(movedPanel, '이전 업무')).toHaveAttribute('title', first.key);
    await expect(button(movedPanel, '다음 업무')).toHaveAttribute('title', last.key);
    await button(movedPanel, '다음 업무').click();
    const lastPanel = page.getByRole('dialog', { name: last.title, exact: true });
    await expect(review(lastPanel).getByRole('status')).toHaveText('3개 중 3번째');
    await expect(button(lastPanel, '다음 업무')).toBeDisabled();
    await page.goBack();
    await expect(lastPanel).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === feedHash);
    await expect(opener).toBeFocused();
    await expect(query).toHaveValue(refMarker);
    await expect(scope).toHaveValue('failed_pipelines');
    await expect(rows).toHaveCount(2);
    await expect(draft).toHaveValue('티켓 검토 중 보존할 연결 초안');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const after = await snapshot();
    expect(after.issues.filter(issue => issueIds.has(issue.id))).toEqual(before.issues.filter(issue => issueIds.has(issue.id)));
    expect(after.gitlabLinks.filter(link => issueIds.has(link.issueId))).toEqual(before.gitlabLinks.filter(link => issueIds.has(link.issueId)));
    expect(await settings()).toEqual(configured);
    expect(prompts).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    expect(remoteCalls).toEqual([]);
  } finally {
    try {
      for (const id of issueIds) {
        const response = await request.delete(`/api/issues/${id}`);
        if (response.ok()) await request.delete(`/api/trash/${(await response.json() as { trashEntryId: string }).trashEntryId}`);
      }
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      remote.closeAllConnections();
      await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve()));
    }
  }
});
