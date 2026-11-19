import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationPreview, SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot } from '../../shared/types';

const csv = (rows: string[][]) => Buffer.from(rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n'));
const suffix = () => randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
function zip(entries: [string, Buffer][]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [path, content] of entries) {
    const name = Buffer.from(path), local = Buffer.alloc(30), directory = Buffer.alloc(46), checksum = crc32(content);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(3 << 8 | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((0o100600 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, content); central.push(directory, name); offset += local.length + name.length + content.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
async function upload(request: APIRequestContext, filename: string, content: Buffer, instanceKey: string) { const response = await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey })}`, { headers: { 'Content-Type': 'application/octet-stream' }, data: content }); expect(response.status(), await response.text()).toBe(201); return await response.json() as LegacyPackageSummary; }
async function open(page: Page, request: APIRequestContext) { const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot; await page.goto(`/#/${workspace.projects[0].id}/settings`); const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true }); await expect(settings).toBeVisible(); return { settings, workspace }; }
async function selectPackage(settings: Locator, filename: string) { await settings.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check(); await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click(); await expect(settings.getByLabel('이관 원본 시간대', { exact: true })).toBeVisible(); }
async function preview(page: Page, settings: Locator) { const response = page.waitForResponse(value => value.url().endsWith('/api/migrations/preview') && value.request().method() === 'POST'); await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click(); const result = await response; expect(result.ok(), await result.text()).toBe(true); return await result.json() as MigrationPreview; }
async function acknowledge(settings: Locator, value: MigrationPreview) { for (const code of value.requiredAcknowledgements) await settings.getByLabel(`이관 확인 ${code}`, { exact: true }).check(); }
function jira(key: string, title: string) { return csv([['Issue key', 'Issue id', 'Project key', 'Project name', 'Summary', 'Description', 'Status', 'Issue Type', 'Created', 'Updated', 'Reporter', 'Comment'], [`${key}-1`, '100', key, `원본 프로젝트 ${key}`, title, 'h2. 원래 설명\n* 보존할 항목', 'Ready', 'Task', '2020-01-02T03:04:05Z', '2020-02-03T04:05:06Z', 'old-author', '2020-02-03T04:06:00Z;old-author;원래 댓글']]); }

test('Jira 매핑·진단 검토 후 실제 이관하고 409·408·대기 중 탐색을 안전하게 처리한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const unique = suffix(), originalKey = `OLD${unique}`, key = `NEW${unique}`, filename = `migration-${unique}.csv`, title = `실제 이관 업무 ${unique}`;
  const pkg = await upload(request, filename, jira(originalKey, title), `migration-browser-${unique}`);
  const { settings, workspace } = await open(page, request);
  await selectPackage(settings, filename);
  const keyInput = settings.getByLabel(`새 프로젝트 키 원본 프로젝트 ${originalKey}`, { exact: true });
  await keyInput.fill(workspace.projects[0].key);
  const blocked = await preview(page, settings); expect(blocked.canApply).toBe(false); await expect(settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();
  await keyInput.fill(key); await expect(settings.getByRole('region', { name: '이관 적용 미리보기', exact: true })).toHaveCount(0);
  const ready = await preview(page, settings); expect(ready.canApply, JSON.stringify(ready.notices)).toBe(true); await acknowledge(settings, ready);
  const applyButton = settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }); await expect(applyButton).toBeEnabled();
  for (const status of [409, 408]) {
    await page.route(`**/api/migrations/previews/${ready.id}/apply`, route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: `합성 ${status} 응답` }) }));
    page.once('dialog', dialog => dialog.accept()); await applyButton.click();
    await expect(settings.getByRole('alert')).toContainText(`합성 ${status}`); await expect(keyInput).toHaveValue(key); await expect(applyButton).toBeEnabled();
    for (const code of ready.requiredAcknowledgements) await expect(settings.getByLabel(`이관 확인 ${code}`, { exact: true })).toBeChecked();
    await page.unroute(`**/api/migrations/previews/${ready.id}/apply`);
  }
  let release = () => {}, held = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { held = resolve; });
  await page.route(`**/api/migrations/previews/${ready.id}/apply`, async route => { const response = await route.fetch(); held(); await gate; await route.fulfill({ response }); });
  try {
    const applied = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${ready.id}/apply`) && value.status() < 400);
    page.once('dialog', dialog => dialog.accept()); await applyButton.click(); await received;
    await expect(keyInput).toBeDisabled(); const actor = await page.getByLabel('작업자 선택', { exact: true }).inputValue();
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(workspace.users.find(user => user.id !== actor)!.id); await expect(page.getByLabel('작업자 선택', { exact: true })).toHaveValue(actor);
    expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    release(); const response = await applied; expect(response.ok()).toBe(true); const result = await response.json() as MigrationApplyResult;
    await expect(settings.getByLabel('이관 영수증 상세', { exact: true })).toBeVisible();
    await settings.getByLabel('이관 영수증 상세', { exact: true }).getByText('검토한 이관 진단', { exact: true }).click(); await expect(settings.getByLabel('이관 영수증 상세', { exact: true })).toContainText('CSV_HISTORY_NOT_PROVIDED');
    const current = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot, issue = current.issues.find(value => value.title === title)!;
    expect(issue.projectId).toBe(result.import.projectIds[0]); expect(issue.createdAt).toBe('2020-01-02T03:04:05.000Z');
    const archives = await (await request.get(`/api/source-imports/${result.import.id}/records?kind=issue&limit=50`)).json() as SourceRecordPage;
    expect(archives.records).toHaveLength(1); expect(archives.records[0].record.sourceId).toBe('100');
    const origins = await (await request.get(`/api/resource-origins?resourceType=issue&resourceId=${issue.id}&limit=50`)).json() as SourceRecordPage; expect(origins.records.some(value => value.record.kind === 'issue')).toBe(true);
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`); await page.getByRole('dialog').getByRole('button', { name: '원본 기록', exact: true }).click(); const originPanel = page.getByRole('region', { name: '원본 이관 기록', exact: true }); await expect(originPanel).toContainText('old-author');
    await originPanel.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('issue'); await originPanel.getByLabel('보존한 원본 기록 목록', { exact: true }).getByRole('button').first().click();
    await expect(originPanel.getByLabel('보존한 원본 본문', { exact: true })).toContainText('원래 설명');
  } finally { release(); await page.unroute(`**/api/migrations/previews/${ready.id}/apply`); await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
});

