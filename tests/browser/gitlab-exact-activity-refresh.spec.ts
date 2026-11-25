import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { AutomationRule, GitlabIssueRefreshResult, GitlabLink, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const rulesPath = '/api/automation-rules';
const repositoryId = 42;
const repository = 'team/triage';
const projectRead = `/forge/api/v4/projects/${repositoryId}`;
const pipelineListRead = `${projectRead}/pipelines`;
const pipelineRead = (id: number) => `${pipelineListRead}/${id}`;
const oldPipelineId = 701;
const button = (container: Locator, name: string) => container.getByRole('button', { name, exact: true });
const exactAction = '이 GitLab 활동 상태 확인';
const selectedReviewAction = '이 활동으로 상태 검토';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

async function refreshActivity(page: Page, trigger: Locator, path: string) {
  const receiving = page.waitForResponse(response => new URL(response.url()).pathname === path);
  await trigger.press('Enter');
  const response = await receiving;
  expect(response.request().method()).toBe('POST');
  expect(response.request().postDataJSON()).toEqual({});
  expect(new URL(response.url()).search).toBe('');
  expect(response.headers()['cache-control']).toBe('no-store');
  return json<GitlabIssueRefreshResult>(response);
}

test('360px에서 이전 GitLab 활동을 공유하고 해당 연결의 상태를 검토한다', async ({ browser, page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID();
  const marker = `old-triage-${suffix.slice(0, 8)}`;
  const token = `synthetic-exact-read-${suffix}`;
  const secret = `synthetic-exact-hook-${suffix}`;
  const epoch = Date.now() - 90_000;
  const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
  const settings = () => request.get(settingsPath).then(response => json<GitlabSettings>(response));
  const workspace = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const initialSettings = await settings();
  expect(initialSettings.baseUrl).toBe('');
  const { projects: [project] } = await workspace();
  const issue = await json<Issue>(await request.post('/api/issues', { data: {
    projectId: project.id, title: `GitLab 이전 연결 확인 ${suffix.slice(0, 8)}`,
  } }), 201);
  const oldRef = `feature/${issue.key}/${marker}`;
  function pipeline(id: number, ref: string, status: 'running' | 'failed' | 'success', seconds: number) {
    return { id, iid: id, project_id: repositoryId, ref, status, sha: 'a'.repeat(40), source: 'push', tag: false,
      updated_at: at(seconds), ...(status !== 'running' ? { finished_at: at(seconds) } : {}) };
  }
  const storedOld = pipeline(oldPipelineId, oldRef, 'running', 0);
  const newer = Array.from({ length: 20 }, (_, index) => pipeline(800 + index, `feature/${issue.key}/newer-${index}`, 'running', 10 + index));
  const newerById = new Map(newer.map(value => [value.id, value]));
  let remoteOld = pipeline(oldPipelineId, oldRef, 'failed', 35);
  let baseUrl = '';
  const repositoryUrl = () => `${baseUrl}/${repository}`;
  const calls: { path: string; method?: string; credential?: string | string[] }[] = [];
  const remote = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    const path = url.pathname;
    calls.push({ path, method: incoming.method, credential: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (path === projectRead) {
      response.end(JSON.stringify({ id: repositoryId, path_with_namespace: repository, web_url: repositoryUrl() }));
      return;
    }
    if (path === pipelineListRead) {
      const candidates = [remoteOld, ...newer].filter(run => run.ref === url.searchParams.get('ref') && run.source === url.searchParams.get('source'));
      response.end(JSON.stringify(candidates.map(run => ({ ...run, web_url: `${repositoryUrl()}/-/pipelines/${run.id}` }))));
      return;
    }
    const id = path.startsWith(`${projectRead}/pipelines/`) ? Number(path.slice(`${projectRead}/pipelines/`.length)) : NaN;
    const state = id === oldPipelineId ? remoteOld : newerById.get(id);
    if (state) response.end(JSON.stringify({ ...state, web_url: `${repositoryUrl()}/-/pipelines/${id}` }));
    else response.writeHead(404).end('{}');
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  baseUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/forge`;
  const publish = async (value: ReturnType<typeof pipeline>) => {
    const result = await json<{ linked: number }>(await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Event': 'Pipeline Hook', 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
      data: { object_kind: 'pipeline', project: { id: repositoryId, web_url: repositoryUrl() }, object_attributes: value },
    }));
    expect(result.linked).toBe(1);
  };
  let rule: AutomationRule | undefined;
  let otherIssue: Issue | undefined;

  try {
    const configured = await json<GitlabSettings>(await request.patch(settingsPath, { data: {
      expectedVersion: initialSettings.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    rule = await json<AutomationRule>(await request.post(rulesPath, { data: {
      projectId: project.id, name: `파이프라인 성공 후 완료 ${suffix.slice(0, 8)}`, enabled: true, trigger: 'pipeline.succeeded',
      gitlabProjectIds: [repositoryId], branchPattern: oldRef, issueTypes: [], fromStatuses: [issue.status], toStatusId: 'done',
    } }), 201);
    expect(rule.enabled).toBe(true);
    await publish(storedOld);
    for (const value of newer) await publish(value);
    const before = await workspace();
    const linked = before.gitlabLinks.filter(link => link.issueId === issue.id);
    expect(linked).toHaveLength(21);
    const oldLink = linked.find(link => link.iid === oldPipelineId)!;
    expect(oldLink).toMatchObject({ state: 'running', kind: 'pipeline' });
    expect(oldLink.manualLinkId).toBeUndefined();
    const runsPath = `/api/automation-runs?projectId=${encodeURIComponent(project.id)}`;
    const beforeRuns = await json(await request.get(runsPath));
    const issuePath = `/api/issues/${encodeURIComponent(issue.id)}`;
    const selectedLinkPath = `${issuePath}/gitlab-links/${encodeURIComponent(oldLink.id)}`;
    const bulkPath = `${issuePath}/gitlab-links/refresh`;
    const exactPath = `${selectedLinkPath}/refresh`;
    const selectedReviewPath = `${selectedLinkPath}/status-review`;
    const browserWrites: string[] = [];
    page.context().on('request', sent => {
      const { pathname } = new URL(sent.url());
      if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(sent.method())) browserWrites.push(`${sent.method()} ${pathname}`);
    });

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/?reviewContext=ticket-filter#/${project.id}/issues?issue=${issue.id}`);
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const gitlab = ticket.getByRole('region', { name: 'GitLab', exact: true });
    const pipelines = gitlab.getByRole('region', { name: '파이프라인', exact: true });
    const bulkTrigger = button(gitlab, 'GitLab에서 상태 확인');
    await expect(bulkTrigger).toBeVisible();
    expect(calls).toHaveLength(0);
    await title.fill('저장하지 않은 티켓 제목');
    await comment.fill('전송하지 않은 티켓 댓글');
    const bulk = await refreshActivity(page, bulkTrigger, bulkPath);
    expect(bulk.links.map(link => link.iid).sort((left, right) => left - right)).toEqual(newer.map(value => value.id));
    expect(bulk).toMatchObject({ failures: [], skipped: 1 });
    expect(bulk.statusReview).toBeUndefined();
    expect(calls.map(call => call.path).sort()).toEqual([projectRead, ...newer.map(value => pipelineRead(value.id))].sort());
    await expect(bulkTrigger).toBeEnabled();
    const afterBulk = await workspace();
    expect(afterBulk.gitlabLinks.find(link => link.id === oldLink.id)).toEqual(oldLink);

    const pages = pipelines.getByRole('navigation', { name: '파이프라인 페이지 이동', exact: true });
    const oldRow = pipelines.locator('.gitlab-activity-row').filter({ has: page.getByText(`#${oldPipelineId}`, { exact: true }) });
    await expect(oldRow).toHaveCount(0);
    const activitySearch = gitlab.getByRole('searchbox', { name: 'GitLab 활동 검색', exact: true });
    const activityScope = gitlab.getByRole('combobox', { name: 'GitLab 활동 범위', exact: true });
    const resetActivityFilters = button(gitlab, '활동 필터 초기화');
    const readsBeforeTicketFilter = calls.length;
    await activitySearch.fill(`#${oldPipelineId}`);
    await activitySearch.press('Enter');
    await expect(oldRow).toBeVisible();
    await expect(gitlab.locator('.gitlab-activity-row')).toHaveCount(1);
    await expect(pages).toHaveCount(0);
    await activitySearch.fill('https://example.test/settings');
    await activitySearch.press('Enter');
    await expect(activitySearch).toHaveAttribute('aria-invalid', 'true');
    await expect(oldRow).toBeVisible();
    const objectUrl = `${repositoryUrl()}/-/pipelines/${oldPipelineId}`;
    await activitySearch.fill(`${objectUrl}?ref=review#details`);
    await activitySearch.press('Enter');
    await expect(activitySearch).toHaveValue(objectUrl);
    await expect(oldRow).toBeVisible();
    await activityScope.selectOption('merge_request');
    await expect(gitlab.getByText('조건에 맞는 GitLab 활동이 없습니다.', { exact: true })).toBeVisible();
    await resetActivityFilters.click();
    await expect(activitySearch).toHaveValue('');
    await expect(activityScope).toHaveValue('all');
    await expect(pages).toContainText('1 / 2 페이지');
    expect(calls).toHaveLength(readsBeforeTicketFilter);

    await button(pages, '다음').click();
    await expect(oldRow).toHaveAttribute('data-gitlab-state', 'running');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const expectedShare = new URL(`/#/${project.id}/issues`, page.url());
    expectedShare.hash += `?${new URLSearchParams({ issue: issue.id, gitlabActivity: oldLink.id })}`;
    const beforeSharing = page.url();
    await button(oldRow, '티켓 활동 링크 복사').click();
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await expect.poll(clipboard).toBe(expectedShare.href);
    const sharedUrl = await clipboard();
    await expect(page).toHaveURL(beforeSharing);
    await expect(title).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('전송하지 않은 티켓 댓글');

    const reader = await browser.newPage({ viewport: { width: 360, height: 820 } });
    try {
      otherIssue = await json<Issue>(await request.post('/api/issues', { data: {
        projectId: project.id, title: `다른 티켓 GitLab 연결 범위 ${suffix.slice(0, 8)}`,
      } }), 201);
      await reader.goto(sharedUrl);
      const sharedGitlab = reader.getByRole('dialog', { name: issue.title, exact: true }).getByRole('region', { name: 'GitLab', exact: true });
      const selected = sharedGitlab.locator('[data-gitlab-selected]');
      await expect(selected).toHaveCount(1);
      await expect(selected).toHaveAttribute('data-gitlab-link-id', oldLink.id);
      await expect(selected).toBeFocused();
      await expect(sharedGitlab.getByRole('navigation', { name: '파이프라인 페이지 이동', exact: true })).toContainText('2 / 2 페이지');

      const wrongTicketShare = new URL(expectedShare);
      wrongTicketShare.hash = `#/${project.id}/issues?${new URLSearchParams({ issue: otherIssue.id, gitlabActivity: oldLink.id })}`;
      await reader.goto(wrongTicketShare.href);
      const otherGitlab = reader.getByRole('dialog', { name: otherIssue.title, exact: true }).getByRole('region', { name: 'GitLab', exact: true });
      await expect(otherGitlab.getByText('선택한 GitLab 활동을 이 티켓에서 찾을 수 없습니다.', { exact: true })).toBeVisible();
      await expect(otherGitlab.locator('[data-gitlab-selected]')).toHaveCount(0);
      await expect(otherGitlab.getByRole('heading', { name: /^GitLab/u })).toBeFocused();
      expect(calls).toHaveLength(readsBeforeTicketFilter);
    } finally { await reader.close(); }
    await page.bringToFront();
    const readsBeforeExact = calls.length;
    const failed = await refreshActivity(page, button(oldRow, exactAction), exactPath);
    expect(failed).toEqual({ links: [expect.objectContaining({ id: oldLink.id, state: 'failed' })], failures: [], skipped: 0 });
    expect(calls.slice(readsBeforeExact).map(call => call.path)).toEqual([projectRead, pipelineRead(oldPipelineId)]);
    await expect(oldRow).toHaveAttribute('data-gitlab-state', 'failed');
    await expect(pages).toContainText('1 / 2 페이지');
    await expect(button(oldRow, exactAction)).toBeFocused();
    await expect(title).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('전송하지 않은 티켓 댓글');
    await button(pages, '다음').click();
    await expect(oldRow).toHaveCount(0);
    await activityScope.selectOption('failed_pipelines');
    await expect(oldRow).toBeVisible();
    await expect(gitlab.locator('.gitlab-activity-row')).toHaveCount(1);
    await resetActivityFilters.click();
    await expect(pages).toContainText('1 / 2 페이지');

    const development = await page.context().newPage();
    try {
      await development.setViewportSize({ width: 360, height: 820 });
      const readsBeforeOpening = calls.length;
      await development.goto(`/#/${project.id}/development`);
      const feed = development.getByRole('region', { name: '연결된 개발 활동', exact: true });
      const scope = feed.getByRole('combobox', { name: '개발 활동 범위', exact: true });
      const query = feed.getByRole('searchbox', { name: '개발 활동 검색', exact: true });
      const settingDraft = development.getByLabel('읽기 API 토큰', { exact: true });
      await expect(settingDraft).toBeEnabled();
      await settingDraft.fill('저장하지 않은 GitLab 연결 초안');
      await scope.selectOption('failed_pipelines');
      await query.fill(marker);
      await query.press('Enter');
      const filtered = feed.locator('.gitlab-activity-row');
      await expect(filtered).toHaveCount(1);
      await expect(filtered).toHaveAttribute('data-gitlab-state', 'failed');
      await expect(filtered.getByText(`#${oldPipelineId}`, { exact: true })).toBeVisible();
      await expect(button(filtered, selectedReviewAction)).toHaveCount(0);
      expect(calls).toHaveLength(readsBeforeOpening);
      const hash = new URL(development.url()).hash;

      remoteOld = pipeline(oldPipelineId, oldRef, 'success', 40);
      const recovered = await refreshActivity(development, button(filtered, exactAction), exactPath);
      expect(recovered).toEqual({ links: [expect.objectContaining({ id: oldLink.id, state: 'success' })], failures: [], skipped: 0 });
      expect(calls.slice(readsBeforeOpening).map(call => call.path)).toEqual([projectRead, pipelineRead(oldPipelineId)]);
      await expect(filtered).toHaveCount(0);
      await expect(feed.getByText('조건에 맞는 개발 활동이 없습니다.', { exact: true })).toBeVisible();
      const confirmed = feed.getByRole('region', { name: '확인한 GitLab 활동', exact: true });
      await expect(confirmed).toContainText(`파이프라인 #${oldPipelineId} · 성공`);
      const openConfirmed = button(confirmed, '티켓에서 이 활동 보기');
      await expect(openConfirmed).toBeFocused();
      await openConfirmed.press('Enter');
      const opened = development.getByRole('dialog', { name: issue.title, exact: true });
      const selected = opened.locator('[data-gitlab-selected]');
      await expect(selected).toHaveAttribute('data-gitlab-link-id', oldLink.id);
      await expect(selected).toHaveAttribute('data-gitlab-state', 'success');
      await expect(selected).toBeFocused();
      await button(opened, '업무 상세 닫기').click();
      await expect(opened).toHaveCount(0);
      await expect(openConfirmed).toBeFocused();
      await expect(query).toHaveValue(marker);
      await expect(scope).toHaveValue('failed_pipelines');
      await expect(development).toHaveURL(url => url.hash === hash);
      await expect(settingDraft).toHaveValue('저장하지 않은 GitLab 연결 초안');
      expect(calls.slice(readsBeforeOpening).map(call => call.path)).toEqual([projectRead, pipelineRead(oldPipelineId)]);

      const after = await workspace();
      expect(after.gitlabLinks.filter(link => link.issueId === issue.id)).toEqual(afterBulk.gitlabLinks.filter(link => link.issueId === issue.id)
        .map(link => link.id === oldLink.id ? recovered.links[0] : link));
      expect(after.issues.find(value => value.id === issue.id)).toEqual(before.issues.find(value => value.id === issue.id));
      expect(await json(await request.get(runsPath))).toEqual(beforeRuns);
      expect(await settings()).toEqual(configured);
    } finally { await development.close(); }

    await page.bringToFront();
    await activitySearch.fill(oldRef);
    await activitySearch.press('Enter');
    const selectedReview = button(oldRow, selectedReviewAction);
    await expect(selectedReview).toBeEnabled();
    const issueForm = ticket.locator('form.issue-detail-form');
    const status = issueForm.getByRole('combobox', { name: '상태', exact: true });
    const suggestionCard = gitlab.getByRole('region', { name: 'GitLab 상태 변경 제안', exact: true });
    const prepare = button(suggestionCard, '목표 상태로 편집');
    const save = button(issueForm, '변경사항 저장');
    await expect(suggestionCard).toHaveCount(0);
    const completedAt = new Date().toISOString();
    remoteOld = { ...remoteOld, updated_at: completedAt, finished_at: completedAt };
    const readsBeforeReview = calls.length;
    const selected = await refreshActivity(page, selectedReview, selectedReviewPath);
    expect(calls.slice(readsBeforeReview).map(call => call.path)).toEqual([projectRead, pipelineRead(oldPipelineId), pipelineListRead]);
    expect(selected).toMatchObject({ links: [expect.objectContaining({ id: oldLink.id, state: 'success' })], failures: [], skipped: 0 });
    if (selected.statusReview?.kind !== 'suggestion') throw new Error('선택한 GitLab 활동의 상태 제안이 없습니다.');
    const { suggestion } = selected.statusReview;
    expect(suggestion).toMatchObject({
      issueId: issue.id, issueVersion: issue.version, fromStatus: issue.status, toStatus: 'done',
      rule: { id: rule.id }, evidence: { link: { id: oldLink.id }, trigger: 'pipeline.succeeded', occurredAt: completedAt },
    });
    await expect(suggestionCard.getByText('선택한 GitLab 활동 기준', { exact: true })).toBeVisible();
    await expect(suggestionCard).toContainText(rule.name);
    await expect(suggestionCard).toContainText(`#${oldPipelineId}`);
    await expect(status).toHaveValue(issue.status);
    await expect(title).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('전송하지 않은 티켓 댓글');
    expect((await workspace()).issues.find(value => value.id === issue.id)).toEqual(issue);
    expect(browserWrites).toEqual([`POST ${bulkPath}`, `POST ${exactPath}`, `POST ${exactPath}`, `POST ${selectedReviewPath}`]);

    await prepare.click();
    await expect(status).toHaveValue('done');
    await expect(status).toBeFocused();
    await expect(title).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('전송하지 않은 티켓 댓글');
    expect((await workspace()).issues.find(value => value.id === issue.id)).toEqual(issue);
    const readsBeforeSave = calls.length;
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
    await save.click();
    const saved = await savedResponse;
    expect(saved.request().postDataJSON()).toMatchObject({
      expectedVersion: issue.version, title: '저장하지 않은 티켓 제목', status: 'done', gitlabStatusSuggestionToken: suggestion.token,
    });
    expect(await json<Issue>(saved)).toMatchObject({ status: 'done', title: '저장하지 않은 티켓 제목', version: issue.version + 1 });
    expect(calls.slice(readsBeforeSave).map(call => call.path)).toEqual([projectRead, pipelineRead(oldPipelineId), pipelineListRead]);
    const savedTicket = page.getByRole('dialog', { name: '저장하지 않은 티켓 제목', exact: true });
    await expect(savedTicket.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue('전송하지 않은 티켓 댓글');
    expect(await json(await request.get(runsPath))).toEqual(beforeRuns);
    expect(browserWrites).toEqual([
      `POST ${bulkPath}`, `POST ${exactPath}`, `POST ${exactPath}`, `POST ${selectedReviewPath}`, `PATCH ${issuePath}`,
    ]);
    expect(calls.every(call => call.method === 'GET' && call.credential === token)).toBe(true);
  } finally {
    try {
      if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`);
      for (const ticket of [issue, otherIssue]) if (ticket) {
        const deleted = await request.delete(`/api/issues/${ticket.id}`);
        if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json() as { trashEntryId: string }).trashEntryId}`);
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

test('360px에서 같은 실행 계열의 최신 파이프라인을 확인하고 이전 상태 제안을 보류한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const suffix = randomUUID().slice(0, 8);
  const token = `synthetic-latest-run-${randomUUID()}`;
  const secret = `synthetic-latest-hook-${randomUUID()}`;
  const workspace = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const settings = () => request.get(settingsPath).then(response => json<GitlabSettings>(response));
  const initial = await settings();
  expect(initial.baseUrl).toBe('');
  const { projects: [project] } = await workspace();
  const issue = await json<Issue>(await request.post('/api/issues', { data: {
    projectId: project.id, title: `최신 파이프라인 검토 ${suffix}`, status: 'todo',
  } }), 201);
  const issuePath = `/api/issues/${issue.id}`;
  const runsPath = `${issuePath}/automation-runs`;
  const branchPrefix = `release/synthetic-${suffix}`;
  const blockedRef = `${branchPrefix}/blocked`;
  const readyRef = `${branchPrefix}/ready`;
  const blockedId = 741, readyId = 742, blockedById = 842, taggedId = 843, otherSourceId = 844, newRunId = 845;
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  let baseUrl = '';
  let finishedAt: string | undefined;
  let replacementCompleted = false;
  let newRun = false;
  const repoUrl = () => `${baseUrl}/${repository}`;
  const pipelineUrl = (id: number) => `${repoUrl()}/-/pipelines/${id}`;
  const pipeline = (id: number, ref: string, status: 'running' | 'success', source = 'push', tag = false) => ({
    id, iid: id, project_id: repositoryId, ref, status, source, tag, sha: id < 800 ? 'b'.repeat(40) : 'c'.repeat(40),
    updated_at: finishedAt ?? startedAt, ...(status === 'success' ? { finished_at: finishedAt } : {}), web_url: pipelineUrl(id),
  });
  const runs = () => [
    pipeline(blockedId, blockedRef, finishedAt ? 'success' : 'running'),
    pipeline(readyId, readyRef, finishedAt ? 'success' : 'running'),
    pipeline(blockedById, blockedRef, replacementCompleted ? 'success' : 'running'),
    pipeline(taggedId, readyRef, 'running', 'push', true),
    pipeline(otherSourceId, readyRef, 'running', 'schedule'),
    ...(newRun ? [pipeline(newRunId, readyRef, 'running')] : []),
  ];
  const calls: URL[] = [];
  const upstream = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    calls.push(url);
    response.setHeader('Content-Type', 'application/json');
    if (incoming.method !== 'GET' || incoming.headers['private-token'] !== token) return response.writeHead(401).end('{}');
    if (url.pathname === projectRead) return response.end(JSON.stringify({ id: repositoryId, path_with_namespace: repository, web_url: repoUrl() }));
    if (url.pathname === pipelineListRead) {
      const selected = runs().filter(run => run.ref === url.searchParams.get('ref'))
        .sort((a, b) => b.id - a.id)
        .map(({ tag, ...run }) => run.id === taggedId ? run : { ...run, tag });
      return response.end(JSON.stringify(selected));
    }
    const run = runs().find(value => pipelineRead(value.id) === url.pathname);
    return run ? response.end(JSON.stringify(run)) : response.writeHead(404).end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/forge`;

  function reviewedQueries(id: number, ref: string) {
    const reads = calls.splice(0);
    expect(reads.slice(0, 3).map(url => url.pathname)).toEqual([projectRead, pipelineRead(id), pipelineListRead]);
    expect(Object.fromEntries(reads[2].searchParams)).toEqual({ ref, source: 'push', order_by: 'id', sort: 'desc', page: '1', per_page: '20' });
    return reads.slice(3).map(url => url.pathname);
  }

  let rule: AutomationRule | undefined;
  try {
    const configured = await json<GitlabSettings>(await request.patch(settingsPath, { data: {
      expectedVersion: initial.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    rule = await json<AutomationRule>(await request.post(rulesPath, { data: {
      projectId: project.id, name: `최신 파이프라인만 검토 ${suffix}`, enabled: true, trigger: 'pipeline.succeeded',
      gitlabProjectIds: [repositoryId], branchPattern: `${branchPrefix}/*`, issueTypes: [], fromStatuses: [issue.status], toStatusId: 'done',
    } }), 201);
    const attach = async (id: number) => json<GitlabLink>(await request.post(`${issuePath}/gitlab-links`, { data: {
      repositoryId, url: pipelineUrl(id), expectedSettingsVersion: configured.version,
    } }), 201);
    const blocked = await attach(blockedId);
    const ready = await attach(readyId);
    expect(calls.splice(0).map(url => url.pathname)).toEqual([projectRead, pipelineRead(blockedId), projectRead, pipelineRead(readyId)]);
    const beforeRuns = await json(await request.get(runsPath));
    finishedAt = new Date().toISOString();

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = ticket.getByRole('region', { name: 'GitLab', exact: true });
    const row = (id: number) => gitlab.locator('.gitlab-activity-row').filter({ has: page.getByText(`#${id}`, { exact: true }) });
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const status = ticket.getByRole('combobox', { name: '상태', exact: true });
    const outcome = gitlab.getByRole('group', { name: 'GitLab 상태 확인 결과', exact: true });
    const proposal = gitlab.getByRole('region', { name: 'GitLab 상태 변경 제안', exact: true });
    const replacementUrl = pipelineUrl(blockedById);
    const replacement = outcome.getByRole('link', { name: `GitLab에서 더 최신 파이프라인 #${blockedById} 열기`, exact: true });
    await title.fill('아직 저장하지 않은 최신 파이프라인 검토 제목');
    await comment.fill('보내지 않은 파이프라인 검토 댓글');
    const reviewPath = (link: GitlabLink) => `${issuePath}/gitlab-links/${encodeURIComponent(link.id)}/status-review`;

    await expect(row(blockedId)).toHaveAttribute('data-gitlab-state', 'running');
    const older = await refreshActivity(page, button(row(blockedId), selectedReviewAction), reviewPath(blocked));
    expect(older).toMatchObject({ links: [{ id: blocked.id, state: 'success' }], failures: [], skipped: 0,
      pipelineReview: { superseded: 1, unverified: 0, replacement: {
        linkId: blocked.id, repositoryId, pipelineId: blockedById, webUrl: replacementUrl, status: 'running',
        ref: blockedRef, source: 'push', tag: false, sha: 'c'.repeat(40),
      } },
    });
    expect(older.statusReview).toBeUndefined();
    expect(reviewedQueries(blockedId, blockedRef)).toEqual([pipelineRead(blockedById)]);
    await expect(row(blockedId)).toHaveAttribute('data-gitlab-state', 'success');
    await expect(outcome.getByText('같은 실행 계열에 더 최신 GitLab 파이프라인이 있습니다. 최신 실행에서 상태를 다시 검토해 주세요.', { exact: true })).toBeVisible();
    await expect(replacement).toBeVisible();
    await expect(replacement).toHaveAttribute('href', replacementUrl);
    await expect(replacement).toHaveAttribute('target', '_blank');
    await expect(replacement).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(outcome).toContainText('조회 시 상태 실행 중');
    await expect(row(blockedById)).toHaveCount(0);
    await expect(outcome).toBeFocused();
    await expect(proposal).toHaveCount(0);
    await expect(status).toHaveValue(issue.status);
    const afterOlderReview = await workspace();
    expect(afterOlderReview.issues.find(row => row.id === issue.id)).toEqual(issue);
    expect(afterOlderReview.gitlabLinks.filter(link => link.issueId === issue.id).map(link => link.id).sort()).toEqual([blocked.id, ready.id].sort());
    expect(await json(await request.get(runsPath))).toEqual(beforeRuns);

    const addReplacement = button(outcome, `최신 파이프라인 #${blockedById} 연결`);
    await addReplacement.press('Enter');
    const addForm = gitlab.getByRole('form', { name: 'GitLab 링크 추가', exact: true });
    const address = addForm.getByRole('textbox', { name: 'GitLab URL', exact: true });
    await expect(address).toHaveValue(replacementUrl);
    await expect(address).toBeFocused();
    await expect(addForm.getByRole('combobox', { name: 'GitLab 저장소', exact: true })).toHaveValue(String(repositoryId));
    expect(calls).toHaveLength(0);
    const linking = page.waitForResponse(response => new URL(response.url()).pathname === `${issuePath}/gitlab-links` && response.request().method() === 'POST');
    await button(addForm, 'GitLab 링크 연결').click();
    const linkResponse = await linking;
    expect(linkResponse.request().postDataJSON()).toEqual({ repositoryId, url: replacementUrl, expectedSettingsVersion: configured.version });
    const linkedReplacement = await json<GitlabLink>(linkResponse, 201);
    expect(linkedReplacement).toMatchObject({ issueId: issue.id, projectId: repositoryId, iid: blockedById, state: 'running' });
    expect(calls.splice(0).map(url => url.pathname)).toEqual([projectRead, pipelineRead(blockedById)]);
    await expect(addForm).toHaveCount(0);
    const reviewReplacement = button(outcome, `최신 파이프라인 #${blockedById} 상태 검토`);
    await expect(reviewReplacement).toBeFocused();
    replacementCompleted = true;
    finishedAt = new Date().toISOString();
    const replacementReview = await refreshActivity(page, reviewReplacement, reviewPath(linkedReplacement));
    expect(reviewedQueries(blockedById, blockedRef)).toEqual([]);
    expect(replacementReview.statusReview).toMatchObject({ kind: 'suggestion',
      suggestion: { issueId: issue.id, toStatus: 'done', evidence: { link: { id: linkedReplacement.id } } },
    });
    await expect(outcome).toBeFocused();
    await expect(status).toHaveValue(issue.status);
    await expect(title).toHaveValue('아직 저장하지 않은 최신 파이프라인 검토 제목');
    await expect(comment).toHaveValue('보내지 않은 파이프라인 검토 댓글');
    expect((await workspace()).issues.find(row => row.id === issue.id)).toEqual(issue);
    expect(await json(await request.get(runsPath))).toEqual(beforeRuns);

    const latest = await refreshActivity(page, button(row(readyId), selectedReviewAction), reviewPath(ready));
    expect(reviewedQueries(readyId, readyRef)).toEqual([pipelineRead(taggedId)]);
    await expect(replacement).toHaveCount(0);
    if (latest.statusReview?.kind !== 'suggestion') throw new Error('최신 계열 파이프라인의 상태 변경 제안이 없습니다.');
    const { suggestion } = latest.statusReview;
    expect(suggestion).toMatchObject({ issueId: issue.id, toStatus: 'done', rule: { id: rule.id },
      evidence: { link: { id: ready.id, pipelineSource: 'push', pipelineTag: false } },
    });
    await expect(proposal).toContainText(rule.name);
    await expect(status).toHaveValue(issue.status);
    await button(proposal, '목표 상태로 편집').click();
    await expect(status).toHaveValue('done');
    expect((await workspace()).issues.find(row => row.id === issue.id)).toEqual(issue);

    newRun = true;
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
    await button(ticket, '변경사항 저장').click();
    const rejected = await saving;
    expect(rejected.request().postDataJSON()).toMatchObject({ gitlabStatusSuggestionToken: suggestion.token, status: 'done' });
    expect(await json(rejected, 409)).toMatchObject({ details: { reason: 'gitlab_status_suggestion_stale' } });
    expect(reviewedQueries(readyId, readyRef)).toEqual([pipelineRead(newRunId)]);
    await expect(ticket.locator('form.issue-detail-form').getByRole('alert')).toContainText('다시 확인');
    await expect(status).toHaveValue(issue.status);
    await expect(title).toHaveValue('아직 저장하지 않은 최신 파이프라인 검토 제목');
    await expect(comment).toHaveValue('보내지 않은 파이프라인 검토 댓글');
    const after = await workspace();
    expect(after.issues.find(row => row.id === issue.id)).toEqual(issue);
    expect(after.gitlabLinks.filter(row => row.issueId === issue.id).map(link => link.iid).sort()).toEqual([blockedId, readyId, blockedById]);
    expect(await json(await request.get(runsPath))).toEqual(beforeRuns);
  } finally {
    try {
      if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`);
      const deleted = await request.delete(issuePath);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json() as { trashEntryId: string }).trashEntryId}`);
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }
});
