import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type {
  Dependency, Issue, Project, ScheduleBulkChainInput, ScheduleBulkLinkInput, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot,
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
    async create(projectId: string, title: string, dates: Pick<Issue, 'startDate' | 'endDate'> = {
      startDate: '2026-11-19', endDate: '2026-11-20',
    }) {
      const issue = await readJson<Issue>(await request.post('/api/issues', { data: {
        projectId, title: `${prefix} ${title}`, ...dates,
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

test('360px 간트에서 날짜 초안과 선후행 연결을 함께 검토하고 동료 수정 뒤 적용·되돌리기한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const f = fixture(request);
  const date = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;
  try {
    const first = await f.create(project.id, '첫 업무', { startDate: date(16), endDate: date(17) });
    const second = await f.create(project.id, '둘째 업무', { startDate: date(18), endDate: date(20) });
    const third = await f.create(project.id, '셋째 업무', { startDate: date(23), endDate: date(24) });
    const unrelated = await f.create(project.id, '별도 날짜 초안', { startDate: date(25), endDate: date(26) });
    const chain = [first, second, third];
    const chainIds = new Set(chain.map(issue => issue.id));
    const changes = { endDate: date(19) };
    const unrelatedEnd = date(30);
    const projectedWarning = `${first.key} → ${second.key}`;
    const stores = async () => {
      const { issues, dependencies } = await workspace(request);
      return {
        issues: new Map(issues.map(issue => [issue.id, issue])),
        links: dependencies.filter(link => chainIds.has(link.predecessorId) && chainIds.has(link.successorId)),
      };
    };

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const confirmations: string[] = [];
    page.on('dialog', async dialog => {
      confirmations.push(dialog.message());
      await dialog.dismiss();
    });
    const schedulePosts: string[] = [];
    page.on('request', posted => {
      const path = new URL(posted.url()).pathname;
      if (posted.method() === 'POST' && path.startsWith('/api/schedule/')) schedulePosts.push(path);
    });
    await page.goto(`/#/${project.id}/gantt`);
    const search = page.getByLabel('간트 업무 검색', { exact: true });
    await expect(search).toBeVisible({ timeout: 35_000 });
    await search.fill(f.prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const endDate = (issue: Issue) => chart.getByLabel(`${issue.key} 종료일`, { exact: true });
    const saveDate = (issue: Issue) => chart.getByRole('button', { name: `${issue.key} 날짜 저장`, exact: true });
    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    const button = (name: string) => dialog.getByRole('button', { name, exact: true });
    const dateDrafts = dialog.getByRole('region', { name: '간트 날짜 초안', exact: true });
    const include = (issue: Issue) => dateDrafts.getByRole('checkbox', { name: `${issue.key} 날짜 초안 포함`, exact: true });
    const previewButton = button('연결 미리보기');
    const apply = button('날짜와 선후행 연결 적용');

    for (const issue of chain) await chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }).check();
    await endDate(first).fill(changes.endDate);
    await endDate(second).fill(changes.endDate);
    await endDate(unrelated).fill(unrelatedEnd);
    await expect(saveDate(unrelated)).toBeVisible();
    await page.getByRole('button', { name: '선후행 일괄 연결', exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(confirmations).toEqual([]);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await dialog.getByRole('combobox', { name: '연결 방식', exact: true }).selectOption('chain');
    await expect(include(first)).toBeChecked();
    await expect(include(second)).toBeChecked();
    await expect(include(third)).toHaveCount(0);
    await expect(include(unrelated)).toHaveCount(0);

    async function preview(currentFirst: Issue) {
      const pending = nextPost(page, previewPath);
      await previewButton.click();
      const response = await pending;
      const input = response.request().postDataJSON() as ScheduleBulkChainInput;
      expect(input).toEqual({ mode: 'chain', projectId: project.id, issues: [currentFirst, second, third].map(reference), type: 'FS', lagDays: 0,
        dates: expect.arrayContaining([currentFirst, second].map(issue => ({ issue: reference(issue), changes }))),
      });
      expect(input.dates).toHaveLength(2);
      const result = await readJson<SchedulePastePreview>(response);
      expect(result.previewId).toBeTruthy();
      expect(result.errors).toEqual([]);
      expect(result.changes).toHaveLength(2);
      expect(result.changes).toEqual(expect.arrayContaining([currentFirst, second].map(issue => expect.objectContaining({
        id: issue.id, version: issue.version, fromEnd: issue.endDate, toEnd: changes.endDate,
      }))));
      expect(result.dependencyChanges).toEqual([
        expect.objectContaining({ predecessorKey: first.key, successorKey: second.key, before: null }),
        expect.objectContaining({ predecessorKey: second.key, successorKey: third.key, before: null }),
      ]);
      expect(result.warnings).toEqual([expect.stringContaining(`${projectedWarning} ·`)]);
      expect(result.warnings[0]).toContain(date(20));
      const warning = dialog.getByRole('region', { name: '일정 검토 경고', exact: true });
      await expect(warning.getByRole('listitem')).toHaveText(result.warnings[0]);
      const dateRows = dialog.getByRole('table', { name: '선택 업무 날짜 변경 목록', exact: true }).getByRole('row');
      for (const issue of [currentFirst, second]) {
        const row = dateRows.filter({ hasText: issue.key });
        await expect(row).toContainText(issue.endDate!);
        await expect(row).toContainText(changes.endDate);
      }
      await expect(dateRows.filter({ hasText: unrelated.key })).toHaveCount(0);
      await expect(apply).toBeEnabled();
      return result.previewId;
    }

    const stalePreview = await preview(first);
    const latestFirst = await readJson<Issue>(await request.patch(`/api/issues/${first.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: first.version, endDate: date(16) },
    }));
    const staleApply = nextPost(page, applyPath);
    await apply.click();
    const rejected = await staleApply;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON()).toEqual({ previewId: stalePreview });
    await expect(apply).toBeDisabled();
    const beforeApply = await stores();
    expect(beforeApply.links).toEqual([]);
    for (const issue of [latestFirst, second, third, unrelated]) expect(beforeApply.issues.get(issue.id)).toEqual(issue);

    await button('새로고침').click();
    const replace = dateDrafts.getByRole('checkbox', { name: `${first.key} 최신 날짜에 내 초안 적용`, exact: true });
    await expect(replace).not.toBeChecked();
    await expect(previewButton).toBeDisabled();
    await replace.check();
    const currentPreview = await preview(latestFirst);
    expect(currentPreview).not.toBe(stalePreview);

    const applying = nextPost(page, applyPath);
    await apply.click();
    const response = await applying;
    expect(response.request().postDataJSON()).toEqual({ previewId: currentPreview });
    const applied = await readJson<SchedulePasteApplyResult>(response);
    expect(applied.dependencyChanges).toBe(2);
    expect(applied.updated).toHaveLength(2);
    expect(applied.warnings).toEqual([expect.stringContaining(projectedWarning)]);
    const afterApply = await stores();
    const links = [[first, second], [second, third]].map(([predecessor, successor]) => expect.objectContaining({
      predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0,
    }));
    expect(afterApply.links).toHaveLength(2);
    expect(afterApply.links).toEqual(expect.arrayContaining(links));
    for (const issue of [latestFirst, second]) {
      const expected = { id: issue.id, startDate: issue.startDate, ...changes, version: issue.version + 1 };
      expect(applied.updated.find(row => row.id === issue.id)).toMatchObject(expected);
      expect(afterApply.issues.get(issue.id)).toMatchObject(expected);
    }
    for (const issue of [third, unrelated]) expect(afterApply.issues.get(issue.id)).toEqual(issue);
    await expect(dialog).toHaveCount(0);
    for (const issue of [first, second]) await expect(saveDate(issue)).toHaveCount(0);
    await expect(saveDate(unrelated)).toBeVisible();
    await expect(endDate(unrelated)).toHaveValue(unrelatedEnd);

    const undoing = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await undoing;
    expect(undone.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    expect(await readJson<SchedulePasteApplyResult>(undone)).toMatchObject({ dependencyChanges: 2, updated: expect.arrayContaining([
      expect.objectContaining({ id: first.id, endDate: latestFirst.endDate }),
      expect.objectContaining({ id: second.id, endDate: second.endDate }),
    ]) });
    const afterUndo = await stores();
    expect(afterUndo.links).toEqual([]);
    for (const issue of [latestFirst, second]) {
      expect(afterUndo.issues.get(issue.id)).toMatchObject({ startDate: issue.startDate, endDate: issue.endDate, version: issue.version + 2 });
      await expect(endDate(issue)).toHaveValue(issue.endDate!);
      await expect(saveDate(issue)).toHaveCount(0);
    }
    expect(afterUndo.issues.get(unrelated.id)).toEqual(unrelated);
    await expect(endDate(unrelated)).toHaveValue(unrelatedEnd);
    await expect(saveDate(unrelated)).toBeVisible();
    expect(confirmations).toEqual([]);
    expect(schedulePosts).toEqual([previewPath, applyPath, previewPath, applyPath, undoPath]);
  } finally {
    await f.close();
  }
});

test('360px 간트의 공통 기준 연결에서 고른 기준의 날짜만 저장하고 제외한 초안을 유지한다', async ({ page, request }) => {
  const { projects: [project], users: [actor] } = await workspace(request);
  const f = fixture(request);
  try {
    const anchor = await f.create(project.id, '공통 기준 업무', { startDate: '2026-11-16', endDate: '2026-11-17' });
    const alternative = await f.create(project.id, '다른 기준 업무');
    const first = await f.create(project.id, '선택 대상 첫 업무');
    const second = await f.create(project.id, '선택 대상 둘째 업무');
    const anchorEnd = '2026-11-18';
    const excludedEnd = '2026-11-25';

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/gantt`);
    const search = page.getByLabel('간트 업무 검색', { exact: true });
    await expect(search).toBeVisible({ timeout: 35_000 });
    await search.fill(f.prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const endDate = (issue: Issue) => chart.getByLabel(`${issue.key} 종료일`, { exact: true });
    const saveDate = (issue: Issue) => chart.getByRole('button', { name: `${issue.key} 날짜 저장`, exact: true });
    for (const issue of [first, second]) await chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }).check();
    await endDate(anchor).fill(anchorEnd);
    await endDate(first).fill(excludedEnd);
    await search.fill(`${f.prefix} 선택 대상`);
    await page.getByRole('button', { name: '선후행 일괄 연결', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    const drafts = dialog.getByRole('region', { name: '간트 날짜 초안', exact: true });
    const include = (issue: Issue) => drafts.getByRole('checkbox', { name: `${issue.key} 날짜 초안 포함`, exact: true });
    const chooseAnchor = async (issue: Issue) => {
      await dialog.getByLabel('기준 업무 검색', { exact: true }).fill(issue.key);
      await dialog.getByRole('button', { name: `${issue.key} ${issue.title}`, exact: true }).click();
    };
    await expect(dialog.getByRole('combobox', { name: '연결 방식', exact: true })).toHaveValue('anchor');
    await expect(include(first)).toBeChecked();
    await include(first).uncheck();
    await chooseAnchor(anchor);
    await expect(include(anchor)).toBeChecked();
    await chooseAnchor(alternative);
    await expect(include(anchor)).toHaveCount(0);
    await expect(include(first)).not.toBeChecked();
    await chooseAnchor(anchor);
    await expect(include(anchor)).toBeChecked();

    const previewing = nextPost(page, previewPath);
    await dialog.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const response = await previewing;
    expect(response.request().postDataJSON()).toEqual({
      projectId: project.id, anchor: reference(anchor), issues: [first, second].map(reference),
      direction: 'predecessor', type: 'FS', lagDays: 0, dates: [{ issue: reference(anchor), changes: { endDate: anchorEnd } }],
    });
    const preview = await readJson<SchedulePastePreview>(response);
    expect(preview.changes).toEqual([expect.objectContaining({ id: anchor.id, fromEnd: anchor.endDate, toEnd: anchorEnd })]);
    const applying = nextPost(page, applyPath);
    await dialog.getByRole('button', { name: '날짜와 선후행 연결 적용', exact: true }).click();
    const applied = await applying;
    expect(applied.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    expect(await readJson<SchedulePasteApplyResult>(applied)).toMatchObject({ dependencyChanges: 2,
      updated: [expect.objectContaining({ id: anchor.id, endDate: anchorEnd })],
    });
    await expect(dialog).toHaveCount(0);
    await expect(endDate(first)).toHaveValue(excludedEnd);
    await expect(saveDate(first)).toBeVisible();
    await expect(saveDate(anchor)).toHaveCount(0);
    const { issues, dependencies } = await workspace(request);
    expect(issues.find(issue => issue.id === first.id)).toEqual(first);
    expect(dependencies.filter(link => link.predecessorId === anchor.id).map(link => link.successorId).sort()).toEqual([first.id, second.id].sort());
  } finally {
    await f.close();
  }
});

test('전체 프로젝트 간트에서 다른 프로젝트를 함께 고르면 안내하고 같은 프로젝트 업무를 순서대로 연결한다', async ({ page, request }) => {
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

    await trigger.click();
    await dialog.getByRole('combobox', { name: '연결 방식', exact: true }).selectOption('chain');
    const previewing = nextPost(page, previewPath);
    await dialog.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const preview = await readJson<SchedulePastePreview>(await previewing);
    expect(preview.dependencyChanges).toEqual([expect.objectContaining({ predecessorKey: first.key, successorKey: second.key })]);
    const applying = nextPost(page, applyPath);
    await dialog.getByRole('button', { name: '검토한 연결 적용', exact: true }).click();
    const applied = await readJson<SchedulePasteApplyResult>(await applying);
    expect(applied).toMatchObject({ updated: [], dependencyChanges: 1 });
    await expect(dialog).toHaveCount(0);
    const links = async () => (await workspace(request)).dependencies.filter(link =>
      [first.id, second.id, anchor.id, other.id].includes(link.predecessorId));
    expect(await links()).toEqual([expect.objectContaining({ predecessorId: first.id, successorId: second.id, type: 'FS', lagDays: 0 })]);
    const undoing = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undoResponse = await undoing;
    expect(undoResponse.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    expect(await readJson<SchedulePasteApplyResult>(undoResponse)).toMatchObject({ updated: [], dependencyChanges: 1 });
    expect(await links()).toEqual([]);
  } finally {
    await f.close();
  }
});

test('360px 간트에서 선택한 업무 순서를 지켜 선후행 연결을 추가하고 새 연결만 되돌린다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const f = fixture(request);
  const project = await readJson<Project>(await request.post('/api/projects', { data: {
    key: `LC${randomUUID().slice(0, 8).toUpperCase()}`, name: f.prefix,
  } }), 201);
  const [actor, peer] = (await workspace(request)).users;
  try {
    const first = await f.create(project.id, '첫 업무');
    const second = await f.create(project.id, '둘째 업무');
    const third = await f.create(project.id, '셋째 업무');
    const fourth = await f.create(project.id, '넷째 업무');
    const chartOrder = [first, second, third, fourth];
    const chain = [first, fourth, second, third];
    const createLink = (predecessor: Issue, successor: Issue, type: Dependency['type'], lagDays: number) =>
      request.post('/api/dependencies', { data: { predecessorId: predecessor.id, successorId: successor.id, type, lagDays } })
        .then(response => readJson<Dependency>(response, 201));
    const retained = await createLink(fourth, second, 'SS', -2);
    const outsideChain = await createLink(first, third, 'FF', 1);
    const currentLinks = async () => (await workspace(request)).dependencies
      .filter(link => chartOrder.some(issue => issue.id === link.predecessorId));
    const expectOriginalLinks = async () => {
      const links = await currentLinks();
      expect(links).toHaveLength(2);
      expect(links).toEqual(expect.arrayContaining([retained, outsideChain]));
    };

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/gantt`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const chartRows = chart.locator('.gantt-row[data-issue-id]');
    await expect(chartRows).toHaveCount(4, { timeout: 35_000 });
    expect(await chartRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-issue-id')))).toEqual(chartOrder.map(issue => issue.id));
    for (const issue of [...chartOrder].reverse()) await chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '선후행 일괄 연결', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const mode = dialog.getByRole('combobox', { name: '연결 방식', exact: true });
    await expect(mode).toHaveValue('chain');
    await expect(mode.getByRole('option', { name: '공통 기준 업무 연결', exact: true })).toHaveJSProperty('disabled', true);
    await expect(dialog.getByLabel('기준 업무 검색', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('연결 유형', { exact: true })).toHaveValue('FS');
    await expect(dialog.getByLabel('근무일 간격', { exact: true })).toHaveValue('0');

    const order = dialog.getByRole('list', { name: '선후행 연결 순서', exact: true });
    const orderRows = order.getByRole('listitem');
    async function expectOrder(issues: Issue[]) {
      await expect(orderRows).toHaveCount(issues.length);
      for (const [index, issue] of issues.entries()) await expect(orderRows.nth(index)).toContainText(issue.key);
    }
    const move = (issue: Issue, direction: '위로' | '아래로') =>
      order.getByRole('button', { name: `${issue.key} ${direction} 이동`, exact: true });
    await expectOrder(chartOrder);
    await expect(move(first, '위로')).toBeDisabled();
    await expect(move(fourth, '아래로')).toBeDisabled();
    await move(fourth, '위로').click();
    await expectOrder([first, second, fourth, third]);
    await move(second, '아래로').click();
    await expectOrder(chain);

    const preview = dialog.getByRole('button', { name: '연결 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '검토한 연결 적용', exact: true });
    async function previewChain(issues: Issue[]) {
      const pending = nextPost(page, previewPath);
      await preview.click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({ mode: 'chain', projectId: project.id, issues: issues.map(reference), type: 'FS', lagDays: 0 });
      const value = await readJson<SchedulePastePreview>(response);
      expect(value.previewId).toBeTruthy();
      expect(value.errors).toEqual([]);
      expect(value.changes).toEqual([]);
      expect(value.unchanged).toBe(1);
      expect(value.retainedDependencies).toEqual([expect.objectContaining({
        predecessorKey: fourth.key, successorKey: second.key, before: { type: 'SS', lagDays: -2 }, after: { type: 'SS', lagDays: -2 },
      })]);
      expect(value.dependencyChanges).toHaveLength(2);
      expect(value.dependencyChanges).toEqual(expect.arrayContaining([[first, fourth], [second, third]].map(([before, after]) =>
        expect.objectContaining({ predecessorKey: before.key, successorKey: after.key, before: null, after: { type: 'FS', lagDays: 0 } }))));
      await expect(dialog.getByRole('table', { name: '유지할 선후행 연결 목록', exact: true })).toContainText(fourth.key);
      await expect(dialog.getByRole('table', { name: '새 선후행 연결 목록', exact: true })).toContainText(third.key);
      return value.previewId;
    }

    const stalePreview = await previewChain(chain);
    await expectOriginalLinks();
    const revised = await readJson<Issue>(await request.patch(`/api/issues/${fourth.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: fourth.version, title: `${fourth.title} 동료 수정` },
    }));
    const rejected = nextPost(page, applyPath);
    await apply.click();
    const rejection = await rejected;
    expect(rejection.status()).toBe(409);
    expect(rejection.request().postDataJSON()).toEqual({ previewId: stalePreview });
    await expect(dialog.getByText('다시 검토 필요', { exact: true })).toBeVisible();
    await expect(apply).toBeDisabled();
    await expectOriginalLinks();

    await dialog.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(order).toContainText(revised.title);
    await expectOrder(chain);
    await expect(mode).toHaveValue('chain');
    const currentPreview = await previewChain([first, revised, second, third]);
    expect(currentPreview).not.toBe(stalePreview);
    const beforeApply = await f.stored();
    const applying = nextPost(page, applyPath);
    await apply.click();
    const applied = await readJson<SchedulePasteApplyResult>(await applying);
    expect(applied).toMatchObject({ updated: [], dependencyChanges: 2 });
    await expect(dialog).toHaveCount(0);
    const added = await currentLinks();
    expect(added).toHaveLength(4);
    expect(added).toEqual(expect.arrayContaining([retained, outsideChain,
      expect.objectContaining({ predecessorId: first.id, successorId: fourth.id, type: 'FS', lagDays: 0 }),
      expect.objectContaining({ predecessorId: second.id, successorId: third.id, type: 'FS', lagDays: 0 }),
    ]));
    expect(await f.stored()).toEqual(beforeApply);

    const undoing = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undoResponse = await undoing;
    expect(undoResponse.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    expect(await readJson<SchedulePasteApplyResult>(undoResponse)).toMatchObject({ updated: [], dependencyChanges: 2 });
    await expectOriginalLinks();
    expect(await f.stored()).toEqual(beforeApply);
  } finally {
    await f.close();
  }
});
