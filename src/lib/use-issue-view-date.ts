'use client';

import { useEffect, useState } from 'react';
import { MAX_CALENDAR_DATE, calendarDate, calendarDay } from '../../shared/calendar';
import { issueViewToday } from '../../shared/issue-view';
import { reservationInstant } from '../../shared/time-reservations';

/** A saved rolling view stays current even when its tab is open across Seoul midnight. */
export function useIssueViewDate(enabled: boolean): string | undefined {
  const [today, setToday] = useState(() => enabled ? issueViewToday() : undefined);
  useEffect(() => {
    if (!enabled) return;
    let timer: number;
    const update = () => {
      window.clearTimeout(timer);
      const date = issueViewToday();
      setToday(date);
      if (date === MAX_CALENDAR_DATE) return;
      const next = calendarDate(calendarDay(date) + 1);
      const midnight = reservationInstant(`${next}T00:00`);
      if (midnight) timer = window.setTimeout(update, Math.max(1, Date.parse(midnight) - Date.now()));
    };
    timer = window.setTimeout(update, 0);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [enabled]);
  return enabled ? today : undefined;
}
