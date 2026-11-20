import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { reservationInstant, reservationLocalDateTime } from '../../shared/time-reservations';
import type { DocPage, DocumentPublicationView, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'America/Los_Angeles' });

const shiftedDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

test('360px 팀 개요의 프로젝트·팀원 조건을 적용하고 원래 업무와 검토본을 열어도 선택을 유지한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const workspace = await request.get('/api/workspace');
  expect(workspace.ok()).toBeTruthy();
  const { projects: [project, anotherProject], users: [member, anotherMember, author] } = await workspace.json() as WorkspaceSnapshot;
  expect(anotherProject).toBeDefined();
  expect(author).toBeDefined();
  const gitlab = async () => (await (await request.get('/api/integrations/gitlab')).json()) as GitlabSettings;
  const originalGitlab = await gitlab();
  expect(originalGitlab).toMatchObject({ baseUrl: '', projectIds: [] });

  const key = randomUUID();
  const issues: Issue[] = [];
  const docs: DocPage[] = [];
  const occurredAt = new Date(Date.now() - 30_000).toISOString();
  const date = reservationLocalDateTime(occurredAt).slice(0, 10);
  const dateBefore = shiftedDate(date, -1);
  const dateAfter = shiftedDate(date, 2);
  const gitlabUrl = `https://git.example.test/team-overview-${key}`;
  const secret = `synthetic-team-overview-${key}`;
  let gitlabConfigured = false;

  async function createIssue(title: string, fields: Partial<Issue>) {
    const response = await request.post('/api/issues', { data: { title: `${title} ${key}`, ...fields } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }

  async function requestReview(title: string, projectId: string | null, reviewerId: string) {
    const body = `${title}의 검토 고정본 ${key}`;
    const headers = { 'X-Actor-Id': author.id };
    const response = await request.post('/api/documents', { headers, data: { projectId, title: `${title} ${key}`,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
    } });
    expect(response.status(), await response.text()).toBe(201);
    const doc = await response.json() as DocPage;
    docs.push(doc);
    const path = `/api/documents/${doc.id}/publication`;
    const state = await request.get(path, { headers });
    expect(state.ok(), await state.text()).toBeTruthy();
    const current = await state.json() as DocumentPublicationView;
    const review = await request.post(path, { headers, data: { action: 'request', reviewerId,
      expectedVersion: current.version, expectedDocumentVersion: current.documentVersion, workspaceGeneration: current.workspaceGeneration,
    } });
    expect(review.status(), await review.text()).toBe(200);
    const reviewed = await review.json() as DocumentPublicationView;
    expect(reviewed.reviewRevision).not.toBeNull();
    return { ...doc, body, revision: reviewed.reviewRevision!.id };
  }

  async function recordMergeRequest(issue: Issue, id: number, updatedAt = occurredAt) {
    const title = `${issue.key} 팀 개요 MR ${id} ${key}`;
    const url = `${gitlabUrl}/repo/-/merge_requests/${id}`;
    const result = await request.post('/api/integrations/gitlab/webhook', {
      headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() }, data: {
        object_kind: 'merge_request', project: { id: 42, web_url: `${gitlabUrl}/repo` }, object_attributes: {
          id, iid: id, action: 'open', state: 'opened', title, source_branch: `feature/${issue.key}`, url, updated_at: updatedAt,
        },
      },
    });
    expect(result.status(), await result.text()).toBe(200);
    expect(await result.json()).toMatchObject({ linked: 1 });
    return { title, url };
  }

  async function reserve(issue: Issue, userId: string, start: string, end: string) {
    const response = await request.post(`/api/issues/${issue.id}/time-reservations`, { data: {
      userId, startAt: reservationInstant(`${date}T${start}`), endAt: reservationInstant(`${date}T${end}`), requestId: randomUUID(),
    } });
    expect(response.status(), await response.text()).toBe(201);
  }

  try {
    const matching = await createIssue('조건에 맞는 협력 업무', {
      projectId: project.id, assigneeId: anotherMember.id, collaboratorIds: [member.id], dueDate: dateBefore, endDate: dateAfter,
    });
    const wrongProject = await createIssue('다른 프로젝트의 담당 업무', {
      projectId: anotherProject.id, assigneeId: member.id, endDate: date,
    });
    const wrongMember = await createIssue('다른 팀원이 담당하는 업무', {
      projectId: project.id, assigneeId: anotherMember.id, dueDate: date,
    });
    const finished = await createIssue('기한이 지난 완료 업무', { projectId: project.id, assigneeId: member.id, status: 'done', dueDate: dateBefore });
    const review = await requestReview('조건에 맞는 대기 문서', project.id, member.id);
    const reviewWrongProject = await requestReview('다른 프로젝트의 대기 문서', anotherProject.id, member.id);
    const reviewWrongMember = await requestReview('다른 팀원이 검토할 대기 문서', project.id, anotherMember.id);
    const commonReview = await requestReview('공통 공간의 대기 문서', null, member.id);
    const changeDraft = await request.patch(`/api/documents/${review.id}`, { headers: { 'X-Actor-Id': author.id }, data: {
      expectedVersion: review.version, title: `새 초안 제목 ${key}`,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `검토 요청 뒤에 쓴 초안 ${key}` }] }] },
    } });
    expect(changeDraft.ok(), await changeDraft.text()).toBeTruthy();

    const settings = await request.patch('/api/integrations/gitlab', { data: {
      expectedVersion: originalGitlab.version, baseUrl: gitlabUrl, projectIds: [42], webhookSecret: secret,
    } });
    expect(settings.ok(), await settings.text()).toBeTruthy();
    gitlabConfigured = true;
    const merge = await recordMergeRequest(matching, 11);
    const mergeWrongProject = await recordMergeRequest(wrongProject, 12);
    const mergeWrongMember = await recordMergeRequest(wrongMember, 13);
    const olderMerge = await recordMergeRequest(matching, 14, `${shiftedDate(date, -7)}T03:00:00.000Z`);
    await reserve(matching, member.id, '08:30', '09:30');
    await reserve(wrongProject, member.id, '09:30', '10:30');
    await reserve(wrongMember, anotherMember.id, '08:30', '09:30');

    await page.goto(`/#/${project.id}/overview`);
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(member.id);
    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    await page.getByRole('button', { name: '팀 개요', exact: true }).click();
    await expect(page.getByRole('heading', { name: '팀 개요', exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.hash.startsWith(`#/${project.id}/teamoverview`));
    const projectFilter = page.getByLabel('프로젝트 필터', { exact: true });
    const memberFilter = page.getByLabel('팀원 필터', { exact: true });
    const dayFilter = page.getByLabel('기준일', { exact: true });
    // Move away first so selecting today's visible value also exercises the hash update.
    await dayFilter.fill(dateBefore);
    await dayFilter.fill(date);

    const deadline = page.getByRole('region', { name: '마감 확인', exact: true });
    const reviews = page.getByRole('region', { name: '검토 대기 문서', exact: true });
    const gitlabActivity = page.getByRole('region', { name: '최근 GitLab 활동', exact: true });
    const reservations = page.getByRole('region', { name: '당일 시간 배정', exact: true });
    const atLeast = async (region: typeof deadline, titles: string[]) => {
      for (const title of titles) await expect(region.getByRole('listitem').filter({ hasText: title })).toBeVisible();
    };
    const absent = async (region: typeof deadline, titles: string[]) => {
      for (const title of titles) await expect(region.getByRole('listitem').filter({ hasText: title })).toHaveCount(0);
    };

    await atLeast(deadline, [matching.title, wrongProject.title, wrongMember.title]);
    await absent(deadline, [finished.title]);
    await atLeast(reviews, [review.title, reviewWrongProject.title, reviewWrongMember.title, commonReview.title]);
    await atLeast(gitlabActivity, [merge.title, mergeWrongProject.title, mergeWrongMember.title]);
    await absent(gitlabActivity, [olderMerge.title]);
    await atLeast(reservations, [matching.title, wrongProject.title, wrongMember.title]);

    const selectedHash = () => new URL(page.url()).hash;
    const filters = () => new URLSearchParams(selectedHash().split('?')[1]);
    const allProjectsHash = selectedHash();
    await deadline.getByRole('button', { name: new RegExp(wrongProject.key) }).click();
    const anotherDrawer = page.getByRole('dialog', { name: wrongProject.title, exact: true });
    await expect(anotherDrawer).toBeVisible();
    await expect.poll(() => filters().get('issue')).toBe(wrongProject.id);
    await expect(page).toHaveURL(url => url.hash.startsWith(`#/${project.id}/teamoverview`));
    await anotherDrawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === allProjectsHash);

    await projectFilter.focus();
    await projectFilter.selectOption(project.id);
    await expect(projectFilter).toBeFocused();
    await atLeast(deadline, [matching.title, wrongMember.title]);
    await absent(deadline, [wrongProject.title]);
    await absent(reviews, [reviewWrongProject.title, commonReview.title]);
    await absent(gitlabActivity, [mergeWrongProject.title]);
    await absent(reservations, [wrongProject.title]);

    await memberFilter.focus();
    await memberFilter.selectOption(member.id);
    await expect(memberFilter).toBeFocused();
    await expect.poll(() => [filters().get('teamProject'), filters().get('teamMember'), filters().get('teamDate')]).toEqual([project.id, member.id, date]);
    const savedHash = selectedHash();
    await atLeast(deadline, [matching.title]);
    await absent(deadline, [wrongMember.title]);
    await atLeast(reviews, [review.title]);
    await absent(reviews, [reviewWrongMember.title]);
    await atLeast(gitlabActivity, [merge.title]);
    await absent(gitlabActivity, [mergeWrongMember.title]);
    await atLeast(reservations, [matching.title]);
    await absent(reservations, [wrongMember.title]);
    await expect(reservations).toContainText('08:30');

    for (const section of [deadline, reviews, gitlabActivity, reservations]) {
      const bounds = await section.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    }
    await expect(gitlabActivity.getByRole('link', { name: new RegExp(merge.title) })).toHaveAttribute('href', merge.url);
    await deadline.getByRole('button', { name: new RegExp(matching.key) }).click();
    const drawer = page.getByRole('dialog', { name: matching.title, exact: true });
    await expect(drawer).toBeVisible();
    await expect.poll(() => filters().get('issue')).toBe(matching.id);
    await expect.poll(() => filters().get('teamMember')).toBe(member.id);
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === savedHash);

    await reviews.getByRole('button', { name: new RegExp(review.title) }).click();
    await expect(page).toHaveURL(url => {
      const [path, query] = url.hash.split('?');
      const params = new URLSearchParams(query);
      return path === `#/${project.id}/documents/${review.id}` && params.get('publication') === 'review' && params.get('revision') === review.revision;
    });
    const reviewDialog = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await expect(reviewDialog.getByRole('region', { name: '검토 고정본 내용' })).toContainText(review.body);
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === savedHash);

    const shortcuts = page.getByRole('article', { name: project.name, exact: true });
    await shortcuts.getByRole('button', { name: '간트 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash.startsWith(`#/${project.id}/gantt`));
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === savedHash);
    await shortcuts.getByRole('button', { name: 'GitLab 활동 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash.startsWith(`#/${project.id}/development`));
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === savedHash);
    await page.reload();
    await expect(projectFilter).toHaveValue(project.id);
    await expect(memberFilter).toHaveValue(member.id);
    await expect(dayFilter).toHaveValue(date);
    await atLeast(deadline, [matching.title]);
    await atLeast(reviews, [review.title]);
    await absent(gitlabActivity, [mergeWrongMember.title]);
  } finally {
    try {
      for (const [collection, resources] of [['documents', docs], ['issues', issues]] as const) {
        for (const { id } of resources) {
          const response = await request.delete(`/api/${collection}/${id}`);
          if (response.status() === 404) continue;
          expect(response.ok(), await response.text()).toBeTruthy();
          const { trashEntryId } = await response.json() as { trashEntryId: string };
          const purge = await request.delete(`/api/trash/${trashEntryId}`);
          expect(purge.ok(), await purge.text()).toBeTruthy();
        }
      }
    } finally {
      if (gitlabConfigured) {
        const current = await gitlab();
        const reset = await request.patch('/api/integrations/gitlab', { data: {
          expectedVersion: current.version, baseUrl: '', projectIds: [], webhookSecret: '', signingToken: '', token: '',
        } });
        expect(reset.ok(), await reset.text()).toBeTruthy();
      }
    }
  }
});
