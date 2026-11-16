import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { DocPage, Issue, Project, WorkspaceSnapshot } from '../../shared/types';

type NavigationFixture = {
  requests: APIRequestContext;
  workspace: WorkspaceSnapshot;
  projectA: Project;
  projectB: Project;
  issueA: Issue;
  issueB: Issue;
  document: DocPage;
  initialText: string;
};

const test = base.extend<{ syntheticNavigation: NavigationFixture }>({
  syntheticNavigation: [async ({ playwright, baseURL }, use, testInfo) => {
    const requests = await playwright.request.newContext({ baseURL });
    const prefix = `탐색 회귀 검증 ${randomUUID()}`;
    try {
      const response = await requests.get('/api/workspace', { timeout: 10_000 });
      expect(response.ok()).toBeTruthy();
      const workspace = await response.json() as WorkspaceSnapshot;
      expect(workspace.projects.length).toBeGreaterThanOrEqual(2);
      expect(workspace.users.length).toBeGreaterThanOrEqual(2);
      const [projectA, projectB] = workspace.projects;
      const createIssue = async (suffix: string) => {
        const created = await requests.post('/api/issues', { timeout: 10_000, data: { projectId: projectA.id, title: `${prefix} 업무 ${suffix}` } });
        expect(created.status()).toBe(201);
        return created.json() as Promise<Issue>;
      };
      const issueA = await createIssue('A');
      const issueB = await createIssue('B');
      const initialText = '서버에 저장된 탐색 회귀 검증용 합성 문서 원본입니다.';
      const created = await requests.post('/api/documents', { timeout: 10_000, data: { projectId: projectB.id, title: `${prefix} 문서`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: initialText }] }] } } });
      expect(created.status()).toBe(201);
      const document = await created.json() as DocPage;
      await use({ requests, workspace, projectA, projectB, issueA, issueB, document, initialText });
    } finally {
      try {
        // Independent requests survive browser teardown/timeouts. Prefix lookup
        // also catches a create whose response arrived after its test timed out.
        const response = await requests.get('/api/workspace', { timeout: 5_000 });
        const snapshot = response.ok() ? await response.json() as WorkspaceSnapshot : undefined;
        const failures: string[] = [];
        for (const [collection, values] of [['documents', snapshot?.documents], ['issues', snapshot?.issues]] as const) {
          for (const value of values?.filter(value => value.title.startsWith(prefix)) || []) {
            const result = await requests.delete(`/api/${collection}/${value.id}`, { timeout: 5_000 });
            if (!result.ok() && result.status() !== 404) failures.push(`${collection}/${value.id}: ${result.status()}`);
          }
        }
        if (failures.length) {
          await testInfo.attach('navigation-cleanup-failures', { body: failures.join('\n'), contentType: 'text/plain' });
          throw new Error(`합성 탐색 데이터를 정리하지 못했습니다: ${failures.join(', ')}`);
        }
      } finally { await requests.dispose(); }
    }
  }, { timeout: 30_000 }],
});

async function setHash(page: Page, hash: string) {
  await page.evaluate(value => { location.hash = value; }, hash);
}

async function guardedHistory(page: Page, direction: 'back' | 'forward', accept: boolean) {
  const confirmation = page.waitForEvent('dialog');
  const navigation = page.evaluate(value => { history[value](); }, direction);
  const dialog = await confirmation;
  expect(dialog.type()).toBe('confirm');
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await navigation;
}

test('미저장 업무에서 뒤로·앞으로 이동 취소는 URL과 편집을 유지하고 승인은 대상 업무를 연다', async ({ page, syntheticNavigation }) => {
  const { projectA, issueA, issueB, requests } = syntheticNavigation;
  const routeA = `#/${projectA.id}/issues?issue=${issueA.id}`;
  const routeB = `#/${projectA.id}/issues?issue=${issueB.id}`;
  await page.goto(`/${routeA}`);
  const panel = page.locator('.issue-detail-panel');
  const title = panel.getByLabel('제목', { exact: true });
  await expect(title).toHaveValue(issueA.title);
  await setHash(page, routeB);
  await expect(title).toHaveValue(issueB.title);
  await title.fill('뒤로 이동을 취소하면 보존할 업무 B 편집');

  await guardedHistory(page, 'back', false);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(routeB);
  await expect(title).toHaveValue('뒤로 이동을 취소하면 보존할 업무 B 편집');
  await guardedHistory(page, 'back', true);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(routeA);
  await expect(title).toHaveValue(issueA.title);

  await title.fill('앞으로 이동을 취소하면 보존할 업무 A 편집');
  await guardedHistory(page, 'forward', false);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(routeA);
  await expect(title).toHaveValue('앞으로 이동을 취소하면 보존할 업무 A 편집');
  await guardedHistory(page, 'forward', true);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(routeB);
  await expect(title).toHaveValue(issueB.title);
  const after = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  expect(after.issues.find(issue => issue.id === issueA.id)?.title).toBe(issueA.title);
  expect(after.issues.find(issue => issue.id === issueB.id)?.title).toBe(issueB.title);
});

