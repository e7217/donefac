import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Response } from '@playwright/test';
import type { MigratedConfluenceDocumentTarget } from '../../shared/confluence-migration-address';
import { documentSectionHash } from '../../shared/document-sections';
import type { Issue, LegacyPackageSummary, MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

type StagedSource = { pack: LegacyPackageSummary; base: string };
const lookupPath = '/api/atlassian-links/resolve-migrated-document';

async function readJson<T>(response: APIResponse | Response, expected = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json() as Promise<T>;
}

async function importBatch(request: APIRequestContext, sources: readonly StagedSource[]) {
  const params = new URLSearchParams(sources.map(({ pack }) => ['packageId', pack.id]));
  const { defaultConfiguration } = await readJson<MigrationOptions>(await request.get(`/api/migrations/options?${params}`));
  const configuration = {
    ...defaultConfiguration,
    sourceBaseUrls: Object.fromEntries(sources.map(({ pack, base }) => [pack.id, base])),
  };
  const plan = await readJson<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
  expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
  const result = await request.post(`/api/migrations/previews/${plan.id}/apply`, {
    data: { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements },
  });
  expect(result.status(), await result.text()).toBe(201);
}

test('360px 별도로 이관한 Jira 업무에서 정확한 Confluence 문서·절을 열고 원본 링크를 유지한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = randomUUID().slice(0, 7).toUpperCase();
  const oldHost = 'wiki.example.test';
  const homeBase = `https://${oldHost}/team-${token}/wiki`, peerBase = `https://${oldHost}/ops-${token}/wiki`;
  const jiraBase = `https://jira.example.test/${token}/tracker`;
  const date = '2020-01-02T00:00:00Z', sourcePageId = '200';
  const homeTitle = `팀 운영 안내 ${token}`, peerTitle = `배포 운영 기준 ${token}`;
  const earlyTitle = `먼저 이관한 Jira 업무 ${token}`, lateTitle = `나중에 이관한 Jira 업무 ${token}`;
  const heading = '배포 전 검토', sectionBody = '운영 프로젝트의 저장된 배포 점검 절차입니다.';
  const pageUrl = (base: string) => `${base}/pages/viewpage.action?pageId=${sourcePageId}`;
  const homeHref = pageUrl(homeBase), peerHref = pageUrl(peerBase);
  const compact = (text: string) => text.replaceAll(' ', '');
  const sectionHref = `${peerHref}#${encodeURIComponent(`${compact(peerTitle)}-${compact(heading)}`)}`;
  const missingSectionHref = `${peerHref}#missing-section`;
  const missingPageHref = `${peerBase}/pages/viewpage.action?pageId=999`;
  const wrongContextHref = pageUrl(`https://${oldHost}/unknown-${token}/wiki`);
  const commentHref = `${peerHref}&focusedCommentId=77#comment-77`, versionHref = `${peerHref}&pageVersion=1`;
  const links = {
    '팀 운영 문서': homeHref, '배포 절 열기': sectionHref, '없는 배포 절': missingSectionHref,
    '없는 운영 페이지': missingPageHref, '다른 설치의 페이지': wrongContextHref,
    '원본 댓글': commentHref, '원본 페이지 버전': versionHref,
  };
  type LinkName = keyof typeof links;
  const jira = (key: string, id: string, projectId: string, title: string) => Buffer.from(JSON.stringify({ issues: [{
    id, key: `${key}-1`, self: `${jiraBase}/rest/api/2/issue/${id}`,
    fields: {
      project: { id: projectId, key, name: title }, summary: title, created: date, updated: date,
      status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
      description: { type: 'doc', version: 1, content: Object.entries(links).map(([text, href]) => ({
        type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
      })) },
    },
  }] }));
  const wiki = (spaceKey: string, title: string, body: string) => zip([{
    path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">${spaceKey}</property></object>
      <object class="Page"><id name="id">${sourcePageId}</id><property name="title">${title}</property><property name="version">1</property>
        <property name="space" class="Space"><id name="id">42</id></property>
        <property name="creationDate">${date}</property><property name="lastModificationDate">${date}</property></object>
      <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[${body}]]></property>
        <property name="content" class="Page"><id name="id">${sourcePageId}</id></property><property name="bodyType">2</property></object>
    </hibernate-generic>`),
  }]);
  const staged: StagedSource[] = [];
  async function stage(filename: string, instanceKey: string, base: string, data: Buffer) {
    const pack = await readJson<LegacyPackageSummary>(await request.post(
      `/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey })}`,
      { headers: { 'Content-Type': 'application/octet-stream' }, data },
    ), 201);
    const source = { pack, base };
    staged.push(source);
    return source;
  }
  const snapshot = async () => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const lookups: string[] = [];
  const external: string[] = [];
  page.on('request', req => {
    const url = new URL(req.url());
    const source = url.searchParams.get('url');
    if (req.method() === 'GET' && url.pathname === lookupPath && source) lookups.push(source);
  });
  await page.context().route(url => url.hostname === oldHost, route => {
    external.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html',
      body: '<title>합성 Confluence 원본</title><link rel="icon" href="data:,">' });
  });
  const findLookup = (name: LinkName) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === lookupPath && url.searchParams.get('url') === links[name];
  });
  const assertResponse = async (response: Response, target: MigratedConfluenceDocumentTarget | null) =>
    expect(await readJson<{ target: MigratedConfluenceDocumentTarget | null }>(response)).toEqual({ target });
  const issueHash = (issue: Issue) => `#/${issue.projectId}/issues?issue=${issue.id}`;
  const ticket = (issue: Issue) => page.getByRole('dialog', { name: issue.title, exact: true });
  const body = (issue: Issue) => ticket(issue).getByRole('region', { name: '설명 미리보기', exact: true });
  const link = (issue: Issue, name: LinkName) => body(issue).getByRole('link', { name, exact: true });
  async function openTicket(issue: Issue) {
    await page.goto(`/${issueHash(issue)}`);
    await expect(body(issue)).toBeVisible({ timeout: 30_000 });
  }
  async function expectOriginalPopup(anchor: Locator, href: string) {
    const before = external.length;
    const opened = page.waitForEvent('popup');
    await anchor.click();
    const popup = await opened;
    try {
      await expect(popup).toHaveURL(href);
      const requested = new URL(href);
      requested.hash = '';
      expect(external.slice(before)).toEqual([requested.href]);
    } finally {
      await popup.close();
    }
  }

  try {
    const early = await stage(`jira-early-${token}.json`, `jira-${token}`, jiraBase, jira(`SE${token}`, '100', '10', earlyTitle));
    await importBatch(request, [early]);
    const earlyIssue = (await snapshot()).issues.find(issue => issue.title === earlyTitle);
    if (!earlyIssue) throw new Error('먼저 이관한 업무를 찾을 수 없습니다.');
    expect(earlyIssue.description).toContain(homeHref);
    expect(earlyIssue.description).toContain(sectionHref);

    const homeSource = await stage(`wiki-team-${token}.zip`, `wiki-team-${token}`, homeBase,
      wiki(`HT${token}`, homeTitle, '<p>팀 프로젝트의 저장된 운영 절차입니다.</p>'));
    const intro = '<p>배포를 시작하기 전 운영 기록을 확인합니다.</p>'.repeat(24);
    const peerSource = await stage(`wiki-ops-${token}.zip`, `wiki-ops-${token}`, peerBase,
      wiki(`PT${token}`, peerTitle, `${intro}<h2>${heading}</h2><p>${sectionBody}</p>`));
    await importBatch(request, [homeSource, peerSource]);
    const documents = (await snapshot()).documents;
    const home = documents.find(document => document.title === homeTitle);
    const peer = documents.find(document => document.title === peerTitle);
    const sectionId = peer?.content.content?.find(node => node.type === 'heading')?.attrs?.sectionId;
    if (!home?.projectId || !peer?.projectId || typeof sectionId !== 'string' || home.id === peer.id) {
      throw new Error('두 설치의 이관 문서와 절을 찾을 수 없습니다.');
    }

    const late = await stage(`jira-late-${token}.json`, `jira-${token}`, jiraBase, jira(`SL${token}`, '101', '11', lateTitle));
    await importBatch(request, [late]);
    const imported = (await snapshot()).issues;
    const lateIssue = imported.find(issue => issue.title === lateTitle);
    if (!lateIssue) throw new Error('나중에 이관한 업무를 찾을 수 없습니다.');
    expect(imported.find(issue => issue.id === earlyIssue.id)).toMatchObject({
      version: earlyIssue.version, description: earlyIssue.description,
    });
    expect(lateIssue.description).toBe(earlyIssue.description);
    const homeHash = `#/${home.projectId}/documents/${home.id}`;
    const sectionHash = documentSectionHash(peer.id, sectionId, peer.projectId);

    await openTicket(earlyIssue);
    for (const name of Object.keys(links) as LinkName[]) await expect(link(earlyIssue, name)).toHaveAttribute('href', links[name]);
    const title = ticket(earlyIssue).getByRole('textbox', { name: '제목', exact: true });
    await title.fill('저장하지 않은 업무 제목');
    const resolvingDirty = findLookup('팀 운영 문서');
    const confirming = page.waitForEvent('dialog');
    const activation = link(earlyIssue, '팀 운영 문서').click();
    const confirmation = await confirming;
    expect(confirmation.type()).toBe('confirm');
    await confirmation.dismiss();
    await activation;
    await assertResponse(await resolvingDirty, { documentId: home.id });
    await expect(page).toHaveURL(url => url.hash === issueHash(earlyIssue));
    await expect(title).toHaveValue('저장하지 않은 업무 제목');
    await title.fill(earlyIssue.title);

    for (const issue of [earlyIssue, lateIssue]) {
      if (issue.id !== earlyIssue.id) await openTicket(issue);
      const resolvingPage = findLookup('팀 운영 문서');
      await link(issue, '팀 운영 문서').click();
      await assertResponse(await resolvingPage, { documentId: home.id });
      await expect(page).toHaveURL(url => url.hash === homeHash);
      await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(homeTitle);
      await page.goBack();
      await expect(page).toHaveURL(url => url.hash === issueHash(issue));
      await expect(ticket(issue)).toBeVisible();

      const resolvingSection = findLookup('배포 절 열기');
      await link(issue, '배포 절 열기').press('Enter');
      await assertResponse(await resolvingSection, { documentId: peer.id, sectionId });
      await expect(page).toHaveURL(url => url.hash === sectionHash);
      await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(peerTitle);
      const section = page.locator('.docs-prose').getByRole('heading', { name: heading, exact: true });
      await expect(section).toHaveAttribute('data-document-section-id', sectionId);
      await expect(section).toBeFocused();
      await expect(section).toBeInViewport();
      await expect(page.locator('.docs-prose')).toContainText(sectionBody);
      await page.goBack();
      await expect(page).toHaveURL(url => url.hash === issueHash(issue));
      await expect(ticket(issue)).toBeVisible();
    }
    expect(external).toEqual([]);
    expect(page.context().pages()).toEqual([page]);

    const fallback = body(lateIssue).getByRole('link', { name: '원본 열기', exact: true });
    for (const name of ['없는 배포 절', '없는 운영 페이지'] as const) {
      const unresolved = findLookup(name);
      await link(lateIssue, name).click();
      await assertResponse(await unresolved, null);
      await expect(body(lateIssue).getByRole('status')).toContainText('이관된 문서를 확인할 수 없습니다.');
      await expect(fallback).toHaveAttribute('href', links[name]);
      await expect(fallback).toHaveAttribute('target', '_blank');
      await expect(page).toHaveURL(url => url.hash === issueHash(lateIssue));
      expect(page.context().pages()).toEqual([page]);
      expect(external).toEqual([]);
    }
    await expectOriginalPopup(fallback, missingPageHref);

    const lookupsBeforeDirectLinks = [...lookups];
    for (const name of ['다른 설치의 페이지', '원본 댓글', '원본 페이지 버전'] as const) {
      await expect(link(lateIssue, name)).toHaveAttribute('href', links[name]);
      await expect(link(lateIssue, name)).toHaveAttribute('target', '_blank');
      await expectOriginalPopup(link(lateIssue, name), links[name]);
    }
    expect(lookups).toEqual(lookupsBeforeDirectLinks);
    expect(page.context().pages()).toEqual([page]);
    await expect(page).toHaveURL(url => url.hash === issueHash(lateIssue));
    const saved = (await snapshot()).issues;
    for (const issue of [earlyIssue, lateIssue]) {
      expect(saved.find(current => current.id === issue.id)).toMatchObject({
        version: issue.version, description: issue.description, descriptionFormat: issue.descriptionFormat,
      });
    }
  } finally {
    const current = await snapshot();
    const resources = [
      ...current.issues.filter(issue => issue.title === earlyTitle || issue.title === lateTitle).map(issue => `/api/issues/${issue.id}`),
      ...current.documents.filter(doc => doc.title === homeTitle || doc.title === peerTitle).map(doc => `/api/documents/${doc.id}`),
    ];
    for (const resource of resources) {
      const { trashEntryId } = await readJson<{ trashEntryId: string }>(await request.delete(resource));
      await readJson(await request.delete(`/api/trash/${trashEntryId}`));
    }
    for (const { pack } of staged) {
      const removed = await request.delete(`/api/legacy-import/packages/${pack.id}?expectedVersion=${pack.version}`);
      expect(removed.ok(), await removed.text()).toBe(true);
    }
  }
});
