import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { readPilotConfluenceReview, type PilotConfluenceReview } from '../../server/pilot-confluence-review.js';

const originalRestrictions = { TEAMSPACE_PILOT_CONFLUENCE_RESTRICTIONS: 'stdin' };
const reviewEnv = { TEAMSPACE_PILOT_CONFLUENCE_REVIEW: 'stdin' };
const versionOneReview: PilotConfluenceReview = {
  packageId: '00000000-0000-4000-8000-000000000001',
  archiveSha256: 'a'.repeat(64),
  archiveBytes: 12345,
  checkedAt: '2026-11-24T00:00:00.000Z',
  selection: 'explicit-pages',
  status: 'matched',
  spacePermissions: 'manual-review',
  findingsPages: 0,
  unidentifiedPages: 0,
};
const review: PilotConfluenceReview = {
  ...versionOneReview,
  coverage: {
    archivePages: 10, matchedPages: 2, permissionCheckedPages: 2, outsideSelectionPages: 7, otherSpacePages: 1, unassignedPages: 0,
  },
};
const stream = (data: unknown) => Readable.from([JSON.stringify(data)]);

test('offline Confluence review stdin keeps independent scopes and pre-existing page restrictions', async () => {
  const payload = { restrictions: [['synthetic-instance', ['111', '222']]], reviews: [review, versionOneReview] };
  const configuration = await readPilotConfluenceReview(reviewEnv, false, stream(payload));
  assert.deepEqual(configuration, {
    restrictedConfluencePages: new Map([['synthetic-instance', new Set(['111', '222'])]]),
    confluenceReviews: [review, versionOneReview],
  });
  assert.deepEqual(await readPilotConfluenceReview(originalRestrictions, false, stream(payload.restrictions)), {
    restrictedConfluencePages: configuration.restrictedConfluencePages,
  });
  assert.deepEqual(await readPilotConfluenceReview(reviewEnv, false, stream({ ...payload, restrictions: [] })), {
    ...configuration, restrictedConfluencePages: new Map(),
  });
});

test('team access and ambiguous Confluence review configuration are rejected before reading stdin', async () => {
  const unreadable = { [Symbol.asyncIterator]() { throw new Error('stdin was read'); } };
  assert.deepEqual(await readPilotConfluenceReview({}, true, unreadable), {});
  for (const env of [originalRestrictions, reviewEnv]) {
    await assert.rejects(readPilotConfluenceReview(env, true, unreadable), /오프라인 리허설/);
  }
  await assert.rejects(readPilotConfluenceReview({ ...originalRestrictions, ...reviewEnv }, false, unreadable), /검토 파일/);
});

test('offline Confluence review stdin rejects inconsistent coverage and private fields', async () => {
  const payload = (row: unknown) => stream({ restrictions: [], reviews: [row] });
  const { coverage } = review;
  for (const row of [
    { ...review, checkedAt: '2026-02-31T00:00:00.000Z' },
    { ...review, selection: 'visible-space' },
    { ...review, archiveBytes: 0 },
    { ...review, findingsPages: 1 },
    { ...review, pageId: '111' },
    { ...review, coverage: { ...coverage, archivePages: 9 } },
    { ...review, coverage: { ...coverage, permissionCheckedPages: 1 } },
    { ...review, coverage: { ...coverage, permissionCheckedPages: 3 } },
    { ...review, coverage: { ...coverage, outsideSelectionPages: -1 } },
    { ...review, coverage: { ...coverage, pageId: '111' } },
  ]) {
    await assert.rejects(readPilotConfluenceReview(reviewEnv, false, payload(row)), /검토 파일/);
  }
  const needsReview = { ...review, status: 'needs-review', coverage: { ...coverage, permissionCheckedPages: 1 } };
  assert.deepEqual((await readPilotConfluenceReview(reviewEnv, false, payload(needsReview))).confluenceReviews, [needsReview]);
});
