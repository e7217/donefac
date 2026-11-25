import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Dialog, type Locator, type Response } from '@playwright/test';
import { documentSectionHash } from '../../shared/document-sections';
import type { MigratedJiraTarget } from '../../shared/jira-migration-address';
import type { Comment, DocPage, DocRevision, LegacyPackageSummary, MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status(), text).toBe(status);
  return JSON.parse(text) as T;
}

test('360px에서 먼저 이관한 Confluence 문서에서 나중에 이관한 Jira 업무와 정확한 댓글을 연다', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = randomUUID().slice(0, 7).toUpperCase();
  const sourceHost = `jira-${token.toLowerCase()}.example.test`;
  const jiraBase = `https://${sourceHost}/jira`, issueKey = `JL${token}`, issueUrl = `${jiraBase}/browse/${issueKey}-1`;
  const title = `이관 업무 ${token}`, wikiTitle = `이관 문서 ${token}`, wrapperTitle = `포함 링크 문서 ${token}`;
  const firstComment = `첫 번째 댓글 ${token}`, exactComment = `지정한 댓글 ${token}`;
  const originalCommentAuthor = { name: `jira-author-${token}`, displayName: `원본 작성자 ${token}` };
  const date = '2020-01-02T00:00:00Z';
  const links = {
    '원래 Jira 업무': issueUrl,
    '지정한 Jira 댓글': `${issueUrl}?focusedId=702#comment-702`,
    '없는 Jira 댓글': `${issueUrl}?focusedCommentId=999#comment-999`,
    '다른 설치의 업무': `https://${sourceHost}/foreign/browse/${issueKey}-1`,
    '선택자가 충돌하는 원본': `${issueUrl}?focusedCommentId=701#comment-702`,
  };
  type LinkName = keyof typeof links;
  const snapshot = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { users: [actor] } = await snapshot();
  const headers = { 'X-Actor-Id': actor.id };
  const packages: LegacyPackageSummary[] = [];
  async function importSource(product: 'jira' | 'confluence', base: string, bytes: Buffer) {
    const query = new URLSearchParams({ filename: `${product}-${token}.${product === 'jira' ? 'json' : 'zip'}`,
      instanceKey: `${product}-wiki-jira-${token}`, product });
    const source = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: bytes,
    }), 201);
    packages.push(source);
    const { defaultConfiguration, identities } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
    const sourceAuthor = identities.find(identity => identity.sourceValue === originalCommentAuthor.name);
    if (product === 'jira') expect(sourceAuthor).toBeDefined();
    const configuration = { ...defaultConfiguration, sourceBaseUrls: { [source.id]: base },
      users: { ...defaultConfiguration.users, ...(sourceAuthor && { [sourceAuthor.id]: actor.id }) },
    };
    const preview = await json<MigrationPreview>(await request.post('/api/migrations/preview', { headers, data: { configuration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    await json(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      headers, data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
  }

  const lookups: string[] = [];
  const sourceRequests: string[] = [];
  const lookupPath = '/api/atlassian-links/resolve-migrated-jira-target';
  page.on('request', req => {
    const url = new URL(req.url());
    const target = url.searchParams.get('url');
    if (url.pathname === lookupPath && target) lookups.push(target);
  });
  await page.context().route(url => url.hostname === sourceHost, route => {
    sourceRequests.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<title>합성 Jira 원본</title><link rel="icon" href="data:,">' });
  });
  const lookup = (name: LinkName) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === lookupPath && url.searchParams.get('url') === links[name];
  });
  const result = (response: Response) => json<{ target: MigratedJiraTarget | null }>(response);
  const expectOriginalPopup = async (anchor: Locator, href: string) => {
    const count = sourceRequests.length;
    const opened = page.waitForEvent('popup');
    await anchor.click();
    const popup = await opened;
    try {
      await expect(popup).toHaveURL(href);
      const requested = new URL(href);
      requested.hash = '';
      expect(sourceRequests.slice(count)).toEqual([requested.href]);
    } finally {
      await popup.close();
    }
  };

  try {
    const wiki = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">WL${token}</property><property name="name">운영 위키</property></object>
      <object class="Page"><id name="id">200</id><property name="title">${wikiTitle}</property><property name="version">1</property>
        <property name="space" class="Space"><id name="id">42</id></property>
        <property name="creationDate">${date}</property><property name="lastModificationDate">${date}</property></object>
      <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<h2>운영 업무 근거</h2>
        ${Object.entries(links).map(([label, href]) => `<p><a href="${href}"><strong>${label}</strong></a></p>`).join('')}
        <p>위키의 저장 본문</p>]]></property><property name="content" class="Page"><id name="id">200</id></property>
        <property name="bodyType">2</property></object>
    </hibernate-generic>`) }]);
    await importSource('confluence', `https://wiki.example.test/${token}/confluence`, wiki);
    const original = (await snapshot()).documents.find(doc => doc.title === wikiTitle);
    const sectionId = original?.content.content?.find(node => node.type === 'heading')?.attrs?.sectionId;
    if (!original?.projectId || typeof sectionId !== 'string') throw new Error('이관 문서와 본문 절을 찾을 수 없습니다.');
    const sectionHash = documentSectionHash(original.id, sectionId, original.projectId);
    const editor = page.locator('.docs-editor-wrap .docs-prose');
    const link = (name: LinkName) => editor.getByRole('link', { name, exact: true });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/${sectionHash}`);
    for (const name of Object.keys(links) as LinkName[]) await expect(link(name)).toHaveAttribute('href', links[name]);
    await link('지정한 Jira 댓글').click();
    expect(lookups).toEqual([]);

    const jira = Buffer.from(JSON.stringify({ issues: [{ id: '1200', key: `${issueKey}-1`, self: `${jiraBase}/rest/api/2/issue/1200`, fields: {
      project: { id: '4020', key: issueKey, name: title }, summary: title, created: date, updated: date,
      status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' }, comment: { comments: [
        { id: '701', body: firstComment, author: originalCommentAuthor, created: date },
        { id: '702', body: exactComment, author: originalCommentAuthor, created: date },
      ] },
    } }] }));
    await importSource('jira', jiraBase, jira);
    const after = await snapshot();
    const issue = after.issues.find(candidate => candidate.title === title);
    if (!issue) throw new Error('나중에 이관한 Jira 업무를 찾을 수 없습니다.');
    expect(after.jiraMigrationOrigins).toContain(jiraBase);
    expect(after.documents.find(doc => doc.id === original.id)).toMatchObject({ version: original.version, content: original.content });
    const comments = await json<Comment[]>(await request.get('/api/comments', { headers, params: { resourceType: 'issue', resourceId: issue.id } }));
    const first = comments.find(comment => comment.body === firstComment), exact = comments.find(comment => comment.body === exactComment);
    if (!first || !exact) throw new Error('이관한 Jira 댓글을 찾을 수 없습니다.');
    const revisions = await json<DocRevision[]>(await request.get(`/api/documents/${original.id}/revisions`));
    const revisionId = revisions.find(revision => revision.version === original.version)?.id;
    if (!revisionId) throw new Error('이관 문서의 저장본을 찾을 수 없습니다.');
    const wrapper = await json<DocPage>(await request.post('/api/documents', { headers, data: {
      projectId: original.projectId, title: wrapperTitle, content: { type: 'doc', content: [
        { type: 'documentInclude', attrs: { documentId: original.id, label: wikiTitle } },
        { type: 'documentRevisionInclude', attrs: { documentId: original.id, revisionId, label: wikiTitle } },
      ] },
    } }), 201);

    await page.reload();
    const docTitle = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await docTitle.fill('미저장 위키 제목');
    await editor.getByText('위키의 저장 본문', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('과 미저장 문장');
    const openInfo = page.getByRole('button', { name: '정보 패널 열기', exact: true });
    const closeInfo = page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true });
    await openInfo.click();
    const draftComment = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await draftComment.fill('아직 저장하지 않은 문서 댓글');
    await closeInfo.click();
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const route = () => new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
    const sourceRequestCount = sourceRequests.length;

    const resolvingIssue = lookup('원래 Jira 업무');
    await link('원래 Jira 업무').click();
    expect(await result(await resolvingIssue)).toEqual({ target: { issueId: issue.id } });
    await expect(panel).toBeVisible();
    expect(route().get('section')).toBe(sectionId);
    expect(route().get('issue')).toBe(issue.id);
    expect(route().get('issueComment')).toBeNull();
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(link('원래 Jira 업무')).toBeFocused();

    const resolvingComment = lookup('지정한 Jira 댓글');
    await link('지정한 Jira 댓글').click();
    expect(await result(await resolvingComment)).toEqual({ target: { issueId: issue.id, commentId: exact.id } });
    await expect(panel.locator(`#issue-comment-${exact.id}`)).toBeFocused();
    await expect(panel.locator(`#issue-comment-${first.id}`)).toBeVisible();
    expect(route().get('section')).toBe(sectionId);
    expect(route().get('issueComment')).toBe(exact.id);
    expect(sourceRequests).toHaveLength(sourceRequestCount);
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === sectionHash);
    await expect(link('지정한 Jira 댓글')).toBeFocused();
    await expect(docTitle).toHaveValue('미저장 위키 제목');
    await expect(editor).toContainText('위키의 저장 본문과 미저장 문장');
    await openInfo.click();
    await expect(draftComment).toHaveValue('아직 저장하지 않은 문서 댓글');
    await closeInfo.click();

    const missing = lookup('없는 Jira 댓글');
    await link('없는 Jira 댓글').click();
    expect(await result(await missing)).toEqual({ target: null });
    const fallback = page.getByRole('status').filter({ hasText: '이관된 Jira 댓글을 확인할 수 없습니다.' }).getByRole('link', { name: '원본 열기' });
    await expect(fallback).toHaveAttribute('href', links['없는 Jira 댓글']);
    expect(sourceRequests).toHaveLength(sourceRequestCount);
    await expectOriginalPopup(fallback, links['없는 Jira 댓글']);
    const internalCount = lookups.length;
    await link('다른 설치의 업무').click();
    await link('선택자가 충돌하는 원본').click();
    await link('원래 Jira 업무').click({ modifiers: ['Control'] });
    expect(lookups).toHaveLength(internalCount);

    const wrapperHash = `#/${original.projectId}/documents/${wrapper.id}`;
    const keepDrafts = (dialog: Dialog) => { void dialog.accept(); };
    page.on('dialog', keepDrafts);
    try {
      await page.evaluate(hash => { location.hash = hash; }, wrapperHash);
      await expect(page).toHaveURL(url => url.hash === wrapperHash);
      await expect(docTitle).toHaveValue(wrapperTitle);
    } finally {
      page.off('dialog', keepDrafts);
    }
    const live = page.getByRole('region', { name: `포함된 문서 ${wikiTitle}`, exact: true });
    const liveLink = live.getByRole('link', { name: '지정한 Jira 댓글', exact: true });
    const included = lookup('지정한 Jira 댓글');
    await liveLink.press('Enter');
    expect(await result(await included)).toEqual({ target: { issueId: issue.id, commentId: exact.id } });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(liveLink).toBeFocused();
    await expect(liveLink).toHaveAttribute('href', links['지정한 Jira 댓글']);
    const background = page.context().waitForEvent('page');
    await liveLink.click({ modifiers: ['Control'] });
    await (await background).close();
    const pinned = page.getByRole('region', { name: `고정 포함 문서 ${wikiTitle}`, exact: true });
    await pinned.getByRole('button', { name: '고정 버전 내용 보기', exact: true }).click();
    await expectOriginalPopup(pinned.getByRole('link', { name: '원래 Jira 업무', exact: true }), links['원래 Jira 업무']);
    expect(lookups).toHaveLength(internalCount + 1);
  } finally {
    const saved = await snapshot();
    const resources = [
      ...saved.issues.filter(issue => issue.title === title).map(issue => `/api/issues/${issue.id}`),
      ...saved.documents.filter(doc => doc.title === wrapperTitle).map(doc => `/api/documents/${doc.id}`),
      ...saved.documents.filter(doc => doc.title === wikiTitle).map(doc => `/api/documents/${doc.id}`),
    ];
    for (const path of resources) {
      const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(path, { headers }));
      await json(await request.delete(`/api/trash/${trashEntryId}`, { headers }));
    }
    for (const source of packages) {
      const removed = await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`, { headers });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
  }
});
