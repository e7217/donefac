import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, IssueIntakePage, IssueIntakeRequest, IssueIntakeResult, Project, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function fixture(request: APIRequestContext) {
  const { users: [reporter, reviewer], restoreGeneration } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  expect(restoreGeneration).toBeTruthy();
  const prefix = randomUUID().slice(0, 7).toUpperCase();
  const project = await json<Project>(await request.post('/api/projects', {
    headers: { 'X-Actor-Id': reviewer.id }, data: { key: `IQ${prefix}`, name: `접수 검사 ${prefix}` },
  }), 201);
  const path = `/api/projects/${project.id}/intake`;
  const header = { 'X-Actor-Id': reporter.id };
  function acceptUrl(page: Page) { return new URL(page.url()).hash; }
  async function list(state = 'pending') {
    return json<IssueIntakePage>(await request.get(`${path}?state=${state}`, { headers: header }));
  }
  async function create(title: string, description = '') {
    const created = await json<IssueIntakeResult>(await request.post(path, {
      headers: header, data: { requestId: randomUUID(), restoreGeneration, title, description },
    }), 201);
    return created.item;
  }
  return { reporter, reviewer, project, path, workspacePath: `/#/${project.id}/intake`, acceptUrl, list, create };
}

const queue = (page: Page) => page.getByRole('list', { name: '접수 요청', exact: true });
const review = (page: Page) => page.getByRole('dialog', { name: '접수 요청 검토', exact: true });
const accept = (page: Page) => review(page).getByRole('button', { name: '업무로 등록', exact: true });

test('접수 링크와 360px 검토로 다른 작업자의 요청을 업무 하나로 전환하고 응답을 재확인한다', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), f.reviewer.id);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/#/${f.project.id}/overview`);
  await page.getByRole('button', { name: '업무 접수', exact: true }).click();
  await expect(page.getByRole('heading', { name: '업무 접수', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '접수 링크 복사', exact: true }).click();
  const submissionUrl = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(submissionUrl.hash).toBe(`#/${f.project.id}/intake?compose=1`);

  const submitter = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    await submitter.addInitScript(id => localStorage.setItem('donefac.actor', id), f.reporter.id);
    const fromLink = await submitter.newPage();
    await fromLink.goto(submissionUrl.href);
    const form = fromLink.getByRole('dialog', { name: '업무 요청 작성', exact: true });
    await expect(form.getByLabel('요청 제목', { exact: true })).toBeFocused();
    const original = '정지 시험 데이터 검토';
    await form.getByLabel('요청 제목', { exact: true }).fill(original);
    await form.getByLabel('요청 내용', { exact: true }).fill('근무일에 분석해서 역추적이 필요합니다.');
    const attemptedWrites: string[] = [];
    await fromLink.route(url => url.pathname === f.path, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      attemptedWrites.push(route.request().postData() ?? '');
      if (attemptedWrites.length > 1) { await route.continue(); return; }
      const result = await route.fetch();
      expect(result.status(), await result.text()).toBe(201);
      await route.abort('failed');
    });
    await form.getByRole('button', { name: '요청 접수', exact: true }).click();
    const retrySubmission = form.getByRole('button', { name: '같은 요청 다시 확인', exact: true });
    await expect(retrySubmission).toBeFocused();
    await expect(form.getByLabel('요청 제목', { exact: true })).toHaveValue(original);
    await retrySubmission.click();
    await expect(form).toHaveCount(0);
    await expect(fromLink.getByRole('button', { name: '접수한 요청 열기', exact: true })).toBeVisible();
    expect(attemptedWrites).toHaveLength(2);
    expect(attemptedWrites[1]).toBe(attemptedWrites[0]);
    expect(f.acceptUrl(fromLink)).toBe(`#/${f.project.id}/intake`);
    const [received] = (await f.list()).items;
    expect(received).toMatchObject({ reporterId: f.reporter.id, title: original, status: 'pending' });
    expect((await f.list()).total).toBe(1);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.getByRole('button', { name: '접수 목록 새로고침', exact: true }).click();
    await expect(queue(page).getByRole('button', { name: new RegExp(original) })).toBeVisible();
    await page.getByRole('checkbox', { name: '내 요청만', exact: true }).check();
    await expect(page.getByText('조건에 맞는 요청이 없습니다.', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: '내 요청만', exact: true }).uncheck();
    await page.getByRole('searchbox', { name: '요청 검색', exact: true }).fill('역추적');
    await queue(page).getByText(original, { exact: true }).click();
    const dialog = review(page);
    await expect(dialog.getByLabel('업무 제목', { exact: true })).toHaveValue(original);
    await dialog.getByRole('button', { name: '요청 링크 복사', exact: true }).click();
    expect(new URL(await page.evaluate(() => navigator.clipboard.readText())).hash).toBe(`#/${f.project.id}/intake?request=${received.id}`);
    const issueTitle = '공유 시험 계획을 검토한다';
    await dialog.getByLabel('업무 제목', { exact: true }).fill(issueTitle);
    await dialog.getByRole('combobox', { name: '담당자', exact: true }).selectOption(f.reviewer.id);
    await dialog.getByLabel('목표 마감일', { exact: true }).fill('2027-03-11');

    const decisions: string[] = [];
    await page.route(url => url.pathname === `${f.path}/${received.id}/decision`, async route => {
      decisions.push(route.request().postData() ?? '');
      if (decisions.length > 1) { await route.continue(); return; }
      const result = await route.fetch();
      expect(result.status(), await result.text()).toBe(200);
      await route.abort('failed');
    });
    await accept(page).click();
    await expect(dialog.getByRole('alert')).toContainText('같은 요청');
    await expect(dialog.getByLabel('업무 제목', { exact: true })).toHaveValue(issueTitle);
    await dialog.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).click();
    const outcome = dialog.getByRole('region', { name: '처리 결과', exact: true });
    await expect(outcome).toContainText('업무로 등록');
    const [closed] = (await f.list('closed')).items;
    expect(closed).toMatchObject({ status: 'accepted', reviewerId: f.reviewer.id, reporterId: f.reporter.id });
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toBe(decisions[0]);

    const snapshot = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const issues = snapshot.issues.filter(issue => issue.projectId === f.project.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: closed.issueId, reporterId: f.reporter.id, title: issueTitle, assigneeId: f.reviewer.id, dueDate: '2027-03-11' });
    await outcome.getByRole('button', { name: new RegExp(`${closed.issueKey} 업무 열기`) }).click();
    const issue = page.getByRole('dialog', { name: issueTitle, exact: true });
    await expect(issue).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await issue.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).toContainText(closed.issueKey!);

    const readReporterNotice = async () => {
      const inbox = await json<TeamNotificationPage>(await request.get('/api/notifications', { headers: { 'X-Actor-Id': f.reporter.id } }));
      return inbox.items.filter(item => item.targetId === received.id);
    };
    await expect.poll(readReporterNotice).toMatchObject([{ kind: 'intake-accepted', readAt: null }]);
    await fromLink.getByRole('button', { name: '알림', exact: true }).click();
    const inbox = fromLink.getByRole('dialog', { name: '팀 알림', exact: true });
    const notice = inbox.getByRole('button', { name: new RegExp(`${original}.*접수 업무 등록`) });
    await expect(notice).toBeVisible();
    await notice.click();
    await expect(review(fromLink).getByRole('region', { name: '처리 결과', exact: true })).toContainText(closed.issueKey!);
    expect(f.acceptUrl(fromLink)).toBe(`#/${f.project.id}/intake?request=${received.id}`);
    await expect.poll(readReporterNotice).toMatchObject([{ kind: 'intake-accepted', readAt: expect.any(String) }]);
  } finally {
    await submitter.close();
  }
});

