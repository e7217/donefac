import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, request as apiRequest, type APIResponse, type BrowserContext } from '@playwright/test';
import type { AutomationRule, AutomationRun, GitlabLink, GitlabSettings, GitlabWebhookStatus, Issue, WorkspaceSnapshot } from '../../shared/types';
import { verifyNativeGitlabRead } from './native-gitlab-read';

const integration = '/api/integrations/gitlab';
const repositoryId = 42;
const branch = 'main';

async function json<T>(response: APIResponse, message: string, status = 200): Promise<T> {
  expect(response.status(), message).toBe(status);
  return await response.json() as T;
}

export async function prepareGitlabTraffic(context: BrowserContext, { origin, projectId, actorId, issueId, jiraIssueKey, jiraInstanceKey }: {
  origin: string;
  projectId: string;
  actorId: string;
  issueId: string;
  jiraIssueKey?: string;
  jiraInstanceKey?: string;
}) {
  if (Boolean(jiraIssueKey) !== Boolean(jiraInstanceKey)) throw new Error('The pilot needs both Jira routing fields or neither.');
  const requests = context.request;
  const headers = { Origin: origin, 'X-Actor-Id': actorId };
  const readWorkspace = async () => json<WorkspaceSnapshot>(await requests.get('/api/workspace'), 'Read the issue and workflow for GitLab');
  const findIssue = (snapshot: WorkspaceSnapshot): Issue => {
    const issue = snapshot.issues.find(item => item.id === issueId);
    if (!issue) throw new Error('The issue for the GitLab pilot is missing.');
    return issue;
  };
  const readIssue = async () => findIssue(await readWorkspace());
  const workspace = await readWorkspace();
  const issue = findIssue(workspace);
  const workflow = workspace.workflows?.find(item => item.projectId === projectId);
  const review = workflow?.statuses.find(item => item.category === 'review');
  if (!review) throw new Error('The project needs a review status for the GitLab pilot.');
  expect(issue.projectId).toBe(projectId);
  expect(workflow?.statuses.find(item => item.id === issue.status)?.category).toBe('in_progress');
  const lookupKey = jiraIssueKey ?? issue.key;
  if (jiraIssueKey) expect(issue.key).not.toBe(jiraIssueKey);
  const signingKey = randomBytes(32);
  const signingToken = `whsec_${signingKey.toString('base64')}`;
  const nativeRead = jiraIssueKey ? undefined : await verifyNativeGitlabRead(context, origin, issue, repositoryId, signingToken);
  const baseUrl = nativeRead?.settings.baseUrl ?? 'https://gitlab.example.test';
  const repositoryUrl = nativeRead?.repositoryUrl ?? `${baseUrl}/team/pilot`;
  const jiraRoutes = jiraInstanceKey ? [{ repositoryId, projectId, jiraInstanceKey }] : [];
  let signed = nativeRead?.settings;
  if (!signed) {
    const settings = await json<GitlabSettings>(await requests.get(integration), 'Read current GitLab settings');
    const configured = await requests.patch(integration, { headers, data: {
      expectedVersion: settings.version, baseUrl, projectIds: [repositoryId], signingToken, jiraRoutes,
    } }).catch(() => { throw new Error('Could not configure signing for the isolated GitLab pilot.'); });
    signed = await json<GitlabSettings>(configured, 'Configure GitLab signing');
  }
  expect(signed.signingTokenConfigured).toBe(true);
  expect(signed.projectIds).toEqual([repositoryId]);
  expect(signed.jiraRoutes ?? []).toEqual(jiraRoutes);
  const settingsEvidence = { baseUrl: signed.baseUrl, jiraRoutes: signed.jiraRoutes };
  const rule = await json<AutomationRule>(await requests.post('/api/automation-rules', { headers, data: {
    projectId, name: '합성 파이프라인 성공 시 검토', trigger: 'pipeline.succeeded', enabled: true,
    gitlabProjectIds: [repositoryId], branchPattern: branch, issueTypes: [], fromStatuses: [issue.status], toStatusId: review.id, actorId,
  } }), 'Enable the repository-scoped GitLab automation rule', 201);
  expect(rule.enabled).toBe(true);

  const links = async () => json<{ total: number; links: GitlabLink[] }>(
    await requests.get(`/api/issues/${issue.id}/gitlab-links?kind=pipeline`), 'Read the issue pipeline links');
  const runs = async () => json<AutomationRun[]>(await requests.get(`/api/automation-runs?projectId=${projectId}`), 'Read project automation runs');
  const status = async () => json<GitlabWebhookStatus>(await requests.get(`${integration}/webhook-status`), 'Read authenticated webhook status');
  function verifyTicketKey(link: GitlabLink) {
    if (jiraIssueKey) expect(link.originalJiraKey).toBe(jiraIssueKey);
    else expect(link).not.toHaveProperty('originalJiraKey');
  }

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
      const initial = pipeline(701, 'running', lookupKey, sha);
      expect(await initial.send()).toEqual({ ok: true, duplicate: false, linked: 1, runs: [] });
      const running = await links();
      expect(running.total).toBe(1);
      expect(running.links).toMatchObject([{ issueId: issue.id, projectId: repositoryId, iid: 701,
        state: 'running', webUrl: pipelineUrl(701), sourceBranch: branch, sourceSha: sha,
        updatedAt: initial.occurredAt, pipelineObservedAt: initial.occurredAt }]);
      verifyTicketKey(running.links[0]);

      const sparse = pipeline(701, 'success', null, sha);
      expect(await sparse.send()).toEqual({ ok: true, duplicate: false, linked: 1, runs: [] });
      const updated = await links();
      expect(updated).toEqual({ ...running, links: [{ ...running.links[0], state: 'success',
        updatedAt: sparse.occurredAt, pipelineObservedAt: sparse.occurredAt }] });
      expect(await readIssue()).toEqual(issue);
      expect(await runs()).toEqual([]);
      const [sparseReceipt] = (await status()).repositories;
      expect(sparseReceipt.lastAcceptedByEvent?.pipeline).toMatchObject({ authentication: 'signing-token', duplicate: false, linked: 1, automationRuns: 0 });

      const keyed = pipeline(702, 'success', lookupKey, 'b'.repeat(40));
      const applied = await keyed.send();
      expect(applied).toMatchObject({ ok: true, duplicate: false, linked: 1 });
      expect(applied.runs).toMatchObject([{ actorId, ruleId: rule.id, issueId: issue.id, fromStatus: issue.status,
        toStatus: rule.toStatusId, outcome: 'changed', occurredAt: keyed.occurredAt,
        context: { trigger: rule.trigger, gitlabProjectId: repositoryId, objectKind: 'pipeline', objectId: '702', branch } }]);
      expect(await keyed.send()).toEqual({ ok: true, duplicate: true, linked: 0, runs: [] });
      expect(await runs()).toEqual(applied.runs);
      const issueAfter = await readIssue();
      expect(issueAfter).toMatchObject({ id: issue.id, status: rule.toStatusId, version: issue.version + 1 });
      const finalLinks = await links();
      expect(finalLinks.total).toBe(2);
      expect(finalLinks.links).toEqual([
        expect.objectContaining({ issueId: issue.id, projectId: repositoryId, iid: 702, state: 'success', webUrl: pipelineUrl(702),
          sourceBranch: branch, sourceSha: 'b'.repeat(40) }),
        updated.links[0],
      ]);
      for (const link of finalLinks.links) verifyTicketKey(link);
      const webhookStatus = await status();
      expect(webhookStatus.repositories).toMatchObject([{ repositoryId,
        lastDelivery: { event: 'pipeline', authentication: 'signing-token', duplicate: true, linked: 0, automationRuns: 0 },
        lastAcceptedByEvent: { pipeline: { event: 'pipeline', authentication: 'signing-token', duplicate: false, linked: 1, automationRuns: 1 } },
      }]);

      const page = await context.newPage();
      try {
        if (!jiraIssueKey) await page.setViewportSize({ width: 360, height: 820 });
        await page.goto(`/#/${projectId}/issues?issue=${issue.id}`, { waitUntil: 'domcontentloaded' });
        const detail = page.getByRole('dialog', { name: issue.title, exact: true });
        const pipelines = detail.getByRole('region', { name: '파이프라인', exact: true });
        await expect(pipelines.locator('[data-gitlab-kind="pipeline"][data-gitlab-state="success"]')).toHaveCount(2, { timeout: 25_000 });
        if (jiraIssueKey) await expect(pipelines.getByText(jiraIssueKey, { exact: true })).toHaveCount(2);
        for (const id of [701, 702]) await expect(pipelines.locator(`a[href="${pipelineUrl(id)}"]`)).toBeVisible();
        if (nativeRead) await expect(detail.locator(`a[href="${nativeRead.link.webUrl}"]`)).toBeVisible();
      } finally {
        await page.close();
      }
      return { issue: issueAfter, links: finalLinks, rule, runs: applied.runs, webhookStatus, settings: settingsEvidence,
        ...(nativeRead && { read: { link: nativeRead.link, status: nativeRead.status, webhookReceipt: nativeRead.webhookReceipt } }) };
    } finally {
      await sender.dispose();
    }
  };
}