test('Confluence 문서·이력을 적용하고 원본 작성자와 긴 storage 원문의 전체 JSON을 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const unique = suffix(), name = `원본 공간 ${unique}`, title = `보존 문서 ${unique}`, raw = ' \r\n<p>원래 <strong>서식</strong></p><ac:structured-macro ac:name="vendor-test"><ac:plain-text-body><![CDATA[안전한 원문]]></ac:plain-text-body></ac:structured-macro>' + '<p>긴 원문😀</p>'.repeat(2500) + '\r\n ', old = '<p>과거 문서</p>';
  const cd = (value: string) => `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`, prop = (key: string, value: string) => `<property name="${key}">${cd(value)}</property>`, ref = (key: string, type: string, id: string) => `<property name="${key}" class="${type}"><id name="id">${id}</id></property>`, obj = (type: string, id: string, body: string) => `<object class="${type}"><id name="${type === 'ConfluenceUserImpl' ? 'key' : 'id'}">${id}</id>${body}</object>`;
  const creator = ref('creator', 'ConfluenceUserImpl', 'old-user'), dates = prop('creationDate', '2019-01-02 03:04:05.000') + prop('lastModificationDate', '2020-01-02 03:04:05.000');
  const attachmentName = 'migration-notes.txt', bytes1 = Buffer.from('원본 첨부 첫 버전'), bytes2 = Buffer.from('원본 첨부 두 번째 버전');
  const xml = `<hibernate-generic>${obj('Space', '42', prop('key', `CF${unique}`) + prop('name', name))}${obj('ConfluenceUserImpl', 'old-user', prop('name', 'confluence-author'))}${obj('Page', '100', prop('title', title) + prop('version', '2') + ref('space', 'Space', '42') + creator + dates + '<collection name="historicalVersions"><element class="Page"><id name="id">101</id></element></collection>')}${obj('Page', '101', prop('title', '과거 제목') + prop('version', '1') + prop('contentStatus', 'historical') + ref('space', 'Space', '42') + ref('originalVersion', 'Page', '100') + creator + dates)}${obj('BodyContent', '200', prop('body', raw) + ref('content', 'Page', '100') + prop('bodyType', '2'))}${obj('BodyContent', '201', prop('body', old) + ref('content', 'Page', '101') + prop('bodyType', '2'))}${obj('Attachment', '700', prop('title', attachmentName) + prop('version', '2') + ref('containerContent', 'Page', '100') + creator + dates + '<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection>')}${obj('Attachment', '701', prop('title', attachmentName) + prop('version', '1') + ref('containerContent', 'Page', '100') + ref('originalVersion', 'Attachment', '700') + creator + dates)}</hibernate-generic>`;
  const filename = `confluence-${unique}.zip`, pkg = await upload(request, filename, zip([['entities.xml', Buffer.from(xml)], ['attachments/100/700/1', bytes1], ['attachments/100/700/2', bytes2]]), `migration-confluence-${unique}`);
  try {
    const { settings } = await open(page, request); await selectPackage(settings, filename); await settings.getByLabel(`새 프로젝트 키 ${name}`, { exact: true }).fill(`CF${unique}`);
    const ready = await preview(page, settings); expect(ready.canApply, JSON.stringify(ready.notices)).toBe(true); await acknowledge(settings, ready);
    const applied = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${ready.id}/apply`)); page.once('dialog', dialog => dialog.accept()); await settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click(); const result = await (await applied).json() as MigrationApplyResult;
    const records = settings.getByRole('region', { name: '이관 영수증 원본 기록', exact: true }); await records.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('page'); await records.getByLabel('보존한 원본 기록 목록', { exact: true }).getByRole('button').filter({ hasText: title }).click();
    const detail = records.getByRole('region', { name: '보존한 원본 기록 상세', exact: true }); await expect(detail).toContainText('confluence-author'); await expect(detail).toContainText('부분 표시'); expect(await detail.getByLabel('보존한 원본 본문', { exact: true }).textContent()).toBe(raw.slice(0, 20000)); await expect(detail.locator('script, img')).toHaveCount(0);
    const downloadEvent = page.waitForEvent('download'); await detail.getByRole('button', { name: '원본 기록 전체 JSON 다운로드', exact: true }).click(); const download = await downloadEvent, path = await download.path(); expect(path).not.toBeNull(); const archive = JSON.parse(await readFile(path!, 'utf8')) as SourceRecordArchive; expect(archive.record.text).toBe(raw); expect(archive.sourceImportId).toBe(result.import.id); expect(archive.record.authorId).toBe('old-user');
    await records.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('revision'); await expect(records.getByLabel('보존한 원본 기록 목록', { exact: true })).toContainText('과거 제목');
    await settings.screenshot({ path: 'docs/screenshots/migration-apply.png' });
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot, document = snapshot.documents.find(value => value.title === title)!;
    await page.goto(`/#/${document.projectId}/documents/${document.id}`); await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
    const attachmentPanel = page.getByRole('region', { name: '첨부파일', exact: true }); let versionRequests = 0; page.on('request', value => { if (value.url().endsWith('/versions')) versionRequests++; });
    await attachmentPanel.getByRole('button', { name: `${attachmentName} 버전`, exact: true }).click(); const versions = attachmentPanel.getByRole('region', { name: `${attachmentName} 보존 버전`, exact: true }); await expect(versions.getByRole('link', { name: /다운로드/ })).toHaveCount(2);
    for (const [label, bytes] of [['1', bytes1], ['2', bytes2]] as const) { const event = page.waitForEvent('download'); await versions.getByRole('link', { name: `${attachmentName} 버전 ${label} 다운로드`, exact: true }).click(); const file = await event, path = await file.path(); expect(await readFile(path!)).toEqual(bytes); }
    await attachmentPanel.getByRole('button', { name: `${attachmentName} 버전`, exact: true }).click(); await attachmentPanel.getByRole('button', { name: `${attachmentName} 버전`, exact: true }).click(); await expect(versions).toBeVisible(); expect(versionRequests).toBe(1);
    await attachmentPanel.getByLabel('첨부할 파일 선택', { exact: true }).setInputFiles({ name: 'standalone.txt', mimeType: 'text/plain', buffer: Buffer.from('이관 이후 일반 첨부') }); await expect(attachmentPanel.getByRole('link', { name: 'standalone.txt', exact: true })).toBeVisible(); await expect(attachmentPanel.getByRole('button', { name: 'standalone.txt 버전', exact: true })).toHaveCount(0);
  } finally { await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
});

