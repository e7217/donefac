import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DocPage, DocumentPublicationView, WorkspaceSnapshot } from '../../shared/types';

test('검토 알림과 탭에서 역할별 목록을 열고 고정본 링크가 가리키는 버전을 확인한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const project = workspace.projects[0];
  const key = randomUUID().slice(0, 8);
  const created: DocPage[] = [];
  async function create(title: string, text: string, projectId: string | null) {
    const response = await request.post('/api/documents', {
      headers: { 'X-Actor-Id': author.id }, data: { projectId, title, content: {
        type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      } },
    });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document);
    return document;
  }
  const publicationPath = (document: DocPage) => `/api/documents/${document.id}/publication`;
  async function state(document: DocPage) {
    const response = await request.get(publicationPath(document));
    expect(response.ok(), await response.text()).toBeTruthy();
    return await response.json() as DocumentPublicationView;
  }
  async function transition(document: DocPage, current: DocumentPublicationView, actorId: string, action: 'request' | 'publish') {
    const response = await request.post(publicationPath(document), {
      headers: { 'X-Actor-Id': actorId }, data: {
        action, expectedVersion: current.version, workspaceGeneration: current.workspaceGeneration,
        ...(action === 'request' ? { reviewerId: reviewer.id, expectedDocumentVersion: current.documentVersion } : {}),
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as DocumentPublicationView;
  }
  async function publish(document: DocPage) {
    const submitted = await transition(document, await state(document), author.id, 'request');
    return transition(document, submitted, reviewer.id, 'publish');
  }

  try {
    const published = await create(`발행 검색 ${key}`, '팀에 발행한 초기 안내', project.id);
    const common = await create(`공통 발행 ${key}`, '팀 공통 발행 안내', null);
    const firstRelease = await publish(published);
    await publish(common);
    const draftTitle = `검토 전 새 편집 ${key}`;
    const changed = await request.patch(`/api/documents/${published.id}`, {
      data: { expectedVersion: published.version, title: draftTitle },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/overview`);
    const actor = page.getByLabel('작업자 선택', { exact: true });
    await expect(actor).toBeVisible();
    // The first workspace snapshot predates this document. The row still opens
    // through the normal route after it refreshes the workspace on demand.
    const assigned = await create(`맡은 검토 ${key}`, '검토 당시 안내 문구', project.id);
    const assignedState = await transition(assigned, await state(assigned), author.id, 'request');
    const inbox = page.getByRole('button', { name: '검토함·발행본', exact: true });
    await actor.selectOption(reviewer.id);
    await expect(inbox).toHaveAttribute('aria-description', '배정된 검토 1개');
    await inbox.click();
    const library = page.getByRole('region', { name: '문서 검토·발행 목록' });
    const assignedTab = library.getByRole('tab', { name: '내 검토', exact: true });
    await expect(assignedTab).toHaveAttribute('aria-selected', 'true');
    const bounds = await library.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const assignedRow = library.getByRole('button', { name: `${assigned.title} 검토본 열기`, exact: true });
    await assignedRow.click();
    await expect(page).toHaveURL(new RegExp(`/documents/${assigned.id}\\?publication=review&revision=${assignedState.reviewRevision!.id}$`));
    const dialog = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    const review = dialog.getByRole('region', { name: '검토 고정본 내용' });
    await expect(review).toContainText('검토 당시 안내 문구');
    await dialog.getByLabel('검토 결과 메모', { exact: true }).fill('검토 절차 설명을 보완해 주세요.');
    await dialog.getByRole('button', { name: '수정 요청 보내기', exact: true }).click();
    await expect(dialog.getByText('검토 절차 설명을 보완해 주세요.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/documents/${assigned.id}$`));
    await expect(inbox).toHaveAttribute('aria-description', '배정된 검토 0개');
    await page.goBack();
    await expect(assignedTab).toHaveAttribute('aria-selected', 'true');
    await expect(assignedRow).toHaveCount(0);
    await actor.selectOption(author.id);
    const requestedTab = library.getByRole('tab', { name: '내 요청', exact: true });
    await requestedTab.click();
    await expect(page).toHaveURL(/\/publication\/requested$/);
    await expect(library.getByText('수정 요청', { exact: true })).toBeVisible();
    await expect(assignedRow).toBeVisible();

    const publishedTab = library.getByRole('tab', { name: '발행본', exact: true });
    await publishedTab.click();
    const scope = library.getByLabel('검토·발행 조회 범위', { exact: true });
    await expect(scope).toHaveValue('project');
    const publishedRow = library.getByRole('button', { name: `${published.title} 발행본 열기`, exact: true });
    const commonRow = library.getByRole('button', { name: `${common.title} 발행본 열기`, exact: true });
    await expect(publishedRow).toBeVisible();
    await expect(commonRow).toHaveCount(0);
    await scope.selectOption('common');
    await expect(commonRow).toBeVisible();
    await expect(publishedRow).toHaveCount(0);
    await scope.selectOption('project');
    const search = library.getByLabel('검토·발행 문서 검색', { exact: true });
    await search.fill(published.title);
    await library.getByRole('button', { name: '검토·발행 검색 실행', exact: true }).click();
    await expect(publishedRow).toBeVisible();
    await publishedRow.click();
    await expect(page).toHaveURL(new RegExp(`\\?publication=published&revision=${firstRelease.publishedRevision!.id}$`));
    const savedLink = page.url();
    const frozenPublication = dialog.getByRole('region', { name: '발행 고정본 내용' });
    await expect(frozenPublication).toContainText(published.title);
    await expect(frozenPublication).toContainText('팀에 발행한 초기 안내');
    await expect(frozenPublication).not.toContainText(draftTitle);
    await page.reload();
    await expect(frozenPublication).toContainText(published.title);

    const secondRelease = await publish(published);
    await page.goto(savedLink);
    await page.reload();
    await expect(dialog.getByRole('alert').filter({ hasText: '링크가 가리킨 저장본이 현재 상태에서 변경되었습니다' })).toBeVisible();
    await expect(frozenPublication).toHaveCount(0);
    await dialog.getByRole('button', { name: '발행본 불러오기', exact: true }).click();
    await expect(frozenPublication).toContainText(secondRelease.publishedRevision!.title);
  } finally {
    for (const document of created.reverse()) await request.delete(`/api/documents/${document.id}`);
  }
});
