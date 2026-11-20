import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Dependency, Issue, WorkspaceSnapshot } from '../../shared/types';

async function snapshot(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function dateAt(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

test('360px 티켓 상세에서 선후행 업무를 검색해 연결·편집·해제하고 간트와 초안을 확인한다', async ({ page, request, context }) => {
  test.setTimeout(80_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const [project, otherProject] = (await snapshot(request)).projects;
  const prefix = `티켓 선후행 ${randomUUID().slice(0, 8)}`;
  const fixtures: Issue[] = [];
  async function makeIssue(projectId: string, title: string, start: number) {
    const created = await request.post('/api/issues', { data: {
      projectId, title, startDate: dateAt(start), endDate: dateAt(start + 1),
    } });
    expect(created.status(), await created.text()).toBe(201);
    const issue = await created.json() as Issue;
    fixtures.push(issue);
    return issue;
  }

  try {
    const prior = await makeIssue(project.id, `${prefix} 윤곽 설계`, 1);
    const current = await makeIssue(project.id, `${prefix} 구현 작업`, 4);
    const foreign = await makeIssue(otherProject.id, `${prefix} 다른 프로젝트 업무`, 1);
    await page.goto(`/#/${project.id}/issues?issue=${current.id}`);
    const details = page.getByRole('dialog', { name: current.title, exact: true });
    const relationships = details.getByRole('region', { name: '업무 의존성', exact: true });
    const title = details.getByRole('textbox', { name: '제목', exact: true });
    const comment = details.getByRole('textbox', { name: '댓글 내용', exact: true });
    const addPredecessor = relationships.getByRole('button', { name: '선행 업무 추가', exact: true });

    await title.fill('저장하지 않은 업무 제목');
    await comment.fill('보내지 않은 댓글');
    const location = page.url();
    await addPredecessor.click();

    const create = page.getByRole('dialog', { name: '선행·후행 업무 연결', exact: true });
    const search = create.getByRole('searchbox', { name: '연결할 업무 검색', exact: true });
    const target = create.getByRole('combobox', { name: '연결할 업무', exact: true });
    await expect(create.getByRole('combobox', { name: '연결 방향', exact: true })).toHaveValue('predecessor');
    await expect(search).toBeFocused();
    await search.fill(foreign.key);
    await expect(target.locator(`option[value="${foreign.id}"]`)).toHaveCount(0);
    await search.fill('윤곽 설계');
    await target.selectOption(prior.id);
    await create.getByRole('combobox', { name: '연결 유형', exact: true }).selectOption('SS');
    await create.getByRole('spinbutton', { name: '추가 간격 근무일' }).fill('1');
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dependencies' && response.request().method() === 'POST');
    await create.getByRole('button', { name: '업무 연결', exact: true }).click();
    const createResponse = await created;
    expect(createResponse.status(), await createResponse.text()).toBe(201);
    const dependency = await createResponse.json() as Dependency;
    expect(dependency).toMatchObject({ predecessorId: prior.id, successorId: current.id, type: 'SS', lagDays: 1 });
    await expect(create).toHaveCount(0);
    await expect(addPredecessor).toBeFocused();
    await expect(relationships.getByText('선행', { exact: true })).toBeVisible();
    await expect(title).toHaveValue('저장하지 않은 업무 제목');
    await expect(comment).toHaveValue('보내지 않은 댓글');

    await relationships.getByRole('button', { name: `${prior.key} 연결 수정`, exact: true }).click();
    const edit = page.getByRole('dialog', { name: '업무 연결 수정', exact: true });
    await edit.getByRole('combobox', { name: '연결 방향', exact: true }).selectOption('successor');
    await edit.getByRole('combobox', { name: '연결 유형', exact: true }).selectOption('FF');
    await edit.getByRole('spinbutton', { name: '추가 간격 근무일' }).fill('-1');
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dependencies/${dependency.id}` && response.request().method() === 'PATCH');
    await edit.getByRole('button', { name: '연결 변경 저장', exact: true }).click();
    const updateResponse = await updated;
    expect(updateResponse.status(), await updateResponse.text()).toBe(200);
    expect(updateResponse.request().postDataJSON()).toMatchObject({ expectedVersion: dependency.version, reverse: true, type: 'FF', lagDays: -1 });
    const changed = await updateResponse.json() as Dependency;
    expect(changed).toMatchObject({ id: dependency.id, predecessorId: current.id, successorId: prior.id, type: 'FF', lagDays: -1 });
    await expect(edit).toHaveCount(0);
    await expect(relationships.getByText('후행', { exact: true })).toBeVisible();

    const chartPage = await context.newPage();
    try {
      await chartPage.goto(`/#/${project.id}/gantt`);
      await chartPage.getByRole('textbox', { name: '간트 업무 검색' }).fill(prefix);
      await expect(chartPage.locator(`[data-dependency-id="${dependency.id}"]`)).toHaveAttribute('data-dependency-type', 'FF');
    } finally {
      await chartPage.close();
    }

    const editButton = relationships.getByRole('button', { name: `${prior.key} 연결 수정`, exact: true });
    await editButton.click();
    const lagInput = edit.getByRole('spinbutton', { name: '추가 간격 근무일' });
    await lagInput.fill('2');
    const concurrent = await request.patch(`/api/dependencies/${dependency.id}`, {
      data: { expectedVersion: changed.version, lagDays: 4 },
    });
    expect(concurrent.ok(), await concurrent.text()).toBeTruthy();
    const latest = await concurrent.json() as Dependency;
    await edit.getByRole('button', { name: '연결 변경 저장', exact: true }).click();
    await expect(edit.getByRole('alert')).toContainText('다른 작업자가 이 연결을 변경했습니다');
    await expect(lagInput).toHaveValue('2');
    await expect(edit.getByRole('button', { name: '연결 변경 저장', exact: true })).toBeDisabled();
    await edit.getByRole('button', { name: '취소', exact: true }).click();
    await expect(editButton).toBeFocused();
    await editButton.click();
    await expect(lagInput).toHaveValue('4');
    await edit.getByRole('button', { name: '취소', exact: true }).click();

    const deletion = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dependencies/${dependency.id}` && response.request().method() === 'DELETE');
    await relationships.getByRole('button', { name: `${prior.key} 연결 해제`, exact: true }).click();
    const deleteResponse = await deletion;
    expect(deleteResponse.status(), await deleteResponse.text()).toBe(200);
    expect(new URL(deleteResponse.url()).searchParams.get('expectedVersion')).toBe(String(latest.version));
    await expect(relationships.getByRole('button', { name: `${prior.key} 연결 수정`, exact: true })).toHaveCount(0);
    await expect(title).toHaveValue('저장하지 않은 업무 제목');
    await expect(comment).toHaveValue('보내지 않은 댓글');
    expect(page.url()).toBe(location);
    const saved = await snapshot(request);
    expect(saved.dependencies.find(link => link.id === dependency.id)).toBeUndefined();
    for (const issue of [prior, current]) {
      expect(saved.issues.find(item => item.id === issue.id)).toMatchObject({
        title: issue.title, startDate: issue.startDate, endDate: issue.endDate, version: issue.version,
      });
    }
  } finally {
    for (const issue of fixtures.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});
