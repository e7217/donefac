import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Dependency, Issue, IssueCloseAsDuplicateResult, IssueRelation, WorkspaceSnapshot } from '../../shared/types';
import { allowedNextStatuses, projectWorkflow } from '../../shared/workflow-helpers';

async function snapshot(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function createDatedIssue(request: APIRequestContext, projectId: string, title: string): Promise<Issue> {
  const response = await request.post('/api/issues', { data: { projectId, title, startDate: '2026-11-23', endDate: '2026-11-25' } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function purgeCreatedIssues(request: APIRequestContext, issues: Issue[]) {
  for (const issue of issues.reverse()) {
    const removed = await request.delete(`/api/issues/${issue.id}`);
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
  }
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

test('업무 관계 수정 응답이 끊기면 같은 요청을 확인하고 이후 동료의 관계를 표시한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const before = await snapshot(request);
  const [project, otherProject] = before.projects;
  const [actor, peer] = before.users;
  const prefix = `관계 수정 결과 확인 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  try {
    const source = await createDatedIssue(request, project.id, `${prefix} 출발`);
    issues.push(source);
    const target = await createDatedIssue(request, otherProject.id, `${prefix} 대상`);
    issues.push(target);
    const path = `/api/issues/${source.id}/relations`;
    const created = await request.post(path, { data: { otherIssueId: target.id, type: 'related', direction: 'outgoing' } });
    expect(created.status(), await created.text()).toBe(201);
    const relation = await created.json() as IssueRelation;
    const editPath = `${path}/${relation.id}`;
    const attempts: string[] = [];
    let applied: IssueRelation | undefined;
    await page.route(`**${editPath}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      attempts.push(route.request().postData() ?? '');
      if (attempts.length > 1) return route.continue();
      const saved = await route.fetch();
      expect(saved.ok(), await saved.text()).toBeTruthy();
      applied = await saved.json() as IssueRelation;
      await route.abort('failed');
    });

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/issues?issue=${source.id}`);
    const panel = page.getByRole('dialog', { name: source.title, exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const relations = panel.getByRole('region', { name: '업무 관계', exact: true });
    await title.fill('저장하지 않은 업무 제목');
    await comment.fill('등록하지 않은 업무 댓글');
    await relations.getByRole('button', { name: `${target.key} 관계 수정`, exact: true }).click();
    const form = relations.getByRole('form', { name: '업무 관계 수정', exact: true });
    const type = form.getByRole('combobox', { name: '업무 관계 유형', exact: true });
    await type.selectOption('blocked-by');
    await form.getByRole('button', { name: '관계 저장', exact: true }).click();
    const recheck = form.getByRole('button', { name: '관계 수정 결과 확인', exact: true });
    await expect(recheck).toBeEnabled();
    await expect(type).toHaveValue('blocked-by');
    await expect(type).toBeDisabled();
    expect(applied).toMatchObject({ type: 'blocks', sourceIssueId: target.id, targetIssueId: source.id });

    const changed = await request.patch(editPath, { headers: { 'X-Actor-Id': peer.id }, data: {
      expectedVersion: applied!.version, type: 'duplicates', direction: 'outgoing',
    } });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const latest = await changed.json() as IssueRelation;
    await recheck.click();
    await expect(form).toHaveCount(0);
    await expect(relations.getByText('이 업무가 중복임', { exact: true })).toBeVisible();
    await expect(title).toHaveValue('저장하지 않은 업무 제목');
    await expect(comment).toHaveValue('등록하지 않은 업무 댓글');
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    expect(JSON.parse(attempts[0])).toMatchObject({ expectedRestoreGeneration: before.restoreGeneration, requestId: expect.any(String) });
    expect(await (await request.get(path)).json()).toEqual([latest]);
    const history = (await snapshot(request)).activities.filter(event => event.resourceId === source.id && event.action === '업무 관계 수정');
    expect(history.map(event => event.actorId).sort()).toEqual([actor.id, peer.id].sort());
  } finally {
    await purgeCreatedIssues(request, issues);
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

test('360px 티켓에서 최신 타 프로젝트 원본을 확인하고 초안을 유지하며 중복으로 닫는다', async ({ page, request }) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const before = await snapshot(request);
  const [project, otherProject] = before.projects;
  const workflow = projectWorkflow(before, project.id);
  const prefix = `중복 종료 ${randomUUID().slice(0, 8)}`;
  const created: Issue[] = [];

  try {
    for (const [projectId, title] of [[project.id, `${prefix} 신청`], [otherProject.id, `${prefix} 원본`]]) {
      created.push(await createDatedIssue(request, projectId, title));
    }
    const [duplicate, original] = created;
    const available = allowedNextStatuses(before, duplicate);
    const earlierStatus = available.find(status => status.id !== duplicate.status && status.category === 'in_progress')!;
    const closedStatus = available.find(status => status.category === 'cancelled')!;
    const issuePath = `/api/issues/${duplicate.id}`;
    const closePath = `${issuePath}/close-as-duplicate`;
    const nextClose = () => page.waitForResponse(response => new URL(response.url()).pathname === closePath && response.request().method() === 'POST');
    const titleDraft = `${prefix} 저장하지 않은 제목`;
    const commentDraft = '작성 중인 중복 검토 댓글';

    await page.goto(`/#/${project.id}/issues?issue=${duplicate.id}`);
    const panel = page.getByRole('dialog');
    await expect(panel).toHaveAccessibleName(duplicate.title);
    const relations = panel.getByRole('region', { name: '업무 관계', exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const status = panel.getByRole('combobox', { name: '상태', exact: true });
    await title.fill(titleDraft);
    await comment.fill(commentDraft);
    await status.selectOption(earlierStatus.id);
    await relations.getByRole('button', { name: '중복으로 닫기', exact: true }).click();

    const close = relations.getByRole('form', { name: '중복으로 닫기', exact: true });
    const search = close.getByRole('searchbox', { name: '원본 업무 검색', exact: true });
    const picker = close.getByRole('combobox', { name: '원본 업무', exact: true });
    const destination = close.getByRole('combobox', { name: '닫을 상태', exact: true });
    const apply = close.getByRole('button', { name: '중복으로 닫기 적용', exact: true });
    const originalOption = picker.locator(`option[value="${original.id}"]`);
    await expect(search).toBeFocused();
    await search.fill(original.key);
    await expect(originalOption).toContainText(original.title);
    await expect(originalOption).toContainText(otherProject.name);
    await picker.selectOption(original.id);
    await destination.selectOption(closedStatus.id);
    await expect(close.getByText('업무 상세에서 저장하지 않은 상태는 여기에서 선택한 상태로 바뀝니다.', { exact: true })).toBeVisible();

    const updatedOriginalTitle = `${original.title} 최신`;
    const external = await request.patch(`/api/issues/${original.id}`, { data: { expectedVersion: original.version, title: updatedOriginalTitle } });
    expect(external.status(), await external.text()).toBe(200);
    const latestOriginal = await external.json() as Issue;
    const rejecting = nextClose();
    await apply.click();
    const rejected = await rejecting;
    expect(rejected.status(), await rejected.text()).toBe(409);
    expect(rejected.request().postDataJSON()).toMatchObject({ originalIssueId: original.id, status: closedStatus.id,
      expectedVersion: duplicate.version, expectedOriginalVersion: original.version, expectedWorkflowVersion: workflow.version });
    await expect(close.getByRole('alert')).toContainText('원본 업무가 변경되었습니다.');
    await expect(apply).toBeDisabled();
    await expect(title).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    await expect(status).toHaveValue(earlierStatus.id);
    await expect(search).toHaveValue(original.key);
    await expect(picker).toHaveValue(original.id);
    await expect(destination).toHaveValue(closedStatus.id);
    expect((await snapshot(request)).issues.find(value => value.id === duplicate.id)).toEqual(duplicate);
    const unchangedRelations = await request.get(`${issuePath}/relations`);
    expect(unchangedRelations.status(), await unchangedRelations.text()).toBe(200);
    expect(await unchangedRelations.json()).toEqual([]);

    await close.getByRole('button', { name: '최신 정보 확인', exact: true }).click();
    await expect(originalOption).toContainText(updatedOriginalTitle);
    await expect(picker).toHaveValue(original.id);
    await expect(destination).toHaveValue(closedStatus.id);
    await expect(apply).toBeEnabled();

    const closing = nextClose();
    await apply.click();
    const closed = await closing;
    expect(closed.status(), await closed.text()).toBe(200);
    expect(closed.request().postDataJSON()).toMatchObject({ expectedOriginalVersion: latestOriginal.version, status: closedStatus.id });
    const result = await closed.json() as IssueCloseAsDuplicateResult;
    expect(result.issue).toMatchObject({ id: duplicate.id, title: duplicate.title, status: closedStatus.id, version: duplicate.version + 1 });
    expect(result.relation).toMatchObject({ origin: 'teamspace', type: 'duplicates', sourceIssueId: duplicate.id, targetIssueId: original.id });
    await expect(close).toHaveCount(0);
    await expect(relations.getByRole('button', { name: '업무 관계 추가', exact: true })).toBeFocused();
    await expect(relations.getByText('이 업무가 중복임', { exact: true })).toBeVisible();
    await expect(title).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    await expect(status).toHaveValue(closedStatus.id);

    const saving = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const saved = await saving;
    expect(saved.status(), await saved.text()).toBe(200);
    expect(saved.request().postDataJSON()).toMatchObject({ expectedVersion: result.issue.version, title: titleDraft, status: closedStatus.id });
    expect(await saved.json()).toMatchObject({ title: titleDraft, status: closedStatus.id, version: result.issue.version + 1 });
    await expect(panel).toHaveAccessibleName(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    await comment.fill('');
    const originalLink = relations.getByRole('button', { name: new RegExp(original.key) }).filter({ hasText: updatedOriginalTitle });
    await expect(originalLink).toContainText(otherProject.name);
    await originalLink.click();
    await expect(panel).toHaveAccessibleName(updatedOriginalTitle);
  } finally {
    await purgeCreatedIssues(request, created);
  }
});

const lostDuplicateResponseScenarios = [
  { name: '중복 종료 응답이 유실되면 다시 쓰지 않고 최신 업무에서 종료와 원본 연결을 확인한다', editAfterClosure: false },
  { name: '중복 종료 응답이 유실된 뒤 다른 작업자가 제목을 바꾸면 초안을 유지하고 최신 제목을 보호한다', editAfterClosure: true },
];

for (const { name, editAfterClosure } of lostDuplicateResponseScenarios) {
  test(name, async ({ page, request }) => {
    test.setTimeout(65_000);
    const before = await snapshot(request);
    const [project] = before.projects;
    const [actor, peer] = before.users;
    const prefix = `중복 종료 확인 ${randomUUID().slice(0, 8)}`;
    const created: Issue[] = [];

    try {
      for (const title of [`${prefix} 문의`, `${prefix} 원본`]) {
        created.push(await createDatedIssue(request, project.id, title));
      }
      const [duplicate, original] = created;
      const closedStatus = allowedNextStatuses(before, duplicate).find(status => status.category === 'cancelled')!;
      const issuePath = `/api/issues/${duplicate.id}`;
      let postCount = 0;
      const forwardedStatuses: number[] = [];
      await page.addInitScript(userId => localStorage.setItem('teamspace.actor', userId), actor.id);
      await page.route(`**${issuePath}/close-as-duplicate`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        postCount += 1;
        if (postCount > 1) return route.continue();
        const response = await route.fetch();
        forwardedStatuses.push(response.status());
        await route.abort('failed');
      });

      await page.goto(`/#/${project.id}/issues?issue=${duplicate.id}`);
      const panel = page.getByRole('dialog');
      await expect(panel).toHaveAccessibleName(duplicate.title);
      const relations = panel.getByRole('region', { name: '업무 관계', exact: true });
      const title = panel.getByRole('textbox', { name: '제목', exact: true });
      const titleDraft = `${prefix} 저장하지 않은 제목`;
      await title.fill(titleDraft);
      await relations.getByRole('button', { name: '중복으로 닫기', exact: true }).click();
      const close = relations.getByRole('form', { name: '중복으로 닫기', exact: true });
      await close.getByRole('searchbox', { name: '원본 업무 검색', exact: true }).fill(original.key);
      await close.getByRole('combobox', { name: '원본 업무', exact: true }).selectOption(original.id);
      await close.getByRole('combobox', { name: '닫을 상태', exact: true }).selectOption(closedStatus.id);
      const apply = close.getByRole('button', { name: '중복으로 닫기 적용', exact: true });
      await apply.click();
      await expect(close.getByRole('alert')).toHaveText('중복 처리 결과를 확인하지 못했습니다. 최신 정보를 확인해 주세요.');
      expect(forwardedStatuses).toEqual([200]);
      await expect(apply).toBeDisabled();

      const latestTitle = editAfterClosure ? `${prefix} 다른 작업자가 저장한 제목` : duplicate.title;
      const latestVersion = duplicate.version + (editAfterClosure ? 2 : 1);
      if (editAfterClosure) {
        const updated = await request.patch(issuePath, {
          headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: duplicate.version + 1, title: latestTitle },
        });
        expect(updated.status(), await updated.text()).toBe(200);
        expect(await updated.json()).toMatchObject({ title: latestTitle, version: latestVersion, status: closedStatus.id });
      }

      await close.getByRole('button', { name: '최신 정보 확인', exact: true }).click();
      await expect(page.getByText('최신 업무에서 종료 상태와 원본 연결을 확인했습니다.', { exact: true })).toBeVisible();
      await expect(close).toHaveCount(0);
      await expect(title).toHaveValue(titleDraft);
      await expect(panel).toHaveAccessibleName(latestTitle);
      await expect(relations.getByText('이 업무가 중복임', { exact: true })).toBeVisible();
      if (editAfterClosure) {
        await expect(panel.getByRole('alert').filter({ hasText: '최신 업무에 다른 변경이 있습니다.' })).toBeVisible();
        await expect(panel.getByRole('alert').filter({ hasText: '다른 변경사항이 있습니다' }))
          .toContainText(`편집 시작 버전은 ${duplicate.version}, 현재 버전은 ${latestVersion}입니다.`);
        const saving = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
        await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
        const rejected = await saving;
        expect(rejected.status(), await rejected.text()).toBe(409);
        expect(rejected.request().postDataJSON()).toMatchObject({ title: titleDraft, expectedVersion: duplicate.version });
        await expect(title).toHaveValue(titleDraft);
      } else {
        await expect(panel.getByRole('combobox', { name: '상태', exact: true })).toHaveValue(closedStatus.id);
      }
      expect(postCount).toBe(1);
      expect((await snapshot(request)).issues.find(issue => issue.id === duplicate.id)).toMatchObject({
        title: latestTitle, version: latestVersion, status: closedStatus.id,
      });
      const savedRelations = await request.get(`${issuePath}/relations`);
      expect(savedRelations.status(), await savedRelations.text()).toBe(200);
      expect(await savedRelations.json()).toMatchObject([
        { origin: 'teamspace', type: 'duplicates', sourceIssueId: duplicate.id, targetIssueId: original.id },
      ]);
    } finally {
      await purgeCreatedIssues(request, created);
    }
  });
}
