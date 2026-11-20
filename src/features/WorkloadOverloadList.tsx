'use client';

import { useId, useMemo, useState } from 'react';
import type { ProjectWorkloadRow, User } from '../../shared/types';
import { formatWorklogMinutes } from '../lib/worklogs';
import './workload-overload-list.css';

const PAGE_SIZE = 8;
const countFormat = new Intl.NumberFormat('ko-KR');
const nameOrder = new Intl.Collator('ko');

type OverloadSelection = { userId: string; date: string };
type Props = {
  rows: readonly ProjectWorkloadRow[];
  users: ReadonlyMap<string, User>;
  selected: OverloadSelection | null;
  onSelect: (value: OverloadSelection, opener: HTMLButtonElement) => void;
};

export function WorkloadOverloadList({ rows, users, selected, onSelect }: Props) {
  const heading = useId();
  const [page, setPage] = useState(0);
  const overloads = useMemo(() => {
    const entries: Array<OverloadSelection & { name: string; excess: number }> = [];
    for (const row of rows) {
      const user = users.get(row.userId);
      if (!user) continue;
      for (const day of row.days) {
        const excess = day.scheduledMinutes - day.availableMinutes;
        if (excess > 0) entries.push({ userId: row.userId, date: day.date, name: user.name, excess });
      }
    }
    return entries.sort((a, b) => b.excess - a.excess || a.date.localeCompare(b.date) ||
      nameOrder.compare(a.name, b.name) || a.userId.localeCompare(b.userId));
  }, [rows, users]);

  if (overloads.length === 0) return null;
  const lastPage = Math.ceil(overloads.length / PAGE_SIZE) - 1;
  const currentPage = Math.min(page, lastPage);
  const first = currentPage * PAGE_SIZE;
  const last = Math.min(first + PAGE_SIZE, overloads.length);

  return <section className="workload-overload-list" aria-labelledby={heading}>
    <div className="workload-section-heading">
      <h3 id={heading}>초과 일정</h3>
      <span className="workload-overload-count">{countFormat.format(overloads.length)}건</span>
    </div>
    <ul role="list">
      {overloads.slice(first, last).map(({ userId, date, name, excess }) => {
        const formattedExcess = formatWorklogMinutes(excess);
        return <li key={`${userId}:${date}`}>
          <button className="workload-overload-entry" type="button"
            aria-label={`${date} ${name} 초과 ${formattedExcess}`}
            aria-pressed={selected?.userId === userId && selected.date === date}
            onClick={event => onSelect({ userId, date }, event.currentTarget)}>
            <time dateTime={date}>{date}</time>
            <strong>{name}</strong>
            <span>초과 {formattedExcess}</span>
          </button>
        </li>;
      })}
    </ul>
    {lastPage > 0 && <div className="workload-page-actions" role="group" aria-label="초과 일정 페이지">
      <span aria-live="polite">{countFormat.format(first + 1)}~{countFormat.format(last)}</span>
      <button className="btn btn-ghost" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</button>
      <button className="btn btn-ghost" type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>다음</button>
    </div>}
  </section>;
}
