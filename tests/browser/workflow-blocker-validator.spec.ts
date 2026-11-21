import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Issue, IssueRelation, ProjectIssueOrder, ProjectWorkflow, WorkflowTransition, WorkspaceSnapshot } from '../../shared/types';

const button = (within: Page | Locator, name: string) => within.getByRole('button', { name, exact: true });
const workflowPath = (projectId: string) => `/api/projects/${projectId}/workflow`;
const orderPath = (projectId: string) => `/api/projects/${projectId}/issue-order`;
const issuePath = (issue: Issue) => `/api/issues/${issue.id}`;
const status = (pane: Locator) => pane.getByLabel('상태', { exact: true });
const dialog = (page: Page, issue: Issue) => page.getByRole('dialog', { name: issue.title, exact: true });
const relations = (pane: Locator) => pane.getByRole('region', { name: '업무 관계', exact: true });
const isGuardedEdge = ({ from, to }: WorkflowTransition) => from === 'todo' && to === 'done';
const edge = (workflow: ProjectWorkflow) => workflow.transitions.find(isGuardedEdge);

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, expected = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json();
}

async function readWorkspace(request: APIRequestContext) {
  return json<WorkspaceSnapshot>(await request.get('/api/workspace'));
}

function waitPatch(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'PATCH');
}

async function saveIssue(page: Page, issue: Issue) {
  const pending = waitPatch(page, issuePath(issue));
  await button(dialog(page, issue), '변경사항 저장').click();
  return pending;
}

