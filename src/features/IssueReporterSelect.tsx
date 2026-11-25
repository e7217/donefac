'use client';

import type { Issue, IssueViewReporterFilter, User } from '../../shared/types';

const memberPrefix = 'member:';
const reporterKinds = { 'current-user': '현재 사용자', unset: '미지정', unknown: '기록 없음' } as const;

function reporterMemberLabel(user: User, users: readonly User[]) {
  return users.some(other => other.id !== user.id && other.name === user.name) ? `${user.name} (${user.email})` : user.name;
}

export function issueReporterFilterLabel(filter: IssueViewReporterFilter, users: readonly User[]) {
  if (filter.kind !== 'member') return `요청자 · ${reporterKinds[filter.kind]}`;
  const user = users.find(candidate => candidate.id === filter.memberId);
  return `요청자 · ${user?.name ?? '현재 팀원 없음'}`;
}

export function IssueReporterFilterSelect({ filter, users, disabled, onChange }: {
  filter: IssueViewReporterFilter | undefined;
  users: readonly User[];
  disabled?: boolean;
  onChange: (filter: IssueViewReporterFilter | undefined) => void;
}) {
  const selected = filter?.kind === 'member' ? `${memberPrefix}${filter.memberId}` : filter?.kind ?? '';
  const missingMember = filter?.kind === 'member' && !users.some(user => user.id === filter.memberId);
  return <label className="issue-filter-select issue-reporter-filter">
    {filter && <span aria-hidden="true">요청자</span>}
    <select aria-label="요청자 필터" value={selected} disabled={disabled} onChange={event => {
      const next = event.currentTarget.value;
      if (next.startsWith(memberPrefix)) onChange({ kind: 'member', memberId: next.slice(memberPrefix.length) });
      else if (next === 'current-user' || next === 'unset' || next === 'unknown') onChange({ kind: next });
      else onChange(undefined);
    }}>
      <option value="">전체 요청자</option>
      <option value="current-user">{reporterKinds['current-user']}</option>
      <option value="unset">{reporterKinds.unset}</option>
      <option value="unknown">{reporterKinds.unknown}</option>
      {missingMember && <option value={selected} disabled>현재 팀원 없음</option>}
      {users.map(user => <option key={user.id} value={`${memberPrefix}${user.id}`}>{reporterMemberLabel(user, users)}</option>)}
    </select>
  </label>;
}

export function IssueReporterSelect({ value, users, onChange, ariaLabel = '요청자' }: {
  value: Issue['reporterId'];
  users: readonly User[];
  onChange: (reporterId: string | null) => void;
  ariaLabel?: string;
}) {
  const selected = value === undefined ? 'unknown' : value === null ? '' : `${memberPrefix}${value}`;
  const missingMember = typeof value === 'string' && !users.some(user => user.id === value);
  return <select className="field" aria-label={ariaLabel} value={selected} onChange={event => {
    const next = event.currentTarget.value;
    if (next === '') onChange(null);
    else if (next.startsWith(memberPrefix)) onChange(next.slice(memberPrefix.length));
  }}>
    {value === undefined && <option value="unknown" disabled>확인되지 않음</option>}
    <option value="">미지정</option>
    {missingMember && <option value={selected} disabled>현재 팀원 없음</option>}
    {users.map(user => <option key={user.id} value={`${memberPrefix}${user.id}`}>{user.name}</option>)}
  </select>;
}
