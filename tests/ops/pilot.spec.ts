import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test as base, expect, type APIRequestContext, type Page, type Request, type Response } from '@playwright/test';
import type { Attachment, DocPage, Issue, Project, RichContent, WorkspaceSnapshot } from '../../shared/types';

interface PilotFixture {
  requests: APIRequestContext;
  project: Project;
  issue: Issue;
  document: DocPage;
  actors: string[];
  text: string;
}
const paragraph = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const test = base.extend<{ pilot: PilotFixture }>({
  pilot: [async ({ playwright, baseURL }, provide) => {
    // This spec is intentionally unusable against an unspecified/live host.
    expect(process.env.TEAMSPACE_PILOT_TEST_URL, 'Run through the isolated pilot harness').toBeTruthy();
    expect(baseURL).toBeTruthy();
    const address = new URL(baseURL!);
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(address.hostname);
    expect(address.origin).toBe(new URL(process.env.TEAMSPACE_PILOT_TEST_URL!).origin);
    expect(address.username + address.password).toBe('');
    const requests = await playwright.request.newContext({ baseURL });
    let project: Project | undefined;
    try {
      const health = await requests.get('/api/health');
      expect(health.status()).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, storage: 'sqlite' });
      const snapshot = await requests.get('/api/workspace');
      expect(snapshot.status()).toBe(200);
      const initial = await snapshot.json() as WorkspaceSnapshot;
      expect(initial.users.length).toBeGreaterThan(1);
      const actors = initial.users.slice(0, 2).map(user => user.id);
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
      const projectResponse = await requests.post('/api/projects', { data: { key: `OP${suffix}`, name: `운영 스모크 ${suffix}` } });
      expect(projectResponse.status()).toBe(201);
      project = await projectResponse.json() as Project;
      const issueResponse = await requests.post('/api/issues', {
        data: { projectId: project.id, title: `운영 검증 업무 ${suffix}`, startDate: day(0), endDate: day(3) },
      });
      expect(issueResponse.status()).toBe(201);
      const issue = await issueResponse.json() as Issue;
      const text = `운영용 정적 화면과 Node API를 확인하는 합성 원문 ${suffix}`;
      const documentResponse = await requests.post('/api/documents', {
        data: { projectId: project.id, title: `운영 검증 문서 ${suffix}`, content: paragraph(text) },
      });
      expect(documentResponse.status()).toBe(201);
      const document = await documentResponse.json() as DocPage;
      await provide({ requests, project, issue, document, actors, text });
    } finally {
      try {
        if (project) {
          const response = await requests.get('/api/workspace', { timeout: 5000 });
          if (response.ok()) {
            const current = await response.json() as WorkspaceSnapshot;
            for (const doc of current.documents.filter(item => item.projectId === project!.id)) {
              const deleted = await requests.delete(`/api/documents/${doc.id}?expectedVersion=${doc.version}`, { timeout: 5000 });
              expect([200, 404]).toContain(deleted.status());
            }
            for (const issue of current.issues.filter(item => item.projectId === project!.id)) {
              const deleted = await requests.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`, { timeout: 5000 });
              expect([200, 404]).toContain(deleted.status());
            }
          }
        }
        // The CLI owns the temporary database, including projects without a DELETE API.
      } finally { await requests.dispose(); }
    }
  }, { timeout: 30000 }],
});

function runtimeEvidence(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const failures: string[] = [], scripts = new Set<string>(), sockets: string[] = [];
  const required = new Set(['script', 'fetch', 'xhr', 'document']);
  const request = (value: Request) => {
    if (!required.has(value.resourceType()) || !/^https?:/.test(value.url())) return;
    const url = new URL(value.url());
    if (url.origin !== origin) failures.push(`External runtime request: ${value.url()}`);
    if (/^\/(?:_next|_vinext|__vinext|@vite|@react-refresh|__auth|__sites|cdn-cgi)(?:\/|$)/.test(url.pathname)) failures.push(`Legacy runtime request: ${url.pathname}`);
    if (value.resourceType() === 'script') scripts.add(url.pathname);
  };
  const response = (value: Response) => {
    if (required.has(value.request().resourceType()) && value.status() >= 500) failures.push(`HTTP ${value.status()}: ${value.url()}`);
  };
  const pageError = (error: Error) => failures.push(error.message);
  page.on('request', request);
  page.on('response', response);
  page.on('pageerror', pageError);
  page.on('websocket', socket => sockets.push(socket.url()));
  return {
    sockets,
    check() {
      expect(failures).toEqual([]);
      expect([...scripts].some(path => /^\/assets\/.+\.js$/.test(path))).toBe(true);
      for (const value of sockets) {
        const url = new URL(value);
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        expect(url.origin).toBe(origin);
        expect(url.pathname).toBe('/api/collaboration');
      }
    },
  };
}
async function canonical(f: PilotFixture) {
  const response = await f.requests.get('/api/workspace');
  expect(response.status()).toBe(200);
  return (await response.json() as WorkspaceSnapshot).documents.find(doc => doc.id === f.document.id)!;
}
const hasImage = (node: RichContent, src: string): boolean =>
  node.type === 'image' && node.attrs?.src === src || Boolean(node.content?.some(child => hasImage(child, src)));

test('built same-origin pilot serves issue/Gantt, persists document edits and downloads exact attachment bytes', async ({ page, baseURL, pilot: f }) => {
  const evidence = runtimeEvidence(page, baseURL!);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '통합 검색', exact: true })).toBeVisible();
  await expect(page.locator('.local-status')).toContainText('파일럿 환경');
  await page.goto(`/#/${f.project.id}/issues?issue=${f.issue.id}`);
  const panel = page.getByRole('dialog', { name: f.issue.title, exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  await page.goto(`/#/${f.project.id}/gantt`);
  const row = page.locator(`.gantt-row[data-issue-id="${f.issue.id}"]`);
  await expect(row).toContainText(f.issue.title);
  await expect(row.getByLabel(`${f.issue.key} 시작일`, { exact: true })).toHaveValue(f.issue.startDate!);
  await page.goto(`/#/${f.project.id}/documents/${f.document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(f.document.title);
  const edited = `${f.text} · 브라우저 저장 완료`;
  await page.locator('.docs-prose').fill(edited);
  const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${f.document.id}`) && response.request().method() === 'PATCH');
  await page.locator('.docs-save-button').click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  expect((await canonical(f)).plainText).toBe(edited);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const filename = `${f.project.key}-synthetic.png`;
  await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
  const uploadResponse = page.waitForResponse(response => response.url().includes('/api/attachments?') && response.request().method() === 'POST');
  await page.getByLabel('첨부할 파일 선택', { exact: true }).setInputFiles({ name: filename, mimeType: 'image/png', buffer: png });
  const uploaded = await uploadResponse;
  expect(uploaded.status()).toBe(201);
  const attachment = await uploaded.json() as Attachment;
  expect(attachment).toMatchObject({ resourceType: 'document', resourceId: f.document.id, filename, mimeType: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') });
  const downloadedEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: `${filename} 다운로드`, exact: true }).click();
  const downloaded = await downloadedEvent;
  expect(downloaded.suggestedFilename()).toBe(filename);
  expect(await readFile((await downloaded.path())!)).toEqual(png);
  const inlinePath = `/api/attachments/${attachment.id}/content?inline=1`;
  const inline = await f.requests.get(inlinePath);
  expect(inline.status()).toBe(200);
  expect(inline.headers()['content-type']).toContain('image/png');
  expect(inline.headers()['x-content-type-options']).toBe('nosniff');
  expect(await inline.body()).toEqual(png);
  await page.getByRole('button', { name: '본문에 삽입', exact: true }).click();
  await page.locator('.docs-save-button').click();
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  await expect.poll(async () => hasImage((await canonical(f)).content, inlinePath)).toBe(true);
  await page.reload();
  await expect(page.locator('.docs-prose')).toContainText(edited);
  const image = page.locator('.docs-prose img');
  await expect(image).toHaveAttribute('src', inlinePath);
  await expect.poll(() => image.evaluate(value => (value as HTMLImageElement).naturalWidth)).toBe(1);
  const persisted = await f.requests.get(`/api/attachments/${attachment.id}/content`);
  expect(persisted.status()).toBe(200);
  expect(persisted.headers()['content-type']).toContain('application/octet-stream');
  expect(await persisted.body()).toEqual(png);
  evidence.check();
});

test('built pilot upgrades real WebSockets and persists edits from two browser actors through reload', async ({ browser, baseURL, pilot: f }) => {
  const contexts = await Promise.all(f.actors.map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  try {
    for (const [index, context] of contexts.entries()) await context.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), f.actors[index]);
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    const evidence = [runtimeEvidence(a, baseURL!), runtimeEvidence(b, baseURL!)];
    await Promise.all([a, b].map(page => page.goto(`/#/${f.project.id}/documents/${f.document.id}`)));
    await expect(a.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(f.document.title);
    await a.getByRole('button', { name: '공동 편집 시작', exact: true }).click();
    for (const page of [a, b]) {
      await expect(page.locator('.docs-live-prose')).toBeVisible();
      await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
      await expect(page.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    }
    await a.bringToFront();
    await a.locator('.docs-live-prose').focus();
    await a.keyboard.press('Control+End');
    const caret = b.locator(`.docs-remote-caret[data-actor-id="${f.actors[0]}"]`);
    await expect(caret).toHaveCount(1);
    await a.getByRole('textbox', { name:'문서 제목', exact:true }).focus();
    await expect(caret).toHaveCount(0);
    async function append(page: Page, value: string) {
      await page.locator('.docs-live-prose').click();
      await page.locator('.docs-live-prose').press('Control+End');
      await page.keyboard.insertText(value);
    }
    await Promise.all([append(a, ' alpha'), append(b, ' beta')]);
    for (const page of [a, b]) {
      await expect(page.locator('.docs-live-prose')).toContainText('alpha');
      await expect(page.locator('.docs-live-prose')).toContainText('beta');
      await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    }
    await expect.poll(async () => (await a.locator('.docs-live-prose').innerText()) === (await b.locator('.docs-live-prose').innerText())).toBe(true);
    const text = await a.locator('.docs-live-prose').innerText();
    expect(text.match(/alpha/g)).toHaveLength(1);
    expect(text.match(/beta/g)).toHaveLength(1);
    expect(text.split(f.text)).toHaveLength(2);
    await expect.poll(async () => (await canonical(f)).plainText).toBe(text);
    await a.reload();
    await expect(a.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect(a.locator('.docs-live-prose')).toHaveText(text);
    for (const observed of evidence) {
      expect(observed.sockets.length).toBeGreaterThan(0);
      observed.check();
    }
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
