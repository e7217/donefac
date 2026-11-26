import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type {
  Issue, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, SourceRecordArchive,
  SourceReconciliationAudit, SourceReconciliationPage, WorkspaceSnapshot,
} from '../../shared/types';

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text'>, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status(), text).toBe(status);
  return JSON.parse(text) as T;
}

test('360px 이관 대조에서 현재 필드와 상위 연결 차이, 원본 주소·대상 연결 오류를 각각 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = randomUUID().slice(0, 7).toUpperCase();
  const created = '2025-01-01T00:00:00Z';
  const title = `주소 연결을 검증할 업무 ${token}`;
  const otherTitle = `동일 원본 ID의 다른 업무 ${token}`;
  const malformedTitle = `대상 연결을 검증할 업무 ${token}`;
  const childTitle = `상위 연결을 다시 검토할 업무 ${token}`;
  const sourceBody = `첫 원본에서 보존한 설명 ${token}`;
  const otherBody = `별도 원본에서 보존한 설명 ${token}`;
  const sources = [
    { instance: `jira-alias-a-${token}`, projectKey: `RA${token}`, base: 'https://jira.example.test/alpha',
      entries: [
        { id: '1200', summary: title, description: sourceBody },
        { id: '1201', summary: malformedTitle, description: '두 번째 원본 설명' },
        { id: '1202', summary: childTitle, description: '상위 연결 대조 원본', parentId: '1200' },
      ] },
    { instance: `jira-alias-b-${token}`, projectKey: `RB${token}`, base: 'https://jira.example.test/beta',
      entries: [{ id: '1200', summary: otherTitle, description: otherBody }] },
  ];
  const packages: LegacyPackageSummary[] = [];
  const createdIssues: string[] = [];

  try {
    for (const input of sources) {
      const payload = { issues: input.entries.map(({ id, summary, description, parentId }, index) => ({
        id, key: `${input.projectKey}-${index + 1}`, self: `${input.base}/rest/api/2/issue/${id}`,
        fields: { project: { id: '4020', key: input.projectKey, name: input.instance }, summary, description,
          created, updated: created, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
          ...(parentId ? { parent: { id: parentId, key: `${input.projectKey}-1` } } : {}),
        },
      })) };
      const parameters = new URLSearchParams({ filename: `${input.instance}.json`, product: 'jira', instanceKey: input.instance });
      packages.push(await readJson<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${parameters}`, {
        headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify(payload)),
      }), 201));
    }
    const [first, second] = packages;
    const optionsParams = new URLSearchParams(packages.map(pkg => ['packageId', pkg.id]));
    const { defaultConfiguration } = await readJson<MigrationOptions>(await request.get(`/api/migrations/options?${optionsParams}`));
    const configuration = { ...defaultConfiguration, sourceBaseUrls: { [first.id]: sources[0].base, [second.id]: sources[1].base } };
    const preview = await readJson<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    const { import: receipt } = await readJson<MigrationApplyResult>(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
    const workspace = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const currentIssue = workspace.issues.find(issue => issue.title === title && receipt.projectIds.includes(issue.projectId))!;
    expect(currentIssue).toBeTruthy();
    const testTitles = new Set([title, malformedTitle, otherTitle, childTitle]);
    createdIssues.push(...workspace.issues.filter(issue => receipt.projectIds.includes(issue.projectId) && testTitles.has(issue.title)).map(issue => issue.id));
    const child = workspace.issues.find(issue => issue.title === childTitle && issue.projectId === currentIssue.projectId)!;
    expect(child.parentId).toBe(currentIssue.id);
    const localDescription = '팀에서 다시 편집한 설명';
    const changed = await readJson<Issue>(await request.patch(`/api/issues/${child.id}`, {
      data: { expectedVersion: child.version, parentId: null, description: localDescription },
    }));
    expect(changed).toMatchObject({ id: child.id, parentId: null, description: localDescription, version: child.version + 1 });
    const base = `/api/source-imports/${receipt.id}`;
    const listing = `${base}/reconciliation`;
    const audit = `${listing}/audit`;
    const audited = await readJson<SourceReconciliationAudit>(await request.get(`${audit}?expectedVersion=${receipt.version}`));
    expect(audited.primaryRecords).toHaveLength(2);
    expect(audited.primaryRecords.every(row => row.invalidTargets === 0)).toBe(true);
    expect(audited.primaryRecords.find(row => row.packageId === first.id)?.hierarchy).toMatchObject({
      matched: 2, changed: 1, unavailable: 0, invalid: 0,
    });
    expect(audited.primaryRecords.find(row => row.packageId === second.id)?.hierarchy?.changed).toBe(0);
    expect(audited.primaryRecords.find(row => row.packageId === first.id)?.fields?.counts.description).toEqual({
      matched: 2, changed: 1, unavailable: 0, invalid: 0,
    });
    expect(audited.primaryRecords.find(row => row.packageId === second.id)?.fields?.counts.description?.changed).toBe(0);
    const realPage = await readJson<SourceReconciliationPage>(await request.get(`${listing}?${new URLSearchParams({ packageId: first.id, kind: 'issue', limit: '30', offset: '0' })}`));
    expect(realPage.rows.map(row => row.sourceId).sort()).toEqual(['1200', '1201', '1202']);
    expect(realPage.rows.every(row => row.status === 'linked')).toBe(true);
    const original = realPage.rows.find(row => row.sourceId === '1200')!;
    expect(original.target?.id).toBe(currentIssue.id);

    // Exercise the UI contract for a damaged binding while using a real receipt, archive, and destination.
    await page.route(url => url.pathname === audit, route => route.fulfill({ json: { ...audited,
      primaryRecords: audited.primaryRecords.map(row => row.packageId === first.id ? { ...row, invalidTargets: 2 } : row),
    } }), { times: 1 });
    const matchesFinding = (url: URL) => url.pathname === listing && url.searchParams.get('finding') === 'invalid-primary-target';
    const rows = realPage.rows.filter(row => row.sourceId !== '1202').map(row => row.sourceRecordId === original.sourceRecordId
      ? { ...row, invalidPrimaryBinding: true } : { ...row, invalidPrimaryTarget: true });
    await page.route(matchesFinding, route => route.fulfill({ json: { ...realPage, total: rows.length, rows } }));

    const archiveReads: string[] = [];
    const writes: string[] = [];
    page.on('request', sent => {
      const url = new URL(sent.url());
      if (url.pathname.startsWith(`${base}/records/`)) archiveReads.push(`${sent.method()} ${url.pathname}`);
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(sent.method())) writes.push(`${sent.method()} ${url.pathname}`);
    });

    await page.goto(`/#/${currentIssue.projectId}/settings?section=migration`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const receipts = settings.getByRole('region', { name: '완료한 이관 영수증', exact: true });
    await receipts.getByRole('button').filter({ hasText: receipt.id }).click();
    await settings.getByRole('button', { name: '이관 결과 대조', exact: true }).click();
    const reconciliation = settings.getByRole('region', { name: '이관 결과 대조', exact: true });
    const list = reconciliation.getByRole('list', { name: '이관 결과 대조 목록', exact: true });
    const clean = list.getByRole('listitem').filter({ hasText: otherTitle });
    await expect(clean.getByText('연결됨', { exact: true })).toBeVisible();
    await expect(clean.getByText('원본 주소·키 연결 오류', { exact: true })).toHaveCount(0);

    await reconciliation.getByRole('button', { name: '전체 이관 검증', exact: true }).click();
    const auditRegion = reconciliation.getByRole('region', { name: '이관 티켓·문서 대조', exact: true });
    const pkg = auditRegion.getByRole('listitem').filter({ hasText: first.filename });
    const otherPkg = auditRegion.getByRole('listitem').filter({ hasText: second.filename });
    const hierarchy = pkg.getByLabel('Jira 업무 상위 연결 대조 건수', { exact: true });
    await expect(hierarchy.locator('div').filter({ hasText: '상위 연결 일치' }).locator('dd')).toHaveText('2');
    await expect(otherPkg.getByRole('button', { name: /^현재 상위 연결 차이/u })).toHaveCount(0);
    const hierarchyFinding = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === listing && url.searchParams.get('finding') === 'changed-parent';
    });
    await hierarchy.getByRole('button', { name: '현재 상위 연결 차이 1개 보기', exact: true }).click();
    const changedParents = await hierarchyFinding;
    expect(Object.fromEntries(new URL(changedParents.url()).searchParams)).toEqual({
      offset: '0', limit: '30', packageId: first.id, kind: 'issue', finding: 'changed-parent',
    });
    expect((await readJson<SourceReconciliationPage>(changedParents)).rows.map(row => row.target?.id)).toEqual([child.id]);
    await expect(reconciliation.getByRole('heading', { name: '대조 원본 목록', exact: true })).toBeFocused();
    await expect(reconciliation.getByText('현재 상위 연결 차이만', { exact: true })).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByText(childTitle, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await reconciliation.getByRole('button', { name: '현재 상위 연결 차이 필터 해제', exact: true }).click();
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(reconciliation.getByLabel('대조 원본 패키지', { exact: true })).toHaveValue(first.id);
    await expect(reconciliation.getByLabel('대조 원본 종류', { exact: true })).toHaveValue('issue');

    const fields = pkg.locator('details').filter({ hasText: '이관 필드 대조' });
    await fields.locator('summary').click();
    const fieldResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === listing && url.searchParams.get('finding') === 'changed-field';
    });
    await fields.getByRole('button', { name: '설명 차이 1개 보기', exact: true }).click();
    const changedFields = await fieldResponse;
    expect(Object.fromEntries(new URL(changedFields.url()).searchParams)).toEqual({
      offset: '0', limit: '30', packageId: first.id, kind: 'issue', finding: 'changed-field', field: 'description',
    });
    const fieldRows = (await readJson<SourceReconciliationPage>(changedFields)).rows;
    expect(fieldRows).toHaveLength(1);
    expect(fieldRows[0]).toMatchObject({ target: { id: child.id }, fieldComparison: { field: 'description', status: 'changed' } });
    await expect(reconciliation.getByText('설명 차이만', { exact: true })).toBeVisible();
    await expect(reconciliation.getByRole('heading', { name: '대조 원본 목록', exact: true })).toBeFocused();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByText(childTitle, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await reconciliation.getByRole('button', { name: '설명 차이 필터 해제', exact: true }).click();
    await expect(list.getByRole('listitem')).toHaveCount(3);

    const selectedFinding = page.waitForResponse(response => matchesFinding(new URL(response.url())));
    await pkg.getByRole('button', { name: '대상 연결 오류 2개 보기', exact: true }).click();
    const finding = await selectedFinding;
    expect(finding.ok()).toBe(true);
    expect(Object.fromEntries(new URL(finding.url()).searchParams)).toEqual({
      offset: '0', limit: '30', packageId: first.id, kind: 'issue', finding: 'invalid-primary-target',
    });
    await expect(reconciliation.getByRole('heading', { name: '대조 원본 목록', exact: true })).toBeFocused();
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(clean).toHaveCount(0);
    const binding = list.getByRole('listitem').filter({ hasText: title });
    const target = list.getByRole('listitem').filter({ hasText: malformedTitle });
    await expect(binding.getByText('원본 주소·키 연결 오류', { exact: true })).toBeVisible();
    await expect(binding.getByText('현재 대상 있음', { exact: true })).toBeVisible();
    await expect(binding.getByText('연결됨', { exact: true })).toHaveCount(0);
    await expect(target.getByText('대상 연결 오류', { exact: true })).toBeVisible();
    await expect(target.getByRole('button', { name: /^현재 업무 열기/u })).toHaveCount(0);

    const recordPath = `${base}/records/${encodeURIComponent(original.sourceRecordId)}`;
    const archiveButton = binding.getByRole('button', { name: '보존 원본 열기', exact: true });
    const selectedArchive = page.waitForResponse(response => new URL(response.url()).pathname === recordPath);
    await archiveButton.click();
    const archiveResponse = await selectedArchive;
    expect(archiveResponse.ok(), await archiveResponse.text()).toBe(true);
    expect(await archiveResponse.json() as SourceRecordArchive).toMatchObject({ id: original.sourceRecordId, packageSha256: first.sha256,
      source: { instanceKey: sources[0].instance }, record: { sourceId: '1200' } });
    const archive = binding.getByRole('region', { name: '보존한 원본 기록 상세', exact: true });
    await expect(archive.getByLabel('보존한 원본 본문', { exact: true })).toHaveText(sourceBody);
    await expect(archive.getByText(first.sha256, { exact: true })).toBeVisible();
    await archive.getByRole('button', { name: '원본 이관 기록 상세 닫기', exact: true }).click();
    await expect(archiveButton).toBeFocused();
    await expect(reconciliation.getByLabel('대조 원본 패키지', { exact: true })).toHaveValue(first.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await binding.getByRole('button', { name: /^현재 업무 열기/u }).click();
    await expect(page).toHaveURL(url => new URLSearchParams(url.hash.split('?')[1]).get('issue') === currentIssue.id);
    await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
    expect(archiveReads).toEqual([`GET ${recordPath}`]);
    expect(writes).toEqual([]);
  } finally {
    for (const issueId of createdIssues) {
      const deleted = await request.delete(`/api/issues/${issueId}`);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json() as { trashEntryId: string }).trashEntryId}`);
    }
    for (const pkg of packages) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});
