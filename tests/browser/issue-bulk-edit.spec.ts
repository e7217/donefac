import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Issue, IssueAssignmentRule, IssueBulkEditPreview, WorkspaceSnapshot } from '../../shared/types';

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
