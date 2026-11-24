import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Response } from '@playwright/test';
import { documentContentSchemaVersion } from '../../shared/document-nodes';
import type { Comment, DocPage, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, RichContent, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const quote = '검토 반복 문구';
const confirmed = '이 위치에서 조건을 확인해 주세요.';
const ambiguous = '중복된 원본 위치의 댓글입니다.';
const otherPage = '다른 문서에만 위치 표식이 있는 댓글입니다.';
const confirmedReply = '선택한 부분의 조건을 확인했습니다.';
const ordinaryParentReply = '원문 위치가 없는 댓글에 대한 원본 답글입니다.';
const conflictingParentReply = '원본의 상위 댓글 정보가 서로 다릅니다.';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function inlineCommentExport(key: string, title: string) {
  const property = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
  const reference = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
  const object = (kind: string, id: string, fields: string) => `<object class="${kind}"><id name="id">${id}</id>${fields}</object>`;
  const marker = (id: string, text: string) => `<ac:inline-comment-marker ac:ref="${id}">${text}</ac:inline-comment-marker>`;
  const date = property('creationDate', '2020-11-21T00:00:00Z') + property('lastModificationDate', '2020-11-22T00:00:00Z');
  const sourceAuthor = '<property name="creator" class="ConfluenceUserImpl"><id name="key">old-author</id></property>';
  const body = (id: string, kind: string, ownerId: string, storage: string) => object('BodyContent', id,
    property('bodyType', '2') + property('body', storage) + reference('content', kind, ownerId));
  const page = (id: string, title: string) => object('Page', id, reference('space', 'Space', '42') + property('title', title) + property('version', '1') + sourceAuthor + date);
  const contentProperty = (id: string, commentId: string, name: string, value: string, valueField = 'stringValue') => object('ContentProperty', id,
    property('name', name) + property(valueField, value) + reference('contentEntity', 'Comment', commentId));
  const collection = (...ids: string[]) => `<collection name="contentProperties" class="java.util.Collection">${ids.map(id =>
    `<element class="ContentProperty" package="com.atlassian.confluence.content"><id name="id">${id}</id></element>`).join('')}</collection>`;
  const parent = (id: string, name = 'parent') =>
    `<property name="${name}" class="Comment" package="com.atlassian.confluence.pages"><id name="id">${id}</id></property>`;
  const comment = (id: string, bodyId: string, text: string, properties: string) =>
    `<object class="Comment" package="com.atlassian.confluence.pages"><id name="id">${id}</id>` +
    reference('containerContent', 'Page', '100') + sourceAuthor + date + properties + '</object>' +
    body(bodyId, 'Comment', id, `<p>${text}</p>`);
  const mainStorage = `<p>${quote}</p><p>두 번째 시작 ${marker('selection-exact', '<strong>검토</strong><em> 반복 문구</em>')} 두 번째 끝</p>` +
    `<p>${marker('selection-duplicate', '두 곳의 원본')}</p><p>${marker('selection-duplicate', '두 곳의 원본')}</p><p>다른 문서의 문장</p>`;
  const xml = `<hibernate-generic>
    ${object('Space', '42', property('key', key) + property('name', `원본 공간 ${key}`))}
    <object class="ConfluenceUserImpl"><id name="key">old-author</id>${property('name', 'original-comment-author')}</object>
    ${page('100', title)}${body('200', 'Page', '100', mainStorage)}
    ${page('101', `${title} 다른 문서`)}${body('201', 'Page', '101', `<p>${marker('selection-other-page', '다른 문서의 문장')}</p>`)}
    ${comment('303', '403', confirmedReply, parent('300'))}
    ${comment('304', '404', ordinaryParentReply, parent('301'))}
    ${comment('305', '405', conflictingParentReply, parent('300') + parent('301', 'parentComment'))}
    ${comment('300', '400', confirmed, collection('500', '501', '502'))}
    ${contentProperty('500', '300', 'inline-marker-ref', 'selection-exact')}
    ${contentProperty('501', '300', 'inline-original-selection', quote)}
    ${contentProperty('502', '300', 'inline-comment', '1', 'longValue')}
    ${comment('301', '401', ambiguous, collection('503'))}
    ${contentProperty('503', '301', 'inline-marker-ref', 'selection-duplicate')}
    ${comment('302', '402', otherPage, '')}
    ${contentProperty('504', '302', 'inline-marker-ref', 'selection-other-page')}
  </hibernate-generic>`;
  return zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]);
}