test('잘못된 주소는 앱을 중단시키지 않고 문서 주소의 프로젝트·누락 항목을 정상화한다', async ({ page, syntheticNavigation }) => {
  const { projectA, projectB, document, workspace } = syntheticNavigation;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const canonical = async () => {
    const route = await page.evaluate(() => location.hash);
    const match = route.match(/^#\/([^/]+)\/(overview|issues|gantt|documents|development|settings|mywork)(?:\/([^?]+))?(?:\?.*)?$/);
    try {
      if (!match || !workspace.projects.some(project => project.id === decodeURIComponent(match[1]))) return false;
      if (match[3] && !workspace.documents.some(value => value.id === decodeURIComponent(match[3])) && decodeURIComponent(match[3]) !== document.id) return false;
      return true;
    } catch { return false; }
  };
  await page.goto('/#/%E0%A4%A/documents/%E0%A4%A');
  await expect(page.locator('.workspace')).toBeVisible();
  await expect.poll(canonical).toBe(true);
  await setHash(page, `#/${projectA.id}/unknown-view`);
  await expect.poll(canonical).toBe(true);
  await setHash(page, '#/missing-project/issues?issue=missing-issue');
  await expect.poll(canonical).toBe(true);
  await expect.poll(() => page.evaluate(() => location.hash.includes('missing-'))).toBe(false);
  await expect(page.locator('.issue-detail-panel')).toHaveCount(0);

  await setHash(page, `#/${projectA.id}/documents/${document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/${projectB.id}/documents/${document.id}`);
  await expect(page.locator('.breadcrumbs')).toContainText(projectB.name);

  await setHash(page, `#/${projectA.id}/documents/missing-document`);
  await expect.poll(canonical).toBe(true);
  await expect.poll(() => page.evaluate(() => location.hash.includes('missing-document'))).toBe(false);
  await expect(page.locator('.workspace')).toBeVisible();
  expect(errors).toEqual([]);
});

test('문서 작업자 전환은 초안을 분리하고 가져오기 승인 뒤에는 이전 ID의 로컬 초안을 비운다', async ({ page, syntheticNavigation }) => {
  const { document, initialText, workspace, requests } = syntheticNavigation;
  await page.goto(`/#/${document.projectId}/documents/${document.id}`);
  const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
  const editor = page.locator('.docs-prose');
  await expect(title).toHaveValue(document.title);
  await expect(editor).toContainText(initialText);
  const picker = page.getByLabel('작업자 선택', { exact: true });
  const originalActor = await picker.inputValue();
  const otherActor = workspace.users.find(user => user.id !== originalActor)!.id;
  const draftText = '이전 작업자에게만 남겨둘 미저장 합성 초안입니다.';
  await editor.fill(draftText);
  page.once('dialog', dialog => dialog.dismiss());
  await picker.selectOption(otherActor);
  await expect(picker).toHaveValue(originalActor);
  await expect(editor).toContainText(draftText);
  page.once('dialog', dialog => dialog.accept());
  await picker.selectOption(otherActor);
  await expect(picker).toHaveValue(otherActor);
  await expect(editor).toContainText(initialText);
  await expect(editor).not.toContainText(draftText);
  await picker.selectOption(originalActor);
  await expect(editor).toContainText(draftText);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '워크스페이스 설정', exact: true }).click();
  const draftKey = `teamspace:document-draft:${originalActor}:${document.id}`;
  await expect.poll(() => page.evaluate(key => Boolean(localStorage.getItem(key)), draftKey)).toBe(true);
  await page.evaluate(() => localStorage.setItem('navigation-test-marker', 'keep'));

  // Import UI cache invalidation is tested independently from the real import
  // transaction tests. Interception avoids replacing a shared development
  // workspace while another browser test may be creating synthetic records.
  const exported = await (await requests.get('/api/export')).json();
  expect(exported.documents.some((value: DocPage) => value.id === document.id)).toBe(true);
  let imports = 0;
  await page.route('**/api/import', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON().data.documents.some((value: DocPage) => value.id === document.id)).toBe(true);
    imports++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, counts: { projects: exported.projects.length, issues: exported.issues.length, documents: exported.documents.length, attachments: exported.attachments?.length || 0 } }) });
  });
  const file = { name: 'synthetic-navigation-export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) };
  const input = page.locator('input[type="file"][accept="application/json,.json"]');
  await input.setInputFiles(file);
  const confirmation = page.getByRole('dialog', { name: '백업 가져오기 확인', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '취소', exact: true }).click();
  expect(imports).toBe(0);
  expect(await page.evaluate(key => Boolean(localStorage.getItem(key)), draftKey)).toBe(true);
  await input.setInputFiles(file);
  await confirmation.getByRole('button', { name: '확인하고 가져오기', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(imports).toBe(1);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('teamspace:document-draft:')))).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('navigation-test-marker'))).toBe('keep');
  await setHash(page, `#/${document.projectId}/documents/${document.id}`);
  await expect(title).toHaveValue(document.title);
  await expect(editor).toContainText(initialText);
  await expect(editor).not.toContainText(draftText);
});
