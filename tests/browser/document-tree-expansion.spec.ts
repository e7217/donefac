import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';

async function read<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('문서 트리의 접힌 가지가 작업자별로 유지되고 다시 연 문서의 경로가 보인다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const { projects: [project], users: [actor, peer] } = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `주간 자료 ${randomUUID().slice(0, 8)}`;
  const created: DocPage[] = [];
  async function create(label: string, parentId: string | null = null) {
    const document = await read<DocPage>(await request.post('/api/documents', {
      headers, data: { projectId: project.id, parentId, title: `${prefix} ${label}` },
    }), 201);
    created.push(document);
    return document;
  }
  try {
    const landing = await create('기본 문서');
    const handover = await create('인수인계');
    const archived = await create('지난 주', handover.id);
    const meeting = await create('주간 회의록', archived.id);
    const reference = await create('별도 참고 자료');
    const guide = await create('참고 자료 하위', reference.id);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/documents/${landing.id}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const actorPicker = page.getByLabel('작업자 선택', { exact: true });
    await actorPicker.selectOption(actor.id);
    await expect(title).toHaveValue(landing.title);
    const tree = page.getByRole('complementary', { name: '문서 목록', exact: true });
    const entry = (document: DocPage) => tree.locator('.docs-tree-link').getByText(document.title, { exact: true });
    const toggle = (document: DocPage, action: '접기' | '펼치기') => tree.getByRole('button', { name: `${document.title} ${action}`, exact: true });
    const search = tree.getByRole('textbox', { name: '문서 찾기', exact: true });

    await toggle(archived, '접기').click();
    await toggle(handover, '접기').click();
    await toggle(reference, '접기').click();
    await expect(entry(archived)).toHaveCount(0);
    await expect(entry(guide)).toHaveCount(0);

    await page.reload();
    await expect(title).toHaveValue(landing.title);
    await expect(entry(archived)).toHaveCount(0);
    await expect(entry(guide)).toHaveCount(0);
    await expect(toggle(handover, '펼치기')).toHaveAttribute('aria-expanded', 'false');

    await actorPicker.selectOption(peer.id);
    await expect(entry(meeting)).toBeVisible();
    await expect(entry(guide)).toBeVisible();
    await actorPicker.selectOption(actor.id);
    await expect(entry(archived)).toHaveCount(0);
    await expect(entry(guide)).toHaveCount(0);

    await search.fill(meeting.title);
    await expect(entry(meeting)).toBeVisible();
    await search.fill('');
    await expect(entry(meeting)).toHaveCount(0);
    await search.fill(meeting.title);
    await entry(meeting).click();
    await expect(title).toHaveValue(meeting.title);
    await search.fill('');
    await expect(entry(meeting)).toBeVisible();
    await expect(entry(meeting).locator('..')).toHaveAttribute('aria-current', 'page');
    await expect(toggle(handover, '접기')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle(archived, '접기')).toHaveAttribute('aria-expanded', 'true');
    await expect(entry(guide)).toHaveCount(0);

    await toggle(handover, '접기').click();
    await expect(entry(meeting)).toHaveCount(0);
    await page.reload();
    await expect(title).toHaveValue(meeting.title);
    await expect(entry(meeting)).toBeVisible();
    await expect(entry(guide)).toHaveCount(0);
  } finally {
    for (const document of created.reverse()) {
      const removed = await request.delete(`/api/documents/${document.id}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
