import type { LegacyRecord } from '../shared/types.js';

export type JiraDateRole = 'startDate' | 'endDate';
type Role = JiraDateRole;
type DateValue = string | null | undefined;
type Proof = boolean | null;
type Definition = { proof: Proof; path: string };
type Observation = { sourceId: string; raw: DateValue; path: string; ambiguous: boolean };
type Warn = (code: string, message: string, recordId: string | null, path: string) => void;

const roles = ['startDate', 'endDate'] as const;
const labels = { startDate: 'Start date', endDate: 'End date' };

export function jiraScheduleDateRole(title: string): Role | undefined {
  const name = title.trim().toLowerCase();
  return roles.find(role => name === labels[role].toLowerCase());
}

export function jiraDatePickerProof(type: string): Proof {
  if (!type.trim()) return null;
  return /^(?:com\.atlassian\.jira\.plugin\.system\.customfieldtypes:)?datepicker$/i.test(type.trim());
}

export function jiraRestDateProof(type: string, custom: string): Proof {
  if (!type.trim()) return jiraDatePickerProof(custom);
  return type.trim().toLowerCase() === 'date' && !/(?:^|:)(?:datetime|datetimepicker|textfield|textarea)$/i.test(custom.trim());
}

export class JiraDateProjection {
  private readonly definitions = { startDate: new Map<string, Definition>(), endDate: new Map<string, Definition>() };
  private readonly conflicts = new Map<Role, string>();
  private readonly observations = new Map<LegacyRecord, Partial<Record<Role, Observation>>>();

  constructor(private readonly warn: Warn) {}

  declare(role: Role, sourceId: string, proof: Proof, path: string): void {
    const fields = this.definitions[role];
    const before = fields.get(sourceId);
    if (before && before.proof !== null && proof !== null && before.proof !== proof) this.reject(role, path);
    if (!before || before.proof === null) fields.set(sourceId, { proof, path });
  }

  reject(role: Role, path: string): void {
    this.conflicts.set(role, path);
  }

  observe(row: LegacyRecord, role: Role, sourceId: string, raw: unknown, path: string, allowClear = false): void {
    const values = this.observations.get(row) ?? {};
    const value = typeof raw === 'string' ? raw.trim() : undefined;
    const validText = value !== undefined && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
    const scalar = raw === undefined || raw === null && allowClear || validText;
    values[role] = {
      sourceId, path, ambiguous: Boolean(values[role]) || !scalar,
      raw: validText && value ? value : allowClear && raw === null ? null : undefined,
    };
    this.observations.set(row, values);
  }

  apply(): void {
    const accepted = new Map<Role, string>();
    for (const role of roles) {
      const fields = this.definitions[role];
      const [definition] = fields;
      if (!definition) continue;
      const [sourceId, { proof, path }] = definition;
      const other = role === 'startDate' ? 'endDate' : 'startDate';
      if (fields.size > 1 || this.definitions[other].has(sourceId) || this.conflicts.has(role)) {
        this.warn('JIRA_PROJECTED_DATE_FIELD_AMBIGUOUS',
          `Jira ${labels[role]} 필드를 하나로 확인할 수 없어 이관 일정에 반영하지 않았습니다.`, null, this.conflicts.get(role) ?? path);
      } else if (proof === true) accepted.set(role, sourceId);
    }
    for (const [row, values] of this.observations) {
      const projected: Partial<Record<Role, string | null>> = {};
      const sources: Partial<Record<Role, string>> = {};
      for (const role of roles) {
        const value = values[role];
        if (!value || accepted.get(role) !== value.sourceId) continue;
        if (value.ambiguous) {
          this.warn('JIRA_PROJECTED_DATE_VALUE_AMBIGUOUS',
            `Jira ${labels[role]} 값 하나를 확인할 수 없어 원래 필드만 보관했습니다.`, row.id, value.path);
        } else if (value.raw !== undefined) {
          projected[role] = value.raw;
          sources[role] = value.sourceId;
        }
      }
      if (Object.keys(projected).length) {
        row.metadata.jiraProjectedDates = projected;
        row.metadata.jiraProjectedDateSources = sources;
      }
    }
  }
}
