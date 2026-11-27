import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { Issue, IssueCloneResult, WorkspaceSnapshot } from '../../shared/types';

async function read<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

const markdown = [
  '## 재현 절차', '', '검토 대상', '', '- [x] 설치 확인', '',
  '| 입력 | 기대 값 |', '| --- | --- |', '| A | 정상 |', '',
  '```bash', 'printf test', '```', '',
  '[운영 안내](https://markdown-asset.invalid/runbook) · [실행 주소](javascript:alert%281%29)', '',
  '![상태 그림](https://markdown-asset.invalid/chart.png)', '',
  '<img src="https://markdown-asset.invalid/html.png" onerror="alert(1)">',
].join('\n');

test('360px에서 Markdown 설명을 편집·미리보기·저장하고 복제본의 표시 형식을 독립적으로 바꾼다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const sourceTitle = `서식 업무 ${randomUUID().slice(0, 8)}`;
  const cloneTitle = `${sourceTitle} 복제`;
  const ids: string[] = [];
  const externalRequests: string[] = [];
  await page.route('https://markdown-asset.invalid/**', async intercepted => {
    externalRequests.push(intercepted.request().url());
    await intercepted.abort();
  });
  try {
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/issues`);
    await page.locator('.issue-heading-actions').getByRole('button', { name: '업무 만들기', exact: true }).click();
    const create = page.getByRole('dialog', { name: '새 업무 만들기', exact: true });
    await create.getByRole('textbox', { name: '업무 제목', exact: true }).fill(sourceTitle);
    const format = create.getByRole('combobox', { name: '설명 서식', exact: true });
    await expect(format).toHaveValue('plain');
    await format.selectOption('markdown');
    const input = create.getByRole('textbox', { name: '설명', exact: true });
    await input.fill(markdown);
    await input.evaluate((element: HTMLTextAreaElement) => {
      const start = element.value.indexOf('검토 대상');
      element.setSelectionRange(start, start + '검토 대상'.length);
    });
    await create.getByRole('button', { name: '굵게', exact: true }).click();
    const source = markdown.replace('검토 대상', '**검토 대상**');
    await expect(input).toHaveValue(source);
    await create.getByRole('button', { name: '미리보기', exact: true }).click();
    const preview = create.getByRole('region', { name: '설명 미리보기', exact: true });
    await expect(preview.getByRole('heading', { name: '재현 절차', exact: true })).toBeVisible();
    await expect(preview.locator('strong', { hasText: '검토 대상' })).toBeVisible();
    await expect(preview.getByRole('table')).toContainText('정상');
    await expect(preview.getByRole('checkbox')).toBeChecked();
    await expect(preview.locator('pre')).toContainText('printf test');
    await expect(preview.getByRole('link', { name: '운영 안내', exact: true })).toHaveAttribute('href', 'https://markdown-asset.invalid/runbook');
    await expect(preview.getByRole('link', { name: '실행 주소', exact: true })).toHaveCount(0);
    await expect(preview).toContainText('onerror=');
    await expect(preview.locator('img, script')).toHaveCount(0);
    expect(externalRequests).toEqual([]);

    const creating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/issues' && response.request().method() === 'POST');
    await create.getByRole('button', { name: '업무 만들기', exact: true }).click();
    const saved = await read<Issue>(await creating, 201);
    ids.push(saved.id);
    expect(saved).toMatchObject({ title: sourceTitle, description: source, descriptionFormat: 'markdown' });
    await expect(create).toHaveCount(0);
    await page.goto(`/#/${project.id}/issues?issue=${saved.id}`);
    const details = page.getByRole('dialog', { name: sourceTitle, exact: true });
    await expect(details.getByRole('region', { name: '설명 미리보기', exact: true }).getByRole('table')).toBeVisible();
    expect(await page.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);

    await details.getByRole('button', { name: '업무 복제', exact: true }).click();
    const clone = page.getByRole('dialog', { name: '업무 복제', exact: true });
    await clone.getByRole('textbox', { name: '업무 제목', exact: true }).fill(cloneTitle);
    const cloneFormat = clone.getByRole('combobox', { name: '설명 서식', exact: true });
    await expect(cloneFormat).toHaveValue('markdown');
    await expect(clone.getByRole('textbox', { name: '설명', exact: true })).toHaveValue(source);
    await cloneFormat.selectOption('plain');
    await expect(clone.getByRole('button', { name: '미리보기', exact: true })).toHaveCount(0);
    const cloning = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${saved.id}/clone`);
    await clone.getByRole('button', { name: '복제 업무 만들기', exact: true }).click();
    const copied = (await read<IssueCloneResult>(await cloning, 201)).issue;
    ids.push(copied.id);
    expect(copied.description).toBe(source);
    expect(copied.descriptionFormat).toBeUndefined();
    await expect(clone).toHaveCount(0);
    await expect(details.getByRole('region', { name: '설명 미리보기', exact: true })).toBeVisible();
    expect(externalRequests).toEqual([]);
  } finally {
    for (const id of ids.reverse()) {
      const removed = await request.delete(`/api/issues/${id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
});

test('기존 평문을 그대로 보여 주고 버전 충돌에서 Markdown 방식과 편집을 유지한다', async ({ page, request }) => {
  const { projects: [project], users: [actor, peer] } = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const title = `업무 설명 충돌 ${randomUUID().slice(0, 8)}`;
  const old = await read<Issue>(await request.post('/api/issues', { headers, data: {
    projectId: project.id, title, description: '## 일반 입력 그대로',
  } }), 201);
  try {
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/issues?issue=${old.id}`);
    const details = page.getByRole('dialog', { name: title, exact: true });
    const format = details.getByRole('combobox', { name: '설명 서식', exact: true });
    const input = details.getByRole('textbox', { name: '설명', exact: true });
    await expect(input).toHaveValue(old.description);
    await expect(format).toHaveValue('plain');
    await expect(details.getByRole('region', { name: '설명 미리보기', exact: true })).toHaveCount(0);
    await format.selectOption('markdown');
    const text = '## 충돌 뒤에도 남아야 하는 설명';
    await input.fill(text);
    await details.getByRole('button', { name: '미리보기', exact: true }).click();
    const newer = await read<Issue>(await request.patch(`/api/issues/${old.id}`, { headers: { 'X-Actor-Id': peer.id }, data: {
      expectedVersion: old.version, description: '다른 작업자가 고친 원래 평문',
    } }));
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${old.id}` && response.request().method() === 'PATCH');
    await details.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect((await pending).status()).toBe(409);
    await expect(details.getByText('다른 변경사항이 있습니다', { exact: true })).toBeVisible();
    await expect(details.getByRole('heading', { name: '충돌 뒤에도 남아야 하는 설명', exact: true })).toBeVisible();
    await details.getByRole('button', { name: '편집', exact: true }).click();
    await expect(input).toHaveValue(text);
    await expect(format).toHaveValue('markdown');
    const workspace = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(workspace.issues.find(issue => issue.id === old.id)).toEqual(newer);
  } finally {
    const removed = await request.delete(`/api/issues/${old.id}`, { headers });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
