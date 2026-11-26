import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Response } from '@playwright/test';
import type {
  LegacyPackageSummary, MigrationApplyResult, MigrationContentReviewDetail, MigrationContentReviewPage, MigrationPreview, WorkspaceSnapshot,
} from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function readJson<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

async function upload(request: APIRequestContext, filename: string, instanceKey: string, data: Buffer) {
  return readJson<LegacyPackageSummary>(await request.post(
    `/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey })}`,
    { headers: { 'Content-Type': 'application/octet-stream' }, data },
  ), 201);
}

test('360px 이관 전 목록과 원본을 검토하고 확인한 내용 그대로 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = randomUUID().slice(0, 7).toUpperCase();
  const issueProjectKey = `A${token}`, documentProjectKey = `Z${token}`;
  const jiraFilename = `a-content-review-${token}.json`, wikiFilename = `z-content-review-${token}.zip`;
  const wikiTitle = `Z 배포 문서 ${token}`, section = `배포 확인 절차 ${token}`;
  const task = '릴리스 환경 점검 완료';
  const originalHost = 'content-review.example.test';
  const originalPageId = '5200', attachmentId = '5400';
  const filename = 'review-proof.png', imageTitle = '첨부 검토 그림';
  const date = '2020-01-02T03:04:05Z';
  const wikiBody = [
    `<h2>${section}</h2>`,
    '<table><tbody><tr><th>환경</th><th>확인 결과</th></tr><tr><td>스테이징</td><td>통과</td></tr></tbody></table>',
    '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status>',
    `<ac:task-body>${task}</ac:task-body></ac:task></ac:task-list>`,
    `<p><a href="https://${originalHost}/guidance">외부 지침</a></p>`,
    `<p><img src="https://${originalHost}/evidence.png" alt="외부 확인 이미지" /></p>`,
    `<p><ac:image ac:alt="${imageTitle}"><ri:attachment ri:filename="${filename}" /></ac:image></p>`,
  ].join('');
  const wikiXml = `<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${documentProjectKey}</property><property name="name">배포 문서 ${token}</property></object>
    <object class="Page"><id name="id">${originalPageId}</id><property name="title">${wikiTitle}</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">42</id></property>
      <property name="creationDate">${date}</property><property name="lastModificationDate">${date}</property></object>
    <object class="BodyContent"><id name="id">5300</id><property name="bodyType">2</property>
      <property name="content" class="Page"><id name="id">${originalPageId}</id></property>
      <property name="body"><![CDATA[${wikiBody}]]></property></object>
    <object class="Attachment"><id name="id">${attachmentId}</id><property name="title">${filename}</property>
      <property name="version">1</property><property name="contentType">image/png</property><property name="creationDate">${date}</property>
      <property name="containerContent" class="Page"><id name="id">${originalPageId}</id></property></object>
  </hibernate-generic>`;
  const issues = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    const summary = `A 검토 업무 ${String(number).padStart(2, '0')} ${token}`;
    return { id: String(5200 + index), key: `${issueProjectKey}-${number}`, fields: {
      project: { id: '6000', key: issueProjectKey, name: `업무 계획 ${token}` }, summary,
      created: date, updated: date, status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
      description: { type: 'doc', version: 1, content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `원래 업무 설명 ${number}` }] },
        { type: 'paragraph', content: [{ type: 'text', text: `이관 후 비교할 업무 내용 ${token} ${number}` }] },
      ] },
    } };
  });
  const checkedIssue = issues[11];
  const assetRequests: string[] = [];
  await page.route(url => url.hostname === originalHost || /^\/api\/attachments\/[^/]+\/content$/u.test(url.pathname), async route => {
    assetRequests.push(route.request().url());
    await route.abort();
  });
  const staged: LegacyPackageSummary[] = [];
  const workspace = () => request.get('/api/workspace').then(response => readJson<WorkspaceSnapshot>(response));
  const belongsToFixture = (title: string) => title === wikiTitle || issues.some(issue => issue.fields.summary === title);

  try {
    const jira = await upload(request, jiraFilename, `content-jira-${token}`, Buffer.from(JSON.stringify({ issues })));
    staged.push(jira);
    const wiki = await upload(request, wikiFilename, `content-wiki-${token}`,
      zip([
        { path: 'entities.xml', bytes: Buffer.from(wikiXml) },
        { path: `attachments/${originalPageId}/${attachmentId}/1`,
          bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0skAAAAASUVORK5CYII=', 'base64') },
      ]));
    staged.push(wiki);
    const previous = await workspace();
    await page.goto(`/#/${previous.projects[0].id}/settings?section=migration`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    for (const source of staged) await settings.getByLabel(`이관 패키지 ${source.filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await expect(settings.getByLabel('이관 원본 시간대', { exact: true })).toBeVisible();
    const previewing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/migrations/preview' &&
      response.request().method() === 'POST');
    await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
    const plan = await readJson<MigrationPreview>(await previewing, 201);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts).toMatchObject({ issues: 12, documents: 1 });
    const previewPath = `/api/migrations/previews/${plan.id}`;
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const list = review.getByRole('region', { name: '변환된 업무·문서', exact: true });
    const resultButton = (title: string) => list.getByRole('button', { name: `변환 결과 보기 ${title}`, exact: true });
    const nextRead = (suffix: string) => page.waitForResponse(response =>
      new URL(response.url()).pathname === `${previewPath}/content${suffix}` && response.request().method() === 'GET');

    const firstRead = nextRead('');
    await review.locator('summary').filter({ hasText: /^변환된 업무·문서$/u }).click();
    const first = await readJson<MigrationContentReviewPage>(await firstRead);
    expect(first).toMatchObject({ previewId: plan.id, version: plan.version, total: 13, offset: 0, limit: 12 });
    expect(first.rows).toHaveLength(12);
    expect(first.rows.every(row => row.targetType === 'issue' && row.packageId === jira.id)).toBe(true);
    await expect(resultButton(wikiTitle)).toHaveCount(0);

    const secondRead = nextRead('');
    await list.getByRole('button', { name: '다음', exact: true }).click();
    const second = await readJson<MigrationContentReviewPage>(await secondRead);
    expect(second).toMatchObject({ total: 13, offset: 12, rows: [
      { packageId: wiki.id, sourceId: originalPageId, title: wikiTitle, targetType: 'document', change: 'new' },
    ] });
    expect(second.rows).toHaveLength(1);
    const opener = resultButton(wikiTitle);
    const documentRead = nextRead('/detail');
    await opener.click();
    const documentResponse = await documentRead;
    expect(new URL(documentResponse.url()).searchParams.get('recordId')).toBe(second.rows[0].recordId);
    const documentResult = await readJson<MigrationContentReviewDetail>(documentResponse);
    expect(documentResult).toMatchObject({ ...second.rows[0] });
    const dialog = page.getByRole('dialog', { name: `변환 결과 · ${wikiTitle}`, exact: true });
    await expect(dialog.getByRole('heading', { name: section, exact: true })).toBeVisible();
    await expect(dialog.getByRole('table').getByRole('row')).toHaveCount(2);
    await expect(dialog.getByRole('cell', { name: '통과', exact: true })).toBeVisible();
    await expect(dialog.getByText(task, { exact: true })).toBeVisible();
    const completedTask = dialog.getByRole('checkbox', { name: '완료된 할 일', exact: true });
    await expect(completedTask).toBeChecked();
    await expect(completedTask).toBeDisabled();
    await expect(dialog.getByText('외부 지침', { exact: true })).toBeVisible();
    await expect(dialog.getByText(`이미지 · ${imageTitle}`, { exact: true })).toBeVisible();
    await expect(dialog.locator('a[href], img[src]')).toHaveCount(0);
    expect(assetRequests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await dialog.getByRole('button', { name: '원본 보기', exact: true }).click();
    const sourceDetail = dialog.getByRole('region', { name: '원본 객체 상세', exact: true });
    await expect(dialog).toContainText(wikiFilename);
    await expect(sourceDetail).toContainText(originalPageId);
    await expect(sourceDetail.getByLabel('원본 본문', { exact: true })).toHaveText(wikiBody);
    await expect(sourceDetail).not.toContainText(issues[0].fields.summary);
    await dialog.getByRole('button', { name: '변환 결과 보기', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: section, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    const backToFirst = nextRead('');
    await list.getByRole('button', { name: '이전', exact: true }).click();
    expect(await readJson<MigrationContentReviewPage>(await backToFirst)).toMatchObject({ offset: 0 });
    const filteredRead = nextRead('');
    await list.getByRole('combobox', { name: '원본 패키지', exact: true }).selectOption(jira.id);
    expect(await readJson<MigrationContentReviewPage>(await filteredRead)).toMatchObject({ offset: 0, total: 12 });
    const search = list.getByRole('textbox', { name: '업무·문서 검색', exact: true });
    await search.fill(checkedIssue.fields.summary);
    const searchRead = nextRead('');
    await list.getByRole('button', { name: '검색', exact: true }).click();
    const matched = await readJson<MigrationContentReviewPage>(await searchRead);
    expect(matched).toMatchObject({ offset: 0, total: 1, rows: [
      { packageId: jira.id, sourceId: checkedIssue.id, targetType: 'issue', title: checkedIssue.fields.summary },
    ] });
    const issueRead = nextRead('/detail');
    await resultButton(checkedIssue.fields.summary).click();
    const issueResponse = await issueRead;
    expect(new URL(issueResponse.url()).searchParams.get('recordId')).toBe(matched.rows[0].recordId);
    const issueResult = await readJson<MigrationContentReviewDetail>(issueResponse);
    const issueDialog = page.getByRole('dialog', { name: `변환 결과 · ${checkedIssue.fields.summary}`, exact: true });
    await expect(issueDialog).toContainText(`이관 후 비교할 업무 내용 ${token} 12`);
    await issueDialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(resultButton(checkedIssue.fields.summary)).toBeFocused();
    expect(assetRequests).toEqual([]);

    const beforeApply = await workspace();
    expect(beforeApply.issues.filter(issue => belongsToFixture(issue.title))).toEqual([]);
    expect(beforeApply.documents.filter(document => belongsToFixture(document.title))).toEqual([]);
    expect(beforeApply.projects.filter(project => [issueProjectKey, documentProjectKey].includes(project.key))).toEqual([]);

    for (const code of plan.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = page.waitForResponse(response => new URL(response.url()).pathname === `${previewPath}/apply` &&
      response.request().method() === 'POST');
    page.once('dialog', confirmation => confirmation.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const result = await readJson<MigrationApplyResult>(await applying, 201);
    const saved = await workspace();
    const savedIssue = saved.issues.find(issue => issue.title === checkedIssue.fields.summary);
    const savedDocument = saved.documents.find(document => document.title === wikiTitle);
    if (!savedIssue || !savedDocument || !savedDocument.projectId) throw new Error('이관한 업무와 문서를 찾을 수 없습니다.');
    expect(result.import.projectIds).toEqual(expect.arrayContaining([savedIssue.projectId, savedDocument.projectId]));
    expect(saved.issues.filter(issue => belongsToFixture(issue.title))).toHaveLength(12);
    expect(savedIssue).toMatchObject({ description: issueResult.description, descriptionFormat: issueResult.descriptionFormat });
    expect(savedDocument.content).toEqual(documentResult.content);
  } finally {
    const saved = await workspace();
    const paths = [
      ...saved.issues.filter(issue => belongsToFixture(issue.title)).map(issue => `/api/issues/${issue.id}`),
      ...saved.documents.filter(document => belongsToFixture(document.title)).map(document => `/api/documents/${document.id}`),
    ];
    for (const path of paths) {
      const { trashEntryId } = await readJson<{ trashEntryId: string }>(await request.delete(path));
      await readJson(await request.delete(`/api/trash/${trashEntryId}`));
    }
    for (const source of staged) {
      const removed = await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
      expect(removed.ok(), await removed.text()).toBe(true);
    }
  }
});
