import { expect, test } from '@playwright/test';
import type { Comment, WorkspaceSnapshot } from '../../shared/types';

test('a blank built pilot supports intake, Gantt planning and a linked document handoff', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(90_000);
  expect(baseURL).toBe(new URL(process.env.TEAMSPACE_PILOT_TEST_URL!).origin);
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1');
  async function workspace(): Promise<WorkspaceSnapshot> {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  expect(await workspace()).toMatchObject({ users: [], projects: [], issues: [], documents: [] });
  const openerName = '합성 계획 담당';
  const readerName = '합성 문서 검토';
  const projectName = '합성 팀 첫 계획';
  const documentTitle = '합성 업무 검토 절차';
  const documentBody = '검토를 마친 뒤 후행 업무의 담당자에게 공유합니다.';
  const intakeTitle = '팀 시험 일정 검토 요청';
  const leadTitle = '요구사항 검토';
  const nextTitle = '검토 결과 공유';
  const monthlyTitle = '선택한 날에 공유 준비';
  const tableValue = '시범 검토 완료';

  await page.goto('/');
  const sidebar = page.locator('.sidebar');
  await sidebar.getByRole('button', { name: '워크스페이스 설정', exact: true }).click();
  for (const [name, email] of [[openerName, 'planner@example.test'], [readerName, 'reader@example.test']]) {
    await page.getByRole('textbox', { name: '새 팀원 이름' }).fill(name);
    await page.getByRole('textbox', { name: '새 팀원 이메일' }).fill(email);
    await page.getByRole('button', { name: '팀원 추가', exact: true }).click();
    await expect(page.locator('.team-list')).toContainText(email);
  }
  const { users } = await workspace();
  const owner = users.find(user => user.name === openerName)!;
  const reader = users.find(user => user.name === readerName)!;
  await page.getByRole('combobox', { name: '작업자 선택' }).selectOption(owner.id);
  await sidebar.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
  const projectForm = page.locator('form').filter({ has: page.getByLabel('프로젝트 이름', { exact: true }) });
  await projectForm.getByLabel('프로젝트 이름').fill(projectName);
  await projectForm.getByLabel('티켓 접두어').fill('NATIVE');
  await projectForm.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: new RegExp(projectName) })).toBeVisible();
  const { projects: [project] } = await workspace();
  expect(project).toMatchObject({ key: 'NATIVE', name: projectName });

  await sidebar.locator('.project-navigation').getByRole('button', { name: /^업무(?: [\d,]+)?$/u }).click();
  await page.getByRole('navigation', { name: '업무 화면', exact: true }).getByRole('button', { name: '간트', exact: true }).click();
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  await expect(chart).toContainText('표시할 업무가 없습니다');
  const actorSwitch = page.getByRole('combobox', { name: '작업자 선택' });
  await actorSwitch.selectOption(reader.id);
  await sidebar.getByRole('button', { name: '업무 접수', exact: true }).click();
  await page.getByRole('button', { name: '요청 작성', exact: true }).click();
  const submitRequest = page.getByRole('dialog', { name: '업무 요청 작성', exact: true });
  await submitRequest.getByLabel('요청 제목', { exact: true }).fill(intakeTitle);
  await submitRequest.getByLabel('요청 내용', { exact: true }).fill('시험 일정의 담당자와 시작일을 확인해 주세요.');
  await submitRequest.getByRole('button', { name: '요청 접수', exact: true }).click();
  await expect(submitRequest).toHaveCount(0);
  expect((await workspace()).issues).toEqual([]);
  await actorSwitch.selectOption(owner.id);
  await page.getByRole('list', { name: '접수 요청', exact: true }).getByText(intakeTitle, { exact: true }).click();
  const review = page.getByRole('dialog', { name: '접수 요청 검토', exact: true });
  await review.getByRole('combobox', { name: '담당자', exact: true }).selectOption(owner.id);
  await review.getByText('추가 속성', { exact: true }).click();
  await review.getByLabel('시작일', { exact: true }).fill('2027-01-07');
  await review.getByLabel('종료일', { exact: true }).fill('2027-01-08');
  await review.getByRole('button', { name: '업무로 등록', exact: true }).click();
  await expect(review.getByRole('region', { name: '처리 결과', exact: true })).toContainText('업무로 등록');
  await review.getByRole('button', { name: '접수 창 닫기', exact: true }).click();
  const [accepted] = (await workspace()).issues;
  expect(accepted).toMatchObject({ projectId: project.id, reporterId: reader.id, assigneeId: owner.id, startDate: '2027-01-07', endDate: '2027-01-08' });

  await sidebar.locator('.project-navigation').getByRole('button', { name: /^업무(?: [\d,]+)?$/u }).click();
  await page.getByRole('navigation', { name: '업무 화면', exact: true }).getByRole('button', { name: '간트', exact: true }).click();
  await page.getByRole('button', { name: '새 업무 붙여넣기', exact: true }).click();
  const paste = page.getByRole('dialog', { name: '업무 붙여넣기', exact: true });
  const sheet = [
    ['임시 키', '제목', '담당자', '시작일', '종료일', '선행 업무'],
    ['review', leadTitle, openerName, '2027-01-11', '2027-01-12', accepted.key],
    ['', nextTitle, readerName, '2027-01-13', '2027-01-14', 'new:review'],
  ].map(row => row.join('\t')).join('\n');
  await paste.getByRole('textbox', { name: '붙여넣을 업무', exact: true }).fill(sheet);
  await paste.getByRole('button', { name: '미리보기', exact: true }).click();
  await expect(paste).toContainText('new:review');
  await paste.getByRole('button', { name: '업무 2개와 선후행 연결 2개 만들기', exact: true }).click();
  await expect(paste).toHaveCount(0);
  const plan = await workspace();
  const lead = plan.issues.find(issue => issue.title === leadTitle)!;
  const next = plan.issues.find(issue => issue.title === nextTitle)!;
  expect(lead).toMatchObject({ projectId: project.id, assigneeId: owner.id, startDate: '2027-01-11', endDate: '2027-01-12' });
  expect(next).toMatchObject({ projectId: project.id, assigneeId: reader.id, startDate: '2027-01-13', endDate: '2027-01-14' });
  expect(plan.dependencies).toHaveLength(2);
  expect(plan.dependencies).toEqual(expect.arrayContaining([
    expect.objectContaining({ predecessorId: accepted.id, successorId: lead.id, type: 'FS', lagDays: 0 }),
    expect.objectContaining({ predecessorId: lead.id, successorId: next.id, type: 'FS', lagDays: 0 }),
  ]));
  await page.getByLabel('간트 표시 시작일', { exact: true }).fill('2027-01-01');
  await chart.evaluate(element => { element.scrollLeft = 0; });
  const monthlyButton = page.getByRole('button', { name: '월간 일정', exact: true });
  await monthlyButton.click();
  const calendar = page.getByRole('region', { name: '월간 일정', exact: true });
  await calendar.locator('[data-calendar-date="2027-01-07"]').click();
  await expect(calendar.getByRole('list', { name: '선택한 날의 일정', exact: true })).toContainText(intakeTitle);
  await calendar.locator('[data-calendar-date="2027-01-15"]').click();
  await calendar.getByRole('button', { name: '이 날짜에 업무 추가', exact: true }).click();
  const monthlyCreate = calendar.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
  await monthlyCreate.getByRole('textbox', { name: '추가할 업무 제목', exact: true }).fill(monthlyTitle);
  await expect(monthlyCreate.getByLabel('추가할 업무 시작일', { exact: true })).toHaveValue('2027-01-15');
  await monthlyCreate.getByRole('button', { name: '간트에 추가', exact: true }).click();
  await expect(calendar.getByRole('list', { name: '선택한 날의 일정', exact: true })).toContainText(monthlyTitle);
  expect((await workspace()).issues.find(issue => issue.title === monthlyTitle)).toMatchObject({ startDate: '2027-01-15', endDate: '2027-01-15' });
  await monthlyButton.click();
  const row = chart.locator(`[data-issue-id="${lead.id}"]`);
  await expect(row.getByLabel(`${lead.key} 시작일`, { exact: true })).toHaveValue('2027-01-11');
  await row.locator('.gantt-issue-name').click();
  const ticket = page.getByRole('dialog', { name: leadTitle, exact: true });
  await ticket.getByRole('button', { name: '새 연결 문서 만들기', exact: true }).click();
  const createDocument = page.getByRole('dialog', { name: '연결 문서 만들기', exact: true });
  await createDocument.getByRole('textbox', { name: '문서 제목', exact: true }).fill(documentTitle);
  await createDocument.getByRole('button', { name: '문서 만들기', exact: true }).click();
  await ticket.getByRole('button', { name: documentTitle, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(documentTitle);
  await page.locator('.docs-prose').fill(documentBody);
  await page.getByRole('button', { name: '표 데이터 붙여넣기', exact: true }).click();
  const pasteTable = page.getByRole('dialog', { name: '표 데이터 붙여넣기', exact: true });
  await pasteTable.getByRole('textbox', { name: '표 데이터', exact: true }).fill(`검토\t결과\n시범 회차\t${tableValue}`);
  await pasteTable.getByRole('button', { name: '표 삽입', exact: true }).click();
  await expect(page.locator('.docs-prose').getByRole('table')).toContainText(tableValue);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  await page.getByRole('button', { name: '공간 홈으로 지정', exact: true }).click();
  await expect(page.getByRole('button', { name: '공간 홈 해제', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '저장본 읽기', exact: true }).click();
  await expect(page.getByRole('article', { name: '저장본 읽기' })).toContainText(documentBody);

  const second = await browser.newContext({ baseURL });
  try {
    await second.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), reader.id);
    const peer = await second.newPage();
    await peer.goto(`/#/${project.id}/documents`);
    await expect(peer.getByRole('article', { name: '저장본 읽기' })).toContainText(documentBody);
    await expect(peer.getByRole('article', { name: '저장본 읽기' }).getByRole('table')).toContainText(tableValue);
    await expect(peer.getByRole('combobox', { name: '작업자 선택' })).toHaveValue(reader.id);
    const saved = await workspace();
    const document = saved.documents.find(item => item.title === documentTitle)!;
    expect(document).toMatchObject({ projectId: project.id });
    expect(document.plainText).toContain(documentBody);
    expect(document.plainText).toContain(tableValue);
    expect(saved.resourceLinks).toEqual([expect.objectContaining({ issueId: lead.id, documentId: document.id })]);
    await peer.getByRole('button', { name: '알림', exact: true }).click();
    const inbox = peer.getByRole('dialog', { name: '팀 알림', exact: true });
    await inbox.getByRole('button', { name: new RegExp(`${intakeTitle}.*접수 업무 등록`) }).click();
    const receipt = peer.getByRole('dialog', { name: '접수 요청 검토', exact: true });
    await expect(receipt.getByRole('region', { name: '처리 결과', exact: true })).toContainText(accepted.key);
    await receipt.getByRole('button', { name: '접수 창 닫기', exact: true }).click();
    await peer.locator('.sidebar').getByRole('button', { name: /^내 업무/ }).click();
    await expect(peer.getByRole('main').getByRole('button', { name: new RegExp(nextTitle) })).toBeVisible();
    await peer.getByRole('button', { name: `${next.key} 상태 변경`, exact: true }).click();
    const handoff = peer.getByRole('dialog', { name: '업무 상태 변경', exact: true });
    await handoff.getByRole('combobox', { name: '변경할 상태', exact: true }).selectOption('in_progress');
    await handoff.getByRole('textbox', { name: '인수인계 댓글', exact: true }).fill('저장한 검토 문서를 읽고 공유 업무를 시작합니다.');
    await handoff.getByRole('button', { name: '상태 변경 적용', exact: true }).click();
    await expect(handoff).toHaveCount(0);
    expect((await workspace()).issues.find(issue => issue.id === next.id)?.status).toBe('in_progress');
    const comments = await request.get(`/api/comments?resourceType=issue&resourceId=${next.id}`);
    expect(comments.ok(), await comments.text()).toBe(true);
    expect(await comments.json() as Comment[]).toMatchObject([
      { body: '저장한 검토 문서를 읽고 공유 업무를 시작합니다.', authorId: reader.id },
    ]);
  } finally { await second.close(); }
});
