import { expect, test, type APIResponse, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Comment, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('360px 티켓에서 GitLab 활동을 댓글 초안에 추가하고 멘션과 재시도 요청을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const gitlabRequests: string[] = [];
  const mock = createServer((incoming, response) => {
    gitlabRequests.push(incoming.url ?? '');
    response.writeHead(404).end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const repositoryUrl = `${baseUrl}/example/handoff`;
  const mergeRequestUrl = `${repositoryUrl}/-/merge_requests/14`;
  const pipelineUrl = `${repositoryUrl}/-/pipelines/820`;
  const settingsPath = '/api/integrations/gitlab';
  const secret = `synthetic-comment-draft-${randomUUID()}`;
  const projectId = 830;
  let issue: Issue | undefined;
  let originalSettings: GitlabSettings | undefined;
  const deliver = async (data: object) => {
    const response = await request.post(`${settingsPath}/webhook`, { data, headers: { 'X-GitLab-Token': secret, 'webhook-id': randomUUID() } });
    expect(await json(response)).toMatchObject({ duplicate: false, linked: 1 });
  };

  try {
    const { projects: [project], users: [author, recipient] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    originalSettings = await json<GitlabSettings>(await request.get(settingsPath));
    expect(originalSettings.baseUrl).toBe('');
    await json(await request.patch(settingsPath, {
      data: { expectedVersion: originalSettings.version, baseUrl, projectIds: [projectId], webhookSecret: secret },
    }));
    const actor = { 'X-Actor-Id': author.id };
    const title = `GitLab 인계 ${randomUUID().slice(0, 8)}`;
    issue = await json<Issue>(await request.post('/api/issues', { headers: actor, data: { projectId: project.id, title } }), 201);
    const branch = `feature/${issue.key}`;
    const mrTitle = `${issue.key} 입력 방식 정리`;
    const repository = { id: projectId, web_url: repositoryUrl };
    await deliver({ object_kind: 'merge_request', project: repository, object_attributes: {
      id: 814, iid: 14, action: 'open', state: 'opened', title: mrTitle, source_branch: branch,
      web_url: `${mergeRequestUrl}?view=parallel#notes`, updated_at: new Date().toISOString(),
    } });
    await deliver({ object_kind: 'pipeline', project: repository, object_attributes: {
      id: 820, iid: 20, status: 'failed', sha: 'a'.repeat(40), ref: branch, url: pipelineUrl, updated_at: new Date().toISOString(),
    } });

    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const field = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const addLink = (kind: string) => panel.locator(`[data-gitlab-kind="${kind}"]`).getByRole('button', { name: '댓글 초안에 추가', exact: true });
    const addMr = addLink('merge_request');
    const addPipeline = addLink('pipeline');
    await expect(addMr).toBeEnabled();
    await expect(addPipeline).toBeEnabled();

    const longDraft = '초'.repeat(10_000);
    await field.fill(longDraft);
    await addMr.click();
    await expect(field).toHaveValue(longDraft);
    await expect(page.getByText('댓글을 10,000자 이내로 줄인 뒤 GitLab 활동을 추가해 주세요.')).toBeVisible();
    await field.fill(`함께 확인해 주세요 @${recipient.email}`);
    const mention = page.getByRole('listbox', { name: '팀원 멘션', exact: true }).getByRole('option').filter({ hasText: recipient.email });
    await expect(mention).toBeVisible();
    await field.press('Enter');
    const prefix = await field.inputValue();
    expect(prefix).toContain(`@${recipient.name}`);
    const mrDraft = `${prefix}\n\nGitLab MR !14 · 저장 상태 열림 · ${mrTitle}\n<${mergeRequestUrl}>`;
    await addMr.click();
    await expect(field).toHaveValue(mrDraft);
    await expect(field).toBeFocused();
    await addMr.click();
    await expect(field).toHaveValue(mrDraft);

    await page.reload();
    await expect(field).toHaveValue(mrDraft);
    await expect(panel.locator('.issue-comment')).toHaveCount(0);
    let original: Comment | undefined;
    await page.route('**/api/comments', async route => {
      const sent = await route.fetch();
      original = await json<Comment>(sent, 201);
      await route.abort('failed');
    }, { times: 1 });
    await panel.getByRole('button', { name: '댓글 등록', exact: true }).click();
    const retry = panel.getByRole('button', { name: '등록 결과 다시 확인', exact: true });
    await expect(retry).toBeEnabled();
    await expect(addPipeline).toBeDisabled();
    expect(original?.mentions?.map(item => item.userId)).toEqual([recipient.id]);
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/comments' && result.request().method() === 'POST');
    await retry.click();
    expect((await json<Comment>(await response)).id).toBe(original?.id);
    const saved = panel.locator('.issue-comment');
    await expect(saved).toHaveCount(1);
    await expect(saved.getByRole('link')).toHaveAttribute('href', mergeRequestUrl);
    await expect(field).toHaveValue('');
    await addPipeline.click();
    expect((await field.inputValue()).split('\n')).toEqual([
      expect.stringMatching(/^GitLab 파이프라인 #20 · 저장 상태 실패(?: · .*)?$/u), `<${pipelineUrl}>`,
    ]);
    expect(gitlabRequests).toEqual([]);
  } finally {
    if (issue) {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json()).trashEntryId}`);
    }
    if (originalSettings?.baseUrl === '') {
      const current = await json<GitlabSettings>(await request.get(settingsPath));
      await json(await request.patch(settingsPath, { data: { expectedVersion: current.version, enabled: false, baseUrl: '', projectIds: [], webhookSecret: '' } }));
    }
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
  }
});
