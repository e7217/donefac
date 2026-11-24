import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type { GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, expected = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json();
}

async function holdNextResponse(page: Page, url: RegExp) {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  await page.route(url, async intercepted => {
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
  return { started: started.promise, release: release.resolve, finished: finished.promise };
}

test('360px 티켓과 개발 화면에서 GitLab MR 검토와 미해결 토론을 원하는 시점에 조회한다', async ({ page, request }) => {
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
  const reviewerPath = `${mrPath}/reviewers`, approvalPath = `${mrPath}/approvals`, discussionsPath = `${mrPath}/discussions`;
  const reviewer = { id: 81, name: '공정 검토자', username: 'reviewer' };
  const approver = { id: 82, name: '승인 담당자', username: 'approver' };
  const fallback = { id: 83, username: 'legacy-reviewer' };
  const withdrawn = { id: 84, name: '이전 승인자', username: 'former-approver' };
  const webhookSecret = `synthetic-gitlab-review-${unique}`;
  const remoteCalls: { path: string; query: string; method?: string; credential?: string | string[] }[] = [];
  const discussionQueries = () => remoteCalls.filter(call => call.path === discussionsPath).map(call => call.query);
  let mode: 'detailed' | 'fallback' | 'empty' | 'unavailable' = 'detailed';
  let discussionMode: 'detailed' | 'empty' | 'partial' | 'unsupported' = 'detailed';
  let baseUrl = '';
  let head = 'e'.repeat(40);
  let updatedAt = new Date(Date.now() - 60_000).toISOString();
  const repositoryUrl = () => `${baseUrl}/team/app`;
  const mrUrl = () => `${repositoryUrl()}/-/merge_requests/${iid}`;
  const literalExcerpt = '<strong>측정값 초기화 조건 확인</strong>';
  const unresolvedNote = {
    id: 4401, noteable_type: 'MergeRequest', noteable_id: mrId, project_id: repositoryId,
    system: false, confidential: false, resolvable: true, resolved: false, body: literalExcerpt, author: reviewer,
    position: { new_path: 'src/measurement/value.ts', new_line: 27 }, web_url: 'https://candidate.invalid/elsewhere#note_9999',
  };
  const secondExcerptStart = '이전 입력의 경계값 확인';
  const secondNote = {
    ...unresolvedNote, id: 4402, body: `${secondExcerptStart} ${'추가'.repeat(165)} 미리보기 이후 내용`, author: approver,
    position: { old_path: 'src/measurement/old-value.ts', old_line: 13 },
  };
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
    else if (url.pathname === discussionsPath) {
      const page = Number(url.searchParams.get('page'));
      if (discussionMode === 'detailed' && page === 1) {
        response.setHeader('X-Next-Page', '2');
        response.end(JSON.stringify([
          { id: 'unresolved', individual_note: false, notes: [unresolvedNote, { ...unresolvedNote, id: 4403, body: '답글 전문은 표시하지 않음' }] },
          { id: 'resolved', individual_note: false, notes: [{ ...unresolvedNote, id: 4404, body: '이미 해결된 토론', resolved: true }] },
          { id: 'ordinary', individual_note: true, notes: [{ ...unresolvedNote, id: 4405, body: '일반 메모' }] },
          { id: 'system', individual_note: false, notes: [{ ...unresolvedNote, id: 4406, body: '시스템 자동 기록', system: true }] },
          { id: 'confidential', individual_note: false, notes: [{ ...unresolvedNote, id: 4407, body: '비공개 토론', confidential: true }] },
          { id: 'non-resolvable', individual_note: false, notes: [{ ...unresolvedNote, id: 4408, body: '해결 표시가 없는 토론', resolvable: false }] },
        ]));
      } else if (discussionMode === 'detailed' && page === 2) {
        response.end(JSON.stringify([{ id: 'second-page', individual_note: false, notes: [secondNote] }]));
      } else if (discussionMode === 'partial') {
        response.setHeader('X-Next-Page', String(page + 1));
        response.end(JSON.stringify([{
          id: `resolved-page-${page}`, individual_note: false,
          notes: [{ ...unresolvedNote, id: 4500 + page, resolved: true }],
        }]));
      } else if (discussionMode === 'empty') response.end('[]');
      else response.writeHead(discussionMode === 'unsupported' ? 501 : 500).end('{}');
    } else if (url.pathname === reviewerPath && mode === 'detailed') {
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

    const openDiscussions = review.getByRole('button', { name: '미해결 토론 확인', exact: true });
    await expect(openDiscussions).toBeVisible();
    await expect(openDiscussions).toHaveAttribute('aria-expanded', 'false');
    expect(discussionQueries()).toEqual([]);
    const discussionRoute = /\/merge-request-discussions$/u;
    const requestedDiscussions = page.waitForRequest(sent => discussionRoute.test(sent.url()));
    await openDiscussions.press('Enter');
    const sent = await requestedDiscussions;
    expect(sent.method()).toBe('GET');
    const requestPath = `/api/issues/${encodeURIComponent(issue.id)}/gitlab-links/${encodeURIComponent(initialLink.id)}/merge-request-discussions`;
    expect(new URL(sent.url()).pathname).toBe(requestPath);
    const discussions = review.getByRole('region', { name: 'GitLab 미해결 토론', exact: true });
    const threadList = discussions.getByRole('list', { name: '미해결 토론', exact: true });
    const threads = threadList.getByRole('listitem');
    const visibleThread = threads.filter({ hasText: literalExcerpt });
    await expect(threads).toHaveCount(2);
    await expect(visibleThread).toContainText('공정 검토자');
    await expect(visibleThread).toContainText('src/measurement/value.ts:27');
    await expect(visibleThread).toContainText('변경 후');
    await expect(visibleThread.locator('strong').filter({ hasText: '측정값 초기화 조건 확인' })).toHaveCount(0);
    await expect(visibleThread.getByRole('link', { name: 'GitLab에서 토론 열기', exact: true })).toHaveAttribute('href', `${mrUrl()}#note_4401`);
    const secondThread = threads.filter({ hasText: secondExcerptStart });
    await expect(secondThread).toContainText('src/measurement/old-value.ts:13');
    await expect(secondThread).toContainText('변경 전');
    await expect(secondThread).toContainText('…');
    await expect(secondThread).not.toContainText('미리보기 이후 내용');
    await expect(secondThread.getByRole('link', { name: 'GitLab에서 토론 열기', exact: true })).toHaveAttribute('href', `${mrUrl()}#note_4402`);
    await expect(discussions).not.toContainText(/답글 전문|이미 해결된 토론|일반 메모|시스템 자동 기록|비공개 토론|해결 표시가 없는 토론/u);
    await expect(discussions.getByRole('link', { name: 'GitLab에서 MR 열기', exact: true })).toHaveAttribute('href', mrUrl());
    expect(await discussions.evaluate(region => region.getBoundingClientRect().width)).toBeLessThanOrEqual(360);
    expect(await threadList.evaluate(list => list.scrollWidth - list.clientWidth)).toBe(0);
    expect(discussionQueries()).toEqual(['?per_page=50&page=1', '?per_page=50&page=2']);
    await expect(title).toHaveValue('저장하지 않은 MR 검토 업무 제목');
    await expect(comment).toHaveValue('작성 중인 MR 검토 메모');

    const reviewRoute = /\/merge-request-review$/u;
    const pendingDiscussion = await holdNextResponse(page, discussionRoute);
    const pendingReview = await holdNextResponse(page, reviewRoute);
    try {
      await discussions.getByRole('button', { name: '미해결 토론 다시 확인', exact: true }).click();
      await pendingDiscussion.started;
      const discussionsAborted = page.waitForEvent('requestfailed', sent => discussionRoute.test(sent.url()));
      await review.getByRole('button', { name: 'MR 검토 다시 확인', exact: true }).click();
      expect((await discussionsAborted).failure()?.errorText).toContain('ERR_ABORTED');
      await expect(discussions).toHaveCount(0);
      await pendingReview.started;
      const aborted = page.waitForEvent('requestfailed', sent => reviewRoute.test(sent.url()));
      const countBefore = remoteCalls.length;
      head = 'f'.repeat(40);
      updatedAt = new Date(Date.parse(updatedAt) + 1_000).toISOString();
      expect(await publish()).toMatchObject({ linked: 1 });
      await gitlab.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true }).click();
      await expect(review.getByRole('status')).toContainText('MR이 변경되었습니다.');
      expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
      expect(remoteCalls).toHaveLength(countBefore);
    } finally {
      pendingDiscussion.release();
      pendingReview.release();
    }
    await Promise.all([pendingDiscussion.finished, pendingReview.finished]);
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
      const discussionCallsBefore = discussionQueries().length;
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

      const showDiscussions = details.getByRole('button', { name: '미해결 토론 확인', exact: true });
      await expect(showDiscussions).toBeVisible();
      expect(discussionQueries()).toHaveLength(discussionCallsBefore);
      discussionMode = 'empty';
      await showDiscussions.click();
      const discussionDetails = details.getByRole('region', { name: 'GitLab 미해결 토론', exact: true });
      const refreshDiscussions = discussionDetails.getByRole('button', { name: '미해결 토론 다시 확인', exact: true });
      await expect(discussionDetails).toContainText('표시할 수 있는 미해결 토론이 없습니다.');
      expect(discussionQueries().slice(discussionCallsBefore)).toEqual(['?per_page=50&page=1']);

      discussionMode = 'partial';
      await refreshDiscussions.click();
      await expect(discussionDetails).toContainText('조회 범위에서 미해결 토론을 찾지 못했습니다.');
      await expect(discussionDetails).toContainText('조회 범위가 제한되었습니다. 전체 토론을 GitLab에서 확인해 주세요.');
      await expect(discussionDetails).not.toContainText('미해결 토론이 없습니다.');
      expect(discussionQueries().slice(discussionCallsBefore + 1)).toEqual([
        '?per_page=50&page=1', '?per_page=50&page=2', '?per_page=50&page=3', '?per_page=50&page=4',
      ]);

      discussionMode = 'unsupported';
      await refreshDiscussions.click();
      await expect(discussionDetails).toContainText('이 GitLab 연결에서는 MR 토론 조회를 지원하지 않습니다.');
      await expect(discussionDetails).not.toContainText('미해결 토론이 없습니다.');
      await expect(discussionDetails.getByRole('link', { name: 'GitLab에서 MR 열기', exact: true })).toHaveAttribute('href', mrUrl());
      await details.getByRole('button', { name: '미해결 토론 닫기', exact: true }).press('Enter');
      await expect(showDiscussions).toBeFocused();

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
    expect(new Set(remoteCalls.map(call => call.path))).toEqual(new Set([projectPath, mrPath, reviewerPath, approvalPath, discussionsPath]));
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
