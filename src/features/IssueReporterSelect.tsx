'use client';

import type { Issue, User } from '../../shared/types';

const memberPrefix = 'member:';

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
