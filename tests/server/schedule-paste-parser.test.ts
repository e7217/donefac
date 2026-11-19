import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSchedulePaste,
  SCHEDULE_PASTE_MAX_BYTES,
  SCHEDULE_PASTE_MAX_ROWS,
} from '../../server/schedule-paste-parser.js';

test('Excel TSV preserves blank/clear semantics, BOM, physical lines and locale-independent key case', () => {
  const result = parseSchedulePaste('\uFEFF\r\n업무 키\t시작일\t종료일\t제목\r\n  proj-1  \t 2026-11-19 \t\t첫 번째\r\n\t\t\t\r\ni-2\t-\t2026-11-30\t두 번째\r\n');
  assert.deepEqual(result, {
    rows: [
      { line: 3, key: 'PROJ-1', startDate: '2026-11-19', endDate: undefined },
      { line: 5, key: 'I-2', startDate: null, endDate: '2026-11-30' },
    ],
    errors: [],
  });
});

test('RFC-style CSV handles quoted ignored commas, escaped quotes and multiline cells with physical line numbers', () => {
  const result = parseSchedulePaste('"Issue Key","Start Date","End Date","Notes"\r\n"p-1","2026-11-19","-","one, two\r\nthree ""quoted"""\r\n"p-2","","2026-11-23","last"\r\n');
  assert.deepEqual(result, {
    rows: [
      { line: 2, key: 'P-1', startDate: '2026-11-19', endDate: null },
      { line: 4, key: 'P-2', startDate: undefined, endDate: '2026-11-23' },
    ],
    errors: [],
  });
});

test('header aliases allow either date column and explicitly headed unrelated columns are ignored', () => {
  for (const key of ['업무 키', '티켓', 'issue key', 'key']) {
    for (const date of ['시작일', 'start date', 'startDate']) {
      assert.deepEqual(parseSchedulePaste(`${key}\t${date}\t기한\np-1\t2024-02-29\t2024/03/01`), {
        rows: [{ line: 2, key: 'P-1', startDate: '2024-02-29', endDate: undefined }], errors: [],
      });
    }
    for (const date of ['종료일', 'end date', 'endDate']) {
      assert.deepEqual(parseSchedulePaste(`${key},${date},ignored\np-1,-,not a date`), {
        rows: [{ line: 2, key: 'P-1', startDate: undefined, endDate: null }], errors: [],
      });
    }
  }
});

test('missing, empty, duplicate or ambiguous headers produce errors without guessing', () => {
  for (const input of [
    'P-1\t2026-11-19',
    'title\tstartDate\np-1\t2026-11-19',
    'key\ttitle\np-1\tname',
    'key\tstart date\t\np-1\t2026-11-19\t',
    'key\t티켓\tstartDate\np-1\tp-1\t2026-11-19',
    'key,startDate,시작일\np-1,2026-11-19,2026-11-20',
    'key,endDate,종료일\np-1,2026-11-19,2026-11-20',
    'key,start date,ignored\tkey\tend date\np-1,2026-11-19,text\tp-1\t2026-11-20',
  ]) {
    const result = parseSchedulePaste(input);
    assert.deepEqual(result.rows, [], input);
    assert.ok(result.errors.length, input);
    assert.equal(result.errors[0].line, 1, input);
  }
  assert.match(parseSchedulePaste('key\t티켓\tstartDate').errors[0].message, /중복/);
  assert.match(parseSchedulePaste('key,start date,ignored\tkey\tend date').errors[0].message, /모호/);
});

test('malformed quotes reject the whole selected format and report physical error lines', () => {
  for (const [input, line] of [
    ['key,startDate,notes\np-1,2026-11-19,valid\np-2,2026-11-20,bad"quote', 3],
    ['key,startDate,notes\np-1,2026-11-19,"closed"trailing', 2],
    ['key,startDate,notes\np-1,2026-11-19,"closed" ', 2],
    ['key\tstartDate\tnotes\r\np-1\t2026-11-19\t"never\r\nclosed', 2],
    ['key,startDate,notes\np-1,2026-11-19,"two\nlines"junk', 3],
  ] as const) {
    const result = parseSchedulePaste(input);
    assert.deepEqual(result.rows, [], input);
    assert.equal(result.errors.length, 1, input);
    assert.equal(result.errors[0].line, line, input);
    assert.match(result.errors[0].message, /따옴표/, input);
  }
});

