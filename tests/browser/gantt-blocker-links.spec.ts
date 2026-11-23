import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type { Dependency, Issue, IssueRelation, Project, ScheduleBlockerLinkInput, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/blocker-links/preview';
const applyPath = '/api/schedule/blocker-links/apply';
const undoPath = '/api/schedule/undo';

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px 간트에서 보기 밖 차단 관계를 검토하고 응답 유실 뒤 새 일정 연결만 되돌린다', async ({ page, request }) => {
  test.setTimeout(105_000);
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const project = await readJson<Project>(await request.post('/api/projects', { data: { key: `GB${suffix}`, name: `차단 관계 검토 ${suffix}` } }), 201);
  const created: Issue[] = [];
  const workspace = async () => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  async function create(title: string, dates: Partial<Pick<Issue, 'startDate' | 'endDate'>>) {
    const issue = await readJson<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title, ...dates } }), 201);
    created.push(issue);
    return issue;
  }
  async function block(source: Issue, target: Issue) {
    return readJson<IssueRelation>(await request.post(`/api/issues/${source.id}/relations`, { data: {
      otherIssueId: target.id, type: 'blocks', direction: 'outgoing',
    } }), 201);
  }
  try {
    const first = await create('준비 작업', { startDate: '2026-11-16', endDate: '2026-11-18' });
    const second = await create('기존 연결 작업', { startDate: '2026-11-17', endDate: '2026-11-20' });
    const third = await create(`현재 차트에서만 보이는 업무 ${suffix}`, { startDate: '2026-11-19' });
    const fourth = await create('마지막 검토 업무', {});
    const existingRelation = await block(first, second);
    const secondRelation = await block(second, third);
    const thirdRelation = await block(third, fourth);
    const retained = await readJson<Dependency>(await request.post('/api/dependencies', { data: {
      predecessorId: first.id, successorId: second.id, type: 'SS', lagDays: -2,
    } }), 201);
    const projectDependencies = async () => (await workspace()).dependencies.filter(dependency => created.some(issue => issue.id === dependency.predecessorId));

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/gantt`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await expect(search).toBeVisible({ timeout: 35_000 });
    await search.fill(third.title);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.locator(`[data-issue-id="${first.id}"]`)).toHaveCount(0);
    const draft = chart.getByLabel(`${third.key} 종료일`, { exact: true });
    await draft.fill('2026-11-24');

    const opener = page.getByRole('button', { name: '차단 관계로 일정 연결', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '차단 관계 선후행 검토', exact: true });
    const candidates = dialog.getByRole('region', { name: '차단 관계 목록', exact: true });
    const choice = (source: Issue, target: Issue) => candidates.getByRole('checkbox', { name: `${source.key} → ${target.key} 차단 관계 선택`, exact: true });
    await expect(choice(first, second)).toBeVisible();
    await expect(candidates).toContainText('이미 연결');
    await candidates.getByRole('button', { name: '이 페이지의 미연결 차단 관계 선택', exact: true }).click();
    await expect(choice(first, second)).not.toBeChecked();
    await expect(choice(second, third)).toBeChecked();
    await expect(choice(third, fourth)).toBeChecked();
    await choice(first, second).check();

    const reviewing = nextPost(page, previewPath);
    await dialog.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const response = await reviewing;
    const input = response.request().postDataJSON() as ScheduleBlockerLinkInput;
    expect(input.projectId).toBe(project.id);
    expect(input.relations).toHaveLength(3);
    expect(input.relations).toEqual(expect.arrayContaining([existingRelation, secondRelation, thirdRelation].map(({ id, version }) => ({ id, version }))));
    const preview = await readJson<SchedulePastePreview>(response);
    expect(preview.previewId).toBeTruthy();
    expect(preview.errors).toEqual([]);
    expect(preview.changes).toEqual([]);
    expect(preview.warnings.length).toBeGreaterThan(0);
    const kept = dialog.getByRole('table', { name: '유지할 선후행 연결 목록', exact: true });
    await expect(kept).toContainText('SS');
    await expect(kept).toContainText('-2');
    const added = dialog.getByRole('table', { name: '새 선후행 연결 목록', exact: true });
    await expect(added).toContainText(fourth.key);
    expect(await projectDependencies()).toEqual([retained]);

    let saved: SchedulePasteApplyResult | undefined;
    const attempts: string[] = [];
    await page.route(`**${applyPath}`, async route => {
      attempts.push(route.request().postDataJSON().previewId);
      if (attempts.length !== 1) return route.continue();
      saved = await readJson<SchedulePasteApplyResult>(await route.fetch());
      await route.fulfill({ status: 408, json: { error: '합성 프록시 응답 시간 초과' } });
    });
    const applying = nextPost(page, applyPath);
    await dialog.getByRole('button', { name: '검토한 연결 적용', exact: true }).click();
    expect((await applying).status()).toBe(408);
    const recovering = nextPost(page, applyPath);
    await dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true }).click();
    expect(await readJson<SchedulePasteApplyResult>(await recovering)).toEqual(saved);
    expect(attempts).toEqual([preview.previewId, preview.previewId]);
    expect(saved?.dependencyChanges).toBe(2);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(search).toHaveValue(third.title);
    await expect(draft).toHaveValue('2026-11-24');
    const savedLinks = await projectDependencies();
    expect(savedLinks).toHaveLength(3);
    expect(savedLinks).toEqual(expect.arrayContaining([retained, expect.objectContaining({ predecessorId: second.id, successorId: third.id, type: 'FS', lagDays: 0 }),
      expect.objectContaining({ predecessorId: third.id, successorId: fourth.id, type: 'FS', lagDays: 0 })]));

    const undoing = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect((await undoing).ok()).toBeTruthy();
    await expect.poll(projectDependencies).toEqual([retained]);
    const relations = await readJson<IssueRelation[]>(await request.get(`/api/issues/${third.id}/relations`));
    expect(relations.map(relation => relation.id)).toEqual(expect.arrayContaining([secondRelation.id, thirdRelation.id]));
    expect((await workspace()).issues.find(issue => issue.id === third.id)).toMatchObject({ version: third.version, endDate: third.endDate });
    await expect(draft).toHaveValue('2026-11-24');
    await draft.press('Escape');

    await page.goto(`/#/${project.id}/gantt?scope=team`);
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await expect(projectFilter).toBeVisible();
    await expect(opener).toHaveCount(0);
    await projectFilter.selectOption(project.id);
    await opener.click();
    await expect(choice(third, fourth)).toBeVisible();
    await dialog.getByRole('button', { name: '차단 관계 선후행 검토 닫기', exact: true }).click();
    await expect(opener).toBeFocused();
  } finally {
    for (const issue of created.reverse()) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});
