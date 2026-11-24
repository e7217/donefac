import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Attachment, DocPage, DocRevision, Issue, RichContent, SavedView, WorkspaceSnapshot } from '../../shared/types';
import { contentReferences } from '../../shared/document-nodes';

const paragraph = (text = ''): RichContent => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
const doc = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const include = (page: DocPage): RichContent => ({ type: 'documentInclude', attrs: { documentId: page.id, label: page.title } });
const details = (summary: string, text: string): RichContent => ({ type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: summary }] }, { type: 'detailsContent', content: [paragraph(text)] }] });
type Fixture = { requests: APIRequestContext; workspace: WorkspaceSnapshot; prefix: string; source: DocPage; target: DocPage; backlink: DocPage; issue: Issue; imagePath: string };
const test = base.extend<{ blocks: Fixture }>({
  blocks: [async ({ playwright, baseURL }, provide) => {
    const requests = await playwright.request.newContext({ baseURL }); const prefix = `문서 블록 ${randomUUID().slice(0, 8)}`;
    try {
      const workspace = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
      const createDoc = async (suffix: string, content = doc(paragraph())) => { const response = await requests.post('/api/documents', { data: { projectId: workspace.projects[0].id, title: `${prefix} ${suffix}`, content } }); expect(response.status()).toBe(201); return await response.json() as DocPage; };
      const issueResponse = await requests.post('/api/issues', { data: { projectId: workspace.projects[0].id, title: `${prefix} 연결 업무` } }); expect(issueResponse.status()).toBe(201); const issue = await issueResponse.json() as Issue;
      const source = await createDoc('편집 문서', doc(paragraph('작성 중인 문서'))), target = await createDoc('포함 원본');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
      const upload = await requests.post(`/api/attachments?resourceType=document&resourceId=${target.id}&filename=fixture.png`, { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': 'image/png' }, data: png }); expect(upload.status()).toBe(201); const attachment = await upload.json() as Attachment, imagePath = `/api/attachments/${attachment.id}/content?inline=1`;
      const rich = doc(
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '포함된 원본의 제목' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '서식 있는 포함 본문', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }] }, { type: 'hardBreak' }, { type: 'text', text: '내부 링크', marks: [{ type: 'link', attrs: { href: '#/all/issues?issue=' + issue.id } }] }] },
        { type: 'blockquote', content: [paragraph('인용한 결정 사항')] }, { type: 'codeBlock', content: [{ type: 'text', text: 'const ready = true;' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('글머리 항목')] }] }, { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('번호 항목')] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('완료한 확인')] }] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('검토 항목')] }, { type: 'tableHeader', content: [paragraph('결과')] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('문서 표시')] }, { type: 'tableCell', content: [paragraph('정상')] }] }] },
        { type: 'image', attrs: { src: imagePath, alt: '합성 포함 이미지' } }, { type: 'horizontalRule' }, details('원본의 접기 영역', '읽기 전용 접기 본문'),
        { type: 'issueReference', attrs: { issueId: issue.id, label: `${issue.key} ${issue.title}` } },
      );
      const patched = await requests.patch(`/api/documents/${target.id}`, { data: { expectedVersion: target.version, content: rich } }); expect(patched.status()).toBe(200); const richTarget = await patched.json() as DocPage;
      const backlink = await createDoc('역참조 문서', doc({ type: 'documentReference', attrs: { documentId: source.id, label: source.title } }));
      expect((await requests.post('/api/resource-links', { data: { issueId: issue.id, documentId: source.id, kind: 'related' } })).status()).toBe(201);
      await provide({ requests, workspace, prefix, source, target: richTarget, backlink, issue, imagePath });
    } finally {
      try { const response = await requests.get('/api/workspace', { timeout: 5000 }); if (response.ok()) { const snapshot = await response.json() as WorkspaceSnapshot; for (const page of snapshot.documents.filter(page => page.title.startsWith(prefix))) await requests.delete(`/api/documents/${page.id}?expectedVersion=${page.version}`, { timeout: 5000 }); for (const issue of snapshot.issues.filter(issue => issue.title.startsWith(prefix))) await requests.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`, { timeout: 5000 }); } }
      finally { await requests.dispose(); }
    }
  }, { timeout: 30_000 }],
});
const snapshot = async (fixture: Fixture) => await (await fixture.requests.get('/api/workspace')).json() as WorkspaceSnapshot;
const currentDoc = async (fixture: Fixture, id = fixture.source.id) => (await snapshot(fixture)).documents.find(page => page.id === id)!;
async function open(page: Page, fixture: Fixture, id = fixture.source.id) { await page.goto(`/#/${fixture.source.projectId}/documents/${id}`); await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toBeVisible(); }

async function insertIssueList(page: Page, projectId: string, viewId = '') {
  await page.getByRole('button', {name:'업무 목록 삽입',exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'업무 목록 삽입',exact:true});
  await dialog.getByLabel('업무 목록 프로젝트', {exact:true}).selectOption(projectId);
  await dialog.getByLabel('업무 목록 공유 보기', {exact:true}).selectOption(viewId);
  await dialog.getByRole('button', {name:'업무 목록 삽입',exact:true}).click();
  await expect(dialog).toHaveCount(0);
}
async function insertIssueSummary(page: Page, projectId: string, viewId = '', groupBy = 'status') {
  await page.getByRole('button', {name:'업무 현황 삽입',exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'업무 현황 삽입',exact:true});
  await dialog.getByLabel('업무 현황 프로젝트', {exact:true}).selectOption(projectId);
  await dialog.getByLabel('업무 현황 공유 보기', {exact:true}).selectOption(viewId);
  await dialog.getByLabel('업무 현황 그룹 기준', {exact:true}).selectOption(groupBy);
  await dialog.getByRole('button', {name:'업무 현황 삽입',exact:true}).click();
  await expect(dialog).toBeHidden();
}
async function choose(page: Page, kind: '업무 참조' | '문서 참조' | '문서 포함', title: string) { await page.getByRole('button', { name: `${kind} 삽입`, exact: true }).click(); const chooser = page.getByRole('dialog', { name: `${kind} 삽입`, exact: true }); await chooser.getByLabel('참조할 항목 검색', { exact: true }).fill(title); await chooser.locator('.doc-reference-results button').filter({ hasText: title }).click(); await expect(chooser).toHaveCount(0); }

test('참조와 포함을 삽입해 실제 서식을 표시하고 이름·상태 갱신 및 연결·내보내기를 보존한다', async ({ page, blocks: f }) => {
  await open(page, f); await choose(page, '업무 참조', f.issue.title); await choose(page, '문서 참조', f.target.title); await choose(page, '문서 포함', f.target.title);
  const included = page.locator('.docs-prose .doc-reference-node .doc-included-content').first();
  await expect(included.getByRole('heading', { name: '포함된 원본의 제목', exact: true })).toBeVisible(); for (const tag of ['strong', 'em', 'u', 's']) await expect(included.locator(tag).filter({ hasText: '서식 있는 포함 본문' })).toBeVisible(); await expect(included.locator('blockquote')).toContainText('인용한 결정 사항'); await expect(included.locator('pre code')).toHaveText('const ready = true;'); await expect(included.locator('table')).toContainText('검토 항목'); await expect(included.getByRole('checkbox', { name: '완료된 할 일', exact: true })).toBeChecked(); await expect(included.locator('img')).toHaveAttribute('src', f.imagePath); await expect.poll(() => included.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
  expect(await included.evaluate(element => (element as HTMLElement).isContentEditable)).toBe(false);
  const renamed = `${f.prefix} 최신 업무 제목`; expect((await f.requests.patch(`/api/issues/${f.issue.id}`, { data: { expectedVersion: f.issue.version, title: renamed, status: 'in_progress' } })).status()).toBe(200);
  const localText = '새로고침에도 남는 로컬 본문'; await page.locator('.docs-prose > p').last().click(); await page.keyboard.insertText(localText);
  expect((await f.requests.patch(`/api/documents/${f.target.id}`, { data: { expectedVersion: f.target.version, title: `${f.prefix} 최신 포함 원본`, content: doc(...(f.target.content.content || []), paragraph('원본에 새로 추가한 본문')) } })).status()).toBe(200);
  await page.getByRole('button', { name: '참조 새로고침', exact: true }).click(); await expect(page.locator('.docs-prose')).toContainText(localText); await expect(included).toContainText('원본에 새로 추가한 본문'); await expect(included).toContainText(`${f.prefix} 최신 포함 원본`);
  const card = page.locator('.docs-prose .doc-reference-node > .doc-reference-card.issue'); await expect(card).toContainText(renamed); await expect(card).toContainText('진행 중');
  await page.locator('.docs-save-button').click(); await expect(page.locator('.docs-save-state')).toHaveText('저장됨'); const saved = await currentDoc(f); expect(contentReferences(saved.content).map(ref => [ref.type, ref.kind, ref.id])).toEqual([['issue', 'reference', f.issue.id], ['document', 'reference', f.target.id], ['document', 'include', f.target.id]]); expect(saved.plainText).toContain(f.issue.id); expect(saved.plainText).not.toContain('서식 있는 포함 본문');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  const linkedIssue = page.locator('.docs-linked-issue');
  await expect(linkedIssue).toHaveCount(1);
  await expect(linkedIssue).toContainText(renamed);
  await expect(linkedIssue).toContainText('본문 참조 1곳');
  await expect(page.locator('.docs-reference-list').filter({ hasText: '본문에서 참조하는 문서' })).toContainText(`${f.prefix} 최신 포함 원본`);
  await expect(page.locator('.docs-reference-list').filter({ hasText: '이 문서를 참조하는 문서' })).toContainText(f.backlink.title);
  await expect(page.getByRole('heading', { name: '본문의 업무 참조', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '문서 내보내기', exact: true }).click(); const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '문서 JSON 내보내기', exact: true }).click(); const download = await downloadEvent, path = await download.path(); expect(path).not.toBeNull(); const exported = JSON.parse(readFileSync(path!, 'utf8')) as { schemaVersion: number; document: DocPage }; expect(exported.schemaVersion).toBe(2); expect(contentReferences(exported.document.content)).toHaveLength(3);
  await page.reload(); await expect(page.locator('.doc-included-content')).toContainText('서식 있는 포함 본문'); await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
});

test('접기 상태는 저장을 만들지 않고 요약에서 Enter로 본문을 편집하며 해제해도 내용을 유지한다', async ({ page, blocks: f }) => {
  const saved = await f.requests.patch(`/api/documents/${f.source.id}`, { data: { expectedVersion: f.source.version, content: doc(details('배포 확인', '승인 조건')) } }); expect(saved.status()).toBe(200); const baseDoc = await saved.json() as DocPage;
  await open(page, f); const block = page.locator('.docs-prose details[data-teamspace-node="details"]'), summary = block.locator('summary'); await expect(block).toHaveAttribute('open', ''); await summary.click(); await expect(block).not.toHaveAttribute('open', ''); await expect(page.locator('.docs-save-state')).toHaveText('저장됨'); expect((await currentDoc(f)).version).toBe(baseDoc.version);
  await page.getByRole('button', { name: '접기 블록 모두 펼치기', exact: true }).click(); await expect(block).toHaveAttribute('open', ''); await summary.click(); await summary.press('End'); await summary.press('Enter'); await page.keyboard.insertText('키보드 본문 추가'); await expect(block.locator('[data-teamspace-details-content]')).toContainText('키보드 본문 추가');
  await page.locator('.docs-save-button').click(); await expect(page.locator('.docs-save-state')).toHaveText('저장됨'); expect((await currentDoc(f)).content.content?.[0].attrs || {}).not.toHaveProperty('open');
  await block.locator('[data-teamspace-details-content] p').first().click(); await page.getByRole('button', { name: '접기 블록 해제', exact: true }).click(); await expect(page.locator('.docs-prose details')).toHaveCount(0); await expect(page.locator('.docs-prose')).toContainText('배포 확인'); await expect(page.locator('.docs-prose')).toContainText('승인 조건'); await page.locator('.docs-save-button').click(); await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  await page.getByRole('button', { name: '접기 블록 삽입', exact: true }).click(); await expect(page.locator('.docs-prose details')).toHaveCount(1); await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
});

test('본문 참조의 탐색 취소는 초안을 보존하고 삭제된 대상은 저장된 이름으로 표시한다', async ({ page, blocks: f }) => {
  const body = doc({ type: 'documentReference', attrs: { documentId: f.target.id, label: f.target.title } }, include(f.target), { type: 'issueReference', attrs: { issueId: f.issue.id, label: `${f.issue.key} ${f.issue.title}` } }); expect((await f.requests.patch(`/api/documents/${f.source.id}`, { data: { expectedVersion: f.source.version, content: body } })).status()).toBe(200);
  await open(page, f); const title = page.getByRole('textbox', { name: '문서 제목', exact: true }); await title.fill(`${f.prefix} 취소 시 보존`);
  const target = page.getByRole('button', { name: `참조 문서 열기 ${f.target.title}`, exact: true }); page.once('dialog', dialog => dialog.dismiss()); await target.click(); await expect(title).toHaveValue(`${f.prefix} 취소 시 보존`);
  let confirmations = 0; const accept = async (dialog: import('@playwright/test').Dialog) => { confirmations++; await dialog.accept(); }; page.on('dialog', accept); await target.click(); await expect(title).toHaveValue(f.target.title); page.off('dialog', accept); expect(confirmations).toBe(1);
  await page.locator('.docs-tree-link').filter({ hasText: f.source.title }).click(); await expect(title).toHaveValue(`${f.prefix} 취소 시 보존`); await page.locator('.docs-save-button').click(); await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  expect((await f.requests.delete(`/api/documents/${f.target.id}?expectedVersion=${f.target.version}`)).status()).toBe(200); expect((await f.requests.delete(`/api/issues/${f.issue.id}?expectedVersion=${f.issue.version}`)).status()).toBe(200); await page.reload(); await expect(page.locator('.doc-include-notice')).toContainText('포함 문서를 찾을 수 없습니다'); await expect(page.getByRole('button', { name: `찾을 수 없는 문서 ${f.target.title}`, exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: `찾을 수 없는 업무 ${f.issue.key} ${f.issue.title}`, exact: true })).toBeDisabled();
});

test('360px 문서에서 공유 보기 업무 목록을 삽입하고 현재 상태와 사라진 보기를 확인한다', async ({ page, blocks: f }) => {
  const projectId = f.source.projectId!;
  const otherResponse = await f.requests.post('/api/issues', {data:{projectId,title:`${f.prefix} 다른 조건의 업무`}});
  expect(otherResponse.status()).toBe(201);
  const other = await otherResponse.json() as Issue;
  const viewResponse = await f.requests.post('/api/views', {data:{
    projectId,name:`${f.prefix} 한 업무만 표시`,layout:'list',filters:{query:f.issue.title,status:'all',assigneeId:'all',type:'all'},
  }});
  expect(viewResponse.status()).toBe(201);
  const view = await viewResponse.json() as SavedView;
  try {
    await page.setViewportSize({width:360,height:820});
    await open(page, f);
    await insertIssueList(page, projectId, view.id);
    const list = page.getByRole('region', {name:'업무 목록',exact:true});
    const initial = list.getByRole('button', {name:`목록 업무 열기 ${f.issue.key} ${f.issue.title}`,exact:true});
    await expect(initial).toBeVisible();
    await expect(list).not.toContainText(other.title);

    const title = page.getByRole('textbox', {name:'문서 제목',exact:true});
    const editedTitle = `${f.source.title} 목록과 함께 저장`;
    await title.fill(editedTitle);
    await initial.click();
    const details = page.getByRole('dialog', {name:f.issue.title,exact:true});
    await expect(details).toBeVisible();
    await expect(page.locator('.docs-title-input')).toHaveValue(editedTitle);
    await details.getByRole('button', {name:'업무 상세 닫기',exact:true}).click();
    await expect(title).toHaveValue(editedTitle);
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    const saved = await currentDoc(f);
    expect(saved.content.content?.find(node => node.type === 'issueList')?.attrs).toMatchObject({projectId,savedViewId:view.id});
    expect(saved.plainText).not.toContain(f.issue.title);
    await page.getByRole('button', {name:'문서 내보내기',exact:true}).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', {name:'문서 JSON 내보내기',exact:true}).click();
    const downloaded = await (await downloadEvent).path();
    const exported = JSON.parse(readFileSync(downloaded!, 'utf8')) as {schemaVersion:number;document:DocPage};
    expect(exported.schemaVersion).toBe(3);
    expect(exported.document.content).toEqual(saved.content);

    const latestTitle = `${f.issue.title} 상태 갱신`;
    const changed = await f.requests.patch(`/api/issues/${f.issue.id}`, {data:{expectedVersion:f.issue.version,title:latestTitle,status:'in_progress',assigneeId:f.workspace.users[1].id}});
    expect(changed.status(), await changed.text()).toBe(200);
    await page.getByRole('button', {name:'참조 새로고침',exact:true}).click();
    const latest = list.getByRole('button', {name:`목록 업무 열기 ${f.issue.key} ${latestTitle}`,exact:true});
    await expect(latest).toContainText('진행 중');
    await expect(latest).toContainText(f.workspace.users[1].name);
    expect((await currentDoc(f)).version).toBe(saved.version);
    await latest.click();
    const updatedDetails = page.getByRole('dialog', {name:latestTitle,exact:true});
    await expect(updatedDetails).toBeVisible();
    await updatedDetails.getByRole('button', {name:'업무 상세 닫기',exact:true}).click();

    expect((await f.requests.delete(`/api/views/${view.id}?expectedVersion=${view.version}`)).status()).toBe(200);
    await page.getByRole('button', {name:'참조 새로고침',exact:true}).click();
    await expect(list).toContainText('공유 보기를 찾을 수 없습니다.');
    await expect(list).toContainText(view.name);
    await expect(list.getByRole('button', {name:/목록 업무 열기/})).toHaveCount(0);
    await list.getByRole('button', {name:'업무 목록 설정',exact:true}).click();
    const settings = page.getByRole('dialog', {name:'업무 목록 설정',exact:true});
    const apply = settings.getByRole('button', {name:'업무 목록 적용',exact:true});
    await expect(apply).toBeDisabled();
    await settings.getByLabel('업무 목록 공유 보기', {exact:true}).selectOption('');
    await apply.click();
    await expect(list).toContainText(other.title);
  } finally {
    await f.requests.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
  }
});

test('문서의 업무 목록과 현황 상세에 공유 보기의 최신 정렬을 반영한다', async ({ page, blocks: f }) => {
  const projectId = f.source.projectId!;
  const query = `${f.prefix} 정렬 업무`;
  async function create(suffix: string, dueDate: string | null) {
    const response = await f.requests.post('/api/issues', { data: { projectId, title: `${query} ${suffix}`, status: 'todo', dueDate } });
    expect(response.status(), await response.text()).toBe(201);
    return response.json() as Promise<Issue>;
  }
  const later = await create('늦은 마감일', '2027-02-03');
  const noDate = await create('마감일 미정', null);
  const earlier = await create('이른 마감일', '2027-02-01');
  const viewResponse = await f.requests.post('/api/views', { data: {
    projectId, name: `${f.prefix} 마감일순`, layout: 'list',
    sort: [{ field: 'dueDate', direction: 'asc' }],
    filters: { query, status: 'all', assigneeId: 'all', type: 'all' },
  } });
  expect(viewResponse.status(), await viewResponse.text()).toBe(201);
  let view = await viewResponse.json() as SavedView;

  try {
    const attrs = { projectId, savedViewId: view.id, label: view.name };
    const saved = await f.requests.patch(`/api/documents/${f.source.id}`, { data: {
      expectedVersion: f.source.version, contentSchemaVersion: 4,
      content: doc({ type: 'issueList', attrs }, { type: 'issueSummary', attrs: { ...attrs, groupBy: 'status' } }),
    } });
    expect(saved.status(), await saved.text()).toBe(200);
    const savedDocument = await saved.json() as DocPage;
    await page.setViewportSize({ width: 360, height: 820 });
    await open(page, f);
    const list = page.getByRole('region', { name: '업무 목록', exact: true });
    const summary = page.getByRole('region', { name: '업무 현황', exact: true });
    await summary.getByRole('button', { name: '할 일 3개', exact: true }).click();

    async function expectOrder(ordered: Issue[]) {
      await expect(list.getByRole('button', { name: /^목록 업무 열기/ }).locator('strong')).toHaveText(ordered.map(issue => issue.title));
      await expect(summary.getByRole('button', { name: /^현황 업무 열기/ }).locator('strong')).toHaveText(ordered.map(issue => issue.title));
    }
    await expectOrder([earlier, later, noDate]);

    const changed = await f.requests.patch(`/api/views/${view.id}`, { data: {
      expectedVersion: view.version, sort: [{ field: 'dueDate', direction: 'desc' }],
    } });
    expect(changed.status(), await changed.text()).toBe(200);
    view = await changed.json() as SavedView;
    await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
    await expectOrder([later, earlier, noDate]);
    expect((await currentDoc(f)).version).toBe(savedDocument.version);
  } finally {
    await f.requests.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
  }
});

test('360px 회의록에서 공유 보기 업무 현황을 바꾸고 묶음별 티켓을 연다', async ({ page, blocks: f }) => {
  const projectId = f.source.projectId!;
  const assignee = f.workspace.users[1];
  const query = `${f.prefix} 회의검토`;
  const create = async (title: string, status: string, priority: Issue['priority']) => {
    const response = await f.requests.post('/api/issues', {data:{projectId,title,status,priority,assigneeId:assignee.id}});
    expect(response.status(), await response.text()).toBe(201);
    return await response.json() as Issue;
  };
  const waiting = await create(`${query} 첫째`, 'todo', 'high');
  const ongoing = await create(`${query} 둘째`, 'in_progress', 'medium');
  const viewResponse = await f.requests.post('/api/views', {data:{
    projectId, name:`${f.prefix} 회의 업무`, layout:'list', filters:{query,status:'all',assigneeId:'all',type:'all'},
  }});
  expect(viewResponse.status(), await viewResponse.text()).toBe(201);
  const view = await viewResponse.json() as SavedView;

  try {
    await page.setViewportSize({width:360,height:820});
    await open(page, f);
    await insertIssueSummary(page, projectId, view.id);

    const card = page.getByRole('region', {name:'업무 현황',exact:true});
    const group = (name: string) => card.getByRole('button', {name,exact:true});
    const ticket = (issue: Issue) => card.getByRole('button', {name:`현황 업무 열기 ${issue.key} ${issue.title}`,exact:true});
    await expect(card).toContainText(view.name);
    await expect(group('진행 중 1개')).toBeVisible();
    await group('할 일 1개').press('Enter');
    await expect(ticket(waiting)).toBeVisible();
    await expect(ticket(ongoing)).toHaveCount(0);
    await expect(ticket(f.issue)).toHaveCount(0);
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    const initial = await currentDoc(f);
    expect(initial.content.content?.find(node => node.type === 'issueSummary')?.attrs).toMatchObject({projectId,savedViewId:view.id,groupBy:'status'});

    const changed = await f.requests.patch(`/api/issues/${waiting.id}`, {data:{expectedVersion:waiting.version,status:'in_progress'}});
    expect(changed.status(), await changed.text()).toBe(200);
    await page.getByRole('button', {name:'참조 새로고침',exact:true}).click();
    await expect(group('할 일 1개')).toHaveCount(0);
    await group('진행 중 2개').click();
    await expect(ticket(waiting)).toBeVisible();
    await expect(ticket(ongoing)).toBeVisible();
    expect((await currentDoc(f)).version).toBe(initial.version);
    await ticket(waiting).click();
    const details = page.getByRole('dialog', {name:waiting.title,exact:true});
    await expect(details).toBeVisible();
    await details.getByRole('button', {name:'업무 상세 닫기',exact:true}).click();
    await expect(ticket(waiting)).toBeVisible();

    const settings = page.getByRole('dialog', {name:'업무 현황 설정',exact:true});
    async function regroup(value: string) {
      await card.getByRole('button', {name:'업무 현황 설정',exact:true}).click();
      await settings.getByLabel('업무 현황 그룹 기준', {exact:true}).selectOption(value);
      await settings.getByRole('button', {name:'업무 현황 적용',exact:true}).click();
      await expect(settings).toBeHidden();
    }
    await regroup('assignee');
    await expect(group(`${assignee.name} 2개`)).toBeVisible();
    await regroup('priority');
    await expect(group('높음 1개')).toBeVisible();
    await expect(group('보통 1개')).toBeVisible();
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await page.reload();
    await expect(group('높음 1개')).toBeVisible();

    await page.getByRole('button', {name:'문서 내보내기',exact:true}).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', {name:'문서 JSON 내보내기',exact:true}).click();
    const path = await (await downloadEvent).path();
    const exported = JSON.parse(readFileSync(path!, 'utf8')) as {schemaVersion:number;document:DocPage};
    expect(exported.schemaVersion).toBe(4);
    expect(exported.document.content.content?.find(node => node.type === 'issueSummary')?.attrs).toMatchObject({projectId,savedViewId:view.id,groupBy:'priority'});
  } finally {
    await f.requests.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
  }
});

test('포함 렌더러는 순환·깊이·전체 표시 한도를 명시하며 유효하지 않은 포함을 선택할 수 없다', async ({ page, blocks: f }) => {
  const nestingErrors: string[] = []; page.on('console', message => { if (message.type() === 'error' && /In HTML|cannot be a descendant|cannot be a child|cannot contain/.test(message.text())) nestingErrors.push(message.text()); });
  let next = f.target; const chain: DocPage[] = [];
  for (let index = 0; index < 7; index++) { const response = await f.requests.post('/api/documents', { data: { projectId: f.source.projectId, title: `${f.prefix} 연결 단계 ${index}`, content: doc(include(next)) } }); expect(response.status()).toBe(201); next = await response.json() as DocPage; chain.push(next); }
  const largeResponse = await f.requests.post('/api/documents', { data: { projectId: f.source.projectId, title: `${f.prefix} 많은 내용`, content: doc({ type: 'table', content: Array.from({ length: 1200 }, (_, index) => ({ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(`합성 긴 표 ${index}`)] }, { type: 'tableCell', content: [paragraph('값')] }] })) }) } }); expect(largeResponse.status()).toBe(201); const large = await largeResponse.json() as DocPage;
  expect((await f.requests.patch(`/api/documents/${f.source.id}`, { data: { expectedVersion: f.source.version, content: doc(include(next), include(large)) } })).status()).toBe(200);
  // A read-only snapshot fixture simulates corrupt legacy/external data. No invalid graph is written to SQLite.
  await page.route('**/api/workspace', async route => { const response = await route.fetch(); const data = await response.json() as WorkspaceSnapshot; data.documents.find(value => value.id === chain[chain.length - 1].id)!.content = doc(include(f.source)); await route.fulfill({ response, json: data }); });
  await open(page, f); await expect(page.locator('.doc-include-notice').filter({ hasText: '순환 문서 포함' })).toBeVisible(); await expect(page.locator('.doc-include-notice').filter({ hasText: '표시 한도' })).toBeVisible(); await page.unroute('**/api/workspace'); await page.reload(); await expect(page.locator('.doc-include-notice').filter({ hasText: '깊이 제한' })).toBeVisible(); expect(nestingErrors).toEqual([]);
  await page.getByRole('button', { name: '문서 포함 삽입', exact: true }).click(); const chooser = page.getByRole('dialog', { name: '문서 포함 삽입', exact: true }); await chooser.getByLabel('참조할 항목 검색', { exact: true }).fill(f.source.title); await expect(chooser.locator('.doc-reference-results button').filter({ hasText: f.source.title })).toBeDisabled();
});

