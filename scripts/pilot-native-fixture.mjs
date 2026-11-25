import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Build the native project using only the signed-in, same-origin browser API. */
export async function prepareNativeTeamPilot(pilot, actorIds) {
  const [ownerId, reporterId, keyOwnerId] = actorIds;
  const api = pilot.api;
  const owner = { 'X-Actor-Id': ownerId };
  const reporter = { 'X-Actor-Id': reporterId };
  const keyOwner = { 'X-Actor-Id': keyOwnerId };
  const empty = await api('/workspace');
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.issues, []);
  assert.deepEqual(empty.documents, []);
  const project = await api('/projects', { method: 'POST', status: 201, headers: owner,
    body: { requestId: randomUUID(), name: '합성 팀 신규 업무', key: 'PILOTNATIVE' } });
  const workflow = await api(`/projects/${project.id}/workflow`);
  const schema = await api(`/projects/${project.id}/issue-schema`);
  const nextStatus = workflow.statuses.find(status => status.category === 'in_progress')?.id;
  assert.ok(nextStatus && nextStatus !== workflow.initialStatusId);
  const restoreGeneration = (await api('/workspace')).restoreGeneration;
  const intakePath = `/projects/${project.id}/intake`;
  const submitted = await api(intakePath, { method: 'POST', status: 201, headers: reporter,
    body: { requestId: randomUUID(), restoreGeneration, title: '합성 현장 일정 요청', description: '팀에서 새로 접수하고 일정으로 넘길 업무입니다.' } });
  assert.equal(submitted.item.status, 'pending');
  assert.equal(submitted.item.reporterId, reporterId);
  assert.deepEqual((await api('/workspace')).issues, []);
  const decision = await api(`${intakePath}/${submitted.item.id}/decision`, { method: 'POST', headers: owner, body: {
    requestId: randomUUID(), restoreGeneration, expectedVersion: submitted.item.version, decision: 'accept',
    expectedWorkflowVersion: workflow.version, expectedIssueSchemaVersion: schema.version, issue: { assigneeId: ownerId },
  } });
  const intake = decision.item;
  assert.equal(intake.status, 'accepted');
  const issue = (await api('/workspace')).issues.find(value => value.id === intake.issueId);
  assert.ok(issue);
  assert.equal(issue.reporterId, reporterId);
  assert.equal(issue.assigneeId, ownerId);
  assert.equal(issue.status, workflow.initialStatusId);
  const gitlabIssue = await api('/issues', { method: 'POST', status: 201, headers: owner,
    body: { projectId: project.id, title: '합성 저장소 변경 검토', status: nextStatus, assigneeId: reporterId } });
  const document = await api('/documents', { method: 'POST', status: 201, headers: owner, body: {
    projectId: project.id, title: '합성 신규 팀 공동 작업 기록',
    content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '새 프로젝트에서 합의한 작업과 검토를 기록합니다.' }] },
      { type: 'issueReference', attrs: { issueId: issue.id, label: issue.key } },
    ] },
  } });
  const homePath = `/document-space-home?projectId=${encodeURIComponent(project.id)}`;
  const home = await api(homePath, { method: 'PATCH', headers: owner,
    body: { documentId: document.id, expectedVersion: 0, restoreGeneration } });
  assert.equal(home.documentId, document.id);
  const attachmentBytes = Buffer.from('합성 팀 작업 첨부\n시제품 검토 값\n');
  const attachment = await api(`/attachments?resourceType=issue&resourceId=${encodeURIComponent(issue.id)}&filename=pilot-native.txt`,
    { method: 'POST', status: 201, headers: { ...owner, 'Content-Type': 'application/octet-stream', 'X-File-Type': 'text/plain' }, body: attachmentBytes });

  const keyRequest = { requestId: randomUUID(), restoreGeneration, name: '합성 팀 읽기 API', access: 'read', projectIds: [project.id], expiresAt: null };
  const issued = await api('/api-keys', { method: 'POST', status: 201, headers: keyOwner, body: keyRequest });
  assert.ok(typeof issued.token === 'string' && issued.token.length > 0, 'New API keys must return a token once.');
  const replayed = await api('/api-keys', { method: 'POST', headers: keyOwner, body: keyRequest });
  assert.equal(replayed.duplicate, true);
  assert.ok(!Object.hasOwn(replayed, 'token'), 'API key retries must exclude the original token.');
  assert.deepEqual(replayed.key, issued.key);
  assert.deepEqual((await api('/api-keys', { headers: keyOwner })).map(key => key.id), [issued.key.id]);
  const authorization = { Authorization: `Bearer ${issued.token}` };
  const keyPath = `/v1/issues/${issue.id}`;
  assert.equal((await api(keyPath, { headers: authorization })).id, issue.id);
  await pilot.request(keyPath, { method: 'PATCH', status: 403, headers: authorization,
    body: { expectedVersion: issue.version, title: '읽기 키가 수정하면 안 되는 제목' } });
  const originalMember = empty.users.find(user => user.id === keyOwnerId);
  assert.ok(originalMember);
  const email = 'pilot-native-updated@example.invalid';
  const emailRequest = { email, expectedVersion: originalMember.version ?? 1, restoreGeneration, requestId: randomUUID() };
  const edited = await api(`/users/${keyOwnerId}`, { method: 'PATCH', headers: keyOwner, body: emailRequest });
  assert.equal(edited.user.id, keyOwnerId);
  assert.equal(edited.user.email, email);
  assert.equal(edited.appliedVersion, emailRequest.expectedVersion + 1);
  assert.equal(edited.duplicate, false);
  const emailReplay = await api(`/users/${keyOwnerId}`, { method: 'PATCH', headers: keyOwner, body: emailRequest });
  assert.deepEqual(emailReplay, { ...edited, duplicate: true });
  assert.equal((await api(keyPath, { headers: authorization })).id, issue.id);
  const revoked = await api(`/api-keys/${issued.key.id}/revoke`, { method: 'POST', headers: keyOwner,
    body: { expectedVersion: issued.key.version, restoreGeneration } });
  assert.ok(revoked.revokedAt);
  await pilot.request(keyPath, { headers: authorization, status: 401 });

  return { issue, document, gitlabIssue, nextStatus, intake, home, attachment: { id: attachment.id, hash: digest(attachmentBytes) },
    member: { id: keyOwnerId, email }, key: { id: issued.key.id, request: keyRequest, token: issued.token, revokedAt: revoked.revokedAt } };
}