test('워크플로 전이에서 열린 차단 업무를 해결해야 보드와 상세의 상태를 변경할 수 있다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const { projects: [project, foreign], users: [actor] } = await readWorkspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const prefix = `열린 차단 검증 ${suffix}`;
  const pendingStatus = `waiting_${suffix}`;
  const terminalStatus = `accepted_${suffix}`;
  const pendingLabel = `승인 대기 ${suffix}`;
  const terminalLabel = `승인 완료 ${suffix}`;
  const description = '승인 이후 확인할 내용';
  const created: Issue[] = [];
  const readWorkflow = async (id: string) => json<ProjectWorkflow>(await request.get(workflowPath(id)));
  const original = await Promise.all([readWorkflow(project.id), readWorkflow(foreign.id)]);
  const [targetWorkflow, sourceWorkflow] = original;
  const readIssue = async (issue: Issue) => (await readWorkspace(request)).issues.find(value => value.id === issue.id);

  async function createIssue(projectId: string, label: string, issueStatus: string) {
    const issue = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId, title: `${prefix} ${label}`, status: issueStatus, description, startDate: '2026-11-23', endDate: '2026-11-24' },
    }), 201);
    created.push(issue);
    return issue;
  }

  try {
    await json<ProjectWorkflow>(await request.patch(workflowPath(foreign.id), {
      headers, data: {
        ...sourceWorkflow, expectedVersion: sourceWorkflow.version,
        statuses: [...sourceWorkflow.statuses,
          { id: pendingStatus, label: pendingLabel, category: 'review', color: '#7994a6' },
          { id: terminalStatus, label: terminalLabel, category: 'done', color: '#24895e' },
        ],
        transitions: [...sourceWorkflow.transitions, { from: pendingStatus, to: terminalStatus, issueTypes: [], requiredFields: [] }],
      },
    }));
    const configured = await json<ProjectWorkflow>(await request.patch(workflowPath(project.id), {
      headers, data: {
        ...targetWorkflow, expectedVersion: targetWorkflow.version,
        transitions: targetWorkflow.transitions.map(value => isGuardedEdge(value)
          ? { ...value, requiredFields: [...new Set([...value.requiredFields, 'description'])] } : value),
      },
    }));
    const transition = configured.transitions.findIndex(isGuardedEdge) + 1;
    expect(transition).toBeGreaterThan(0);
    const source = await createIssue(foreign.id, '다른 프로젝트 승인', pendingStatus);
    const target = await createIssue(project.id, '검토 대상', 'todo');
    const anchor = await createIssue(project.id, '완료 열 기준 업무', 'done');
    const relation = await json<IssueRelation>(await request.post(`${issuePath(source)}/relations`, {
      headers, data: { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' },
    }), 201);

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/settings`);
    const settings = page.getByRole('region', { name: '프로젝트 워크플로 설정', exact: true });
    const transitions = settings.locator('.workflow-tabs button').filter({ hasText: '허용 전이' });
    const requireResolved = settings.getByRole('checkbox', { name: `전이 ${transition} 열린 차단 업무 해결 필요`, exact: true });
    await transitions.click();
    await settings.getByLabel('출발 상태로 전이 필터', { exact: true }).selectOption('todo');
    await expect(requireResolved).not.toBeChecked();
    await requireResolved.check();
    const saving = waitPatch(page, workflowPath(project.id));
    await button(settings, '워크플로 저장').click();
    const guarded = await json<ProjectWorkflow>(await saving);
    expect(edge(guarded)).toMatchObject({ requireResolvedBlockers: true, requiredFields: edge(configured)?.requiredFields });
    expect(guarded.transitions.filter(value => value.requireResolvedBlockers)).toEqual([edge(guarded)]);
    await expect(button(settings, '워크플로 저장')).toBeDisabled();
    await page.reload();
    await transitions.click();
    await expect(requireResolved).toBeChecked();
    expect(edge(await readWorkflow(project.id))).toEqual(edge(guarded));

    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto(`/#/${project.id}/issues`);
    await page.getByRole('textbox', { name: '업무 검색', exact: true }).fill(prefix);
    await button(page, '보드').click();
    const card = (issue: Issue) => page.locator(`.issue-board-card[data-issue-id="${issue.id}"]`);
    const originalOrder = await json<ProjectIssueOrder>(await request.get(orderPath(project.id)));
    const moving = waitPatch(page, orderPath(project.id));
    await card(target).dragTo(card(anchor), { targetPosition: { x: 30, y: 8 } });
    const rejectedMove = await moving;
    expect(rejectedMove.status(), await rejectedMove.text()).toBe(422);
    expect(rejectedMove.request().postDataJSON()).toMatchObject({ issueId: target.id, anchorId: anchor.id, status: 'done' });
    await expect(page.getByRole('status', { name: '업무 순서 상태', exact: true })).toContainText('차단');
    await expect(page.locator('.issue-board-column[data-status-id="todo"]').locator(card(target))).toBeVisible();
    expect(await json<ProjectIssueOrder>(await request.get(orderPath(project.id)))).toEqual(originalOrder);
    expect(await readIssue(target)).toEqual(target);

    await page.setViewportSize({ width: 360, height: 820 });
    await card(target).click();
    const targetPanel = dialog(page, target);
    await status(targetPanel).selectOption('done');
    const rejectedSave = await saveIssue(page, target);
    expect(await json<{ details: unknown }>(rejectedSave, 422)).toMatchObject({ details: { reason: 'open_issue_blockers' } });
    await expect(status(targetPanel)).toHaveValue('done');
    await expect(targetPanel.getByRole('alert')).toContainText('차단');
    expect(await readIssue(target)).toEqual(target);

    const targetRelations = relations(targetPanel);
    await button(targetPanel, '차단 업무 보기').click();
    await expect(targetRelations).toBeFocused();
    await expect(targetRelations.getByText('이 업무가 차단됨', { exact: true })).toBeVisible();
    await expect(targetRelations.getByText('열린 차단 업무', { exact: true })).toBeVisible();
    await expect(targetRelations.getByText(pendingLabel)).toBeVisible();
    page.once('dialog', confirmation => confirmation.accept());
    await button(targetRelations, `${source.key} 업무 열기`).click();

    const sourcePanel = dialog(page, source);
    await expect(sourcePanel).toBeVisible();
    await expect(status(sourcePanel)).toHaveValue(pendingStatus);
    await status(sourcePanel).selectOption(terminalStatus);
    const resolved = await json<Issue>(await saveIssue(page, source));
    expect(resolved.status).toBe(terminalStatus);
    expect(resolved.completedAt).toBeTruthy();
    await relations(sourcePanel).getByRole('button').filter({ hasText: target.title }).click();
    await expect(status(targetPanel)).toHaveValue('todo');
    await status(targetPanel).selectOption('done');
    await targetPanel.getByLabel('설명', { exact: true }).fill('');
    const required = await json<{ details: { requiredFields: string[] } }>(await saveIssue(page, target), 422);
    expect(required.details.requiredFields).toContain('description');
    await expect(targetPanel.getByRole('alert')).toContainText('설명');
    expect(await readIssue(target)).toEqual(target);

    await targetPanel.getByLabel('설명', { exact: true }).fill(description);
    const completed = await json<Issue>(await saveIssue(page, target));
    expect(completed).toMatchObject({ id: target.id, status: 'done', version: target.version + 1, startDate: target.startDate, endDate: target.endDate });
    expect(completed.completedAt).toBeTruthy();
    expect(await readIssue(target)).toEqual(completed);
    expect(await json<IssueRelation[]>(await request.get(`${issuePath(target)}/relations`))).toContainEqual(relation);

    await expect(button(targetPanel, '변경사항 저장')).toBeDisabled();
    await page.goto(`/#/${project.id}/settings`);
    await transitions.click();
    await requireResolved.uncheck();
    const clearing = waitPatch(page, workflowPath(project.id));
    await button(settings, '워크플로 저장').click();
    const cleared = await json<ProjectWorkflow>(await clearing);
    expect(edge(cleared)?.requireResolvedBlockers).not.toBe(true);
    expect(edge(cleared)?.requiredFields).toEqual(edge(configured)?.requiredFields);
  } finally {
    try {
      // Clear the synthetic issue and its trash entry before restoring the configuration it referenced.
      for (const issue of created.reverse()) {
        const removed = await request.delete(issuePath(issue), { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    } finally {
      for (const baseline of original) {
        const current = await readWorkflow(baseline.projectId);
        if (current.version === baseline.version) continue;
        await json<ProjectWorkflow>(await request.patch(workflowPath(baseline.projectId), {
          headers, data: {
            ...baseline, expectedVersion: current.version,
            transitions: baseline.transitions.map(value => ({ ...value, requireResolvedBlockers: value.requireResolvedBlockers === true })),
          },
        }));
      }
    }
  }
});
