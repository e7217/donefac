import { defaultWorkCalendar } from './calendar.js';
import { DEFAULT_DAILY_WORKLOAD_MINUTES } from './project-workload.js';
import type { TeamWorkloadCapacity } from './types.js';

export function defaultTeamWorkloadCapacity(): TeamWorkloadCapacity {
  const calendar = defaultWorkCalendar('team');
  return {
    version: calendar.version,
    updatedAt: calendar.updatedAt,
    workingWeekdays: calendar.workingWeekdays,
    calendarExceptions: calendar.exceptions,
    defaultDailyMinutes: DEFAULT_DAILY_WORKLOAD_MINUTES,
    members: [],
    exceptions: [],
  };
}
