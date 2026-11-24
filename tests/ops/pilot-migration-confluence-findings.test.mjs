import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  confluenceFindingsProof, CONFLUENCE_FINDING_CODES, CONFLUENCE_FINDINGS_FORMAT, CONFLUENCE_FINDINGS_MAX_BYTES,
  CONFLUENCE_FINDINGS_VERSION, parseConfluenceFindings, validConfluenceFindingsProof,
} from '../../scripts/pilot-migration-confluence-findings.mjs';
import { startRehearsalPilot } from '../../scripts/pilot-migration-runtime.mjs';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const checkedAt = '2026-11-23T06:00:00.000Z';
const reportHash = 'a'.repeat(64);
const zipHash = 'b'.repeat(64);
const packageId = '00000000-0000-4000-8000-000000000002';
const pageId = '99999999999999999999';

function report(overrides = {}) {
  return {
    format: CONFLUENCE_FINDINGS_FORMAT, version: 1, checkedAt, selection: 'explicit-pages',
    status: 'needs-review', archive: { sha256: zipHash, bytes: 13 }, spacePermissions: 'manual-review', unidentifiedPages: 0,
    findings: [{ pageId, codes: ['VERSION_MISMATCH', 'LIVE_RESTRICTED'] }], ...overrides,
  };
}

const partialCoverage = Object.freeze({
  archivePages: 8, matchedPages: 3, permissionCheckedPages: 2, outsideSelectionPages: 1, otherSpacePages: 1, unassignedPages: 1,
});

function coveredReport(overrides = {}) {
  return report({ version: CONFLUENCE_FINDINGS_VERSION, coverage: partialCoverage, ...overrides });
}

test('projects a validated findings file into stable counts and no page details', () => {
  const findings = parseConfluenceFindings(report({ unidentifiedPages: 2, findings: [
    { pageId, codes: ['VERSION_MISMATCH', 'LIVE_RESTRICTED'] },
    { pageId: '2', codes: ['ARCHIVE_ONLY_PAGE', 'LIVE_RESTRICTED'] },
  ] }));
  const proof = confluenceFindingsProof(findings, reportHash, packageId);
  assert.deepEqual(proof, {
    packageId, sha256: reportHash, checkedAt, version: 1, selection: 'explicit-pages', status: 'needs-review',
    archive: { sha256: zipHash, bytes: 13 }, spacePermissions: 'manual-review', pageCount: 2, unidentifiedPages: 2,
    reasonCounts: { ARCHIVE_ONLY_PAGE: 1, LIVE_RESTRICTED: 2, VERSION_MISMATCH: 1 },
  });
  assert.deepEqual(Object.keys(proof.reasonCounts), ['ARCHIVE_ONLY_PAGE', 'LIVE_RESTRICTED', 'VERSION_MISMATCH']);
  assert.ok(!JSON.stringify(proof).includes(pageId));
  assert.ok(!Object.hasOwn(proof, 'findings'));
  assert.equal(validConfluenceFindingsProof(proof), true);
});

test('accepts empty matched and needs-review audits with manual space permission review', () => {
  for (const status of ['matched', 'needs-review']) {
    const proof = confluenceFindingsProof(parseConfluenceFindings(report({ status, findings: [] })), reportHash, packageId);
    assert.equal(proof.status, status);
    assert.equal(proof.spacePermissions, 'manual-review');
    assert.equal(proof.pageCount, 0);
    assert.deepEqual(proof.reasonCounts, {});
    assert.equal(validConfluenceFindingsProof(proof), true);
  }
  const unidentified = parseConfluenceFindings(report({ findings: [], unidentifiedPages: 1 }));
  assert.equal(validConfluenceFindingsProof(confluenceFindingsProof(unidentified, reportHash, packageId)), true);
});

test('records aggregate ZIP coverage in the v2 proof without private page or source information', () => {
  const findings = parseConfluenceFindings(coveredReport());
  const proof = confluenceFindingsProof(findings, reportHash, packageId);
  assert.equal(proof.version, 2);
  assert.deepEqual(proof.coverage, partialCoverage);
  assert.notEqual(proof.coverage, partialCoverage);
  assert.ok(!JSON.stringify(proof).includes(pageId));
  assert.equal(validConfluenceFindingsProof(proof), true);

  const coverage = { ...partialCoverage, archivePages: 5, permissionCheckedPages: 3, unassignedPages: 0 };
  const matched = parseConfluenceFindings(coveredReport({ status: 'matched', findings: [], coverage }));
  assert.equal(validConfluenceFindingsProof(confluenceFindingsProof(matched, reportHash, packageId)), true);
});

