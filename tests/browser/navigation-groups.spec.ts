import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ApiKeyCreated, ApiKeyRecord, Issue, Project, WorkspaceSnapshot } from '../../shared/types';

type NavigationGroupsFixture = { requests: APIRequestContext; project: Project; issue: Issue; prefix: string };

const test = base.extend<{ navigationGroups: NavigationGroupsFixture }>({
  navigationGroups: [async ({ playwright, baseURL }, provide, testInfo) => {
    const requests = await playwright.request.newContext({ baseURL });
    const prefix = `메뉴 묶음 검증 ${randomUUID()}`;
    try {
      const response = await requests.get('/api/workspace', { timeout: 10_000 });
      expect(response.ok()).toBeTruthy();
      const workspace = await response.json() as WorkspaceSnapshot;
      const [project] = workspace.projects;
      expect(project).toBeTruthy();
      const created = await requests.post('/api/issues', { timeout: 10_000, data: { projectId: project.id, title: `${prefix} 업무` } });
      expect(created.status(), await created.text()).toBe(201);
      await provide({ requests, project, issue: await created.json() as Issue, prefix });
    } finally {
      try {
        const response = await requests.get('/api/workspace', { timeout: 5_000 });
        const snapshot = response.ok() ? await response.json() as WorkspaceSnapshot : undefined;
        const failures: string[] = [];
        for (const issue of snapshot?.issues.filter(value => value.title.startsWith(prefix)) ?? []) {
          const result = await requests.delete(`/api/issues/${issue.id}`, { timeout: 5_000 });
          if (!result.ok() && result.status() !== 404) failures.push(`issues/${issue.id}: ${result.status()}`);
        }
        if (failures.length) {
          await testInfo.attach('navigation-groups-cleanup-failures', { body: failures.join('\n'), contentType: 'text/plain' });
          throw new Error(`합성 메뉴 검증 데이터를 정리하지 못했습니다: ${failures.join(', ')}`);
        }
      } finally { await requests.dispose(); }
    }
  }, { timeout: 30_000 }],
});

const sidebar = (page: Page) => page.locator('aside.sidebar');
const workspaceNav = (page: Page) => sidebar(page).getByRole('navigation', { name: '워크스페이스', exact: true });
const projectNav = (page: Page, project: Project) => sidebar(page).getByRole('navigation', { name: `${project.name} 메뉴`, exact: true });
const tabs = (page: Page, group: string) => page.getByRole('navigation', { name: `${group} 화면`, exact: true });
const hash = (page: Page) => page.evaluate(() => location.hash);

async function expectCurrent(scope: Locator, name: string | RegExp) {
  await expect(scope.getByRole('button', { name, exact: typeof name === 'string' })).toHaveAttribute('aria-current', 'page');
  await expect(scope.locator('[aria-current="page"]')).toHaveCount(1);
}

