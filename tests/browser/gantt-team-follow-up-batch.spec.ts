import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { AutomaticSchedulePreview, Issue, IssueRelation, LegacyPackageSummary, MigrationConfiguration, MigrationOptions, MigrationPreview,
  Project, SchedulePasteApplyResult, TeamScheduleBlocker, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function scheduleResponse(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function removeIssues(request: APIRequestContext, issueIds: Iterable<string>, headers: Record<string, string>) {
  for (const id of [...issueIds].reverse()) {
    const removed = await request.delete(`/api/issues/${id}`, { headers });
    if (!removed.ok()) continue;
    const { trashEntryId } = await removed.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`, { headers });
  }
}

test('차단 관계가 바뀌면 선행 날짜 입력을 유지하고 최신 후행 업무를 다시 선택한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [first, second], users: [actor, peer] } = await workspace();
  const headers = { 'X-Actor-Id': actor.id };
  const peerHeaders = { 'X-Actor-Id': peer.id };
  const prefix = `후행 관계 재검토 ${randomUUID().slice(0, 8)}`;
  const created: string[] = [];
  const previewPath = '/api/schedule/team-follow-up-preview';
  const applyPath = '/api/schedule/team-follow-up-apply';
  async function issue(projectId: string, title: string, startDate: string, endDate: string) {
    const saved = await json<Issue>(await request.post('/api/issues', { headers, data: { projectId, title: `${prefix} ${title}`, startDate, endDate } }), 201);
    created.push(saved.id);
    return saved;
  }

  try {
    const source = await issue(first.id, '선행', '2026-11-23', '2026-11-24');
    const removed = await issue(second.id, '이전 후행', '2026-11-25', '2026-11-26');
    const replacement = await issue(second.id, '새 후행', '2026-11-25', '2026-11-26');
    const path = `/api/issues/${source.id}/relations`;
    const block = async (target: Issue, actorHeaders = headers) => json<IssueRelation>(await request.post(path, {
      headers: actorHeaders, data: { type: 'blocks', direction: 'outgoing', otherIssueId: target.id },
    }), 201);
    const oldRelation = await block(removed);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${first.id}/gantt?${new URLSearchParams({ scope: 'team', ganttQ: prefix })}`);
    await page.getByRole('button', { name: '프로젝트 간 차단', exact: true }).click();
    const blockers = page.getByRole('region', { name: '프로젝트 간 차단', exact: true });
    const [initial] = await Promise.all([scheduleResponse(page, previewPath),
      blockers.getByRole('button', { name: `${source.key} → ${removed.key} 프로젝트 간 일정 검토`, exact: true }).click()]);
    const initialProposal = await json<AutomaticSchedulePreview>(initial);
    const review = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    const start = review.getByLabel('선행 업무 시작일', { exact: true });
    const end = review.getByLabel('선행 업무 종료일', { exact: true });
    await end.fill('2026-11-27');

    await json<IssueRelation>(await request.patch(`${path}/${oldRelation.id}`, {
      headers: peerHeaders, data: { expectedVersion: oldRelation.version, type: 'related', direction: 'outgoing' },
    }));
    const newRelation = await block(replacement, peerHeaders);
    const newSource = await json<Issue>(await request.patch(`/api/issues/${source.id}`, {
      headers: peerHeaders, data: { expectedVersion: source.version, startDate: '2026-11-24' },
    }));
    const rejected = await json<{ details: { reason: string } }>(await request.post(applyPath, {
      headers, data: { previewId: initialProposal.previewId },
    }), 409);
    expect(rejected.details.reason).toBe('stale_team_follow_up_relations');
    const [stale] = await Promise.all([scheduleResponse(page, previewPath),
      review.getByRole('button', { name: '미리보기 다시 계산', exact: true }).click()]);
    expect(stale.status()).toBe(404);
    await expect(review.getByRole('button', { name: '함께 적용', exact: true })).toBeDisabled();
    await review.getByRole('button', { name: '최신 차단 관계 확인', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '최신 후행 업무 선택', exact: true });
    await expect(chooser.getByRole('checkbox', { name: `${removed.key} 함께 검토`, exact: true })).toHaveCount(0);
    const choice = chooser.getByRole('checkbox', { name: `${replacement.key} 함께 검토`, exact: true });
    await expect(choice).not.toBeChecked();
    await choice.check();
    const [recalculated] = await Promise.all([scheduleResponse(page, previewPath),
      chooser.getByRole('button', { name: '선택한 후행 일정 검토', exact: true }).click()]);
    expect(recalculated.request().postDataJSON()).toEqual({ relationId: newRelation.id, expectedVersion: newRelation.version,
      anchorChange: { id: source.id, expectedVersion: newSource.version, startDate: newSource.startDate, endDate: '2026-11-27' } });
    await expect(start).toHaveValue(newSource.startDate!);
    await expect(end).toHaveValue('2026-11-27');
    expect((await json<AutomaticSchedulePreview>(recalculated)).changes.map(change => change.id).sort()).toEqual([source.id, replacement.id].sort());

    const [applied] = await Promise.all([scheduleResponse(page, applyPath),
      review.getByRole('button', { name: '함께 적용', exact: true }).click()]);
    expect((await json<SchedulePasteApplyResult>(applied)).updated.map(issue => issue.id).sort()).toEqual([source.id, replacement.id].sort());
    await expect(review).toHaveCount(0);
    expect((await workspace()).issues.find(issue => issue.id === removed.id)).toEqual(removed);
  } finally { await removeIssues(request, created, headers); }
});

