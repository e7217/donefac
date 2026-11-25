import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SCHEDULE_BULK_DATE_ISSUES } from '../../shared/types.js';
import { parseGanttDateRangePaste } from '../../src/features/gantt-inline-date-paste.js';

test('a clipboard date rectangle retains row positions, blanks and explicit clears', () => {
  assert.deepEqual(parseGanttDateRangePaste('\uFEFF 2028-02-29\t2028-03-03\r\n\t\r\n\t-\r\n', 'startDate'), {
    rows: [{ startDate: '2028-02-29', endDate: '2028-03-03' }, {}, { endDate: null }],
  });
  assert.deepEqual(parseGanttDateRangePaste('2027-03-10\r-\r', 'endDate'), { rows: [{ endDate: '2027-03-10' }, { endDate: null }] });
  assert.equal(parseGanttDateRangePaste('2027-03-10\t2027-03-11\r\n', 'startDate'), null);
});

test('clipboard rectangles reject invalid ISO days, ragged rows, excess columns, and too many rows', () => {
  for (const [text, field, message] of [
    ['2027-03-10\t2027-03-11\n2027-02-29\t', 'startDate', /2행 1열.*YYYY-MM-DD/u],
    ['2027-03-10\t\n2027-03-11', 'startDate', /2행의 열 수/u],
    ['2027-03-10\t2027-03-11\n\t', 'endDate', /시작일 칸/u],
    ['2027-03-10\t\t\n\t\t', 'startDate', /날짜 한 열/u],
    [Array(MAX_SCHEDULE_BULK_DATE_ISSUES + 1).fill('2027-03-10').join('\n'), 'startDate', /최대 100행/u],
  ] as const) {
    const parsed = parseGanttDateRangePaste(text, field);
    assert.ok(parsed && 'error' in parsed);
    assert.match(parsed.error, message);
  }
  const exact = parseGanttDateRangePaste(Array(MAX_SCHEDULE_BULK_DATE_ISSUES).fill('2027-03-10').join('\n'), 'startDate');
  assert.ok(exact && 'rows' in exact);
  assert.equal(exact.rows.length, MAX_SCHEDULE_BULK_DATE_ISSUES);
});
