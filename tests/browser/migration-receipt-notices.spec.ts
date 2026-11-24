import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, SourceRecordArchive, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

function wikiPage(id: number, title: string, body: string): string {
  return `<object class="Page"><id name="id">${id}</id><property name="title">${title}</property>
    <property name="version">1</property><property name="creationDate">2020-01-02T03:04:05Z</property>
    <property name="lastModificationDate">2020-02-03T04:05:06Z</property>
    <property name="space" class="Space"><id name="id">42</id></property></object>
  <object class="BodyContent"><id name="id">${id + 1000}</id><property name="body"><![CDATA[${body}]]></property>
    <property name="content" class="Page"><id name="id">${id}</id></property></object>`;
}

function wikiExport(key: string, pages: string[]): Buffer {
  return zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${key}</property>
      <property name="name">원본 문서 공간 ${key}</property></object>
    ${pages.join('\n')}
  </hibernate-generic>`) }]);
}

test('360px 이관 영수증의 경고에서 같은 원본 ID를 가진 패키지의 보존 원본을 구분한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
  const warningCode = 'UNSUPPORTED_MACRO';
  const entries = ['A', 'B'].map(letter => ({
    filename: `receipt-${letter}-${token}.zip`,
    instanceKey: `receipt-wiki-${letter.toLowerCase()}-${token}`,
    spaceKey: `RW${letter}${token}`,
    title: `${letter} 패키지 원본 문서 ${token}`,
    body: `<p>${letter} 패키지의 보존된 본문 ${token}</p><ac:structured-macro ac:name="vendor-${letter.toLowerCase()}"/>`,
  }));
  const workspace = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const staging = new Map<string, LegacyPackageSummary>();
  const sources: { input: typeof entries[number]; pkg: LegacyPackageSummary }[] = [];
  const removeStaging = (pkg: LegacyPackageSummary) => request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);

  try {
    for (const [index, input] of entries.entries()) {
      const extraPages = index === 0 ? Array.from({ length: 51 }, (_, offset) =>
        wikiPage(200 + offset, `추가 경고 문서 ${offset}`, '<ac:structured-macro ac:name="vendor-extra"/>'),
      ) : [];
      const content = wikiExport(input.spaceKey, [...extraPages, wikiPage(100, input.title, input.body)]);
      const params = new URLSearchParams({ filename: input.filename, instanceKey: input.instanceKey });
      const pkg = await readJson<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${params}`, {
        headers: { 'Content-Type': 'application/octet-stream' }, data: content,
      }), 201);
      staging.set(pkg.id, pkg);
      sources.push({ input, pkg });
    }
    const params = new URLSearchParams(sources.map(({ pkg }) => ['packageId', pkg.id]));
    const { defaultConfiguration: configuration } = await readJson<MigrationOptions>(await request.get(`/api/migrations/options?${params}`));
    const proposed = await readJson<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(proposed.canApply, JSON.stringify(proposed.notices.filter(notice => notice.severity === 'error'))).toBe(true);
    const { import: receipt } = await readJson<MigrationApplyResult>(await request.post(`/api/migrations/previews/${proposed.id}/apply`, {
      data: { expectedVersion: proposed.version, acknowledgements: proposed.requiredAcknowledgements },
    }), 201);

    for (const { pkg } of sources) {
      const deleted = await removeStaging(pkg);
      expect(deleted.ok(), await deleted.text()).toBe(true);
      staging.delete(pkg.id);
      expect((await request.get(`/api/legacy-import/packages/${pkg.id}`)).status()).toBe(404);
    }

    const notices = receipt.notices ?? [];
    const visibleNotices = notices.filter(notice => notice.severity === 'warning' && notice.code === warningCode);
    expect(visibleNotices).toHaveLength(53);
    const targets = sources.map(({ input, pkg }) => {
      const reference = `${pkg.id}/page:100`;
      const scopedIndex = visibleNotices.findIndex(notice => notice.recordId === reference);
      expect(scopedIndex, reference).toBeGreaterThanOrEqual(0);
      const fullIndex = notices.indexOf(visibleNotices[scopedIndex]);
      expect(fullIndex).toBeGreaterThan(scopedIndex);
      return { input, pkg, reference, fullIndex, secondPage: scopedIndex >= 50 };
    });
    expect(targets.some(target => target.secondPage)).toBe(true);

    const writes: string[] = [];
    const originalReads: string[] = [];
    const originalPrefix = `/api/source-imports/${receipt.id}/notices/`;
    page.on('request', value => {
      const url = new URL(value.url());
      const method = value.method();
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) writes.push(`${method} ${url.pathname}`);
      if (url.pathname.startsWith(originalPrefix)) originalReads.push(`${url.pathname}${url.search}`);
    });
    await page.goto(`/#/${workspace.projects[0].id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const receipts = settings.getByRole('region', { name: '완료한 이관 영수증', exact: true });
    await receipts.getByRole('button').filter({ hasText: receipt.id }).click();
    const detail = settings.getByLabel('이관 영수증 상세', { exact: true });
    const summary = detail.getByRole('region', { name: '이관 후속 확인', exact: true });
    await summary.getByRole('button', { name: '적용 당시 경고 보기', exact: true }).click();
    const scopeHeading = detail.getByRole('heading', { name: '적용 당시 경고', exact: true });
    await expect(scopeHeading).toBeFocused();
    const search = detail.getByRole('textbox', { name: '영수증 이관 진단 검색', exact: true });
    await search.fill(warningCode);
    const next = detail.getByRole('button', { name: '영수증 이관 진단 다음 페이지', exact: true });
    const previous = detail.getByRole('button', { name: '영수증 이관 진단 이전 페이지', exact: true });

    let onSecondPage = false;
    for (const target of targets) {
      if (target.secondPage !== onSecondPage) {
        await (target.secondPage ? next : previous).click();
        onSecondPage = target.secondPage;
      }
      const pageLabel = detail.getByText(target.secondPage ? '51–53 / 53' : '1–50 / 53', { exact: true });
      await expect(pageLabel).toBeVisible();
      const notice = detail.locator('.migration-notice.is-warning').filter({
        has: page.getByText(`원본 항목 ${target.reference}`, { exact: true }),
      });
      const opener = notice.getByRole('button', { name: '보존 원본 보기', exact: true });
      const dialog = page.getByRole('dialog', { name: '이관 진단의 보존 원본', exact: true });
      if (target === targets[0]) {
        await page.route(url => url.pathname === `${originalPrefix}${target.fullIndex}/source`, route =>
          route.fulfill({ status: 503, json: { error: '합성 원본 조회 오류' } }), { times: 1 });
        await opener.click();
        await expect(dialog.getByRole('alert')).toHaveText('합성 원본 조회 오류');
      }
      const read = page.waitForResponse(response => new URL(response.url()).pathname.startsWith(originalPrefix));
      if (target === targets[0]) await dialog.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      else await opener.click();
      const response = await read;
      expect(response.request().method()).toBe('GET');
      expect(response.ok(), await response.text()).toBe(true);
      const url = new URL(response.url());
      expect(url.pathname).toBe(`${originalPrefix}${target.fullIndex}/source`);
      expect(url.searchParams.get('expectedVersion')).toBe(String(receipt.version));
      const archive = await response.json() as SourceRecordArchive;
      expect(archive).toMatchObject({ sourceImportId: receipt.id, packageSha256: target.pkg.sha256, source: { instanceKey: target.input.instanceKey },
        record: { kind: 'page', sourceId: '100', title: target.input.title, text: target.input.body } });

      const archiveDetail = dialog.getByRole('region', { name: '보존한 원본 기록 상세', exact: true });
      await expect(archiveDetail.getByRole('heading', { name: target.input.title, exact: true })).toBeVisible();
      await expect(archiveDetail.getByText(target.input.instanceKey, { exact: false })).toBeVisible();
      await expect(archiveDetail.getByText(target.pkg.sha256, { exact: true })).toBeVisible();
      await expect(archiveDetail.getByLabel('보존한 원본 본문', { exact: true })).toHaveText(target.input.body);
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(scopeHeading).toBeVisible();
      await expect(search).toHaveValue(warningCode);
      await expect(pageLabel).toBeVisible();
    }
    expect(originalReads).toEqual([targets[0], ...targets].map(target => `${originalPrefix}${target.fullIndex}/source?expectedVersion=${receipt.version}`));
    expect(writes).toEqual([]);
  } finally {
    for (const pkg of staging.values()) await removeStaging(pkg);
  }
});
