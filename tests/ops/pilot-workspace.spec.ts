import { expect, test } from '@playwright/test';
import type { Comment, WorkspaceSnapshot } from '../../shared/types';

test('a blank built pilot supports team setup, Gantt planning and a linked document handoff', async ({ page, browser, baseURL, request }) => {
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
  const leadTitle = '요구사항 검토';
  const nextTitle = '검토 결과 공유';

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

  await sidebar.getByRole('button', { name: '간트 · 일정', exact: true }).click();
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  await expect(chart).toContainText('표시할 업무가 없습니다');
  await page.getByRole('button', { name: '새 업무 붙여넣기', exact: true }).click();
  const paste = page.getByRole('dialog', { name: '업무 붙여넣기', exact: true });
  const sheet = [
    ['임시 키', '제목', '담당자', '시작일', '종료일', '선행 업무'],
    ['review', leadTitle, openerName, '2027-01-11', '2027-01-12', ''],
    ['', nextTitle, readerName, '2027-01-13', '2027-01-14', 'new:review'],
  ].map(row => row.join('\t')).join('\n');
  await paste.getByRole('textbox', { name: '붙여넣을 업무', exact: true }).fill(sheet);
  await paste.getByRole('button', { name: '미리보기', exact: true }).click();
  await expect(paste).toContainText('new:review');
  await paste.getByRole('button', { name: '업무 2개와 선후행 연결 1개 만들기', exact: true }).click();
  await expect(paste).toHaveCount(0);
  const plan = await workspace();
  const lead = plan.issues.find(issue => issue.title === leadTitle)!;
  const next = plan.issues.find(issue => issue.title === nextTitle)!;
  expect(lead).toMatchObject({ projectId: project.id, assigneeId: owner.id, startDate: '2027-01-11', endDate: '2027-01-12' });
  expect(next).toMatchObject({ projectId: project.id, assigneeId: reader.id, startDate: '2027-01-13', endDate: '2027-01-14' });
  expect(plan.dependencies).toEqual([expect.objectContaining({ predecessorId: lead.id, successorId: next.id, type: 'FS', lagDays: 0 })]);
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
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  await page.getByRole('button', { name: '저장본 읽기', exact: true }).click();
  await expect(page.getByRole('article', { name: '저장본 읽기' })).toContainText(documentBody);

  const second = await browser.newContext({ baseURL });
  try {
    await second.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), reader.id);
    const peer = await second.newPage();
    await peer.goto(page.url());
    await expect(peer.getByRole('article', { name: '저장본 읽기' })).toContainText(documentBody);
    await expect(peer.getByRole('combobox', { name: '작업자 선택' })).toHaveValue(reader.id);
    const saved = await workspace();
    const document = saved.documents.find(item => item.title === documentTitle)!;
    expect(document).toMatchObject({ projectId: project.id, plainText: documentBody });
    expect(saved.resourceLinks).toEqual([expect.objectContaining({ issueId: lead.id, documentId: document.id })]);
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