test('only exact real ISO dates are accepted; local dates, Excel serials and timestamps are errors', () => {
  const values = ['2026-2-01', '2023-02-29', '2024-02-30', '2026-13-01', '11/19/2026', '19.11.2026', '46345', '2026-11-19T00:00:00Z', '－'];
  const result = parseSchedulePaste(`key\tstartDate\tendDate\n${values.map((value, index) => `p-${index + 1}\t${value}\t`).join('\n')}\np-valid\t0000-01-01\t9999-12-31\np-leap\t2024-02-29\t - `);
  assert.equal(result.errors.length, values.length);
  assert.deepEqual(result.errors.map(error => error.line), values.map((_, index) => index + 2));
  assert.deepEqual(result.errors.map(error => error.key), values.map((_, index) => `P-${index + 1}`));
  assert.deepEqual(result.rows, [
    { line: values.length + 2, key: 'P-VALID', startDate: '0000-01-01', endDate: '9999-12-31' },
    { line: values.length + 3, key: 'P-LEAP', startDate: '2024-02-29', endDate: null },
  ]);
});

test('wrong column counts and empty/control keys cannot shift cells or infer a third date', () => {
  const result = parseSchedulePaste('key\tstartDate\tendDate\np-1\t2026-11-19\np-2\t2026-11-19\t2026-11-20\t2026-11-21\n\t2026-11-19\t\n"p-\n3"\t2026-11-19\t\np-ok\t\t');
  assert.deepEqual(result.errors.map(error => error.line), [2, 3, 4, 5]);
  assert.match(result.errors[0].message, /열 수/);
  assert.match(result.errors[1].message, /열 수/);
  assert.deepEqual(result.rows, [{ line: 7, key: 'P-OK', startDate: undefined, endDate: undefined }]);
});

test('normalized duplicate keys name the second physical row and the first occurrence', () => {
  const result = parseSchedulePaste('key,endDate,notes\n p-1 ,2026-11-19,"two\nlines"\nP-1,-,again\np-2,,valid');
  assert.deepEqual(result.rows, [
    { line: 2, key: 'P-1', startDate: undefined, endDate: '2026-11-19' },
    { line: 5, key: 'P-2', startDate: undefined, endDate: undefined },
  ]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 4);
  assert.equal(result.errors[0].key, 'P-1');
  assert.match(result.errors[0].message, /2번째 줄/);
  // An invalid first date still reserves its key, rather than choosing a later row silently.
  assert.match(parseSchedulePaste('key,startDate\np-1,bad\nP-1,2026-11-19').errors[1].message, /중복/);
});

test('500 nonblank data rows are allowed, blank rows do not consume the limit and 501 rows fail explicitly', () => {
  const entries = Array.from({ length: SCHEDULE_PASTE_MAX_ROWS }, (_, index) => `p-${index + 1}\t2026-11-19`);
  const accepted = parseSchedulePaste(`key\tstartDate\n\n${entries.join('\n\t\n')}\n`);
  assert.equal(accepted.rows.length, SCHEDULE_PASTE_MAX_ROWS);
  assert.deepEqual(accepted.errors, []);
  const rejected = parseSchedulePaste(`key\tstartDate\n${[...entries, 'p-last\t2026-11-19'].join('\n')}`);
  assert.deepEqual(rejected.rows, []);
  assert.equal(rejected.errors[0].line, 502);
  assert.match(rejected.errors[0].message, /500행/);
});

test('128 KiB limit measures UTF-8 bytes including BOM; malformed input is returned as diagnostics', () => {
  const prefix = '\uFEFFkey,endDate,notes\r\np-1,-,';
  const padding = 'x'.repeat(SCHEDULE_PASTE_MAX_BYTES - Buffer.byteLength(prefix, 'utf8'));
  assert.equal(parseSchedulePaste(prefix + padding).rows.length, 1);
  for (const value of [prefix + padding + 'x', prefix + padding.slice(0, -1) + '가', '가'.repeat(SCHEDULE_PASTE_MAX_BYTES / 3 + 1)]) {
    const result = parseSchedulePaste(value);
    assert.deepEqual(result.rows, []);
    assert.match(result.errors[0].message, /128 KiB/);
    assert.equal(result.errors[0].line, null);
  }
  for (const value of [null, undefined, 42, {}, [], '', ' \r\n\t\n']) {
    const result = parseSchedulePaste(value);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.length);
  }
});
