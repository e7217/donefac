import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { AutomationRule, GitlabSettings, Issue, IssueAutomationRunPage, Project, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const settingsPath = '/api/integrations/gitlab';

test('360px 티켓에서 GitLab 상태 자동화 차단을 확인하고 초안을 유지하며 상태를 변경한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const initial = await workspace(request);
  const [editor, automationActor] = initial.users;
  const original = await json<GitlabSettings>(await request.get(settingsPath));
  expect(original).toMatchObject({ baseUrl: '', projectIds: [], tokenConfigured: false, webhookSecretConfigured: false });
  const key = `AH${randomUUID().slice(0, 8).toUpperCase()}`;
  const project = await json<Project>(await request.post('/api/projects', { data: { key, name: `${key} 자동화 기록 검증` } }), 201);
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const workflow = await json<ProjectWorkflow>(await request.get(workflowPath));
  await json<ProjectWorkflow>(await request.patch(workflowPath, { data: { ...workflow, expectedVersion: workflow.version,
    fieldRules: [{ issueType: '*', statusId: 'done', requiredFields: ['description'] }],
  } }));
  const issue = await json<Issue>(await request.post('/api/issues', { data: { projectId: project.id, status: 'todo', title: '병합 후 설명을 확인할 업무' } }), 201);
  const issuePath = `/api/issues/${issue.id}`;
  const historyPath = `${issuePath}/automation-runs`;
  const secret = `synthetic-ticket-history-${randomUUID()}`;
  const gitlab = createServer((_request, response) => { response.writeHead(404); response.end(); });
  gitlab.listen(0, '127.0.0.1');
  await once(gitlab, 'listening');
  const baseUrl = `http://127.0.0.1:${(gitlab.address() as { port: number }).port}/gitlab`;
  const mrUrl = `${baseUrl}/test/engine/-/merge_requests/31`;
  const branch = `feature/${issue.key}-review`;
  const draftTitle = '내가 작성 중인 제목';
  const draftComment = '아직 보내지 않은 댓글';
  const description = '병합 결과와 완료 조건을 확인했습니다.';
  const eventId = randomUUID();
  let rule: AutomationRule | undefined;

  try {
    await json<GitlabSettings>(await request.patch(settingsPath, { data: { expectedVersion: original.version, baseUrl, projectIds: [42], webhookSecret: secret } }));
    rule = await json<AutomationRule>(await request.post('/api/automation-rules', { data: {
      projectId: project.id, name: 'MR 완료 전 설명 검사', enabled: true, trigger: 'merge_request.merged', gitlabProjectIds: [42],
      branchPattern: 'feature/*', issueTypes: [], fromStatuses: ['todo'], toStatusId: 'done', actorId: automationActor.id,
    } }), 201);

    const headers = { 'X-Gitlab-Token': secret, 'X-Gitlab-Event': 'Merge Request Hook', 'webhook-id': eventId };

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), editor.id);
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const ticket = page.getByRole('dialog');
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const status = ticket.getByRole('combobox', { name: '상태', exact: true });
    const history = ticket.getByRole('region', { name: 'GitLab 상태 자동화 기록', exact: true });
    const refresh = history.getByRole('button', { name: '자동화 기록 새로고침', exact: true });
    const review = history.getByRole('button', { name: '목표 상태로 편집', exact: true });
    await expect(refresh).toBeEnabled({ timeout: 25_000 });
    await expect(review).toHaveCount(0);
    await title.fill(draftTitle);
    await comment.fill(draftComment);

    const event = { object_kind: 'merge_request', project: { id: 42 }, object_attributes: {
      id: 773, iid: 31, target_project_id: 42, action: 'merge', state: 'merged', title: `${issue.key} synthetic MR`,
      source_branch: branch, url: mrUrl, updated_at: new Date().toISOString(),
    } };
    const deliver = () => request.post(`${settingsPath}/webhook`, { headers, data: event });
    await json(await deliver());
    const before = await json<IssueAutomationRunPage>(await request.get(historyPath));
    expect(before.issueVersion).toBe(issue.version);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({ issueId: issue.id, ruleId: rule.id, actorId: automationActor.id,
      fromStatus: 'todo', toStatus: 'done', outcome: 'blocked', reason: expect.stringContaining('설명'),
      context: { ruleName: rule.name, gitlabProjectId: 42, objectId: '773', objectKind: 'merge_request', branch },
    });
    expect(before.latestBlockedRunId).toBe(before.items[0].id);

    await refresh.click();
    await expect(history).toContainText(rule.name);
    await expect(history).toContainText('차단');
    await expect(history).toContainText('할 일');
    await expect(history).toContainText('완료');
    await expect(history).toContainText('필수 속성을 입력해 주세요');
    await expect(history).toContainText(branch);
    await expect(history.getByRole('link', { name: 'GitLab 원본 열기', exact: true })).toHaveAttribute('href', mrUrl);
    const bounds = await history.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
    await expect(title).toHaveValue(draftTitle);
    await expect(comment).toHaveValue(draftComment);

    await status.selectOption('in_progress');
    await expect(review).toHaveCount(0);
    await status.selectOption('todo');
    await review.click();
    await expect(status).toHaveValue('done');
    await expect(status).toBeFocused();
    await expect(title).toHaveValue(draftTitle);
    await expect(comment).toHaveValue(draftComment);
    expect((await workspace(request)).issues.find(item => item.id === issue.id)).toEqual(issue);

    const save = ticket.getByRole('button', { name: '변경사항 저장', exact: true });
    await save.click();
    await expect(ticket.locator('form.issue-detail-form').getByRole('alert')).toContainText('설명');
    await ticket.getByRole('textbox', { name: '설명', exact: true }).fill(description);
    const update = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
    await save.click();
    expect((await update).status()).toBe(200);
    await expect(save).toBeDisabled();
    await expect(comment).toHaveValue(draftComment);
    const saved = await workspace(request);
    expect(saved.issues.find(item => item.id === issue.id)).toMatchObject({ title: draftTitle, status: 'done', description, version: issue.version + 1 });
    expect(saved.activities.filter(activity => activity.resourceId === issue.id).at(-1)?.actorId).toBe(editor.id);

    expect(await json<{ duplicate: boolean }>(await deliver())).toMatchObject({ duplicate: true });
    await refresh.click();
    await expect(history).toContainText('차단');
    await expect(review).toHaveCount(0);
    expect(await json<IssueAutomationRunPage>(await request.get(historyPath))).toEqual({
      ...before, issueVersion: issue.version + 1, latestBlockedRunId: null,
    });

    await comment.fill('');
    await page.goto(`/#/${project.id}/development`);
    const automation = page.getByRole('region', { name: 'GitLab 상태 자동화 설정', exact: true });
    const projectHistory = automation.getByRole('region', { name: '자동화 실행 기록', exact: true });
    await expect(projectHistory.getByRole('row').filter({ hasText: issue.key })).toContainText('차단');
  } finally {
    try {
      if (rule) await request.delete(`/api/automation-rules/${rule.id}?expectedVersion=${rule.version}`);
      const current = await json<GitlabSettings>(await request.get(settingsPath));
      if (current.baseUrl === baseUrl) await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } });
      const removed = await request.delete(issuePath);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    } finally {
      await new Promise<void>(resolve => gitlab.close(() => resolve()));
    }
  }
});