test('360px에서 Confluence 문장 댓글의 원래 위치와 답글을 열고 연결을 확인할 수 없는 댓글을 별도로 표시한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const key = `IC${suffix}`;
  const title = `이관한 문장 댓글 ${suffix}`;
  const query = new URLSearchParams({ filename: `${key}.zip`, instanceKey: `inline-comment-${suffix}`, product: 'confluence' });
  const source = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: inlineCommentExport(key, title),
  }), 201);
  let documentIds: string[] = [];
  try {
    const { users: [reviewer] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const { defaultConfiguration, identities } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
    const configuration = {
      ...defaultConfiguration,
      datePolicy: 'import-time',
      projects: defaultConfiguration.projects.map(mapping => ({ ...mapping, key, name: `댓글 이관 ${suffix}` })),
      users: Object.fromEntries(identities.map(identity => [identity.id, reviewer.id])),
    };
    const plan = await json<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts).toMatchObject({
      confluenceInlineCommentsAnchored: 1,
      confluenceInlineCommentsUnresolved: 2,
      confluenceInlineRepliesLinked: 1,
      confluenceInlineRepliesUnresolved: 2,
    });
    expect(plan.requiredAcknowledgements).toContain('CONFLUENCE_INLINE_COMMENT_ANCHOR_UNRESOLVED');
    const { import: receipt } = await json<MigrationApplyResult>(await request.post(`/api/migrations/previews/${plan.id}/apply`, {
      data: { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements },
    }), 201);
    const [projectId] = receipt.projectIds;
    const documents = (await json<WorkspaceSnapshot>(await request.get('/api/workspace'))).documents.filter(row => row.projectId === projectId);
    documentIds = documents.map(document => document.id);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), reviewer.id);
    await page.goto(`/#/${projectId}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const receipts = settings.getByRole('region', { name: '완료한 이관 영수증', exact: true });
    await receipts.getByRole('button').filter({ hasText: receipt.id }).click();
    const details = receipts.getByLabel('이관 영수증 상세', { exact: true });
    await expect(details.getByText('원문 위치를 연결한 문장 댓글 1', { exact: true })).toBeVisible();
    await expect(details.getByText('일반 댓글로 옮긴 위치 미확인 댓글 2', { exact: true })).toBeVisible();
    await expect(details.getByText('문장 댓글에 연결한 답글 1', { exact: true })).toBeVisible();
    await expect(details.getByText('일반 댓글로 옮긴 답글 2', { exact: true })).toBeVisible();

    const original = documents.find(row => row.title === title);
    if (!original) throw new Error('이관한 문서를 찾을 수 없습니다.');
    const commentsPath = `/api/comments?resourceType=document&resourceId=${original.id}`;
    const comments = await json<Comment[]>(await request.get(commentsPath));
    expect(comments.map(comment => comment.body).sort()).toEqual([
      confirmed, ambiguous, otherPage, confirmedReply, ordinaryParentReply, conflictingParentReply,
    ].sort());
    const saved = comments.find(comment => comment.body === confirmed);
    if (!saved?.documentSource) throw new Error('위치를 확인한 원본 댓글에 발췌가 저장되지 않았습니다.');
    const reply = comments.find(comment => comment.body === confirmedReply);
    if (!reply) throw new Error('원본 답글을 찾을 수 없습니다.');
    expect(saved.documentSource.text).toBe(quote);
    expect(comments.filter(comment => comment.documentSource).map(comment => comment.id)).toEqual([saved.id]);
    expect(reply.parentCommentId).toBe(saved.id);
    expect(comments.filter(comment => comment.parentCommentId).map(comment => comment.id)).toEqual([reply.id]);

    const latestText = '팀에서 다시 쓴 현재 문서 본문';
    const content: RichContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: latestText }] }] };
    const path = `/api/documents/${original.id}`;
    await json<DocPage>(await request.patch(path, { data: {
      expectedVersion: original.version, contentSchemaVersion: documentContentSchemaVersion(content), content,
    } }));
    await page.goto(`/#/${projectId}/documents/${original.id}?comment=${encodeURIComponent(saved.id)}`);
    const article = page.locator(`#document-comment-${saved.id}`);
    await expect(article).toBeFocused({ timeout: 25_000 });
    await expect(page.locator('.docs-prose')).toHaveText(latestText);
    await expect(article.locator('blockquote')).toHaveText(quote);
    const replyArticle = article.getByRole('article', { name: '답글', exact: true });
    await expect(replyArticle.getByText(confirmedReply, { exact: true })).toBeVisible();
    for (const body of [ambiguous, otherPage, ordinaryParentReply, conflictingParentReply]) {
      const fallback = page.locator('.docs-comment').filter({ hasText: body });
      await expect(fallback).toBeVisible();
      await expect(fallback.locator('blockquote')).toHaveCount(0);
      await expect(fallback.getByRole('article', { name: '답글', exact: true })).toHaveCount(0);
      await expect(fallback.getByRole('button', { name: '원문 저장본 열기', exact: true })).toHaveCount(0);
    }

    await article.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
    const reader = article.getByRole('region', { name: `댓글 원문 저장본 ${title}`, exact: true });
    const paragraphs = reader.locator('.doc-readonly-content > div > p');
    await expect(paragraphs.first()).toHaveText(quote);
    await expect(paragraphs.first().locator('mark[data-document-excerpt]')).toHaveCount(0);
    const selected = paragraphs.nth(1).locator('mark[data-document-excerpt]');
    await expect(selected.first()).toBeVisible();
    expect((await selected.allTextContents()).join('')).toBe(quote);
    await expect(selected.locator('strong')).toHaveText('검토');
    await expect(selected.locator('em')).toHaveText('반복 문구');

    await article.getByRole('button', { name: '원문 저장본 접기', exact: true }).click();
    const resolutionPath = `${path}/selection-comments/${saved.id}/resolution`;
    const resolved = page.waitForResponse(response => new URL(response.url()).pathname === resolutionPath && response.request().method() === 'PATCH');
    await article.getByRole('button', { name: '해결 처리', exact: true }).click();
    const after = await json<Comment>(await resolved);
    expect(after.resolution?.state).toBe('resolved');
    expect(after.documentSource).toEqual(saved.documentSource);
    await expect(article.getByRole('button', { name: '다시 열기', exact: true })).toBeVisible();
    await page.goto(`/#/${projectId}/documents/${original.id}?comment=${encodeURIComponent(reply.id)}`);
    await expect(replyArticle).toBeFocused({ timeout: 25_000 });
    await expect(replyArticle.getByText(confirmedReply, { exact: true })).toBeVisible();
  } finally {
    for (const id of documentIds) {
      const removed = await request.delete(`/api/documents/${id}`);
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
    await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});
