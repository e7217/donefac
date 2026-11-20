import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Dependency, Issue, SchedulePasteApplyResult, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext) {
  return (await (await request.get('/api/workspace')).json()) as WorkspaceSnapshot;
}

function dateAt(offset: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function createIssue(request: APIRequestContext, projectId: string, offset: number) {
  const response = await request.post('/api/issues', {
    data: {
      projectId, title: `일정 붙여넣기 검사 ${Date.now()} ${offset}`,
      startDate: dateAt(offset), endDate: dateAt(offset + 3),
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Issue;
}

test('붙여넣기 전에 오류와 연결 경고를 표시하고 검토한 변경을 적용·되돌린다', async ({ page, request }) => {
  const project = (await workspace(request)).projects[0];
  const predecessor = await createIssue(request, project.id, 0);
  const successor = await createIssue(request, project.id, 5);
  try {
    const dependency = await request.post('/api/dependencies', {
      data: {predecessorId:predecessor.id,successorId:successor.id,lagDays:0},
    });
    expect(dependency.ok()).toBeTruthy();
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', {name:'일정 붙여넣기',exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'일정 붙여넣기',exact:true});
    const input = dialog.getByRole('textbox', {name:'붙여넣을 일정표'});
    const preview = dialog.getByRole('button', {name:'붙여넣기 미리보기',exact:true});
    const apply = dialog.getByRole('button', {name:'검토한 일정 적용',exact:true});
    const text = [
      ['업무 키','시작일','종료일'],
      [predecessor.key,dateAt(1),dateAt(9)],
      [successor.key,'','-'],
    ].map(row => row.join('\t')).join('\n');

    const invalid = text.replace(dateAt(1), '2026/11/19');
    await input.fill(invalid);
    await preview.click();
    await expect(dialog.getByRole('region', {name:'일정 붙여넣기 오류'})).toContainText('YYYY-MM-DD');
    await expect(apply).toBeDisabled();
    await expect(input).toHaveValue(invalid);
    await input.fill(text);
    await preview.click();
    const table = dialog.getByRole('table', {name:'붙여넣기 일정 변경 목록'});
    await expect(table.getByRole('row', {name:new RegExp(predecessor.key)})).toContainText(dateAt(9));
    await expect(table.getByRole('row', {name:new RegExp(successor.key)})).toContainText('미정');
    await expect(dialog.getByText(/선행 업무 종료 후/)).toBeVisible();
    expect((await workspace(request)).issues.find(issue => issue.id === predecessor.id)?.endDate).toBe(predecessor.endDate);

    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel(`${predecessor.key} 종료일`, {exact:true})).toHaveValue(dateAt(9));
    await expect(page.getByLabel(`${successor.key} 종료일`, {exact:true})).toHaveValue('');
    const stored = (await workspace(request)).issues.find(issue => issue.id === successor.id);
    expect(stored?.startDate).toBe(successor.startDate);
    expect(stored?.endDate).toBeNull();
    await page.getByRole('button', {name:'되돌리기',exact:true}).click();
    await expect(page.getByLabel(`${predecessor.key} 종료일`, {exact:true})).toHaveValue(predecessor.endDate!);
    await expect(page.getByLabel(`${successor.key} 종료일`, {exact:true})).toHaveValue(successor.endDate!);

    await page.setViewportSize({width:360,height:820});
    const opener = page.getByRole('button', {name:'일정 붙여넣기',exact:true});
    await opener.click();
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await input.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  } finally {
    for (const issue of [predecessor, successor]) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('일정 붙여넣기의 오래된 미리보기를 거절하고 붙여넣은 원문을 유지한다', async ({ page, request }) => {
  const project = (await workspace(request)).projects[0];
  const issue = await createIssue(request, project.id, 0);
  try {
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', {name:'일정 붙여넣기',exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'일정 붙여넣기',exact:true});
    const input = dialog.getByRole('textbox', {name:'붙여넣을 일정표'});
    const preview = dialog.getByRole('button', {name:'붙여넣기 미리보기',exact:true});
    const apply = dialog.getByRole('button', {name:'검토한 일정 적용',exact:true});
    const text = `key,startDate,endDate\n${issue.key},${dateAt(1)},${dateAt(7)}`;
    await input.fill(text);
    await preview.click();
    await expect(apply).toBeEnabled();
    const external = await request.patch(`/api/issues/${issue.id}`, {
      data:{expectedVersion:issue.version,endDate:dateAt(5)},
    });
    expect(external.ok()).toBeTruthy();
    await apply.click();
    await expect(dialog.getByRole('alert')).toContainText('다시 미리 확인');
    await expect(apply).toBeDisabled();
    await expect(input).toHaveValue(text);
    expect((await workspace(request)).issues.find(value => value.id === issue.id)?.endDate).toBe(dateAt(5));
    await preview.click();
    await expect(apply).toBeEnabled();
    await expect(dialog.getByRole('table')).toContainText(dateAt(5));

    page.once('dialog', popup => void popup.dismiss());
    await page.evaluate(() => { location.hash = location.hash.replace(/\/gantt$/, '/issues'); });
    await expect(page).toHaveURL(/\/gantt$/);
    await expect(input).toHaveValue(text);
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel(`${issue.key} 종료일`, {exact:true})).toHaveValue(dateAt(7));
  } finally { await request.delete(`/api/issues/${issue.id}`); }
});

test('서버 적용 뒤 응답이 끊기면 같은 미리보기로 결과를 다시 받아 되돌릴 수 있다', async ({ page, request }) => {
  const project = (await workspace(request)).projects[0];
  const issue = await createIssue(request, project.id, 0);
  try {
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', {name:'일정 붙여넣기',exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'일정 붙여넣기',exact:true});
    const input = dialog.getByRole('textbox', {name:'붙여넣을 일정표'});
    const text = `key,endDate\n${issue.key},${dateAt(8)}`;
    await input.fill(text);
    await dialog.getByRole('button', {name:'붙여넣기 미리보기',exact:true}).click();

    const attempts: string[] = [];
    await page.route('**/api/schedule/paste-apply', async route => {
      const body = route.request().postDataJSON() as {previewId: string};
      attempts.push(body.previewId);
      if (attempts.length === 1) {
        const persisted = await route.fetch();
        expect(persisted.ok()).toBeTruthy();
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });

    await dialog.getByRole('button', {name:'검토한 일정 적용',exact:true}).click();
    const retry = dialog.getByRole('button', {name:'적용 결과 다시 확인',exact:true});
    await expect(retry).toBeEnabled();
    await expect(input).toHaveValue(text);
    const latest = (await workspace(request)).issues.find(value => value.id === issue.id)!;
    expect(latest.endDate).toBe(dateAt(8));
    expect(latest.version).toBe(issue.version + 1);

    await retry.click();
    await expect(dialog).toHaveCount(0);
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    const acknowledged = (await workspace(request)).issues.find(value => value.id === issue.id)!;
    expect(acknowledged.version).toBe(latest.version);
    await page.getByRole('button', {name:'되돌리기',exact:true}).click();
    await expect(page.getByLabel(`${issue.key} 종료일`, {exact:true})).toHaveValue(issue.endDate!);
  } finally { await request.delete(`/api/issues/${issue.id}`); }
});

test('360px 간트에서 날짜와 업무 연결을 함께 붙여넣고 연결만 변경한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const predecessor = await createIssue(request, project.id, 0);
  const successor = await createIssue(request, project.id, 5);
  const addedEndDate = dateAt(12);
  const pair = { predecessorId: predecessor.id, successorId: successor.id };
  const storedLink = async () => (await workspace(request)).dependencies.find(dependency =>
    dependency.predecessorId === pair.predecessorId && dependency.successorId === pair.successorId,
  );

  try {
    await page.goto(`/#/${project.id}/gantt`);
    const open = page.getByRole('button', { name: '일정 붙여넣기', exact: true });
    const undo = page.getByRole('button', { name: '되돌리기', exact: true });
    const dialog = page.getByRole('dialog', { name: '일정 붙여넣기', exact: true });
    const input = dialog.getByRole('textbox', { name: '붙여넣을 일정표' });
    const preview = dialog.getByRole('button', { name: '붙여넣기 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '검토한 일정 적용', exact: true });
    const dates = dialog.getByRole('table', { name: '붙여넣기 일정 변경 목록' });
    const links = dialog.getByRole('table', { name: '붙여넣기 업무 연결 변경 목록' });
    const linkRow = links.getByRole('row').filter({ hasText: successor.key });
    const endDate = page.getByLabel(`${successor.key} 종료일`, { exact: true });
    const editLink = page.getByRole('button', {
      name: `${predecessor.key}와 ${successor.key} 연결 수정`, exact: true,
    });

    await open.click();
    await input.fill(`업무 키\t종료일\t선행 업무\t연결 유형\t근무일 간격\n${successor.key}\t${addedEndDate}\t${predecessor.key}\tSS\t2`);
    await preview.click();
    await expect(dates).toContainText(addedEndDate);
    await expect(linkRow).toContainText(predecessor.key);
    await expect(linkRow).toContainText('연결 없음');
    await expect(linkRow).toContainText('SS · 시작 후 시작');
    await expect(linkRow).toContainText('+2근무일');
    await expect(linkRow).toContainText('추가');
    const bounds = (await links.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(await storedLink()).toBeUndefined();

    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(endDate).toHaveValue(addedEndDate);
    await expect(editLink).toBeVisible();
    expect(await storedLink()).toMatchObject({ ...pair, type: 'SS', lagDays: 2 });
    await undo.click();
    await expect(endDate).toHaveValue(successor.endDate!);
    await expect(editLink).toHaveCount(0);
    expect(await storedLink()).toBeUndefined();

    const current = await request.post('/api/dependencies', { data: { ...pair, type: 'FF', lagDays: -1 } });
    expect(current.ok()).toBeTruthy();
    await open.click();
    await input.fill(`key,predecessor,dependency type\n${successor.key},${predecessor.key},-`);
    await preview.click();
    await expect(dates).toHaveCount(0);
    await expect(linkRow).toContainText('FF · 완료 후 완료');
    await expect(linkRow).toContainText('-1근무일');
    await expect(linkRow).toContainText('삭제');
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(endDate).toHaveValue(successor.endDate!);
    expect(await storedLink()).toBeUndefined();
    await undo.click();
    await expect(editLink).toBeVisible();
    expect(await storedLink()).toMatchObject({ ...pair, type: 'FF', lagDays: -1 });
  } finally {
    for (const issue of [predecessor, successor]) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('360px 간트에서 한 업무의 선행 연결 여러 개와 날짜를 함께 검토·적용·되돌린다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const edited = await createIssue(request, project.id, 0);
  const removed = await createIssue(request, project.id, 2);
  const added = await createIssue(request, project.id, 4);
  const successor = await createIssue(request, project.id, 7);
  const startDate = dateAt(13);
  const endDate = dateAt(17);

  async function addPredecessor(predecessor: Issue, type: Dependency['type'], lagDays: number) {
    const response = await request.post('/api/dependencies', {
      data: { predecessorId: predecessor.id, successorId: successor.id, type, lagDays },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()) as Dependency;
  }

  async function readState() {
    const snapshot = await workspace(request);
    return {
      successor: snapshot.issues.find(issue => issue.id === successor.id),
      links: snapshot.dependencies.filter(link => link.successorId === successor.id)
        .sort((left, right) => left.predecessorId.localeCompare(right.predecessorId)),
    };
  }

  try {
    const originalEdit = await addPredecessor(edited, 'FS', 0);
    const originalRemoval = await addPredecessor(removed, 'FF', 1);
    const before = await readState();
    const header = ['업무 키', '시작일', '종료일', '선행 업무', '연결 유형', '근무일 간격'];
    const editRow = [successor.key, startDate, '', edited.key, 'SS', '2'];
    const removeRow = [successor.key, '', endDate, removed.key, '-', ''];
    const addRow = [successor.key, '', '', added.key, 'SF', '-2'];
    const tsv = (rows: string[][]) => rows.map(row => row.join('\t')).join('\n');
    const invalid = tsv([header, editRow, removeRow, [successor.key, dateAt(14), '', added.key, 'SF', '-2'],
      [successor.key.toLowerCase(), '', '', edited.key.toLowerCase(), '-', '']]);
    const text = tsv([header, editRow, removeRow, addRow]);

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', { name: '일정 붙여넣기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '일정 붙여넣기', exact: true });
    const input = dialog.getByRole('textbox', { name: '붙여넣을 일정표' });
    const preview = dialog.getByRole('button', { name: '붙여넣기 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '검토한 일정 적용', exact: true });
    const startField = page.getByLabel(`${successor.key} 시작일`, { exact: true });
    const endField = page.getByLabel(`${successor.key} 종료일`, { exact: true });

    await input.fill(invalid);
    await preview.click();
    const errors = dialog.getByRole('region', { name: '일정 붙여넣기 오류' });
    await expect(errors.getByRole('listitem').filter({ hasText: `4행 · ${successor.key}` })).toContainText('시작일');
    await expect(errors.getByRole('listitem').filter({ hasText: `5행 · ${successor.key}` })).toContainText('중복');
    await expect(apply).toBeDisabled();
    await expect(input).toHaveValue(invalid);
    expect(await readState()).toEqual(before);

    await input.fill(text);
    await preview.click();
    const review = dialog.getByRole('region', { name: '붙여넣기 변경 검토' });
    await expect(review.getByRole('heading', { name: /날짜 1건 · 업무 연결 3건/ })).toBeVisible();
    const dates = review.getByRole('table', { name: '붙여넣기 일정 변경 목록' });
    await expect(dates.getByRole('row')).toHaveCount(2);
    const mergedDates = dates.getByRole('row').filter({ hasText: successor.key });
    await expect(mergedDates).toContainText(startDate);
    await expect(mergedDates).toContainText(endDate);
    const links = review.getByRole('table', { name: '붙여넣기 업무 연결 변경 목록' });
    await expect(links.getByRole('row')).toHaveCount(4);
    const linkRow = (predecessor: Issue) => links.getByRole('row').filter({
      has: page.getByText(predecessor.key, { exact: true }),
    });
    await expect(linkRow(edited)).toContainText('입력 2행');
    await expect(linkRow(edited)).toContainText('FS · 완료 후 시작');
    await expect(linkRow(edited)).toContainText('SS · 시작 후 시작');
    await expect(linkRow(edited)).toContainText('+2근무일');
    await expect(linkRow(removed)).toContainText('입력 3행');
    await expect(linkRow(removed)).toContainText('삭제');
    await expect(linkRow(added)).toContainText('입력 4행');
    await expect(linkRow(added)).toContainText('SF · 시작 후 완료');
    await expect(linkRow(added)).toContainText('-2근무일');
    const bounds = await links.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    expect(await readState()).toEqual(before);

    const attempts: { previewId: string; result: SchedulePasteApplyResult }[] = [];
    await page.route('**/api/schedule/paste-apply', async route => {
      const { previewId } = route.request().postDataJSON() as { previewId: string };
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBeTruthy();
      attempts.push({ previewId, result: await response.json() as SchedulePasteApplyResult });
      if (attempts.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await apply.click();
    const retry = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeEnabled();
    await expect(input).toHaveValue(text);
    expect(attempts[0].result.dependencyChanges).toBe(3);
    expect(attempts[0].result.updated.map(issue => issue.id)).toEqual([successor.id]);
    const committed = await readState();
    expect(committed.successor).toMatchObject({ startDate, endDate, version: successor.version + 1 });
    expect(committed.links).toHaveLength(2);
    expect(committed.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalEdit.id, predecessorId: edited.id, type: 'SS', lagDays: 2 }),
      expect.objectContaining({ predecessorId: added.id, type: 'SF', lagDays: -2 }),
    ]));

    await retry.click();
    await expect(dialog).toHaveCount(0);
    await expect(startField).toHaveValue(startDate);
    await expect(endField).toHaveValue(endDate);
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    expect(await readState()).toEqual(committed);

    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(startField).toHaveValue(successor.startDate!);
    await expect(endField).toHaveValue(successor.endDate!);
    const reverted = await readState();
    expect(reverted.successor).toMatchObject({ startDate: successor.startDate, endDate: successor.endDate });
    expect(reverted.links).toHaveLength(2);
    expect(reverted.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalEdit.id, predecessorId: edited.id, type: 'FS', lagDays: 0 }),
      expect.objectContaining({ id: originalRemoval.id, predecessorId: removed.id, type: 'FF', lagDays: 1 }),
    ]));
  } finally {
    for (const issue of [edited, removed, added, successor]) await request.delete(`/api/issues/${issue.id}`);
  }
});
