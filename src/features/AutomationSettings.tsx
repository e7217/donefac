'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, FlaskConical, Plus, RefreshCw, Save, Trash2, Workflow, X } from 'lucide-react';
import type { AutomationPreview, AutomationRule, AutomationRun, FeatureProps, GitlabAutomationTrigger, GitlabSettings } from '../../shared/types';
import { AUTOMATION_TRIGGER_LABELS, AUTOMATION_TRIGGERS, sortedAutomationRules } from '../../shared/automation';
import { projectIssueTypes } from '../../shared/issue-schema';
import { projectStatuses, statusMeta } from '../../shared/workflow-helpers';
import { api, patch, post, remove } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './automation-settings.css';

type RuleDraft = Pick<AutomationRule, 'name' | 'enabled' | 'trigger' | 'gitlabProjectIds' | 'branchPattern' | 'issueTypes' | 'fromStatuses' | 'toStatusId' | 'actorId' | 'priority'> & { environment: string };
const draftOf = (rule: AutomationRule): RuleDraft => ({ name: rule.name, enabled: rule.enabled, trigger: rule.trigger, gitlabProjectIds: [...rule.gitlabProjectIds], branchPattern: rule.branchPattern, environment: rule.environment ?? '', issueTypes: [...rule.issueTypes], fromStatuses: [...rule.fromStatuses], toStatusId: rule.toStatusId, actorId: rule.actorId, priority: rule.priority });
const emptyDraft = (actorId: string): RuleDraft => ({ name: '', enabled: false, trigger: 'merge_request.merged', gitlabProjectIds: [], branchPattern: '*', environment: '', issueTypes: [], fromStatuses: [], toStatusId: '', actorId, priority: 100 });
const ready = (settings: GitlabSettings | null) => Boolean(settings?.baseUrl && settings.projectIds.length && (settings.webhookSecretConfigured || settings.signingTokenConfigured));
const time = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR') : '없음';

