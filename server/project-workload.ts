import { isCalendarDate } from '../shared/calendar.js';
import { defaultWorkloadCapacity, MAX_DAILY_WORKLOAD_MINUTES, WorkloadError } from '../shared/project-workload.js';
import type { Project, ProjectWorkloadCapacity, User, WorkloadCapacityValues } from '../shared/types.js';
import type { Store } from './store.js';

export { WorkloadError } from '../shared/project-workload.js';

const MAX_EXCEPTIONS = 10_000;

function invalid(message: string, status = 400, details?: unknown): never {
  throw new WorkloadError(status, message, details);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}을(를) 확인해 주세요.`);
  return value as Record<string, unknown>;
}

function minutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_DAILY_WORKLOAD_MINUTES) {
    invalid(`하루 가용 시간은 0~${MAX_DAILY_WORKLOAD_MINUTES} 사이의 정수 분으로 입력해 주세요.`);
  }
  return value;
}

function readUserId(value: unknown, userIds: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !userIds.has(value)) invalid('가용 시간을 지정할 팀원을 확인해 주세요.');
  return value;
}

export function nextWorkloadCapacityVersion(version: number): number {
  if (!Number.isSafeInteger(version + 1)) invalid('가용 시간 설정 버전이 한도에 도달했습니다.', 409);
  return version + 1;
}

export function parseWorkloadCapacityValues(input: Record<string, unknown>, userIds: ReadonlySet<string>): WorkloadCapacityValues {
  const defaultDailyMinutes = minutes(input.defaultDailyMinutes);
  if (!Array.isArray(input.members) || input.members.length > userIds.size) invalid('팀원별 가용 시간 목록을 확인해 주세요.');
  const seenMembers = new Set<string>();
  const members = input.members.map(value => {
    const raw = object(value, '팀원별 가용 시간');
    const userId = readUserId(raw.userId, userIds);
    if (seenMembers.has(userId)) invalid('팀원별 가용 시간을 중복 지정할 수 없습니다.');
    seenMembers.add(userId);
    return { userId, dailyMinutes: minutes(raw.dailyMinutes) };
  });

  if (!Array.isArray(input.exceptions) || input.exceptions.length > MAX_EXCEPTIONS) {
    invalid('날짜별 가용 시간 예외는 10,000개 이하여야 합니다.');
  }
  const seenDates = new Map<string, Set<string>>();
  const exceptions = input.exceptions.map(value => {
    const raw = object(value, '날짜별 가용 시간');
    const userId = readUserId(raw.userId, userIds);
    const date = raw.date;
    if (!isCalendarDate(date)) invalid('날짜별 가용 시간에는 유효한 YYYY-MM-DD 날짜가 필요합니다.');
    const dates = seenDates.get(userId) ?? new Set<string>();
    if (dates.has(date)) invalid('같은 팀원의 날짜별 가용 시간을 중복 지정할 수 없습니다.');
    dates.add(date);
    seenDates.set(userId, dates);
    return { userId, date, availableMinutes: minutes(raw.availableMinutes) };
  });

  members.sort((a, b) => a.userId.localeCompare(b.userId));
  exceptions.sort((a, b) => a.date.localeCompare(b.date) || a.userId.localeCompare(b.userId));
  return { defaultDailyMinutes, members, exceptions };
}

export class ProjectWorkloadService {
  constructor(private readonly store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS project_workload_capacities(id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL)');
  }

  get(projectId: string): ProjectWorkloadCapacity {
    const project = this.store.get<Project>('projects', projectId);
    if (!project) invalid('프로젝트를 찾을 수 없습니다.', 404);
    return this.store.get<ProjectWorkloadCapacity>('project_workload_capacities', projectId)
      ?? defaultWorkloadCapacity(projectId, project.createdAt);
  }

  snapshot(): ProjectWorkloadCapacity[] {
    const stored = new Map(this.store.all<ProjectWorkloadCapacity>('project_workload_capacities').map(value => [value.projectId, value]));
    return this.store.all<Project>('projects').map(project => stored.get(project.id) ?? defaultWorkloadCapacity(project.id, project.createdAt));
  }

  save(projectId: string, body: unknown, onSaved?: (capacity: ProjectWorkloadCapacity) => void): ProjectWorkloadCapacity {
    const input = object(body, '프로젝트 가용 시간 설정');
    const { expectedVersion } = input;
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      invalid('expectedVersion이 필요합니다.');
    }
    if ((Object.hasOwn(input, 'id') && input.id !== projectId) || (Object.hasOwn(input, 'projectId') && input.projectId !== projectId)) {
      invalid('가용 시간 설정의 프로젝트를 변경할 수 없습니다.');
    }
    return this.store.transaction(() => {
      const prior = this.get(projectId);
      if (expectedVersion !== prior.version) {
        invalid('가용 시간 설정이 변경되었습니다. 최신 설정을 불러와 주세요.', 409, { currentVersion: prior.version });
      }
      const values = {
        defaultDailyMinutes: Object.hasOwn(input, 'defaultDailyMinutes') ? input.defaultDailyMinutes : prior.defaultDailyMinutes,
        members: Object.hasOwn(input, 'members') ? input.members : prior.members,
        exceptions: Object.hasOwn(input, 'exceptions') ? input.exceptions : prior.exceptions,
      };
      const userIds = new Set(this.store.all<User>('users').map(user => user.id));
      const result = {
        id: projectId, projectId, version: nextWorkloadCapacityVersion(prior.version), updatedAt: new Date().toISOString(),
        ...parseWorkloadCapacityValues(values, userIds),
      };
      this.store.put('project_workload_capacities', result);
      onSaved?.(result);
      return result;
    });
  }

  validateImport(raw: unknown, projects: Project[], users: User[], { legacy = false }: { legacy?: boolean } = {}): ProjectWorkloadCapacity[] {
    if (legacy) return projects.map(project => defaultWorkloadCapacity(project.id, project.createdAt));
    if (!Array.isArray(raw) || raw.length !== projects.length) invalid('프로젝트별 가용 시간 설정이 하나씩 필요합니다.');
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const seen = new Set<string>();
    return raw.map(value => {
      const input = object(value, '가용 시간 설정');
      const { projectId, version, updatedAt } = input;
      if (typeof projectId !== 'string' || input.id !== projectId || !projectIds.has(projectId) || seen.has(projectId)) {
        invalid('가용 시간 설정의 프로젝트가 중복되거나 올바르지 않습니다.');
      }
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
        || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
        invalid('가용 시간 설정의 버전과 수정 시간을 확인해 주세요.');
      }
      seen.add(projectId);
      return { id: projectId, projectId, version, updatedAt, ...parseWorkloadCapacityValues(input, userIds) };
    });
  }

  replaceImported(values: ProjectWorkloadCapacity[], previousVersions: ReadonlyMap<string, number>): void {
    const restored = values.map(value => {
      const previous = previousVersions.get(value.projectId);
      return previous === undefined ? value : { ...value, version: nextWorkloadCapacityVersion(Math.max(value.version, previous)) };
    });
    this.store.db.exec('DELETE FROM project_workload_capacities');
    for (const value of restored) this.store.put('project_workload_capacities', value);
  }
}
