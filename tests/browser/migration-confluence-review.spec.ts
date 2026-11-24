import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { LegacyPackageSummary, MigrationConfluenceReview, MigrationOptions, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

test('360px 이관 화면에서 ZIP 전체 검토 범위와 개별 검토 파일을 구분한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const filename = `confluence-review-${suffix}.zip`;
  const space = `<object class="Space"><id name="id">42</id><property name="key">REV${suffix}</property><property name="name">검토 ${suffix}</property></object>`;
  const pages = [100, 200, 300, 400].map(id => `<object class="Page"><id name="id">${id}</id>
    <property name="title">검토 문서 ${id}</property><property name="version">1</property>
    <property name="creationDate">2020-01-02T03:04:05Z</property><property name="lastModificationDate">2020-01-03T03:04:05Z</property>
    <property name="space" class="Space"><id name="id">42</id></property></object>
    <object class="BodyContent"><id name="id">8${id}</id><property name="bodyType">2</property>
    <property name="body"><![CDATA[<p>검토 문서 ${id} 본문</p>]]></property>
    <property name="content" class="Page"><id name="id">${id}</id></property></object>`).join('');
  const xml = `<hibernate-generic>${space}${pages}</hibernate-generic>`;
  const workspace = await request.get('/api/workspace');
  expect(workspace.ok(), await workspace.text()).toBe(true);
  const { projects } = await workspace.json() as WorkspaceSnapshot;
  const upload = await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey: `review-${suffix}` })}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const source = await upload.json() as LegacyPackageSummary;

  try {
    const baseReview: MigrationConfluenceReview = {
      packageId: source.id, checkedAt: '2026-11-24T06:00:00.000Z', selection: 'explicit-pages', status: 'matched',
      spacePermissions: 'manual-review', findingsPages: 0, unidentifiedPages: 0,
    };
    await page.route(url => url.pathname === '/api/migrations/options', async route => {
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      const options = await response.json() as MigrationOptions;
      const otherPackageId = randomUUID();
      options.confluenceReviews = [baseReview, { ...baseReview, coverage: {
        archivePages: 4, matchedPages: 1, permissionCheckedPages: 1, outsideSelectionPages: 3, otherSpacePages: 0, unassignedPages: 0,
      } }, { ...baseReview, coverage: {
        archivePages: 4, matchedPages: 3, permissionCheckedPages: 3, outsideSelectionPages: 1, otherSpacePages: 0, unassignedPages: 0,
      } }, { ...baseReview, packageId: otherPackageId, status: 'needs-review', findingsPages: 1234 }];
      options.confluenceReviewCoverage = [{ packageId: source.id, archivePages: 4, permissionCheckedPages: 3 },
        { packageId: otherPackageId, archivePages: 1234, permissionCheckedPages: 1234 }];
      await route.fulfill({ response, json: options });
    });
    await page.goto(`/#/${projects[0].id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const checkbox = settings.getByLabel(`이관 패키지 ${filename}`, { exact: true });
    await checkbox.check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    const coverage = settings.getByRole('region', { name: 'Confluence 원본 검토 범위', exact: true });
    const combined = coverage.getByRole('region', { name: `ZIP 전체 페이지 제한 확인 ${filename}`, exact: true });
    const legacy = coverage.getByRole('article').filter({ hasText: '이전 검토 파일에는 페이지 확인 범위가 기록되지 않았습니다.' });
    const current = coverage.getByRole('article').filter({ hasText: 'ZIP에 포함된 현재 페이지' }).first();
    await expect(coverage.getByRole('article')).toHaveCount(3);
    await expect(coverage.getByRole('region', { name: /^ZIP 전체 페이지 제한 확인/ })).toHaveCount(1);
    for (const [label, count] of [
      ['현재 페이지 수', 4], ['제한 여부를 확인한 페이지', 3], ['제한 여부를 확인할 페이지', 1],
    ] as const) {
      await expect(combined.getByText(label, { exact: true }).locator('..')).toContainText(`${count}개`);
    }
    await expect(legacy).toBeVisible();
    await expect(current).toContainText('검토한 범위에서 대조 일치');
    await expect(current).toContainText('검토 진단이 있는 페이지 0개');
    for (const [label, count] of [
      ['ZIP에 포함된 현재 페이지', 4], ['페이지 제한 여부 확인', 1], ['페이지 제한 여부 미확인', 3], ['지정 범위 밖 페이지', 3],
    ] as const) {
      await expect(current.getByText(label, { exact: true }).locator('..')).toContainText(`${count}개`);
    }
    await expect(coverage.getByText('공간 권한은 원본에서 별도로 확인하세요.', { exact: true })).toBeVisible();

    await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
    const preview = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const previewCoverage = preview.getByRole('region', { name: 'Confluence 원본 검토 범위', exact: true });
    await expect(previewCoverage.getByRole('article')).toHaveCount(3);
    await expect(previewCoverage.getByRole('region', { name: `ZIP 전체 페이지 제한 확인 ${filename}`, exact: true })).toBeVisible();
    await expect(coverage).toHaveCount(1);
    const bounds = await previewCoverage.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await checkbox.uncheck();
    await expect(coverage).toHaveCount(0);
  } finally {
    const deleted = await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});
