import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type {
  Dependency, Issue, ScheduleBulkLinkInput, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot,
} from '../../shared/types';

const previewPath = '/api/schedule/bulk-links/preview';
const applyPath = '/api/schedule/bulk-links/apply';
const undoPath = '/api/schedule/undo';
const dialogName = '선후행 연결 일괄 추가';
const reference = ({ id, version }: Issue) => ({ id, expectedVersion: version });

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

const workspace = async (request: APIRequestContext) => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
const nextPost = (page: Page, path: string) => page.waitForResponse(response =>
  new URL(response.url()).pathname === path && response.request().method() === 'POST');

function fixture(request: APIRequestContext) {
  const prefix = `일괄 연결 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  return {
    prefix,
    async create(projectId: string, title: string) {
      const issue = await readJson<Issue>(await request.post('/api/issues', { data: {
        projectId, title: `${prefix} ${title}`, startDate: '2026-11-19', endDate: '2026-11-20',
      } }), 201);
      issues.push(issue);
      return issue;
    },
    async stored() {
      return (await workspace(request)).issues.filter(issue => issues.some(original => original.id === issue.id))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async close() {
      for (const issue of issues.reverse()) {
        const removed = await request.delete(`/api/issues/${issue.id}`);
        if (removed.ok()) {
          const { trashEntryId } = await removed.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
    },
  };
}

test('360px 간트에서 필터 밖 기준 업무를 연결하고 응답 유실 뒤 기존 연결을 보존한 채 새 연결만 되돌린다', async ({ page, request }) => {
  test.setTimeout(110_000);
  const [project] = (await workspace(request)).projects;
  const f = fixture(request);
  let retained: Dependency | undefined;
  try {
    const anchor = await f.create(project.id, '숨겨질 기준 업무');
    const kept = await f.create(project.id, '선택 대상 기존 업무');
    const added = await f.create(project.id, '선택 대상 신규 업무');
    retained = await readJson<Dependency>(await request.post('/api/dependencies', { data: {
      predecessorId: anchor.id, successorId: kept.id, type: 'SS', lagDays: -2,
    } }), 201);
    const dependencyRows = async () => (await workspace(request)).dependencies.filter(link => link.predecessorId === anchor.id);
    const originals = await f.stored();

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/gantt`);
    const search = page.getByLabel('간트 업무 검색', { exact: true });
    await expect(search).toBeVisible({ timeout: 35_000 });
    await search.fill(f.prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const selected = (issue: Issue) => chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });
    const open = page.getByRole('button', { name: '선후행 일괄 연결', exact: true });
    await expect(open).toHaveCount(0);
    for (const issue of [anchor, kept, added]) await selected(issue).check();
    await search.fill(`${f.prefix} 선택 대상`);
    await expect(selected(anchor)).toHaveCount(0);
    await expect(selected(kept)).toBeChecked();
    await expect(selected(added)).toBeChecked();

    await open.click();
    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const anchorSearch = dialog.getByLabel('기준 업무 검색', { exact: true });
    await anchorSearch.fill(anchor.key);
    await dialog.getByRole('button', { name: `${anchor.key} ${anchor.title}`, exact: true }).click();
    await expect(dialog.getByText('선택한 기준 업무', { exact: true })).toBeVisible();
    await dialog.getByLabel('기준 업무 방향', { exact: true }).selectOption('predecessor');
    await dialog.getByLabel('연결 유형', { exact: true }).selectOption('FF');
    await dialog.getByLabel('근무일 간격', { exact: true }).fill('2');
    const previewRequest = nextPost(page, previewPath);
    await dialog.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const previewResponse = await previewRequest;
    const input = previewResponse.request().postDataJSON() as ScheduleBulkLinkInput;
    expect(input).toMatchObject({
      projectId: project.id, anchor: reference(anchor), direction: 'predecessor', type: 'FF', lagDays: 2,
    });
    expect(input.issues).toHaveLength(2);
    expect(input.issues).toEqual(expect.arrayContaining([reference(kept), reference(added)]));
    const preview = await readJson<SchedulePastePreview>(previewResponse);
    expect(preview.previewId).toBeTruthy();
    expect(preview.errors).toEqual([]);
    expect(preview.changes).toEqual([]);
    expect(preview.unchanged).toBe(1);
    expect(preview.retainedDependencies).toEqual([expect.objectContaining({
      predecessorKey: anchor.key, successorKey: kept.key, before: { type: 'SS', lagDays: -2 }, after: { type: 'SS', lagDays: -2 },
    })]);
    expect(preview.dependencyChanges).toEqual([expect.objectContaining({
      predecessorKey: anchor.key, successorKey: added.key, before: null, after: { type: 'FF', lagDays: 2 },
    })]);
    const retainedTable = dialog.getByRole('table', { name: '유지할 선후행 연결 목록', exact: true });
    await expect(retainedTable).toContainText(kept.key);
    await expect(retainedTable).toContainText('SS');
    await expect(retainedTable).toContainText('-2');
    await expect(retainedTable).not.toContainText(added.key);
    const newTable = dialog.getByRole('table', { name: '새 선후행 연결 목록', exact: true });
    await expect(newTable).toContainText(added.key);
    await expect(newTable).toContainText('FF');
    await expect(newTable).not.toContainText(kept.key);
    expect(await dependencyRows()).toEqual([retained]);

    let savedResult: SchedulePasteApplyResult | undefined;
    const attempts: string[] = [];
    await page.route(`**${applyPath}`, async route => {
      const body = route.request().postDataJSON() as { previewId: string };
      attempts.push(body.previewId);
      if (attempts.length === 1) {
        savedResult = await readJson<SchedulePasteApplyResult>(await route.fetch());
        await route.fulfill({ status: 408, json: { error: '합성 프록시 응답 시간 초과' } });
      } else {
        await route.continue();
      }
    });
    await dialog.getByRole('button', { name: '검토한 연결 적용', exact: true }).click();
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recover).toBeEnabled();
    expect(savedResult?.dependencyChanges).toBe(1);
    expect(savedResult?.updated).toEqual([]);
    const appliedLinks = await dependencyRows();
    expect(appliedLinks).toHaveLength(2);
    expect(appliedLinks).toContainEqual(retained);
    expect(appliedLinks).toContainEqual(expect.objectContaining({ successorId: added.id, type: 'FF', lagDays: 2 }));

    const retryResponse = nextPost(page, applyPath);
    await recover.click();
    expect(await readJson<SchedulePasteApplyResult>(await retryResponse)).toEqual(savedResult);
    await expect(dialog).toHaveCount(0);
    expect(attempts).toEqual([preview.previewId, preview.previewId]);
    expect(await dependencyRows()).toEqual(appliedLinks);

    const undoResponse = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await undoResponse;
    expect(undone.request().postDataJSON()).toEqual({ undoId: savedResult?.undoId });
    expect(await readJson<SchedulePasteApplyResult>(undone)).toMatchObject({ updated: [], dependencyChanges: 1 });
    expect(await dependencyRows()).toEqual([retained]);
    expect(await f.stored()).toEqual(originals);
  } finally {
    if (retained) await request.delete(`/api/dependencies/${retained.id}`);
    await f.close();
  }
});

