import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, IssuePastePreview, IssuePasteResult, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function dateAt(offset: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function purgeIssues(request: APIRequestContext, issues: Issue[]) {
  for (const issue of issues) {
    const deleted = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
    if (deleted.ok()) {
      const { trashEntryId } = await deleted.json() as { trashEntryId?: string };
      if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
    }
  }
}

test('360px 프로젝트 목록에서 붙여넣기 응답과 목록 조회가 실패해도 일정이 있는 업무를 한 번만 만든다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const prefix = `업무 붙여넣기 검사 ${randomUUID().slice(0, 8)}`;
  const first = {
    projectId: project.id,
    title: `${prefix} 검토, "초안"`,
    description: '한글 메모',
    status: 'in_progress',
    startDate: dateAt(1),
    endDate: dateAt(3),
    dueDate: dateAt(2),
    labels: ['검토', '회의'],
  };
  const second = {
    projectId: project.id,
    title: `${prefix} 공유`,
    status: 'todo',
    startDate: dateAt(5),
    endDate: dateAt(7),
    dueDate: dateAt(6),
    labels: ['공유'],
  };
  const text = [
    ['제목', '설명', '상태', '시작일', '종료일', '목표 마감일', '라벨'],
    [`"${first.title.replaceAll('"', '""')}"`, first.description, '진행 중', first.startDate, first.endDate, first.dueDate, first.labels.join(',')],
    [second.title, '', second.status, second.startDate, second.endDate, second.dueDate, second.labels.join(',')],
  ].map(row => row.join('\t')).join('\n');
  const invalid = text.replace(second.startDate, '2026-02-30');
  const pastePath = `/api/projects/${project.id}/issues`;
  const storedIssues = async () => (await workspace(request)).issues.filter(issue => issue.title.startsWith(prefix));

  try {
    await page.goto(`/#/${project.id}/issues`);
    await page.getByRole('textbox', { name: '업무 검색', exact: true }).fill(prefix);
    const opener = page.getByRole('button', { name: '업무 붙여넣기', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '업무 붙여넣기', exact: true });
    const input = dialog.getByRole('textbox', { name: '붙여넣을 업무', exact: true });
    const preview = dialog.getByRole('button', { name: '미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '업무 2개 만들기', exact: true });
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await input.fill(invalid);
    const invalidPreview = page.waitForResponse(response => response.url().endsWith(`${pastePath}/paste-preview`)
      && response.request().method() === 'POST');
    await preview.click();
    const rejected = await invalidPreview;
    expect(rejected.status(), await rejected.text()).toBe(200);
    expect(await rejected.json()).toMatchObject({
      previewId: null,
      rows: [expect.objectContaining({ title: first.title })],
      errors: [expect.objectContaining({ line: 3 })],
    });
    await expect(dialog.getByRole('alert')).toContainText(/3행.*YYYY-MM-DD/);
    await expect(input).toHaveValue(invalid);
    const activeApply = dialog.getByRole('button', { name: /업무 \d+개 만들기/ }).and(dialog.locator(':enabled'));
    await expect(activeApply).toHaveCount(0);
    expect(await storedIssues()).toEqual([]);

    await input.fill(text);
    const validPreview = page.waitForResponse(response => response.url().endsWith(`${pastePath}/paste-preview`)
      && response.request().method() === 'POST');
    await preview.click();
    const reviewed = await validPreview;
    expect(reviewed.ok(), await reviewed.text()).toBe(true);
    const { previewId } = await reviewed.json() as IssuePastePreview;
    expect(previewId).toBeTruthy();
    await expect(apply).toBeEnabled();
    const review = dialog.getByRole('region', { name: '새 업무 미리보기', exact: true });
    await expect(review.getByRole('heading', { name: `2행 ${first.title}`, exact: true })).toBeVisible();
    await expect(review.getByRole('heading', { name: `3행 ${second.title}`, exact: true })).toBeVisible();
    await expect(review.getByText(first.endDate, { exact: true })).toBeVisible();
    await expect(input).toHaveValue(text);
    expect(await storedIssues()).toEqual([]);

    const attempts: string[] = [];
    let committed: Issue[] = [];
    let dropRefresh = false;
    let refreshFailures = 0;
    await page.route('**/api/workspace', async route => {
      if (!dropRefresh) return route.continue();
      dropRefresh = false;
      refreshFailures++;
      await route.abort('failed');
    });
    await page.route(`**${pastePath}/paste-apply`, async route => {
      const posted = route.request().postDataJSON() as { previewId: string };
      attempts.push(posted.previewId);
      if (attempts.length === 1) {
        const persisted = await route.fetch();
        expect(persisted.status(), await persisted.text()).toBe(201);
        const result = await persisted.json() as IssuePasteResult;
        expect(result.duplicate).toBe(false);
        committed = result.issues;
        await route.abort('failed');
      } else {
        if (attempts.length === 2) dropRefresh = true;
        await route.continue();
      }
    });

    await apply.click();
    const retry = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue(text);
    expect(committed).toMatchObject([first, second]);
    const storedBeforeRetry = await storedIssues();
    expect(storedBeforeRetry).toHaveLength(2);
    expect(storedBeforeRetry).toEqual(expect.arrayContaining(committed));

    const acknowledgement = page.waitForResponse(response => response.url().endsWith(`${pastePath}/paste-apply`)
      && response.request().method() === 'POST');
    await retry.click();
    const replay = await acknowledgement;
    expect(replay.status(), await replay.text()).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true, issues: committed });
    await expect(dialog.getByRole('alert')).toContainText('최신 목록을 불러오지 못했습니다.');
    await expect(retry).toBeEnabled();
    expect(refreshFailures).toBe(1);
    await retry.click();
    await expect(dialog).toHaveCount(0);
    expect(attempts).toEqual([previewId, previewId]);
    const after = await workspace(request);
    expect(after.issues.filter(issue => issue.title.startsWith(prefix))).toEqual(storedBeforeRetry);
    const rows = page.locator('.issue-table tbody tr[data-issue-id]');
    for (const issue of committed) {
      expect(after.activities.filter(activity => activity.resourceId === issue.id && activity.action === '티켓 생성')).toHaveLength(1);
      await expect(rows.filter({ hasText: issue.key })).toContainText(issue.title);
    }

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(prefix);
    const chart = page.getByRole('region', { name: '간트 차트' });
    for (const issue of committed) {
      await expect(chart.getByLabel(`${issue.key} 시작일`, { exact: true })).toHaveValue(issue.startDate!);
      await expect(chart.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(issue.endDate!);
    }
  } finally {
    await purgeIssues(request, await storedIssues());
  }
});

test('360px에서 업무와 기존·신규 선행 연결을 함께 검토하고 저장 응답 유실 후 간트에서 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const prefix = `연결 붙여넣기 검사 ${randomUUID().slice(0, 8)}`;
  const release = { title: `${prefix} 배포`, startDate: dateAt(9), endDate: dateAt(11) };
  const design = { title: `${prefix} 설계`, startDate: dateAt(3), endDate: dateAt(5) };
  const storedIssues = async () => (await workspace(request)).issues.filter(issue => issue.title.startsWith(prefix));

  try {
    const existingResponse = await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} 준비`, startDate: dateAt(1), endDate: dateAt(2),
    } });
    expect(existingResponse.status(), await existingResponse.text()).toBe(201);
    const existing = await existingResponse.json() as Issue;
    const pastePath = `/api/projects/${project.id}/issues`;
    const sheet = [
      ['제목', '임시 키', '선행 업무', '연결 유형', '근무일 간격', '시작일', '종료일'],
      [release.title, 'release', `${existing.key},new:design`, 'FS,FF', '0,-1', release.startDate, release.endDate],
      [design.title, 'design', '', '', '', design.startDate, design.endDate],
    ].map(row => row.join('\t')).join('\n');

    await page.goto(`/#/${project.id}/issues`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '업무 붙여넣기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '업무 붙여넣기', exact: true });
    const input = dialog.getByRole('textbox', { name: '붙여넣을 업무', exact: true });
    await input.fill(sheet);
    const waitingForPreview = page.waitForResponse(response => new URL(response.url()).pathname === `${pastePath}/paste-preview`
      && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '미리보기', exact: true }).click();
    const reviewed = await waitingForPreview;
    expect(reviewed.status(), await reviewed.text()).toBe(200);
    const { previewId, errors } = await reviewed.json() as IssuePastePreview;
    expect(previewId).toBeTruthy();
    expect(errors).toEqual([]);
    const review = dialog.getByRole('region', { name: '새 업무 미리보기', exact: true });
    const list = review.getByRole('list', { name: '2행 선행 업무 연결', exact: true });
    await expect(list).toContainText(existing.key);
    await expect(list).toContainText(existing.title);
    await expect(list).toContainText('new:design');
    await expect(list).toContainText(design.title);
    await expect(list).toContainText('FF');
    await expect(list).toContainText('-1근무일');
    expect(await storedIssues()).toEqual([existing]);

    const applyPath = `${pastePath}/paste-apply`;
    const attempts: string[] = [];
    let committed: IssuePasteResult | undefined;
    await page.route(`**${applyPath}`, async route => {
      const { previewId: postedPreviewId } = route.request().postDataJSON() as { previewId: string };
      attempts.push(postedPreviewId);
      if (attempts.length !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      committed = await response.json() as IssuePasteResult;
      await route.abort('failed');
    });

    await dialog.getByRole('button', { name: '업무 2개와 선후행 연결 2개 만들기', exact: true }).click();
    const retry = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeEnabled();
    expect(committed?.issues).toMatchObject([release, design]);
    const persisted = committed;
    expect(persisted?.dependencies).toHaveLength(2);
    const waitingForReplay = page.waitForResponse(response => new URL(response.url()).pathname === applyPath
      && response.request().method() === 'POST');
    await retry.click();
    const replay = await waitingForReplay;
    expect(replay.status(), await replay.text()).toBe(200);
    expect(await replay.json()).toEqual({ ...persisted, duplicate: true });
    await expect(dialog).toHaveCount(0);
    expect(attempts).toEqual([previewId, previewId]);

    const [released, designed] = persisted!.issues;
    const after = await workspace(request);
    const links = after.dependencies.filter(link => link.successorId === released.id);
    expect(links).toEqual(persisted!.dependencies);
    expect(links.map(({ predecessorId, type, lagDays }) => [predecessorId, type, lagDays])).toEqual([
      [existing.id, 'FS', 0], [designed.id, 'FF', -1],
    ]);
    expect(after.issues.filter(issue => issue.title.startsWith(prefix))).toHaveLength(3);

    await page.goto(`/#/${project.id}/gantt`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.getByLabel(`${released.key} 시작일`, { exact: true })).toHaveValue(release.startDate);
    await expect(chart.getByLabel(`${designed.key} 종료일`, { exact: true })).toHaveValue(design.endDate);
    for (const link of links) {
      const edge = chart.locator(`[data-dependency-id="${link.id}"]`);
      await expect(edge).toBeVisible();
      await expect(edge).toHaveAttribute('data-dependency-type', link.type);
    }
  } finally {
    await purgeIssues(request, await storedIssues());
  }
});
