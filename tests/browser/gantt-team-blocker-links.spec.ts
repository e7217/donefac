import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type {
  Dependency, Issue, IssueRelation, Project, ScheduleBlockerLinkInput, ScheduleBlockerLinkPage,
  SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot,
} from '../../shared/types';

const listPath = '/api/schedule/blocker-links';
const previewPath = `${listPath}/preview`;
const applyPath = `${listPath}/apply`;
const undoPath = '/api/schedule/undo';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

function nextCandidateList(page: Page, projectId?: string) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === listPath && url.searchParams.get('offset') === '0' &&
      (projectId ? url.searchParams.get('projectId') === projectId && !url.searchParams.has('scope')
        : url.searchParams.get('scope') === 'team' && !url.searchParams.has('projectId'));
  });
}

test('360px 팀 간트에서 프로젝트별 차단 연결을 한 번에 적용하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [first, second], users: [actor] } = await workspace();
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const created = new Set<string>();
  async function issue(project: Project, title: string, startDate: string, endDate: string) {
    const result = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId: project.id, title: `${title} ${suffix}`, startDate, endDate },
    }), 201);
    created.add(result.id);
    return result;
  }
  async function block(source: Issue, target: Issue) {
    return json<IssueRelation>(await request.post(`/api/issues/${source.id}/relations`, {
      headers, data: { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' },
    }), 201);
  }
  async function schedule() {
    const { issues, dependencies } = await workspace();
    return {
      issues: issues.filter(item => created.has(item.id)),
      dependencies: dependencies.filter(link => created.has(link.predecessorId) || created.has(link.successorId)),
    };
  }

  try {
    const firstSource = await issue(first, '첫 프로젝트 준비 업무', '2026-11-16', '2026-11-18');
    const firstTarget = await issue(first, '첫 프로젝트 후행 업무', '2026-11-19', '2026-11-20');
    const firstLater = await issue(first, '첫 프로젝트 기존 연결 업무', '2026-11-23', '2026-11-25');
    const secondSource = await issue(second, '둘째 프로젝트 준비 업무', '2026-11-16', '2026-11-18');
    const secondTarget = await issue(second, '둘째 프로젝트 후행 업무', '2026-11-19', '2026-11-20');
    const firstBlocker = await block(firstSource, firstTarget);
    const keptBlocker = await block(firstTarget, firstLater);
    const secondBlocker = await block(secondSource, secondTarget);
    const crossProject = await block(firstSource, secondTarget);
    const retained = await json<Dependency>(await request.post('/api/dependencies', {
      headers, data: { predecessorId: firstTarget.id, successorId: firstLater.id, type: 'SS', lagDays: -2 },
    }), 201);
    const before = await schedule();
    const picked = [
      { id: firstBlocker.id, version: firstBlocker.version, projectId: first.id },
      { id: keptBlocker.id, version: keptBlocker.version, projectId: first.id },
      { id: secondBlocker.id, version: secondBlocker.version, projectId: second.id },
    ];

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${first.id}/gantt?scope=team`);
    await expect(page.getByRole('combobox', { name: '프로젝트 필터', exact: true })).toHaveValue('');
    const opener = page.getByRole('button', { name: '차단 관계로 일정 연결', exact: true });
    const allProjects = nextCandidateList(page);
    await opener.click();
    const listed = await json<ScheduleBlockerLinkPage>(await allProjects);
    expect(listed.items).toEqual(expect.arrayContaining(picked.map(item => expect.objectContaining(item))));
    expect(listed.items.map(item => item.id)).not.toContain(crossProject.id);

    const dialog = page.getByRole('dialog', { name: '차단 관계 선후행 검토', exact: true });
    const candidates = dialog.getByRole('region', { name: '차단 관계 목록', exact: true });
    const projectFilter = candidates.getByRole('combobox', { name: '차단 관계 프로젝트', exact: true });
    const checkbox = (source: Issue, target: Issue) => candidates.getByRole('checkbox', {
      name: `${source.key} → ${target.key} 차단 관계 선택`, exact: true,
    });
    await expect(projectFilter).toHaveValue('');
    await expect(checkbox(firstSource, firstTarget)).toBeVisible();
    await expect(checkbox(secondSource, secondTarget)).toBeVisible();
    await expect(checkbox(firstSource, secondTarget)).toHaveCount(0);

    async function narrow(project: Project) {
      const loading = nextCandidateList(page, project.id);
      await projectFilter.selectOption(project.id);
      await json<ScheduleBlockerLinkPage>(await loading);
    }
    await narrow(first);
    await expect(checkbox(secondSource, secondTarget)).toHaveCount(0);
    await checkbox(firstSource, firstTarget).check();
    await checkbox(firstTarget, firstLater).check();
    await narrow(second);
    await expect(checkbox(firstSource, firstTarget)).toHaveCount(0);
    await checkbox(secondSource, secondTarget).check();
    await expect(candidates.getByRole('status')).toHaveText('선택 3건 / 최대 100건');
    await candidates.getByText('선택한 차단 관계 3건', { exact: true }).click();
    const selected = candidates.locator('details[open]');
    await expect(selected.locator(`[data-schedule-project="${first.id}"]`).first()).toContainText(first.name);
    await expect(selected.locator(`[data-schedule-project="${second.id}"]`)).toContainText(second.name);
    await narrow(first);
    await expect(checkbox(firstSource, firstTarget)).toBeChecked();
    await expect(checkbox(firstTarget, firstLater)).toBeChecked();

    const reviewing = nextPost(page, previewPath);
    await dialog.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const response = await reviewing;
    const input = response.request().postDataJSON() as ScheduleBlockerLinkInput;
    expect(input).toEqual({ projectId: null, relations: picked });
    const preview = await json<SchedulePastePreview>(response);
    expect(preview).toMatchObject({ projectId: null, errors: [], unchanged: 1, changes: [] });
    expect(new Set(preview.projectIds)).toEqual(new Set([first.id, second.id]));
    expect(preview.previewId).toBeTruthy();
    const added = dialog.getByRole('table', { name: '새 선후행 연결 목록', exact: true });
    const kept = dialog.getByRole('table', { name: '유지할 선후행 연결 목록', exact: true });
    for (const project of [first, second]) {
      await expect(added.locator(`[data-schedule-project="${project.id}"]`)).toContainText(project.name);
    }
    await expect(kept.locator(`[data-schedule-project="${first.id}"]`)).toContainText(first.name);
    await expect(kept).toContainText('SS');
    await expect(kept).toContainText('-2');
    expect(await schedule()).toEqual(before);

    const attempts: string[] = [];
    let saved: SchedulePasteApplyResult | undefined;
    await page.route(`**${applyPath}`, async route => {
      attempts.push(route.request().postDataJSON().previewId);
      if (attempts.length !== 1) return route.continue();
      saved = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.fulfill({ status: 408, json: { error: '합성 프록시 응답 시간 초과' } });
    });
    const applying = nextPost(page, applyPath);
    await dialog.getByRole('button', { name: '검토한 연결 적용', exact: true }).click();
    expect((await applying).status()).toBe(408);
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recover).toBeFocused();
    await expect(projectFilter).toBeDisabled();
    const recovering = nextPost(page, applyPath);
    await recover.click();
    const recovered = await json<SchedulePasteApplyResult>(await recovering);
    expect(recovered).toEqual(saved);
    expect(recovered.dependencyChanges).toBe(2);
    expect(attempts).toEqual([preview.previewId, preview.previewId]);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    const applied = await schedule();
    expect(applied.issues).toEqual(before.issues);
    expect(applied.dependencies).toHaveLength(3);
    expect(applied.dependencies).toEqual(expect.arrayContaining([
      retained,
      expect.objectContaining({ predecessorId: firstSource.id, successorId: firstTarget.id, type: 'FS', lagDays: 0 }),
      expect.objectContaining({ predecessorId: secondSource.id, successorId: secondTarget.id, type: 'FS', lagDays: 0 }),
    ]));
    const undoing = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undo = await undoing;
    expect(undo.request().postDataJSON()).toEqual({ undoId: recovered.undoId });
    await json(undo);
    await expect.poll(schedule).toEqual(before);

    const sourceRelations = await Promise.all([firstSource, firstTarget, secondSource].map(async source =>
      json<IssueRelation[]>(await request.get(`/api/issues/${source.id}/relations`, { headers }))));
    expect(sourceRelations.flat()).toEqual(expect.arrayContaining([firstBlocker, keptBlocker, secondBlocker, crossProject]
      .map(item => expect.objectContaining({ id: item.id, version: item.version, sourceIssueId: item.sourceIssueId, targetIssueId: item.targetIssueId }))));
  } finally {
    for (const id of [...created].reverse()) {
      const removed = await request.delete(`/api/issues/${id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
});