export function AutomationSettings(props: FeatureProps) { return <ProjectAutomation key={`${props.projectId}:${props.actorId}`} {...props} />; }
function ProjectAutomation(props: FeatureProps) {
  const { projectId, actorId } = props;
  const [rules, setRules] = useState<AutomationRule[]>([]), [runs, setRuns] = useState<AutomationRun[]>([]);
  const [connection, setConnection] = useState<GitlabSettings | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null), [creating, setCreating] = useState(false);
  const active = useRef(true), sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try { const [nextRules, nextRuns, settings] = await Promise.all([api<AutomationRule[]>(`/automation-rules?projectId=${encodeURIComponent(projectId)}`), api<AutomationRun[]>(`/automation-runs?projectId=${encodeURIComponent(projectId)}&limit=50`), api<GitlabSettings>('/integrations/gitlab')]); if (!active.current || request !== sequence.current) return; setRules(sortedAutomationRules(nextRules)); setRuns(nextRuns); setConnection(settings); setError(''); }
    catch (cause) { if (active.current && request === sequence.current) setError(errorMessage(cause)); } finally { if (active.current && request === sequence.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => { active.current = true; const initial = setTimeout(() => { void load(); }, 0); const changed = () => { void load(); }; window.addEventListener('teamspace:gitlab-settings-changed', changed); return () => { clearTimeout(initial); active.current = false; window.removeEventListener('teamspace:gitlab-settings-changed', changed); }; }, [load]);
  const canLeave = () => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }));
  const current = rules.find(value => value.id === selectedId);
  const validProject = props.data.projects.some(value => value.id === projectId);
  if (!validProject) return <section className="card automation-settings"><h2>GitLab 상태 자동화</h2><p>프로젝트를 선택하면 상태 전환 규칙을 관리할 수 있습니다.</p></section>;
  return <section className="card automation-settings" aria-label="GitLab 상태 자동화 설정">
    <header><div><h2><Workflow size={21} />GitLab 상태 자동화</h2><p>인증된 새 GitLab 이벤트에 맞춰 업무 상태를 전환합니다.</p></div><div className="automation-card-actions"><button className="btn btn-ghost" disabled={loading} onClick={() => { void load(); void props.refresh(); }} aria-label="자동화 설정 새로고침"><RefreshCw size={16} />새로고침</button><button className="btn btn-primary" disabled={loading || creating} onClick={() => { if (canLeave()) { setSelectedId(null); setCreating(true); } }}><Plus size={16} />규칙 만들기</button></div></header>
    {!ready(connection) && !loading && <p className="automation-notice" role="status">GitLab 주소·프로젝트 ID와 웹훅 인증을 먼저 설정하세요. 읽기 API 토큰 없이도 인증된 수신 이벤트를 사용할 수 있습니다.</p>}
    <p className="automation-policy">같은 업무에는 우선순위 숫자가 가장 작은 첫 규칙만 적용합니다. 전환이 차단되어도 이후 규칙으로 넘어가지 않습니다. 활성화 이후 수신한 이벤트부터 처리합니다.</p>
    {error && <p className="automation-error" role="alert">{error} 기존 입력과 로그는 유지됩니다.</p>}
    {loading && <p>자동화 설정을 불러오는 중입니다.</p>}
    <div className="automation-rule-list">{rules.map(rule => { const enabled = rule.enabled && ready(connection) && rule.gitlabBaseUrl === connection?.baseUrl && rule.gitlabProjectIds.every(id => connection?.projectIds.includes(id)); return <button type="button" key={rule.id} className={`automation-rule-card ${selectedId === rule.id && !creating ? 'is-selected' : ''}`} onClick={() => { if (selectedId === rule.id && !creating || canLeave()) { setCreating(false); setSelectedId(rule.id); } }}><span className="automation-rule-order">우선순위 {rule.priority}</span><strong>{rule.name}</strong><span className={`automation-state ${enabled ? 'is-enabled' : ''}`}>{enabled ? '활성' : rule.enabled ? '연결 확인 필요' : '비활성'}</span><span>{AUTOMATION_TRIGGER_LABELS[rule.trigger]} · {rule.trigger === 'deployment.succeeded' ? `환경 ${rule.environment}` : rule.branchPattern}</span><small>저장소 {rule.gitlabProjectIds.join(', ')} · 버전 {rule.version}</small></button>; })}{!loading && !rules.length && <div className="automation-empty">등록된 규칙이 없습니다. 미리보기로 동작을 확인한 뒤 활성화하세요.</div>}</div>
    {(creating || selectedId) && <RuleEditor key={`${creating ? 'new' : selectedId}:${actorId}`} {...props} rule={current} creating={creating} connection={connection} onClose={() => { if (canLeave()) { setSelectedId(null); setCreating(false); } }} onSaved={async rule => { setRules(previous => sortedAutomationRules([rule, ...previous.filter(value => value.id !== rule.id)])); setCreating(false); setSelectedId(rule.id); await load(); }} onDeleted={async () => { setSelectedId(null); setCreating(false); await load(); }} />}
    <section className="automation-runs" aria-label="자동화 실행 기록"><div><h3>최근 실행 기록</h3><span>최대 50건 · 차단 이유도 기록합니다.</span></div>{!runs.length ? <p className="automation-empty">아직 처리한 이벤트가 없습니다.</p> : <div className="automation-log-scroll"><table><thead><tr><th>업무</th><th>규칙</th><th>처리 결과</th><th>이유</th><th>시각</th></tr></thead><tbody>{runs.map(run => <tr key={run.id}><td><button className="automation-issue-link" onClick={() => props.openIssue(run.issueId)}>{run.key}</button><span>{run.title}</span></td><td>{rules.find(rule => rule.id === run.ruleId)?.name || '삭제된 규칙'}
      {run.context?.objectKind === 'deployment' && <small>배포 #{run.context.objectId} · 환경 {run.context.environment}</small>}
    </td><td><span className={`automation-outcome is-${run.outcome}`}>{outcomeLabel(run.outcome, false)}</span><small>{statusMeta(props.data, projectId, run.fromStatus).label} / {statusMeta(props.data, projectId, run.toStatus).label}</small></td><td>{run.reason}</td><td><time>{time(run.createdAt)}</time><details><summary>이벤트 정보</summary><code>{run.eventId}</code><span>발생 {time(run.occurredAt)}</span></details></td></tr>)}</tbody></table></div>}</section>
  </section>;
}

