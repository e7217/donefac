import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, request as apiRequest, type APIResponse, type BrowserContext } from '@playwright/test';
import type { AutomationRule, AutomationRun, GitlabLink, GitlabSettings, GitlabWebhookStatus, Issue, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const baseUrl = 'https://gitlab.example.test';
const repositoryId = 42;
const repositoryUrl = `${baseUrl}/team/pilot`;
const branch = 'main';

async function json<T>(response: APIResponse, message: string, status = 200): Promise<T> {
  expect(response.status(), message).toBe(status);
  return await response.json() as T;
}

export async function prepareGitlabTraffic(context: BrowserContext, { origin, projectId, actorId }: {
  origin: string;
  projectId: string;
  actorId: string;
}) {
  const requests = context.request;
  const headers = { Origin: origin, 'X-Actor-Id': actorId };
  const issue = await json<Issue>(await requests.post('/api/issues', { headers, data: {
    projectId, title: '공동 편집 중 서명된 파이프라인으로 검토할 업무',
  } }), 'Create the issue for concurrent GitLab activity', 201);
  const settings = await json<GitlabSettings>(await requests.get(integration), 'Read current GitLab settings');
  const signingKey = randomBytes(32);
  const configured = await requests.patch(integration, { headers, data: {
    expectedVersion: settings.version, baseUrl, projectIds: [repositoryId], signingToken: `whsec_${signingKey.toString('base64')}`,
  } }).catch(() => { throw new Error('Could not configure signing for the isolated GitLab pilot.'); });
  const signed = await json<GitlabSettings>(configured, 'Configure GitLab signing');
  expect(signed.signingTokenConfigured).toBe(true);
  const rule = await json<AutomationRule>(await requests.post('/api/automation-rules', { headers, data: {
    projectId, name: '합성 파이프라인 성공 시 검토', trigger: 'pipeline.succeeded', enabled: true,
    gitlabProjectIds: [repositoryId], branchPattern: branch, issueTypes: [], fromStatuses: [issue.status], toStatusId: 'review', actorId,
  } }), 'Enable the repository-scoped GitLab automation rule', 201);
  expect(rule.enabled).toBe(true);

  const links = async () => json<{ total: number; links: GitlabLink[] }>(
    await requests.get(`/api/issues/${issue.id}/gitlab-links?kind=pipeline`), 'Read the issue pipeline links');
  const runs = async () => json<AutomationRun[]>(await requests.get(`/api/automation-runs?projectId=${projectId}`), 'Read project automation runs');
  const readIssue = async () => {
    const snapshot = await json<WorkspaceSnapshot>(await requests.get('/api/workspace'), 'Read the GitLab-linked issue');
    return snapshot.issues.find(item => item.id === issue.id);
  };
  const status = async () => json<GitlabWebhookStatus>(await requests.get(`${integration}/webhook-status`), 'Read authenticated webhook status');

  return async function verifyGitlabTraffic() {
    // GitLab has its own HTTPS client and sends the original signed bytes without a pilot session cookie.
    const sender = await apiRequest.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    const pipelineUrl = (id: number) => `${repositoryUrl}/-/pipelines/${id}`;
    function pipeline(id: number, state: 'running' | 'success', key: string | null, sha: string) {
      const occurredAt = new Date().toISOString();
      const payload = {
        object_kind: 'pipeline', project: { id: repositoryId, ...(key ? { web_url: repositoryUrl } : {}) },
        object_attributes: { id, ref: branch, sha, status: state, updated_at: occurredAt },
        ...(key ? { commit: { id: sha, message: `${key} 합성 커밋` } } : {}),
      };
      const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
      const deliveryId = randomUUID();
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const signature = createHmac('sha256', signingKey).update(`${deliveryId}.${timestamp}.`).update(bytes).digest('base64');
      const signedHeaders = { 'Content-Type': 'application/json', 'X-Gitlab-Event': 'Pipeline Hook',
        'webhook-id': deliveryId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
      return {
        occurredAt,
        async send() {
          const response = await sender.post(`${integration}/webhook`, {
            headers: signedHeaders, data: bytes, maxRedirects: 0,
          }).catch(() => { throw new Error('Could not send the signed pilot GitLab delivery.'); });
          return json<{ ok: boolean; duplicate: boolean; linked: number; runs: AutomationRun[] }>(response, 'Accept a signed GitLab delivery');
        },
      };
    }

    try {
      const sha = 'a'.repeat(40);
      const initial = pipeline(701, 'running', issue.key, sha);
      expect(await initial.send()).toEqual({ ok: true, duplicate: false, linked: 1, runs: [] });
      const running = await links();
      expect(running.total).toBe(1);
      expect(running.links).toMatchObject([{ issueId: issue.id, projectId: repositoryId, iid: 701,
        state: 'running', webUrl: pipelineUrl(701), sourceBranch: branch, sourceSha: sha, updatedAt: initial.occurredAt }]);

      const sparse = pipeline(701, 'success', null, sha);
      expect(await sparse.send()).toEqual({ ok: true, duplicate: false, linked: 1, runs: [] });
      const updated = await links();
      expect(updated).toEqual({ ...running, links: [{ ...running.links[0], state: 'success', updatedAt: sparse.occurredAt }] });
      expect(await readIssue()).toEqual(issue);
      expect(await runs()).toEqual([]);
      const [sparseReceipt] = (await status()).repositories;
      expect(sparseReceipt.lastAcceptedByEvent?.pipeline).toMatchObject({ authentication: 'signing-token', duplicate: false, linked: 1, automationRuns: 0 });

      const keyed = pipeline(702, 'success', issue.key, 'b'.repeat(40));
      const applied = await keyed.send();
      expect(applied).toMatchObject({ ok: true, duplicate: false, linked: 1 });
      expect(applied.runs).toMatchObject([{ actorId, ruleId: rule.id, issueId: issue.id, fromStatus: issue.status,
        toStatus: rule.toStatusId, outcome: 'changed', occurredAt: keyed.occurredAt,
        context: { trigger: rule.trigger, gitlabProjectId: repositoryId, objectKind: 'pipeline', objectId: '702', branch } }]);
      expect(await keyed.send()).toEqual({ ok: true, duplicate: true, linked: 0, runs: [] });
      expect(await runs()).toEqual(applied.runs);
      const issueAfter = await readIssue();
      if (!issueAfter) throw new Error('The linked issue disappeared during the GitLab pilot.');
      expect(issueAfter).toMatchObject({ id: issue.id, status: rule.toStatusId, version: issue.version + 1 });
      const finalLinks = await links();
      expect(finalLinks.total).toBe(2);
      expect(finalLinks.links).toEqual([expect.objectContaining({ issueId: issue.id, iid: 702, state: 'success', webUrl: pipelineUrl(702) }), updated.links[0]]);
      const webhookStatus = await status();
      expect(webhookStatus.repositories).toMatchObject([{ repositoryId,
        lastDelivery: { event: 'pipeline', authentication: 'signing-token', duplicate: true, linked: 0, automationRuns: 0 },
        lastAcceptedByEvent: { pipeline: { event: 'pipeline', authentication: 'signing-token', duplicate: false, linked: 1, automationRuns: 1 } },
      }]);

      const page = await context.newPage();
      try {
        await page.goto(`/#/${projectId}/issues?issue=${issue.id}`, { waitUntil: 'domcontentloaded' });
        const detail = page.getByRole('dialog', { name: issue.title, exact: true });
        const pipelines = detail.getByRole('region', { name: '파이프라인', exact: true });
        await expect(pipelines.locator('[data-gitlab-kind="pipeline"][data-gitlab-state="success"]')).toHaveCount(2, { timeout: 25_000 });
        for (const id of [701, 702]) await expect(pipelines.locator(`a[href="${pipelineUrl(id)}"]`)).toBeVisible();
      } finally {
        await page.close();
      }
      return { issue: issueAfter, links: finalLinks, rule, runs: applied.runs, webhookStatus };
    } finally {
      await sender.dispose();
    }
  };
}
