import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSchedulePaste } from '../../server/schedule-paste-parser.js';
import { formatIssueCsv } from '../../shared/issue-csv.js';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import type { Issue, PlanningItem, Project } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const stamp = '2026-11-01T00:00:00Z';
const project = (id: string, key: string, name: string): Project => ({ id, key, name, color: '#283756', description: '비공개 프로젝트 설명', createdAt: stamp });
const team = project('team-private-project-id', 'TEAM', '팀 프로젝트');
const ops = project('ops-private-project-id', 'OPS', '운영 프로젝트');
const assignee = { id: 'private-member-id', name: '담당 팀원', email: 'private@example.test', color: '#283756' };
const createIssue = (key: string, fields: Partial<Issue> = {}): Issue => ({
  id: `private-issue-id:${key}`, key, projectId: team.id, title: key, description: '비공개 업무 설명',
  type: 'internal-type-id', status: 'internal-status-id', priority: 'medium', assigneeId: assignee.id,
  collaboratorIds: ['private-collaborator-id'], parentId: 'private-parent-id', labels: [], startDate: null,
  endDate: null, dueDate: null, estimate: null, cycle: null, module: null, release: null,
  customFields: { privateField: '비공개 사용자 정의 속성' }, version: 42, createdAt: stamp,
  updatedAt: stamp, completedAt: null, ...fields,
});
const plan = (id: string, projectId: string, kind: PlanningItem['kind'], name: string): PlanningItem => ({
  id, projectId, kind, name, description: '비공개 계획 설명', status: 'active', ownerId: null,
  startDate: null, endDate: null, targetDate: null, version: 1, createdAt: stamp, updatedAt: stamp,
});
const data = {
  projects: [team, ops], users: [assignee],
  issueSchemas: [team, ops].map(item => ({ ...defaultIssueSchema(item.id), issueTypes: [
    { id: 'internal-type-id', name: item === team ? '기능 작업' : '점검 작업', color: '#283756', archived: false },
  ] })),
  workflows: [team, ops].map(item => ({ ...defaultWorkflow(item.id), statuses: [
    { id: 'internal-status-id', label: item === team ? '검증 중' : '점검 중', category: 'review' as const, color: '#283756' },
  ] })),
  planningItems: [
    plan('private-team-cycle-id', team.id, 'cycle', '현재 사이클'),
    plan('private-ops-module-id', ops.id, 'module', '다른 프로젝트 모듈'),
    plan('private-team-release-id', team.id, 'release', '정기 배포'),
  ],
};
const header = '\uFEFF"업무 키","프로젝트","제목","유형","상태","우선순위","담당자","시작일","종료일","목표 마감일","라벨","사이클","모듈","릴리스"\r\n';

test('formats supplied rows in order with project-specific names and excludes private record data', () => {
  const rows = [
    createIssue('OPS-2', { projectId: ops.id, title: '운영 업무', priority: 'high', assigneeId: 'deleted-member-id', moduleId: 'private-ops-module-id' }),
    createIssue('TEAM-9', { title: '핵심, 업무 "검증"', cycleId: 'private-team-cycle-id', cycle: '이전 사이클',
      moduleId: 'private-ops-module-id', module: '기존 모듈', releaseId: 'private-team-release-id', labels: ['검토', '한글'],
      startDate: '2026-12-01', endDate: '2026-12-04', dueDate: '2026-12-07' }),
    createIssue('TEAM-1', { type: 'deleted-type-id', status: 'deleted-status-id', assigneeId: null }),
  ];
  assert.equal(formatIssueCsv(data, rows),
    header
    + '"OPS-2","운영 프로젝트","운영 업무","점검 작업","점검 중","높음","","","","","","","다른 프로젝트 모듈",""\r\n'
    + '"TEAM-9","팀 프로젝트","핵심, 업무 ""검증""","기능 작업","검증 중","보통","담당 팀원","2026-12-01","2026-12-04","2026-12-07","검토, 한글","현재 사이클","기존 모듈","정기 배포"\r\n'
    + '"TEAM-1","팀 프로젝트","TEAM-1","알 수 없는 유형","알 수 없는 상태","보통","","","","","","","",""\r\n');
  assert.equal(formatIssueCsv(data, []), header);
});

test('keeps formula-like values as text and escapes quotes and physical lines within cells', () => {
  const triggers = ['=1+1', '+1', '-1', '−1', '@A1', '＝1', '＋1', '－1', '＠A1', ' \u0085\u200b\uFEFF=1', '\tplain', '\rplain', '\nplain', '\u0007plain'];
  const rows = triggers.map((title, index) => createIssue(`TEAM-${index + 1}`, { title }));
  const csv = formatIssueCsv({ ...data, projects: [{ ...team, name: '@팀' }], users: [{ ...assignee, name: '+동료' }] }, rows);
  for (const [index, title] of triggers.entries()) {
    assert.ok(csv.includes(`"TEAM-${index + 1}","'@팀","'${title}","기능 작업","검증 중","보통","'+동료"`));
  }
  const quoted = formatIssueCsv(data, [createIssue('TEAM-1', {
    title: '문장, "인용"\r\n=2+2', labels: ['=첫 라벨', '쉼표, 라벨'], release: '－단계',
  })]);
  assert.equal(quoted, header + '"TEAM-1","팀 프로젝트","문장, ""인용""\r\n=2+2","기능 작업","검증 중","보통","담당 팀원","","","","\'=첫 라벨, 쉼표, 라벨","","","\'－단계"\r\n');
});

test('accepts exported plan dates and goal deadlines in the schedule paste parser', () => {
  const csv = formatIssueCsv(data, [
    createIssue('TEAM-2', { title: '한글 "인용"\n다음 줄, 기호', startDate: '2026-12-01', endDate: '2026-12-02', dueDate: '2026-12-31' }),
    createIssue('TEAM-1', { title: '=1+1', endDate: '2026-12-03' }),
  ]);
  assert.deepEqual(parseSchedulePaste(csv), {
    rows: [
      { line: 2, key: 'TEAM-2', startDate: '2026-12-01', endDate: '2026-12-02', dueDate: '2026-12-31' },
      { line: 4, key: 'TEAM-1', startDate: undefined, endDate: '2026-12-03' },
    ],
    errors: [],
  });
});