function RuleEditor({ rule, creating, connection, onClose, onSaved, onDeleted, ...props }: FeatureProps & { rule?: AutomationRule; creating: boolean; connection: GitlabSettings | null; onClose: () => void; onSaved: (rule: AutomationRule) => Promise<void>; onDeleted: () => Promise<void> }) {
  const { data, projectId, actorId, notify } = props;
  const environmentHint = useId();
  const [draft, setDraft] = useState<RuleDraft>(() => rule ? draftOf(rule) : emptyDraft(actorId)), [baseline, setBaseline] = useState<RuleDraft>(() => rule ? draftOf(rule) : emptyDraft(actorId));
  const [id] = useState(rule?.id || '');
  const [version, setVersion] = useState(rule?.version || 0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<AutomationPreview | null>(null), [selected, setSelected] = useState<string[]>([]), [branch, setBranch] = useState('main');
  const [chosenSampleTrigger, setSampleTrigger] = useState<GitlabAutomationTrigger | null>(null);
  const [chosenSampleEnvironment, setSampleEnvironment] = useState<string | null>(null);
  const [sampleProject, setSampleProject] = useState(draft.gitlabProjectIds[0] || connection?.projectIds[0] || 0);
  const sampleTrigger = chosenSampleTrigger ?? draft.trigger;
  const sampleEnvironment = chosenSampleEnvironment ?? draft.environment;
  const deploymentRule = draft.trigger === 'deployment.succeeded';
  const deploymentSample = sampleTrigger === 'deployment.succeeded';
  const { environment, ...baseRule } = draft;
  const ruleValues = deploymentRule ? { ...baseRule, environment, branchPattern: '*', projectId } : { ...baseRule, projectId };
  const busyRef = useRef(false), dirtyRef = useRef(false), active = useRef(true);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline), remoteChanged = Boolean(rule && rule.version > version);
  if (rule && remoteChanged && !dirty && !busy && !preview) { setDraft(draftOf(rule)); setBaseline(draftOf(rule)); setVersion(rule.version); setError(''); }
  useEffect(() => { dirtyRef.current = dirty || Boolean(preview); }, [dirty, preview]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { const guard = (event: Event) => { if (event.defaultPrevented) return; if (busyRef.current) { event.preventDefault(); notify('자동화 처리가 끝난 뒤 이동해 주세요.', 'error'); } else if (dirtyRef.current) { if (!window.confirm('저장하지 않은 자동화 입력과 미리보기를 버리고 이동할까요?')) event.preventDefault(); else afterAcceptedNavigation(event, () => { dirtyRef.current = false; setDraft(structuredClone(baseline)); setPreview(null); setError(''); }); } }; const unload = (event: BeforeUnloadEvent) => { if (busyRef.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload); return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); }; }, [baseline, notify]);
  function update<K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) { setDraft(previous => ({ ...previous, [key]: value })); setPreview(null); }
  const statuses = projectStatuses(data, projectId), knownTypes = projectIssueTypes(data, projectId, { includeArchived: true });
  const types = [...knownTypes, ...draft.issueTypes.filter(id => !knownTypes.some(value => value.id === id)).map(id => ({ id, name: `${id} (현재 양식에 없음)`, color: '', archived: true }))];
  const repositories = [...new Set([...(connection?.projectIds || []), ...draft.gitlabProjectIds, ...(rule?.gitlabProjectIds || [])])];
  const sources = [...statuses, ...draft.fromStatuses.filter(id => !statuses.some(value => value.id === id)).map(id => ({ id, label: `${id} (현재 워크플로에 없음)`, color: '', category: 'backlog' as const }))];
  async function execute(action: () => Promise<void>) { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); try { await action(); } catch (cause) { if (active.current) setError(errorMessage(cause)); } finally { busyRef.current = false; if (active.current) setBusy(false); } }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.fromStatuses.length || !draft.gitlabProjectIds.length || !draft.toStatusId) {
      setError('저장소, 출발 상태와 도착 상태를 명시적으로 선택하세요.');
      return;
    }
    await execute(async () => {
      const saved = creating ? await post<AutomationRule>('/automation-rules', ruleValues)
        : await patch<AutomationRule>(`/automation-rules/${id}`, { ...ruleValues, expectedVersion: version });
      if (!active.current) return;
      const savedDraft = draftOf(saved);
      setDraft(savedDraft);
      setBaseline(savedDraft);
      setVersion(saved.version);
      setPreview(null);
      dirtyRef.current = false;
      await onSaved(saved);
      notify('자동화 규칙을 저장했습니다.');
    });
  }

  function previewRule(event: FormEvent) {
    event.preventDefault();
    if (!selected.length) {
      setError('미리 볼 업무를 하나 이상 선택하세요.');
      return;
    }
    if (deploymentRule && !environment.trim()) {
      setError('규칙의 배포 환경 이름을 입력하세요.');
      return;
    }
    const sample = {
      trigger: sampleTrigger,
      gitlabProjectId: sampleProject,
      ...(deploymentSample ? { environment: sampleEnvironment } : { branch }),
    };
    void execute(async () => {
      const result = await post<AutomationPreview>('/automation/preview', { rule: ruleValues, issueIds: selected, sample });
      if (active.current) setPreview(result);
    });
  }
  async function reload() { if (!id || busyRef.current || dirtyRef.current && !window.confirm('작성 중인 자동화 입력과 미리보기를 버리고 최신 규칙을 불러올까요?')) return; await execute(async () => { const values = await api<AutomationRule[]>(`/automation-rules?projectId=${encodeURIComponent(projectId)}`), latest = values.find(value => value.id === id); if (!latest) throw new Error('이 규칙은 서버에서 삭제되었습니다. 입력을 유지합니다.'); if (!active.current) return; setDraft(draftOf(latest)); setBaseline(draftOf(latest)); setVersion(latest.version); setPreview(null); dirtyRef.current = false; await onSaved(latest); }); }
  return <section className="automation-editor" aria-label="자동화 규칙 편집"><div className="automation-editor-heading"><h3>{creating ? '새 자동화 규칙' : baseline.name}</h3><button className="btn btn-ghost" disabled={busy} onClick={onClose} aria-label="자동화 규칙 편집 닫기"><X size={17} />닫기</button></div>
    {!creating && !rule && <p className="automation-error" role="alert">이 규칙이 서버 목록에 없습니다. 작성 중인 입력은 유지됩니다.</p>}{remoteChanged && (dirty || preview) && <p className="automation-error" role="alert">다른 작업자가 규칙을 변경했습니다. 입력은 버전 {version} 기준으로 유지됩니다.</p>}
    <form onSubmit={save}><fieldset disabled={busy}><div className="automation-form-grid"><label>규칙 이름<input className="field" aria-label="자동화 규칙 이름" value={draft.name} required maxLength={120} onChange={event => update('name', event.target.value)} /></label><label>이벤트<Select ariaLabel="자동화 이벤트" value={draft.trigger} onChange={value => update('trigger', value as GitlabAutomationTrigger)}>{AUTOMATION_TRIGGERS.map(trigger => <option value={trigger} key={trigger}>{AUTOMATION_TRIGGER_LABELS[trigger]}</option>)}</Select></label>
      {deploymentRule ? <label>배포 환경<input className="field" aria-label="자동화 배포 환경" aria-describedby={environmentHint} maxLength={255} value={environment}
        required autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => update('environment', event.target.value)} />
        <small id={environmentHint}>GitLab 환경 이름이 대소문자까지 같아야 합니다.</small>
      </label> : <label>브랜치 패턴<input className="field" aria-label="자동화 브랜치 패턴" maxLength={128} value={draft.branchPattern}
        required onChange={event => update('branchPattern', event.target.value)} />
        <small>*는 모든 길이, ?는 한 글자와 일치합니다. 나머지는 그대로 비교합니다.</small>
      </label>}
      <label>우선순위<input className="field" type="number" aria-label="자동화 우선순위" min={0} max={10000} step={1} value={draft.priority} required onChange={event => update('priority', Number(event.target.value))} /></label><label>도착 상태<Select ariaLabel="자동화 도착 상태" value={draft.toStatusId} onChange={value => update('toStatusId', value)}><option value="">상태 선택</option>{draft.toStatusId && !statuses.some(value => value.id === draft.toStatusId) && <option value={draft.toStatusId}>{draft.toStatusId} (현재 워크플로에 없음)</option>}{statuses.map(status => <option value={status.id} key={status.id}>{status.label}</option>)}</Select></label><label>실행 작업자<Select ariaLabel="자동화 실행 작업자" value={draft.actorId} onChange={value => update('actorId', value)}>{!data.users.some(user => user.id === draft.actorId) && <option value={draft.actorId}>찾을 수 없는 작업자 · {draft.actorId}</option>}{data.users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</Select></label></div>
      <div className="automation-check-group" role="group" aria-label="자동화 GitLab 저장소"><strong>GitLab 저장소 · 필수</strong>{repositories.length ? repositories.map(id => <label key={id}><input type="checkbox" aria-label={`자동화 저장소 ${id}`} checked={draft.gitlabProjectIds.includes(id)} disabled={!connection?.projectIds.includes(id) && !draft.gitlabProjectIds.includes(id)} onChange={event => update('gitlabProjectIds', event.target.checked ? [...draft.gitlabProjectIds, id] : draft.gitlabProjectIds.filter(value => value !== id))} />{id}{!connection?.projectIds.includes(id) && <small>연결에서 제거됨</small>}</label>) : <p>위 GitLab 연결에 프로젝트 ID를 먼저 등록하세요.</p>}</div>
      <div className="automation-check-group" role="group" aria-label="자동화 출발 상태"><strong>출발 상태 · 하나 이상 직접 선택</strong>{sources.map(status => <label key={status.id}><input type="checkbox" aria-label={`자동화 출발 상태 ${status.label}`} checked={draft.fromStatuses.includes(status.id)} onChange={event => update('fromStatuses', event.target.checked ? [...draft.fromStatuses, status.id] : draft.fromStatuses.filter(value => value !== status.id))} />{status.label}</label>)}</div>
      <div className="automation-check-group" role="group" aria-label="자동화 업무 유형"><strong>업무 유형 · 선택하지 않으면 모든 유형</strong>{types.map(type => <label key={type.id}><input type="checkbox" aria-label={`자동화 업무 유형 ${type.name}`} checked={draft.issueTypes.includes(type.id)} onChange={event => update('issueTypes', event.target.checked ? [...draft.issueTypes, type.id] : draft.issueTypes.filter(value => value !== type.id))} />{type.name}{type.archived && <small>보관됨</small>}</label>)}</div>
      <label className="automation-enable"><input type="checkbox" aria-label="자동화 규칙 활성화" checked={draft.enabled} disabled={!ready(connection) && !draft.enabled} onChange={event => update('enabled', event.target.checked)} />규칙 활성화</label><p className="automation-policy">새 규칙의 기본값은 비활성입니다. 활성화를 선택하면 인증된 이후 이벤트가 실제 업무를 변경하며 워크플로·필수 속성 규칙을 따릅니다.</p>
      {error && <p className="automation-error" role="alert">{error} 입력과 미리보기는 유지됩니다.</p>}
      <div className="automation-editor-actions">{!creating && <><button className="btn btn-ghost" type="button" onClick={() => void reload()}>최신 규칙</button><button className="btn btn-ghost" type="button" onClick={() => { if (window.confirm('이 규칙을 삭제할까요? 저장하지 않은 규칙 입력도 사라집니다. 실행 기록은 유지됩니다.')) void execute(async () => { await remove(`/automation-rules/${id}?expectedVersion=${version}`); dirtyRef.current = false; await onDeleted(); notify('자동화 규칙을 삭제했습니다.'); }); }}><Trash2 size={16} />삭제</button></>}<button className="btn btn-primary" type="submit" disabled={!dirty || !draft.name.trim()}><Save size={16} />{busy ? '처리 중…' : '규칙 저장'}</button></div>
    </fieldset></form>
    <form className="automation-preview" aria-label="자동화 미리보기" onSubmit={previewRule}><fieldset disabled={busy}><h4><FlaskConical size={18} />저장 전 동작 미리보기</h4><p>업무 상태를 바꾸지 않습니다. 비활성 규칙도 같은 조건으로 시험합니다.</p><div className="automation-form-grid"><label>시험 이벤트<Select ariaLabel="미리보기 이벤트" value={sampleTrigger} onChange={value => { setSampleTrigger(value as GitlabAutomationTrigger); setPreview(null); }}>{AUTOMATION_TRIGGERS.map(trigger => <option value={trigger} key={trigger}>{AUTOMATION_TRIGGER_LABELS[trigger]}</option>)}</Select></label><label>시험 저장소<Select ariaLabel="미리보기 GitLab 저장소" value={String(sampleProject)} onChange={value => { setSampleProject(Number(value)); setPreview(null); }}><option value="0">저장소 선택</option>{repositories.map(id => <option value={id} key={id}>{id}</option>)}</Select></label>
      {deploymentSample ? <label className="automation-wide">시험 배포 환경<input className="field" aria-label="미리보기 배포 환경"
        value={sampleEnvironment} maxLength={255} required autoCapitalize="none" autoCorrect="off" spellCheck={false}
        onChange={event => { setSampleEnvironment(event.target.value); setPreview(null); }} />
      </label> : <label className="automation-wide">시험 브랜치<input className="field" aria-label="미리보기 브랜치" value={branch}
        maxLength={512} onChange={event => { setBranch(event.target.value); setPreview(null); }} />
      </label>}
      </div><div className="automation-preview-issues" role="group" aria-label="미리 볼 업무">{data.issues.filter(issue => issue.projectId === projectId).map(issue => <label key={issue.id}><input type="checkbox" aria-label={`${issue.key} 자동화 미리보기 선택`} checked={selected.includes(issue.id)} onChange={event => { setSelected(event.target.checked ? [...selected, issue.id] : selected.filter(id => id !== issue.id)); setPreview(null); }} /><span>{issue.key} · {issue.title}</span></label>)}</div><button className="btn" type="submit" disabled={!selected.length || !sampleProject}><FlaskConical size={16} />{busy ? '확인 중…' : '변경 없이 미리보기'}</button></fieldset>{preview && <div className="automation-preview-result" role="status"><strong>미리보기 결과 · 저장하거나 상태를 변경하지 않았습니다.</strong>{preview.warnings.map((warning, index) => <p className="automation-notice" key={index}>{warning}</p>)}{preview.outcomes.map(outcome => <div className="automation-preview-outcome" key={outcome.issueId}><span className={`automation-outcome is-${outcome.outcome}`}>{outcomeLabel(outcome.outcome, true)}</span><strong>{outcome.key} · {outcome.title}</strong><span>{statusMeta(data, projectId, outcome.fromStatus).label} / {statusMeta(data, projectId, outcome.toStatus).label}</span><p>{outcome.reason}</p></div>)}<button className="btn btn-ghost" disabled={busy} onClick={() => setPreview(null)} type="button">미리보기 닫기</button></div>}</form>
    {!creating && <p className="automation-editor-meta">버전 {version} · 마지막 활성화 {time(rule?.enabledAt || null)} · 연결 {rule?.gitlabBaseUrl || '미설정'}</p>}
  </section>;
}

function outcomeLabel(value: AutomationRun['outcome'], preview: boolean) { return value === 'changed' ? preview ? '변경 예정' : '변경됨' : value === 'no_op' ? '변경 없음' : value === 'blocked' ? '차단됨' : '대상 아님'; }
function Select({ ariaLabel, value, onChange, children }: { ariaLabel: string; value: string; onChange: (value: string) => void; children: ReactNode }) { return <span className="automation-select"><select className="field" aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)}>{children}</select><ChevronDown size={16} aria-hidden="true" /></span>; }