test('사이드바는 묶음 메뉴만 보여주고 묶음 탭이 주소와 현재 위치를 바꾼다', async ({ page, navigationGroups }) => {
  const { project, issue } = navigationGroups;
  await page.goto(`/#/${project.id}/overview`);
  await expect(sidebar(page)).toBeVisible();

  const workspace = workspaceNav(page);
  for (const name of ['팀 개요', '즐겨찾기']) await expect(workspace.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /^내 업무 \d+$/u })).toBeVisible();
  await expect(workspace.getByRole('button')).toHaveCount(3);
  const projectMenu = projectNav(page, project);
  for (const name of ['개요', '사이클', '업무 접수', '문서', '더보기']) await expect(projectMenu.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(projectMenu.getByRole('button', { name: /^업무 \d+$/u })).toBeVisible();
  await expectCurrent(projectMenu, '개요');
  await expect(projectMenu.getByRole('button', { name: '보고서', exact: true })).toHaveCount(0);
  for (const name of ['휴지통', '워크스페이스 설정']) await expect(sidebar(page).getByRole('button', { name, exact: true })).toBeVisible();
  for (const removed of ['전체 프로젝트 보드', '전체 프로젝트 간트', '팀 결정 후속 업무', '간트 · 일정', '백로그 · 사이클', '검토함 · 발행본']) {
    await expect(sidebar(page).getByRole('button', { name: removed, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('navigation', { name: /화면$/u })).toHaveCount(0);

  await projectMenu.getByRole('button', { name: /^업무 \d+$/u }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/issues`);
  const work = tabs(page, '업무');
  await expectCurrent(work, '목록 · 보드');
  await expectCurrent(projectMenu, /^업무 \d+$/u);
  await expect(page.locator('.main-content').getByText(issue.title).first()).toBeVisible();
  await expect(page.locator('.breadcrumbs')).toHaveText(new RegExp(`워크스페이스.*${project.name}.*업무.*목록 · 보드`, 'u'));

  await work.getByRole('button', { name: '간트', exact: true }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/gantt`);
  await expectCurrent(work, '간트');
  await expectCurrent(projectMenu, /^업무 \d+$/u);
  await expect(work.getByRole('button', { name: '간트', exact: true })).toHaveAttribute('data-gantt-focus-control', '');

  await projectMenu.getByRole('button', { name: '사이클', exact: true }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/backlog`);
  const cycle = tabs(page, '사이클');
  await expectCurrent(cycle, '백로그 · 사이클 보드');
  await cycle.getByRole('button', { name: '사이클 · 모듈 · 릴리스', exact: true }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/planning`);
  await expectCurrent(cycle, '사이클 · 모듈 · 릴리스');
  // A group entry re-opens the page of its group that is already open.
  await projectMenu.getByRole('button', { name: '사이클', exact: true }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/planning`);

  await projectMenu.getByRole('button', { name: '문서', exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/${project.id}/documents`));
  const docs = tabs(page, '문서');
  await expectCurrent(docs, '문서');
  await docs.getByRole('button', { name: '검토함 · 발행본', exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/${project.id}/publication`));
  await expectCurrent(docs, '검토함 · 발행본');

  await workspace.getByRole('button', { name: '팀 개요', exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/${project.id}/teamoverview`));
  const team = tabs(page, '팀 개요');
  await expectCurrent(team, '개요');
  await expectCurrent(workspace, '팀 개요');
  await team.getByRole('button', { name: '전체 프로젝트 보드', exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/${project.id}/teamboard`));
  await expectCurrent(team, '전체 프로젝트 보드');
  await team.getByRole('button', { name: '전체 프로젝트 간트', exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/${project.id}/gantt\\?scope=team`));
  await expectCurrent(team, '전체 프로젝트 간트');
  await expectCurrent(workspace, '팀 개요');
  await team.getByRole('button', { name: '팀 결정 후속 업무', exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/${project.id}/reports/decision-follow-ups`));
  await expectCurrent(team, '팀 결정 후속 업무');
  await expect(projectMenu.getByRole('button', { name: '더보기', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.breadcrumbs')).toHaveText(/워크스페이스.*팀 개요.*팀 결정 후속 업무/u);
});

test('이전 주소는 해당 화면과 탭을 열고 더보기는 보고서에서 자동으로 펼친다', async ({ page, navigationGroups }) => {
  const { project } = navigationGroups;
  const projectMenu = projectNav(page, project);
  await page.goto(`/#/${project.id}/backlog`);
  await expectCurrent(tabs(page, '사이클'), '백로그 · 사이클 보드');
  await expectCurrent(projectMenu, '사이클');

  await page.goto(`/#/${project.id}/publication`);
  await expectCurrent(tabs(page, '문서'), '검토함 · 발행본');
  await expectCurrent(projectMenu, '문서');

  await page.goto(`/#/${project.id}/gantt?scope=team`);
  await expectCurrent(tabs(page, '팀 개요'), '전체 프로젝트 간트');
  await expectCurrent(workspaceNav(page), '팀 개요');
  await expect(page.getByRole('region', { name: '간트 차트' })).toBeVisible();

  await page.goto(`/#/${project.id}/overview`);
  const more = projectMenu.getByRole('button', { name: '더보기', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.goto(`/#/${project.id}/reports`);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expectCurrent(projectMenu, '보고서');
  await expect(projectMenu.getByRole('button', { name: '개발 · GitLab', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: /화면$/u })).toHaveCount(0);

  await projectMenu.getByRole('button', { name: '개요', exact: true }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/overview`);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(projectMenu.getByRole('button', { name: '보고서', exact: true })).toHaveCount(0);
  await more.click();
  await projectMenu.getByRole('button', { name: '개발 · GitLab', exact: true }).click();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/${project.id}/development`));
  await expectCurrent(projectMenu, '개발 · GitLab');
});

test('설정 섹션은 주소로 열리고 숨긴 섹션의 미저장 입력을 유지한다', async ({ page, navigationGroups }) => {
  const { project, prefix } = navigationGroups;
  const dialogs: string[] = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.goto(`/#/${project.id}/settings?section=migration`);
  const sections = page.getByRole('navigation', { name: '설정 섹션', exact: true });
  await expectCurrent(sections, '이관');
  await expect(page.getByRole('heading', { name: '이관', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '기존 도구 원본 분석' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '팀원', exact: true })).toBeHidden();
  await expect(page.getByRole('region', { name: '프로젝트 워크플로 설정' })).toBeHidden();
  await expect(page.locator('[data-settings-section="data"]')).toBeHidden();

  await page.goto(`/#/${project.id}/settings?section=unknown-section`);
  await expectCurrent(sections, '일반');
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/settings`);
  await expect(page.getByRole('heading', { name: '팀원', exact: true })).toBeVisible();

  await sections.getByRole('button', { name: '업무 구성', exact: true }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/settings?section=work`);
  await expect(page.locator('.breadcrumbs')).toHaveText(/워크스페이스.*설정.*업무 구성/u);
  await expect(page.locator('.breadcrumbs')).not.toContainText(project.name);
  const workflow = page.getByRole('region', { name: '프로젝트 워크플로 설정' });
  const stateName = workflow.getByLabel('상태 1 이름', { exact: true });
  await expect(stateName).toBeEnabled();
  const draft = `${prefix} 미저장 상태`.slice(0, 40);
  await stateName.fill(draft);
  const memberName = page.getByLabel('새 팀원 이름', { exact: true });

  await sections.getByRole('button', { name: '일반', exact: true }).click();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/settings`);
  await expect(workflow).toBeHidden();
  await memberName.fill(`${prefix} 미저장 팀원`);
  await sections.getByRole('button', { name: '업무 구성', exact: true }).click();
  await expect(stateName).toHaveValue(draft);
  await expect(workflow.getByRole('button', { name: '워크플로 저장', exact: true })).toBeEnabled();

  await page.goBack();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/settings`);
  await expectCurrent(sections, '일반');
  await expect(memberName).toHaveValue(`${prefix} 미저장 팀원`);
  await page.goForward();
  await expectCurrent(sections, '업무 구성');
  await expect(stateName).toHaveValue(draft);

  // A modal in the visible section blocks section changes from history, so it never ends up hidden while modal.
  await sections.getByRole('button', { name: '일반', exact: true }).click();
  await page.getByRole('button', { name: '이메일 변경' }).first().click();
  const emailDialog = page.locator('dialog[open]');
  await expect(emailDialog).toBeVisible();
  await page.goBack();
  await expect.poll(() => hash(page)).toBe(`#/${project.id}/settings`);
  await expect(emailDialog).toBeVisible();
  await expect(page.locator('[data-settings-section="general"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(emailDialog).toBeHidden();
  await sections.getByRole('button', { name: '업무 구성', exact: true }).click();
  await expect(stateName).toHaveValue(draft);
  expect(dialogs).toEqual([]);
});

test('설정 섹션 전환은 진행 중인 요청을 기다리고 결과 창이 열린 섹션을 숨기지 않는다', async ({ page, navigationGroups }) => {
  const { project, prefix, requests } = navigationGroups;
  const [owner] = (await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot).users;
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), owner.id);
  let created: ApiKeyCreated | null = null;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/api-keys', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  try {
    await page.goto(`/#/${project.id}/settings?section=integrations`);
    const sections = page.getByRole('navigation', { name: '설정 섹션', exact: true });
    const general = sections.getByRole('button', { name: '일반', exact: true });
    await page.getByLabel('API 키 이름', { exact: true }).fill(`${prefix} 키`.slice(0, 60));
    const issued = page.waitForResponse(response => response.url().endsWith('/api/api-keys') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'API 키 발급', exact: true }).click();
    await general.click();
    await expect(page.getByText('API 키 발급이 끝난 후 이동해주세요.')).toBeVisible();
    await expect.poll(() => hash(page)).toBe(`#/${project.id}/settings?section=integrations`);
    await expectCurrent(sections, 'API 키');

    release();
    created = await (await issued).json() as ApiKeyCreated;
    const secret = page.getByRole('dialog', { name: 'API 키를 복사해주세요', exact: true });
    await expect(secret.getByLabel('발급한 API 키', { exact: true })).toHaveValue(created.token);
    // The one-time key covers the page; even a forced section change keeps its section visible.
    await general.dispatchEvent('click');
    await expect(secret).toBeVisible();
    await expectCurrent(sections, 'API 키');
    page.once('dialog', dialog => void dialog.accept());
    await secret.getByRole('button', { name: '확인하고 닫기', exact: true }).click();
    await expect(secret).toHaveCount(0);
    await general.click();
    await expect.poll(() => hash(page)).toBe(`#/${project.id}/settings`);
  } finally {
    release();
    if (created) {
      const keys = await (await requests.get('/api/api-keys', { headers: { 'X-Actor-Id': owner.id } })).json() as ApiKeyRecord[];
      const key = keys.find(value => value.id === created!.key.id);
      if (key && !key.revokedAt) {
        const revoked = await requests.post(`/api/api-keys/${key.id}/revoke`, { headers: { 'X-Actor-Id': owner.id }, data: { expectedVersion: key.version } });
        expect(revoked.status()).toBe(200);
      }
    }
  }
});