test('접수 요청자는 처리 전에 내용을 바로잡고 동료의 작성 중인 검토 입력을 유지한다', async ({ page, browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const item = await f.create('압력 값 확인 요청', '처음 기록한 압력 범위입니다.');
  const address = `${f.workspacePath}?request=${item.id}`;
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), f.reviewer.id);
  await page.goto(address);
  const check = review(page);
  const original = check.getByRole('region', { name: '접수 원문', exact: true });
  await expect(original.getByText(item.title, { exact: true })).toBeVisible();
  await expect(check.getByRole('button', { name: '요청 수정', exact: true })).toHaveCount(0);
  await check.getByRole('textbox', { name: '업무 설명', exact: true }).fill('담당 팀에서 점검 순서를 검토합니다.');

  const submitter = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    await submitter.addInitScript(id => localStorage.setItem('donefac.actor', id), f.reporter.id);
    const author = await submitter.newPage();
    await author.goto(address);
    const authorDialog = review(author);
    const editButton = authorDialog.getByRole('button', { name: '요청 수정', exact: true });
    await editButton.click();
    const editor = authorDialog.getByRole('form', { name: '요청 수정', exact: true });
    const title = '정정한 압력 값 확인 요청';
    const description = '확인할 범위를 12~23으로 정정합니다.';
    await expect(editor.getByLabel('요청 제목', { exact: true })).toBeFocused();
    await editor.getByLabel('요청 제목', { exact: true }).fill(title);
    await editor.getByRole('textbox', { name: '요청 내용', exact: true }).fill(description);
    const attempts: string[] = [];
    await author.route(url => url.pathname === `${f.path}/${item.id}/edit`, async route => {
      attempts.push(route.request().postData() ?? '');
      if (attempts.length > 1) { await route.continue(); return; }
      const result = await route.fetch();
      expect(result.status(), await result.text()).toBe(200);
      await route.abort('failed');
    });
    await editor.getByRole('button', { name: '수정 저장', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('같은 요청');
    await expect(editor.getByLabel('요청 제목', { exact: true })).toHaveValue(title);
    await editor.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(editButton).toBeFocused();
    await expect(authorDialog.getByRole('region', { name: '접수 원문', exact: true }).getByText(description, { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect((await f.list()).items).toMatchObject([{ id: item.id, title, description, version: item.version + 1 }]);

    await accept(page).click();
    await expect(check.getByRole('alert')).toContainText('최신 상태');
    await check.getByRole('button', { name: '최신 상태 확인', exact: true }).click();
    await expect(original.getByText(description, { exact: true })).toBeVisible();
    await expect(check.getByLabel('업무 제목', { exact: true })).toHaveValue(title);
    await expect(check.getByRole('textbox', { name: '업무 설명', exact: true })).toHaveValue('담당 팀에서 점검 순서를 검토합니다.');
    await accept(page).click();
    await expect(check.getByRole('region', { name: '처리 결과', exact: true })).toBeVisible();
    const snapshot = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(snapshot.issues.filter(issue => issue.projectId === f.project.id)).toMatchObject([{
      title, description: '담당 팀에서 점검 순서를 검토합니다.', reporterId: f.reporter.id,
    }]);
    await author.reload();
    await expect(authorDialog.getByRole('region', { name: '처리 결과', exact: true })).toBeVisible();
    await expect(editButton).toHaveCount(0);
  } finally {
    await submitter.close();
  }
});

test('중복 업무가 바뀌면 메모를 남기고 최신 버전을 다시 고르며 반려에는 사유를 받는다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const f = await fixture(request);
  const headers = { 'X-Actor-Id': f.reviewer.id };
  const duplicate = await f.create('이미 진행 중인 수집 요청');
  const reject = await f.create('팀 범위를 벗어나는 요청');
  const issue = await json<Issue>(await request.post('/api/issues', {
    headers, data: { projectId: f.project.id, title: '수집 데이터 정리' },
  }), 201);
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), f.reviewer.id);
  await page.goto(`${f.workspacePath}?request=${duplicate.id}`);
  const dialog = review(page);
  const method = dialog.getByRole('combobox', { name: '처리 방식', exact: true });
  await method.selectOption('duplicate');
  await dialog.getByRole('searchbox', { name: '기존 업무 검색', exact: true }).fill(issue.key);
  const originallySelected = dialog.getByRole('list', { name: '연결할 기존 업무', exact: true })
    .getByRole('button', { name: new RegExp(issue.title) });
  await originallySelected.click();
  const memo = dialog.getByRole('textbox', { name: '연결 메모', exact: true });
  await memo.fill('수집 기준은 기존 업무에서 이어갑니다.');
  const updated = await json<Issue>(await request.patch(`/api/issues/${issue.id}`, {
    headers, data: { expectedVersion: issue.version, title: '수집 데이터 정리와 검증' },
  }));
  const link = dialog.getByRole('button', { name: '기존 업무에 연결', exact: true });
  await link.click();
  await expect(dialog.getByRole('alert')).toContainText('중복 업무가 변경');
  await expect(memo).toHaveValue('수집 기준은 기존 업무에서 이어갑니다.');
  await dialog.getByRole('button', { name: '최신 상태 확인', exact: true }).click();
  await expect(dialog.getByText('선택한 업무가 변경됐습니다. 목록에서 최신 업무를 다시 선택해 주세요.', { exact: true })).toBeVisible();
  await expect(link).toBeDisabled();
  await dialog.getByRole('list', { name: '연결할 기존 업무', exact: true }).getByText(updated.title, { exact: true }).click();
  await link.click();
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).toContainText('수집 기준은 기존 업무에서 이어갑니다.');
  await dialog.getByRole('button', { name: '접수 창 닫기', exact: true }).click();

  await queue(page).getByText(reject.title, { exact: true }).click();
  await method.selectOption('reject');
  const rejectButton = dialog.getByRole('button', { name: '반려', exact: true });
  await expect(rejectButton).toBeDisabled();
  const reason = dialog.getByRole('textbox', { name: '반려 사유', exact: true });
  await reason.fill('현재 팀 업무 범위와 연결되지 않습니다.');
  const navigation = page.waitForEvent('dialog').then(confirm => confirm.dismiss());
  await dialog.getByRole('button', { name: '접수 창 닫기', exact: true }).click();
  await navigation;
  await expect(reason).toHaveValue('현재 팀 업무 범위와 연결되지 않습니다.');
  await rejectButton.click();
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).toContainText('현재 팀 업무 범위와 연결되지 않습니다.');
  await dialog.getByRole('button', { name: '접수 창 닫기', exact: true }).click();
  await page.getByRole('button', { name: /^처리 완료/ }).click();
  await expect(queue(page).getByText(duplicate.title, { exact: true })).toBeVisible();
  await expect(queue(page).getByText(reject.title, { exact: true })).toBeVisible();
  const closed = new Map<string, IssueIntakeRequest>((await f.list('closed')).items.map(item => [item.id, item]));
  expect(closed.get(duplicate.id)).toMatchObject({ status: 'duplicate', issueId: issue.id });
  expect(closed.get(reject.id)).toMatchObject({ status: 'rejected', issueId: null });
  expect((await f.list()).total).toBe(0);
});
