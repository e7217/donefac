import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Issue, IssueAssignmentRule, IssueAssignmentRunPage, WorkspaceSnapshot } from '../../shared/types';

test('프로젝트에서 배정 규칙을 미리 보고 상태만 저장해 담당자 배정 이력을 확인한다', async ({ page, request }) => {
  const workspace = async () => await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const { projects: [project], users: [, target] } = await workspace();
  const rulesPath = `/api/projects/${project.id}/assignment-rules`;
  const runsPath = `/api/projects/${project.id}/assignment-runs`;
  const title = `배정 확인 ${randomUUID().slice(0, 8)}`;
  const created = await request.post('/api/issues', { data: { projectId: project.id, title, status: 'todo' } });
  expect(created.status(), await created.text()).toBe(201);
  const issue = await created.json() as Issue;
  let ruleId: string | undefined;

  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/settings`);
    const settings = page.getByRole('region', { name: '상태별 담당자 자동 배정', exact: true });
    await settings.getByRole('button', { name: '배정 규칙 만들기', exact: true }).click();
    const editor = settings.getByRole('region', { name: '담당자 배정 규칙 편집', exact: true });
    const name = `${title} 규칙`;
    await editor.getByLabel('배정 규칙 이름', { exact: true }).fill(name);
    await editor.getByLabel('배정 출발 상태 할 일', { exact: true }).check();
    await editor.getByLabel('배정 도착 상태', { exact: true }).selectOption('review');
    await editor.getByLabel('배정 대상 팀원', { exact: true }).selectOption(target.id);
    await editor.getByLabel(`${issue.key} 배정 미리보기 선택`, { exact: true }).check();

    await editor.getByRole('button', { name: '배정 미리보기', exact: true }).click();
    await expect(editor.getByText('배정 예정', { exact: true })).toBeVisible();
    await expect(editor.getByText(`미지정 → ${target.name}`, { exact: true })).toBeVisible();
    expect((await workspace()).issues.find(item => item.id === issue.id)).toMatchObject({
      assigneeId: null, status: 'todo', version: issue.version,
    });
    expect((await (await request.get(runsPath)).json()).total).toBe(0);

    const saved = page.waitForResponse(response => new URL(response.url()).pathname === rulesPath && response.request().method() === 'POST');
    const save = editor.getByRole('button', { name: '배정 규칙 저장', exact: true });
    await save.click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(201);
    const rule = await response.json() as IssueAssignmentRule;
    ruleId = rule.id;
    expect(rule.enabled).toBe(false);
    const enabled = editor.getByLabel('배정 규칙 활성화', { exact: true });
    await expect(enabled).toBeEnabled();
    await enabled.check();
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === `${rulesPath}/${rule.id}` && response.request().method() === 'PATCH');
    await save.click();
    const activated = await updated;
    expect(activated.ok(), await activated.text()).toBeTruthy();
    expect((await activated.json() as IssueAssignmentRule).enabled).toBe(true);
    await expect(save).toBeEnabled();
    await editor.getByRole('button', { name: '배정 규칙 편집 닫기', exact: true }).click();

    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const issuePanel = page.getByRole('dialog');
    const assignee = issuePanel.getByLabel('담당자', { exact: true });
    await expect(assignee).toHaveValue('');
    await issuePanel.getByLabel('상태', { exact: true }).selectOption('review');
    await issuePanel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await expect(assignee).toHaveValue(target.id);
    const changed = (await workspace()).issues.find(item => item.id === issue.id);
    expect(changed).toMatchObject({ assigneeId: target.id, status: 'review', version: issue.version + 1 });
    await issuePanel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await page.goto(`/#/${project.id}/settings`);
    const history = settings.getByRole('region', { name: '담당자 배정 실행 기록', exact: true });
    const entry = history.getByRole('row').filter({ hasText: issue.key });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('배정됨');
    await expect(entry).toContainText(target.name);
    const runs = await (await request.get(runsPath)).json() as IssueAssignmentRunPage;
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({ issueId: issue.id, ruleId: rule.id, source: 'user', outcome: 'assigned' });
    await entry.getByRole('button', { name: issue.key, exact: true }).click();
    await expect(issuePanel.getByRole('heading', { name: issue.title, exact: true })).toBeVisible();
  } finally {
    if (ruleId) {
      const configured = await (await request.get(rulesPath)).json() as IssueAssignmentRule[];
      const saved = configured.find(rule => rule.id === ruleId);
      if (saved) await request.delete(`${rulesPath}/${saved.id}?expectedVersion=${saved.version}`);
    }
    await request.delete(`/api/issues/${issue.id}`);
  }
});
