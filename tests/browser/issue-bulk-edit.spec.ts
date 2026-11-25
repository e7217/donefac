import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type { Issue, IssueAssignmentRule, IssueBulkEditChanges, IssueBulkEditPreview, PlanningItem, PlanningKind, Project, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function responseAt(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function removeIssues(request: APIRequestContext, issues: Issue[]) {
  for (const issue of issues) {
    const archived = await request.delete(`/api/issues/${issue.id}`);
    if (archived.ok()) {
      const { trashEntryId } = await archived.json();
      await request.delete(`/api/trash/${trashEntryId}`);
    }
  }
}

test('360px 담당자별 프로젝트 보드에서 보이는 카드를 골라 한 번에 상태와 우선순위를 변경한다', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [owner, reviewer] } = await workspace(request);
  const prefix = `보드-일괄-${randomUUID().slice(0, 8)}`;
  const bulkPath = `/api/projects/${project.id}/issues/bulk`;
  const created: Issue[] = [];

  try {
    for (const [name, assigneeId] of [['대상 하나', owner.id], ['대상 둘', reviewer.id], ['보류', owner.id]]) {
      const response = await request.post('/api/issues', { data: { title: `${prefix} ${name}`, projectId: project.id,
        status: 'todo', priority: 'medium', assigneeId } });
      expect(response.status(), await response.text()).toBe(201);
      created.push(await response.json());
    }
    const [first, second, hidden] = created;
    const beforeOrder = (await workspace(request)).issueOrders?.find(order => order.projectId === project.id)?.issueIds;
    expect(beforeOrder).toBeDefined();
    await page.goto(`/#/${project.id}/issues`);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await expect(search).toBeVisible({ timeout: 24_000 });
    await search.fill(prefix);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await page.getByRole('combobox', { name: '보드 그룹', exact: true }).selectOption('assignee');
    const board = page.getByRole('region', { name: '담당자별 보드', exact: true });
    const select = (issue: Issue) => board.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });
    const toggle = page.getByRole('button', { name: '일괄 편집', exact: true });
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    const selectVisible = page.getByRole('checkbox', { name: '표시된 업무 전체 선택', exact: true });
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await toggle.click();
    await expect(selectVisible).toBeFocused();
    await select(hidden).check();
    await select(first).check();
    await expect(board.locator(`[data-issue-id="${first.id}"]`)).toHaveAttribute('draggable', 'false');
    await expect(board.getByRole('button', { name: `${first.key} 상태 변경`, exact: true })).toHaveCount(0);

    await search.fill(`${prefix} 대상`);
    await expect(select(hidden)).toHaveCount(0);
    await expect(select(first)).toBeChecked();
    await expect(select(second)).not.toBeChecked();
    await selectVisible.check();
    await expect(select(second)).toBeChecked();
    await editor.getByRole('combobox', { name: '일괄 변경 상태', exact: true }).selectOption('review');
    await editor.getByRole('combobox', { name: '일괄 변경 우선순위', exact: true }).selectOption('high');
    const previewResponse = responseAt(page, `${bulkPath}-preview`);
    await editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const preview = await previewResponse;
    expect(preview.status(), await preview.text()).toBe(200);
    const { rows } = await preview.json() as IssueBulkEditPreview;
    expect(new Set(rows.map(row => row.id))).toEqual(new Set([first.id, second.id]));

    const appliedResponse = responseAt(page, `${bulkPath}-apply`);
    await editor.getByRole('button', { name: '일괄 적용', exact: true }).click();
    const applied = await appliedResponse;
    expect(applied.status(), await applied.text()).toBe(200);
    for (const issue of [first, second]) {
      const lane = board.locator(`[data-board-assignee-id="${issue.assigneeId}"]`);
      await expect(lane.locator(`[data-status-id="review"] [data-issue-id="${issue.id}"]`)).toBeVisible();
    }
    await editor.getByRole('button', { name: '일괄 편집 닫기', exact: true }).click();
    await expect(toggle).toBeFocused();
    await expect(search).toHaveValue(`${prefix} 대상`);
    await expect(board.getByRole('button', { name: `${first.key} 상태 변경`, exact: true })).toBeVisible();
    const saved = await workspace(request);
    expect(saved.issues.find(issue => issue.id === hidden.id)).toEqual(hidden);
    expect(saved.issueOrders?.find(order => order.projectId === project.id)?.issueIds).toEqual(beforeOrder);
    for (const issue of [first, second]) expect(saved.issues.find(value => value.id === issue.id)).toMatchObject({
      version: issue.version + 1, status: 'review', priority: 'high', assigneeId: issue.assigneeId,
    });
  } finally {
    await removeIssues(request, created);
  }
});