test('rejects missing or inconsistent coverage in sidecars and their proofs', () => {
  const proof = confluenceFindingsProof(parseConfluenceFindings(coveredReport()), reportHash, packageId);
  for (const changes of [
    { coverage: undefined }, { coverage: null }, { version: 1 }, { version: 3 }, { selection: 'visible-space' },
    { coverage: { ...partialCoverage, archivePages: 100_001 } },
    { coverage: { ...partialCoverage, archivePages: 1000, matchedPages: 501 } },
    { coverage: { ...partialCoverage, archivePages: 5 } },
    { coverage: { ...partialCoverage, outsideSelectionPages: -1 } },
    { coverage: { ...partialCoverage, otherSpacePages: 0.5 } },
    { coverage: { ...partialCoverage, permissionCheckedPages: 4 } },
    { coverage: { ...partialCoverage, pageId } },
  ]) {
    assert.throws(() => parseConfluenceFindings(coveredReport(changes)), /형식 또는 건수/u);
    assert.equal(validConfluenceFindingsProof({ ...proof, ...changes }), false);
  }
  assert.throws(() => parseConfluenceFindings(coveredReport({ status: 'matched', findings: [] })), /형식 또는 건수/u);
  assert.equal(validConfluenceFindingsProof({ ...proof, status: 'matched', pageCount: 0, reasonCounts: {} }), false);
});

test('rejects incompatible metadata, duplicate page or reason, and injected private fields', () => {
  const injected = 'private fixture page content';
  const goodRow = { pageId, codes: ['VERSION_MISMATCH'] };
  for (const invalid of [
    null, [], report({ version: 2 }), report({ checkedAt: '2026-02-30T00:00:00.000Z' }), report({ status: 'observed' }),
    report({ status: 'matched' }), report({ status: 'matched', findings: [], unidentifiedPages: 1 }),
    report({ archive: { sha256: zipHash, bytes: CONFLUENCE_FINDINGS_MAX_BYTES + 1 } }),
    report({ archive: { sha256: zipHash, bytes: 13, file: injected } }), report({ selection: injected }),
    report({ findings: [goodRow, goodRow] }), report({ findings: [{ ...goodRow, codes: [] }] }),
    report({ findings: [{ ...goodRow, codes: ['VERSION_MISMATCH', 'VERSION_MISMATCH'] }] }),
    report({ findings: [{ ...goodRow, codes: ['UNKNOWN'] }] }), report({ findings: [{ ...goodRow, pageId: 1 }] }),
    report({ findings: [{ ...goodRow, pageId: '01' }] }), report({ findings: [{ ...goodRow, pageId: '1'.repeat(21) }] }),
    report({ findings: [{ ...goodRow, text: injected }] }), report({ source: injected }),
  ]) {
    assert.throws(() => parseConfluenceFindings(invalid), error => error instanceof Error &&
      error.message === 'Confluence 페이지별 검토 파일의 형식 또는 건수를 확인해 주세요.' && !error.message.includes(injected));
  }
});

test('rejects a proof with wrong identifiers, incompatible counts, or extra fields', () => {
  const allReasons = confluenceFindingsProof(parseConfluenceFindings(report({
    findings: [{ pageId, codes: [...CONFLUENCE_FINDING_CODES] }],
  })), reportHash, packageId);
  assert.equal(validConfluenceFindingsProof(allReasons), true);
  for (const invalid of [
    { packageId: '../workspace' }, { sha256: 'wrong' }, { archive: { sha256: 'wrong', bytes: 13 } }, { pageCount: 0 },
    { reasonCounts: null }, { reasonCounts: {} }, { reasonCounts: { VERSION_MISMATCH: 2 } },
    { reasonCounts: { VERSION_MISMATCH: 0 } }, { reasonCounts: { VERSION_MISMATCH: 1, UNKNOWN: 1 } },
    { findings: [] }, { spacePermissions: 'passed' }, { unidentifiedPages: Number.MAX_SAFE_INTEGER },
  ]) assert.equal(validConfluenceFindingsProof({ ...allReasons, ...invalid }), false);
});

