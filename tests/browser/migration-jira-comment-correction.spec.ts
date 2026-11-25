import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { AtlassianSearchTarget } from '../../shared/atlassian-search';
import type {
  CommentEditSnapshot, IssueCommentView, JiraOriginalCommentLinksResult, LegacyPackageSummary,
  MigrationApplyResult, MigrationOptions, MigrationPreview, SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot,
} from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'text' | 'status'>, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

test('360px에서 새 Jira 댓글 수정분을 검토하고 팀 편집과 원본 주소를 유지한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const originalKey = `JCR${suffix}`;
  const title = `Jira 댓글 수정 견본 ${suffix}`;
  const sourceBase = `https://jira-${suffix.toLowerCase()}.example.invalid/team`;
  const sourceIssueUrl = `${sourceBase}/browse/${originalKey}-1`;
  const sourceCommentUrl = `${sourceIssueUrl}?focusedCommentId=701#comment-701`;
  const author = { name: `comment-correction-${suffix}`, displayName: `원본 댓글 작성자 ${suffix}` };
  const created = '2020-08-01T00:00:00Z';
  const beforeDate = '2020-08-02T00:00:00Z';
  const afterDate = '2020-08-03T00:00:00Z';
  const oldLink = 'https://wiki.example.invalid/design/old';
  const newLink = 'https://wiki.example.invalid/design/new';
  const oldLabel = '이전 설계';
  const newLabel = '수정 설계';
  const localBody = '팀에서 직접 바꾼 댓글';
  const original = [
    { id: '701', body: `[${oldLabel}|${oldLink}]` },
    { id: '702', body: '팀 편집 전 댓글' },
    { id: '703', body: '시각을 확인할 기존 댓글' },
  ];
  const corrected = [
    { id: '701', body: `[${newLabel}|${newLink}]`, updated: afterDate },
    { id: '702', body: '원본에서 바뀐 팀 편집 대상', updated: afterDate },
    { id: '703', body: '수정 시각 없이 받은 댓글' },
  ];
  const workspace = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const { projects: [settingsProject], users: [actor] } = await workspace();
  const headers = { 'X-Actor-Id': actor.id };
  const staged: LegacyPackageSummary[] = [];
  let issueId: string | undefined;

  async function stage(next: boolean) {
    const filename = `jira-comment-${next ? 'correction' : 'original'}-${suffix}.json`;
    const comments = (next ? corrected : original.map(row => ({ ...row, updated: beforeDate })))
      .map(row => ({ ...row, author, created }));
    const jira = { issues: [{
      id: '1901', key: `${originalKey}-1`, self: `${sourceBase}/rest/api/2/issue/1901`, fields: {
        project: { id: '101', key: originalKey, name: title }, summary: title, created, updated: next ? afterDate : beforeDate,
        status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, comment: { comments },
      },
    }] };
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: `jira-comment-correction-${suffix}` });
    const source = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify(jira)),
    }), 201);
    staged.push(source);
    return source;
  }

  try {
    const initial = await stage(false);
    const { defaultConfiguration, identities } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${initial.id}`, { headers }));
    const identity = identities.find(item => item.sourceValue === author.name);
    if (!identity) throw new Error('The synthetic Jira author was not staged.');
    const configuration = {
      ...defaultConfiguration,
      users: { ...defaultConfiguration.users, [identity.id]: actor.id },
      sourceBaseUrls: { ...defaultConfiguration.sourceBaseUrls, [initial.id]: sourceBase },
    };
    const firstPlan = await json<MigrationPreview>(await request.post('/api/migrations/preview', { headers, data: { configuration } }), 201);
    expect(firstPlan.canApply, JSON.stringify(firstPlan.notices)).toBe(true);
    const { import: firstReceipt } = await json<MigrationApplyResult>(await request.post(`/api/migrations/previews/${firstPlan.id}/apply`, {
      headers, data: { expectedVersion: firstPlan.version, acknowledgements: firstPlan.requiredAcknowledgements },
    }), 201);
    const issue = (await workspace()).issues.find(item => firstReceipt.projectIds.includes(item.projectId) && item.title === title);
    if (!issue) throw new Error('The original Jira issue was not imported.');
    issueId = issue.id;
    const readComments = () => request.get('/api/comments', { headers, params: { resourceType: 'issue', resourceId: issue.id } })
      .then(response => json<IssueCommentView[]>(response));
    const firstComments = await readComments();
    const untouched = firstComments.find(comment => comment.body === `${oldLabel} <${oldLink}>`);
    const edited = firstComments.find(comment => comment.body === original[1].body);
    if (!untouched || !edited) throw new Error('The two original Jira comments are required.');
    const { editToken } = await json<CommentEditSnapshot>(await request.get(`/api/comments/${edited.id}/edit`, { headers }));
    await json<CommentEditSnapshot>(await request.patch(`/api/comments/${edited.id}`, {
      headers, data: { body: localBody, editToken, requestId: randomUUID() },
    }));
    const before = await readComments();
    expect(before).toHaveLength(3);

    const resolveComment = () => request.get('/api/atlassian-links/resolve', { headers, params: { url: sourceCommentUrl } })
      .then(response => json<{ targets: AtlassianSearchTarget[] }>(response));
    const target = { targetType: 'issue', targetId: issue.id, commentId: untouched.id };
    expect((await resolveComment()).targets).toEqual([target]);
    const readOriginalLinks = () => request.get(`/api/comments/${untouched.id}/jira-original-links`, { headers })
      .then(response => json<JiraOriginalCommentLinksResult>(response));
    expect((await readOriginalLinks()).links).toEqual([{ label: oldLabel, href: oldLink }]);

    const next = await stage(true);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${settingsProject.id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await settings.getByLabel(`이관 패키지 ${next.filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await settings.getByLabel('이관 방식', { exact: true }).selectOption('append');
    await settings.getByText('사용자 매핑', { exact: true }).click();
    await settings.getByLabel(`사용자 매핑 ${author.displayName}`, { exact: true }).selectOption(actor.id);
    const corrections = settings.getByRole('checkbox', { name: '기존 Jira 댓글의 수정분 검토', exact: true });
    const appendHistory = settings.getByRole('checkbox', { name: '기존 Jira 업무에 댓글과 작업 시간 기록 추가', exact: true });
    const preview = async () => {
      const pending = page.waitForResponse(response => response.url().endsWith('/api/migrations/preview') && response.request().method() === 'POST');
      await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
      return json<MigrationPreview>(await pending, 201);
    };
    await expect(corrections).not.toBeChecked();
    const disabled = await preview();
    expect(disabled.canApply).toBe(false);
    expect(disabled.jiraCommentReview).toBeUndefined();

    await corrections.check();
    await expect(appendHistory).not.toBeChecked();
    const plan = await preview();
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendTo).toMatchObject({ projectId: issue.projectId, refreshComments: true });
    expect(plan.configuration.appendTo?.refreshHistory).toBeUndefined();
    expect(plan.counts).toMatchObject({ updatedJiraComments: 1, conflictingJiraComments: 1, archivedJiraCommentCorrections: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const outcomes = review.getByRole('region', { name: 'Jira 댓글 수정 검토', exact: true });
    const safeRow = outcomes.getByRole('article', { name: 'Jira 댓글 701', exact: true });
    await expect(safeRow.getByText('수정 반영', { exact: true })).toBeVisible();
    const comparison = safeRow.getByLabel('댓글 본문 비교', { exact: true });
    await expect(comparison.getByText(`${oldLabel} <${oldLink}>`, { exact: true })).toBeVisible();
    await expect(comparison.getByText(`${newLabel} <${newLink}>`, { exact: true })).toBeVisible();
    const conflict = outcomes.getByRole('article', { name: 'Jira 댓글 702', exact: true });
    await expect(conflict.getByText('팀에서 수정한 댓글 유지', { exact: true })).toBeVisible();
    await expect(conflict.getByText(localBody, { exact: true })).toBeVisible();
    const archived = outcomes.getByRole('article', { name: 'Jira 댓글 703', exact: true });
    await expect(archived.getByText('원본에만 보관', { exact: true })).toBeVisible();
    const opener = archived.getByRole('button', { name: 'Jira 댓글 원본 보기', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('dialog', { name: 'Jira 댓글 수정 원본 기록', exact: true });
    await expect(detail).toContainText(next.filename);
    await expect(detail.getByLabel('원본 본문', { exact: true })).toHaveText(corrected[2].body);
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await readComments()).toEqual(before);

    for (const code of plan.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`) && response.request().method() === 'POST');
    const confirming = page.waitForEvent('dialog');
    const clickApply = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const confirmation = await confirming;
    const message = confirmation.message();
    await confirmation.accept();
    await clickApply;
    expect(message).toContain('Jira 댓글 수정 1건 반영');
    const { import: receipt } = await json<MigrationApplyResult>(await applying, 201);
    const receiptDetail = settings.getByLabel('이관 영수증 상세', { exact: true });
    for (const label of ['반영한 Jira 댓글 수정 1', '팀 변경을 유지한 Jira 댓글 1', '원본에만 보관한 Jira 댓글 수정 1']) {
      await expect(receiptDetail.getByText(label, { exact: true })).toBeVisible();
    }

    const after = await readComments();
    expect(after).toHaveLength(before.length);
    expect(after.find(comment => comment.id === untouched.id)).toMatchObject({
      id: untouched.id, resourceId: issue.id, authorId: actor.id, createdAt: untouched.createdAt,
      body: `${newLabel} <${newLink}>`, editVersion: (untouched.editVersion ?? 0) + 1,
    });
    expect(after.filter(comment => comment.id !== untouched.id)).toEqual(before.filter(comment => comment.id !== untouched.id));
    expect((await resolveComment()).targets).toEqual([target]);
    expect((await readOriginalLinks()).links).toEqual([{ label: newLabel, href: newLink }]);
    const { records } = await json<SourceRecordPage>(await request.get(`/api/source-imports/${receipt.id}/records?kind=comment`, { headers }));
    const preserved = records.find(record => record.record.sourceId === '703');
    if (!preserved) throw new Error('The archive-only source comment was not preserved in the new receipt.');
    const archivedRecord = await json<SourceRecordArchive>(await request.get(`/api/source-imports/${receipt.id}/records/${preserved.id}`, { headers }));
    expect(archivedRecord.record.text).toBe(corrected[2].body);
    expect(archivedRecord.jiraCommentCorrection).toBeUndefined();

    await expect(settings.getByRole('button', { name: '이관 원본·영수증 새로고침', exact: true })).toBeEnabled();
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}&issueComment=${untouched.id}`);
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const updated = panel.locator(`#issue-comment-${untouched.id}`);
    await expect(updated).toBeFocused();
    await expect(updated.getByRole('link', { name: newLink, exact: true })).toHaveAttribute('href', newLink);
    await expect(panel.locator(`#issue-comment-${edited.id}`)).toContainText(localBody);
  } finally {
    if (issueId) {
      const removed = await request.delete(`/api/issues/${issueId}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
    for (const item of staged) await request.delete(`/api/legacy-import/packages/${item.id}?expectedVersion=${item.version}`, { headers });
  }
});
