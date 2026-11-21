'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowRightLeft, ArrowUp, ChevronDown, GitBranch, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { type FeatureProps, type IssueRequiredField, type ProjectWorkflow, type WorkflowStatus, type WorkflowTransition } from '../../shared/types';
import { MAX_WORKFLOW_WIP_LIMIT, projectWorkflow, STATUS_CATEGORY_LABELS } from '../../shared/workflow-helpers';
import { projectIssueSchema, projectIssueTypes, requiredFieldLabels } from '../../shared/issue-schema';
import { api, patch } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import { WorkflowStatusMigration } from './WorkflowStatusMigration';
import './workflow-settings.css';

type StatusDraft = Omit<WorkflowStatus, 'wipLimit'> & { wipLimitText: string };
type WorkflowDraft = Omit<ProjectWorkflow, 'statuses'> & { statuses: StatusDraft[] };

function workflowDraft(value: ProjectWorkflow): WorkflowDraft {
  return {
    ...value,
    statuses: value.statuses.map(({ wipLimit, ...status }) => ({ ...status, wipLimitText: String(wipLimit ?? '') })),
    transitions: value.transitions.map(edge => ({ ...edge, requireResolvedBlockers: edge.requireResolvedBlockers === true })),
  };
}

function validLimit(value: string) {
  const limit = Number(value);
  return value === '' || (/^[0-9]+$/.test(value) && limit >= 1 && limit <= MAX_WORKFLOW_WIP_LIMIT);
}