test('전체 프로젝트 간트에서 다른 프로젝트를 함께 고르면 안내하고 같은 프로젝트를 선택하면 연결을 연다', async ({ page, request }) => {
  const [project, otherProject] = (await workspace(request)).projects;
  const f = fixture(request);
  try {
    const first = await f.create(project.id, '같은 프로젝트 첫 업무');
    const second = await f.create(project.id, '같은 프로젝트 둘째 업무');
    const anchor = await f.create(project.id, '선택 밖 기준 업무');
    const other = await f.create(otherProject.id, '다른 프로젝트 업무');
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/gantt?scope=team`);
    const search = page.getByLabel('간트 업무 검색', { exact: true });
    await expect(search).toBeVisible({ timeout: 35_000 });
    await search.fill(f.prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const selected = (issue: Issue) => chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });
    const trigger = page.getByRole('button', { name: '선후행 일괄 연결', exact: true });
    await selected(first).check();
    await selected(other).check();
    await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveAccessibleDescription('같은 프로젝트의 업무를 선택해 주세요.');

    await selected(other).uncheck();
    await selected(second).check();
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    await expect(dialog).toBeVisible();
    const anchorSearch = dialog.getByLabel('기준 업무 검색', { exact: true });
    await anchorSearch.fill(other.key);
    await expect(dialog.getByText('선택할 수 있는 기준 업무가 없습니다.', { exact: true })).toBeVisible();
    await anchorSearch.fill(anchor.key);
    await expect(dialog.getByRole('button', { name: `${anchor.key} ${anchor.title}`, exact: true })).toBeVisible();
    await anchorSearch.clear();
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await f.close();
  }
});