/** Re-read exact native evidence in the same workspace, after restart, and after physical recovery. */
export async function verifyNativeTeamData(pilot, seed, knowledge) {
  const api = pilot.api;
  assert.ok(knowledge && knowledge.projectId === seed.issue.projectId && knowledge.issueId === seed.issue.id);
  assert.notEqual(knowledge.documentId, seed.document.id);
  const projectId = seed.issue.projectId;
  const documentPath = `/documents/${encodeURIComponent(knowledge.documentId)}`;
  const snapshotPath = revisionId => `${documentPath}/publication/snapshot?${new URLSearchParams({
    kind: 'published', revisionId,
  })}`;
  const [workspace, portable, storedIntake, notificationPage, home, file, publication, revision, latestRevision, keys] = await Promise.all([
    api('/workspace'), api('/export'), api(`/projects/${projectId}/intake/${seed.intake.id}`),
    api('/notifications', { headers: { 'X-Actor-Id': seed.intake.reporterId } }),
    api(`/document-space-home?projectId=${encodeURIComponent(projectId)}`),
    pilot.request(`/attachments/${seed.attachment.id}/content`),
    api(`${documentPath}/publication`), api(snapshotPath(knowledge.revisionId)), api(snapshotPath(knowledge.latest.revisionId)),
    api('/api-keys', { headers: { 'X-Actor-Id': seed.member.id } }),
  ]);
  assert.deepEqual(portable.sourceImports, []);
  assert.deepEqual(portable.sourceRecords, []);
  assert.deepEqual(storedIntake, seed.intake);
  const notices = notificationPage.items.filter(value => value.targetId === seed.intake.id);
  assert.equal(notices.length, 1);
  const [notice] = notices;
  assert.equal(notice.kind, 'intake-accepted');
  assert.equal(typeof notice.readAt, 'string');
  assert.deepEqual(home, seed.home);
  assert.equal(digest(Buffer.from(await file.arrayBuffer())), seed.attachment.hash);
  const link = workspace.resourceLinks.find(value => value.id === knowledge.linkId);
  assert.ok(link && link.issueId === seed.issue.id && link.documentId === knowledge.documentId && link.kind === '관련 문서');
  const draft = workspace.documents.find(document => document.id === knowledge.documentId);
  assert.equal(draft?.title, knowledge.draft.title);
  assert.ok(draft.plainText.includes(knowledge.draft.body) && !draft.plainText.includes(knowledge.publishedBody));
  assert.equal(publication.published.revisionId, knowledge.latest.revisionId);
  assert.equal(publication.published.publishedById, knowledge.reviewerId);
  assert.equal(latestRevision.id, knowledge.latest.revisionId);
  assert.equal(latestRevision.documentId, knowledge.documentId);
  assert.equal(latestRevision.title, knowledge.latest.title);
  assert.ok(latestRevision.plainText.includes(knowledge.latest.body) && !latestRevision.plainText.includes(knowledge.draft.body));
  assert.equal(revision.id, knowledge.revisionId);
  assert.equal(revision.documentId, knowledge.documentId);
  assert.equal(revision.title, knowledge.publishedTitle);
  assert.ok(revision.plainText.includes(knowledge.publishedBody) && !revision.plainText.includes(knowledge.latest.body));
  assert.ok(revision.content.content.some(node => node.type === 'heading' && node.attrs?.sectionId === knowledge.sectionId));
  const member = workspace.users.find(user => user.id === seed.member.id);
  assert.equal(member?.email, seed.member.email);
  const revoked = keys.find(value => value.id === seed.key.id);
  assert.equal(revoked?.revokedAt, seed.key.revokedAt);
  const replayed = await api('/api-keys', { method: 'POST', headers: { 'X-Actor-Id': seed.member.id }, body: seed.key.request });
  assert.equal(replayed.duplicate, true);
  assert.ok(!Object.hasOwn(replayed, 'token'), 'API key retries must exclude the original token after recovery.');
  assert.deepEqual(replayed.key, revoked);
  await pilot.request(`/v1/issues/${seed.issue.id}`, {
    headers: { Authorization: `Bearer ${seed.key.token}` }, status: 401,
  });

  return digest(JSON.stringify({ storedIntake, notice, home, attachment: seed.attachment, link, draft, publication, revision, latestRevision, member, revoked }));
}
