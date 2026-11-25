import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse } from '@playwright/test';
import { gitlabFollowUpPath } from '../../shared/gitlab-follow-up';
import type { GitlabLink, GitlabSettings, Issue, IssueRelation, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

const gitlabSettings = '/api/integrations/gitlab';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

test.use({ trace: 'off', screenshot: 'off' });

test('360px saved GitLab failure opens an ordinary follow-up with stale and lost-response recovery', async ({ page, request }) => {
  test.setTimeout(85_000);
  const initial = await json<GitlabSettings>(await request.get(gitlabSettings));
  const workspace = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const project = (await workspace()).projects[0];
  const source = await json<Issue>(await request.post('/api/issues', {
    data: { projectId: project.id, title: `합성 원본 ${randomUUID().slice(0, 8)}` },
  }), 201);
  const gitlabRequests: string[] = [];
  const remote = createServer((incoming, response) => {
    gitlabRequests.push(`${incoming.method} ${incoming.url}`);
    response.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const base = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/forge`;
  const repository = `${base}/team/ci-follow-up`;
  const secret = `synthetic-hook-${randomUUID()}`;
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const workflow = await json<ProjectWorkflow>(await request.get(workflowPath));
  let modifiedWorkflow: ProjectWorkflow | undefined;
  let created: Issue | undefined;
  const epoch = Date.now() - 60_000;
  const at = (id: number) => new Date(epoch + (id - 700) * 1000).toISOString();
  async function publish(id: number, ref: string, state: 'failed' | 'success') {
    const result = await json<{ linked: number }>(await request.post(`${gitlabSettings}/webhook`, {
      headers: { 'X-Gitlab-Event': 'Pipeline Hook', 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
      data: { object_kind: 'pipeline', project: { id: 42, web_url: repository }, object_attributes: {
        id, iid: id - 600, project_id: 42, ref: `ci/${source.key}/${ref}`, status: state,
        sha: 'a'.repeat(40), source: 'push', tag: false, updated_at: at(id), finished_at: at(id),
      } },
    }));
    expect(result.linked).toBe(1);
  }
  try {
    await json<GitlabSettings>(await request.patch(gitlabSettings, { data: {
      expectedVersion: initial.version, baseUrl: base, projectIds: [42], token: '', webhookSecret: secret,
    } }));
    await publish(700, 'resolved', 'failed');
    await publish(701, 'resolved', 'success');
    await publish(702, 'needs-repair', 'failed');
    const callsBefore = [...gitlabRequests];
    const links = (await workspace()).gitlabLinks.filter(link => link.issueId === source.id);
    const wanted = links.find(link => link.iid === 102)!;
    const older = links.find(link => link.iid === 100)!;
    const path = `/api${gitlabFollowUpPath(source.id, wanted.id)}`;
    const row = (link: GitlabLink) => page.locator(`li[data-gitlab-link-id="${link.id}"]`);
    const action = '후속 업무 만들기';
    const sourceTitle = '저장하지 않은 원본 제목';
    const repairTitle = '회귀 테스트 실패 재현 및 수정';
    const note = '보드에서 맡을 작업을 정리합니다.';
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${source.id}`);
    const sourceDrawer = page.getByRole('dialog', { name: source.title, exact: true });
    await sourceDrawer.getByRole('textbox', { name: '제목', exact: true }).fill(sourceTitle);
    await sourceDrawer.getByRole('textbox', { name: '댓글 내용', exact: true }).fill('보관할 원본 댓글 초안');
    await expect(row(older)).toBeVisible();
    await expect(row(older).getByRole('button', { name: action })).toHaveCount(0);
    const opener = row(wanted).getByRole('button', { name: action, exact: true });
    await opener.click();
    const form = page.getByRole('dialog', { name: 'GitLab 후속 업무 만들기', exact: true });
    const title = form.getByRole('textbox', { name: '업무 제목', exact: true });
    const evidence = form.getByRole('region', { name: '저장할 GitLab 근거', exact: true });
    await expect(title).toBeFocused();
    await expect(title).toHaveValue(`${source.key} · GitLab 파이프라인 #702 실패 후속 작업`);
    await expect(evidence.getByRole('link', { name: 'GitLab 파이프라인 #702' })).toHaveAttribute('href', `${repository}/-/pipelines/702`);
    await title.fill(repairTitle);
    await form.locator('textarea[name="description"]').fill(note);
    const save = form.getByRole('button', { name: '업무 만들고 연결', exact: true });

    modifiedWorkflow = await json<ProjectWorkflow>(await request.patch(workflowPath, { data: {
      ...workflow, expectedVersion: workflow.version,
      fieldRules: [...workflow.fieldRules, { issueType: '*', statusId: workflow.initialStatusId, requiredFields: ['dueDate'] }],
    } }));
    await save.click();
    await expect(form.getByRole('alert')).toContainText('업무 양식이 변경되었습니다');
    await expect(title).toHaveValue(repairTitle);
    await form.getByRole('button', { name: '최신 GitLab 근거 확인', exact: true }).click();
    await expect(save).toBeEnabled();
    await expect(form.locator('textarea[name="description"]')).toHaveValue(note);
    await form.locator('input[name="dueDate"]').fill('2027-03-02');
    const posts: string[] = [];
    await page.route(url => url.pathname === path, async intercepted => {
      if (intercepted.request().method() !== 'POST') return intercepted.continue();
      posts.push(intercepted.request().postData() ?? '');
      if (posts.length !== 1) return intercepted.continue();
      created = await json<Issue>(await intercepted.fetch(), 201);
      await intercepted.abort('failed');
    });
    await save.click();
    const recover = form.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(recover).toBeFocused();
    await recover.click();
    await expect(form).toHaveCount(0);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBe(posts[0]);
    await expect(opener).toBeFocused();
    await expect(sourceDrawer.getByRole('textbox', { name: '제목', exact: true })).toHaveValue(sourceTitle);
    await expect(sourceDrawer.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue('보관할 원본 댓글 초안');
    const stored = await workspace();
    const [repair] = stored.issues.filter(issue => issue.title === repairTitle);
    expect(repair.id).toBe(created!.id);
    expect(repair.description).toBe(`${note}\n\nGitLab 파이프라인 #702 · 실패\n원본 업무 ${source.key}\n${repository}/-/pipelines/702`);
    expect(stored.issues.filter(issue => issue.title === repairTitle)).toHaveLength(1);
    expect(stored.gitlabLinks.filter(link => link.issueId === repair.id)).toEqual([]);
    const relations = await json<IssueRelation[]>(await request.get(`/api/issues/${source.id}/relations`));
    expect(relations).toHaveLength(1);
    expect(relations[0].type).toBe('related');
    expect(new Set([relations[0].sourceIssueId, relations[0].targetIssueId])).toEqual(new Set([source.id, repair.id]));
    await expect(sourceDrawer.getByRole('button', { name: `${repair.key} 업무 열기` })).toBeVisible();

    const navigate = page.waitForEvent('dialog').then(confirmation => confirmation.accept());
    await sourceDrawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await navigate;
    await page.goto(`/#/${project.id}/development`);
    await row(wanted).getByRole('button', { name: action, exact: true }).click();
    await expect(evidence.getByRole('link', { name: 'GitLab 파이프라인 #702' })).toBeVisible();
    await form.getByRole('button', { name: '취소', exact: true }).click();
    await expect(row(wanted).getByRole('button', { name: action, exact: true })).toBeFocused();
    expect(gitlabRequests).toEqual(callsBefore);
  } finally {
    if (modifiedWorkflow) await request.patch(workflowPath, { data: { ...workflow, expectedVersion: modifiedWorkflow.version } });
    if (created) await request.delete(`/api/issues/${created.id}?expectedVersion=${created.version}`);
    await request.delete(`/api/issues/${source.id}?expectedVersion=${source.version}`);
    const saved = await json<GitlabSettings>(await request.get(gitlabSettings));
    await request.patch(gitlabSettings, { data: { expectedVersion: saved.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '' } });
    await new Promise<void>(resolve => remote.close(() => resolve()));
  }
});
