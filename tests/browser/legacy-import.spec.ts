import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { LegacyPackageSummary, LegacyRecord, LegacyRecordPage, WorkspaceSnapshot } from '../../shared/types';

interface LegacyFixture { request: APIRequestContext; workspace: WorkspaceSnapshot; instanceKey: string; filename: string }
const test = base.extend<{ legacy: LegacyFixture }>({
  legacy: [async ({ playwright, baseURL }, provide) => {
    const request = await playwright.request.newContext({ baseURL }), suffix = randomUUID(), instanceKey = `legacy-browser-${suffix}`;
    try { const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot; await provide({ request, workspace, instanceKey, filename: `legacy-${suffix}.csv` }); }
    finally {
      try {
        const response = await request.get('/api/legacy-import/packages', { timeout: 5000 });
        if (response.ok()) for (const value of await response.json() as LegacyPackageSummary[]) {
          if (value.source.instanceKey.startsWith(instanceKey)) expect((await request.delete(`/api/legacy-import/packages/${value.id}?expectedVersion=${value.version}`, { timeout: 5000 })).status()).toBe(200);
        }
      } finally { await request.dispose(); }
    }
  }, { timeout: 30_000 }],
});
const csv = (rows: string[][]) => Buffer.from(rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n'));
const canonical = (snapshot: WorkspaceSnapshot) => ({ issues: snapshot.issues, documents: snapshot.documents });
async function openSettings(page: Page, f: LegacyFixture) {
  await page.goto(`/#/${f.workspace.projects[0].id}/settings?section=migration`);
  return page.getByRole('region', { name: '기존 도구 원본 분석', exact: true });
}

test('Jira CSV를 분석해 원본 객체·페이지·진단·SHA를 확인하고 중복 분석과 삭제는 현재 업무를 바꾸지 않는다', async ({ page, legacy: f }) => {
  test.setTimeout(60_000);
  const raw = '<img src="x" onerror="window.__legacyUnsafe=true"/>\r\n  원본 공백과 본문  ';
  const content = csv([['Issue key', 'Issue id', 'Summary', 'Description', 'Status'], ...Array.from({ length: 51 }, (_, index) => [`OLD-${index + 1}`, String(1000 + index), `합성 가져오기 ${index + 1}`, index === 0 ? raw : `본문 ${index + 1}`, '진행'])]);
  const settings = await openSettings(page, f);
  await expect(settings).toContainText('원본을 분석하고 누락 항목을 확인하세요.');
  await settings.getByLabel('원본 인스턴스 식별값', { exact: true }).fill(f.instanceKey);
  await settings.getByLabel('Jira·Confluence 원본 파일', { exact: true }).setInputFiles({ name: f.filename, mimeType: 'text/csv', buffer: content });
  const creation = page.waitForResponse(response => response.url().includes('/api/legacy-import/packages?') && response.request().method() === 'POST');
  await settings.getByRole('button', { name: '원본 분석 시작', exact: true }).click();
  const response = await creation; expect(response.status()).toBe(201); const summary = await response.json() as LegacyPackageSummary;
  expect(summary).toMatchObject({ source: { product: 'jira', format: 'jira-csv', instanceKey: f.instanceKey }, counts: { issue: 51 }, applySupported: false });
  await expect(settings.getByLabel('원본 분석 요약', { exact: true })).toBeVisible();
  await settings.locator('.legacy-package-item').filter({ hasText: f.filename }).click();
  await expect(settings.getByLabel('원본 분석 요약', { exact: true })).toBeVisible();
  await settings.getByLabel('원본 객체 종류', { exact: true }).selectOption('issue');
  const records = settings.getByLabel('원본 객체 목록', { exact: true }); await expect(records.getByRole('button')).toHaveCount(50);
  await settings.getByRole('button', { name: '원본 객체 다음 페이지', exact: true }).click();
  await expect(records.getByRole('button')).toHaveCount(1); await expect(records).toContainText('합성 가져오기 51');
  await settings.getByRole('button', { name: '원본 객체 이전 페이지', exact: true }).click();
  await expect(records.getByRole('button')).toHaveCount(50);
  await settings.getByLabel('원본 객체 검색', { exact: true }).fill('합성 가져오기 1');
  await settings.getByRole('button', { name: '검색', exact: true }).click();
  await records.getByRole('button').filter({ hasText: '1000' }).click();
  const detail = settings.getByRole('region', { name: '원본 객체 상세', exact: true });
  await expect(detail.getByLabel('원본 본문', { exact: true })).toHaveText(raw, { useInnerText: false });
  await expect(detail.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as Window & { __legacyUnsafe?: boolean }).__legacyUnsafe))).toBe(false);
  const summaries = await (await f.request.get(`/api/legacy-import/packages/${summary.id}/records?kind=issue&limit=1`)).json() as LegacyRecordPage;
  expect(Object.hasOwn(summaries.records[0], 'text')).toBe(false); expect(Object.hasOwn(summaries.records[0], 'metadata')).toBe(false); expect(summaries.records[0].textBytes).toBe(Buffer.byteLength(raw));
  await settings.getByRole('tab', { name: '분석 진단', exact: true }).click();
  await settings.getByLabel('분석 진단 심각도', { exact: true }).selectOption('warning');
  await expect(settings.getByRole('tabpanel')).toContainText('CSV_HISTORY_NOT_PROVIDED');
  await settings.getByRole('tab', { name: '파일 목록', exact: true }).click();
  const files = settings.getByRole('tabpanel'); await expect(files).toContainText(f.filename); await expect(files).toContainText(createHash('sha256').update(content).digest('hex'));
  await settings.screenshot({ path: 'docs/screenshots/legacy-import.png' });
  await settings.getByLabel('Jira·Confluence 원본 파일', { exact: true }).setInputFiles({ name: f.filename, mimeType: 'text/csv', buffer: content });
  const duplicate = page.waitForResponse(value => value.url().includes('/api/legacy-import/packages?') && value.request().method() === 'POST');
  await settings.getByRole('button', { name: '원본 분석 시작', exact: true }).click();
  const repeated = await duplicate; expect(repeated.status()).toBe(200); expect((await repeated.json() as LegacyPackageSummary).id).toBe(summary.id);
  await expect(settings.locator('.legacy-package-item').filter({ hasText: f.filename })).toHaveCount(1);
  expect(canonical(await (await f.request.get('/api/workspace')).json() as WorkspaceSnapshot)).toEqual(canonical(f.workspace));
  const removal = page.waitForResponse(value => value.url().includes(`/api/legacy-import/packages/${summary.id}?expectedVersion=${summary.version}`) && value.request().method() === 'DELETE');
  page.once('dialog', value => value.accept());
  await settings.getByRole('button', { name: '선택한 원본 분석 삭제', exact: true }).click(); expect((await removal).status()).toBe(200);
  await expect(settings.locator('.legacy-package-item').filter({ hasText: f.filename })).toHaveCount(0);
});

