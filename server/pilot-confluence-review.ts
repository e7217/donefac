import { z } from 'zod';
import type { MigrationConfluenceReview } from '../shared/types.js';
import { LEGACY_MAX_RECORDS } from './legacy-import-model.js';

export type PilotConfluenceReview = MigrationConfluenceReview & { archiveSha256: string; archiveBytes: number };

const readError = 'Confluence 리허설의 검토 파일을 읽을 수 없습니다.';
const restrictionsError = 'Confluence 리허설의 페이지 제한을 읽을 수 없습니다.';
const maxLivePages = 500;
const maxFindings = LEGACY_MAX_RECORDS + maxLivePages;
const maxArchiveBytes = 64 * 1024 * 1024;
const count = z.number().int().nonnegative();
const archiveCount = count.max(LEGACY_MAX_RECORDS);
const liveCount = count.max(maxLivePages);
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const reviewSchema = z.object({
  packageId: z.string().regex(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/),
  archiveSha256: z.string().regex(/^[a-f\d]{64}$/),
  archiveBytes: count.positive().max(maxArchiveBytes),
  checkedAt: z.string().regex(isoTime).refine(value =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  selection: z.enum(['explicit-pages', 'visible-space']),
  status: z.enum(['matched', 'needs-review']),
  spacePermissions: z.literal('manual-review'),
  findingsPages: count.max(maxFindings),
  unidentifiedPages: count.max(maxFindings),
  coverage: z.object({
    archivePages: archiveCount,
    matchedPages: liveCount,
    permissionCheckedPages: liveCount,
    outsideSelectionPages: archiveCount,
    otherSpacePages: archiveCount,
    unassignedPages: archiveCount,
  }).strict().optional(),
}).strict().refine(review => {
  const { coverage, findingsPages, unidentifiedPages, selection, status } = review;
  if (findingsPages + unidentifiedPages > maxFindings ||
      (status === 'matched' && (findingsPages !== 0 || unidentifiedPages !== 0))) return false;
  if (!coverage) return true;
  const { archivePages, matchedPages, permissionCheckedPages, outsideSelectionPages, otherSpacePages, unassignedPages } = coverage;
  const scopedPages = archivePages - outsideSelectionPages - otherSpacePages - unassignedPages;
  return permissionCheckedPages <= matchedPages && matchedPages <= scopedPages &&
    (selection === 'explicit-pages' || outsideSelectionPages === 0) &&
    (status === 'needs-review' || (matchedPages > 0 && permissionCheckedPages === matchedPages &&
      matchedPages === scopedPages && unassignedPages === 0));
});

function readRestrictions(input: unknown, allowEmpty: boolean) {
  const result = new Map<string, ReadonlySet<string>>();
  if (!Array.isArray(input) || (!allowEmpty && !input.length) || input.length > 20) throw new Error(restrictionsError);
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error(restrictionsError);
    const [instance, pageIds] = entry;
    if (typeof instance !== 'string' || !instance.trim() || instance.length > 200 || result.has(instance) ||
        !Array.isArray(pageIds) || !pageIds.length ||
        !pageIds.every(id => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id))) throw new Error(restrictionsError);
    result.set(instance, new Set(pageIds));
  }
  return result;
}

function parseReviewInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, 'restrictions') || !Object.hasOwn(input, 'reviews')) throw new Error(readError);
  const { restrictions, reviews } = input as Record<string, unknown>;
  if (!Array.isArray(reviews) || !reviews.length || reviews.length > 100) throw new Error(readError);
  const parsed = z.array(reviewSchema).safeParse(reviews);
  if (!parsed.success) throw new Error(readError);
  return { restrictedConfluencePages: readRestrictions(restrictions, true), confluenceReviews: parsed.data };
}

export async function readPilotConfluenceReview(env: Record<string, string | undefined>, teamAccess: boolean,
  stdin: AsyncIterable<string | Uint8Array>): Promise<{
    restrictedConfluencePages?: ReadonlyMap<string, ReadonlySet<string>>;
    confluenceReviews?: readonly PilotConfluenceReview[];
  }> {
  const { TEAMSPACE_PILOT_CONFLUENCE_RESTRICTIONS: restrictions, TEAMSPACE_PILOT_CONFLUENCE_REVIEW: review } = env;
  if (restrictions === undefined && review === undefined) return {};
  if (teamAccess) throw new Error('Confluence 검토는 오프라인 리허설에서 실행해 주세요.');
  const message = review === undefined ? restrictionsError : readError;
  if ((restrictions !== undefined && review !== undefined) || (review ?? restrictions) !== 'stdin') throw new Error(message);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 128 * 1024 * 1024) throw new Error(message);
    chunks.push(bytes);
  }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new Error(message); }
  return review === undefined ? { restrictedConfluencePages: readRestrictions(input, false) } : parseReviewInput(input);
}
