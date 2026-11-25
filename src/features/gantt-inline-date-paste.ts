import { isCalendarDate } from '../../shared/calendar';
import type { ScheduleDependencyEndpoint } from '../../shared/schedule-dependencies';
import { SCHEDULE_PASTE_MAX_BYTES } from '../../shared/schedule-paste-format';
import { MAX_SCHEDULE_BULK_DATE_ISSUES, type ScheduleBulkDateChanges } from '../../shared/types';

type DateRangePaste = { rows: ScheduleBulkDateChanges[] } | { error: string };

export function parseGanttDateRangePaste(text: string, firstField: ScheduleDependencyEndpoint): DateRangePaste | null {
  const normalized = text.replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
  if (!normalized.includes('\n')) return null;
  const lines = normalized.split('\n', MAX_SCHEDULE_BULK_DATE_ISSUES + 1);
  if (lines.length > MAX_SCHEDULE_BULK_DATE_ISSUES || text.length > SCHEDULE_PASTE_MAX_BYTES) {
    return { error: `날짜는 한 번에 최대 ${MAX_SCHEDULE_BULK_DATE_ISSUES}행까지 붙여넣을 수 있습니다.` };
  }
  const width = lines[0].split('\t').length;
  if (width > 2 || (width === 2 && firstField === 'endDate')) {
    return { error: '날짜 한 열을 붙여넣거나 시작일 칸에서 시작일·종료일 두 열을 붙여넣으세요.' };
  }

  const rows: ScheduleBulkDateChanges[] = [];
  const fields: readonly ScheduleDependencyEndpoint[] = [firstField, 'endDate'];
  for (const [index, line] of lines.entries()) {
    const cells = line.split('\t');
    if (cells.length !== width) return { error: `${index + 1}행의 열 수가 다릅니다. 같은 열 수로 날짜를 복사해 주세요.` };
    const changes: ScheduleBulkDateChanges = {};
    for (const [column, cell] of cells.entries()) {
      const value = cell.trim();
      if (!value) continue;
      if (value === '-') changes[fields[column]] = null;
      else if (isCalendarDate(value)) changes[fields[column]] = value;
      else return { error: `${index + 1}행 ${column + 1}열의 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.` };
    }
    rows.push(changes);
  }
  return { rows };
}
