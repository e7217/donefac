import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, IssueBulkEditPreview, IssueBulkEditResult, Project, ProjectWorkflow, TeamIssueBulkEditPreviewInput, WorkflowStatus, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/team/issues/bulk-preview';
const applyPath = '/api/team/issues/bulk-apply';
const workflowPath = (project: Project) => `/api/projects/${project.id}/workflow`;
const issuePath = (issue: Issue) => `/api/issues/${issue.id}`;

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const posted = (page: Page, path: string) => page.waitForResponse(response =>
  new URL(response.url()).pathname === path && response.request().method() === 'POST');

test('360px 팀 보드에서 보이는 업무를 프로젝트별 상태로 검토하고 적용 응답이 유실돼도 한 번만 변경한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [first, second], users: [actor, assignee] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const prefix = `보드 일괄 ${suffix}`;
  const query = `${prefix} 대상`;
  const previousLabel = `기존-${suffix}`;
  const newLabel = `변경-${suffix}`;
  const dueDate = '2031-05-14';
  const sharedStatus = `shared_${suffix}`;
  const firstReview = { id: sharedStatus, label: `왼쪽 검토 ${suffix}`, category: 'review', color: '#537ba5' } as const;
  const secondBlocked = { id: sharedStatus, label: `오른쪽 설명 검토 ${suffix}`, category: 'review', color: '#527ba3' } as const;
  const secondReady = { id: `ready_${suffix}`, label: `오른쪽 진행 ${suffix}`, category: 'in_progress', color: '#4f8a7a' } as const;
  const workflows = new Map<string, ProjectWorkflow>();
  const issues: Issue[] = [];

  async function configure(project: Project, statuses: WorkflowStatus[], transitions: ProjectWorkflow['transitions']) {
    const before = await json<ProjectWorkflow>(await request.get(workflowPath(project)));
    workflows.set(project.id, before);
    return json<ProjectWorkflow>(await request.patch(workflowPath(project), { headers, data: {
      ...before, expectedVersion: before.version, statuses: [...before.statuses, ...statuses], transitions: [...before.transitions, ...transitions],
    } }));
  }

  async function createIssue(project: Project, title: string) {
    const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
      title: `${prefix} ${title}`, projectId: project.id, status: 'todo', priority: 'medium', assigneeId: actor.id, labels: [previousLabel],
    } }), 201);
    issues.push(issue);
    return issue;
  }

  const currentIssues = async () => {
    const current = (await workspace(request)).issues;
    return issues.map(issue => current.find(item => item.id === issue.id));
  };

  try {
    const firstWorkflow = await configure(first, [firstReview], [{ from: 'todo', to: firstReview.id, issueTypes: [], requiredFields: [] }]);
    const secondWorkflow = await configure(second, [secondBlocked, secondReady], [
      { from: 'todo', to: secondBlocked.id, issueTypes: [], requiredFields: ['description'] },
      { from: 'todo', to: secondReady.id, issueTypes: [], requiredFields: [] },
    ]);
    const left = await createIssue(first, '대상 첫째');
    const right = await createIssue(second, '대상 둘째');
    const hidden = await createIssue(first, '별도 카드');

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${first.id}/teamboard`);
    const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
    const search = page.getByRole('searchbox', { name: '보드 업무 검색', exact: true });
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const card = (issue: Issue) => board.locator(`[data-issue-id="${issue.id}"]`);
    const checkbox = (issue: Issue) => card(issue).getByRole('checkbox', { name: `${issue.key} 업무 선택`, exact: true });
    await expect(board).toBeVisible();
    await search.fill(prefix);
    await page.getByRole('button', { name: '보드 일괄 편집', exact: true }).click();
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    const previewRegion = editor.getByRole('region', { name: '일괄 변경 미리보기', exact: true });
    const previewButton = editor.getByRole('button', { name: '변경 미리보기', exact: true });
    const applyButton = editor.getByRole('button', { name: '일괄 적용', exact: true });
    const statusSelect = (project: Project) => editor.getByRole('combobox', { name: `일괄 상태 ${project.name}`, exact: true });
    const priority = editor.getByRole('combobox', { name: '일괄 변경 우선순위', exact: true });
    await expect(editor).toBeVisible();
    const bounds = await editor.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await checkbox(hidden).check();
    await checkbox(left).check();
    await checkbox(right).check();
    await statusSelect(first).selectOption(firstReview.id);
    await statusSelect(second).selectOption(secondBlocked.id);
    await priority.selectOption('high');

    await search.fill(query);
    await expect(card(hidden)).toHaveCount(0);
    await expect(checkbox(left)).toBeChecked();
    await expect(checkbox(right)).toBeChecked();
    await expect(statusSelect(first)).toHaveValue(firstReview.id);
    await expect(priority).toHaveValue('high');
    await projectFilter.selectOption(first.id);
    await expect(card(right)).toHaveCount(0);
    await expect(statusSelect(second)).toHaveCount(0);
    await expect(checkbox(left)).toBeChecked();
    await expect(statusSelect(first)).toHaveValue(firstReview.id);
    await projectFilter.selectOption('');
    await expect(checkbox(right)).not.toBeChecked();
    await checkbox(right).check();
    await expect(statusSelect(second)).toHaveValue('');
    await expect(statusSelect(first).locator(`option[value="${sharedStatus}"]`)).toHaveText(firstReview.label);
    await expect(statusSelect(second).locator(`option[value="${sharedStatus}"]`)).toHaveText(secondBlocked.label);
    await statusSelect(second).selectOption(secondBlocked.id);
    await editor.getByRole('combobox', { name: '일괄 변경 담당자', exact: true }).selectOption(`team-member:${assignee.id}`);
    await editor.getByRole('combobox', { name: '일괄 변경 마감일', exact: true }).selectOption('set');
    await editor.getByLabel('지정할 마감일', { exact: true }).fill(dueDate);
    await editor.getByRole('textbox', { name: '추가할 라벨', exact: true }).fill(newLabel);
    await editor.getByText('제거할 라벨 선택', { exact: true }).click();
    await editor.getByRole('checkbox', { name: `${previousLabel} 라벨 제거`, exact: true }).check();

    const blockedPost = posted(page, previewPath);
    await previewButton.click();
    const blocked = await json<IssueBulkEditPreview>(await blockedPost);
    expect(blocked).toMatchObject({ changed: 1, blocked: 1, previewId: null });
    await expect(previewRegion).toContainText('설명');
    await expect(applyButton).toHaveCount(0);
    expect(await currentIssues()).toEqual(issues);

    await statusSelect(second).selectOption(secondReady.id);
    const previewPost = posted(page, previewPath);
    await previewButton.click();
    const previewResponse = await previewPost;
    const input = previewResponse.request().postDataJSON() as TeamIssueBulkEditPreviewInput;
    expect(input).toEqual({
      issues: expect.arrayContaining([left, right].map(({ id, projectId, version }) => ({ id, projectId, expectedVersion: version }))),
      changes: { priority: 'high', assigneeId: assignee.id, dueDate, addLabels: [newLabel], removeLabels: [previousLabel] },
      statuses: { [first.id]: firstReview.id, [second.id]: secondReady.id },
      workflowVersions: { [first.id]: firstWorkflow.version, [second.id]: secondWorkflow.version },
    });
    expect(input.issues).toHaveLength(2);
    const preview = await json<IssueBulkEditPreview>(previewResponse);
    expect(preview).toMatchObject({ changed: 2, unchanged: 0, blocked: 0, previewId: expect.any(String) });
    expect(preview.rows).toEqual(expect.arrayContaining([left, right].map(issue => expect.objectContaining({
      id: issue.id, projectId: issue.projectId,
      after: { status: input.statuses?.[issue.projectId], priority: 'high', assigneeId: assignee.id, dueDate, labels: [newLabel] },
    }))));
    await expect(previewRegion).toContainText(firstReview.label);
    await expect(previewRegion).toContainText(secondReady.label);
    await expect(previewRegion).not.toContainText(hidden.key);
    expect(await currentIssues()).toEqual(issues);

    const applies: unknown[] = [];
    await page.route(`**${applyPath}`, async route => {
      applies.push(route.request().postDataJSON());
      const committed = await route.fetch();
      if (applies.length === 1 && committed.ok()) {
        await route.fulfill({ status: 408, json: { error: '합성 일괄 편집 응답 유실' } });
      } else {
        await route.fulfill({ response: committed });
      }
    });
    const firstApply = posted(page, applyPath);
    await applyButton.click();
    expect((await firstApply).status()).toBe(408);
    await expect(editor.getByRole('alert')).toContainText('적용 결과를 확인하지 못했습니다');
    await expect(projectFilter).toBeDisabled();
    const recovery = posted(page, applyPath);
    await editor.getByRole('button', { name: '적용 결과 다시 확인', exact: true }).click();
    const receipt = await json<IssueBulkEditResult>(await recovery);
    expect(receipt).toEqual({ previewId: preview.previewId, updated: expect.arrayContaining([left, right].map(({ id, key, version }) =>
      ({ id, key, version: version + 1 }))), unchanged: 0 });
    expect(receipt.updated).toHaveLength(2);
    expect(applies).toEqual([{ previewId: preview.previewId }, { previewId: preview.previewId }]);
    await expect(previewRegion).toHaveCount(0);
    await expect(card(left).locator('[data-board-status]')).toHaveText(firstReview.label);
    await expect(card(right).locator('[data-board-status]')).toHaveText(secondReady.label);
    await expect(search).toHaveValue(query);
    await expect(card(hidden)).toHaveCount(0);
    expect(await currentIssues()).toEqual([
      expect.objectContaining({ id: left.id, version: left.version + 1, status: firstReview.id,
        priority: 'high', assigneeId: assignee.id, dueDate, labels: [newLabel] }),
      expect.objectContaining({ id: right.id, version: right.version + 1, status: secondReady.id,
        priority: 'high', assigneeId: assignee.id, dueDate, labels: [newLabel] }),
      hidden,
    ]);
  } finally {
    for (const issue of issues.reverse()) {
      const removed = await request.delete(issuePath(issue), { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
    for (const project of [first, second]) {
      const before = workflows.get(project.id);
      if (!before) continue;
      const current = await json<ProjectWorkflow>(await request.get(workflowPath(project)));
      if (current.version === before.version) continue;
      await json<ProjectWorkflow>(await request.patch(workflowPath(project), { headers, data: {
        ...before, expectedVersion: current.version,
        transitions: before.transitions.map(edge => ({ ...edge, requireResolvedBlockers: edge.requireResolvedBlockers === true })),
      } }));
    }
  }
});
