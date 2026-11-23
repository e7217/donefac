import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse } from '@playwright/test';
import type { GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, expected = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json();
}

test('360px 티켓과 개발 화면에서 연결한 GitLab MR의 검토자와 확인된 승인 정보를 직접 조회한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settingsPath = '/api/integrations/gitlab';
  const settings = async () => json<GitlabSettings>(await request.get(settingsPath));
  const initial = await settings();
  expect(initial.baseUrl).toBe('');
  const { projects: [project] } = await workspace();
  const unique = randomUUID();
  const issue = await json<Issue>(await request.post('/api/issues', {
    data: { projectId: project.id, title: `MR 검토 ${unique.slice(0, 8)}` },
  }), 201);
  const repositoryId = 42, mrId = 872, iid = 8;
  const projectPath = `/forge/api/v4/projects/${repositoryId}`;
  const mrPath = `${projectPath}/merge_requests/${iid}`;
  const reviewerPath = `${mrPath}/reviewers`, approvalPath = `${mrPath}/approvals`;
  const reviewer = { id: 81, name: '공정 검토자', username: 'reviewer' };
  const approver = { id: 82, name: '승인 담당자', username: 'approver' };
  const fallback = { id: 83, username: 'legacy-reviewer' };
  const withdrawn = { id: 84, name: '이전 승인자', username: 'former-approver' };
  const webhookSecret = `synthetic-gitlab-review-${unique}`;
  const remoteCalls: { path: string; query: string; method?: string; credential?: string | string[] }[] = [];
  let mode: 'detailed' | 'fallback' | 'empty' | 'unavailable' = 'detailed';
  let baseUrl = '';
  let head = 'e'.repeat(40);
  let updatedAt = new Date(Date.now() - 60_000).toISOString();
  const repositoryUrl = () => `${baseUrl}/team/app`;
  const mrUrl = () => `${repositoryUrl()}/-/merge_requests/${iid}`;
  const mr = () => ({ id: mrId, iid, project_id: repositoryId, target_project_id: repositoryId, state: 'opened',
    title: `${issue.key} 검토 기다리는 변경`, source_branch: `feature/${issue.key}`, sha: head,
    updated_at: updatedAt, web_url: mrUrl(), detailed_merge_status: 'not_approved',
    ...(mode === 'unavailable' ? {} : { reviewers: mode === 'fallback' ? [fallback] : mode === 'empty' ? [] : [reviewer, approver, withdrawn] }),
  });
  const mock = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    remoteCalls.push({ path: url.pathname, query: url.search, method: incoming.method, credential: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === projectPath) response.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/app', web_url: repositoryUrl() }));
    else if (url.pathname === mrPath) response.end(JSON.stringify(mr()));
    else if (url.pathname === reviewerPath && mode === 'detailed') {
      response.setHeader('X-Next-Page', '2');
      response.end(JSON.stringify([
        { user: reviewer, state: 'requested_changes' }, { user: approver, state: 'reviewed' }, { user: withdrawn, state: 'unapproved' },
      ]));
    } else if (url.pathname === reviewerPath && mode === 'empty') response.end('[]');
    else if (url.pathname === approvalPath && mode === 'detailed') response.end(JSON.stringify({
      id: mrId, iid, project_id: repositoryId, approvals_required: 2, approvals_left: 1, approved_by: [{ user: approver }],
    }));
    else response.writeHead(url.pathname === approvalPath ? 403 : 404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;

  const publish = () => request.post(`${settingsPath}/webhook`, {
    headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() },
    data: { object_kind: 'merge_request', project: { id: repositoryId, web_url: repositoryUrl() }, object_attributes: { ...mr(), action: 'update' } },
  }).then(response => json<{ linked: number }>(response));

  try {
    await json(await request.patch(settingsPath, { data: {
      expectedVersion: initial.version, baseUrl, projectIds: [repositoryId], webhookSecret,
    } }));
    expect(await publish()).toMatchObject({ linked: 1 });
    const initialLink = (await workspace()).gitlabLinks.find(link => link.issueId === issue.id && link.kind === 'merge_request')!;
    expect(initialLink).toMatchObject({ iid, state: 'opened', sourceSha: head });
    await page.setViewportSize({ width: 360, height: 820 });
    const route = `#/${project.id}/issues?issue=${issue.id}`;
    await page.goto(`/${route}`);
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = ticket.getByRole('region', { name: 'GitLab', exact: true });
    const open = gitlab.getByRole('button', { name: 'MR 검토 확인', exact: true });
    await expect(open).toBeVisible();
    expect(remoteCalls).toHaveLength(0);
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    await title.fill('저장하지 않은 MR 검토 업무 제목');
    await comment.fill('작성 중인 MR 검토 메모');
    await open.press('Enter');
    const review = gitlab.getByRole('region', { name: 'GitLab MR 검토', exact: true });
    const reviewers = review.getByRole('list', { name: '검토자', exact: true });
    await expect(reviewers.getByRole('listitem').filter({ hasText: '공정 검토자 (@reviewer)' })).toContainText('수정 요청');
    await expect(reviewers.getByRole('listitem').filter({ hasText: '승인 담당자 (@approver)' })).toContainText('검토 완료');
    await expect(reviewers.getByRole('listitem').filter({ hasText: '이전 승인자 (@former-approver)' })).toContainText('승인 철회');
    await expect(review.getByRole('list', { name: '승인자', exact: true })).toContainText('승인 담당자 (@approver)');
    await expect(review).toContainText('필요한 승인 2개 · 남은 승인 1개');
    await expect(review.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT.+Z$/u);
    await expect(review.getByRole('link', { name: 'GitLab', exact: true })).toHaveAttribute('href', mrUrl());
    expect(await review.evaluate(region => region.getBoundingClientRect().width)).toBeLessThanOrEqual(360);

    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
    const reviewRoute = /\/merge-request-review$/u;
    await page.route(reviewRoute, async intercepted => {
      try {
        const response = await intercepted.fetch();
        expect(response.status()).toBe(200);
        started.resolve();
        await release.promise;
        await intercepted.fulfill({ response }).catch(() => undefined);
      } catch (cause) {
        started.reject(cause);
        await intercepted.abort().catch(() => undefined);
      } finally { finished.resolve(); }
    }, { times: 1 });
    try {
      await review.getByRole('button', { name: 'MR 검토 다시 확인', exact: true }).click();
      await started.promise;
      const aborted = page.waitForEvent('requestfailed', sent => reviewRoute.test(sent.url()));
      const countBefore = remoteCalls.length;
      head = 'f'.repeat(40);
      updatedAt = new Date(Date.parse(updatedAt) + 1_000).toISOString();
      expect(await publish()).toMatchObject({ linked: 1 });
      await gitlab.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true }).click();
      await expect(review.getByRole('status')).toContainText('MR이 변경되었습니다.');
      expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
      expect(remoteCalls).toHaveLength(countBefore);
    } finally { release.resolve(); }
    await finished.promise;
    await expect(reviewers).toHaveCount(0);
    await expect(title).toHaveValue('저장하지 않은 MR 검토 업무 제목');
    await expect(comment).toHaveValue('작성 중인 MR 검토 메모');
    await expect(page).toHaveURL(url => url.hash === route);
    await gitlab.getByRole('button', { name: 'MR 검토 닫기', exact: true }).press('Enter');
    await expect(open).toBeFocused();

    mode = 'fallback';
    const development = await page.context().newPage();
    try {
      await development.setViewportSize({ width: 360, height: 820 });
      const before = remoteCalls.length;
      await development.goto(`/#/${project.id}/development`);
      const activity = development.getByRole('region', { name: '연결된 개발 활동', exact: true });
      const trigger = activity.getByRole('button', { name: 'MR 검토 확인', exact: true });
      await expect(trigger).toBeVisible();
      expect(remoteCalls).toHaveLength(before);
      await trigger.click();
      const details = activity.getByRole('region', { name: 'GitLab MR 검토', exact: true });
      await expect(details.getByRole('list', { name: '검토자', exact: true })).toContainText('@legacy-reviewer');
      await expect(details).toContainText('상태 미확인');
      await expect(details).toContainText('GitLab에서 승인 정보를 확인하지 못했습니다.');
      await expect(details).not.toContainText('남은 승인');

      const retry = details.getByRole('button', { name: 'MR 검토 다시 확인', exact: true });
      mode = 'empty';
      await retry.click();
      await expect(details).toContainText('지정된 검토자가 없습니다.');
      mode = 'unavailable';
      await retry.click();
      await expect(details).toContainText('GitLab에서 검토자 목록을 확인하지 못했습니다.');
      await expect(details).not.toContainText('지정된 검토자가 없습니다.');
    } finally { await development.close(); }

    const final = await workspace();
    expect(final.gitlabLinks.find(link => link.id === initialLink.id)).toMatchObject({ updatedAt, sourceSha: head });
    expect(final.issues.find(item => item.id === issue.id)).toEqual(issue);
    expect(remoteCalls.filter(call => call.path === reviewerPath).map(call => call.query)).toEqual(Array<string>(5).fill('?per_page=50&page=1'));
    expect(remoteCalls.every(call => call.method === 'GET' && call.credential === undefined)).toBe(true);
    expect(new Set(remoteCalls.map(call => call.path))).toEqual(new Set([projectPath, mrPath, reviewerPath, approvalPath]));
  } finally {
    try {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});