test('Confluence CDATA를 실행하지 않고 20,000자만 표시하며 전체 JSON 다운로드는 원문·관계를 그대로 보존한다', async ({ page, legacy: f }) => {
  const body = '  <p>원문\r\n<script>window.__legacyUnsafe=true</script></p>\r\n' + '긴 본문😀'.repeat(5000) + '\r\n끝 공백  ';
  const sourceId = 'page:/42', text = `<?xml version="1.0" encoding="UTF-8"?><hibernate-generic><object class="Space"><id name="id">space-1</id><property name="name">합성 공간</property><property name="key">SYN</property></object><object class="Page"><id name="id">${sourceId}</id><property name="title">합성 Confluence 원문</property><property name="space" class="Space"><id name="id">space-1</id></property><property name="version">1</property></object><object class="BodyContent"><id name="id">body-1</id><property name="body"><![CDATA[${body}]]></property><property name="content" class="Page"><id name="id">${sourceId}</id></property><property name="bodyType">2</property></object><object class="UnknownSyntheticPlugin"><id name="id">unsupported-1</id></object></hibernate-generic>`;
  const settings = await openSettings(page, f);
  await settings.getByLabel('원본 인스턴스 식별값', { exact: true }).fill(f.instanceKey);
  await settings.getByLabel('원본 도구', { exact: true }).selectOption('confluence');
  await settings.getByLabel('Jira·Confluence 원본 파일', { exact: true }).setInputFiles({ name: 'entities.xml', mimeType: 'application/xml', buffer: Buffer.from(text) });
  const creation = page.waitForResponse(response => response.url().includes('/api/legacy-import/packages?') && response.request().method() === 'POST');
  await settings.getByRole('button', { name: '원본 분석 시작', exact: true }).click();
  const response = await creation; expect(response.status()).toBe(201); const summary = await response.json() as LegacyPackageSummary;
  expect(summary.counts.page).toBe(1); await expect(settings).toContainText('UnknownSyntheticPlugin');
  await settings.getByLabel('원본 객체 종류', { exact: true }).selectOption('page');
  const detailResponse = page.waitForResponse(value => value.url().endsWith(`/api/legacy-import/packages/${summary.id}/records/${encodeURIComponent(`page:${sourceId}`)}`));
  await settings.getByLabel('원본 객체 목록', { exact: true }).getByRole('button').filter({ hasText: '합성 Confluence 원문' }).click();
  expect((await detailResponse).status()).toBe(200);
  const detail = settings.getByRole('region', { name: '원본 객체 상세', exact: true });
  await expect(detail).toContainText('부분 표시');
  expect(await detail.getByLabel('원본 본문', { exact: true }).textContent()).toBe(body.slice(0, 20000));
  await expect(detail.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as Window & { __legacyUnsafe?: boolean }).__legacyUnsafe))).toBe(false);
  const downloadEvent = page.waitForEvent('download'); await detail.getByRole('button', { name: '원본 객체 전체 JSON 다운로드', exact: true }).click();
  const download = await downloadEvent, path = await download.path(); expect(path).not.toBeNull();
  const downloaded = JSON.parse(await readFile(path!, 'utf8')) as LegacyRecord;
  expect(downloaded.text).toBe(body); expect(downloaded.sourceId).toBe(sourceId); expect(downloaded.references).toContainEqual({ kind: 'project', sourceId: 'space-1', relation: 'space' });
  expect(canonical(await (await f.request.get('/api/workspace')).json() as WorkspaceSnapshot)).toEqual(canonical(f.workspace));
});