const repo = fileURLToPath(new URL('../../', import.meta.url));
const date = '2020-03-01T00:00:00Z';
const childPageId = '99999999999999999998';
const publicPageId = '99999999999999999997';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const allowedBytes = Buffer.from('synthetic unaffected attachment\x00\n');
const blockedBytes = Buffer.from('synthetic restricted descendant attachment\x00\n');

function wikiArchive(key, pages) {
  const files = [];
  const objects = pages.flatMap(({ id, title, parent, attachment, restricted }, index) => {
    const rows = [
      `<object class="Page"><id name="id">${id}</id><property name="title">${title}</property>
        <property name="version">1</property><property name="space" class="Space"><id name="id">20</id></property>
        <property name="creationDate">${date}</property><property name="lastModificationDate">${date}</property>
        ${parent ? `<property name="parent" class="Page"><id name="id">${parent}</id></property>` : ''}</object>`,
      `<object class="BodyContent"><id name="id">${300 + index}</id><property name="body"><![CDATA[<p>${title} content</p>]]></property>
        <property name="content" class="Page"><id name="id">${id}</id></property></object>`,
    ];
    if (restricted) {
      const permissionSetId = 500 + index;
      rows.push(`<object class="ContentPermissionSet"><id name="id">${permissionSetId}</id>
        <property name="type">View</property><property name="owningContent" class="Page"><id name="id">${id}</id></property></object>`);
    }
    if (attachment) {
      const attachmentId = 700 + index;
      rows.push(`<object class="Attachment"><id name="id">${attachmentId}</id><property name="title">${title}.bin</property>
        <property name="version">1</property><property name="containerContent" class="Page"><id name="id">${id}</id></property>
        <property name="creationDate">${date}</property></object>`);
      files.push({ path: `attachments/${id}/${attachmentId}/1`, bytes: attachment });
    }
    return rows;
  });
  const xml = `<hibernate-generic><object class="Space"><id name="id">20</id><property name="key">${key}</property>
    <property name="name">${key} fixture</property></object>${objects.join('')}</hibernate-generic>`;
  return zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }, ...files]);
}

function rehearsal(args) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/pilot-migration.mjs', ...args], {
    cwd: repo, env: { PATH: process.env.PATH, LANG: process.env.LANG }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', opened;
  const address = new Promise(resolve => { opened = resolve; });
  child.stdout.on('data', data => {
    stdout += data;
    const url = /이관 검토 주소 (http:\/\/127\.0\.0\.1:\d+)\s/.exec(stdout)?.[1];
    if (url) opened(url);
  });
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, address, exited };
}

