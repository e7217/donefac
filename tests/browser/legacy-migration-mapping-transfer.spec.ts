import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import type { LegacyPackageSummary, MigrationMappingFile, MigrationMappingRestore, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';

const stagePath = '/api/legacy-import/packages';
const exportPath = '/api/migrations/mapping/export';
const importPath = '/api/migrations/mapping/import';
const previewPath = '/api/migrations/preview';

function posted(page: Page, pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
}

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

const file = (buffer: Buffer) => ({ name: 'teamspace-migration-mapping.json', mimeType: 'application/json', buffer });

async function expectViewportWidth(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test('360px에서 내보낸 이관 매핑을 다시 분석한 원본에 불러오고 변경 전 검토를 지킨다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = randomUUID().slice(0, 7).toUpperCase();
  const key = `MR${token}`;
  const mappedKey = `MP${token}`;
  const sourceName = `매핑 원본 프로젝트 ${token}`;
  const mappedName = `옮길 프로젝트 ${token}`;
  const issueTitle = `복원해서 검토할 업무 ${token}`;
  const csv = Buffer.from([
    'Issue key,Issue id,Project key,Project name,Summary,Status,Issue Type,Created,Updated',
    `${key}-1,110,${key},${sourceName},${issueTitle},Ready,Task,2020-01-02T03:04:05Z,2020-02-03T04:05:06Z`,
  ].join('\r\n'));
  const snapshot = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const stage = async (filename: string) => json<LegacyPackageSummary>(await request.post(`${stagePath}?${new URLSearchParams({
    filename, instanceKey: `synthetic-mapping-${token}`, product: 'jira',
  })}`, { headers: { 'Content-Type': 'application/octet-stream' }, data: csv }), 201);
  const remove = async (pkg: LegacyPackageSummary) => json(await request.delete(`${stagePath}/${pkg.id}?expectedVersion=${pkg.version}`));
  const baseline = await snapshot();
  const original = await stage(`mapping-original-${token}.csv`);
  const pendingCleanup = new Map([[original.id, original]]);
  try {
    await page.goto(`/#/${baseline.projects[0].id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const projectKey = settings.getByLabel(`새 프로젝트 키 ${sourceName}`, { exact: true });
    const projectName = settings.getByLabel(`새 프로젝트 이름 ${sourceName}`, { exact: true });
    const timezone = settings.getByLabel('이관 원본 시간대', { exact: true });
    const datePolicy = settings.getByLabel('이관 날짜 처리', { exact: true });
    const restore = settings.getByLabel('이관 매핑 파일 불러오기', { exact: true });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const packageChoice = (pkg: LegacyPackageSummary) => settings.getByLabel(`이관 패키지 ${pkg.filename}`, { exact: true });
    const select = async (pkg: LegacyPackageSummary) => {
      await packageChoice(pkg).check();
      await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
      await expect(timezone).toBeVisible();
    };
    const preview = async () => {
      const created = posted(page, previewPath);
      await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
      return json<MigrationPreview>(await created, 201);
    };
    await select(original);
    await projectKey.fill(mappedKey);
    await projectName.fill(mappedName);
    await timezone.fill('Asia/Seoul');
    await datePolicy.selectOption('import-time');
    const exporting = posted(page, exportPath);
    const download = page.waitForEvent('download');
    await settings.getByRole('button', { name: '이관 매핑 JSON 내보내기', exact: true }).click();
    const exported = await json<MigrationMappingFile>(await exporting);
    const downloaded = await download;
    expect(downloaded.suggestedFilename()).toBe('teamspace-migration-mapping.json');
    const path = await downloaded.path();
    expect(path).toBeTruthy();
    const savedFile = await readFile(path!);
    expect(JSON.parse(savedFile.toString('utf8'))).toEqual(exported);
    expect(exported.configuration.packageIds).toEqual([original.id]);
    expect(exported.configuration.projects[0]).toMatchObject({ key: mappedKey, name: mappedName });
    await expect(review).toHaveCount(0);

    await remove(original);
    pendingCleanup.delete(original.id);
    const restaged = await stage(`mapping-restaged-${token}.csv`);
    pendingCleanup.set(restaged.id, restaged);
    expect(restaged.id).not.toBe(original.id);
    expect(restaged.sha256).toBe(original.sha256);
    await page.reload();
    await select(restaged);
    const draftName = `유지해야 할 검토 초안 ${token}`;
    await projectName.fill(draftName);
    await timezone.fill('Europe/London');
    const before = await preview();
    expect(before.canApply, JSON.stringify(before.notices)).toBe(true);
    await expect(review).toContainText(draftName);
    await expect(restore).toBeVisible();
    await expectViewportWidth(page);
    const mutations: string[] = [];
    page.on('request', outgoing => {
      const pathname = new URL(outgoing.url()).pathname;
      if (outgoing.method() === 'POST' && pathname.startsWith('/api/migrations/')) mutations.push(pathname);
    });
    const assertDraft = async () => {
      await expect(packageChoice(restaged)).toBeChecked();
      await expect(projectKey).toHaveValue(key);
      await expect(projectName).toHaveValue(draftName);
      await expect(timezone).toHaveValue('Europe/London');
      await expect(review).toContainText(draftName);
    };

    const invalid = structuredClone(exported);
    invalid.packages[0].sha256 = '0'.repeat(64);
    const rejecting = posted(page, importPath);
    await restore.setInputFiles(file(Buffer.from(JSON.stringify(invalid))));
    const rejected = await json<{ error: string; details: { reason: string } }>(await rejecting, 409);
    expect(rejected.details.reason).toBe('package_missing');
    await expect(settings.getByRole('alert').filter({ hasText: rejected.error })).toBeVisible();
    await assertDraft();

    async function load(accept: boolean) {
      const incoming = posted(page, importPath);
      const prompt = page.waitForEvent('dialog').then(async dialog => {
        expect(dialog.message()).toContain('현재 패키지 선택과 이관 매핑 및 미리보기를 파일의 매핑으로 바꿀까요?');
        if (accept) await dialog.accept();
        else await dialog.dismiss();
      });
      await restore.setInputFiles(file(savedFile));
      await prompt;
      const value = await json<MigrationMappingRestore>(await incoming);
      expect(value.configuration.packageIds).toEqual([restaged.id]);
      expect(value.configuration.projects[0]).toMatchObject({ key: mappedKey, name: mappedName });
      return value;
    }
    await load(false);
    await assertDraft();
    const accepted = await load(true);
    await expect(settings.getByRole('status').filter({ hasText: '이관 매핑을 불러왔습니다. 적용 전 미리보기를 새로 만들어 주세요.' })).toBeVisible();
    await expect(packageChoice(restaged)).toBeChecked();
    await expect(projectKey).toHaveValue(mappedKey);
    await expect(projectName).toHaveValue(mappedName);
    await expect(timezone).toHaveValue('Asia/Seoul');
    await expect(datePolicy).toHaveValue('import-time');
    await expect(review).toHaveCount(0);
    expect(mutations).toEqual([importPath, importPath, importPath]);

    const fresh = await preview();
    expect(fresh.id).not.toBe(before.id);
    expect(fresh.configuration).toEqual(accepted.configuration);
    expect(fresh.canApply, JSON.stringify(fresh.notices)).toBe(true);
    await expect(review).toContainText(mappedName);
    await expectViewportWidth(page);
    expect(mutations).toEqual([importPath, importPath, importPath, previewPath]);
    const after = await snapshot();
    expect(after.projects).toEqual(baseline.projects);
    expect(after.issues).toEqual(baseline.issues);
    expect(after.documents).toEqual(baseline.documents);
    const fileControls = settings.getByRole('group', { name: '이관 매핑 파일', exact: true });
    const bounds = await fileControls.evaluate(element => {
      const viewport = document.documentElement.clientWidth;
      return [element, ...element.querySelectorAll('input, button')].map(control => {
        const { left, right } = control.getBoundingClientRect();
        return { left, right, viewport };
      });
    });
    for (const { left, right, viewport } of bounds) {
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(viewport);
    }
  } finally {
    for (const pkg of pendingCleanup.values()) await remove(pkg);
  }
});
