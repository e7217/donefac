'use client';

import { useState } from 'react';
import { CalendarError, calculateWorkingDateRange, isCalendarDate, MAX_WORKING_DURATION_DAYS, type createCalendarMath } from '../../shared/calendar';
import './working-day-range-picker.css';

type Anchor = 'startDate' | 'endDate';
type DateRange = { startDate: string; endDate: string };
type Props = {
  calendarMath: ReturnType<typeof createCalendarMath>;
  startDate: string | null;
  endDate: string | null;
  onApply: (dates: DateRange) => void;
  disabled?: boolean;
};

export function WorkingDayRangePicker({ calendarMath, startDate, endDate, onApply, disabled }: Props) {
  const [selectedAnchor, setSelectedAnchor] = useState<Anchor | null>(null);
  const [input, setInput] = useState('');
  const anchor = selectedAnchor ?? (startDate || !endDate ? 'startDate' : 'endDate');
  const date = anchor === 'startDate' ? startDate : endDate;
  const validDate = isCalendarDate(date);
  const anchorLabel = anchor === 'startDate' ? '시작일' : '종료일';
  const oppositeLabel = anchor === 'startDate' ? '계산한 종료일' : '계산한 시작일';
  const duration = input.trim();
  const days = /^\d+$/u.test(duration) ? Number(duration) : NaN;
  let range: DateRange | undefined;
  let message = validDate ? '' : `기준 ${anchorLabel}을 입력해 주세요.`;
  if (validDate && duration) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_WORKING_DURATION_DAYS) {
      message = `근무일 수는 1~${MAX_WORKING_DURATION_DAYS.toLocaleString('ko-KR')} 사이의 정수로 입력해 주세요.`;
    } else {
      try { range = calculateWorkingDateRange(calendarMath, anchor, date, days); }
      catch (cause) {
        if (!(cause instanceof CalendarError)) throw cause;
        message = cause.message;
      }
    }
  }
  const nonworkingAnchor = validDate && !calendarMath.isWorking(date);
  const hasChange = range && (range.startDate !== startDate || range.endDate !== endDate);

  return <details className="working-day-range">
    <summary>근무일 기간 계산</summary>
    <div className="working-day-range-fields">
      <label>계산 기준<select className="field" value={anchor} disabled={disabled} onChange={event => {
        event.stopPropagation();
        setSelectedAnchor(event.currentTarget.value === 'endDate' ? 'endDate' : 'startDate');
      }}><option value="startDate">시작일</option><option value="endDate">종료일</option></select></label>
      <label>근무일 수<input className="field" type="text" inputMode="numeric" value={input} disabled={disabled}
        onChange={event => { event.stopPropagation(); setInput(event.currentTarget.value); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }} /></label>
    </div>
    <div className="working-day-range-result">
      {range && <output aria-label={oppositeLabel}>
        <span>{oppositeLabel}</span><strong>{anchor === 'startDate' ? range.endDate : range.startDate}</strong>
      </output>}
      <button type="button" className="btn" disabled={disabled || !hasChange} onClick={() => {
        if (!range) return;
        setSelectedAnchor(anchor);
        onApply(range);
      }}>
        날짜에 반영
      </button>
    </div>
    {message && <p className="working-day-range-message" role="status">{message}</p>}
    {nonworkingAnchor && <p className="working-day-range-message" role="status">기준 날짜는 비근무일입니다. 날짜는 유지하고 근무일 수에서 제외합니다.</p>}
  </details>;
}