test('파일·분석 설정은 오류와 다중 탐색 거절에서 보존되고 처리 중에는 작업자 변경을 막는다', async ({ page, legacy: f }) => {
  const settings = await openSettings(page, f), instance = settings.getByLabel('원본 인스턴스 식별값', { exact: true }), file = settings.getByLabel('Jira·Confluence 원본 파일', { exact: true });
  await instance.fill(f.instanceKey); await settings.getByLabel('원본 도구', { exact: true }).selectOption('jira');
  await file.setInputFiles({ name: 'invalid.xml', mimeType: 'application/xml', buffer: Buffer.from('<broken>') });
  const failure = page.waitForResponse(response => response.url().includes('/api/legacy-import/packages?') && response.request().method() === 'POST');
  await settings.getByRole('button', { name: '원본 분석 시작', exact: true }).click(); expect((await failure).status()).toBe(400);
  await expect(settings.getByRole('alert')).toContainText('선택한 파일과 입력은 유지됩니다'); await expect(instance).toHaveValue(f.instanceKey);
  expect(await file.evaluate(value => (value as HTMLInputElement).files?.[0]?.name)).toBe('invalid.xml');
  page.once('dialog', value => value.accept());
  expect(await page.evaluate(() => { const laterGuard = (event: Event) => event.preventDefault(); window.addEventListener('teamspace:navigate', laterGuard); try { return window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })); } finally { window.removeEventListener('teamspace:navigate', laterGuard); } })).toBe(false);
  await expect(instance).toHaveValue(f.instanceKey); expect(await file.evaluate(value => (value as HTMLInputElement).files?.length)).toBe(1);
  page.once('dialog', value => value.accept()); expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(true);
  await expect(instance).toHaveValue(''); expect(await file.evaluate(value => (value as HTMLInputElement).files?.length)).toBe(0);
  await instance.fill(f.instanceKey); await file.setInputFiles({ name: f.filename, mimeType: 'text/csv', buffer: csv([['Issue key', 'Summary'], ['OLD-1', '합성 대기 업무']]) });
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let reportHeld = () => {}; const held = new Promise<void>(resolve => { reportHeld = resolve; });
  await page.route('**/api/legacy-import/packages?*', async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); reportHeld(); await gate; await route.fulfill({ response }); });
  try {
    await settings.getByRole('button', { name: '원본 분석 시작', exact: true }).click(); await held;
    await expect(instance).toBeDisabled(); expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    const actor = page.getByLabel('작업자 선택', { exact: true }), previous = await actor.inputValue();
    await actor.selectOption(f.workspace.users.find(value => value.id !== previous)!.id); await expect(actor).toHaveValue(previous);
    release(); await expect(settings.locator('.legacy-package-item').filter({ hasText: f.filename })).toBeVisible();
    await expect(instance).toBeEnabled(); await expect(instance).toHaveValue(f.instanceKey);
  } finally { release(); }
});