export function WorkflowSettings(props: FeatureProps) {
  const project = props.data.projects.find(value => value.id === props.projectId);
  if (!project) return null;
  return <WorkflowEditor key={`${project.id}:${props.actorId}`} {...props} />;
}
function WorkflowEditor({ data, projectId, actorId, refresh, notify }: FeatureProps) {
  const [draft, setDraft] = useState(() => workflowDraft(projectWorkflow(data, projectId)));
  const [baseline, setBaseline] = useState<ProjectWorkflow>(() => structuredClone(projectWorkflow(data, projectId)));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'states' | 'transitions' | 'fields'>('states');
  const [transitionFilter, setTransitionFilter] = useState('all');
  const [migrationOpen, setMigrationOpen] = useState(false);
  const limitHint = useId();
  const closeMigration = useCallback(() => setMigrationOpen(false), []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(workflowDraft(baseline));
  const issueTypes = projectIssueTypes(data, projectId, { includeArchived: true });
  const typeLabels = Object.fromEntries(issueTypes.map(type => [type.id, `${type.name}${type.archived ? ' (보관됨)' : ''}`]));
  const requirementLabels = requiredFieldLabels(data, projectId);
  const archivedRequirements = projectIssueSchema(data, projectId).fields.filter(field => field.archived).map(field => `custom:${field.id}`);
  for (const id of archivedRequirements) requirementLabels[id] = `${requirementLabels[id]} (보관됨)`;
  const remote = data.workflows?.find(workflow => workflow.projectId === projectId);
  const remoteChanged = Boolean(remote && remote.version > baseline.version);
  if (remote && remoteChanged && !dirty && !saving && !loading) { setDraft(workflowDraft(remote)); setBaseline(structuredClone(remote)); setError(''); }
  const dirtyRef = useRef(false), savingRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    let active = true;
    api<ProjectWorkflow>(`/projects/${projectId}/workflow`).then(value => { if (active) { setDraft(workflowDraft(value)); setBaseline(value); } }).catch(err => { if (active) setError(errorMessage(err)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);
  const guard = useCallback((event: Event) => {
    if (event.defaultPrevented) return;
    if (savingRef.current) { event.preventDefault(); notify('워크플로 저장이 끝난 뒤 이동해 주세요.', 'error'); }
    else if (dirtyRef.current) { if (!window.confirm('저장하지 않은 워크플로 설정을 버리고 이동할까요?')) event.preventDefault(); else afterAcceptedNavigation(event, () => { dirtyRef.current = false; setDraft(workflowDraft(baseline)); setError(''); }); }
  }, [notify, baseline]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current || savingRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', beforeUnload); };
  }, [guard]);
  const updateStatus = (index: number, changes: Partial<StatusDraft>) => setDraft(previous => ({ ...previous, statuses: previous.statuses.map((value, row) => row === index ? { ...value, ...changes } : value) }));
  function renameNewId(index: number, id: string) {
    setDraft(previous => { const oldId = previous.statuses[index].id; return { ...previous, statuses: previous.statuses.map((status, row) => row === index ? { ...status, id } : status), initialStatusId: previous.initialStatusId === oldId ? id : previous.initialStatusId, transitions: previous.transitions.map(edge => ({ ...edge, from: edge.from === oldId ? id : edge.from, to: edge.to === oldId ? id : edge.to })), fieldRules: previous.fieldRules.map(rule => ({ ...rule, statusId: rule.statusId === oldId ? id : rule.statusId })) }; });
  }
  function removeStatus(id: string) { setDraft(previous => ({ ...previous, statuses: previous.statuses.filter(status => status.id !== id), transitions: previous.transitions.filter(edge => edge.from !== id && edge.to !== id), fieldRules: previous.fieldRules.filter(rule => rule.statusId !== id) })); }
  function moveStatus(index: number, offset: number) { setDraft(previous => { const statuses = [...previous.statuses]; [statuses[index], statuses[index + offset]] = [statuses[index + offset], statuses[index]]; return { ...previous, statuses }; }); }
  function updateTransition(index: number, changes: Partial<WorkflowTransition>) {
    setDraft(previous => ({ ...previous, transitions: previous.transitions.map((edge, row) => row === index ? { ...edge, ...changes } : edge) }));
  }
  function addTransition() {
    for (const from of draft.statuses) for (const to of draft.statuses) if (from.id !== to.id && !draft.transitions.some(edge => edge.from === from.id && edge.to === to.id)) { setDraft(previous => ({ ...previous, transitions: [...previous.transitions, { from: from.id, to: to.id, issueTypes: [], requiredFields: [], requireResolvedBlockers: false }] })); return; }
    notify('모든 상태 사이의 전이가 이미 설정되어 있습니다.', 'error');
  }
  function addMissingTransitions() {
    setDraft(previous => {
      const present = new Set(previous.transitions.map(({ from, to }) => `${from}:${to}`));
      const added = previous.statuses.flatMap(from => previous.statuses
        .filter(to => from.id !== to.id && !present.has(`${from.id}:${to.id}`))
        .map(to => ({ from: from.id, to: to.id, issueTypes: [], requiredFields: [], requireResolvedBlockers: false })));
      return added.length ? { ...previous, transitions: [...previous.transitions, ...added] } : previous;
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    const invalid = draft.statuses.find(status => !validLimit(status.wipLimitText));
    if (invalid) {
      setTab('states');
      setError(`${invalid.label || invalid.id}의 업무 한도를 1~${MAX_WORKFLOW_WIP_LIMIT.toLocaleString('ko-KR')} 사이의 정수로 입력해 주세요.`);
      return;
    }
    const statuses = draft.statuses.map(({ wipLimitText, ...status }) => ({ ...status, wipLimit: wipLimitText === '' ? null : Number(wipLimitText) }));
    savingRef.current = true; setSaving(true); setError('');
    try { const value = await patch<ProjectWorkflow>(`/projects/${projectId}/workflow`, { ...draft, statuses, expectedVersion: draft.version }); setDraft(workflowDraft(value)); setBaseline(value); dirtyRef.current = false; await refresh(); notify('프로젝트 워크플로를 저장했습니다.'); }
    catch (err) { setError(errorMessage(err)); } finally { savingRef.current = false; setSaving(false); }
  }
  async function reload() {
    if (savingRef.current || (dirtyRef.current && !window.confirm('작성 중인 설정을 버리고 최신 워크플로를 불러올까요?'))) return;
    savingRef.current = true; setLoading(true); setError('');
    try { const value = await api<ProjectWorkflow>(`/projects/${projectId}/workflow`); setDraft(workflowDraft(value)); setBaseline(value); dirtyRef.current = false; await refresh(); }
    catch (err) { setError(errorMessage(err)); } finally { savingRef.current = false; setLoading(false); }
  }
  const stateOptions = draft.statuses.map(status => <option key={status.id} value={status.id}>{status.label || status.id}</option>);
  return <section className="card workflow-settings" aria-label="프로젝트 워크플로 설정"><div className="workflow-heading"><div><h2><GitBranch size={18} />프로젝트 워크플로</h2><p>{data.projects.find(project => project.id === projectId)?.name}의 상태와 진행 규칙을 팀에 맞게 설정하세요.</p></div><span className="workflow-version">버전 {draft.version}{dirty ? ' · 저장 필요' : ''}</span></div>
    <form onSubmit={save}>{remoteChanged && dirty && <div className="issue-form-error workflow-remote-warning" role="alert">서버 워크플로가 버전 {remote?.version}(으)로 변경되었습니다. 작성 중인 설정은 편집 시작 버전 {baseline.version} 기준으로 유지됩니다. 최신 설정을 확인한 뒤 다시 편집해 주세요.</div>}<fieldset disabled={loading || saving}><div className="workflow-tabs">{([['states', '상태'], ['transitions', '허용 전이'], ['fields', '필수 속성']] as const).map(([value, label]) => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}<span>{value === 'states' ? draft.statuses.length : value === 'transitions' ? draft.transitions.length : draft.fieldRules.length}</span></button>)}</div>
      {tab === 'states' && <div className="workflow-tab-content">
        {baseline.statuses.length > 1 && <button className="btn workflow-migration-launch" type="button" aria-haspopup="dialog" onClick={() => setMigrationOpen(true)}><ArrowRightLeft size={14} aria-hidden="true" />상태 일괄 변경</button>}
        <div className="workflow-initial">
          <label>새 업무의 기본 상태
            <select className="field" aria-label="새 업무의 기본 상태" value={draft.initialStatusId}
              onChange={event => setDraft(previous => ({ ...previous, initialStatusId: event.target.value }))}>{stateOptions}</select>
          </label>
          <p>상태 ID는 저장 후 고정됩니다. 완료 분류 변경은 집계와 사용 중인 업무의 완료 시각에도 반영됩니다.</p>
        </div>
        <p id={limitHint} className="workflow-limit-hint">업무 한도는 해당 상태에 있는 프로젝트의 업무를 하위 업무까지 모두 셉니다. 한도를 넘으면 보드에 경고가 표시됩니다.</p>
        <div className="workflow-table-scroll">
          <table className="workflow-state-table">
            <thead><tr><th>순서</th><th>상태 이름</th><th className="workflow-limit-column">업무 한도</th><th>고유 ID</th><th>색상</th><th>분류</th><th>사용 중</th><th /></tr></thead>
            <tbody>{draft.statuses.map((status, index) => {
              const count = data.issues.filter(issue => issue.projectId === projectId && issue.status === status.id).length;
              const existing = baseline.statuses.some(value => value.id === status.id);
              const limitName = draft.statuses.some((value, row) => row !== index && value.label === status.label)
                ? `${status.label} (${status.id})` : status.label || status.id;
              return <tr key={index} className="workflow-status-row">
                <td>
                  <div className="workflow-order">
                    <button type="button" aria-label={`${status.label} 위로`} onClick={() => moveStatus(index, -1)} disabled={index === 0}><ArrowUp size={13} /></button>
                    <button type="button" aria-label={`${status.label} 아래로`} onClick={() => moveStatus(index, 1)} disabled={index === draft.statuses.length - 1}><ArrowDown size={13} /></button>
                  </div>
                </td>
                <td><input className="field" aria-label={`상태 ${index + 1} 이름`} value={status.label} onChange={event => updateStatus(index, { label: event.target.value })} required maxLength={40} /></td>
                <td className="workflow-limit-column">
                  <input className="field workflow-limit-input" inputMode="numeric" aria-label={`업무 한도 ${limitName}`}
                    aria-describedby={limitHint} aria-invalid={!validLimit(status.wipLimitText)} placeholder="미설정"
                    value={status.wipLimitText} onChange={event => updateStatus(index, { wipLimitText: event.target.value })} />
                </td>
                <td><input className="field workflow-state-id" aria-label={`상태 ${index + 1} ID`} value={status.id} readOnly={existing} onChange={event => renameNewId(index, event.target.value)} required maxLength={48} pattern="[a-z][a-z0-9_-]*" title={existing ? '저장된 상태의 ID는 고정됩니다.' : '영문 소문자·숫자·밑줄·하이픈'} /></td>
                <td><input type="color" aria-label={`상태 ${index + 1} 색상`} value={status.color} onChange={event => updateStatus(index, { color: event.target.value })} /></td>
                <td><select className="field" aria-label={`상태 ${index + 1} 분류`} value={status.category} onChange={event => updateStatus(index, { category: event.target.value as WorkflowStatus['category'] })}>{Object.entries(STATUS_CATEGORY_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></td>
                <td><span className="workflow-usage">{count}개</span></td>
                <td><button className="issue-icon-button" type="button" aria-label={`${status.label} 상태 삭제`} title={count ? '업무에서 사용 중인 상태는 삭제할 수 없습니다.' : draft.initialStatusId === status.id ? '기본 상태를 먼저 변경하세요.' : '상태 삭제'} disabled={count > 0 || draft.initialStatusId === status.id} onClick={() => removeStatus(status.id)}><Trash2 size={14} /></button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <button className="btn btn-ghost" type="button" onClick={() => setDraft(previous => ({
          ...previous, statuses: [...previous.statuses, { id: `state_${Date.now().toString(36)}`, label: '새 상태', color: '#588b9c', category: 'todo', wipLimitText: '' }],
        }))}><Plus size={14} /> 상태 추가</button>
      </div>}
      {tab === 'transitions' && <div className="workflow-tab-content">
        <div className="workflow-section-actions">
          <p>등록한 방향으로만 상태를 변경할 수 있습니다. 같은 상태에서 속성을 수정하는 것은 허용됩니다.</p>
          <button type="button" className="btn" onClick={addTransition}><Plus size={14} />전이 추가</button>
        </div>
        <div className="workflow-transition-controls">
          <select className="field" aria-label="출발 상태로 전이 필터" value={transitionFilter} onChange={event => setTransitionFilter(event.target.value)}>
            <option value="all">모든 출발 상태</option>{stateOptions}
          </select>
          <button type="button" className="btn btn-ghost" onClick={addMissingTransitions}>빠진 전이 모두 추가</button>
          <button type="button" className="btn btn-ghost" onClick={() => setDraft(previous => ({ ...previous, transitions: [] }))}>전이 모두 비우기</button>
        </div>
        <div className="workflow-rules-table">
          <div className="workflow-rule-header"><span>출발 상태</span><span /><span>도착 상태</span><span>업무 유형</span><span>전이 시 필수 속성</span><span /></div>
          {draft.transitions.map((edge, index) => transitionFilter !== 'all' && edge.from !== transitionFilter ? null : <div className="workflow-transition-row" key={index}>
            <select className="field" aria-label={`전이 ${index + 1} 출발 상태`} value={edge.from}
              onChange={event => updateTransition(index, { from: event.target.value })}>{stateOptions}</select>
            <ArrowRight size={13} aria-hidden="true" />
            <select className="field" aria-label={`전이 ${index + 1} 도착 상태`} value={edge.to}
              onChange={event => updateTransition(index, { to: event.target.value })}>{stateOptions}</select>
            <MultiSelect label={`전이 ${index + 1} 업무 유형`} options={typeLabels} value={edge.issueTypes} emptyLabel="모든 유형"
              hint="선택하지 않으면 모든 유형에 적용됩니다." onChange={issueTypes => updateTransition(index, { issueTypes })} />
            <MultiSelect label={`전이 ${index + 1} 필수 속성`} options={requirementLabels} disabledOptions={archivedRequirements}
              value={edge.requiredFields} emptyLabel="없음" onChange={values => updateTransition(index, { requiredFields: values as IssueRequiredField[] })} />
            <button type="button" className="issue-icon-button" aria-label={`전이 ${index + 1} 삭제`}
              onClick={() => setDraft(previous => ({ ...previous, transitions: previous.transitions.filter((_, row) => row !== index) }))}><Trash2 size={14} /></button>
            <label className="workflow-transition-blockers">
              <input type="checkbox" aria-label={`전이 ${index + 1} 열린 차단 업무 해결 필요`} checked={edge.requireResolvedBlockers === true}
                onChange={event => updateTransition(index, { requireResolvedBlockers: event.target.checked })} />
              열린 차단 업무 해결 필요
            </label>
          </div>)}
        </div>
        {!draft.transitions.length && <div className="workflow-empty">허용 전이가 없습니다. 업무 속성 수정은 가능하며 상태 변경은 제한됩니다.</div>}
      </div>}
      {tab === 'fields' && <div className="workflow-tab-content"><div className="workflow-section-actions"><p>선택한 유형과 상태의 업무에 적용됩니다. 기존 업무는 다음 수정부터 검사합니다.</p><button type="button" className="btn" onClick={() => setDraft(previous => ({ ...previous, fieldRules: [...previous.fieldRules, { issueType: '*', statusId: previous.statuses[0]?.id || '', requiredFields: [] }] }))}><Plus size={14} />규칙 추가</button></div><div className="workflow-field-rule-header"><span>업무 유형</span><span>적용 상태</span><span>필수 속성</span><span /></div>{draft.fieldRules.map((rule, index) => <div className="workflow-field-rule" key={index}><select className="field" aria-label={`규칙 ${index + 1} 업무 유형`} value={rule.issueType} onChange={event => setDraft(previous => ({ ...previous, fieldRules: previous.fieldRules.map((value, row) => row === index ? { ...value, issueType: event.target.value } : value) }))}><option value="*">모든 유형</option>{rule.issueType !== '*' && !Object.hasOwn(typeLabels, rule.issueType) && <option value={rule.issueType}>사용할 수 없는 유형 · {rule.issueType}</option>}{issueTypes.map(type => <option key={type.id} value={type.id}>{typeLabels[type.id]}</option>)}</select><select className="field" aria-label={`규칙 ${index + 1} 상태`} value={rule.statusId} onChange={event => setDraft(previous => ({ ...previous, fieldRules: previous.fieldRules.map((value, row) => row === index ? { ...value, statusId: event.target.value } : value) }))}>{stateOptions}</select><MultiSelect label={`규칙 ${index + 1} 필수 속성`} options={requirementLabels} disabledOptions={archivedRequirements} value={rule.requiredFields} emptyLabel="없음" onChange={values => setDraft(previous => ({ ...previous, fieldRules: previous.fieldRules.map((value, row) => row === index ? { ...value, requiredFields: values as IssueRequiredField[] } : value) }))} /><button type="button" className="issue-icon-button" aria-label={`규칙 ${index + 1} 삭제`} onClick={() => setDraft(previous => ({ ...previous, fieldRules: previous.fieldRules.filter((_, row) => row !== index) }))}><Trash2 size={14} /></button></div>)}{!draft.fieldRules.length && <div className="workflow-empty">추가 필수 속성 규칙이 없습니다. 제목 등 기본 입력 검사는 유지됩니다.</div>}</div>}
      </fieldset>{error && <div className="issue-form-error" role="alert">{error} 입력한 설정은 유지됩니다.</div>}<div className="workflow-footer"><span>{loading ? '설정을 불러오는 중…' : '저장하면 업무 목록·보드·간트에 반영됩니다.'}</span><button type="button" className="btn" onClick={reload} disabled={saving || loading}><RefreshCw size={14} />최신 설정 불러오기</button><button type="submit" className="btn btn-primary" disabled={saving || loading || !dirty}><Save size={14} />{saving ? '저장 중…' : '워크플로 저장'}</button></div></form>
    {migrationOpen && <WorkflowStatusMigration actorId={actorId} savedWorkflow={baseline} users={data.users} refresh={refresh} notify={notify} onClose={closeMigration} />}
  </section>;
}
function MultiSelect({ label, options, value, emptyLabel, hint, onChange, disabledOptions = [] }: { label: string; options: Record<string, string>; value: string[]; emptyLabel: string; hint?: string; onChange: (value: string[]) => void; disabledOptions?: string[] }) {
  return <details className="workflow-multiselect"><summary aria-label={label}>{value.length ? value.map(key => options[key] || key).join(', ') : emptyLabel}<ChevronDown size={12} /></summary><div>{hint && <p>{hint}</p>}{Object.entries({ ...Object.fromEntries(value.filter(key => !Object.hasOwn(options, key)).map(key => [key, `사용할 수 없음 · ${key}`])), ...options }).map(([key, title]) => <label key={key}><input type="checkbox" aria-label={`${label} · ${title}`} checked={value.includes(key)} disabled={disabledOptions.includes(key) && !value.includes(key)} onChange={event => onChange(event.target.checked ? [...value, key] : value.filter(item => item !== key))} />{title}</label>)}</div></details>;
}
