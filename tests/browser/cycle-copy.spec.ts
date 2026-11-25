import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { CycleCopyPreview, CycleCopyResult, Issue, PlanningItem, Project, WorkspaceSnapshot } from '../../shared/types';
import { projectWorkflow } from '../../shared/workflow-helpers';

async function read<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('360px에서 기존 사이클을 복제하고 변경된 원본과 유실된 응답을 처리한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const key = `CP${randomUUID().slice(0, 8).toUpperCase()}`;
  const project = await read<Project>(await request.post('/api/projects', { data: { key, name: `사이클 복제 ${key}` } }), 201);
  const snapshot = async () => read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const workspace = await snapshot();
  const [owner, peer] = workspace.users;
  const initialStatus = projectWorkflow(workspace, project.id).initialStatusId;
  const source = await read<PlanningItem>(await request.post('/api/planning-items', { data: {
    projectId: project.id, kind: 'cycle', status: 'active', name: `원본 사이클 ${key}`, ownerId: owner.id,
    startDate: '2026-11-16', endDate: '2026-11-20', targetDate: '2026-11-23',
  } }), 201);
  const modulePlan = await read<PlanningItem>(await request.post('/api/planning-items', { data: {
    projectId: project.id, kind: 'module', name: `원본 모듈 ${key}`,
  } }), 201);
  const targetName = `다음 검증 사이클 ${key}`;

  const createIssue = async (title: string, values: Partial<Issue>) =>
    read<Issue>(await request.post('/api/issues', { data: { projectId: project.id, cycleId: source.id, title, ...values } }), 201);

  try {
    const parent = await createIssue('작업 준비', { status: 'done', assigneeId: peer.id, moduleId: modulePlan.id,
      startDate: '2026-11-16', endDate: '2026-11-18' });
    const child = await createIssue('검증 업무', { parentId: parent.id, startDate: '2026-11-19', endDate: '2026-11-20', dueDate: '2026-11-23' });
    const omitted = await createIssue('이번에는 제외할 업무', {});
    for (const link of [
      { predecessorId: parent.id, successorId: child.id, type: 'FS', lagDays: 0 },
      { predecessorId: child.id, successorId: omitted.id, type: 'SS', lagDays: 1 },
    ]) await read(await request.post('/api/dependencies', { data: link }), 201);

    await page.goto(`/#/${project.id}/planning/${source.id}`);
    const editor = page.getByRole('region', { name: '사이클 상세', exact: true });
    const open = editor.getByRole('button', { name: '업무와 함께 복제', exact: true });
    await expect(open).toHaveCount(1);
    const sourceName = editor.getByLabel('계획 이름', { exact: true });
    await sourceName.fill('저장하지 않은 제목');
    await expect(open).toBeDisabled();
    await sourceName.fill(source.name);
    const membership = editor.getByRole('checkbox', { name: `${omitted.key} 계획 연결`, exact: true });
    await membership.uncheck();
    await expect(open).toBeDisabled();
    await membership.check();
    await open.click();

    const dialog = page.getByRole('dialog', { name: '사이클 업무와 함께 복제', exact: true });
    const name = dialog.getByLabel('새 사이클 이름', { exact: true });
    const days = dialog.getByLabel('일정 이동 일수', { exact: true });
    const review = dialog.getByRole('button', { name: '복제 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '사이클 복제 적용', exact: true });
    const excluded = dialog.getByRole('checkbox', { name: `${omitted.key} ${omitted.title}`, exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(`${source.name} 복사본`);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    await open.click();
    await name.fill(targetName);
    await days.fill('4');
    await excluded.uncheck();

    page.once('dialog', async prompt => { expect(prompt.message()).toContain('미리보기를 버리고'); await prompt.dismiss(); });
    await page.keyboard.press('Escape');
    await expect(name).toHaveValue(targetName);
    await expect(excluded).not.toBeChecked();

    const path = `/api/planning-items/${source.id}/copy`;
    const nextPost = (url: string) => page.waitForResponse(response => new URL(response.url()).pathname === url && response.request().method() === 'POST');
    async function preview() {
      const pending = nextPost(`${path}-preview`);
      await review.click();
      return read<CycleCopyPreview>(await pending);
    }

    const first = await preview();
    expect(first.cycle).toEqual({ name: targetName, ownerId: owner.id, startDate: '2026-11-20', endDate: '2026-11-24', targetDate: '2026-11-27' });
    expect(first.rows.map(row => row.sourceIssueId)).toEqual([parent.id, child.id]);
    expect(first.rows).toMatchObject([
      { sourceIssueId: parent.id, statusId: initialStatus, assigneeId: peer.id, dueDate: null, parentKey: null },
      { sourceIssueId: child.id, startDate: '2026-11-23', endDate: '2026-11-24', dueDate: '2026-11-27', parentKey: parent.key },
    ]);
    expect(first.dependencies).toMatchObject([{ predecessorKey: parent.key, successorKey: child.key, type: 'FS', lagDays: 0 }]);
    expect(first.omitted).toEqual({ parents: 0, dependencies: 1 });
    const reviewSection = dialog.getByRole('region', { name: '복제 미리보기 결과', exact: true });
    await expect(reviewSection).toContainText('마감 2026-11-27');
    await expect(reviewSection).toContainText(`상위 업무 ${parent.key}`);
    await expect(reviewSection).toContainText('의존성 1건을 제외합니다.');
    expect((await snapshot()).planningItems?.find(plan => plan.name === targetName)).toBeUndefined();

    const edited = await read<Issue>(await request.patch(`/api/issues/${child.id}`, {
      data: { expectedVersion: child.version, title: '검증 업무 최신화' }, headers: { 'X-Actor-Id': peer.id },
    }));
    const applyingStale = nextPost(path);
    await apply.click();
    const stale = await applyingStale;
    expect(stale.status(), await stale.text()).toBe(409);
    expect(stale.request().postDataJSON()).toEqual({ previewId: first.previewId });
    await expect(apply).toBeDisabled();
    await expect(review).toBeDisabled();
    await dialog.getByRole('button', { name: '최신 사이클 및 업무 확인', exact: true }).click();
    await expect(name).toHaveValue(targetName);
    await expect(days).toHaveValue('4');
    await expect(excluded).not.toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: `${child.key} ${edited.title}`, exact: true })).toBeChecked();
    const latest = await preview();
    expect(latest.previewId).not.toBe(first.previewId);
    expect(latest.rows).toMatchObject([{ sourceIssueId: parent.id }, { sourceIssueId: edited.id, title: edited.title }]);

    let attempts = 0;
    let saved: CycleCopyResult | undefined;
    let loseNextRefresh = false;
    await page.route('**/api/workspace', async route => {
      if (!loseNextRefresh) return route.continue();
      loseNextRefresh = false;
      await route.abort('failed');
    });
    await page.route(`**${path}`, async route => {
      attempts++;
      expect(route.request().postDataJSON()).toEqual({ previewId: latest.previewId });
      const response = await route.fetch();
      if (attempts === 1) {
        saved = await read<CycleCopyResult>(response, 201);
        await route.abort('failed');
      } else {
        expect(await read<CycleCopyResult>(response)).toMatchObject({ duplicate: true, cycle: { id: saved!.cycle.id } });
        loseNextRefresh = true;
        await route.fulfill({ response });
      }
    });
    await apply.click();
    const retry = dialog.getByRole('button', { name: '같은 복제 요청 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    await expect(name).toBeDisabled();
    await expect(excluded).toBeDisabled();
    await retry.click();
    const openNew = dialog.getByRole('button', { name: '새 사이클 열기', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('복제를 저장했습니다.');
    await expect(openNew).toBeDisabled();
    await dialog.getByRole('button', { name: '새 사이클 정보 다시 불러오기', exact: true }).click();
    await expect(openNew).toBeEnabled();
    expect(attempts).toBe(2);

    const current = await snapshot();
    expect(current.planningItems?.filter(plan => plan.name === targetName)).toEqual([saved!.cycle]);
    expect(current.planningItems?.find(plan => plan.id === source.id)).toEqual(source);
    expect(current.issues.find(issue => issue.id === parent.id)).toEqual(parent);
    expect(current.issues.find(issue => issue.id === child.id)).toEqual(edited);
    expect(current.issues.find(issue => issue.id === omitted.id)).toEqual(omitted);
    const copied = saved!.issues.map(row => current.issues.find(issue => issue.id === row.id));
    expect(copied).toMatchObject([
      { cycleId: saved!.cycle.id, parentId: null, moduleId: null, status: initialStatus },
      { cycleId: saved!.cycle.id, parentId: copied[0]!.id, title: edited.title, dueDate: '2026-11-27' },
    ]);
    expect(current.dependencies.filter(link => link.predecessorId === copied[0]?.id)).toMatchObject([
      { predecessorId: copied[0]!.id, successorId: copied[1]!.id, type: 'FS', lagDays: 0 },
    ]);
    await openNew.click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === `#/${project.id}/planning/${saved!.cycle.id}`);
    await expect(editor.getByLabel('계획 상태', { exact: true })).toHaveValue('planned');
    await expect(editor.getByLabel('계획 이름', { exact: true })).toHaveValue(targetName);
  } finally {
    const current = await snapshot();
    for (const issue of current.issues.filter(issue => issue.projectId === project.id).reverse()) await request.delete(`/api/issues/${issue.id}`);
    for (const plan of current.planningItems?.filter(plan => plan.projectId === project.id) ?? []) {
      await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${plan.version}`);
    }
  }
});
