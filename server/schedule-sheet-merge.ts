import type { ScheduleSheetBaseline } from '../shared/schedule-paste-format.js';
import type { Dependency } from '../shared/types.js';
import type { SchedulePasteRow } from './schedule-paste-parser.js';

type LinkInput = NonNullable<SchedulePasteRow['dependency']>;
type LinkBaseline = NonNullable<ScheduleSheetBaseline['dependency']>;
type LinkValues = Pick<Dependency, 'type' | 'lagDays'>;
type LinkResult = { values: LinkValues | null } | { errors: string[] };

export function scheduleSheetConflict(label: string, baseline: string | number | null, saved: string | number | null, input: string | number | null) {
  return `${label} 값이 일정표를 받은 뒤 바뀌었습니다. 내보낸 값 ${baseline ?? '미정'} · 현재 ${saved ?? '미정'} · 입력 ${input ?? '미정'}`;
}

function editedLinkValues(input: LinkInput, baseline: LinkBaseline) {
  return {
    type: input.type === baseline.type ? undefined : input.type,
    lagDays: input.lagDays === baseline.lagDays ? undefined : input.lagDays,
  };
}

export function unchangedScheduleSheetLink(input: LinkInput, baseline: LinkBaseline): boolean {
  const { type, lagDays } = editedLinkValues(input, baseline);
  return input.predecessorKey === baseline.predecessorKey && type === undefined && lagDays === undefined;
}

export function mergeScheduleSheetLink(input: LinkInput, predecessorId: string, saved: Dependency | undefined,
  baseline: ScheduleSheetBaseline['dependency'] | undefined): LinkResult {
  if (baseline === undefined) {
    return { values: input.type === '-' ? null : { type: input.type ?? saved?.type ?? 'FS', lagDays: input.lagDays ?? saved?.lagDays ?? 0 } };
  }
  if (baseline === null) {
    const values = input.type === '-' ? null : { type: input.type ?? 'FS', lagDays: input.lagDays ?? 0 };
    if (saved && (!values || values.type !== saved.type || values.lagDays !== saved.lagDays)) {
      return { errors: ['일정표를 받은 뒤 이 선행 연결이 이미 추가되었습니다. 현재 연결을 확인해 주세요.'] };
    }
    return { values };
  }
  if (baseline.predecessorId !== predecessorId) {
    return { errors: ['내려받은 선행 업무가 바뀌었습니다. 새 업무를 연결하려면 새 행을 추가해 주세요.'] };
  }

  const { type, lagDays } = editedLinkValues(input, baseline);
  if (type === undefined && lagDays === undefined) return { values: saved ? { type: saved.type, lagDays: saved.lagDays } : null };
  if (type === '-' && !saved) return { values: null };
  if (saved?.id !== baseline.id) {
    return { errors: ['일정표를 받은 뒤 선행 연결이 해제되거나 교체되었습니다. 현재 연결을 확인해 주세요.'] };
  }
  if (type === '-') {
    if (saved.type !== baseline.type || saved.lagDays !== baseline.lagDays) {
      return { errors: [`일정표를 받은 뒤 수정된 연결입니다. 내보낸 연결 ${baseline.type} · ${baseline.lagDays}근무일, 현재 ${saved.type} · ${saved.lagDays}근무일을 확인해 주세요.`] };
    }
    return { values: null };
  }

  const errors: string[] = [];
  if (type && saved.type !== baseline.type && saved.type !== type) errors.push(scheduleSheetConflict('연결 유형', baseline.type, saved.type, type));
  if (lagDays !== undefined && saved.lagDays !== baseline.lagDays && saved.lagDays !== lagDays) {
    errors.push(scheduleSheetConflict('근무일 간격', baseline.lagDays, saved.lagDays, lagDays));
  }
  return errors.length ? { errors } : { values: { type: type ?? saved.type, lagDays: lagDays ?? saved.lagDays } };
}
