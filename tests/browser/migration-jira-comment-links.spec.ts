import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type {
  Comment, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

test('360px에서 Jira 댓글의 링크를 이관하고 댓글 수정과 백업 복원 뒤 다시 연다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const originalKey = `JC${suffix}`;
  const title = `링크가 있는 Jira 댓글 업무 ${suffix}`;
  const sourceBase = 'https://jira.example.test/company';
  const sourceUrl = `${sourceBase}/browse/${originalKey}-1`;
  const adfUrl = 'https://wiki.example.test/reviews/design?state=ready,';
  const wikiUrl = 'https://wiki.example.test/guides/assembly';
  const nativeUrl = 'https://wiki.example.test/team/notes';
  const adfLabel = '설계 확인 자료';
  const wikiLabel = '조립 안내';
  const unsafeUrl = 'https://test-user:synthetic-token@wiki.example.test/private';
  const inactiveUrl = 'javascript:void(0)';
  const adf = (...links: Array<[label: string, url: string]>) => ({ type: 'doc', version: 1, content: [{
    type: 'paragraph', content: links.map(([text, href]) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })),
  }] });
  const initial = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const [actor, teammate] = initial.users;
  expect(actor).toBeDefined();
  expect(teammate).toBeDefined();
  const mention = `@${teammate.name}`;
  const overlapUrl = `https://wiki.example.test/people/${mention}/today`;
  const nativeText = `작업 중에 ${nativeUrl}. ${overlapUrl} <strong>주소를 기록했습니다.</strong>`;
  const from = nativeText.indexOf(mention);
  const mentions = [{ userId: teammate.id, from, to: from + mention.length }];
  const headers = { 'X-Actor-Id': actor.id };
  const author = { name: `comment-editor-${suffix}`, displayName: `이전 작성자 ${suffix}` };
  const sourceComments = [
    { id: '701', body: adf([adfLabel, adfUrl]) },
    { id: '702', body: `[${wikiLabel}|${wikiUrl}]` },
    { id: '703', body: adf(['인증 정보가 포함된 주소', unsafeUrl], ['스크립트 주소', inactiveUrl]) },
    { id: '704', body: adf([nativeUrl, nativeUrl]) },
  ];
  const jira = { issues: [{
    id: '1200', key: `${originalKey}-1`, self: `${sourceBase}/rest/api/2/issue/1200`, fields: {
      project: { id: '4020', key: originalKey, name: `Jira 댓글 원본 ${suffix}` }, summary: title,
      created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      comment: { comments: sourceComments.map(comment => ({ ...comment, author, created: '2020-01-02T00:00:00Z' })) },
    },
  }] };
  const query = new URLSearchParams({ filename: `jira-comment-links-${suffix}.json`, product: 'jira', instanceKey: `comment-links-${suffix}` });
  const source = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify(jira)),
  }), 201);
  let issueId: string | undefined;

  try {
    const { defaultConfiguration, identities } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
    const originAuthor = identities.find(identity => identity.sourceValue === author.name);
    if (!originAuthor) throw new Error('The synthetic Jira comment author was not staged.');
    const configuration = { ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(project => ({ ...project, key: `TC${suffix}` })),
      users: { ...defaultConfiguration.users, [originAuthor.id]: actor.id },
      sourceBaseUrls: { ...defaultConfiguration.sourceBaseUrls, [source.id]: sourceBase },
    };
    const preview = await json<MigrationPreview>(await request.post('/api/migrations/preview', { headers, data: { configuration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    expect(preview.counts.comments).toBe(sourceComments.length);
    const { import: receipt } = await json<MigrationApplyResult>(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      headers, data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const issue = workspace.issues.find(issue => issue.projectId === receipt.projectIds[0] && issue.title === title);
    if (!issue) throw new Error('The Jira comment target issue was not imported.');
    issueId = issue.id;
    const comments = await json<Comment[]>(await request.get('/api/comments', { params: { resourceType: 'issue', resourceId: issue.id } }));
    const imported = comments.find(comment => comment.body === `${adfLabel} <${adfUrl}>`);
    const wiki = comments.find(comment => comment.body === `${wikiLabel} <${wikiUrl}>`);
    const unsafe = comments.find(comment => comment.body.includes('인증 정보가 포함된 주소'));
    const unlabelled = comments.find(comment => comment.body === `<${nativeUrl}>`);
    if (!imported || !wiki || !unsafe || !unlabelled) throw new Error('The imported comments did not retain the expected link representation.');
    const native = await json<Comment>(await request.post('/api/comments', { headers, data: {
      resourceType: 'issue', resourceId: issue.id, body: nativeText, mentions,
    } }), 201);
    expect(native.mentions).toEqual(mentions);

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const article = (comment: Comment) => panel.locator(`#issue-comment-${comment.id}`);
    const link = (comment: Comment, url: string) => article(comment).getByRole('link', { name: url, exact: true });
    const sourceLink = panel.getByRole('region', { name: '기존 도구 연결', exact: true }).getByRole('link', { name: '원본 열기', exact: true });
    async function expectNativeComment() {
      await expect(link(native, nativeUrl)).toHaveAttribute('href', nativeUrl);
      await expect(article(native).getByRole('link')).toHaveCount(1);
      await expect(article(native)).toContainText(overlapUrl);
      await expect(article(native).locator('.comment-mention-text')).toHaveText(mention);
      await expect(article(native)).toContainText('<strong>주소를 기록했습니다.</strong>');
    }
    await expect(article(imported)).toBeVisible({ timeout: 30_000 });
    await expect(link(imported, adfUrl)).toHaveAttribute('href', adfUrl);
    await expect(article(imported)).toContainText(adfLabel);
    await expect(link(wiki, wikiUrl)).toHaveAttribute('href', wikiUrl);
    await expect(article(unsafe)).toContainText('스크립트 주소');
    await expect(article(unsafe).getByRole('link')).toHaveCount(0);
    await expect(link(unlabelled, nativeUrl)).toHaveAttribute('href', nativeUrl);
    await expectNativeComment();
    await expect(sourceLink).toHaveAttribute('href', sourceUrl);

    const draft = `확인했습니다. ${imported.body}를 검토에 사용합니다.`;
    await article(imported).getByRole('button', { name: '댓글 수정', exact: true }).click();
    const edit = article(imported).getByRole('form', { name: '댓글 수정', exact: true });
    const body = edit.getByRole('textbox', { name: '수정할 댓글', exact: true });
    await expect(body).toHaveValue(imported.body);
    await body.fill(draft);
    await edit.getByRole('button', { name: '수정 저장', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(article(imported)).toContainText('를 검토에 사용합니다.');
    await expect(link(imported, adfUrl)).toHaveAttribute('href', adfUrl);

    const backup = await json<WorkspaceSnapshot & { comments: Comment[]; sourceRecords: SourceRecordArchive[] }>(await request.get('/api/export'));
    expect(backup.comments.find(comment => comment.id === imported.id)).toMatchObject({ body: draft, editVersion: 1 });
    const original = backup.sourceRecords.find(row => row.sourceImportId === receipt.id && row.targetType === 'comment' && row.targetId === imported.id);
    expect(original?.record).toMatchObject({ sourceId: '701', textFormat: 'adf' });
    expect(JSON.parse(original!.record.text)).toEqual(sourceComments[0].body);
    await json(await request.post('/api/import', { headers, data: { confirm: 'REPLACE', data: backup } }));
    await page.reload();
    await expect(article(imported)).toBeVisible();
    await expect(article(imported)).toContainText('를 검토에 사용합니다.');
    await expect(link(imported, adfUrl)).toHaveAttribute('href', adfUrl);
    await expect(link(wiki, wikiUrl)).toHaveAttribute('href', wikiUrl);
    await expect(article(unsafe).getByRole('link')).toHaveCount(0);
    await expectNativeComment();
    await expect(sourceLink).toHaveAttribute('href', sourceUrl);
    await page.context().route(url => url.hostname === 'wiki.example.test', route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: '<h1>합성 설계 자료</h1>',
    }));
    const [opened] = await Promise.all([page.context().waitForEvent('page'), link(imported, adfUrl).click()]);
    await expect(opened).toHaveURL(adfUrl);
    await expect(opened.getByRole('heading', { name: '합성 설계 자료' })).toBeVisible();
    expect(await opened.evaluate(() => window.opener === null)).toBe(true);
    await opened.close();
  } finally {
    if (issueId) {
      const removed = await request.delete(`/api/issues/${issueId}`, { headers });
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`, { headers });
    }
    await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`, { headers });
  }
});
