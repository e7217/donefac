import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';

test('문서 라벨을 저장하고 공유 링크와 통합 검색으로 문서를 찾는다', async ({ browser, page, request, baseURL }) => {
  test.setTimeout(75_000);
  const suffix = randomUUID().slice(0, 8);
  const label = `설계 ${suffix.toUpperCase()}`;
  const labelKey = label.toLowerCase();
  const workspaceResponse = await request.get('/api/workspace');
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as WorkspaceSnapshot;
  expect(workspace.projects.length).toBeGreaterThanOrEqual(2);
  const [project, otherProject] = workspace.projects;
  const created: DocPage[] = [];
  const create = async (title: string, projectId: string | null, labels: string[] = []) => {
    const response = await request.post('/api/documents', { data: { title, projectId, labels } });
    expect(response.status()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document);
    return document;
  };

  try {
    const document = await create(`설정 문서 ${suffix}`, project.id);
    const unlabeled = await create(`운영 기록 ${suffix}`, project.id);
    const shared = await create(`공통 회의록 ${suffix}`, null, [labelKey]);
    const other = await create(`별도 프로젝트 문서 ${suffix}`, otherProject.id, [label]);
    const path = `/#/${project.id}/documents`;
    await page.setViewportSize({ width: 360, height: 844 });
    await page.goto(`${path}/${document.id}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(document.title, { timeout: 25_000 });
    await page.getByRole('textbox', { name: '문서 라벨', exact: true }).fill(label);
    await page.getByRole('button', { name: '라벨 추가', exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}`) && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    expect((await saved).status()).toBe(200);
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    const tree = page.getByRole('complementary', { name: '문서 목록' });
    const filter = tree.getByRole('combobox', { name: '문서 라벨 필터' });
    const row = (name: string) => tree.locator('.docs-tree-link').filter({ hasText: name });
    await expect(row(unlabeled.title)).toBeVisible();
    const changedTitle = `${document.title} 편집 중`;
    await title.fill(changedTitle);
    await filter.selectOption(labelKey);
    await expect(page).toHaveURL(/\?label=/);
    await expect(title).toHaveValue(changedTitle);
    await expect(row(document.title)).toBeVisible();
    await expect(row(shared.title)).toBeVisible();
    await expect(row(other.title)).toHaveCount(0);
    await expect(row(unlabeled.title)).toHaveCount(0);

    const find = tree.getByRole('textbox', { name: '문서 찾기' });
    await find.fill('공통 회의록');
    await expect(row(document.title)).toHaveCount(0);
    await expect(row(shared.title)).toBeVisible();
    await find.fill(labelKey);
    await expect(row(document.title)).toBeVisible();
    await expect(row(shared.title)).toBeVisible();
    await find.clear();

    await page.goBack();
    await expect(filter).toHaveValue('');
    await expect(title).toHaveValue(changedTitle);
    await expect(row(unlabeled.title)).toBeVisible();
    await page.goForward();
    await expect(filter).toHaveValue(labelKey);
    await expect(title).toHaveValue(changedTitle);

    const link = `${path}?${new URLSearchParams({ label })}`;
    const sharedContext = await browser.newContext({ baseURL });
    const sharedPage = await sharedContext.newPage();
    try {
      await sharedPage.goto(link);
      const sharedTree = sharedPage.getByRole('complementary', { name: '문서 목록' });
      await expect(sharedTree.getByRole('combobox', { name: '문서 라벨 필터' })).toHaveValue(labelKey);
      await sharedTree.locator('.docs-tree-link').filter({ hasText: shared.title }).click();
      await expect(sharedPage.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(shared.title);
      await expect(sharedPage).toHaveURL(/\?label=/);
      await sharedPage.getByRole('button', { name: '통합 검색', exact: true }).click();
      const search = sharedPage.getByRole('dialog', { name: '통합 검색' });
      await search.getByRole('textbox').fill(labelKey);
      await expect(search.getByRole('button', { name: other.title })).toBeVisible();
      await expect(search.getByRole('button', { name: document.title })).toBeVisible();
      await expect(search.getByRole('button', { name: unlabeled.title })).toHaveCount(0);
      await sharedPage.goto(`${path}?label=missing-${suffix}`);
      await expect(sharedPage.getByText('조건에 맞는 문서가 없습니다.', { exact: true })).toBeVisible();
      await expect(sharedPage.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveCount(0);
    } finally {
      await sharedContext.close();
    }

    await page.getByRole('button', { name: `라벨 삭제: ${label}`, exact: true }).click();
    const removed = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}`) && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const response = await removed;
    expect(response.status()).toBe(200);
    expect(((await response.json()) as DocPage).labels ?? []).toEqual([]);
    await expect(row(document.title)).toHaveCount(0);
    await expect(title).toHaveValue(changedTitle);
  } finally {
    for (const document of created) await request.delete(`/api/documents/${document.id}`);
  }
});
