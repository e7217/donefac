import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Dependency, Issue, IssueRelation, WorkspaceSnapshot } from '../../shared/types';

async function snapshot(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test('360px 티켓에서 다른 프로젝트의 업무 관계를 편집하고 동시 변경에도 티켓과 댓글 초안을 유지한다', async ({ page, context, request }) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, otherProject] } = await snapshot(request);
  const prefix = `논리 관계 ${randomUUID().slice(0, 8)}`;
  const created: Issue[] = [];
  const fields = { startDate: '2026-11-23', endDate: '2026-11-25' };
  async function issue(projectId: string, title: string): Promise<Issue> {
    const response = await request.post('/api/issues', { data: { projectId, title, ...fields } });
    expect(response.status(), await response.text()).toBe(201);
    const value = await response.json() as Issue;
    created.push(value);
    return value;
  }
  const detailPath = (value: Issue) => `/#/${value.projectId}/issues?issue=${value.id}`;

  try {
    const source = await issue(project.id, `${prefix} 사용자 작업`);
    const target = await issue(otherProject.id, `${prefix} 통합 선검증`);
    const path = `/api/issues/${source.id}/relations`;
    await page.goto(detailPath(source));
    const panel = page.getByRole('dialog', { name: source.title, exact: true });
    const relations = panel.getByRole('region', { name: '업무 관계', exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const add = relations.getByRole('button', { name: '업무 관계 추가', exact: true });
    await expect(relations.getByText('연결된 업무 관계가 없습니다.', { exact: true })).toBeVisible();
    await title.fill('편집 중인 티켓 제목');
    await comment.fill('보내지 않은 업무 댓글');
    await add.click();
    const create = relations.getByRole('form', { name: '업무 관계 추가', exact: true });
    const search = create.getByRole('searchbox', { name: '연결할 업무 검색', exact: true });
    const picker = create.getByRole('combobox', { name: '연결할 업무', exact: true });
    await expect(search).toBeFocused();
    await search.fill(`${target.key} 선검증`);
    await expect(picker.locator(`option[value="${target.id}"]`)).toContainText(otherProject.name);
    await expect(picker.locator(`option[value="${source.id}"]`)).toHaveCount(0);
    await search.press('Enter');
    await expect(picker).toBeFocused();
    await picker.selectOption(target.id);
    await create.getByRole('combobox', { name: '업무 관계 유형', exact: true }).selectOption('blocked-by');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await create.getByRole('button', { name: '관계 저장', exact: true }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(201);
    const relation = await response.json() as IssueRelation;
    expect(relation).toMatchObject({ origin: 'teamspace', type: 'blocks', sourceIssueId: target.id, targetIssueId: source.id });
    await expect(create).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(relations.getByText('이 업무가 차단됨', { exact: true })).toBeVisible();
    await expect(relations.getByRole('button', { name: `${target.key} 일정 연결 검토`, exact: true })).toHaveCount(0);

    const reader = await context.newPage();
    try {
      await reader.goto(detailPath(target));
      const reverse = reader.getByRole('region', { name: '업무 관계', exact: true });
      await expect(reverse.getByText('이 업무가 차단함', { exact: true })).toBeVisible();
      await reverse.getByRole('button', { name: new RegExp(source.key) }).filter({ hasText: source.title }).click();
      await expect(reader.getByRole('dialog', { name: source.title, exact: true })).toBeVisible();
    } finally {
      await reader.close();
    }

    const editButton = relations.getByRole('button', { name: `${target.key} 관계 수정`, exact: true });
    await editButton.click();
    const edit = relations.getByRole('form', { name: '업무 관계 수정', exact: true });
    const type = edit.getByRole('combobox', { name: '업무 관계 유형', exact: true });
    const save = edit.getByRole('button', { name: '관계 저장', exact: true });
    await expect(type).toHaveValue('blocked-by');
    await type.selectOption('related');
    const external = await request.patch(`/api/issues/${target.id}/relations/${relation.id}`, { data: {
      expectedVersion: relation.version, type: 'duplicates', direction: 'outgoing',
    } });
    expect(external.ok(), await external.text()).toBeTruthy();
    const concurrent = await external.json() as IssueRelation;
    const waitForEdit = () => page.waitForResponse(reply => new URL(reply.url()).pathname === `${path}/${relation.id}` && reply.request().method() === 'PATCH');
    const rejected = waitForEdit();
    await save.click();
    expect((await rejected).status()).toBe(409);
    await expect(edit.getByRole('alert')).toContainText('다른 작업자가 업무 관계를 변경했습니다.');
    await expect(type).toHaveValue('related');
    await expect(save).toBeDisabled();
    await edit.getByRole('button', { name: '최신 관계 열기', exact: true }).click();
    await expect(type).toHaveValue('duplicated-by');
    await type.selectOption('related');
    const applying = waitForEdit();
    await save.click();
    const applied = await applying;
    expect(applied.ok(), await applied.text()).toBeTruthy();
    expect(applied.request().postDataJSON()).toMatchObject({ expectedVersion: concurrent.version, type: 'related' });
    const updated = await applied.json() as IssueRelation;
    expect(updated.id).toBe(relation.id);
    expect(updated.version).toBeGreaterThan(concurrent.version);
    await expect(relations.getByText('관련 업무', { exact: true })).toBeVisible();

    await relations.getByRole('button', { name: `${target.key} 관계 해제`, exact: true }).click();
    const unlink = relations.getByRole('group', { name: '업무 관계 해제', exact: true });
    const deleting = page.waitForResponse(reply => new URL(reply.url()).pathname === `${path}/${relation.id}` && reply.request().method() === 'DELETE');
    await unlink.getByRole('button', { name: '업무 관계 해제', exact: true }).click();
    const deleted = await deleting;
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
    expect(new URL(deleted.url()).searchParams.get('expectedVersion')).toBe(String(updated.version));
    await expect(relations.getByText('연결된 업무 관계가 없습니다.', { exact: true })).toBeVisible();
    await expect(add).toBeFocused();
    await expect(title).toHaveValue('편집 중인 티켓 제목');
    await expect(comment).toHaveValue('보내지 않은 업무 댓글');
    expect(new URL(page.url()).hash).toBe(detailPath(source).slice(1));
    const after = await snapshot(request);
    for (const original of created) expect(after.issues.find(value => value.id === original.id)).toEqual(original);
    expect(after.dependencies.filter(value => created.some(item => [value.predecessorId, value.successorId].includes(item.id)))).toEqual([]);
  } finally {
    for (const value of created.reverse()) {
      const removed = await request.delete(`/api/issues/${value.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});

test('같은 프로젝트 차단 관계에서 동시 방향 변경을 확인하고 최신 방향으로 일정 연결을 저장한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await snapshot(request);
  const prefix = `일정 연결 검토 ${randomUUID().slice(0, 8)}`;
  const created: Issue[] = [];

  try {
    const fixtures = [
      { title: `${prefix} 확인 작업`, startDate: '2026-11-23', endDate: '2026-11-25' },
      { title: `${prefix} 적용 작업`, startDate: '2026-11-26', endDate: '2026-11-27' },
    ];
    for (const fixture of fixtures) {
      const response = await request.post('/api/issues', { data: { projectId: project.id, ...fixture } });
      expect(response.status(), await response.text()).toBe(201);
      created.push(await response.json() as Issue);
    }
    const [source, target] = created;
    const path = `/api/issues/${source.id}/relations`;
    const createdRelation = await request.post(path, { data: { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' } });
    expect(createdRelation.status(), await createdRelation.text()).toBe(201);
    const relation = await createdRelation.json() as IssueRelation;
    const dependencyPath = `${path}/${relation.id}/schedule-dependency`;
    const linkedDependencies = async () => (await snapshot(request)).dependencies.filter(value =>
      created.some(issue => [value.predecessorId, value.successorId].includes(issue.id)));
    const nextWrite = () => page.waitForResponse(response =>
      new URL(response.url()).pathname === dependencyPath && response.request().method() === 'POST');

    await page.goto(`/#/${project.id}/issues?issue=${source.id}`);
    const panel = page.getByRole('dialog', { name: source.title, exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const relations = panel.getByRole('region', { name: '업무 관계', exact: true });
    const trigger = relations.getByRole('button', { name: `${target.key} 일정 연결 검토`, exact: true });
    await expect(title).toHaveValue(source.title, { timeout: 30_000 });
    await title.fill('저장하지 않은 티켓 제목');
    await comment.fill('보내지 않은 연결 검토 메모');
    await trigger.click();

    const editor = page.getByRole('dialog', { name: '관계에서 일정 연결', exact: true });
    const type = editor.getByRole('combobox', { name: '연결 유형', exact: true });
    const lag = editor.getByRole('spinbutton', { name: '추가 간격 근무일', exact: true });
    const save = editor.getByRole('button', { name: '업무 연결', exact: true });
    const endpoint = (role: string) => editor.locator('.issue-dependent-context').filter({ hasText: role });
    await expect(type).toBeFocused();
    await expect(editor.getByRole('combobox', { name: '일정 연결 방향', exact: true })).toHaveCount(0);
    await expect(endpoint('선행 업무')).toContainText(source.key);
    await expect(endpoint('후행 업무')).toContainText(target.key);
    await expect(type).toHaveValue('FS');
    await expect(lag).toHaveValue('0');
    await type.selectOption('FF');
    await lag.fill('-2');

    const reversed = await request.patch(`${path}/${relation.id}`, { data: {
      expectedVersion: relation.version, type: 'blocks', direction: 'incoming',
    } });
    expect(reversed.status(), await reversed.text()).toBe(200);
    const latest = await reversed.json() as IssueRelation;
    expect(latest).toMatchObject({ id: relation.id, sourceIssueId: target.id, targetIssueId: source.id });
    expect(latest.version).toBeGreaterThan(relation.version);
    const rejecting = nextWrite();
    await save.click();
    const rejected = await rejecting;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON()).toMatchObject({
      expectedVersion: relation.version, predecessorId: source.id, successorId: target.id, type: 'FF', lagDays: -2,
    });
    await expect(editor.getByRole('alert')).toContainText('다른 작업자가 변경했습니다.');
    await expect(type).toHaveValue('FF');
    await expect(lag).toHaveValue('-2');
    expect(await linkedDependencies()).toEqual([]);

    await editor.getByRole('button', { name: '취소', exact: true }).click();
    await expect(relations.getByText('이 업무가 차단됨', { exact: true })).toBeVisible();
    await trigger.click();
    await expect(endpoint('선행 업무')).toContainText(target.key);
    await expect(endpoint('후행 업무')).toContainText(source.key);
    await expect(type).toHaveValue('FS');
    await expect(lag).toHaveValue('0');
    await type.selectOption('SS');
    await lag.fill('1');
    const saving = nextWrite();
    await save.click();
    const saved = await saving;
    expect(saved.status(), await saved.text()).toBe(201);
    expect(saved.request().postDataJSON()).toMatchObject({
      expectedVersion: latest.version, predecessorId: target.id, successorId: source.id, type: 'SS', lagDays: 1,
    });
    const dependency = await saved.json() as Dependency;
    await expect(editor).toHaveCount(0);
    await expect(relations.getByText('일정 연결됨', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '선행 업무 추가', exact: true })).toBeFocused();
    await expect(title).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('보내지 않은 연결 검토 메모');
    expect(await linkedDependencies()).toEqual([dependency]);
    const after = await snapshot(request);
    for (const original of created) expect(after.issues.find(value => value.id === original.id)).toEqual(original);
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
