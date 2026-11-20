import { randomUUID } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';
import type { AtlassianLink, AtlassianLinkPreview } from '../../shared/atlassian-links';
import type { DocPage, Issue, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 } });

async function expectOriginal(panel: Locator, url: string) {
  const anchor = panel.getByRole('link', { name: '원본 열기', exact: true });
  await expect(anchor).toHaveAttribute('href', url);
  await expect(anchor).toHaveAttribute('target', '_blank');
  await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  const size = await panel.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width);
}

test('360px 업무와 문서에서 원본 링크를 다시 열고 초안을 유지하면서 조회하거나 해제한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const project = workspace.projects[0];
  const headers = { 'X-Actor-Id': workspace.users[0].id };
  const prefix = `원본 링크 검사 ${randomUUID().slice(0, 8)}`;
  const jiraUrl = `https://jira.example.invalid/${'long-context-'.repeat(12)}/browse/WORK-123`;
  const confluenceUrl = 'https://wiki.example.invalid/pages/viewpage.action?pageId=12345';
  const previewRoute = '**/api/atlassian-links/*/preview';
  const previewCalls: string[] = [];
  let preview: AtlassianLinkPreview | undefined;
  let issue: Issue | undefined;
  let document: DocPage | undefined;

  const endpoint = (targetType: 'issue' | 'document', targetId: string) =>
    `/api/atlassian-links?${new URLSearchParams({ targetType, targetId })}`;

  try {
    const createdIssue = await request.post('/api/issues', {
      headers, data: { projectId: project.id, title: `${prefix} 업무`, description: '원래 설명' },
    });
    expect(createdIssue.status(), await createdIssue.text()).toBe(201);
    issue = await createdIssue.json() as Issue;
    const createdDocument = await request.post('/api/documents', {
      headers, data: { projectId: project.id, title: `${prefix} 문서` },
    });
    expect(createdDocument.status(), await createdDocument.text()).toBe(201);
    document = await createdDocument.json() as DocPage;

    await page.route(previewRoute, async route => {
      previewCalls.push(route.request().method());
      if (preview) return route.fulfill({ json: preview });
      return route.fulfill({ status: 503, json: { error: '원본 조회 설정이 필요합니다.' } });
    });

    const panel = page.getByRole('region', { name: '기존 도구 연결', exact: true });
    const product = panel.getByLabel('기존 도구', { exact: true });
    const url = panel.getByLabel('원본 URL', { exact: true });
    const add = panel.getByRole('button', { name: '원본 링크 추가', exact: true });
    const read = panel.getByRole('button', { name: '원본 정보 조회', exact: true });

    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const issueDetails = page.getByRole('dialog', { name: issue.title, exact: true });
    const description = issueDetails.getByLabel('설명', { exact: true });
    const unsavedDescription = '저장하지 않은 업무 설명';
    await description.fill(unsavedDescription);
    await expect(product).toHaveValue('jira');
    await url.fill(`${jiraUrl}?focusedCommentId=42#comment`);
    await add.click();
    await expectOriginal(panel, jiraUrl);
    await expect(description).toHaveValue(unsavedDescription);
    expect(previewCalls).toEqual([]);

    preview = { title: 'Jira 원본 업무', status: '진행 중', locator: 'WORK-123', updatedAt: '2026-11-20T01:00:00.000Z' };
    await read.click();
    await expect(panel.getByText('Jira 원본 업무', { exact: true })).toBeVisible();
    await expect(panel.getByText('WORK-123', { exact: true })).toBeVisible();
    await expect(panel.getByText('진행 중', { exact: true })).toBeVisible();
    await expect(panel.locator('time')).toHaveAttribute('datetime', preview.updatedAt!);
    await expect(description).toHaveValue(unsavedDescription);
    expect(previewCalls).toEqual(['GET']);

    await description.fill(issue.description);
    await expect(issueDetails.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
    await page.reload();
    await expectOriginal(panel, jiraUrl);
    await expect(panel.getByText('Jira 원본 업무', { exact: true })).toHaveCount(0);
    await issueDetails.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await page.goto(`/#/${project.id}/documents/${document.id}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const unsavedTitle = `${document.title} 미저장`;
    const openDocumentLinks = async () => {
      await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
      await page.getByRole('button', { name: '연결', exact: true }).click();
    };
    await title.fill(unsavedTitle);
    await openDocumentLinks();
    await expect(product).toHaveValue('confluence');
    await url.fill(`${confluenceUrl}&focusedCommentId=42#comment`);
    await add.click();
    await expectOriginal(panel, confluenceUrl);
    await expect(title).toHaveValue(unsavedTitle);
    expect(previewCalls).toEqual(['GET']);

    preview = undefined;
    await read.click();
    await expect(panel.getByRole('alert')).toHaveText('원본 조회 설정이 필요합니다.');
    await expectOriginal(panel, confluenceUrl);
    preview = { title: 'Confluence 원본 문서', status: null, locator: '12345', updatedAt: null };
    await read.click();
    await expect(panel.getByText('Confluence 원본 문서', { exact: true })).toBeVisible();
    await expect(panel.getByText('12345', { exact: true })).toBeVisible();
    await expect(title).toHaveValue(unsavedTitle);
    expect(previewCalls).toEqual(['GET', 'GET', 'GET']);

    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(title).toHaveValue(unsavedTitle);
    await openDocumentLinks();
    await expectOriginal(panel, confluenceUrl);
    await expect(panel.getByText('Confluence 원본 문서', { exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect(panel.getByRole('link', { name: '원본 열기', exact: true })).toHaveCount(0);
    await expect(title).toHaveValue(unsavedTitle);
    expect(previewCalls).toEqual(['GET', 'GET', 'GET']);

    const remainingIssueLinks = await request.get(endpoint('issue', issue.id), { headers });
    const remainingDocLinks = await request.get(endpoint('document', document.id), { headers });
    expect(await remainingIssueLinks.json()).toEqual([expect.objectContaining({ product: 'jira', url: jiraUrl })]);
    expect(await remainingDocLinks.json()).toEqual([]);
    const updated = await (await request.get('/api/workspace', { headers })).json() as WorkspaceSnapshot;
    expect(updated.issues.find(item => item.id === issue?.id)).toMatchObject({ description: issue.description, version: issue.version });
    expect(updated.documents.find(item => item.id === document?.id)).toMatchObject({ title: document.title, version: document.version });
  } finally {
    if (issue) {
      const response = await request.get(endpoint('issue', issue.id), { headers });
      if (response.ok()) {
        for (const link of await response.json() as AtlassianLink[]) {
          await request.delete(`/api/atlassian-links/${link.id}`, { headers });
        }
      }
      await request.delete(`/api/issues/${issue.id}`, { headers });
    }
    if (document) await request.delete(`/api/documents/${document.id}`, { headers });
  }
});
