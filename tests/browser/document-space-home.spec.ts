import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { documentReadingHash } from '../../shared/document-sections';
import type { DocPage, DocumentSpaceHome, RichContent, WorkspaceSnapshot } from '../../shared/types';

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function fixture(request: APIRequestContext) {
  const initial = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const [project, peer] = initial.projects;
  const generation = initial.restoreGeneration;
  const prefix = `공간 홈 ${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  const path = (id?: string) => id ? `/api/document-space-home?projectId=${encodeURIComponent(id)}` : '/api/document-space-home';
  return { project, peer, path,
    async add(title: string, projectId: string | null, content: RichContent[] = [paragraph(title)]) {
      const document = await json<DocPage>(await request.post('/api/documents', { data: {
        title: `${prefix} ${title}`, projectId, content: { type: 'doc', content },
      } }), 201);
      ids.push(document.id);
      return document;
    },
    async set(document: DocPage, expectedVersion: number) {
      return json<DocumentSpaceHome>(await request.patch(path(document.projectId ?? undefined), { data: {
        expectedVersion, documentId: document.id, restoreGeneration: generation,
      } }));
    },
    async cleanup() {
      for (const id of ids) {
        const response = await request.delete(`/api/documents/${id}`);
        if (response.ok()) await request.delete(`/api/trash/${(await response.json() as { trashEntryId: string }).trashEntryId}`);
      }
    },
  };
}

const docPath = (projectId: string, id?: string) => `/#/${projectId}/documents${id ? `/${id}` : ''}`;
const reader = (page: Page) => page.getByRole('article', { name: '저장본 읽기', exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('a shared project home opens the saved reader while explicit document and section routes take precedence', async ({ page, request, browser, baseURL }) => {
  const f = await fixture(request);
  const alternateSection = randomUUID();
  const home = await f.add('프로젝트 팀 소개', f.project.id, [paragraph('회의 시작 전에 확인할 저장된 문서입니다.')]);
  const other = await f.add('직접 열 문서', f.project.id, [
    { type: 'heading', attrs: { level: 2, sectionId: alternateSection }, content: [{ type: 'text', text: '직접 연결한 절' }] },
    paragraph('직접 연결한 절의 저장 내용'),
  ]);
  const shared = await f.add('팀 전체 운영 기록', null);
  const peer = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    await page.goto(docPath(f.project.id, home.id));
    await button(page, '공간 홈으로 지정').click();
    await expect(button(page, '공간 홈 해제')).toBeEnabled();
    await f.set(shared, 0);
    const page360 = await peer.newPage();
    await page360.goto(docPath(f.project.id));
    await expect(page360).toHaveURL(url => url.hash === documentReadingHash(home.id, f.project.id));
    await expect(reader(page360).getByText('회의 시작 전에 확인할 저장된 문서입니다.')).toBeVisible();
    await expect(reader(page360).getByRole('heading', { name: home.title, exact: true })).toBeFocused();

    await page360.goto(docPath(f.project.id, other.id));
    await expect(page360.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(other.title);
    await expect(reader(page360)).toHaveCount(0);
    const direct = documentReadingHash(other.id, f.project.id, alternateSection);
    await page360.goto(`/${direct}`);
    await expect(reader(page360).getByRole('heading', { name: '직접 연결한 절' })).toBeFocused();
    await page360.reload();
    await expect(page360).toHaveURL(url => url.hash === direct);
    await button(page360, '팀 공통 문서 홈 열기').click();
    await expect(page360).toHaveURL(url => url.hash === documentReadingHash(shared.id, f.project.id));
    await expect(reader(page360).getByRole('heading', { name: shared.title, exact: true })).toBeVisible();
    await button(page360, '프로젝트 문서 홈 열기').click();
    await expect(reader(page360).getByRole('heading', { name: home.title, exact: true })).toBeVisible();
    await page360.goto(docPath(f.peer.id));
    await expect(button(page360, '팀 공통 문서 홈 열기')).toBeVisible();
    await expect(button(page360, '프로젝트 문서 홈 열기')).toHaveCount(0);
    await expect(reader(page360)).toHaveCount(0);

    await button(page, '공간 홈 해제').click();
    await expect(button(page, '공간 홈으로 지정')).toBeEnabled();
    await page360.goto(docPath(f.project.id));
    await expect(button(page360, '프로젝트 문서 홈 열기')).toHaveCount(0);
    await expect(page360.getByRole('textbox', { name: '문서 제목', exact: true })).toBeVisible();
  } finally {
    await peer.close();
    await f.cleanup();
  }
});

test('a stale home write refreshes the setting and an uncertain response preserves the open draft', async ({ page, request }) => {
  const f = await fixture(request);
  const candidate = await f.add('홈 후보', f.project.id);
  const peerHome = await f.add('동료가 지정한 홈', f.project.id);
  try {
    await page.goto(docPath(f.project.id, candidate.id));
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(candidate.title);
    await title.fill('저장하지 않은 공간 홈 후보 제목');
    const previous = await json<DocumentSpaceHome>(await request.get(f.path(f.project.id)));
    await f.set(peerHome, previous.version);
    await button(page, '공간 홈으로 지정').click();
    await expect(page.getByText('다른 작업자가 공간 홈을 변경했습니다. 최신 홈을 확인해 주세요.')).toBeVisible();
    await expect(title).toHaveValue('저장하지 않은 공간 홈 후보 제목');
    await expect(button(page, '프로젝트 문서 홈 열기')).toHaveAttribute('title', peerHome.title);

    const methods: string[] = [];
    await page.route('**/api/document-space-home?projectId=*', async route => {
      const method = route.request().method();
      methods.push(method);
      if (method !== 'PATCH') {
        await route.continue();
        return;
      }
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    });
    await button(page, '공간 홈으로 지정').click();
    await expect(button(page, '공간 홈 해제')).toBeEnabled();
    await expect(title).toHaveValue('저장하지 않은 공간 홈 후보 제목');
    await expect(button(page, '프로젝트 문서 홈 열기')).toHaveAttribute('title', candidate.title);
    expect(methods).toEqual(['PATCH', 'GET']);
  } finally { await f.cleanup(); }
});
