import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGanttMonthCalendar, ganttCalendarWeekday, shiftGanttCalendarDay, shiftGanttCalendarMonth } from '../../shared/gantt-month-calendar.js';
import type { Issue, Milestone } from '../../shared/types.js';

test('monthly Gantt dates use Monday-first Gregorian months and respect both supported year boundaries', () => {
  const leap = buildGanttMonthCalendar('2028-02-29', [], []);
  assert.equal(leap.leading, 1);
  assert.equal(leap.days.length, 29);
  assert.equal(leap.days.at(-1), '2028-02-29');
  assert.equal(ganttCalendarWeekday('2028-02-29'), 1);
  assert.equal(buildGanttMonthCalendar('2100-02-01', [], []).days.length, 28);
  assert.equal(buildGanttMonthCalendar('0000-02-01', [], []).days.length, 29);
  assert.equal(buildGanttMonthCalendar('9999-12-31', [], []).days.at(-1), '9999-12-31');
  assert.equal(shiftGanttCalendarDay('2028-02-29', 1), '2028-03-01');
  assert.equal(shiftGanttCalendarDay('0000-01-01', -1), '0000-01-01');
  assert.equal(shiftGanttCalendarDay('9999-12-31', 1), '9999-12-31');
  assert.equal(shiftGanttCalendarMonth('2028-01-31', 1), '2028-02-29');
  assert.equal(shiftGanttCalendarMonth('2028-12-31', 1), '2029-01-31');
  assert.equal(shiftGanttCalendarMonth('0000-01-01', -1), null);
  assert.equal(shiftGanttCalendarMonth('9999-12-31', 1), null);
});

test('monthly Gantt agenda groups one issue per day and keeps distinct saved dates and milestone entries', () => {
  const first = { id: 'issue-1', startDate: '2028-01-31', endDate: '2028-02-29', dueDate: '2028-02-29' } as Issue;
  const second = { id: 'issue-2', startDate: null, endDate: null, dueDate: '2028-02-28' } as Issue;
  const third = { id: 'issue-3', startDate: '2028-02-01', endDate: '2028-03-01', dueDate: null } as Issue;
  const milestone = { id: 'milestone', date: '2028-02-29' } as Milestone;
  const marchMilestone = { id: 'other-milestone', date: '2028-03-01' } as Milestone;
  const { entries } = buildGanttMonthCalendar('2028-02-01', [first, second, third], [milestone, marchMilestone]);
  assert.deepEqual(entries.get('2028-02-29'), [
    { kind: 'issue', issue: first, fields: ['endDate', 'dueDate'] },
    { kind: 'milestone', milestone },
  ]);
  assert.deepEqual(entries.get('2028-02-28'), [{ kind: 'issue', issue: second, fields: ['dueDate'] }]);
  assert.deepEqual(entries.get('2028-02-01'), [{ kind: 'issue', issue: third, fields: ['startDate'] }]);
  assert.deepEqual(entries.get('2028-02-05'), []);
  assert.equal(entries.has('2028-01-31'), false);
  assert.equal(entries.has('2028-03-01'), false);
});
