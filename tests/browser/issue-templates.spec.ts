import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, IssueTemplate, ProjectIssueSchema, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const settingsPath = (projectId: string) => `/api/projects/${projectId}/issue-templates`;
const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

function waitForCreate(page: Page, pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
}

async function cleanup(request: APIRequestContext, projectId: string, prefix: string) {
  const path = settingsPath(projectId);
  const templates = await json<IssueTemplate[]>(await request.get(path));
  for (const template of templates.filter(item => item.name.startsWith(prefix))) {
    await json(await request.patch(`${path}/${template.id}`, { data: { expectedVersion: template.version, archived: true } }));
  }
  for (const issue of (await workspace(request)).issues.filter(item => item.projectId === projectId && item.title.startsWith(prefix))) {
    const removed = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`));
    expect((await request.delete(`/api/trash/${removed.trashEntryId}`)).ok()).toBe(true);
  }
}

test('프로젝트 설정에 저장한 업무 템플릿을 새 업무에 적용하고 기본값을 편집한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const { projects: [project], users: [actor] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const prefix = `합성 업무 양식 ${suffix}`;
  const name = `${prefix} 검토 템플릿`;
  const title = `${prefix} 기본 제목`;
  const finalTitle = `${prefix} 수정된 제목`;
  const description = '## 배포 점검\n- 재현 절차 확인';
  const path = settingsPath(project.id);
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const fieldId = `bug_context_${suffix}`;
  const fieldName = '버그 재현 환경';
  const fieldDefault = '테스트용 센서';

  try {
    const schema = await json<ProjectIssueSchema>(await request.get(schemaPath));
    await json(await request.patch(schemaPath, { data: {
      ...schema, expectedVersion: schema.version,
      fields: [...schema.fields, {
        id: fieldId, name: fieldName, kind: 'text', issueTypes: ['버그'], description: '', required: false, archived: false, options: [],
      }],
    } }));
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/settings?section=work`);
    await expect(page.getByRole('heading', { name: '업무 템플릿', exact: true })).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: '새 템플릿', exact: true }).click();
    await page.getByLabel('템플릿 이름', { exact: true }).fill(name);
    await page.getByLabel('기본 제목', { exact: true }).fill(title);
    await page.getByRole('combobox', { name: '기본 유형', exact: true }).selectOption('버그');
    await page.getByRole('combobox', { name: '기본 우선순위', exact: true }).selectOption('high');
    await page.getByLabel('기본 라벨', { exact: true }).fill('배포, 검토');
    await page.getByLabel('설명 서식', { exact: true }).selectOption('markdown');
    await page.getByLabel('설명', { exact: true }).fill(description);
    await page.getByLabel(`기본 ${fieldName}`, { exact: true }).fill(fieldDefault);
    const saving = waitForCreate(page, path);
    await page.getByRole('button', { name: '템플릿 저장', exact: true }).click();
    const saved = await saving;
    expect(saved.status(), await saved.text()).toBe(201);
    const template = await saved.json() as IssueTemplate;
    expect(template.defaults).toMatchObject({
      title, description, descriptionFormat: 'markdown', type: '버그', priority: 'high', labels: ['배포', '검토'], customFields: { [fieldId]: fieldDefault },
    });
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    await page.goto(`/#/${project.id}/issues`);
    await page.getByRole('button', { name: '업무 만들기', exact: true }).first().click();
    const modal = page.getByRole('dialog', { name: '새 업무 만들기', exact: true });
    const picker = modal.getByRole('combobox', { name: '업무 템플릿', exact: true });
    await picker.selectOption({ label: name });
    await modal.getByRole('button', { name: '템플릿 적용', exact: true }).click();
    const titleField = modal.getByLabel('업무 제목', { exact: true });
    await expect(titleField).toHaveValue(title);
    const type = modal.getByRole('combobox', { name: '유형', exact: true });
    await expect(type).toHaveValue('버그');
    await expect(modal.getByLabel('설명', { exact: true })).toHaveValue(description);
    const customField = modal.getByLabel(fieldName, { exact: true });
    await expect(customField).toHaveValue(fieldDefault);
    const priority = modal.getByRole('combobox', { name: '우선순위', exact: true });
    await expect(priority).toHaveValue('high');
    await titleField.fill(finalTitle);
    await priority.selectOption('urgent');
    await type.selectOption('작업');
    await expect(customField).toHaveCount(0);

    const creating = waitForCreate(page, '/api/issues');
    await modal.getByRole('button', { name: '업무 만들기', exact: true }).click();
    const response = await creating;
    expect(response.status(), await response.text()).toBe(201);
    const submitted = response.request().postDataJSON();
    expect(submitted).toMatchObject({ templateId: template.id, expectedTemplateVersion: template.version });
    expect(submitted.customFields).not.toHaveProperty(fieldId);
    const issue = await response.json() as Issue;
    expect(issue).toMatchObject({
      projectId: project.id, title: finalTitle, description, descriptionFormat: 'markdown', type: '작업', priority: 'urgent',
      labels: ['배포', '검토'], reporterId: actor.id, assigneeId: null, startDate: null, endDate: null,
    });
    expect(issue.customFields).not.toHaveProperty(fieldId);
    await expect(modal).not.toBeVisible();
  } finally {
    try { await cleanup(request, project.id, prefix); }
    finally {
      const schema = await json<ProjectIssueSchema>(await request.get(schemaPath));
      if (schema.fields.some(field => field.id === fieldId)) {
        await json(await request.patch(schemaPath, { data: {
          ...schema, expectedVersion: schema.version, fields: schema.fields.filter(field => field.id !== fieldId),
        } }));
      }
    }
  }
});

test('기존 업무를 업무 템플릿으로 저장할 때 원본의 담당자와 일정은 저장하지 않는다', async ({ page, request }) => {
  const { projects: [project], users: [actor, assignee] } = await workspace(request);
  const prefix = `합성 원본 양식 ${randomUUID().slice(0, 8)}`;
  const name = `${prefix} 템플릿`;
  const path = settingsPath(project.id);

  try {
    const issue = await json<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} 원본`, description: '원본 설명', priority: 'low', assigneeId: assignee.id, startDate: '2026-11-23',
    } }), 201);
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/settings?section=work`);
    await page.getByRole('button', { name: '기존 업무에서 만들기', exact: true }).click();
    await page.getByLabel('템플릿 이름', { exact: true }).fill(name);
    await page.getByRole('combobox', { name: '원본 업무', exact: true }).selectOption(issue.id);
    const saving = waitForCreate(page, path);
    await page.getByRole('button', { name: '템플릿 저장', exact: true }).click();
    const response = await saving;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ name, sourceIssueId: issue.id, expectedIssueVersion: issue.version });
    const template = await response.json() as IssueTemplate;
    expect(template.defaults).toEqual({
      title: issue.title, description: issue.description, descriptionFormat: issue.descriptionFormat ?? 'plain',
      type: issue.type, priority: issue.priority, labels: issue.labels, customFields: issue.customFields ?? {},
    });
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  } finally {
    await cleanup(request, project.id, prefix);
  }
});
