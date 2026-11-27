import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { createApp } from '../../server/app.js';
import type { IssueTemplate, RecurringIssueRule, RecurringIssueRun, WorkspaceSnapshot } from '../../shared/types';

const firstOccurrence = '2026-01-04T15:00:00.000Z';

type RecurringFixture = { request: APIRequestContext; origin: string; advance: () => void };

const test = base.extend<{ recurring: RecurringFixture }>({
  recurring: async ({ playwright }, provide) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'donefac-recurring-browser-api-'));
    let instant = '2026-01-04T14:59:59.999Z';
    const app = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false,
      recurringIssueIntervalMs: 25, recurringIssueClock: () => new Date(instant) });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('격리 API 주소를 확인하지 못했습니다.');
    const origin = `http://127.0.0.1:${address.port}`;
    const request = await playwright.request.newContext({ baseURL: origin });
    try {
      await provide({ request, origin, advance() { instant = firstOccurrence; } });
    } finally {
      try {
        await request.dispose();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      } finally { app.close(); rmSync(dataDir, { recursive: true, force: true }); }
    }
  },
});

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, expected: number | number[] = 200): Promise<T> {
  const allowed = Array.isArray(expected) ? expected : [expected];
  expect(allowed, await response.text()).toContain(response.status());
  return response.json();
}

function matchWrite(page: Page, path: string, method: 'POST' | 'PATCH') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function setup(request: APIRequestContext) {
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { users: [actor, assignee], projects: [project] } = await workspace();
  const prefix = `합성 주간 업무 ${randomUUID().slice(0, 8)}`;
  const rulePath = `/api/projects/${encodeURIComponent(project.id)}/recurring-issues`;
  const templatePath = `/api/projects/${encodeURIComponent(project.id)}/issue-templates`;
  const list = async () => json<RecurringIssueRule[]>(await request.get(`${rulePath}?includeArchived=1`));
  return {
    actor, assignee, project, prefix, rulePath, list,
    template: async (suffix: string) => json<IssueTemplate>(await request.post(templatePath, { data: {
      name: `${prefix} ${suffix} 템플릿`, defaults: { title: `${prefix} ${suffix} 티켓`, description: '', descriptionFormat: 'plain',
        type: '작업', priority: 'medium', labels: [], customFields: {} },
    } }), 201),
  };
}

test('360px에서 주간 반복 업무의 저장 결과를 다시 확인하고 일정과 생성된 티켓을 연다', async ({ page, recurring }) => {
  test.setTimeout(65_000);
  const { request } = recurring;
  const f = await setup(request);
  const name = `${f.prefix} 반복 예약`;
  const runName = `${f.prefix} 생성 결과`;
  const template = await f.template('설정');
  const runnable = await f.template('생성');
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), f.actor.id);
  const submissions: unknown[] = [];
  await page.route('**/api/**', async route => {
    const source = new URL(route.request().url());
    const response = await route.fetch({ url: `${recurring.origin}${source.pathname}${source.search}` });
    if (source.pathname === f.rulePath && route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) {
        expect(response.status(), await response.text()).toBe(201);
        await route.abort('failed');
        return;
      }
    }
    await route.fulfill({ response });
  });
  await page.goto(`/#/${f.project.id}/settings?section=work`);
  const area = page.getByRole('region', { name: '반복 업무', exact: true });
  await expect(area).toBeVisible({ timeout: 25_000 });
  await area.getByRole('button', { name: '반복 업무 추가', exact: true }).click();
  await area.getByLabel('반복 업무 이름', { exact: true }).fill(name);
  await area.getByRole('combobox', { name: '업무 템플릿', exact: true }).selectOption(template.id);
  await area.getByRole('combobox', { name: '요일', exact: true }).selectOption('3');
  await area.getByLabel('시간', { exact: true }).fill('08:35');
  await area.getByRole('combobox', { name: '담당자', exact: true }).selectOption(f.assignee.id);
  await area.getByRole('button', { name: '반복 업무 저장', exact: true }).click();
  const confirmSave = area.getByRole('button', { name: '저장 결과 확인', exact: true });
  await expect(confirmSave).toBeEnabled();
  await expect(area.getByLabel('반복 업무 이름', { exact: true })).toHaveValue(name);
  const replay = matchWrite(page, f.rulePath, 'POST');
  await confirmSave.click();
  const rule = await json<RecurringIssueRule>(await replay, [200, 201]);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect((await f.list()).filter(item => item.name === name)).toHaveLength(1);
  expect(rule).toMatchObject({ name, templateId: template.id, weekday: 3, time: '08:35', assigneeId: f.assignee.id, enabled: true });
  expect(rule.nextRunAt).toBeTruthy();

  const row = area.getByRole('listitem', { name, exact: true });
  const path = `${f.rulePath}/${rule.id}`;
  await expect(row).toBeVisible();
  const pause = matchWrite(page, path, 'PATCH');
  await row.getByRole('button', { name: '일시 중지', exact: true }).click();
  const paused = await json<RecurringIssueRule>(await pause);
  expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
  const resume = matchWrite(page, path, 'PATCH');
  await row.getByRole('button', { name: '다시 시작', exact: true }).click();
  const resumed = await json<RecurringIssueRule>(await resume);
  expect(resumed).toMatchObject({ enabled: true, id: rule.id, version: paused.version + 1 });
  expect(resumed.nextRunAt).toBeTruthy();

  const second = await json<RecurringIssueRule>(await request.post(f.rulePath, { data: {
    name: runName, templateId: runnable.id, weekday: 1, time: '00:00', assigneeId: f.assignee.id,
    enabled: true, requestId: randomUUID(),
  } }), 201);
  expect(second.nextRunAt).toBe(firstOccurrence);
  const latestRun = async (): Promise<RecurringIssueRun | undefined> => (await f.list()).find(item => item.id === second.id)?.recentRuns[0];
  expect(await latestRun()).toBeUndefined();
  recurring.advance();
  await expect.poll(async () => (await latestRun())?.outcome).toBe('created');
  const run = await latestRun();
  if (run?.outcome !== 'created') throw new Error('The recurring issue did not run.');
  expect(run.scheduledAt).toBe(firstOccurrence);
  await area.getByRole('button', { name: '반복 업무 새로고침', exact: true }).click();
  const executed = area.getByRole('listitem', { name: runName, exact: true });
  await executed.getByRole('button', { name: run.issueKey, exact: true }).click();
  const issue = page.getByRole('dialog', { name: runnable.defaults.title, exact: true });
  await expect(issue).toBeVisible();
  await expect(issue.getByText(run.issueKey, { exact: true })).toBeVisible();
});
