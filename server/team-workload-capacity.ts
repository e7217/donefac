import { validateWorkCalendar } from '../shared/calendar.js';
import { defaultTeamWorkloadCapacity } from '../shared/team-workload-capacity.js';
import type { TeamWorkloadCapacity, User } from '../shared/types.js';
import { nextWorkloadCapacityVersion, parseWorkloadCapacityValues, WorkloadError } from './project-workload.js';
import type { Store } from './store.js';

const settingKey = 'teamWorkloadCapacity';

function capacityObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkloadError(400, '팀 가용 시간 설정을 확인해 주세요.');
  }
  return raw as Record<string, unknown>;
}

function parseCapacity(
  input: Record<string, unknown>, version: number, updatedAt: string, users: readonly User[],
): TeamWorkloadCapacity {
  const calendar = validateWorkCalendar({
    id: 'team', projectId: 'team', name: '팀 작업 달력', version, updatedAt,
    workingWeekdays: input.workingWeekdays, exceptions: input.calendarExceptions,
  });
  return {
    version, updatedAt,
    workingWeekdays: calendar.workingWeekdays, calendarExceptions: calendar.exceptions,
    ...parseWorkloadCapacityValues(input, new Set(users.map(user => user.id))),
  };
}

export class TeamWorkloadCapacityService {
  constructor(private readonly store: Store) {}

  get(): TeamWorkloadCapacity {
    return this.store.setting(settingKey) ?? defaultTeamWorkloadCapacity();
  }

  save(body: unknown, onSaved?: (capacity: TeamWorkloadCapacity) => void): TeamWorkloadCapacity {
    const input = capacityObject(body);
    const { expectedVersion } = input;
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new WorkloadError(400, 'expectedVersion이 필요합니다.');
    }
    return this.store.transaction(() => {
      const prior = this.get();
      if (expectedVersion !== prior.version) {
        throw new WorkloadError(409, '팀 가용 시간 설정이 변경되었습니다. 최신 설정을 불러와 주세요.', { currentVersion: prior.version });
      }
      const capacity = parseCapacity(
        { ...prior, ...input }, nextWorkloadCapacityVersion(prior.version), new Date().toISOString(), this.store.all<User>('users'),
      );
      this.store.setSetting(settingKey, capacity);
      onSaved?.(capacity);
      return capacity;
    });
  }

  validateImport(raw: unknown, users: readonly User[], { legacy = false }: { legacy?: boolean } = {}): TeamWorkloadCapacity {
    if (legacy && raw === undefined) return defaultTeamWorkloadCapacity();
    const input = capacityObject(raw);
    const { version, updatedAt } = input;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
      || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
      throw new WorkloadError(400, '팀 가용 시간 설정의 버전과 수정 시간을 확인해 주세요.');
    }
    const capacity = parseCapacity(input, version, updatedAt, users);
    if (!legacy) return capacity;

    const defaults = defaultTeamWorkloadCapacity();
    if (capacity.defaultDailyMinutes !== defaults.defaultDailyMinutes || capacity.members.length || capacity.exceptions.length
      || capacity.calendarExceptions.length || capacity.workingWeekdays.length !== defaults.workingWeekdays.length
      || capacity.workingWeekdays.some((day, index) => day !== defaults.workingWeekdays[index])) {
      throw new WorkloadError(400, '팀 가용 시간 설정은 schemaVersion 19가 필요합니다.');
    }
    return defaults;
  }

  replaceImported(capacity: TeamWorkloadCapacity, previousVersion: number): void {
    this.store.setSetting(settingKey, {
      ...capacity, version: nextWorkloadCapacityVersion(Math.max(capacity.version, previousVersion)),
    });
  }
}
