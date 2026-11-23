import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeliveryBlockerDraftContent } from '../../server/delivery-blocker-draft-content.js';
import { normalizeDocumentContent } from '../../server/document-content.js';
import { documentNodes } from '../../shared/document-references.js';
import type { DeliveryBlockerIssue, DeliveryBlockerReport, DeliveryBlockerRow, DeliveryScheduleConflict } from '../../shared/types.js';

const projectId = 'private-project-id';
const sourceHref = '#/private-project-id/reports?tab=blockers&view=private-view-id&reason=issue_block';

function issue(key: string, overrides: Partial<DeliveryBlockerIssue> = {}): DeliveryBlockerIssue {
  return {
    id: `private-${key}`, projectId, key, title: `업무 ${key}`, status: 'todo', assigneeId: 'private-user-id',
    statusLabel: '할 일', assigneeName: '팀원', version: 1, ...overrides,
  };
}

function row(target: DeliveryBlockerIssue, overrides: Partial<DeliveryBlockerRow> = {}): DeliveryBlockerRow {
  return {
    issue: target, priority: 'high', deadline: null, blockers: { total: 0, items: [] },
    scheduleConflicts: { total: 0, items: [] }, gitlab: { blockedMergeRequests: 0, failedPipelines: 0 },
    ...overrides,
  };
}

function report(overrides: Partial<DeliveryBlockerReport> = {}): DeliveryBlockerReport {
  return {
    projectId, generatedAt: '2026-11-20T09:10:20.123+09:00', revision: 'private-revision-token',
    savedView: null, reason: null, counts: { open: 0, affected: 0, reasons: { issue_block: 0, schedule_conflict: 0, gitlab: 0 } },
    total: 0, offset: 0, limit: 20, items: [], ...overrides,
  };
}

test('blocker draft preserves the reviewed scope, counts, display facts and cause examples as editable text', () => {
  const target = issue('TEAM-7', { title: '대상 <검토> & 확정', statusLabel: '검토 중', assigneeName: '이지현' });
  const next = issue('TEAM-8', { assigneeName: null });
  const causes = [{ ...issue('OTHER-2', { projectId: 'other-private-id' }), origin: 'jira' as const },
    issue('TEAM-1'), issue('TEAM-2'), issue('OMITTED-CAUSE')];
  const predecessor = [issue('OTHER-2', { projectId: 'other-private-id' }), issue('TEAM-3'), issue('TEAM-4'), issue('OMITTED-SCHEDULE')];
  const conflicts: DeliveryScheduleConflict[] = predecessor.map(value => ({
    predecessor: value, type: 'FF', lagDays: 2, endpoint: 'endDate',
    scheduledDate: '2026-11-25', requiredDate: '2026-11-28',
  }));
  const captured = report({
    savedView: { id: 'private-view-id', name: '이번 주 작업', version: 2 }, reason: 'issue_block',
    counts: { open: 5, affected: 4, reasons: { issue_block: 2, schedule_conflict: 3, gitlab: 1 } }, total: 2,
    items: [
      row(target, {
        deadline: { source: 'dueDate', value: '2026-11-30' }, blockers: { total: 6, items: causes },
        scheduleConflicts: { total: 7, items: conflicts }, gitlab: { blockedMergeRequests: 2, failedPipelines: 1 },
      }),
      row(next, { deadline: { source: 'endDate', value: '2026-12-01' }, blockers: { total: 1, items: [causes[0]] } }),
    ],
  });
  const before = structuredClone(captured);
  const draft = buildDeliveryBlockerDraftContent(captured, sourceHref);
  assert.deepEqual(captured, before);
  assert.deepEqual(buildDeliveryBlockerDraftContent(captured, sourceHref), draft);

  const nodes = [...documentNodes(normalizeDocumentContent(draft.content).content)];
  const prose = nodes.filter(node => node.type === 'text').map(node => node.text).join('\n');
  assert.match(prose, /보고서 기준 시각 2026-11-20 00:10:20\.123 UTC/);
  assert.match(prose, /보기 이번 주 작업 · 원인 업무 차단/);
  assert.match(prose, /미완료 업무 5개 · 차단된 업무 4개/);
  assert.match(prose, /업무 차단 2개 · 간트 일정 충돌 3개 · GitLab 조치 1개/);
  assert.match(prose, /선택한 조건에 해당하는 업무 2개 중 2개를 기록했습니다/);
  assert.match(prose, /TEAM-7 · 대상 <검토> & 확정\n상태 검토 중 · 담당자 이지현 · 우선순위 높음 · 목표 마감일 2026-11-30/);
  assert.match(prose, /TEAM-8 · 업무 TEAM-8\n상태 할 일 · 담당자 미지정 · 우선순위 높음 · 종료일 2026-12-01/);
  assert.match(prose, /업무 차단 6건[\s\S]*OTHER-2 · 업무 OTHER-2[^\n]*Jira 이관 관계[\s\S]*예시 외 3건/);
  assert.match(prose, /간트 일정 충돌 7건[\s\S]*완료 후 완료 \(FF\) · \+2근무일 · 종료일 2026-11-25 · 2026-11-28부터 가능[\s\S]*예시 외 4건/);
  assert.match(prose, /GitLab 조치 · 병합 확인이 필요한 MR 2건 · 실패한 파이프라인 1건/);
  assert.doesNotMatch(prose, /OMITTED-|private-/);
  const sourceLink = nodes.find(node => node.text === '진행 차단 보고서 열기');
  assert.equal(sourceLink?.marks?.[0].attrs?.href, sourceHref);
  assert.equal(sourceLink?.marks?.[0].attrs?.target, '_self');
  assert.match(prose, /진행 차단 보고서 열기\n \(현재 상태\)/);

  assert.deepEqual(draft.issueIds, [target, next, ...causes.slice(0, 3), ...predecessor.slice(1, 3)].map(value => value.id));
  assert.deepEqual(nodes.filter(node => node.type === 'issueReference').map(node => node.attrs?.issueId), draft.issueIds);
  assert.ok((draft.content.content?.findIndex(node => node.type === 'issueReference') ?? -1) >
    (draft.content.content?.findIndex(node => node.content?.[0].text === '관련 업무') ?? -1));
  assert.deepEqual(draft.content.content?.slice(-2), [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '회의 메모' }] }, { type: 'paragraph' },
  ]);
});

