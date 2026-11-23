import assert from 'node:assert/strict';
import test from 'node:test';
import { ISSUE_PASTE_MAX_BYTES, ISSUE_PASTE_MAX_LINKS, ISSUE_PASTE_MAX_ROWS, normalizeIssuePasteKey, parseIssuePaste } from '../../server/issue-paste-parser.js';

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

test('issue paste parses forward references and multiple predecessor rules while retaining each created row', () => {
  const result = parseIssuePaste([
    '제목\t임시 키\t선행 업무\t연결 유형\t근무일 간격',
    '출시\tRelease\tnew:설계, team-21,NEW:REVIEW\tff,,ss\t+1,,-2',
    '설계\t설계\t\t\t',
    '검토\tReview\tTEAM-22, new:설계\tsf\t3650',
  ].join('\n'));
  assert.deepEqual(result, {
    rows: [
      { line: 2, title: '출시', localKey: 'Release', dependencies: [
        { predecessor: { kind: 'new', localKey: '설계' }, type: 'FF', lagDays: 1 },
        { predecessor: { kind: 'existing', key: 'team-21' }, type: 'FS', lagDays: 0 },
        { predecessor: { kind: 'new', localKey: 'REVIEW' }, type: 'SS', lagDays: -2 },
      ] },
      { line: 3, title: '설계', localKey: '설계' },
      { line: 4, title: '검토', localKey: 'Review', dependencies: [
        { predecessor: { kind: 'existing', key: 'TEAM-22' }, type: 'SF', lagDays: 3650 },
        { predecessor: { kind: 'new', localKey: '설계' }, type: 'SF', lagDays: 3650 },
      ] },
    ],
    errors: [],
  });
});

test('issue paste accepts quoted CSV predecessor lists and NFC-equivalent batch names', () => {
  const result = parseIssuePaste([
    'title,temp_key,predecessors,dependency types,lag days',
    '후행,,"new:CAFE\u0301, TEAM-9",,"-3650, -0"',
    '선행,Café,,,',
  ].join('\n'));
  assert.deepEqual(result, {
    rows: [
      { line: 2, title: '후행', dependencies: [
        { predecessor: { kind: 'new', localKey: 'CAFÉ' }, type: 'FS', lagDays: -3650 },
        { predecessor: { kind: 'existing', key: 'TEAM-9' }, type: 'FS', lagDays: 0 },
      ] },
      { line: 3, title: '선행', localKey: 'Café' },
    ],
    errors: [],
  });
  assert.equal(normalizeIssuePasteKey('Cafe\u0301'), normalizeIssuePasteKey('CAFÉ'));
});

test('issue paste rejects malformed and duplicate declarations and link cell values at physical lines', () => {
  const result = parseIssuePaste([
    '제목\t임시 키\t선행 업무\t연결 유형\t근무일 간격',
    '첫 선언\tPlan\t\t\t',
    '\t\t\t\t',
    '이름 충돌\tplan\t\t\t',
    '잘못된 임시 키\tnew:계획\t\t\t',
    '선행 누락\t\t\tFS\t',
    '빈 선행\t\tTEAM-1,\t\t',
    '중복 선행\t\tnew:plan, NEW:PLAN\t\t',
    '개수 불일치\t\tTEAM-1,TEAM-2,TEAM-3\tFS,SS\t0,1',
    '연결 해제 불가\t\tTEAM-1\t-\t',
    '간격 범위\t\tTEAM-1\tFS\t3651',
    '잘못된 새 선행\t\tnew:_plan\t\t',
    '기존 연결 중복\t\tTEAM-1, team-1\t\t',
  ].join('\n'));
  assert.deepEqual(result.rows, [{ line: 2, title: '첫 선언', localKey: 'Plan' }]);
  assert.deepEqual(result.errors.map(error => error.line), [4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 13]);
  assert.match(result.errors[0].message, /2번째 줄과 중복/);
  assert.match(result.errors[1].message, /임시 키/);
  assert.match(result.errors[2].message, /선행 업무를 지정/);
  assert.match(result.errors[3].message, /2번째/);
  assert.match(result.errors[4].message, /중복/);
  assert.match(result.errors[5].message, /연결 유형.*개수/);
  assert.match(result.errors[6].message, /근무일 간격.*개수/);
  assert.match(result.errors[7].message, /FS, SS, FF, SF/);
  assert.match(result.errors[8].message, /-3650~3650/);
  assert.match(result.errors[9].message, /new:.*임시 키/);
  assert.match(result.errors[10].message, /중복/);
});

test('issue paste identifies missing, self and cyclic local references using the relevant physical lines', () => {
  const result = parseIssuePaste([
    '제목\t임시 키\t선행 업무',
    '일부 없는 업무\t\tnew:누락,TEAM-77,new:d',
    '본인\tSelf\tnew:self',
    '작업 A\tA\tnew:b',
    '작업 B\tB\tnew:c',
    '작업 C\tC\tnew:a',
    '별개 업무\tD\tnew:a',
    '없는 업무\t\tnew:다른누락',
  ].join('\n'));
  assert.deepEqual(result.errors.map(error => error.line), [2, 3, 6, 8]);
  assert.match(result.errors[0].message, /누락.*찾을 수 없/);
  assert.match(result.errors[1].message, /자기 자신/);
  assert.match(result.errors[2].message, /순환 관계/);
  assert.match(result.errors[3].message, /다른누락.*찾을 수 없/);
  assert.deepEqual(result.rows[0].dependencies, [
    { predecessor: { kind: 'existing', key: 'TEAM-77' }, type: 'FS', lagDays: 0 },
    { predecessor: { kind: 'new', localKey: 'd' }, type: 'FS', lagDays: 0 },
  ]);
  assert.deepEqual(result.rows.at(-1), { line: 8, title: '없는 업무' });
});

test('issue paste bounds the combined number of declared predecessor links', () => {
  const keys = Array.from({ length: ISSUE_PASTE_MAX_LINKS }, (_, index) => `TEAM-${index + 1}`).join(',');
  const boundary = `제목\t선행 업무\n일정\t${keys}`;
  const valid = parseIssuePaste(boundary);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.rows[0].dependencies?.length, ISSUE_PASTE_MAX_LINKS);
  const exceeded = parseIssuePaste(`${boundary}\n다른 일정\tTEAM-1`);
  assert.deepEqual(exceeded.rows, []);
  assert.equal(exceeded.errors[0].line, 3);
  assert.match(exceeded.errors[0].message, /1,000개/);
});
