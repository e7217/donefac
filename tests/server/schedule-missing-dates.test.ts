import assert from 'node:assert/strict';
import test from 'node:test';
import { createCalendarMath, defaultWorkCalendar } from '../../shared/calendar.js';
import { suggestMissingScheduleDates, type MissingScheduleLink } from '../../shared/schedule-missing-dates.js';

const standardCalendar = defaultWorkCalendar('test');
const calendarMath = createCalendarMath({ ...standardCalendar, exceptions: [
  { date: '2026-11-25', label: '휴무', isWorking: false },
  { date: '2026-11-28', label: '추가 근무', isWorking: true },
] });
const allDays = createCalendarMath({ ...standardCalendar, workingWeekdays: [0, 1, 2, 3, 4, 5, 6] });
const defaults = { startDate: null, endDate: null, notBefore: '2026-11-23', workingDays: 3, calendarMath };

function link(role: MissingScheduleLink['role'], type: MissingScheduleLink['type'], lagDays: number,
  key: string, startDate: string | null, endDate: string | null): MissingScheduleLink {
  return { role, type, lagDays, other: { key, startDate, endDate } };
}

test('chooses the earliest exact workday span across stored relationship types and calendar exceptions', () => {
  const suggestion = suggestMissingScheduleDates({ ...defaults, links: [
    link('predecessor', 'FS', 1, 'TS-11', '2026-11-18', '2026-11-20'),
    link('predecessor', 'SS', 0, 'TS-12', '2026-11-23', '2026-11-24'),
    link('predecessor', 'FF', 1, 'TS-13', '2026-11-26', '2026-11-27'),
    link('predecessor', 'SF', 0, 'TS-14', '2026-11-24', null),
    link('successor', 'SS', 0, 'TS-15', '2026-11-26', null),
    link('successor', 'FS', -1, 'TS-16', '2026-11-28', null),
  ] });
  assert.deepEqual(suggestion, { dates: { startDate: '2026-11-26', endDate: '2026-11-28' }, pendingKeys: [], conflicts: [] });
});

test('retains a fixed date even when it falls on a nonworking day', () => {
  const fromStart = suggestMissingScheduleDates({ ...defaults, startDate: '2026-11-25', workingDays: 2, notBefore: '2026-12-15', links: [
    link('successor', 'SS', 0, 'TS-17', '2026-11-25', '2026-11-27'),
  ] });
  assert.deepEqual(fromStart, { dates: { startDate: '2026-11-25', endDate: '2026-11-27' }, pendingKeys: [], conflicts: [] });
  const fromEnd = suggestMissingScheduleDates({ ...defaults, endDate: '2026-11-29', workingDays: 2, notBefore: '2026-12-15', links: [
    link('predecessor', 'FF', 1, 'TS-18', '2026-11-25', '2026-11-27'),
  ] });
  assert.deepEqual(fromEnd, { dates: { startDate: '2026-11-27', endDate: '2026-11-29' }, pendingKeys: [], conflicts: [] });
});

test('rejects known ceilings and a range that would need to move a fixed date', () => {
  const successor = suggestMissingScheduleDates({ ...defaults, links: [
    link('successor', 'FF', 0, 'TS-19', null, '2026-11-24'),
  ] });
  assert.equal(successor.dates, null);
  assert.deepEqual(successor.pendingKeys, []);
  assert.match(successor.conflicts[0], /TS-19.*2026-11-24.*2026-11-26/);

  const fixed = suggestMissingScheduleDates({ ...defaults, endDate: '2026-11-27', links: [
    link('predecessor', 'FS', 0, 'TS-20', null, '2026-11-26'),
  ] });
  assert.equal(fixed.dates, null);
  assert.match(fixed.conflicts[0], /TS-20.*시작일.*2026-11-27/);
});

test('identifies only required unknown link endpoints and deduplicates the tickets', () => {
  const suggestion = suggestMissingScheduleDates({ ...defaults, links: [
    link('predecessor', 'FS', 0, 'TS-21', '2026-11-20', null),
    link('successor', 'FF', 0, 'TS-21', '2026-11-20', null),
    link('predecessor', 'SS', 0, 'TS-22', '2026-11-21', null),
    link('successor', 'SS', 0, 'TS-23', null, '2026-11-27'),
  ] });
  assert.deepEqual(suggestion, {
    dates: { startDate: '2026-11-23', endDate: '2026-11-26' }, pendingKeys: ['TS-21', 'TS-23'], conflicts: [],
  });
});

test('uses the first representable date for an outgoing negative lag and refuses calendar overflow', () => {
  const earliest = suggestMissingScheduleDates({ ...defaults, notBefore: '0000-01-01', workingDays: 2, calendarMath: allDays, links: [
    link('successor', 'FS', -3, 'TS-24', '0000-01-01', null),
  ] });
  assert.deepEqual(earliest, { dates: { startDate: '0000-01-02', endDate: '0000-01-03' }, pendingKeys: [], conflicts: [] });
  const underflow = suggestMissingScheduleDates({ ...defaults, endDate: '0000-01-02', workingDays: 2, calendarMath: allDays, links: [
    link('successor', 'FS', -3, 'TS-25', '0000-01-01', null),
  ] });
  assert.equal(underflow.dates, null);
  assert.match(underflow.conflicts[0], /TS-25.*날짜 범위/);
  const overflow = suggestMissingScheduleDates({ ...defaults, notBefore: '9999-12-31', calendarMath: allDays, links: [] });
  assert.equal(overflow.dates, null);
  assert.match(overflow.conflicts[0], /날짜 범위/);
});

test('requires working days for automatically filled endpoints even at a nonworking link boundary', () => {
  const suggestion = suggestMissingScheduleDates({ ...defaults, links: [
    link('predecessor', 'FF', 0, 'TS-26', null, '2026-11-29'),
    link('successor', 'FF', 0, 'TS-27', null, '2026-11-29'),
  ] });
  assert.equal(suggestion.dates, null);
  assert.match(suggestion.conflicts[0], /TS-27.*2026-11-29.*2026-11-30/);
});
