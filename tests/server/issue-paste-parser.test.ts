import assert from 'node:assert/strict';
import test from 'node:test';
import { ISSUE_PASTE_MAX_BYTES, ISSUE_PASTE_MAX_ROWS, parseIssuePaste } from '../../server/issue-paste-parser.js';

test('issue paste reads Korean Excel TSV, retaining quoted multiline descriptions and physical lines', () => {
  const header = ['제목', '설명', '유형', '상태', '우선순위', '담당자', '시작일', '종료일', '목표 마감일', '라벨'];
  const first = [
    ' 첫 업무 ', '"  첫 줄\r\n두 번째 ""설명""  "', ' 버그 ', ' 진행 중 ', '높음', '김 팀원',
    ' 2024-02-29 ', '2024-03-01', '2024-03-05', ' 일정, , 중요 ,',
  ];
  const second = ['후속 업무', '', '', '', '', '', '', '', '', ''];
  const result = parseIssuePaste([
    '\uFEFF', header.join('\t'), first.join('\t'), header.map(() => '').join('\t'), second.join('\t'), '',
  ].join('\r\n'));
  assert.deepEqual(result, {
    rows: [
      {
        line: 3, title: '첫 업무', description: '  첫 줄\r\n두 번째 "설명"  ',
        type: '버그', status: '진행 중', priority: '높음', assignee: '김 팀원',
        startDate: '2024-02-29', endDate: '2024-03-01', dueDate: '2024-03-05', labels: ['일정', '중요'],
      },
      { line: 6, title: '후속 업무' },
    ],
    errors: [],
  });
});

test('issue paste reads quoted CSV and case-insensitive header aliases', () => {
  const result = parseIssuePaste([
    '"Summary","Desc","ISSUE TYPE","State","Priority","assigned_to","Start Date","end-date","target due date","tags"',
    '"제목, ""개선""","설명\r두 번째 줄","task","in_progress","high","member@example.test","2026-11-19","","2026-11-21","설계, 검토"',
    '후속 업무,,,,,,,,,',
  ].join('\r'));
  assert.deepEqual(result, {
    rows: [
      {
        line: 2, title: '제목, "개선"', description: '설명\r두 번째 줄',
        type: 'task', status: 'in_progress', priority: 'high', assignee: 'member@example.test',
        startDate: '2026-11-19', dueDate: '2026-11-21', labels: ['설계', '검토'],
      },
      { line: 4, title: '후속 업무' },
    ],
    errors: [],
  });
});

test('issue paste supports a title-only column with either delimiter and keeps literal cell text', () => {
  for (const [input, title] of [
    ['제목\n제목에, 쉼표', '제목에, 쉼표'],
    ['TITLE\n제목에\t탭', '제목에\t탭'],
    ['"Issue Title"\n"제목에, 쉼표와\t탭"', '제목에, 쉼표와\t탭'],
    ['summary\n=표시할 내용', '=표시할 내용'],
  ]) {
    assert.deepEqual(parseIssuePaste(input), { rows: [{ line: 2, title }], errors: [] });
  }
});

test('issue paste rejects duplicate, blank, misspelled and missing headers', () => {
  for (const [input, message] of [
    ['\n제목,summary\n업무,제목', /제목 헤더가 중복/],
    ['\n제목,\n업무,', /2번째 열의 헤더가 비어/],
    ['\n제목,assigne\n업무,이름', /'assigne' 헤더를 인식할 수 없/],
    ['\n설명\n본문', /제목 헤더/],
  ] as const) {
    const result = parseIssuePaste(input);
    assert.deepEqual(result.rows, [], input);
    assert.equal(result.errors.length, 1, input);
    assert.equal(result.errors[0].line, 2, input);
    assert.match(result.errors[0].message, message, input);
  }
  assert.match(parseIssuePaste('제목\n\n').errors[0].message, /업무 행이 없습니다/);
});

test('issue paste accepts an empty key column and directs existing keys to Gantt', () => {
  for (const heading of ['업무 키', 'key', 'issueKey']) {
    const result = parseIssuePaste(`제목,${heading}\n업무,  \n기존 업무,TEAM-1`);
    assert.deepEqual(result.rows, [{ line: 2, title: '업무' }]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, 3);
    assert.match(result.errors[0].message, /간트/);
  }
  const exported = parseIssuePaste('"업무 키","프로젝트","제목","사이클"\r\n"TEAM-1","팀","기존 업무","파일럿"');
  assert.deepEqual(exported.rows, []);
  assert.deepEqual(exported.errors.map(error => error.line), [1, 2]);
  assert.match(exported.errors[0].message, /'프로젝트' 열은.*지원하지 않습니다/);
  assert.match(exported.errors[1].message, /간트/);
});

test('issue paste rejects invalid dates, missing titles and width mismatches at their physical rows', () => {
  const result = parseIssuePaste([
    '제목,시작일,종료일,목표 마감일',
    '"두\n줄",2024-02-29,2024-03-01,',
    ' ,2026-11-20,,',
    '날짜,2023-02-29,2026-11-19T00:00:00Z,11/20/2026',
    '열이 부족함,2026-11-20',
    '유효한 날짜,,, 2026-11-20 ',
  ].join('\n'));
  assert.deepEqual(result.rows, [
    { line: 2, title: '두\n줄', startDate: '2024-02-29', endDate: '2024-03-01' },
    { line: 7, title: '유효한 날짜', dueDate: '2026-11-20' },
  ]);
  assert.deepEqual(result.errors.map(error => error.line), [4, 5, 5, 5, 6]);
  assert.match(result.errors[0].message, /제목을 입력/);
  assert.match(result.errors[1].message, /시작일.*YYYY-MM-DD/);
  assert.match(result.errors[2].message, /종료일.*YYYY-MM-DD/);
  assert.match(result.errors[3].message, /목표 마감일.*YYYY-MM-DD/);
  assert.match(result.errors[4].message, /열 수/);
});

test('issue paste rejects whole input for invalid quotes or NUL and locates physical errors', () => {
  for (const [input, line, message] of [
    ['제목,설명\n업무,유효\n업무,"두\n줄"오류', 4, /따옴표 형식/],
    ['제목\t설명\r업무\t유효\r업무\t"닫히지\r않음', 3, /닫히지 않은 큰따옴표/],
    ['제목\r\n업무\r\n널\0문자', 3, /널 문자/],
  ] as const) {
    const result = parseIssuePaste(input);
    assert.deepEqual(result.rows, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, line);
    assert.match(result.errors[0].message, message);
  }
});

test('issue paste limits UTF-8 bytes and nonblank records separately', () => {
  const heading = 'title\n';
  const available = ISSUE_PASTE_MAX_BYTES - Buffer.byteLength(heading);
  const boundary = heading + '한'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
  assert.equal(Buffer.byteLength(boundary), ISSUE_PASTE_MAX_BYTES);
  assert.equal(parseIssuePaste(boundary).rows.length, 1);
  assert.match(parseIssuePaste(boundary + 'x').errors[0].message, /128 KiB/);
  assert.match(parseIssuePaste(null).errors[0].message, /문자열/);

  const issueRows = Array.from({ length: ISSUE_PASTE_MAX_ROWS }, (_, index) => `업무 ${index + 1}\n\n`).join('');
  assert.equal(parseIssuePaste(heading + issueRows).rows.length, ISSUE_PASTE_MAX_ROWS);
  const exceeded = parseIssuePaste(heading + issueRows + '초과 행');
  assert.deepEqual(exceeded.rows, []);
  assert.equal(exceeded.errors[0].line, 202);
  assert.match(exceeded.errors[0].message, /100행/);
});