test('360px 간트 날짜 초안을 티켓 후행 검토에서 수정해 저장하고 동료의 시작일도 보존한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [first, second], users: [actor, peer] } = await workspace();
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `간트 후행 초안 ${randomUUID().slice(0, 8)}`;
  const created: string[] = [];
  const previewPath = '/api/schedule/team-follow-up-preview';
  const applyPath = '/api/schedule/team-follow-up-apply';
  async function issue(project: Project, label: string, startDate: string, endDate: string) {
    const saved = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId: project.id, title: `${prefix} ${label}`, startDate, endDate },
    }), 201);
    created.push(saved.id);
    return saved;
  }

  try {
    const source = await issue(first, '선행', '2026-11-23', '2026-11-24');
    const target = await issue(second, '후행', '2026-11-25', '2026-11-26');
    const other = await issue(first, '별도 초안', '2026-11-23', '2026-11-25');
    const blocker = await json<IssueRelation>(await request.post(`/api/issues/${source.id}/relations`, {
      headers, data: { type: 'blocks', direction: 'outgoing', otherIssueId: target.id },
    }), 201);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${first.id}/gantt?${new URLSearchParams({ scope: 'team', ganttQ: prefix })}`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = (value: Issue) => chart.locator(`[data-issue-id="${value.id}"]`);
    const anchorEnd = row(source).getByLabel(`${source.key} 종료일`, { exact: true });
    const otherEnd = row(other).getByLabel(`${other.key} 종료일`, { exact: true });
    await anchorEnd.fill('2026-11-27');
    await otherEnd.fill('2026-11-30');
    await row(source).locator('.gantt-issue-name').click();

    const ticket = page.getByRole('dialog', { name: source.title, exact: true });
    const title = ticket.getByLabel('제목', { exact: true });
    const comment = ticket.getByLabel('댓글 내용', { exact: true });
    const titledDraft = `${source.title} 제목 초안`;
    const commentDraft = '함께 저장할 때 보존할 댓글';
    await title.fill(titledDraft);
    await comment.fill(commentDraft);
    const launch = ticket.getByRole('button', { name: '프로젝트 간 일정 검토', exact: true });
    const review = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    const sourceStart = review.getByLabel('선행 업무 시작일', { exact: true });
    const sourceEnd = review.getByLabel('선행 업무 종료일', { exact: true });
    const apply = review.getByRole('button', { name: '함께 적용', exact: true });
    const anchorChange = { id: source.id, expectedVersion: source.version, startDate: source.startDate, endDate: '2026-11-27' };
    async function openReview() {
      const [response] = await Promise.all([scheduleResponse(page, previewPath), launch.click()]);
      expect(response.request().postDataJSON()).toEqual({ relationId: blocker.id, expectedVersion: blocker.version, anchorChange });
      await json<AutomaticSchedulePreview>(response);
      await expect(sourceEnd).toHaveValue(anchorChange.endDate);
    }

    await openReview();
    await review.getByRole('button', { name: '돌아가기', exact: true }).click();
    await expect(launch).toBeFocused();
    expect((await workspace()).issues.find(value => value.id === source.id)).toEqual(source);

    await openReview();
    const changed = await json<Issue>(await request.patch(`/api/issues/${source.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: source.version, startDate: '2026-11-24' },
    }));
    const [stale] = await Promise.all([scheduleResponse(page, applyPath), apply.click()]);
    expect(stale.status()).toBe(409);
    await review.getByRole('button', { name: '최신 일정 기준으로 다시 검토', exact: true }).click();
    await expect(sourceStart).toHaveValue(changed.startDate!);
    await expect(sourceEnd).toHaveValue(anchorChange.endDate);
    const finalEnd = '2026-11-30';
    await sourceEnd.fill(finalEnd);
    const [recalculated] = await Promise.all([scheduleResponse(page, previewPath),
      review.getByRole('button', { name: '미리보기 다시 계산', exact: true }).click()]);
    expect(recalculated.request().postDataJSON().anchorChange).toEqual({
      ...anchorChange, expectedVersion: changed.version, startDate: changed.startDate, endDate: finalEnd,
    });
    const proposal = await json<AutomaticSchedulePreview>(recalculated);
    expect(proposal.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: source.id, toStart: changed.startDate, toEnd: finalEnd }),
      expect.objectContaining({ id: target.id, toStart: '2026-12-01', toEnd: '2026-12-02' }),
    ]));
    const [applied] = await Promise.all([scheduleResponse(page, applyPath), apply.click()]);
    const result = await json<SchedulePasteApplyResult>(applied);
    expect(result.updated.map(value => value.id).sort()).toEqual([source.id, target.id].sort());
    await expect(review).toHaveCount(0);
    await expect(launch).toBeFocused();
    await expect(title).toHaveValue(titledDraft);
    await expect(comment).toHaveValue(commentDraft);
    const leave = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await Promise.all([leave, ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click()]);
    await expect(anchorEnd).toHaveValue(finalEnd);
    await expect(row(source).getByRole('button', { name: `${source.key} 날짜 저장`, exact: true })).toHaveCount(0);
    await expect(otherEnd).toHaveValue('2026-11-30');
    await expect(row(other).getByRole('button', { name: `${other.key} 날짜 저장`, exact: true })).toBeVisible();
    expect((await workspace()).issues.find(value => value.id === other.id)).toEqual(other);
  } finally { await removeIssues(request, created, headers); }
});

