import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';

const packagesPath = '/api/legacy-import/packages';
const optionsPath = '/api/migrations/options';
const previewPath = '/api/migrations/preview';
const batchName = '여러 원본 파일 분석';
const button = (within: Page | Locator, name: string) => within.getByRole('button', { name, exact: true });
const csv = (rows: string[][]) => Buffer.from(rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n'));
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');

async function json<T>(response: Pick<APIResponse, 'status' | 'json' | 'text'>, expected = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const packages = async (request: APIRequestContext) => json<LegacyPackageSummary[]>(await request.get(packagesPath));
const content = ({ projects, issues, documents }: WorkspaceSnapshot) => ({ projects, issues, documents });

function responseAt(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

function jiraExport(key: string, title: string) {
  return csv([
    ['Issue key', 'Issue id', 'Project key', 'Project name', 'Summary', 'Description', 'Status', 'Issue Type', 'Created', 'Updated'],
    [`${key}-1`, '101', key, `원본 Jira ${key}`, title, '배치에서 분석한 합성 업무 설명', 'Ready', 'Task', '2020-01-02T03:04:05Z', '2020-02-03T04:05:06Z'],
  ]);
}

function confluenceExport(spaceKey: string, title: string, body: string) {
  return zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">원본 Confluence ${spaceKey}</property></object>
    <object class="Page"><id name="id">100</id><property name="title">${title}</property><property name="version">1</property><property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">2020-01-02T00:00:00Z</property></object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>${body}</p>]]></property><property name="content" class="Page"><id name="id">100</id></property></object>
  </hibernate-generic>`) }]);
}

test('360px에서 Jira와 Confluence를 순차 분석하고 재시도 후 선택한 원본만 이관한다', async ({ page, request }) => {
  test.setTimeout(110_000);
  const id = randomUUID().slice(0, 7).toUpperCase();
  const instance = `batch-browser-${id}`;
  const jiraInstance = `${instance}-jira`;
  const wikiInstance = `${instance}-wiki`;
  const priorFilename = `prior-${id}.csv`;
  const jiraFilename = `issues-${id}.csv`;
  const wrongFilename = `same-issues-${id}.csv`;
  const wikiFilename = `docs-${id}.zip`;
  const jiraKey = `BJ${id}`;
  const wikiKey = `BW${id}`;
  const issueTitle = `합성 신규 업무 ${id}`;
  const docTitle = `합성 신규 문서 ${id}`;
  const docBody = `새 문서에서 확인할 합성 본문 ${id}`;
  const jira = jiraExport(jiraKey, issueTitle);
  const wiki = confluenceExport(wikiKey, docTitle, docBody);
  const baseline = await workspace(request);
  const { projects: [project], users: [actor] } = baseline;
  const headers = { 'X-Actor-Id': actor.id };
  const postPrior = () => request.post(`${packagesPath}?${new URLSearchParams({ filename: priorFilename, instanceKey: `${instance}-prior` })}`, {
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: jiraExport(`BP${id}`, `이전 매핑 업무 ${id}`),
  });

  let announceFirst = () => {};
  const firstCommitted = new Promise<void>(resolve => { announceFirst = resolve; });
  let releaseFirst = () => {};
  const firstReply = new Promise<void>(resolve => { releaseFirst = resolve; });
  const requests: { filename: string; instanceKey: string | null; product: string | null; sha256: string }[] = [];
  let jiraSaved: LegacyPackageSummary | undefined;
  let wikiSaved: LegacyPackageSummary | undefined;

  try {
    const prior = await json<LegacyPackageSummary>(await postPrior(), 201);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(actorId => localStorage.setItem('donefac.actor', actorId), actor.id);
    await page.goto(`/#/${project.id}/settings?section=migration`);
    const mapping = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const pick = (filename: string) => mapping.getByRole('checkbox', { name: `이관 패키지 ${filename}`, exact: true });
    const loadMapping = button(mapping, '선택 패키지 매핑 불러오기');
    const timezone = mapping.getByLabel('이관 원본 시간대', { exact: true });
    await pick(priorFilename).check();
    await loadMapping.click();
    await timezone.fill('Europe/Paris');
    await expect(timezone).toHaveValue('Europe/Paris');

    const legacy = page.getByRole('region', { name: '기존 도구 원본 분석', exact: true });
    await button(legacy, batchName).click();
    const batch = legacy.getByRole('region', { name: batchName, exact: true });
    const handoff = button(batch, '분석한 패키지로 이관 매핑');
    const run = button(batch, '원본 파일 순차 분석');
    await batch.getByLabel('분석할 원본 파일 여러 개', { exact: true }).setInputFiles([
      { name: jiraFilename, mimeType: 'text/csv', buffer: jira },
      { name: wrongFilename, mimeType: 'text/csv', buffer: jira },
      { name: wikiFilename, mimeType: 'application/zip', buffer: wiki },
    ]);
    const row = (filename: string) => batch.locator(`[data-batch-filename="${filename}"]`);
    const state = (filename: string, label: string) => row(filename).getByText(label, { exact: true });
    for (const filename of [jiraFilename, wrongFilename]) {
      await row(filename).getByLabel('원본 인스턴스 식별값', { exact: true }).fill(jiraInstance);
    }
    await row(wikiFilename).getByLabel('원본 인스턴스 식별값', { exact: true }).fill(wikiInstance);
    const wrongProduct = row(wrongFilename).getByRole('combobox', { name: '원본 도구', exact: true });
    await wrongProduct.selectOption('confluence');
    await expect(state(jiraFilename, '분석 대기')).toBeVisible();
    await expect(state(wikiFilename, '분석 대기')).toBeVisible();

    await page.route('**/api/legacy-import/packages?*', async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      const params = new URL(request.url()).searchParams;
      const filename = params.get('filename')!;
      requests.push({ filename, instanceKey: params.get('instanceKey'), product: params.get('product'), sha256: digest(request.postDataBuffer()!) });
      const response = await route.fetch();
      if (filename === jiraFilename && !jiraSaved) {
        jiraSaved = await json<LegacyPackageSummary>(response, 201);
        announceFirst();
        await firstReply;
      }
      if (filename === wikiFilename && !wikiSaved) {
        wikiSaved = await json<LegacyPackageSummary>(response, 201);
        await route.abort('failed');
        return;
      }
      await route.fulfill({ response });
    });
    await run.click();
    await firstCommitted;
    await expect(state(jiraFilename, '분석 중')).toBeVisible();
    await expect(state(wrongFilename, '분석 대기')).toBeVisible();
    await expect(state(wikiFilename, '분석 대기')).toBeVisible();
    expect(requests.map(value => value.filename)).toEqual([jiraFilename]);
    expect(content(await workspace(request))).toEqual(content(baseline));
    await button(batch, '현재 분석 후 중지').click();
    await expect(batch.getByText('현재 파일의 분석을 마치면 중지합니다.', { exact: true })).toBeVisible();
    releaseFirst();
    await expect(state(jiraFilename, '분석 완료')).toBeVisible();
    await expect(run).toBeEnabled();
    await expect(state(wrongFilename, '분석 대기')).toBeVisible();
    await expect(state(wikiFilename, '분석 대기')).toBeVisible();
    expect(requests.map(value => value.filename)).toEqual([jiraFilename]);
    const rejectedAlias = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === packagesPath && url.searchParams.get('filename') === wrongFilename && response.request().method() === 'POST';
    });
    await run.click();
    expect((await rejectedAlias).status()).toBe(400);

    await expect(state(jiraFilename, '분석 완료')).toBeVisible();
    await expect(state(wrongFilename, '분석 실패')).toBeVisible();
    await expect(state(wikiFilename, '결과 확인 필요')).toBeVisible();
    await expect(handoff).toBeDisabled();
    expect(requests.map(value => value.filename)).toEqual([jiraFilename, wrongFilename, wikiFilename]);
    expect(jiraSaved).toMatchObject({ sha256: digest(jira), source: { product: 'jira', format: 'jira-csv', instanceKey: jiraInstance }, counts: { issue: 1 } });
    expect(wikiSaved).toMatchObject({ sha256: digest(wiki), source: { product: 'confluence', format: 'confluence-xml', instanceKey: wikiInstance }, counts: { page: 1 } });

    const checkingWiki = responseAt(page, packagesPath);
    await button(row(wikiFilename), '같은 요청으로 다시 확인').click();
    expect(await json<LegacyPackageSummary>(await checkingWiki)).toEqual(wikiSaved);
    await expect(state(wikiFilename, '기존 분석 재사용')).toBeVisible();
    expect(requests[3]).toEqual(requests[2]);
    await wrongProduct.selectOption('jira');
    const checkingAlias = responseAt(page, packagesPath);
    await button(row(wrongFilename), '다시 분석').click();
    expect(await json<LegacyPackageSummary>(await checkingAlias)).toEqual(jiraSaved);
    await expect(state(wrongFilename, '기존 분석 재사용')).toBeVisible();
    expect(requests[4]).toEqual({ filename: wrongFilename, instanceKey: jiraInstance, product: 'jira', sha256: digest(jira) });
    const selectedIds = [jiraSaved!.id, wikiSaved!.id];
    expect((await packages(request)).filter(item => item.source.instanceKey.startsWith(instance)).map(item => item.id).sort())
      .toEqual([prior.id, ...selectedIds].sort());
    expect(content(await workspace(request))).toEqual(content(baseline));

    const previewRequests: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path.startsWith('/api/migrations/preview')) previewRequests.push(path);
    });
    page.once('dialog', confirmation => confirmation.dismiss());
    await handoff.click();
    await expect(timezone).toHaveValue('Europe/Paris');
    await expect(pick(priorFilename)).toBeChecked();
    await expect(pick(jiraFilename)).not.toBeChecked();
    page.once('dialog', confirmation => confirmation.accept());
    await handoff.click();
    await expect(mapping.getByRole('heading', { name: '실제 데이터 이관', exact: true })).toBeFocused();
    await expect(pick(priorFilename)).not.toBeChecked();
    await expect(pick(jiraFilename)).toBeChecked();
    await expect(pick(wikiFilename)).toBeChecked();
    await expect(mapping.getByRole('checkbox', { checked: true })).toHaveCount(2);
    await expect(timezone).toHaveCount(0);
    expect(previewRequests).toEqual([]);
    expect(content(await workspace(request))).toEqual(content(baseline));

    const mappingRequest = responseAt(page, optionsPath, 'GET');
    await loadMapping.click();
    const mappingResponse = await mappingRequest;
    expect(new URL(mappingResponse.url()).searchParams.getAll('packageId').sort()).toEqual([...selectedIds].sort());
    const options = await json<MigrationOptions>(mappingResponse);
    expect(options.defaultConfiguration.packageIds.sort()).toEqual([...selectedIds].sort());
    await expect(timezone).toBeVisible();
    const reviewing = responseAt(page, previewPath);
    await button(mapping, '적용 전 미리보기 만들기').click();
    const preview = await json<MigrationPreview>(await reviewing, 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    expect(preview.configuration.packageIds.sort()).toEqual([...selectedIds].sort());
    expect(preview.counts).toMatchObject({ projects: 2, issues: 1, documents: 1 });
    expect(preview.samples.map(sample => sample.title)).toEqual(expect.arrayContaining([issueTitle, docTitle]));
    expect(content(await workspace(request))).toEqual(content(baseline));

    const review = mapping.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    for (const code of preview.requiredAcknowledgements) await review.getByRole('checkbox', { name: `이관 확인 ${code}`, exact: true }).check();
    const applying = responseAt(page, `/api/migrations/previews/${preview.id}/apply`);
    page.once('dialog', confirmation => confirmation.accept());
    await button(review, '검토한 이관 실제 적용').click();
    const receipt = (await json<MigrationApplyResult>(await applying, 201)).import;
    expect(receipt.packages.map(item => item.stagingId).sort()).toEqual([...selectedIds].sort());
    expect(receipt.projectIds).toHaveLength(2);
    const after = await workspace(request);
    expect(after.issues.filter(issue => baseline.issues.some(value => value.id === issue.id))).toEqual(baseline.issues);
    expect(after.documents.filter(document => baseline.documents.some(value => value.id === document.id))).toEqual(baseline.documents);
    expect(after.issues.filter(issue => receipt.projectIds.includes(issue.projectId))).toMatchObject([{ title: issueTitle }]);
    expect(after.documents.filter(document => receipt.projectIds.includes(document.projectId!))).toMatchObject([{ title: docTitle, plainText: docBody }]);
  } finally {
    releaseFirst();
    const current = await workspace(request);
    const created = [
      ...current.issues.filter(issue => issue.title === issueTitle).map(issue => ({ id: issue.id, resource: 'issues' })),
      ...current.documents.filter(document => document.title === docTitle).map(document => ({ id: document.id, resource: 'documents' })),
    ];
    for (const { id, resource } of created) {
      const removed = await request.delete(`/api/${resource}/${id}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
    for (const pkg of (await packages(request)).filter(item => item.source.instanceKey.startsWith(instance))) {
      await request.delete(`${packagesPath}/${pkg.id}?expectedVersion=${pkg.version}`, { headers });
    }
  }
});

test('다른 화면에서 지운 분석 패키지를 매핑에 넘기지 않고 원본으로 다시 분석한다', async ({ page, request }) => {
  const { projects: [project], users: [actor] } = await workspace(request);
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const filename = `deleted-${suffix}.csv`;
  const instanceKey = `batch-removed-${suffix}`;
  const headers = { 'X-Actor-Id': actor.id };
  try {
    await page.addInitScript(actorId => localStorage.setItem('donefac.actor', actorId), actor.id);
    await page.goto(`/#/${project.id}/settings?section=migration`);
    const legacy = page.getByRole('region', { name: '기존 도구 원본 분석', exact: true });
    await button(legacy, batchName).click();
    const batch = legacy.getByRole('region', { name: batchName, exact: true });
    const mapping = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const handoff = button(batch, '분석한 패키지로 이관 매핑');
    const pick = mapping.getByRole('checkbox', { name: `이관 패키지 ${filename}`, exact: true });
    await batch.getByLabel('분석할 원본 파일 여러 개', { exact: true }).setInputFiles({
      name: filename, mimeType: 'text/csv', buffer: jiraExport(`DL${suffix}`, '다시 분석할 합성 업무'),
    });
    const row = batch.locator(`[data-batch-filename="${filename}"]`);
    await row.getByLabel('원본 인스턴스 식별값', { exact: true }).fill(instanceKey);
    const uploading = responseAt(page, packagesPath);
    await button(batch, '원본 파일 순차 분석').click();
    const original = await json<LegacyPackageSummary>(await uploading, 201);
    await expect(handoff).toBeEnabled();
    await expect(pick).not.toBeChecked();
    expect((await request.delete(`${packagesPath}/${original.id}?expectedVersion=${original.version}`, { headers })).ok()).toBe(true);

    await handoff.click();
    await expect(batch.getByText('보관한 분석 목록이 변경되었습니다. 해당 파일의 결과를 확인해 주세요.', { exact: true })).toBeVisible();
    await expect(row).toHaveAttribute('data-state', 'failed');
    await expect(handoff).toBeDisabled();
    await expect(mapping.getByText('이관 패키지 1개 선택', { exact: true })).toHaveCount(0);

    const retrying = responseAt(page, packagesPath);
    await button(row, '다시 분석').click();
    const replacement = await json<LegacyPackageSummary>(await retrying, 201);
    expect(replacement).toMatchObject({ sha256: original.sha256, source: original.source });
    expect(replacement.id).not.toBe(original.id);
    await handoff.click();
    await expect(pick).toBeChecked();
    await expect(mapping.getByRole('heading', { name: '실제 데이터 이관', exact: true })).toBeFocused();
  } finally {
    for (const item of (await packages(request)).filter(pkg => pkg.source.instanceKey === instanceKey)) {
      await request.delete(`${packagesPath}/${item.id}?expectedVersion=${item.version}`, { headers });
    }
  }
});
