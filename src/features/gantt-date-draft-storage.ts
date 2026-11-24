import { isCalendarDate } from '../../shared/calendar';
import type { Issue } from '../../shared/types';

export type StoredGanttDateDraft = {
  id: string;
  projectId: string;
  version: number;
  startDate: string | null;
  endDate: string | null;
  draftStart: string | null;
  draftEnd: string | null;
};

export type GanttIssueDateDrafts = {
  read: (issue: Issue) => StoredGanttDateDraft | undefined;
  acceptSaved: (draft: StoredGanttDateDraft, saved: Issue) => void;
};

export const GANTT_DATE_DRAFT_PREFIX = 'teamspace:gantt-date-drafts:';
const schemaVersion = 1;

export function ganttDateDraftKey(actorId: string, projectScope: string | null, restoreGeneration: string | undefined): string {
  return `${GANTT_DATE_DRAFT_PREFIX}${JSON.stringify([actorId, projectScope, restoreGeneration ?? null])}`;
}

function isStoredDraft(value: unknown): value is StoredGanttDateDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Partial<StoredGanttDateDraft>;
  return typeof draft.id === 'string' && Boolean(draft.id.trim()) &&
    typeof draft.projectId === 'string' && Boolean(draft.projectId.trim()) &&
    typeof draft.version === 'number' && Number.isSafeInteger(draft.version) && draft.version > 0 &&
    [draft.startDate, draft.endDate, draft.draftStart, draft.draftEnd].every(date => date === null || isCalendarDate(date));
}

function dateDraftValues({ id, projectId, version, startDate, endDate, draftStart, draftEnd }: StoredGanttDateDraft): StoredGanttDateDraft {
  return { id, projectId, version, startDate, endDate, draftStart, draftEnd };
}

export function readGanttDateDrafts(storage: Storage, key: string): Map<string, StoredGanttDateDraft> {
  const raw = storage.getItem(key);
  const drafts = new Map<string, StoredGanttDateDraft>();
  if (raw === null) return drafts;

  const envelope: unknown = JSON.parse(raw);
  if (!envelope || typeof envelope !== 'object' || !('schemaVersion' in envelope) || envelope.schemaVersion !== schemaVersion ||
      !('drafts' in envelope) || !Array.isArray(envelope.drafts)) {
    throw new Error('보관한 간트 날짜 초안 형식을 읽을 수 없습니다.');
  }
  for (const entry of envelope.drafts) {
    if (isStoredDraft(entry) && !drafts.has(entry.id)) drafts.set(entry.id, dateDraftValues(entry));
  }
  return drafts;
}

export function writeGanttDateDrafts(storage: Storage, key: string, drafts: ReadonlyMap<string, StoredGanttDateDraft>): void {
  if (!drafts.size) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify({ schemaVersion, drafts: Array.from(drafts.values(), dateDraftValues) }));
}

export function clearGanttDateDrafts(storage: Storage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key?.startsWith(GANTT_DATE_DRAFT_PREFIX)) storage.removeItem(key);
  }
}