test('360px에서 검색 결과만 일괄 편집하고 응답 유실 뒤 같은 미리보기의 적용 결과를 확인한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const initial = await workspace(request);
  const project = initial.projects[0];
  const reviewer = initial.users[1];
  const prefix = `일괄-${randomUUID().slice(0, 8)}`;
  const rulesPath = `/api/projects/${project.id}/assignment-rules`;
  const bulkPath = `/api/projects/${project.id}/issues/bulk`;
  const issues: Issue[] = [];
  let rule: IssueAssignmentRule | undefined;

  try {
    for (const title of [`${prefix} 대상 하나`, `${prefix} 대상 둘`, `${prefix} 보관`]) {
      const response = await request.post('/api/issues', { data: { title, projectId: project.id, status: 'todo', priority: 'medium' } });
      expect(response.status(), await response.text()).toBe(201);
      issues.push(await response.json());
    }
    const ruleResponse = await request.post(rulesPath, { data: {
      name: `${prefix} 검토 배정`, enabled: true, mode: 'unassigned', priority: 0, fromStatuses: ['todo'], toStatusId: 'review',
      issueTypes: [], assigneeId: reviewer.id,
    } });
    expect(ruleResponse.status(), await ruleResponse.text()).toBe(201);
    rule = await ruleResponse.json();

    const [first, second, hidden] = issues;
    await page.goto(`/#/${project.id}/issues`);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await expect(search).toBeVisible({ timeout: 24_000 });
    await search.fill(prefix);
    await page.getByRole('button', { name: '일괄 편집', exact: true }).click();
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    await expect(editor).toBeVisible();
    const editorBounds = await editor.boundingBox();
    expect(editorBounds).not.toBeNull();
    expect(editorBounds!.x).toBeGreaterThanOrEqual(0);
    expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(360);

    const selected = (issue: Issue) => page.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });
    const previewButton = editor.getByRole('button', { name: '변경 미리보기', exact: true });
    const previewRegion = page.getByRole('region', { name: '일괄 변경 미리보기', exact: true });
    await selected(hidden).check();
    const priority = editor.getByRole('combobox', { name: '일괄 변경 우선순위', exact: true });
    await priority.selectOption('high');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(selected(hidden)).toBeChecked();
    await expect(priority).toHaveValue('high');

    const firstResponse = responseAt(page, `${bulkPath}-preview`);
    await previewButton.click();
    const responseForHidden = await firstResponse;
    expect(responseForHidden.status(), await responseForHidden.text()).toBe(200);
    expect((await responseForHidden.json() as IssueBulkEditPreview).rows.map(row => row.id)).toEqual([hidden.id]);
    await expect(previewRegion).toContainText(hidden.key);

    await search.fill(`${prefix} 대상`);
    await expect(selected(hidden)).toHaveCount(0);
    await expect(previewRegion).toHaveCount(0);
    await expect(previewButton).toBeDisabled();
    await expect(priority).toHaveValue('high');
    await page.getByRole('checkbox', { name: '검색 결과 전체 선택', exact: true }).check();
    await expect(selected(first)).toBeChecked();
    await expect(selected(second)).toBeChecked();
    await editor.getByRole('combobox', { name: '일괄 변경 상태', exact: true }).selectOption('review');

    const filteredResponse = responseAt(page, `${bulkPath}-preview`);
    await previewButton.click();
    const filtered = await filteredResponse;
    expect(filtered.status(), await filtered.text()).toBe(200);
    const preview = await filtered.json() as IssueBulkEditPreview;
    expect(preview.changed).toBe(2);
    expect(new Set(preview.rows.map(row => row.id))).toEqual(new Set([first.id, second.id]));
    for (const row of preview.rows) expect(row.after).toEqual({ status: 'review', priority: 'high', assigneeId: reviewer.id });
    await expect(previewRegion).toContainText(first.key);
    await expect(previewRegion).toContainText(second.key);
    await expect(previewRegion).toContainText(reviewer.name);
    await expect(previewRegion).not.toContainText(hidden.key);
    expect((await workspace(request)).issues.filter(issue => issues.some(original => original.id === issue.id)))
      .toEqual(expect.arrayContaining(issues));

    const attempted: unknown[] = [];
    await page.route(`**${bulkPath}-apply`, async route => {
      attempted.push(route.request().postDataJSON());
      const committed = await route.fetch();
      if (attempted.length === 1 && committed.ok()) {
        await route.fulfill({ status: 502, json: { error: '합성 일괄 편집 응답 유실' } });
      } else {
        await route.fulfill({ response: committed });
      }
    });
    const firstApply = responseAt(page, `${bulkPath}-apply`);
    await page.getByRole('button', { name: '일괄 적용', exact: true }).click();
    expect((await firstApply).status()).toBe(502);
    await expect(editor.getByRole('alert')).toContainText('적용 결과를 확인하지 못했습니다');
    const receiptResponse = responseAt(page, `${bulkPath}-apply`);
    await page.getByRole('button', { name: '적용 결과 다시 확인', exact: true }).click();
    const applied = await receiptResponse;
    expect(applied.status(), await applied.text()).toBe(200);
    expect(attempted).toEqual([{ previewId: preview.previewId }, { previewId: preview.previewId }]);
    await expect(previewRegion).toHaveCount(0);
    const final = (await workspace(request)).issues;
    for (const issue of [first, second]) {
      expect(final.find(item => item.id === issue.id)).toMatchObject({
        version: issue.version + 1, status: 'review', priority: 'high', assigneeId: reviewer.id,
      });
    }
    expect(final.find(issue => issue.id === hidden.id)).toEqual(hidden);
  } finally {
    if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`);
    await removeIssues(request, issues);
  }
});

test('360px에서 마감일과 라벨 변경을 검토하고 충돌 뒤 전체를 다시 적용한다', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const initial = await workspace(request);
  const project = initial.projects[0];
  const otherEditor = initial.users[1];
  const prefix = `마감-라벨-${randomUUID().slice(0, 8)}`;
  const bulkPath = `/api/projects/${project.id}/issues/bulk`;
  const issues: Issue[] = [];
  const oldDate = '2030-05-15';
  const newDate = '2030-06-24';
  const oldLabel = '검토, 이번 차수';
  const newLabel = '정리 완료';
  const sharedLabel = '팀 공통';

  async function stored(issue: Issue) {
    return (await workspace(request)).issues.find(current => current.id === issue.id);
  }

  try {
    for (const data of [
      { title: `${prefix} 대상 하나`, dueDate: oldDate, labels: ['유지-A', oldLabel, sharedLabel] },
      { title: `${prefix} 대상 둘`, dueDate: null, labels: ['유지-B', oldLabel] },
      { title: `${prefix} 보관`, dueDate: oldDate, labels: ['유지-C', oldLabel] },
    ]) {
      const response = await request.post('/api/issues', { data: { ...data, projectId: project.id, status: 'todo' } });
      expect(response.status(), await response.text()).toBe(201);
      issues.push(await response.json());
    }
    const [first, second, hidden] = issues;
    const selected = (issue: Issue) => page.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });
    await page.goto(`/#/${project.id}/issues`);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await expect(search).toBeVisible({ timeout: 24_000 });
    await search.fill(`${prefix} 대상`);
    await page.getByRole('button', { name: '일괄 편집', exact: true }).click();
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    await page.getByRole('checkbox', { name: '검색 결과 전체 선택', exact: true }).check();
    await expect(selected(first)).toBeChecked();
    await expect(selected(second)).toBeChecked();
    await expect(selected(hidden)).toHaveCount(0);

    const dateMode = editor.getByRole('combobox', { name: '일괄 변경 마감일', exact: true });
    const dateInput = editor.getByLabel('지정할 마감일', { exact: true });
    const addLabels = editor.getByRole('textbox', { name: '추가할 라벨', exact: true });
    const removeLabel = editor.getByRole('checkbox', { name: `"${oldLabel}" 라벨 제거`, exact: true });
    await dateMode.selectOption('set');
    await dateInput.fill(newDate);
    await addLabels.fill(`${newLabel}, ${sharedLabel}`);
    await editor.getByText('제거할 라벨 선택', { exact: true }).click();
    await removeLabel.check();

    const previewRegion = editor.getByRole('region', { name: '일괄 변경 미리보기', exact: true });
    const previewButton = editor.getByRole('button', { name: '변경 미리보기', exact: true });
    async function review() {
      const responded = responseAt(page, `${bulkPath}-preview`);
      await previewButton.click();
      const response = await responded;
      expect(response.status(), await response.text()).toBe(200);
      return response.json() as Promise<IssueBulkEditPreview>;
    }
    async function apply(status: 200 | 409) {
      const responded = responseAt(page, `${bulkPath}-apply`);
      await previewRegion.getByRole('button', { name: '일괄 적용', exact: true }).click();
      const response = await responded;
      expect(response.status(), await response.text()).toBe(status);
    }

    const preview = await review();
    expect(preview.previewId).toBeTruthy();
    expect({ changed: preview.changed, blocked: preview.blocked, unchanged: preview.unchanged }).toEqual({ changed: 2, blocked: 0, unchanged: 0 });
    const firstLabels = ['유지-A', sharedLabel, newLabel];
    const secondLabels = ['유지-B', newLabel, sharedLabel];
    expect(preview.rows.map(row => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(preview.rows.find(row => row.id === first.id)).toMatchObject({
      before: { dueDate: oldDate, labels: first.labels }, after: { dueDate: newDate, labels: firstLabels },
    });
    expect(preview.rows.find(row => row.id === second.id)).toMatchObject({
      before: { dueDate: null, labels: second.labels }, after: { dueDate: newDate, labels: secondLabels },
    });
    const firstReviewRow = previewRegion.getByRole('listitem').filter({ has: page.getByText(`${first.key} ${first.title}`, { exact: true }) });
    await expect(firstReviewRow).toContainText(`${oldDate} → ${newDate}`);
    await expect(firstReviewRow).toContainText(`유지-A, "${oldLabel}", ${sharedLabel} → 유지-A, ${sharedLabel}, ${newLabel}`);
    await expect(previewRegion).not.toContainText(hidden.key);
    for (const issue of issues) expect(await stored(issue)).toEqual(issue);

    const concurrentLabel = '동시에 붙인 라벨';
    const modified = await request.patch(`/api/issues/${second.id}`, {
      headers: { 'X-Actor-Id': otherEditor.id },
      data: { expectedVersion: second.version, labels: [...second.labels, concurrentLabel] },
    });
    expect(modified.status(), await modified.text()).toBe(200);
    const newSecond = await modified.json() as Issue;
    await apply(409);
    await expect(editor.getByRole('alert')).toContainText('변경되었습니다');
    await expect(previewRegion).toHaveCount(0);
    await expect(dateMode).toHaveValue('set');
    await expect(dateInput).toHaveValue(newDate);
    await expect(addLabels).toHaveValue(`${newLabel}, ${sharedLabel}`);
    await expect(removeLabel).toBeChecked();
    expect(await stored(first)).toEqual(first);
    expect(await stored(second)).toEqual(newSecond);
    expect(await stored(hidden)).toEqual(hidden);

    await editor.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(previewButton).toBeEnabled();
    const reviewedAgain = await review();
    expect(reviewedAgain.previewId).toBeTruthy();
    expect(reviewedAgain.previewId).not.toBe(preview.previewId);
    const refreshedSecondLabels = ['유지-B', concurrentLabel, newLabel, sharedLabel];
    expect(reviewedAgain.rows.find(row => row.id === second.id)?.after?.labels).toEqual(refreshedSecondLabels);
    await apply(200);
    await expect(previewRegion).toHaveCount(0);
    expect(await stored(first)).toMatchObject({ dueDate: newDate, labels: firstLabels, version: first.version + 1 });
    expect(await stored(second)).toMatchObject({ dueDate: newDate, labels: refreshedSecondLabels, version: second.version + 2 });
    expect(await stored(hidden)).toEqual(hidden);

    await selected(first).check();
    await dateMode.selectOption('clear');
    await expect(dateInput).toHaveCount(0);
    const cleared = await review();
    expect(cleared.rows).toHaveLength(1);
    expect(cleared.rows[0]).toMatchObject({ id: first.id, before: { dueDate: newDate }, after: { dueDate: null } });
    expect(cleared.rows[0].before).not.toHaveProperty('labels');
    expect(cleared.rows[0].after).not.toHaveProperty('labels');
    await expect(previewRegion).toContainText(`${newDate} → 미지정`);
    await apply(200);
    await expect(previewRegion).toHaveCount(0);
    expect(await stored(first)).toMatchObject({ dueDate: null, labels: firstLabels, version: first.version + 2 });
    expect(await stored(second)).toMatchObject({ dueDate: newDate, labels: refreshedSecondLabels, version: second.version + 2 });
    expect(await stored(hidden)).toEqual(hidden);
  } finally {
    await removeIssues(request, issues);
  }
});