test('360px 화면은 가로 스크롤 없이 탭 줄과 설정 섹션을 보여준다', async ({ page, navigationGroups }) => {
  const { project } = navigationGroups;
  await page.setViewportSize({ width: 360, height: 780 });
  const pageOverflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const route of ['issues', 'gantt?scope=team', 'planning', 'publication', 'settings?section=data']) {
    await page.goto(`/#/${project.id}/${route}`);
    await expect(page.locator('.workspace-content')).toBeVisible();
    if (route.startsWith('settings')) {
      await expectCurrent(page.getByRole('navigation', { name: '설정 섹션', exact: true }), '데이터');
      await expect(page.getByRole('heading', { name: '데이터 내보내기 · 가져오기' })).toBeVisible();
    } else {
      await expect(page.getByRole('navigation', { name: /화면$/u })).toBeVisible();
      // Lazy pages render inside Suspense: measure the loaded page, not its fallback.
      await expect(page.locator('.workspace-content h1').first()).toBeVisible();
    }
    await expect.poll(pageOverflow).toBeLessThanOrEqual(0);
  }
  const team = tabs(page, '팀 개요');
  await page.goto(`/#/${project.id}/teamboard`);
  await expect(team).toBeVisible();
  await expect.poll(() => team.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(pageOverflow).toBeLessThanOrEqual(0);

  await expect(sidebar(page)).not.toHaveClass(/is-open/u);
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await expect(sidebar(page)).toHaveClass(/is-open/u);
  await projectNav(page, project).getByRole('button', { name: '사이클', exact: true }).click();
  await expect(sidebar(page)).not.toHaveClass(/is-open/u);
  await expectCurrent(tabs(page, '사이클'), '백로그 · 사이클 보드');
});