test('두 공동 편집자가 새 블록을 동기화하고 접기 표시를 로컬에만 바꾸며 복구 후에도 새 스키마가 유지된다', async ({ page, browser, baseURL, blocks: f }) => {
  expect((await f.requests.post(`/api/documents/${f.source.id}/collaboration/enable`, { data: { expectedVersion: f.source.version } })).status()).toBe(200);
  const [actorA, actorB] = f.workspace.users; await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorA.id);
  const second = await browser.newContext({ baseURL }); await second.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorB.id); const peer = await second.newPage(); let sent = 0;
  page.on('websocket', socket => socket.on('framesent', frame => { try { if (JSON.parse(String(frame.payload)).type === 'update') sent++; } catch { /* Other frames are irrelevant to the no-write toggle assertion. */ } }));
  try {
    await open(page, f); await open(peer, f); await expect(page.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    await Promise.all([choose(page, '업무 참조', f.issue.title), choose(peer, '문서 포함', f.target.title)]);
    for (const client of [page, peer]) { await expect(client.locator('.docs-live-prose .doc-reference-node > .doc-reference-card.issue')).toHaveCount(1); await expect(client.locator('.docs-live-prose .doc-reference-node > .doc-included-content')).toHaveCount(1); await expect(client.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨'); }
    await insertIssueList(page, f.source.projectId!);
    const list = peer.locator('.docs-live-prose [data-teamspace-node="issueList"]');
    await expect(list.getByRole('button', {name:`목록 업무 열기 ${f.issue.key} ${f.issue.title}`,exact:true})).toBeVisible();
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    expect((await currentDoc(f)).content.content?.find(node => node.type === 'issueList')?.attrs).toMatchObject({projectId:f.source.projectId,savedViewId:null});
    await insertIssueSummary(page, f.source.projectId!, '', 'priority');
    const chartGroup = (client: Page) => client.getByRole('region', {name:'업무 현황',exact:true}).getByRole('button', {name:/^보통 \d+개$/});
    await expect(chartGroup(peer)).toBeVisible();
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const beforeDrilldown = await currentDoc(f);
    expect(beforeDrilldown.content.content?.find(node => node.type === 'issueSummary')?.attrs).toMatchObject({projectId:f.source.projectId,savedViewId:null,groupBy:'priority'});
    const updatesBeforeDrilldown = sent;
    await chartGroup(page).click();
    await expect(chartGroup(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(chartGroup(peer)).toHaveAttribute('aria-expanded', 'false');
    expect(sent).toBe(updatesBeforeDrilldown);
    expect((await currentDoc(f)).version).toBe(beforeDrilldown.version);
    await page.getByRole('button', { name: '접기 블록 삽입', exact: true }).click(); await expect(peer.locator('.docs-live-prose details.doc-details-block')).toHaveCount(1); await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨'); const before = await currentDoc(f), beforeFrames = sent;
    await page.locator('.docs-live-prose details.doc-details-block > summary').click(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(sent).toBe(beforeFrames); expect((await currentDoc(f)).version).toBe(before.version); await expect(peer.locator('.docs-live-prose details.doc-details-block')).toHaveAttribute('open', '');
    const revisionResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${f.source.id}/checkpoint`) && response.request().method() === 'POST'); await page.getByRole('button', { name: '버전 기록', exact: true }).click(); const revision = await (await revisionResponse).json() as DocRevision;
    await page.locator('.docs-live-prose .doc-reference-node[data-teamspace-node="issueReference"]').hover(); await page.locator('.docs-live-prose .doc-reference-node[data-teamspace-node="issueReference"]').getByRole('button', { name: '참조 블록 삭제', exact: true }).click(); await expect(peer.locator('.docs-live-prose .doc-reference-node > .doc-reference-card.issue')).toHaveCount(0); await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const current = await currentDoc(f); expect((await f.requests.post(`/api/documents/${current.id}/restore`, { data: { expectedVersion: current.version, revisionId: revision.id } })).status()).toBe(200);
    for (const client of [page, peer]) { await expect(client.locator('.docs-collaboration-recovery')).toBeVisible(); client.once('dialog', dialog => dialog.accept()); await client.getByRole('button', { name: '최신 문서 열기', exact: true }).click(); await expect(client.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨'); await expect(client.locator('.docs-live-prose .doc-reference-node > .doc-reference-card.issue')).toHaveCount(1); await expect(chartGroup(client)).toBeVisible(); }
    const continuation = '복구 후 이어쓰기'; await page.locator('.docs-live-prose > p').last().click(); await page.keyboard.press('End'); await page.keyboard.insertText(continuation); await expect(peer.locator('.docs-live-prose')).toContainText(continuation); for (const client of [page, peer]) await expect(client.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨'); const persisted = await currentDoc(f); expect(persisted.plainText).toContain(continuation); expect(contentReferences(persisted.content)).toHaveLength(2); await page.locator('.docs-paper-scroll').evaluate(element => { element.scrollTop = 0; }); mkdirSync('docs/screenshots', { recursive: true }); await page.screenshot({ path: 'docs/screenshots/document-blocks.png', fullPage: true });
  } finally { await second.close(); }
});