test('360px에서 이동 전 키로 상위 업무를 찾아 일괄 지정하고 계층을 확인한 뒤 해제한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, source], users: [actor, teammate] } = await workspace(request);
  const prefix = `상위 지정 ${randomUUID().slice(0, 8)}`;
  const bulkPath = `/api/projects/${project.id}/issues/bulk`;
  const headers = { 'X-Actor-Id': actor.id };
  const dates = { startDate: '2030-05-13', endDate: '2030-05-16', dueDate: '2030-05-20' };
  const created: Issue[] = [];

  async function create(name: string, options: Partial<Pick<Issue, 'projectId' | 'parentId'>> = {}) {
    const response = await request.post('/api/issues', { headers, data: {
      projectId: project.id, status: 'backlog', title: `${prefix} ${name}`, ...dates, ...options,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  try {
    const original = await create('이동할 상위', { projectId: source.id });
    const movePath = `/api/issues/${original.id}/project-move`;
    const move: IssueProjectMoveInput = { expectedVersion: original.version, projectId: project.id, includeConnected: false,
      mappings: [{ issueId: original.id, status: original.status, type: original.type }] };
    const proposed = await request.post(`${movePath}/preview`, { headers, data: move });
    expect(proposed.status(), await proposed.text()).toBe(200);
    const { token, blockers } = await proposed.json() as IssueProjectMovePreview;
    expect(blockers).toEqual([]);
    expect(token).toBeTruthy();
    const moved = await request.post(`${movePath}/apply`, { headers, data: { ...move, token } });
    expect(moved.status(), await moved.text()).toBe(200);
    const { issues: [parent] } = await moved.json() as IssueProjectMoveResult;
    expect(parent).toMatchObject({ id: original.id, projectId: project.id });
    expect(parent.key).not.toBe(original.key);

    const formerParent = await create('기존 상위');
    const first = await create('선택할 업무 하나', { parentId: formerParent.id });
    const second = await create('선택할 업무 둘');
    const descendant = await create('함께 유지할 하위', { parentId: first.id });
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    const list = page.getByRole('region', { name: '업무 목록', exact: true });
    const previewRegion = editor.getByRole('region', { name: '일괄 변경 미리보기', exact: true });
    const previewButton = editor.getByRole('button', { name: '변경 미리보기', exact: true });
    const parentMode = editor.getByRole('combobox', { name: '일괄 변경 상위 업무', exact: true });
    const parentSearch = editor.getByRole('searchbox', { name: '상위 업무 검색', exact: true });
    const candidates = editor.getByRole('list', { name: '상위 업무 후보', exact: true });
    const rowReference = (issue: Issue) => ({ id: issue.id, key: issue.key, title: issue.title });
    const issueRow = (issue: Issue) => list.locator(`[data-issue-id="${issue.id}"]`);
    const previewRow = (issue: Issue) => previewRegion.getByRole('listitem').filter({ has: page.getByText(`${issue.key} ${issue.title}`, { exact: true }) });

    async function selectChildren() {
      await page.goto(`/#/${project.id}/issues`);
      const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
      await expect(search).toBeVisible({ timeout: 24_000 });
      await search.fill(`${prefix} 선택할 업무`);
      await expect(issueRow(parent)).toHaveCount(0);
      await expect(issueRow(descendant)).toHaveCount(0);
      await page.getByRole('button', { name: '일괄 편집', exact: true }).click();
      await list.getByRole('checkbox', { name: '검색 결과 전체 선택', exact: true }).check();
      for (const issue of [first, second]) await expect(issueRow(issue).getByRole('checkbox', { name: `${issue.key} 선택`, exact: true })).toBeChecked();
    }

    async function review(parentId: string | null) {
      const posted = responseAt(page, `${bulkPath}-preview`);
      await previewButton.click();
      const response = await posted;
      expect(response.status(), await response.text()).toBe(200);
      expect(response.request().postDataJSON()).toMatchObject({ changes: { parentId } });
      const result = await response.json() as IssueBulkEditPreview;
      expect(result.previewId).toBeTruthy();
      expect({ changed: result.changed, blocked: result.blocked }).toEqual({ changed: 2, blocked: 0 });
      expect(result.rows.map(row => row.id).sort()).toEqual([first.id, second.id].sort());
      return result;
    }

    async function apply(expected: 200 | 409) {
      const posted = responseAt(page, `${bulkPath}-apply`);
      await previewRegion.getByRole('button', { name: '일괄 적용', exact: true }).click();
      const response = await posted;
      expect(response.status(), await response.text()).toBe(expected);
      await expect(previewRegion).toHaveCount(0);
    }

    async function verifyStored(parentId: string | null, versionIncrease: number) {
      const current = (await workspace(request)).issues;
      for (const issue of [first, second]) {
        expect(current.find(row => row.id === issue.id)).toMatchObject({
          ...dates, parentId, status: issue.status, version: issue.version + versionIncrease,
        });
      }
      expect(current.find(row => row.id === descendant.id)).toEqual(descendant);
      expect(current.find(row => row.id === formerParent.id)).toEqual(formerParent);
    }

    await selectChildren();
    await parentMode.selectOption('set');
    await parentSearch.fill(original.key);
    const choose = candidates.getByRole('button', { name: `${parent.key} · ${parent.title}`, exact: true });
    await expect(candidates).toContainText(`이동 전 키 ${original.key}`);
    await parentSearch.press('Enter');
    await expect(choose).toBeFocused();
    await choose.press('Enter');
    await expect(choose).toHaveAttribute('aria-pressed', 'true');
    const firstReview = await review(parent.id);
    for (const issue of [first, second]) {
      const prior = issue.id === first.id ? rowReference(formerParent) : null;
      expect(firstReview.rows.find(row => row.id === issue.id)).toMatchObject({
        before: { parentId: issue.parentId }, after: { parentId: parent.id },
        parents: { before: prior, after: rowReference(parent) },
      });
      await expect(previewRow(issue)).toContainText(`${parent.key} · ${parent.title}`);
    }
    await expect(previewRow(first)).toContainText(`${formerParent.key} · ${formerParent.title}`);
    await expect(previewRow(second)).toContainText('상위 업무 없음');

    const rename = await request.patch(`/api/issues/${parent.id}`, { headers: { 'X-Actor-Id': teammate.id },
      data: { expectedVersion: parent.version, title: `${prefix} 다른 팀원이 고친 상위` } });
    expect(rename.status(), await rename.text()).toBe(200);
    const latestParent = await rename.json() as Issue;
    await apply(409);
    await expect(editor.getByRole('alert')).toBeVisible();
    await expect(parentMode).toHaveValue('set');
    const unchanged = (await workspace(request)).issues;
    for (const issue of [first, second, descendant]) expect(unchanged.find(row => row.id === issue.id)).toEqual(issue);
    await editor.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(parentSearch).toHaveValue(original.key);
    await expect(candidates.getByRole('button', { name: `${latestParent.key} · ${latestParent.title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    const reviewedAgain = await review(parent.id);
    expect(reviewedAgain.previewId).not.toBe(firstReview.previewId);
    for (const row of reviewedAgain.rows) expect(row.parents?.after).toMatchObject(rowReference(latestParent));
    await apply(200);
    await verifyStored(parent.id, 1);

    await editor.getByRole('button', { name: '일괄 편집 닫기', exact: true }).click();
    await issueRow(first).getByRole('button', { name: new RegExp(first.title) }).click();
    const issueDetail = page.getByRole('dialog', { name: first.title, exact: true });
    await expect(issueDetail.getByRole('button', { name: `상위 업무 · ${latestParent.key} ${latestParent.title}`, exact: true })).toBeVisible();
    await issueDetail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(latestParent.title);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await chart.getByRole('checkbox', { name: `${parent.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '하위 업무 일정 보기', exact: true }).click();
    await expect(chart.locator(`[data-issue-id="${first.id}"]`)).toContainText('하위 1단계');
    await expect(chart.locator(`[data-issue-id="${second.id}"]`)).toContainText('하위 1단계');
    await expect(chart.locator(`[data-issue-id="${descendant.id}"]`)).toContainText('하위 2단계');

    await selectChildren();
    await parentMode.selectOption('clear');
    await expect(parentSearch).toHaveCount(0);
    const clearing = await review(null);
    for (const row of clearing.rows) expect(row).toMatchObject({
      before: { parentId: parent.id }, after: { parentId: null }, parents: { before: rowReference(latestParent), after: null },
    });
    await apply(200);
    await verifyStored(null, 2);
  } finally {
    await removeIssues(request, created.reverse());
  }
});

test('360px에서 사이클·모듈·릴리스를 함께 배정하고 보관 충돌 뒤 새 대상을 골라 적용한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { users: [actor, teammate] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `계획 일괄 ${suffix}`;
  const headers = { 'X-Actor-Id': actor.id };
  const startDate = new Date().toISOString().slice(0, 10);
  const endDate = new Date(Date.parse(startDate) + 4 * 86_400_000).toISOString().slice(0, 10);
  const dueDate = new Date(Date.parse(startDate) + 7 * 86_400_000).toISOString().slice(0, 10);
  const unchangedLabel = '기존 계획 표시';
  const addedLabel = '일괄 배정 검토';
  const response = await request.post('/api/projects', { headers, data: { key: `BMP${suffix}`, name: prefix } });
  expect(response.status(), await response.text()).toBe(201);
  const project = await response.json() as Project;
  const bulkPath = `/api/projects/${project.id}/issues/bulk`;
  const plans: PlanningItem[] = [], issues: Issue[] = [];
  const kinds = [['cycle', 'cycleId', '사이클'], ['module', 'moduleId', '모듈'], ['release', 'releaseId', '릴리스']] as const;

  async function plan(kind: PlanningKind, name: string) {
    const response = await request.post('/api/planning-items', { headers, data: {
      projectId: project.id, kind, name: `${prefix} ${name}`, status: 'active', startDate, endDate,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const created = await response.json() as PlanningItem;
    plans.push(created);
    return created;
  }

  async function ticket(title: string, options: Partial<Pick<Issue, 'cycleId' | 'moduleId' | 'releaseId' | 'status'>> = {}) {
    const response = await request.post('/api/issues', { headers, data: {
      projectId: project.id, title: `${prefix} ${title}`, startDate, endDate, dueDate, labels: [unchangedLabel], ...options,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const created = await response.json() as Issue;
    issues.push(created);
    return created;
  }

  const projectPlan = (item: PlanningItem) => ({ id: item.id, name: item.name });
  try {
    const previous = {} as Record<PlanningKind, PlanningItem>, proposed = {} as Record<PlanningKind, PlanningItem>;
    for (const [kind, , label] of kinds) {
      previous[kind] = await plan(kind, `원래 ${label}`);
      proposed[kind] = await plan(kind, `새 ${label}`);
    }
    const replacement = await plan('module', '다시 선택한 모듈');
    const first = await ticket('대상 하나', { status: 'backlog', cycleId: previous.cycle.id, moduleId: previous.module.id, releaseId: previous.release.id });
    const second = await ticket('대상 둘', { status: 'todo' });
    const outside = await ticket('검색 밖 업무', { releaseId: previous.release.id });
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    const list = page.getByRole('region', { name: '업무 목록', exact: true });
    const planning = editor.getByRole('region', { name: '계획 연결 일괄 변경', exact: true });
    const select = (label: string) => planning.getByRole('combobox', { name: `일괄 변경 ${label}`, exact: true });
    const previewRegion = editor.getByRole('region', { name: '일괄 변경 미리보기', exact: true });
    const previewButton = editor.getByRole('button', { name: '변경 미리보기', exact: true });
    const previewRow = (issue: Issue) => previewRegion.getByRole('listitem').filter({ has: page.getByText(`${issue.key} ${issue.title}`, { exact: true }) });
    const labelBox = editor.getByRole('textbox', { name: '추가할 라벨', exact: true });

    async function selectTickets() {
      await page.goto(`/#/${project.id}/issues`);
      const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
      await expect(search).toBeVisible({ timeout: 24_000 });
      await search.fill(`${prefix} 대상`);
      await page.getByRole('button', { name: '일괄 편집', exact: true }).click();
      await list.getByRole('checkbox', { name: '검색 결과 전체 선택', exact: true }).check();
      for (const issue of [first, second]) await expect(list.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true })).toBeChecked();
      await expect(list.getByRole('checkbox', { name: `${outside.key} 선택`, exact: true })).toHaveCount(0);
    }

    async function review(changes: IssueBulkEditChanges) {
      const pending = responseAt(page, `${bulkPath}-preview`);
      await previewButton.click();
      const response = await pending;
      expect(response.status(), await response.text()).toBe(200);
      expect(response.request().postDataJSON().changes).toEqual(changes);
      const result = await response.json() as IssueBulkEditPreview;
      expect(result.previewId).toBeTruthy();
      expect({ changed: result.changed, blocked: result.blocked }).toEqual({ changed: 2, blocked: 0 });
      expect(result.rows.map(row => row.id).sort()).toEqual([first.id, second.id].sort());
      return result;
    }

    async function apply(expected: 200 | 409) {
      const pending = responseAt(page, `${bulkPath}-apply`);
      await previewRegion.getByRole('button', { name: '일괄 적용', exact: true }).click();
      const response = await pending;
      expect(response.status(), await response.text()).toBe(expected);
      await expect(previewRegion).toHaveCount(0);
    }

    async function expectAssignment(versionDelta: number, cycle: PlanningItem | null, release: PlanningItem | null) {
      const current = (await workspace(request)).issues;
      for (const issue of [first, second]) expect(current.find(item => item.id === issue.id)).toMatchObject({
        version: issue.version + versionDelta, status: issue.status, priority: issue.priority, assigneeId: issue.assigneeId,
        startDate, endDate, dueDate, labels: [unchangedLabel, addedLabel],
        cycleId: cycle?.id ?? null, cycle: cycle?.name ?? null, moduleId: replacement.id, module: replacement.name,
        releaseId: release?.id ?? null, release: release?.name ?? null,
      });
      expect(current.find(item => item.id === outside.id)).toEqual(outside);
    }

    await selectTickets();
    for (const [kind, , label] of kinds) await select(label).selectOption(`plan:${proposed[kind].id}`);
    await labelBox.fill(addedLabel);
    const changes = { cycleId: proposed.cycle.id, moduleId: proposed.module.id, releaseId: proposed.release.id, addLabels: [addedLabel] };
    const initial = await review(changes);
    for (const issue of [first, second]) for (const [kind, field, label] of kinds) {
      const prior = issue.id === first.id ? previous[kind] : null;
      expect(initial.rows.find(row => row.id === issue.id)).toMatchObject({
        before: { [field]: prior?.id ?? null }, after: { [field]: proposed[kind].id },
        plans: { [kind]: { before: prior && projectPlan(prior), after: projectPlan(proposed[kind]) } },
      });
      await expect(previewRow(issue)).toContainText(`${prior?.name ?? `${label} 없음`} → ${proposed[kind].name}`);
    }

    const stale = proposed.module;
    const archived = await request.patch(`/api/planning-items/${stale.id}`, { headers: { 'X-Actor-Id': teammate.id },
      data: { expectedVersion: stale.version, status: 'archived' } });
    expect(archived.status(), await archived.text()).toBe(200);
    await apply(409);
    const untouched = (await workspace(request)).issues;
    for (const issue of issues) expect(untouched.find(item => item.id === issue.id)).toEqual(issue);
    await editor.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(planning.getByRole('alert')).toHaveText('보관된 모듈에는 연결할 수 없습니다. 다른 계획을 선택해 주세요.');
    await expect(previewButton).toBeDisabled();
    await expect(labelBox).toHaveValue(addedLabel);
    for (const [kind, , label] of kinds) await expect(select(label)).toHaveValue(`plan:${proposed[kind].id}`);
    await expect(select('모듈').locator('option:checked')).toHaveAttribute('disabled', '');
    await select('모듈').selectOption(`plan:${replacement.id}`);
    const fresh = await review({ ...changes, moduleId: replacement.id });
    expect(fresh.previewId).not.toBe(initial.previewId);
    for (const row of fresh.rows) expect(row.plans?.module?.after).toEqual(projectPlan(replacement));
    await apply(200);
    await expectAssignment(1, proposed.cycle, proposed.release);

    await editor.getByRole('button', { name: '일괄 편집 닫기', exact: true }).click();
    await page.goto(`/#/${project.id}/gantt/${proposed.release.id}`);
    await page.getByRole('checkbox', { name: '연결된 업무만', exact: true }).check();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    for (const issue of [first, second]) {
      const row = chart.locator(`[data-issue-id="${issue.id}"]`);
      await expect(row).toBeVisible();
      await expect(row.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(endDate);
    }
    await expect(chart.locator(`[data-issue-id="${outside.id}"]`)).toHaveCount(0);

    await selectTickets();
    await select('사이클').selectOption('clear');
    await select('릴리스').selectOption('clear');
    await expect(select('모듈')).toHaveValue('');
    const cleared = await review({ cycleId: null, releaseId: null });
    for (const row of cleared.rows) {
      expect(row.plans).toEqual({ cycle: { before: projectPlan(proposed.cycle), after: null }, release: { before: projectPlan(proposed.release), after: null } });
    }
    await apply(200);
    await expectAssignment(2, null, null);
  } finally {
    await removeIssues(request, issues);
    for (const item of plans) {
      const response = await request.get(`/api/planning-items/${item.id}`);
      if (response.ok()) {
        const current = await response.json() as PlanningItem;
        await request.delete(`/api/planning-items/${item.id}?expectedVersion=${current.version}`, { headers });
      }
    }
  }
});