test('blocker draft retains the first 20 rows and reserves the first 20 references for unique targets', () => {
  const targets = Array.from({ length: 22 }, (_, index) => issue(`TEAM-${index + 1}`));
  const sources = Array.from({ length: 25 }, (_, index) => issue(`SOURCE-${index + 1}`));
  const items = targets.map((target, index) => row(target, {
    blockers: { total: 3, items: [targets[19], sources[index], sources[index + 1]] },
    scheduleConflicts: { total: 1, items: [{ predecessor: sources[index], type: 'SF', lagDays: -1,
      endpoint: 'endDate', scheduledDate: '2026-11-23', requiredDate: '2026-11-24' }] },
  }));
  const draft = buildDeliveryBlockerDraftContent(report({ items, total: 27 }), sourceHref);
  const nodes = [...documentNodes(normalizeDocumentContent(draft.content).content)];
  const rows = nodes.filter(node => node.type === 'heading' && node.attrs?.level === 3);
  assert.deepEqual(rows.map(node => node.content?.[0].text), targets.slice(0, 20).map(value => `${value.key} · ${value.title}`));
  assert.deepEqual(draft.issueIds, [...targets.slice(0, 20), ...sources.slice(0, 10)].map(value => value.id));
  assert.deepEqual(nodes.filter(node => node.type === 'issueReference').map(node => node.attrs?.issueId), draft.issueIds);
  assert.ok(nodes.some(node => node.text === '선택한 조건에 해당하는 업무 27개 중 20개를 기록했습니다.'));
  assert.ok(nodes.some(node => node.text === '초안에서 생략한 업무 7개'));
  assert.ok(nodes.some(node => node.text?.includes('SOURCE-20 · 업무 SOURCE-20')));
  assert.ok(nodes.some(node => node.text?.includes('시작 후 완료 (SF) · -1근무일')));
});

test('blocker draft with an empty report has an editable note and no references', () => {
  const result = buildDeliveryBlockerDraftContent(report(), sourceHref);
  const nodes = [...documentNodes(normalizeDocumentContent(result.content).content)];
  assert.deepEqual(result.issueIds, []);
  assert.ok(nodes.some(node => node.text === '보기 프로젝트 전체 · 원인 전체 원인'));
  assert.ok(nodes.some(node => node.text === '회의 메모'));
  assert.ok(!nodes.some(node => node.type === 'issueReference'));
});
