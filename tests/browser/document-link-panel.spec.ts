import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { documentSectionHash } from '../../shared/document-sections';
import type { DocPage, DocumentTreeMovePreview, RichContent, WorkspaceSnapshot } from '../../shared/types';

const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const linkParagraph = (text: string, href: string): RichContent => ({
  type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
});

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function showLinks(page: Page) {
  const details = page.getByRole('complementary', { name: '문서 상세 정보', exact: true });
  if (!(await details.isVisible())) await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
  await details.getByRole('button', { name: '연결', exact: true }).click();
  return details.locator('.docs-reference-list').filter({ hasText: '본문에서 참조하는 문서' });
}

test('360px에서 붙여넣은 절 링크와 이관 링크를 연결 패널과 역참조에서 열고 이동한 문서를 찾는다', async ({ page, request, context }) => {
  test.setTimeout(85_000);
  const { projects: [original, destination], users: [actor] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const heading = '장비 연결 검토 절';
  const sectionId = `panel-section-${suffix}`;
  const migratedSectionId = `migrated-section-${suffix}`;
  const archivedId = randomUUID();
  const createdIds: string[] = [];

  async function create(title: string, content: RichContent) {
    const document = await json<DocPage>(await request.post('/api/documents', { headers,
      data: { projectId: original.id, title: `${title} ${suffix}`, content },
    }), 201);
    createdIds.push(document.id);
    return document;
  }

  try {
    const target = await create('절 링크를 받을 문서', body(
      { type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: heading }] },
      { type: 'heading', attrs: { level: 2, sectionId: migratedSectionId }, content: [{ type: 'text', text: '이관한 원래 문서 절' }] },
    ));
    const duplicate = await create('참조와 링크가 겹치는 문서', body(paragraph('같은 문서 목적지')));
    const unrelated = await create('URL 모양만 비슷한 외부 문서', body(paragraph('외부 주소의 대상')));
    const route = `#/${original.id}/documents/${target.id}`;
    const targetSection = documentSectionHash(target.id, sectionId, original.id);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${route}`);
    await page.locator('summary').filter({ hasText: '문서 목차' }).click();
    await page.getByRole('button', { name: `절 링크 복사 ${heading}`, exact: true }).click();
    await expect(page.getByText('절 링크를 복사했습니다.', { exact: true })).toBeVisible();
    const copiedAddress = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(copiedAddress).hash).toBe(targetSection);

    const duplicateRoute = `#/${original.id}/documents/${duplicate.id}`;
    const unrelatedRoute = `#/${original.id}/documents/${unrelated.id}`;
    const source = await create('문서 링크를 작성한 문서', body(
      linkParagraph('문서 링크', `${route}?${new URLSearchParams({ label: '검증' })}`),
      linkParagraph('이관으로 보존한 절 링크', documentSectionHash(target.id, migratedSectionId)),
      linkParagraph('사라진 절 링크', documentSectionHash(target.id, 'deleted-section', original.id)),
      linkParagraph('보관된 문서 링크', `#/${original.id}/documents/${archivedId}`),
      linkParagraph('외부 서비스 링크', `https://another-workspace.example.test/${unrelatedRoute}`),
      linkParagraph('같은 호스트의 다른 서비스', new URL(`/another-app${unrelatedRoute}`, copiedAddress).href),
      { type: 'documentReference', attrs: { documentId: duplicate.id, label: duplicate.title } },
      linkParagraph('같은 문서를 여는 일반 링크', duplicateRoute),
      paragraph('붙여넣을 위치'),
    ));
    const externalOnly = await create('외부 주소만 있는 원본', body(linkParagraph('다른 워크스페이스 문서',
      `https://another-workspace.example.test/${targetSection}`)));
    const sourcePath = `/#/${original.id}/documents/${source.id}`;
    await page.goto('about:blank');
    await page.goto(sourcePath);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(source.title);
    const editor = page.locator('.docs-prose');
    await editor.getByText('붙여넣을 위치', { exact: true }).click();
    await page.keyboard.press('End');
    await editor.evaluate((element, href) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.textContent = '복사한 절 링크';
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/html', `<p>${anchor.outerHTML}</p>`);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, copiedAddress);
    await expect(editor.getByRole('link', { name: '복사한 절 링크', exact: true })).toHaveAttribute('href', copiedAddress);
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    const outgoing = await showLinks(page);
    const targetRows = outgoing.getByRole('button').filter({ hasText: target.title });
    await expect(targetRows).toHaveCount(4);
    await expect(targetRows.filter({ hasText: '문서 링크' })).toHaveCount(1);
    await expect(targetRows.filter({ hasText: '절 링크 · 이관한 원래 문서 절' })).toHaveCount(1);
    const currentSection = targetRows.filter({ hasText: `절 링크 · ${heading}` });
    await expect(currentSection).toHaveCount(1);
    await expect(outgoing.getByRole('button').filter({ hasText: duplicate.title })).toHaveCount(1);
    await expect(outgoing).not.toContainText(unrelated.title);
    await expect(outgoing.getByRole('button').filter({ hasText: '보관된 문서 링크' })).toBeDisabled();

    const move = { projectId: destination.id, parentId: null };
    const preview = await json<DocumentTreeMovePreview>(await request.post(`/api/documents/${target.id}/move-preview`, { headers, data: move }));
    await json(await request.post(`/api/documents/${target.id}/move`, { headers, data: { ...move, token: preview.token } }));
    await page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
    await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
    await expect(page.getByText('참조, 포함 원본, 업무 현황과 문서 목록을 새로 불러왔습니다.', { exact: true })).toBeVisible();
    await showLinks(page);
    await currentSection.click();
    await expect(page).toHaveURL(url => url.hash === documentSectionHash(target.id, sectionId, destination.id));
    await expect(editor.getByRole('heading', { name: heading, exact: true })).toBeFocused();

    await showLinks(page);
    const backlinks = page.locator('.docs-reference-list').filter({ hasText: '이 문서를 참조하는 문서' });
    const backlink = backlinks.getByRole('button').filter({ hasText: source.title });
    await expect(backlink).toHaveCount(1);
    await expect(backlink).toContainText('내 문서에 링크함');
    await expect(backlinks).not.toContainText(externalOnly.title);
    await backlink.click();
    await expect(page).toHaveURL(url => url.hash === `#/${original.id}/documents/${source.id}`);

    await showLinks(page);
    await targetRows.filter({ hasText: '절을 찾을 수 없음 · 현재 문서 열기' }).click();
    await expect(page).toHaveURL(url => url.hash === `#/${destination.id}/documents/${target.id}`);
  } finally {
    for (const id of createdIds.reverse()) {
      const response = await request.delete(`/api/documents/${id}`, { headers });
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
});