test('360px 차단 목록에서 고른 여러 프로젝트의 후행 일정만 함께 적용하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const readWorkspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [sourceProject, ordinaryProject], users: [actor] } = await readWorkspace();
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 7);
  const prefix = `후행 일괄 ${suffix}`;
  const issueIds = new Set<string>();
  const previewPath = '/api/schedule/team-follow-up-preview';
  const applyPath = '/api/schedule/team-follow-up-apply';
  const undoPath = '/api/schedule/undo';

  const createIssue = async (project: Project, title: string, startDate = '2026-11-16', endDate = startDate) => {
    const created = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId: project.id, title: `${prefix} ${title}`, startDate, endDate },
    }), 201);
    issueIds.add(created.id);
    return created;
  };
  const block = async (source: Issue, target: Issue) => json<IssueRelation>(await request.post(`/api/issues/${source.id}/relations`, {
    headers, data: { type: 'blocks', direction: 'outgoing', otherIssueId: target.id },
  }), 201);
  const readDates = async () => Object.fromEntries((await readWorkspace()).issues.filter(issue => issueIds.has(issue.id))
    .map(({ id, startDate, endDate, version }) => [id, { startDate, endDate, version }]));
  const readRelations = async (issue: Issue) => json<IssueRelation[]>(await request.get(`/api/issues/${issue.id}/relations`, { headers }));

  try {
    const holidayProject = await json<Project>(await request.post('/api/projects', {
      headers, data: { key: `H${suffix.toUpperCase()}`, name: `${prefix} 휴무 프로젝트` },
    }), 201);
    const ordinaryCalendar = await json<WorkCalendar>(await request.get(`/api/projects/${ordinaryProject.id}/calendar`));
    const holidayPath = `/api/projects/${holidayProject.id}/calendar`;
    const defaultCalendar = await json<WorkCalendar>(await request.get(holidayPath));
    const holidayCalendar = await json<WorkCalendar>(await request.patch(holidayPath, {
      headers, data: { ...defaultCalendar, expectedVersion: defaultCalendar.version, workingWeekdays: [1, 2, 3, 4, 5],
        exceptions: [{ date: '2026-11-23', isWorking: false, label: '가상 프로젝트 휴무' }] },
    }));
    const source = await createIssue(sourceProject, '저장된 날짜를 쓰는 원인', '2026-11-19', '2026-11-20');
    const ordinary = await createIssue(ordinaryProject, '다음 월요일에 시작할 대상', '2026-11-16', '2026-11-17');
    const holiday = await createIssue(holidayProject, '휴무 다음 근무일에 시작할 대상');
    const skipped = await createIssue(ordinaryProject, '선택하지 않을 대상');
    const ordinaryEdge = await block(source, ordinary);
    const holidayEdge = await block(source, holiday);
    await block(source, skipped);
    const before = await readDates();
    const relations = await readRelations(source);
    const boardHash = `#/${sourceProject.id}/gantt?${new URLSearchParams({ scope: 'team', ganttProject: sourceProject.id, ganttQ: prefix })}`;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/${boardHash}`);
    await page.getByRole('button', { name: '프로젝트 간 차단', exact: true }).click();
    const blockers = page.getByRole('region', { name: '프로젝트 간 차단', exact: true });
    const launcher = blockers.getByRole('button', { name: `${source.key} 후행 일정 함께 검토`, exact: true });
    await launcher.click();
    const chooser = page.getByRole('dialog', { name: '후행 업무 선택', exact: true });
    const choose = (issue: Issue) => chooser.getByRole('checkbox', { name: `${issue.key} 함께 검토`, exact: true });
    const openPreview = chooser.getByRole('button', { name: '선택한 후행 일정 검토', exact: true });
    await expect(openPreview).toBeDisabled();
    await expect(chooser).toContainText(ordinaryProject.name);
    await expect(chooser).toContainText(holidayProject.name);
    await expect(choose(skipped)).not.toBeChecked();
    await choose(ordinary).check();
    await choose(holiday).check();
    const waitingForPreview = scheduleResponse(page, previewPath);
    await openPreview.click();
    const previewResponse = await waitingForPreview;
    const posted = previewResponse.request().postDataJSON();
    expect(Object.keys(posted)).toEqual(['relations']);
    expect(posted.relations).toHaveLength(2);
    expect(posted.relations).toEqual(expect.arrayContaining([ordinaryEdge, holidayEdge].map(({ id, version }) => ({ relationId: id, expectedVersion: version }))));
    const proposed = await json<AutomaticSchedulePreview>(previewResponse);
    expect(proposed.blocking).toEqual([]);
    expect(proposed.teamFollowUp?.relations).toHaveLength(2);
    expect(proposed.teamFollowUp?.relations).toEqual(expect.arrayContaining([
      { relationId: ordinaryEdge.id, expectedVersion: ordinaryEdge.version, targetIssueId: ordinary.id },
      { relationId: holidayEdge.id, expectedVersion: holidayEdge.version, targetIssueId: holiday.id },
    ]));
    expect(proposed.calendarVersions).toMatchObject({ [ordinaryProject.id]: ordinaryCalendar.version, [holidayProject.id]: holidayCalendar.version });
    expect(proposed.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual(expect.arrayContaining([
      [ordinary.id, '2026-11-23', '2026-11-24'], [holiday.id, '2026-11-24', '2026-11-24'],
    ]));
    expect(proposed.changes).toHaveLength(2);

    const review = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    await expect(review.getByLabel('선행 업무 종료일', { exact: true })).toHaveValue(source.endDate!);
    const dates = review.getByRole('table', { name: '검토할 업무 일정', exact: true });
    await expect(dates.getByRole('row').filter({ hasText: ordinary.title })).toContainText(ordinaryProject.name);
    await expect(dates.getByRole('row').filter({ hasText: holiday.title })).toContainText(holidayProject.name);
    await expect(dates.getByRole('row').filter({ hasText: skipped.title })).toHaveCount(0);
    expect(await readDates()).toEqual(before);

    const writes: unknown[] = [];
    page.on('request', sent => {
      if (sent.method() === 'POST' && new URL(sent.url()).pathname === applyPath) writes.push(sent.postDataJSON());
    });
    let applied: SchedulePasteApplyResult | undefined;
    await page.route(url => url.pathname === applyPath, async route => {
      applied = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.fulfill({ status: 408, json: { error: '합성 응답 유실' } });
    }, { times: 1 });
    const waitingForApply = scheduleResponse(page, applyPath);
    await review.getByRole('button', { name: '함께 적용', exact: true }).click();
    expect((await waitingForApply).status()).toBe(408);
    const checkResult = review.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(checkResult).toBeVisible();
    await expect(review.getByLabel('선행 업무 종료일', { exact: true })).toBeDisabled();
    const waitingForResult = scheduleResponse(page, `/api/schedule/team-follow-up-result/${proposed.previewId}`, 'GET');
    await checkResult.click();
    expect(await json<SchedulePasteApplyResult>(await waitingForResult)).toEqual(applied);
    expect(writes).toEqual([{ previewId: proposed.previewId }]);
    await expect(review).toHaveCount(0);
    await expect(launcher).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === boardHash);
    expect(await readDates()).toEqual({ ...before,
      [ordinary.id]: { startDate: '2026-11-23', endDate: '2026-11-24', version: before[ordinary.id].version + 1 },
      [holiday.id]: { startDate: '2026-11-24', endDate: '2026-11-24', version: before[holiday.id].version + 1 },
    });

    const waitingForUndo = scheduleResponse(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undoResponse = await waitingForUndo;
    expect(undoResponse.request().postDataJSON()).toEqual({ undoId: applied!.undoId });
    const undone = await json<SchedulePasteApplyResult>(undoResponse);
    expect(undone.updated.map(issue => issue.id).sort()).toEqual([ordinary.id, holiday.id].sort());
    const afterUndo = await readDates();
    expect(afterUndo[source.id]).toEqual(before[source.id]);
    expect(afterUndo[skipped.id]).toEqual(before[skipped.id]);
    for (const issue of [ordinary, holiday]) {
      expect(afterUndo[issue.id]).toMatchObject({ startDate: issue.startDate, endDate: issue.endDate });
    }
    expect(await readRelations(source)).toEqual(relations);
  } finally {
    await removeIssues(request, issueIds, headers);
  }
});

test('360px에서는 간트의 날짜 초안과 고른 Jira 이관 관계를 함께 검토한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { users: [actor] } = await workspace();
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const prefix = `Jira 후행 ${suffix}`;
  const packages: LegacyPackageSummary[] = [];
  const issueIds = new Set<string>();
  const originalKeys = { source: `OA${suffix}`, target: `OB${suffix}` };
  const targetIds = ['201', '202', '203'];
  const labels: Record<string, string> = { '100': '초안을 작성할 Jira 선행 업무', '201': '첫 번째 Jira 후행 업무',
    '202': '두 번째 Jira 후행 업무', '203': '선택하지 않은 Jira 후행 업무' };
  const linkType = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };

  function sourceRecord(id: string, project: 'source' | 'target', relationId?: string) {
    const key = originalKeys[project];
    return { id, key: `${key}-${id}`, fields: {
      project: { id: project === 'source' ? '10101' : '10102', key, name: `${key} Jira 프로젝트` },
      summary: `${prefix} ${labels[id]}`, created: '2020-09-01T09:00:00Z', updated: '2020-09-02T09:00:00Z',
      issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' },
      issuelinks: relationId ? [{ id: relationId, type: linkType, inwardIssue: { id: '100' } }] : [],
    } };
  }

  async function options(tag: string, rows: ReturnType<typeof sourceRecord>[]) {
    const query = new URLSearchParams({ filename: `jira-${suffix}-${tag}.json`, product: 'jira', instanceKey: `handoff-${suffix}` });
    const staged = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify({ issues: rows })),
    }), 201);
    packages.push(staged);
    return json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${staged.id}`, { headers }));
  }

  async function importSelected(configuration: MigrationConfiguration) {
    const preview = await json<MigrationPreview>(await request.post('/api/migrations/preview', { headers, data: { configuration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    await json(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      headers, data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
  }

  async function setDates(id: string, startDate: string, endDate = startDate) {
    const issue = (await workspace()).issues.find(row => row.title === `${prefix} ${labels[id]}`)!;
    expect(issue).toBeDefined();
    issueIds.add(issue.id);
    return json<Issue>(await request.patch(`/api/issues/${issue.id}`, {
      headers, data: { expectedVersion: issue.version, startDate, endDate },
    }));
  }

  try {
    const sourceOptions = await options('source', [sourceRecord('100', 'source')]);
    await importSelected(sourceOptions.defaultConfiguration);
    const targetOptions = await options('target', targetIds.map(id => sourceRecord(id, 'target')));
    await importSelected(targetOptions.defaultConfiguration);
    const refresh = await options('links', targetIds.map((id, index) => sourceRecord(id, 'target', String(801 + index))));
    const target = refresh.appendTarget!;
    expect(target).toBeDefined();
    await importSelected({ ...refresh.defaultConfiguration, appendTo: {
      projectId: target.projectId,
      statuses: Object.fromEntries(refresh.statuses.map(row => [row.id, target.statuses.find(status => status.label === row.label)!.id])),
      issueTypes: Object.fromEntries(refresh.issueTypes.map(row => [row.id, target.issueTypes.find(type => type.name === row.label)!.id])),
      fields: Object.fromEntries(refresh.fields.map(row => [row.id, null])),
      refreshRelations: true,
    } });
    const source = await setDates('100', '2026-11-19', '2026-11-20');
    const first = await setDates('201', '2026-11-16');
    const second = await setDates('202', '2026-11-16', '2026-11-17');
    const skipped = await setDates('203', '2026-11-16');
    const jiraLinks = (await json<TeamScheduleBlocker[]>(await request.get('/api/schedule/team-blockers', { headers })))
      .filter(edge => edge.sourceIssueId === source.id);
    expect(jiraLinks).toHaveLength(3);
    expect(jiraLinks.every(edge => edge.origin === 'jira')).toBe(true);

    const previewPath = '/api/schedule/team-follow-up-preview';
    const applyPath = '/api/schedule/team-follow-up-apply';
    const nextEnd = '2026-11-24';
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const crossArrows = chart.locator('path[data-team-blocker-id]');
    const teamScope = new URLSearchParams({ scope: 'team', ganttQ: prefix });
    await page.goto(`/#/${source.projectId}/gantt?${teamScope}`);
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill('2026-11-16');
    await expect(page.getByRole('checkbox', { name: '프로젝트 간 차단 표시', exact: true })).toBeChecked();
    await expect(crossArrows).toHaveCount(3);
    for (const link of jiraLinks) {
      await expect(crossArrows.and(chart.locator(`[data-team-blocker-id="${link.id}"]`))).toHaveAttribute('data-dependency-conflict', 'true');
    }
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(`${prefix} ${labels['100']}`);
    await expect(crossArrows).toHaveCount(0);
    await page.goto(`/#/${source.projectId}/gantt`);
    await expect(page.getByRole('checkbox', { name: '프로젝트 간 차단 표시', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '일정 충돌', exact: true }).click();
    const findings = page.getByRole('region', { name: '일정 충돌', exact: true });
    await expect(findings.getByText('프로젝트 간 차단 · Jira 원본', { exact: true })).toHaveCount(3);
    for (const link of jiraLinks) {
      const row = findings.locator(`[data-team-blocker-id="${link.id}"]`);
      await expect(row).toContainText('2026-11-23부터');
    }
    await findings.getByRole('button', { name: '일정 충돌 닫기', exact: true }).click();
    const anchor = page.getByRole('region', { name: '간트 차트', exact: true }).locator(`[data-issue-id="${source.id}"]`);
    const sourceEnd = anchor.getByLabel(`${source.key} 종료일`, { exact: true });
    const startReview = anchor.getByRole('button', { name: `${source.key} 프로젝트 간 일정 검토`, exact: true });
    await sourceEnd.fill(nextEnd);
    const chooser = page.getByRole('dialog', { name: '후행 업무 선택', exact: true });
    const preview = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    async function reviewSelected() {
      await startReview.click();
      await expect(chooser.getByRole('list', { name: '차단되는 후행 업무', exact: true }).getByText(/Jira 이관 관계/)).toHaveCount(3);
      for (const issue of [first, second]) await chooser.getByRole('checkbox', { name: `${issue.key} 함께 검토`, exact: true }).check();
      const waiting = scheduleResponse(page, previewPath);
      await chooser.getByRole('button', { name: '선택한 후행 일정 검토', exact: true }).click();
      const response = await waiting;
      expect(response.request().postDataJSON()).toEqual({
        relations: [first, second].map(issue => {
          const edge = jiraLinks.find(row => row.targetIssueId === issue.id)!;
          return { relationId: edge.id, expectedVersion: edge.version };
        }),
        anchorChange: { id: source.id, expectedVersion: source.version, startDate: source.startDate, endDate: nextEnd },
      });
      const result = await json<AutomaticSchedulePreview>(response);
      expect(result.blocking).toEqual([]);
      const [anchorChange, ...followUps] = result.changes;
      expect(anchorChange).toMatchObject({ id: source.id, toStart: source.startDate, toEnd: nextEnd });
      expect(followUps).toHaveLength(2);
      expect(followUps.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual(expect.arrayContaining([
        [first.id, '2026-11-25', '2026-11-25'], [second.id, '2026-11-25', '2026-11-26'],
      ]));
      return result;
    }

    await reviewSelected();
    await preview.getByRole('button', { name: '돌아가기', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(startReview).toBeFocused();
    await expect(sourceEnd).toHaveValue(nextEnd);
    expect((await workspace()).issues.find(issue => issue.id === source.id)).toMatchObject({ endDate: source.endDate, version: source.version });

    const reviewed = await reviewSelected();
    const waitingForApply = scheduleResponse(page, applyPath);
    await preview.getByRole('button', { name: '함께 적용', exact: true }).click();
    const appliedResponse = await waitingForApply;
    expect(appliedResponse.request().postDataJSON()).toEqual({ previewId: reviewed.previewId });
    const applied = await json<SchedulePasteApplyResult>(appliedResponse);
    expect(applied.updated.map(issue => issue.id).sort()).toEqual([source.id, first.id, second.id].sort());
    expect((await workspace()).issues.find(issue => issue.id === skipped.id)).toMatchObject({ startDate: skipped.startDate, endDate: skipped.endDate,
      version: skipped.version });
    await expect(preview).toHaveCount(0);
    await expect(sourceEnd).toHaveValue(nextEnd);
  } finally {
    await removeIssues(request, issueIds, headers);
    for (const pkg of packages) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`, { headers });
  }
});

test('360px 티켓에서 날짜 초안을 넘겨 여러 프로젝트의 후행을 검토하고 같은 티켓에서 되돌린다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const readWorkspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [sourceProject, standardProject], users: [actor, peer] } = await readWorkspace();
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 7);
  const prefix = `티켓 후행 일정 ${suffix}`;
  const issueIds = new Set<string>();
  const previewPath = '/api/schedule/team-follow-up-preview';
  const applyPath = '/api/schedule/team-follow-up-apply';
  const undoPath = '/api/schedule/undo';
  async function createIssue(project: Project, title: string, startDate: string, endDate: string) {
    const result = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId: project.id, title: `${prefix} ${title}`, startDate, endDate },
    }), 201);
    issueIds.add(result.id);
    return result;
  }

  try {
    const holidayProject = await json<Project>(await request.post('/api/projects', {
      headers, data: { key: `TH${suffix.toUpperCase()}`, name: `${prefix} 대상 휴무` },
    }), 201);
    const calendarPath = `/api/projects/${holidayProject.id}/calendar`;
    const calendar = await json<WorkCalendar>(await request.get(calendarPath));
    await json<WorkCalendar>(await request.patch(calendarPath, { headers, data: {
      expectedVersion: calendar.version, exceptions: [{ date: '2026-11-27', isWorking: false, label: '대상 휴무' }],
    } }));
    const source = await createIssue(sourceProject, '원인', '2026-11-23', '2026-11-24');
    const standard = await createIssue(standardProject, '일반 달력의 후행', '2026-11-25', '2026-11-26');
    const holiday = await createIssue(holidayProject, '휴일을 건너뛰는 후행', '2026-11-25', '2026-11-25');
    for (const target of [standard, holiday]) {
      await json<IssueRelation>(await request.post(`/api/issues/${source.id}/relations`, {
        headers, data: { type: 'blocks', direction: 'outgoing', otherIssueId: target.id },
      }), 201);
    }

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${sourceProject.id}/issues?issue=${source.id}`);
    const details = page.getByRole('dialog', { name: source.title, exact: true });
    const panelStart = details.getByLabel('시작일', { exact: true });
    const panelEnd = details.getByLabel('종료일', { exact: true });
    const due = details.getByLabel('목표 마감일', { exact: true });
    const description = details.getByRole('textbox', { name: '설명', exact: true });
    const comment = details.getByRole('textbox', { name: '댓글 내용', exact: true });
    const launch = details.getByRole('button', { name: '프로젝트 간 일정 검토', exact: true });
    const chooser = page.getByRole('dialog', { name: '후행 업무 선택', exact: true });
    const review = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    await panelEnd.fill('2026-11-26');
    await due.fill('2026-12-10');
    await description.fill('아직 저장하지 않은 원인 설명');
    await comment.fill('아직 게시하지 않은 댓글');
    await launch.click();
    await chooser.getByRole('button', { name: '취소', exact: true }).click();
    await expect(launch).toBeFocused();
    await expect(panelEnd).toHaveValue('2026-11-26');
    await expect(due).toHaveValue('2026-12-10');

    await launch.click();
    for (const target of [standard, holiday]) {
      await chooser.getByRole('checkbox', { name: `${target.key} 함께 검토`, exact: true }).check();
    }
    const opening = scheduleResponse(page, previewPath);
    await chooser.getByRole('button', { name: '선택한 후행 일정 검토', exact: true }).click();
    const originalPreview = await opening;
    expect(originalPreview.request().postDataJSON().anchorChange).toEqual({
      id: source.id, expectedVersion: source.version, startDate: source.startDate, endDate: '2026-11-26',
    });
    const comparison = review.getByRole('table', { name: '검토할 업무 일정', exact: true });
    await expect(comparison.getByRole('row').filter({ hasText: standard.title })).toContainText(standardProject.name);
    await expect(comparison.getByRole('row').filter({ hasText: holiday.title })).toContainText(holidayProject.name);
    const bounds = (await review.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);

    const peerSaved = await json<Issue>(await request.patch(`/api/issues/${source.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: source.version, startDate: '2026-11-24', dueDate: '2026-12-15' },
    }));
    const apply = review.getByRole('button', { name: '함께 적용', exact: true });
    const stale = scheduleResponse(page, applyPath);
    await apply.click();
    expect((await stale).status()).toBe(409);
    await review.getByRole('button', { name: '최신 일정 기준으로 다시 검토', exact: true }).click();
    await expect(review.getByLabel('선행 업무 시작일', { exact: true })).toHaveValue(peerSaved.startDate!);
    await expect(review.getByLabel('선행 업무 종료일', { exact: true })).toHaveValue('2026-11-26');
    const recalculating = scheduleResponse(page, previewPath);
    await review.getByRole('button', { name: '미리보기 다시 계산', exact: true }).click();
    const retryPreview = await recalculating;
    expect(retryPreview.request().postDataJSON().anchorChange).toEqual({
      id: source.id, expectedVersion: peerSaved.version, startDate: '2026-11-24', endDate: '2026-11-26',
    });
    const reviewed = await json<AutomaticSchedulePreview>(retryPreview);
    expect(reviewed.blocking).toEqual([]);
    expect(reviewed.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual(expect.arrayContaining([
      [standard.id, '2026-11-27', '2026-11-30'], [holiday.id, '2026-11-30', '2026-11-30'],
    ]));

    let applied: SchedulePasteApplyResult | undefined;
    await page.route(url => url.pathname === applyPath, async route => {
      expect(route.request().headers()['x-teamspace-schedule-undo-scope']).toBe(`issue:${source.id}`);
      applied = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.fulfill({ status: 408, json: { error: '합성 응답 유실' } });
    }, { times: 1 });
    await apply.click();
    const retry = review.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const recovery = scheduleResponse(page, `/api/schedule/team-follow-up-result/${reviewed.previewId}`, 'GET');
    await retry.click();
    expect(await json<SchedulePasteApplyResult>(await recovery)).toEqual(applied);
    await expect(review).toHaveCount(0);
    await expect(launch).toBeFocused();
    await expect(panelStart).toHaveValue('2026-11-24');
    await expect(panelEnd).toHaveValue('2026-11-26');
    await expect(due).toHaveValue('2026-12-10');
    await expect(description).toHaveValue('아직 저장하지 않은 원인 설명');
    await expect(comment).toHaveValue('아직 게시하지 않은 댓글');
    await expect(details.getByText('다른 변경사항이 있습니다', { exact: true })).toBeVisible();
    expect((await readWorkspace()).issues.find(issue => issue.id === source.id)).toMatchObject({
      version: peerSaved.version + 1, dueDate: peerSaved.dueDate, description: source.description,
    });

    const undoing = scheduleResponse(page, undoPath);
    await details.getByRole('button', { name: '일정과 연결 되돌리기', exact: true }).click();
    const undoResponse = await undoing;
    expect(undoResponse.request().postDataJSON()).toEqual({ undoId: applied!.undoId });
    const undone = await json<SchedulePasteApplyResult>(undoResponse);
    expect(undone.updated.map(issue => issue.id).sort()).toEqual([source.id, standard.id, holiday.id].sort());
    await expect(panelStart).toHaveValue(peerSaved.startDate!);
    await expect(panelEnd).toHaveValue(source.endDate!);
    await expect(due).toHaveValue('2026-12-10');
    await expect(description).toHaveValue('아직 저장하지 않은 원인 설명');
    await expect(comment).toHaveValue('아직 게시하지 않은 댓글');
    await expect(details.getByText('다른 변경사항이 있습니다', { exact: true })).toBeVisible();
    const restored = await readWorkspace();
    expect(restored.issues.find(issue => issue.id === source.id)?.dueDate).toBe(peerSaved.dueDate);
    for (const target of [standard, holiday]) expect(restored.issues.find(issue => issue.id === target.id)).toMatchObject({
      startDate: target.startDate, endDate: target.endDate,
    });
    await expect(page).toHaveURL(url => url.hash === `#/${sourceProject.id}/issues?issue=${source.id}`);
  } finally {
    await removeIssues(request, issueIds, headers);
  }
});