test('매핑과 다른 설정이 함께 수정되면 한 탐색 거절이 모든 초안을 보존한다', async ({ page, request }) => {
  const unique = suffix(), filename = `migration-guard-${unique}.csv`, key = `GU${unique}`, pkg = await upload(request, filename, jira(key, `탐색 검증 ${unique}`), `migration-guard-${unique}`);
  try {
    const { settings, workspace } = await open(page, request); await selectPackage(settings, filename);
    const name = settings.getByLabel(`새 프로젝트 이름 원본 프로젝트 ${key}`, { exact: true }); await name.fill('내 이관 프로젝트 초안');
    const legacy = page.getByRole('region', { name: '기존 도구 원본 분석', exact: true }).getByLabel('원본 인스턴스 식별값', { exact: true }); await legacy.fill('다른 설정 카드의 초안');
    const actor = page.getByLabel('작업자 선택', { exact: true }), initial = await actor.inputValue(), target = workspace.users.find(user => user.id !== initial)!.id, url = page.url(); let count = 0;
    const cancelSecond = (dialog: import('@playwright/test').Dialog) => { count++; if (count === 1) void dialog.accept(); else void dialog.dismiss(); }; page.on('dialog', cancelSecond); await actor.selectOption(target); page.off('dialog', cancelSecond);
    await expect(actor).toHaveValue(initial); await expect(name).toHaveValue('내 이관 프로젝트 초안'); await expect(legacy).toHaveValue('다른 설정 카드의 초안'); expect(page.url()).toBe(url); expect(count).toBe(2);
    const acceptAll = (dialog: import('@playwright/test').Dialog) => void dialog.accept(); page.on('dialog', acceptAll); await actor.selectOption(target); page.off('dialog', acceptAll); await expect(actor).toHaveValue(target); await expect(settings.getByLabel('이관 매핑', { exact: true })).toHaveCount(0); await expect(legacy).toHaveValue('');
  } finally { await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
});

test('Jira 작업 시간을 검토해 이관하고 티켓과 기간 보고서에서 초 단위로 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const unique = suffix(), key = `TM${unique}`, filename = `worklog-${unique}.json`;
  const workDate = '2020-02-03', title = `이관 작업 시간 ${unique}`;
  const originalAuthor = { name: `worker-${unique}`, displayName: `원본 작업자 ${unique}` };
  const data = {
    issues: [{
      id:'1901', key:`${key}-1`, fields:{
        project:{id:'101',key,name:`원본 시간 프로젝트 ${unique}`},summary:title,
        issuetype:{id:'1',name:'Task'},status:{id:'1',name:'Open'},
        created:'2020-01-02T03:00:00Z',updated:'2020-02-03T18:00:00Z',
        worklog:{startAt:0,total:1,worklogs:[{
          id:'200',author:originalAuthor,started:`${workDate}T00:15:00.000+0900`,
          timeSpentSeconds:91,comment:'원래 작업 메모',
        }]},
      },
      changelog:{startAt:0,total:0,histories:[]},
    }],
  };
  const pkg = await upload(request, filename, Buffer.from(JSON.stringify(data)), `worklog-browser-${unique}`);
  try {
    const {settings} = await open(page, request);
    await selectPackage(settings, filename);
    const currentActor = await page.getByLabel('작업자 선택', {exact:true}).inputValue();
    await settings.getByText('사용자 매핑', {exact:true}).click();
    await settings.getByLabel(`사용자 매핑 ${originalAuthor.displayName}`, {exact:true}).selectOption(currentActor);
    const checked = await preview(page, settings);
    expect(checked.canApply, JSON.stringify(checked.notices)).toBe(true);
    expect(checked.counts.worklogs).toBe(1);
    const review = settings.getByRole('region', {name:'이관 적용 미리보기',exact:true});
    await expect(review).toContainText('적용할 작업 시간 1');
    await acknowledge(settings, checked);
    const response = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${checked.id}/apply`));
    page.once('dialog', dialog => void dialog.accept());
    await settings.getByRole('button', {name:'검토한 이관 실제 적용',exact:true}).click();
    const applied = await response;
    expect(applied.ok(), await applied.text()).toBe(true);
    await expect(settings.getByLabel('이관 영수증 상세', {exact:true})).toBeVisible();
    const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const issue = workspace.issues.find(row => row.title === title)!;
    expect(issue).toBeTruthy();

    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const drawer = page.getByRole('dialog', {name:title,exact:true});
    await drawer.getByRole('button', {name:'작업 시간',exact:true}).click();
    const worklogs = drawer.getByRole('region', {name:'업무 작업 기록'});
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('1분 31초');
    await expect(worklogs.getByLabel('작업 기록 목록')).toContainText('Jira 이관');
    await expect(worklogs.getByLabel('작업 기록 목록')).toContainText(workDate);
    await worklogs.getByRole('button', {name:`${workDate} 작업 기록 수정`,exact:true}).click();
    await expect(worklogs).toContainText('이관 작업 시간은 1분 31초입니다');
    await worklogs.getByLabel('작업 기록 내용', {exact:true}).fill('이관 후 추가 메모');
    await worklogs.getByRole('button', {name:'기록 수정 저장',exact:true}).click();
    await expect(worklogs.getByLabel('작업 기록 목록')).toContainText('이관 후 추가 메모');
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('1분 31초');

    await drawer.getByRole('button', {name:'업무 상세 닫기'}).click();
    await page.getByRole('button', {name:'보고서',exact:true}).click();
    await page.getByRole('tab', {name:'작업 시간',exact:true}).click();
    await page.getByLabel('작업 시간 시작일', {exact:true}).fill(workDate);
    await page.getByLabel('작업 시간 종료일', {exact:true}).fill(workDate);
    await page.getByRole('button', {name:'작업 시간 조회',exact:true}).click();
    await expect(page.getByRole('region', {name:'업무별 작업 시간'})).toContainText('1분 31초');
  } finally {
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});
