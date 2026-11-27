'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, FlaskConical, Plus, RefreshCw, Save, Trash2, UserRoundCheck, X } from 'lucide-react';
import type {
  FeatureProps,
  IssueAssignmentOutcome,
  IssueAssignmentPreview,
  IssueAssignmentRule,
  IssueAssignmentRuleInput,
  IssueAssignmentRunPage,
} from '../../shared/types';
import { issueTypeMeta, projectIssueTypes } from '../../shared/issue-schema';
import { projectStatuses, statusMeta } from '../../shared/workflow-helpers';
import { ApiError, api } from '../lib/api';
import { afterAcceptedNavigation, isSettingsSectionNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './automation-settings.css';
import './issue-assignment-rules.css';

const PAGE_SIZE = 20;
const PREVIEW_LIMIT = 50;
const DEFAULT_RULE: IssueAssignmentRuleInput = {
  name: '',
  enabled: false,
  fromStatuses: [],
  toStatusId: '',
  issueTypes: [],
  assigneeId: '',
  mode: 'unassigned',
  priority: 100,
};
const MODE_LABELS = { unassigned: '담당자 미지정 업무만 배정', replace: '기존 담당자 교체' };
const OUTCOME_LABELS = { assigned: '배정됨', unchanged: '유지됨', skipped: '건너뜀', blocked: '전환 불가' };
const OUTCOME_CLASSES = { assigned: 'is-changed', unchanged: '', skipped: 'is-ignored', blocked: 'is-blocked' };
const formatRunDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
type Editor = { rule: IssueAssignmentRule | null; draft: IssueAssignmentRuleInput };

function ruleInput(rule: IssueAssignmentRule): IssueAssignmentRuleInput {
  const { name, enabled, fromStatuses, toStatusId, issueTypes, assigneeId, mode, priority } = rule;
  return { name, enabled, fromStatuses, toStatusId, issueTypes, assigneeId, mode, priority };
}

function toggleChoice(items: string[], id: string, checked: boolean) {
  return checked ? [...items, id] : items.filter(item => item !== id);
}

function OutcomeBadge({ outcome, preview = false }: { outcome: IssueAssignmentOutcome['outcome']; preview?: boolean }) {
  return <span className={`automation-outcome ${OUTCOME_CLASSES[outcome]}`}>
    {preview && outcome === 'assigned' ? '배정 예정' : OUTCOME_LABELS[outcome]}
  </span>;
}

export function IssueAssignmentRules(props: FeatureProps) {
  if (!props.data.projects.some(project => project.id === props.projectId)) return null;
  return <ProjectAssignmentRules key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectAssignmentRules({ data, projectId, actorId, notify, openIssue }: FeatureProps) {
  const [rules, setRules] = useState<IssueAssignmentRule[]>([]);
  const [runs, setRuns] = useState<IssueAssignmentRunPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewIssueIds, setPreviewIssueIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<IssueAssignmentOutcome[] | null>(null);
  const listing = useRef<AbortController | null>(null);
  const pending = useRef<AbortController | null>(null);

  const path = `/projects/${encodeURIComponent(projectId)}`;
  const statuses = projectStatuses(data, projectId);
  const issueTypes = projectIssueTypes(data, projectId, { includeArchived: true });
  const projectIssues = data.issues.filter(issue => issue.projectId === projectId);
  const projectIssueIds = new Set(projectIssues.map(issue => issue.id));
  const selectedIssues = previewIssueIds.filter(id => projectIssueIds.has(id));
  const dirty = editor !== null && (
    JSON.stringify(editor.draft) !== JSON.stringify(editor.rule ? ruleInput(editor.rule) : DEFAULT_RULE)
    || selectedIssues.length > 0
    || preview !== null
  );
  const statusLabel = (id: string) => statusMeta(data, projectId, id).label;
  const memberLabel = (id: string | null) => id ? data.users.find(user => user.id === id)?.name ?? `팀원 ${id}` : '미지정';
  const assigneeChange = (outcome: IssueAssignmentOutcome) =>
    `${memberLabel(outcome.previousAssigneeId)} → ${memberLabel(outcome.assigneeId)}`;

  const request = useCallback(<T,>(suffix: string, options: RequestInit = {}) => {
    return api<T>(`${path}${suffix}`, { ...options, headers: { 'X-Actor-Id': actorId } });
  }, [actorId, path]);

  const load = useCallback(async (offset = 0) => {
    listing.current?.abort();
    const controller = new AbortController();
    listing.current = controller;
    setLoading(true);
    setLoadError('');
    try {
      const [latestRules, latestRuns] = await Promise.all([
        request<IssueAssignmentRule[]>('/assignment-rules', { signal: controller.signal }),
        request<IssueAssignmentRunPage>(`/assignment-runs?offset=${offset}&limit=${PAGE_SIZE}`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      setRules(latestRules);
      setRuns(latestRuns);
    } catch (err) {
      if (!controller.signal.aborted) setLoadError(errorMessage(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [request]);

  const resetEditor = useCallback((rule?: IssueAssignmentRule | null) => {
    setEditor(rule === undefined ? null : { rule, draft: rule ? ruleInput(rule) : DEFAULT_RULE });
    setPreviewIssueIds([]);
    setPreview(null);
    setConflict(false);
    setError('');
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(initial);
      listing.current?.abort();
    };
  }, [data.issues, load]);

  useEffect(() => {
    const imported = () => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      resetEditor();
      setRules([]);
      setRuns(null);
      void load();
    };
    window.addEventListener('donefac:workspace-imported', imported);
    return () => {
      pending.current?.abort();
      window.removeEventListener('donefac:workspace-imported', imported);
    };
  }, [load, resetEditor]);

  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('담당자 배정 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if (isSettingsSectionNavigation(event)) {
        return;
      } else if (dirty) {
        if (window.confirm('작성 중인 배정 규칙과 미리보기를 버리고 이동할까요?')) {
          afterAcceptedNavigation(event, resetEditor);
        } else {
          event.preventDefault();
        }
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!pending.current && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('donefac:navigate', navigate);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('donefac:navigate', navigate);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [dirty, notify, resetEditor]);

  function switchEditor(rule?: IssueAssignmentRule | null) {
    if (pending.current || (dirty && !window.confirm('작성 중인 배정 규칙과 미리보기를 버릴까요?'))) return;
    resetEditor(rule);
  }

  function updateDraft(changes: Partial<IssueAssignmentRuleInput>) {
    setEditor(current => current && { ...current, draft: { ...current.draft, ...changes } });
    setPreview(null);
  }

  function validateDraft(draft: IssueAssignmentRuleInput) {
    if (!draft.name.trim()) return '규칙 이름을 입력해 주세요.';
    if (!draft.toStatusId || !draft.assigneeId) {
      return '도착 상태와 배정할 팀원을 선택해 주세요.';
    }
    if (!Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 10000) {
      return '우선순위를 0에서 10000 사이의 정수로 입력해 주세요.';
    }
    return '';
  }

  async function execute(task: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      await task(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        void load(runs?.offset);
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const { rule, draft } = editor;
    const validation = validateDraft(draft);
    if (validation) {
      setError(validation);
      return;
    }
    await execute(async signal => {
      const saved = await request<IssueAssignmentRule>(
        rule ? `/assignment-rules/${encodeURIComponent(rule.id)}` : '/assignment-rules',
        { signal, method: rule ? 'PATCH' : 'POST', body: JSON.stringify({ ...draft, expectedVersion: rule?.version }) },
      );
      if (signal.aborted) return;
      resetEditor(saved);
      setRules(current => [...current.filter(item => item.id !== saved.id), saved]);
      notify('담당자 배정 규칙을 저장했습니다.');
      void load(runs?.offset);
    });
  }

  async function removeRule(rule: IssueAssignmentRule) {
    if (pending.current || !window.confirm(`‘${rule.name}’ 배정 규칙을 삭제할까요?`)) return;
    await execute(async signal => {
      await request<void>(`/assignment-rules/${encodeURIComponent(rule.id)}?expectedVersion=${rule.version}`, { signal, method: 'DELETE' });
      if (signal.aborted) return;
      resetEditor();
      setRules(current => current.filter(item => item.id !== rule.id));
      notify('담당자 배정 규칙을 삭제했습니다.');
      void load(runs?.offset);
    });
  }

  async function runPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !selectedIssues.length) return;
    const validation = validateDraft(editor.draft);
    if (validation) {
      setError(validation);
      return;
    }
    setPreview(null);
    await execute(async signal => {
      const result = await request<IssueAssignmentPreview>('/assignment-rules/preview', {
        signal,
        method: 'POST',
        body: JSON.stringify({ rule: editor.draft, issueIds: selectedIssues }),
      });
      if (!signal.aborted) setPreview(result.outcomes);
    });
  }

  const activeRule = editor?.rule;
  const remoteRule = activeRule && rules.find(rule => rule.id === activeRule.id);
  const remoteChanged = Boolean(activeRule && (!remoteRule || remoteRule.version !== activeRule.version));
  const draft = editor?.draft;
  const sourceOptions = statuses.map(({ id, label }) => ({ id, label }));
  const typeOptions = issueTypes.map(type => ({ id: type.id, label: type.archived ? `${type.name} (보관됨)` : type.name }));
  for (const id of draft?.fromStatuses ?? []) {
    if (!statuses.some(status => status.id === id)) sourceOptions.push({ id, label: `${id} (삭제됨)` });
  }
  for (const id of draft?.issueTypes ?? []) {
    if (!issueTypes.some(type => type.id === id)) typeOptions.push({ id, label: `${id} (삭제됨)` });
  }
  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  return <section className="card automation-settings assignment-settings" aria-label="상태별 담당자 자동 배정">
    <header>
      <div>
        <h2><UserRoundCheck size={21} />상태별 담당자 자동 배정</h2>
        <p>업무의 상태가 바뀔 때 조건에 맞는 팀원을 배정합니다.</p>
      </div>
      <div className="automation-card-actions">
        <button type="button" className="btn btn-ghost" aria-label="담당자 배정 새로고침" disabled={busy || loading} onClick={() => void load()}>
          <RefreshCw size={16} />새로고침
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => switchEditor(null)}>
          <Plus size={16} />배정 규칙 만들기
        </button>
      </div>
    </header>
    <p className="automation-policy">직접 전환하거나 보드, API, GitLab에서 상태를 바꿀 때 적용됩니다. 조건에 맞는 활성 규칙은 우선순위 숫자가 낮은 순서로 확인하고 첫 규칙에서 처리를 마칩니다. 상태와 함께 담당자를 직접 지정하거나 비우면 그 입력을 적용합니다.</p>
    {loadError && <p role="alert" className="automation-error">{loadError}</p>}
    <div className="automation-rule-list" aria-label="담당자 배정 규칙">
      {sortedRules.map(rule => <button key={rule.id} type="button" className={`automation-rule-card${activeRule?.id === rule.id ? ' is-selected' : ''}`}
        aria-pressed={activeRule?.id === rule.id} disabled={busy} onClick={() => {
          if (activeRule?.id !== rule.id) switchEditor(rule);
        }}>
        <span className={`automation-state${rule.enabled ? ' is-enabled' : ''}`}>{rule.enabled ? '활성' : '비활성'}</span>
        <strong>{rule.name}</strong>
        <span>{rule.fromStatuses.map(statusLabel).join(', ') || '모든 출발 상태'} → {statusLabel(rule.toStatusId)}</span>
        <span>{rule.issueTypes.map(id => issueTypeMeta(data, projectId, id).name).join(', ') || '모든 업무 유형'}</span>
        <small>{memberLabel(rule.assigneeId)} · {MODE_LABELS[rule.mode]} · 우선순위 {rule.priority}</small>
      </button>)}
      {!sortedRules.length && <div className="automation-empty">
        {loading ? '배정 규칙을 불러오는 중입니다.' : loadError ? '배정 규칙을 읽을 수 없습니다.' : '등록된 배정 규칙이 없습니다.'}
      </div>}
    </div>

    {draft && <section className="automation-editor" aria-label="담당자 배정 규칙 편집">
      <div className="automation-editor-heading">
        <h3>{activeRule ? activeRule.name : '새 담당자 배정 규칙'}</h3>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => switchEditor()} aria-label="배정 규칙 편집 닫기">
          <X size={17} />닫기
        </button>
      </div>
      {(conflict || remoteChanged) && activeRule && <div className="assignment-conflict automation-notice">
        <p>{remoteRule ? '다른 작업자가 이 규칙을 변경했습니다. 작성 중인 입력을 유지합니다.' : '현재 목록에서 이 규칙을 찾을 수 없습니다. 작성 중인 입력을 유지합니다.'}</p>
        {remoteRule && <button type="button" className="btn btn-secondary" disabled={busy || loading} onClick={() => switchEditor(remoteRule)}>
          최신 규칙 불러오기
        </button>}
      </div>}
      {error && <p role="alert" className="automation-error assignment-editor-error">{error}</p>}

      <form onSubmit={save}>
        <fieldset disabled={busy}>
          <div className="automation-form-grid">
            <label>규칙 이름
              <input className="field" aria-label="배정 규칙 이름" value={draft.name} maxLength={100} required
                onChange={event => updateDraft({ name: event.target.value })} />
            </label>
            <label>우선순위
              <input className="field" aria-label="배정 규칙 우선순위" value={Number.isNaN(draft.priority) ? '' : draft.priority}
                type="number" min={0} max={10000} step={1} required onChange={event => updateDraft({ priority: event.target.valueAsNumber })} />
            </label>
            <label>도착 상태
              <select className="field" aria-label="배정 도착 상태" value={draft.toStatusId} required
                onChange={event => updateDraft({ toStatusId: event.target.value })}>
                <option value="">상태 선택</option>
                {draft.toStatusId && !statuses.some(status => status.id === draft.toStatusId) && <option value={draft.toStatusId}>{draft.toStatusId} (삭제됨)</option>}
                {statuses.map(status => <option value={status.id} key={status.id}>{status.label}</option>)}
              </select>
            </label>
            <label>배정할 팀원
              <select className="field" aria-label="배정 대상 팀원" value={draft.assigneeId} required
                onChange={event => updateDraft({ assigneeId: event.target.value })}>
                <option value="">팀원 선택</option>
                {draft.assigneeId && !data.users.some(user => user.id === draft.assigneeId) && <option value={draft.assigneeId}>{draft.assigneeId} (삭제됨)</option>}
                {data.users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}
              </select>
            </label>
            <label>기존 담당자 처리
              <select className="field" aria-label="기존 담당자 처리" value={draft.mode} onChange={event => updateDraft({ mode: event.target.value === 'replace' ? 'replace' : 'unassigned' })}>
                <option value="unassigned">{MODE_LABELS.unassigned}</option>
                <option value="replace">{MODE_LABELS.replace}</option>
              </select>
            </label>
          </div>

          <div className="automation-check-group" role="group" aria-label="배정 출발 상태">
            <strong>출발 상태 · 선택하지 않으면 모든 상태</strong>
            {sourceOptions.map(({ id, label }) => <label key={id}>
              <input type="checkbox" aria-label={`배정 출발 상태 ${label}`} checked={draft.fromStatuses.includes(id)}
                onChange={event => updateDraft({ fromStatuses: toggleChoice(draft.fromStatuses, id, event.target.checked) })} />
              {label}
            </label>)}
          </div>
          <div className="automation-check-group" role="group" aria-label="배정 업무 유형">
            <strong>업무 유형 · 선택하지 않으면 모든 유형</strong>
            {typeOptions.map(({ id, label }) => <label key={id}>
              <input type="checkbox" aria-label={`배정 업무 유형 ${label}`} checked={draft.issueTypes.includes(id)}
                onChange={event => updateDraft({ issueTypes: toggleChoice(draft.issueTypes, id, event.target.checked) })} />
              {label}
            </label>)}
          </div>
          <label className="automation-enable">
            <input type="checkbox" aria-label="배정 규칙 활성화" checked={draft.enabled}
              onChange={event => updateDraft({ enabled: event.target.checked })} />규칙 활성화
          </label>
          <div className="automation-editor-actions">
            {activeRule && <button type="button" className="btn btn-danger" onClick={() => void removeRule(activeRule)}>
              <Trash2 size={16} />배정 규칙 삭제
            </button>}
            <button type="submit" className="btn btn-primary"><Save size={16} />배정 규칙 저장</button>
          </div>
        </fieldset>
      </form>

      <form className="automation-preview" onSubmit={runPreview}>
        <fieldset disabled={busy}>
          <h4><FlaskConical size={17} />미리보기</h4>
          <p>업무를 최대 {PREVIEW_LIMIT}개 고르면 편집 중인 규칙을 단독으로 시뮬레이션합니다. 비활성 규칙도 미리 볼 수 있습니다.</p>
          {projectIssues.length > 0 ? <div className="automation-preview-issues" role="group" aria-label="배정 미리보기 업무">
            {projectIssues.map(issue => <label key={issue.id}>
              <input type="checkbox" aria-label={`${issue.key} 배정 미리보기 선택`} checked={selectedIssues.includes(issue.id)}
                disabled={selectedIssues.length >= PREVIEW_LIMIT && !selectedIssues.includes(issue.id)}
                onChange={event => {
                  setPreviewIssueIds(toggleChoice(selectedIssues, issue.id, event.target.checked));
                  setPreview(null);
                }} />
              <span><strong>{issue.key}</strong> {issue.title} · {statusLabel(issue.status)}</span>
            </label>)}
          </div> : <p>이 프로젝트에 미리 볼 업무가 없습니다.</p>}
          <button type="submit" className="btn btn-secondary" disabled={!selectedIssues.length}>배정 미리보기</button>
        </fieldset>
        {preview && <div className="automation-preview-result" aria-live="polite">
          <strong>미리보기 결과 · {preview.length}건</strong>
          {preview.map(outcome => <div className="automation-preview-outcome" key={outcome.issueId}>
            <strong>{outcome.issueKey} {outcome.issueTitle}</strong>
            <span>{statusLabel(outcome.fromStatusId)} → {statusLabel(outcome.toStatusId)}</span>
            <span>{assigneeChange(outcome)}</span>
            <OutcomeBadge outcome={outcome.outcome} preview />
            <p>{outcome.reason}</p>
          </div>)}
        </div>}
      </form>
    </section>}

    <section className="automation-runs" aria-label="담당자 배정 실행 기록">
      <div>
        <h3>담당자 배정 실행 기록</h3>
        {runs && <span>총 {runs.total}건</span>}
      </div>
      {runs?.items.length ? <div className="automation-log-scroll" tabIndex={0} role="region" aria-label="담당자 배정 실행 기록 표">
        <table>
          <thead><tr><th scope="col">업무</th><th scope="col">규칙</th><th scope="col">상태 전환</th><th scope="col">담당자</th><th scope="col">결과</th><th scope="col">실행 시각</th></tr></thead>
          <tbody>{runs.items.map(run => <tr key={run.id}>
            <td>{projectIssueIds.has(run.issueId)
              ? <button type="button" className="automation-issue-link" onClick={() => openIssue(run.issueId)}>{run.issueKey}</button>
              : <strong>{run.issueKey}</strong>}
              <small>{run.issueTitle}</small>
            </td>
            <td>{run.ruleName}<small>{run.source === 'gitlab' ? 'GitLab' : memberLabel(run.actorId)}</small></td>
            <td>{statusLabel(run.fromStatusId)} → {statusLabel(run.toStatusId)}</td>
            <td>{assigneeChange(run)}</td>
            <td><OutcomeBadge outcome={run.outcome} /><small>{run.reason}</small></td>
            <td><time dateTime={run.createdAt}>{formatRunDate.format(new Date(run.createdAt))}</time></td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="automation-empty">
        {loading ? '실행 기록을 불러오는 중입니다.' : loadError ? '실행 기록을 읽을 수 없습니다.' : '기록된 실행이 없습니다.'}
      </p>}
      {runs && runs.total > runs.limit && <div className="assignment-history-pages" aria-label="배정 실행 기록 페이지">
        <button type="button" className="btn btn-ghost" disabled={busy || loading || runs.offset === 0}
          onClick={() => void load(Math.max(0, runs.offset - runs.limit))}><ChevronLeft size={16} />이전</button>
        <span>{runs.offset + 1}–{Math.min(runs.offset + runs.limit, runs.total)} / {runs.total}</span>
        <button type="button" className="btn btn-ghost" disabled={busy || loading || runs.offset + runs.limit >= runs.total}
          onClick={() => void load(runs.offset + runs.limit)}>다음<ChevronRight size={16} /></button>
      </div>}
    </section>
  </section>;
}
