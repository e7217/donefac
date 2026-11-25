import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('360px 간트에서 신규 일정표를 붙여넣고 날짜 초안과 팀 필터를 유지한 채 응답을 다시 확인한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const prefix = `합성 간트 신규 표 ${randomUUID().slice(0, 8)}`;
  const create = await request.post('/api/issues', { data: {
    projectId: project.id, title: `${prefix} 기존`, startDate: '2027-01-11', endDate: '2027-01-12',
  } });
  expect(create.status(), await create.text()).toBe(201);
  const existing = await create.json() as Issue;
  const path = `/api/projects/${project.id}/issues/paste-apply`;
  const applyIds: string[] = [];
  try {
    await page.goto(`/#/${project.id}/gantt?scope=team`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const open = page.getByRole('button', { name: '새 업무 붙여넣기', exact: true });
    await expect(open).toHaveCount(0);
    await projectFilter.selectOption(project.id);
    const query = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await query.fill(`${prefix} 기존`);
    await query.press('Enter');
    const originalDate = chart.getByLabel(`${existing.key} 종료일`, { exact: true });
    await originalDate.fill('2027-01-13');
    await open.click();
    const paste = page.getByRole('dialog', { name: '업무 붙여넣기', exact: true });
    const input = paste.getByRole('textbox', { name: '붙여넣을 업무', exact: true });
    const text = [
      ['임시 키', '제목', '시작일', '종료일', '선행 업무'],
      ['setup', `${prefix} 설정`, '2027-01-18', '2027-01-19', existing.key],
      ['', `${prefix} 기록`, '2027-01-20', '2027-01-21', 'new:setup'],
    ].map(row => row.join('\t')).join('\n');
    await expect(input).toBeFocused();
    await expect(paste).toContainText(project.name);
    await input.fill(text);
    await paste.getByRole('button', { name: '미리보기', exact: true }).click();
    await expect(paste).toContainText('new:setup');
    await page.route(`**${path}`, async route => {
      applyIds.push(route.request().postDataJSON().previewId);
      if (applyIds.length === 1) {
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(201);
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await paste.getByRole('button', { name: '업무 2개와 선후행 연결 2개 만들기', exact: true }).click();
    const retry = paste.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expect(input).toHaveValue(text);
    await retry.click();
    await expect(paste).toHaveCount(0);
    expect(applyIds).toEqual([expect.any(String), applyIds[0]]);
    await expect(projectFilter).toHaveValue(project.id);
    await expect(query).toHaveValue(`${prefix} 기존`);
    await expect(originalDate).toHaveValue('2027-01-13');
    const after = await workspace(request);
    expect(after.issues.find(item => item.id === existing.id)?.endDate).toBe(existing.endDate);
    const added = after.issues.filter(item => item.title.startsWith(prefix) && item.id !== existing.id);
    expect(added).toHaveLength(2);
    const setup = added.find(item => item.title.endsWith('설정'))!;
    const record = added.find(item => item.title.endsWith('기록'))!;
    expect(after.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ predecessorId: existing.id, successorId: setup.id }),
      expect.objectContaining({ predecessorId: setup.id, successorId: record.id }),
    ]));
    await expect(page.getByText('추가한 업무 중 2개가 현재 간트의 보기 범위 밖에 있습니다.', { exact: true })).toBeVisible();
    const hiddenButton = page.getByRole('button', { name: '보기 범위 밖 업무 열기', exact: true });
    await hiddenButton.click();
    const ticket = page.getByRole('dialog', { name: setup.title, exact: true });
    await expect(ticket).toBeVisible();
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(hiddenButton).toBeFocused();
    await expect(originalDate).toHaveValue('2027-01-13');
  } finally {
    for (const issue of (await workspace(request)).issues.filter(item => item.title.startsWith(prefix))) {
      await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
    }
  }
});
