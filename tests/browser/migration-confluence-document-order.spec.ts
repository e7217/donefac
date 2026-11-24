import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DocPage, LegacyPackageSummary, MigrationApplyResult, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

function sourcePage(id: string, title: string, parentId: string | null, position?: number, macro = '') {
  const parent = parentId === null ? '<property name="parent"/>' : `<property name="parent" class="Page"><id name="id">${parentId}</id></property>`;
  return `<object class="Page"><id name="id">${id}</id><property name="title">${title}</property><property name="version">1</property>
    ${parent}${position === undefined ? '' : `<property name="position">${position}</property>`}
    <property name="creationDate">2020-01-02T03:04:05Z</property><property name="lastModificationDate">2020-01-03T03:04:05Z</property>
    <property name="space" class="Space"><id name="id">42</id></property></object>
    <object class="BodyContent"><id name="id">8${id}</id><property name="bodyType">2</property>
    <property name="body"><![CDATA[<p>${title} 본문</p>${macro}]]></property>
    <property name="content" class="Page"><id name="id">${id}</id></property></object>`;
}

test('360px 이관 미리보기에서 문서 그룹의 순서를 확인하고 그대로 탐색한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const key = `PO${suffix}`;
  const filename = `document-order-${suffix}.zip`;
  const source = '<hibernate-generic>' +
    `<object class="Space"><id name="id">42</id><property name="key">${key}</property><property name="name">이관 ${key}</property></object>` +
    sourcePage('100', 'A 원본 뒤 그룹', null, 11) + sourcePage('200', 'Z 원본 앞 그룹', null, 2, '<ac:structured-macro ac:name="children"/>') +
    sourcePage('210', 'B 원본 두 번째', '200', 10) + sourcePage('220', 'Y 원본 첫 번째', '200', 2) +
    sourcePage('110', '혼합 위치 첫 문서', '100') + sourcePage('120', '혼합 위치 둘째 문서', '100', 1) + '</hibernate-generic>';
  const query = new URLSearchParams({ filename, product: 'confluence', instanceKey: `document-order-${suffix}` });
  const uploaded = await request.post(`/api/legacy-import/packages?${query}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: zip([{ path: 'entities.xml', bytes: Buffer.from(source) }]),
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const staged = await uploaded.json() as LegacyPackageSummary;
  const imported: DocPage[] = [];
  try {
    const initial = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    await page.goto(`/#/${initial.projects[0].id}/settings`);
    const migration = page.getByRole('region', { name: '실제 데이터 이관' });
    await migration.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check();
    await migration.getByRole('button', { name: '선택 패키지 매핑 불러오기' }).click();
    const previewing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/migrations/preview' && response.request().method() === 'POST');
    await migration.getByRole('button', { name: '적용 전 미리보기 만들기' }).click();
    const reviewed = await previewing;
    expect(reviewed.status(), await reviewed.text()).toBe(201);
    const preview = await reviewed.json() as MigrationPreview;
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    const review = migration.getByRole('region', { name: '이관 적용 미리보기' });
    await expect(review.getByText('원본 순서를 적용할 문서 그룹 2', { exact: true })).toBeVisible();
    await expect(review.getByText('기본 순서를 사용할 문서 그룹 1', { exact: true })).toBeVisible();
    for (const code of preview.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = page.waitForResponse(response => new URL(response.url()).pathname === `/api/migrations/previews/${preview.id}/apply`);
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용' }).click();
    const applied = await applying;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = (await applied.json() as MigrationApplyResult).import;
    const [projectId] = receipt.projectIds;
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    imported.push(...snapshot.documents.filter(document => document.projectId === projectId));
    expect(imported).toHaveLength(6);

    const receiptDetail = migration.locator('[aria-label="이관 영수증 상세"]');
    await expect(receiptDetail.getByText('원본 순서를 적용할 문서 그룹 2', { exact: true })).toBeVisible();
    const home = imported.find(document => document.title === 'Z 원본 앞 그룹')!;
    await page.goto(`/#/${projectId}/documents/${home.id}`);
    const tree = page.getByRole('complementary', { name: '문서 목록', exact: true });
    const treeTitles = tree.locator('.docs-tree-link > span:nth-child(2)');
    await expect(treeTitles).toHaveText(['Z 원본 앞 그룹', 'Y 원본 첫 번째', 'B 원본 두 번째', 'A 원본 뒤 그룹', '혼합 위치 첫 문서', '혼합 위치 둘째 문서']);
    const directory = page.getByRole('region', { name: '하위 문서 목록', exact: true });
    await expect(directory.getByRole('link')).toHaveText(['Y 원본 첫 번째', 'B 원본 두 번째']);
    await tree.getByText('Y 원본 첫 번째', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue('Y 원본 첫 번째');
    await page.reload();
    await expect(treeTitles).toHaveText(['Z 원본 앞 그룹', 'Y 원본 첫 번째', 'B 원본 두 번째', 'A 원본 뒤 그룹', '혼합 위치 첫 문서', '혼합 위치 둘째 문서']);
  } finally {
    for (const document of imported.reverse()) {
      const removed = await request.delete(`/api/documents/${document.id}?expectedVersion=${document.version}`);
      expect(removed.ok(), await removed.text()).toBe(true);
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      expect((await request.delete(`/api/trash/${trashEntryId}`)).ok()).toBe(true);
    }
    const deleted = await request.delete(`/api/legacy-import/packages/${staged.id}?expectedVersion=${staged.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});
