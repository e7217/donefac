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

test('dependency-only and mixed date sheets preserve blank fields and normalize relationship choices', () => {
  for (const header of ['선행 업무', 'predecessor', 'Predecessor Key']) {
    assert.deepEqual(parseSchedulePaste(`업무 키\t${header}\n p-2 \t p-1 `), {
      rows: [{ line: 2, key: 'P-2', startDate: undefined, endDate: undefined, dependency: { predecessorKey: 'P-1' } }],
      errors: [],
    });
  }
  assert.deepEqual(parseSchedulePaste([
    'key,start date,종료일,predecessor key,dependency type,근무일 간격',
    ' p-2 ,2026-11-19,,p-1, ss ,-3650',
    'p-3,,-,p-2,ff,+3650',
    'p-4,,,p-3, SF ,',
    'p-5,,,p-4,,-0',
    'p-6,,,p-5,-,',
    'p-7,,2026-11-20,,,',
    'p-8,,,p-7,fs,0',
  ].join('\n')), {
    rows: [
      { line: 2, key: 'P-2', startDate: '2026-11-19', endDate: undefined, dependency: { predecessorKey: 'P-1', type: 'SS', lagDays: -3650 } },
      { line: 3, key: 'P-3', startDate: undefined, endDate: null, dependency: { predecessorKey: 'P-2', type: 'FF', lagDays: 3650 } },
      { line: 4, key: 'P-4', startDate: undefined, endDate: undefined, dependency: { predecessorKey: 'P-3', type: 'SF' } },
      { line: 5, key: 'P-5', startDate: undefined, endDate: undefined, dependency: { predecessorKey: 'P-4', lagDays: 0 } },
      { line: 6, key: 'P-6', startDate: undefined, endDate: undefined, dependency: { predecessorKey: 'P-5', type: '-' } },
      { line: 7, key: 'P-7', startDate: undefined, endDate: '2026-11-20' },
      { line: 8, key: 'P-8', startDate: undefined, endDate: undefined, dependency: { predecessorKey: 'P-7', type: 'FS', lagDays: 0 } },
    ],
    errors: [],
  });
});

test('relationship diagnostics preserve physical rows and reject fields without a predecessor', () => {
  const result = parseSchedulePaste([
    'key,startDate,선행 업무,연결 유형,lag days',
    'p-2,,,FS,',
    'p-3,,,,0',
    'p-4,,p-1,FS+1,',
    'p-5,,p-1,-,1',
    'p-6,,p-1,,3651',
    'p-7,,p-1,,-3651',
    'p-8,,p-1,,1.0',
    'p-9,,p-1,,1e2',
    'p-10,,"p-\n1",,',
    'p-11,,p-1,,1',
    'P-11,,p-2,,1',
  ].join('\n'));
  assert.deepEqual(result.errors.map(error => error.line), [2, 3, 4, 5, 6, 7, 8, 9, 10, 13]);
  assert.match(result.errors[0].message, /선행 업무 키를 지정/);
  assert.match(result.errors[1].message, /선행 업무 키를 지정/);
  assert.match(result.errors[2].message, /연결 유형/);
  assert.match(result.errors[3].message, /간격을 비워/);
  for (const error of result.errors.slice(4, 8)) assert.match(error.message, /정수/);
  assert.match(result.errors[8].message, /제어 문자/);
  assert.match(result.errors[9].message, /12번째 줄/);
  assert.deepEqual(result.rows, [
    { line: 12, key: 'P-11', startDate: undefined, endDate: undefined, dependency: { predecessorKey: 'P-1', lagDays: 1 } },
  ]);
  assert.match(parseSchedulePaste('key,startDate,dependency type\np-1,2026-11-19,FS').errors[0].message, /선행 업무 키를 지정/);
  assert.match(parseSchedulePaste('key,predecessor,선행 업무\np-2,p-1,p-1').errors[0].message, /선행 업무 헤더가 중복/);
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