async function withReview(root, action) {
  const run = rehearsal(['review', root]);
  let timer;
  try {
    const address = await Promise.race([
      run.address,
      run.exited.then(result => { throw new Error(result.stderr || 'Review closed before opening.'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Review did not open.')), 30_000); }),
    ]);
    return await action(address);
  } finally {
    clearTimeout(timer);
    if (run.child.exitCode === null && run.child.signalCode === null) {
      run.child.kill('SIGINT');
      const stopped = await run.exited;
      assert.equal(stopped.code, 130, stopped.stderr);
    }
  }
}

async function prepareRehearsal(t, sources, findings, bind = true) {
  const scratch = await mkdtemp(join(tmpdir(), 'teamspace-confluence-live-restriction-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'run');
  const manifest = join(scratch, 'manifest.json');
  const findingsPath = join(scratch, 'findings.json');
  const [reviewed] = sources;
  const raw = Buffer.from(JSON.stringify(report({ archive: { sha256: digest(reviewed.bytes), bytes: reviewed.bytes.length }, findings })));
  for (const { name, bytes } of sources) await writeFile(join(scratch, `${name}.zip`), bytes);
  await writeFile(manifest, JSON.stringify({ packages: sources.map(({ name }) => ({
    file: `${name}.zip`, product: 'confluence', instanceKey: name,
  })) }));
  await writeFile(findingsPath, raw, { mode: 0o600 });
  const stage = await rehearsal(['stage', manifest, root, ...(bind ? ['--confluence-findings', findingsPath] : [])]).exited;
  assert.equal(stage.code, 0, stage.stdout + stage.stderr);
  const stagePath = join(root, 'workspace', '.teamspace-rehearsal', 'stage.json');
  const staged = JSON.parse(await readFile(stagePath, 'utf8'));
  return { root, stagePath, staged, raw };
}

async function api(base, path, { actor, method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(`${base}/api${path}`, { method, signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function reviewConfiguration(base, packages) {
  const { users } = await api(base, '/workspace');
  const query = new URLSearchParams(packages.map(({ packageId }) => ['packageId', packageId]));
  const { defaultConfiguration: configuration } = await api(base, `/migrations/options?${query}`);
  return { actor: users[0].id, configuration };
}

function previewMigration(base, actor, configuration) {
  return api(base, '/migrations/preview', { method: 'POST', actor, body: { configuration }, status: 201 });
}

function applyMigration(base, actor, preview, status = 201, acknowledgements = preview.requiredAcknowledgements) {
  const body = { expectedVersion: preview.version, acknowledgements };
  return api(base, `/migrations/previews/${preview.id}/apply`, { method: 'POST', actor, body, status });
}

async function verification(root, exitCode) {
  const result = await rehearsal(['verify', root]).exited;
  assert.equal(result.code, exitCode, result.stdout + result.stderr);
  const path = /검증 결과 (verification-[a-z\d]+\/report\.json) \(/i.exec(result.stdout)?.[1];
  assert.ok(path, result.stdout);
  const raw = await readFile(join(root, path), 'utf8');
  assert.ok(!raw.includes(pageId) && !raw.includes(childPageId) && !raw.includes(publicPageId));
  return JSON.parse(raw);
}

test('profile-bound rehearsal still requires explicit exclusion of restrictions recorded in the Confluence XML', { timeout: 90_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'teamspace-confluence-archived-restriction-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'run');
  const manifest = join(scratch, 'manifest.json');
  const profilePath = join(scratch, 'profile.json');
  const filename = 'archived-wiki.zip';
  await writeFile(join(scratch, filename), wikiArchive('ARC', [
    { id: pageId, title: 'Archived restricted page', restricted: true },
    { id: childPageId, title: 'Archived restricted child', parent: pageId },
    { id: publicPageId, title: 'Public page' },
  ]));
  await writeFile(manifest, JSON.stringify({ packages: [{ file: filename, product: 'confluence', instanceKey: 'archived-wiki' }] }));

  const profile = await rehearsal(['profile', manifest, profilePath]).exited;
  assert.equal(profile.code, 2, profile.stdout + profile.stderr);
  const { status, packages } = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.equal(status, 'review');
  assert.deepEqual(packages[0].analysis.diagnostics.filter(row => row.severity === 'error'), [
    { code: 'CONFLUENCE_RESTRICTED_CONTENT', severity: 'error', count: 2 },
  ]);

  const stage = await rehearsal(['stage', manifest, root, '--profile', profilePath]).exited;
  assert.equal(stage.code, 0, stage.stdout + stage.stderr);
  const staged = JSON.parse(await readFile(join(root, 'workspace', '.teamspace-rehearsal', 'stage.json'), 'utf8'));
  assert.equal(staged.profile.status, 'review');
  assert.equal(staged.packages[0].errors, 2);
  assert.equal(staged.confluenceReviews, undefined);
  const restrictedRecord = `${staged.packages[0].packageId}/page:${pageId}`;
  const childRecord = `${staged.packages[0].packageId}/page:${childPageId}`;

  await withReview(root, async base => {
    const { actor, configuration } = await reviewConfiguration(base, staged.packages);
    const blocked = await previewMigration(base, actor, configuration);
    assert.equal(blocked.canApply, false);
    assert.deepEqual(blocked.notices.filter(notice => notice.code === 'SOURCE_CONFLUENCE_RESTRICTED_CONTENT' && notice.severity === 'error')
      .map(notice => notice.recordId).sort(), [restrictedRecord, childRecord].sort());
    await applyMigration(base, actor, blocked, 409);
    assert.deepEqual((await api(base, '/workspace')).documents, []);
    assert.deepEqual(await api(base, '/source-imports'), []);

    const safe = await previewMigration(base, actor, { ...configuration, excludedRecords: [restrictedRecord] });
    assert.equal(safe.canApply, true, JSON.stringify(safe.notices));
    assert.equal(safe.counts.explicitExcludedRecords, 1);
    assert.equal(safe.counts.excludedDescendants, 1);
    await applyMigration(base, actor, safe);
    assert.deepEqual((await api(base, '/workspace')).documents.map(({ title, plainText }) => [title, plainText]), [
      ['Public page', 'Public page content'],
    ]);
  });

  const verified = await verification(root, 2);
  assert.equal(verified.status, 'review');
  assert.equal(verified.comparison.matches, true);
  assert.equal(verified.profile.sha256, staged.profile.sha256);
  for (const snapshot of [verified.source, verified.restore]) {
    assert.equal(snapshot.evidence.checks.receiptsWithPrimaryRecordCountMismatches, 0);
    const [pages] = snapshot.evidence.receipts[0].primaryRecords;
    assert.equal(pages.packageId, staged.packages[0].packageId);
    assert.deepEqual(pages.counts, { linked: 1, trashed: 0, missing: 0, 'archive-only': 0, excluded: 2 });
  }
});

test('guarded rehearsal requires excluding ZIP-bound live restrictions and omits their descendants and files', { timeout: 120_000 }, async t => {
  const reviewed = wikiArchive('REV', [
    { id: pageId, title: 'Restricted page' },
    { id: childPageId, title: 'Restricted descendant', parent: pageId, attachment: blockedBytes },
    { id: publicPageId, title: 'Unconfirmed page', attachment: allowedBytes },
  ]);
  const unrelated = wikiArchive('ALT', [{ id: pageId, title: 'Same numeric ID in another instance' }]);
  const findings = [{ pageId, codes: ['LIVE_RESTRICTED', 'RESTRICTION_MISMATCH'] },
    { pageId: publicPageId, codes: ['LIVE_RESTRICTION_UNKNOWN'] }];
  const { root, staged } = await prepareRehearsal(t, [
    { name: 'reviewed-wiki', bytes: reviewed }, { name: 'unrelated-wiki', bytes: unrelated },
  ], findings);
  const [reviewedPackage, unrelatedPackage] = staged.packages;
  assert.equal(staged.confluenceReviews[0].packageId, reviewedPackage.packageId);
  assert.notEqual(staged.confluenceReviews[0].archive.sha256, unrelatedPackage.sha256);
  assert.equal(reviewedPackage.errors, 0, 'The ZIP alone has no restriction error');
  const restrictedRecord = `${reviewedPackage.packageId}/page:${pageId}`;
  const childRecord = `${reviewedPackage.packageId}/page:${childPageId}`;

  // A preview made before the guard was loaded cannot be reused in the CLI review process.
  const unguarded = await startRehearsalPilot(join(root, 'workspace'));
  let stale;
  try {
    const { actor, configuration } = await reviewConfiguration(unguarded.url, staged.packages);
    stale = await previewMigration(unguarded.url, actor, configuration);
    assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  } finally {
    await unguarded.close();
  }

  await withReview(root, async base => {
    const { actor, configuration } = await reviewConfiguration(base, staged.packages);
    const staleResult = await applyMigration(base, actor, stale, 409);
    assert.match(staleResult.error, /Confluence 페이지별 검토 범위/);
    const blocked = await previewMigration(base, actor, configuration);
    assert.equal(blocked.canApply, false);
    const records = blocked.notices.filter(notice => notice.code === 'RESTRICTED_CONTENT' && notice.severity === 'error').map(notice => notice.recordId);
    assert.ok(records.includes(restrictedRecord), JSON.stringify(blocked.notices));
    assert.ok(records.includes(childRecord), JSON.stringify(blocked.notices));
    assert.ok(records.every(id => id.startsWith(`${reviewedPackage.packageId}/`)), JSON.stringify(blocked.notices));
    assert.ok(!records.includes(`${reviewedPackage.packageId}/page:${publicPageId}`));
    await applyMigration(base, actor, blocked, 409);
    assert.deepEqual((await api(base, '/workspace')).documents, []);
    assert.deepEqual(await api(base, '/source-imports'), []);

    const safe = await previewMigration(base, actor, { ...configuration, excludedRecords: [restrictedRecord] });
    assert.equal(safe.canApply, true, JSON.stringify(safe.notices));
    assert.equal(safe.counts.explicitExcludedRecords, 1);
    assert.equal(safe.counts.excludedDescendants, 2);
    assert.equal(safe.counts.documents, 2);
    assert.equal(safe.counts.attachments, 1);
    assert.ok(safe.requiredAcknowledgements.includes('RECORDS_EXCLUDED'));
    await applyMigration(base, actor, safe, 400, safe.requiredAcknowledgements.filter(code => code !== 'RECORDS_EXCLUDED'));
    const { import: receipt } = await applyMigration(base, actor, safe);
    const { documents } = await api(base, '/workspace');
    assert.deepEqual(documents.map(({ title, plainText }) => [title, plainText]).sort(), [
      ['Same numeric ID in another instance', 'Same numeric ID in another instance content'],
      ['Unconfirmed page', 'Unconfirmed page content'],
    ]);
    const reconciliation = await api(base, `/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${receipt.version}`);
    assert.deepEqual(reconciliation.attachments.map(({ status, recordStatus }) => [status, recordStatus]).sort(),
      [['excluded', 'excluded'], ['verified', 'linked']]);
    const { fileId } = reconciliation.attachments.find(attachment => attachment.status === 'verified');
    const response = await fetch(`${base}/api/attachments/${fileId}/content`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), allowedBytes);
  });

  const verified = await verification(root, 2);
  assert.equal(verified.status, 'review');
  assert.equal(verified.comparison.matches, true);
  const [review] = verified.source.evidence.receipts[0].confluenceReviews;
  assert.deepEqual(review.counts, { excluded: 1, documentBound: 1, archiveOnly: 0, absent: 0 });
  assert.deepEqual(review.liveRestrictedCounts, { excluded: 1, documentBound: 0, archiveOnly: 0, absent: 0 });
  assert.equal(verified.source.evidence.checks.receiptsWithLiveRestrictedConfluenceDocuments, 0);
  assert.deepEqual(verified.restore.evidence.receipts[0].confluenceReviews, [review]);
});

test('verification fails for a legacy receipt that linked a live restricted page', { timeout: 90_000 }, async t => {
  const bytes = wikiArchive('OLD', [{ id: pageId, title: 'Previously linked restricted page' }]);
  const { root, stagePath, staged, raw } = await prepareRehearsal(t, [{ name: 'legacy-wiki', bytes }],
    [{ pageId, codes: ['LIVE_RESTRICTED'] }], false);
  await withReview(root, async base => {
    const { actor, configuration } = await reviewConfiguration(base, staged.packages);
    const beforeGuard = await previewMigration(base, actor, configuration);
    assert.equal(beforeGuard.canApply, true, JSON.stringify(beforeGuard.notices));
    await applyMigration(base, actor, beforeGuard);
    assert.equal((await api(base, '/workspace')).documents[0].title, 'Previously linked restricted page');
  });

  // Reconstruct the proof files recorded by the previous, unguarded rehearsal implementation.
  const proof = confluenceFindingsProof(parseConfluenceFindings(JSON.parse(raw)), digest(raw), staged.packages[0].packageId);
  const proofs = join(root, 'workspace', '.teamspace-rehearsal', 'confluence-findings');
  await mkdir(proofs, { mode: 0o700 });
  await writeFile(join(proofs, `${proof.sha256}.json`), raw, { mode: 0o600 });
  await writeFile(stagePath, JSON.stringify({ ...staged, confluenceReviews: [proof] }));

  const verified = await verification(root, 1);
  assert.equal(verified.status, 'failed');
  assert.equal(verified.source.evidence.status, 'failed');
  assert.equal(verified.source.evidence.checks.receiptsWithLiveRestrictedConfluenceDocuments, 1);
  const [review] = verified.source.evidence.receipts[0].confluenceReviews;
  assert.deepEqual(review.liveRestrictedCounts, { excluded: 0, documentBound: 1, archiveOnly: 0, absent: 0 });
  assert.equal(verified.restore, null);
});
