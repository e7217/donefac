'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowDown, ArrowUp, ChevronDown, ListFilter, Plus, RefreshCw, Save, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { CustomFieldDefinition, CustomFieldKind, CustomFieldOption, CustomFieldVisibility, FeatureProps, IssueTypeDefinition, ProjectIssueSchema } from '../../shared/types';
import { fieldScopeCovers, hasCustomValue, projectIssueSchema } from '../../shared/issue-schema';
import { projectStatuses } from '../../shared/workflow-helpers';
import { api, patch } from '../lib/api';
import { afterAcceptedNavigation, isSettingsSectionNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './issue-schema-settings.css';

const FIELD_KINDS: Record<CustomFieldKind, string> = { text: '텍스트', number: '숫자', date: '날짜', select: '단일 선택', multi_select: '여러 항목 선택', checkbox: '체크박스', user: '팀원', url: 'URL' };
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
function reordered<T>(values: T[], index: number, delta: number) { const next = [...values]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; }

export function IssueSchemaSettings(props: FeatureProps) {
  if (!props.data.projects.some(project => project.id === props.projectId)) return null;
  return <SchemaEditor key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function SchemaEditor({ data, projectId, refresh, notify }: FeatureProps) {
  const [draft, setDraft] = useState<ProjectIssueSchema>(() => structuredClone(projectIssueSchema(data, projectId)));
  const [baseline, setBaseline] = useState<ProjectIssueSchema>(() => structuredClone(projectIssueSchema(data, projectId)));
  const [tab, setTab] = useState<'types' | 'fields'>('types');
  const [expandedFields, setExpandedFields] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirtyRef = useRef(false), pendingRef = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const remote = data.issueSchemas?.find(value => value.projectId === projectId);
  const remoteChanged = Boolean(remote && remote.version > baseline.version);
  const issues = data.issues.filter(value => value.projectId === projectId);
  const workflow = data.workflows?.find(value => value.projectId === projectId);
  const statusNames = Object.fromEntries(projectStatuses(data, projectId).map(status => [status.id, status.label]));
  const fieldById = new Map(draft.fields.map(field => [field.id, field]));
  if (remote && remoteChanged && !dirty && !loading && !saving) { setDraft(structuredClone(remote)); setBaseline(structuredClone(remote)); setError(''); }
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    let active = true;
    api<ProjectIssueSchema>(`/projects/${projectId}/issue-schema`).then(value => { if (active) { setDraft(value); setBaseline(value); } }).catch(err => { if (active) setError(errorMessage(err)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pendingRef.current) { event.preventDefault(); notify('업무 속성 설정 처리가 끝난 뒤 이동해 주세요.', 'error'); }
      else if (isSettingsSectionNavigation(event)) return;
      else if (dirtyRef.current) {
        if (!window.confirm('저장하지 않은 업무 유형·속성 설정을 버리고 이동할까요?')) event.preventDefault();
        else afterAcceptedNavigation(event, () => { dirtyRef.current = false; setDraft(structuredClone(baseline)); setError(''); });
      }
    };
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current || pendingRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('donefac:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('donefac:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [baseline, notify]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (pendingRef.current) return; pendingRef.current = true; setSaving(true); setError('');
    try { const value = await patch<ProjectIssueSchema>(`/projects/${projectId}/issue-schema`, { ...draft, expectedVersion: draft.version }); setDraft(value); setBaseline(value); dirtyRef.current = false; await refresh(); notify('업무 유형과 사용자 정의 속성을 저장했습니다.'); }
    catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setSaving(false); }
  }
  async function reload() {
    if (pendingRef.current || (dirtyRef.current && !window.confirm('작성 중인 유형·속성 설정을 버리고 최신 설정을 불러올까요?'))) return;
    pendingRef.current = true; setLoading(true); setError('');
    try { const value = await api<ProjectIssueSchema>(`/projects/${projectId}/issue-schema`); setDraft(value); setBaseline(value); dirtyRef.current = false; await refresh(); }
    catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setLoading(false); }
  }
  function updateType(index: number, changes: Partial<IssueTypeDefinition>) { setDraft(previous => ({ ...previous, issueTypes: previous.issueTypes.map((value, row) => row === index ? { ...value, ...changes } : value) })); }
  function renameTypeId(index: number, id: string) { if (draft.issueTypes.some((value, row) => row !== index && value.id === id) || baseline.issueTypes.some(value => value.id === id && value.id !== draft.issueTypes[index].id)) { setError('이미 사용한 유형 ID입니다. 새 고유 ID를 입력하세요.'); return; } setDraft(previous => { const oldId = previous.issueTypes[index].id; return { ...previous, issueTypes: previous.issueTypes.map((value, row) => row === index ? { ...value, id } : value), fields: previous.fields.map(field => ({ ...field, issueTypes: field.issueTypes.map(value => value === oldId ? id : value) })) }; }); }
  function updateField(index: number, changes: Partial<CustomFieldDefinition>) { setDraft(previous => ({ ...previous, fields: previous.fields.map((value, row) => row === index ? { ...value, ...changes } : value) })); }
  function renameFieldId(index: number, id: string) {
    const oldId = draft.fields[index].id;
    if (draft.fields.some((value, row) => row !== index && value.id === id) || baseline.fields.some(value => value.id === id && value.id !== oldId)) {
      setError('이미 사용한 속성 ID입니다. 새 고유 ID를 입력하세요.');
      return;
    }
    setDraft(previous => ({ ...previous, fields: previous.fields.map((field, row) => {
      if (row === index) return { ...field, id };
      const rule = field.visibleWhen;
      const match = rule?.fieldMatch;
      return rule && match?.fieldId === oldId ? { ...field, visibleWhen: { ...rule, fieldMatch: { ...match, fieldId: id } } } : field;
    }) }));
    setExpandedFields(previous => { const next = new Set(previous); if (next.delete(oldId)) next.add(id); return next; });
  }
  function addField() { const id = newId('field'); setDraft(previous => ({ ...previous, fields: [...previous.fields, { id, name: '새 속성', description: '', kind: 'text', required: false, issueTypes: [], options: [], archived: false }] })); setExpandedFields(previous => new Set(previous).add(id)); }
  function updateOption(fieldIndex: number, index: number, changes: Partial<CustomFieldOption>) { setDraft(previous => ({ ...previous, fields: previous.fields.map((field, row) => row === fieldIndex ? { ...field, options: field.options.map((value, at) => at === index ? { ...value, ...changes } : value) } : field) })); }
  function renameOptionId(fieldIndex: number, index: number, id: string) {
    const source = draft.fields[fieldIndex], oldId = source.options[index].id;
    const saved = baseline.fields.find(value => value.id === source.id);
    if (source.options.some((value, row) => row !== index && value.id === id) || saved?.options.some(value => value.id === id && value.id !== oldId)) {
      setError('이미 사용한 선택 항목 ID입니다. 새 고유 ID를 입력하세요.');
      return;
    }
    setDraft(previous => ({ ...previous, fields: previous.fields.map((field, row) => {
      if (row === fieldIndex) return { ...field, options: field.options.map((option, at) => at === index ? { ...option, id } : option) };
      const rule = field.visibleWhen;
      const match = rule?.fieldMatch;
      return rule && match?.fieldId === source.id && match.value === oldId ? { ...field, visibleWhen: { ...rule, fieldMatch: { ...match, value: id } } } : field;
    }) }));
  }
  function references(fieldId: string) { const id = `custom:${fieldId}` as const; return (workflow?.fieldRules.filter(rule => rule.requiredFields.includes(id)).length || 0) + (workflow?.transitions.filter(edge => edge.requiredFields.includes(id)).length || 0); }
  function typeReferences(typeId: string) { return (workflow?.fieldRules.filter(rule => rule.issueType === typeId).length || 0) + (workflow?.transitions.filter(edge => edge.issueTypes.includes(typeId)).length || 0); }
  const typeNames = Object.fromEntries(draft.issueTypes.map(value => [value.id, `${value.name}${value.archived ? ' (보관됨)' : ''}`]));

  return <section className="card issue-schema-settings" aria-label="업무 유형·사용자 정의 속성 설정">
    <header><div><h2><SlidersHorizontal size={18} />업무 유형 · 사용자 정의 속성</h2><p>팀에서 사용하는 업무 유형과 입력 항목을 프로젝트별로 설정하세요.</p></div><span>버전 {draft.version}{dirty ? ' · 저장 필요' : ''}</span></header>
    <form onSubmit={save}>
      {remoteChanged && dirty && <div className="issue-form-error issue-schema-remote" role="alert">다른 작업자가 유형·속성 설정을 버전 {remote?.version}(으)로 변경했습니다. 작성 중인 입력은 버전 {baseline.version} 기준으로 유지됩니다.</div>}
      <fieldset disabled={loading || saving}>
        <nav className="issue-schema-tabs" aria-label="업무 속성 설정 종류"><button type="button" className={tab === 'types' ? 'active' : ''} onClick={() => setTab('types')}>업무 유형 <span>{draft.issueTypes.length}</span></button><button type="button" className={tab === 'fields' ? 'active' : ''} onClick={() => setTab('fields')}>사용자 정의 속성 <span>{draft.fields.length}</span></button></nav>
        {tab === 'types' && <div className="issue-schema-content"><div className="issue-schema-description"><p>이름과 순서는 바꿀 수 있습니다. 저장된 ID는 고정되며 보관한 유형은 새 업무에 선택할 수 없습니다.</p><button className="btn" type="button" disabled={draft.issueTypes.length >= 50} onClick={() => setDraft(previous => ({ ...previous, issueTypes: [...previous.issueTypes, { id: newId('type'), name: '새 유형', color: '#588b9c', archived: false }] }))}><Plus size={14} />업무 유형 추가</button></div><div className="issue-schema-table-scroll"><table className="issue-schema-type-table"><thead><tr><th>순서</th><th>유형 이름</th><th>고유 ID</th><th>색상</th><th>보관</th><th>사용 중</th><th /></tr></thead><tbody>{draft.issueTypes.map((type, index) => {
          const existing = baseline.issueTypes.some(value => value.id === type.id), used = issues.filter(value => value.type === type.id).length, referenced = typeReferences(type.id), scoped = draft.fields.some(field => field.issueTypes.includes(type.id));
          return <tr key={index} className={type.archived ? 'is-archived' : ''}><td><OrderButtons name={`유형 ${index + 1}`} index={index} count={draft.issueTypes.length} move={delta => setDraft(previous => ({ ...previous, issueTypes: reordered(previous.issueTypes, index, delta) }))} /></td><td><input className="field" aria-label={`유형 ${index + 1} 이름`} value={type.name} maxLength={120} required onChange={event => updateType(index, { name: event.target.value })} /></td><td><input className="field issue-schema-id" aria-label={`유형 ${index + 1} ID`} value={type.id} readOnly={existing} maxLength={48} pattern={existing ? undefined : '[a-z][a-z0-9_-]*'} required onChange={event => renameTypeId(index, event.target.value)} title={existing ? '저장된 ID는 고정됩니다.' : '영문 소문자로 시작하며 숫자·밑줄·하이픈을 사용할 수 있습니다.'} /></td><td><input type="color" aria-label={`유형 ${index + 1} 색상`} value={type.color} onChange={event => updateType(index, { color: event.target.value })} /></td><td><label className="issue-schema-archive"><input type="checkbox" aria-label={`유형 ${index + 1} 보관`} checked={type.archived} onChange={event => updateType(index, { archived: event.target.checked })} /><Archive size={12} />{type.archived ? '보관됨' : '사용'}</label></td><td><span className="issue-schema-usage">업무 {used}개{referenced > 0 && <small>규칙 {referenced}개</small>}</span></td><td><button className="issue-icon-button" type="button" aria-label={`유형 ${index + 1} 삭제`} disabled={draft.issueTypes.length <= 1 || used > 0 || referenced > 0 || scoped} title={used || referenced || scoped ? '업무·규칙·속성 범위에서 사용하는 유형은 보관하세요.' : '유형 삭제'} onClick={() => setDraft(previous => ({ ...previous, issueTypes: previous.issueTypes.filter((_, row) => row !== index) }))}><Trash2 size={14} /></button></td></tr>;
        })}</tbody></table></div></div>}
        {tab === 'fields' && <div className="issue-schema-content"><div className="issue-schema-description"><p>속성의 형식은 저장 후 고정됩니다. 필수·적용 유형은 다음 업무 수정부터 검사하며 기존 값은 보존됩니다.</p><button className="btn" type="button" disabled={draft.fields.length >= 100} onClick={addField}><Plus size={14} />속성 추가</button></div><div className="issue-schema-field-list">{draft.fields.map((field, index) => {
          const saved = baseline.fields.find(value => value.id === field.id), used = issues.filter(value => hasCustomValue(value.customFields?.[field.id])).length, referenced = references(field.id), expanded = expandedFields.has(field.id);
          const dependents = draft.fields.filter(item => !item.archived && item.visibleWhen?.fieldMatch?.fieldId === field.id);
          const visibilityReferenceMessage = dependents.length ? '이 속성을 사용하는 표시 조건을 먼저 변경하세요.' : undefined;
          return <article className={`issue-schema-field ${field.archived ? 'is-archived' : ''}`} key={index}><div className="issue-schema-field-heading"><OrderButtons name={`속성 ${index + 1}`} index={index} count={draft.fields.length} move={delta => setDraft(previous => ({ ...previous, fields: reordered(previous.fields, index, delta) }))} /><button className="issue-schema-field-title" type="button" aria-label={`속성 ${index + 1} 세부 설정`} aria-expanded={expanded} onClick={() => setExpandedFields(previous => { const next = new Set(previous); if (!next.delete(field.id)) next.add(field.id); return next; })}><ListFilter size={15} /><strong>{field.name || '이름 없는 속성'}</strong><span>{FIELD_KINDS[field.kind]}</span>{field.required && <small>필수</small>}{field.archived && <small>보관됨</small>}<ChevronDown size={14} /></button><span className="issue-schema-usage">업무 {used}개{referenced > 0 && <small>규칙 {referenced}개</small>}{dependents.length > 0 && <small>표시 조건 {dependents.length}개</small>}</span><button className="issue-icon-button" type="button" aria-label={`속성 ${index + 1} 삭제`} disabled={used > 0 || referenced > 0 || dependents.length > 0} title={visibilityReferenceMessage ?? (used || referenced ? '값이나 규칙이 있는 속성은 보관하세요.' : '속성 삭제')} onClick={() => setDraft(previous => ({ ...previous, fields: previous.fields.filter((_, row) => row !== index) }))}><Trash2 size={15} /></button></div>
            {expanded && <div className="issue-schema-field-body"><div className="issue-schema-field-grid"><label>속성 이름<input className="field" aria-label={`속성 ${index + 1} 이름`} value={field.name} maxLength={120} required onChange={event => updateField(index, { name: event.target.value })} /></label><label>고유 ID<input className="field issue-schema-id" aria-label={`속성 ${index + 1} ID`} value={field.id} maxLength={48} pattern="[a-z][a-z0-9_-]*" required readOnly={Boolean(saved)} onChange={event => renameFieldId(index, event.target.value)} /></label><label>형식<select className="field" aria-label={`속성 ${index + 1} 형식`} value={field.kind} disabled={Boolean(saved)} title={saved ? '저장된 속성 형식은 고정됩니다.' : undefined} onChange={event => { const kind = event.target.value as CustomFieldKind; updateField(index, { kind, options: kind === 'select' || kind === 'multi_select' ? field.options : [] }); }}>{Object.entries(FIELD_KINDS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>적용 유형<ScopeSelect label={`속성 ${index + 1} 적용 유형`} options={typeNames} value={field.issueTypes} onChange={issueTypes => updateField(index, { issueTypes })} /></label><label className="issue-schema-wide">설명<textarea className="field" aria-label={`속성 ${index + 1} 설명`} maxLength={20000} value={field.description} onChange={event => updateField(index, { description: event.target.value })} rows={2} /></label></div><div className="issue-schema-field-flags"><label><input type="checkbox" aria-label={`속성 ${index + 1} 필수`} checked={field.required} onChange={event => updateField(index, { required: event.target.checked })} />표시될 때 필수</label><label><input type="checkbox" aria-label={`속성 ${index + 1} 보관`} disabled={!field.archived && (referenced > 0 || dependents.length > 0)} title={visibilityReferenceMessage ?? (referenced ? '워크플로 필수 규칙을 먼저 해제하세요.' : undefined)} checked={field.archived} onChange={event => updateField(index, { archived: event.target.checked })} /><Archive size={12} />{field.archived ? '보관됨 · 기존 값 유지' : '속성 보관'}</label></div>
              <VisibilitySettings label={`속성 ${index + 1}`} field={field} fields={fieldById} statuses={statusNames}
                onChange={visibleWhen => updateField(index, { visibleWhen })} />
              {(field.kind === 'select' || field.kind === 'multi_select') && <div className="issue-schema-options"><div><h3>선택 항목 <span>{field.options.length}</span></h3><button className="btn btn-ghost" type="button" disabled={field.options.length >= 200} onClick={() => updateField(index, { options: [...field.options, { id: newId('option'), name: '새 항목', archived: false }] })}><Plus size={13} />선택 항목 추가</button></div>{field.options.map((option, optionIndex) => {
                const optionSaved = saved?.options.some(value => value.id === option.id), optionUsed = issues.filter(issue => { const value = issue.customFields?.[field.id]; return value === option.id || Array.isArray(value) && value.includes(option.id); }).length;
                const optionReferenced = dependents.some(item => item.visibleWhen?.fieldMatch?.value === option.id);
                const optionReferenceMessage = optionReferenced ? '이 항목을 사용하는 표시 조건을 먼저 변경하세요.' : undefined;
                return <div className="issue-schema-option-row" key={optionIndex}><OrderButtons name={`속성 ${index + 1} 항목 ${optionIndex + 1}`} index={optionIndex} count={field.options.length} move={delta => updateField(index, { options: reordered(field.options, optionIndex, delta) })} /><input className="field" aria-label={`속성 ${index + 1} 항목 ${optionIndex + 1} 이름`} value={option.name} maxLength={120} required onChange={event => updateOption(index, optionIndex, { name: event.target.value })} /><input className="field issue-schema-id" aria-label={`속성 ${index + 1} 항목 ${optionIndex + 1} ID`} value={option.id} maxLength={48} pattern="[a-z][a-z0-9_-]*" readOnly={Boolean(optionSaved)} required onChange={event => renameOptionId(index, optionIndex, event.target.value)} /><label className="issue-schema-archive"><input type="checkbox" aria-label={`속성 ${index + 1} 항목 ${optionIndex + 1} 보관`} checked={option.archived} disabled={!option.archived && optionReferenced} title={optionReferenceMessage} onChange={event => updateOption(index, optionIndex, { archived: event.target.checked })} />보관</label><span className="issue-schema-option-usage">{optionUsed}개</span><button className="issue-icon-button" type="button" aria-label={`속성 ${index + 1} 항목 ${optionIndex + 1} 삭제`} disabled={optionUsed > 0 || optionReferenced} title={optionReferenceMessage ?? (optionUsed ? '사용 중인 항목은 보관하세요.' : '선택 항목 삭제')} onClick={() => updateField(index, { options: field.options.filter((_, at) => at !== optionIndex) })}><Trash2 size={13} /></button></div>;
              })}{!field.options.length && <p className="issue-schema-empty">선택 항목을 추가하고 이름을 입력하세요.</p>}</div>}
            </div>}
          </article>;
        })}{!draft.fields.length && <div className="issue-schema-empty"><SlidersHorizontal size={24} /><p>팀에 필요한 값을 업무에 추가하세요.</p><span>텍스트, 숫자, 날짜, 선택 항목, 체크박스, 팀원, URL을 지원합니다.</span></div>}</div></div>}
      </fieldset>
      {error && <div className="issue-form-error issue-schema-error" role="alert">{error} 입력한 설정은 유지됩니다.</div>}
      <footer><span>{loading ? '업무 속성을 불러오는 중…' : '사용 중인 항목은 삭제 대신 보관하세요. 표시 이름과 값의 연결은 ID로 유지됩니다.'}</span><button className="btn" type="button" disabled={loading || saving} onClick={reload}><RefreshCw size={14} />최신 유형·속성 불러오기</button><button className="btn btn-primary" type="submit" disabled={loading || saving || !dirty}><Save size={14} />{saving ? '저장 중…' : '유형·속성 저장'}</button></footer>
    </form>
  </section>;
}

function OrderButtons({ name, index, count, move }: { name: string; index: number; count: number; move: (delta: number) => void }) { return <div className="issue-schema-order"><button className="issue-icon-button" type="button" aria-label={`${name} 위로`} disabled={index === 0} onClick={() => move(-1)}><ArrowUp size={12} /></button><button className="issue-icon-button" type="button" aria-label={`${name} 아래로`} disabled={index === count - 1} onClick={() => move(1)}><ArrowDown size={12} /></button></div>; }

function ScopeSelect({ label, options, value, onChange, emptyLabel = '모든 유형', help = '선택하지 않으면 모든 유형에 적용합니다.' }: {
  label: string;
  options: Record<string, string>;
  value: string[];
  onChange: (value: string[]) => void;
  emptyLabel?: string;
  help?: string;
}) {
  return <details className="issue-schema-scope">
    <summary aria-label={label}><span>{value.length ? value.map(id => options[id] || id).join(', ') : emptyLabel}</span><ChevronDown size={12} /></summary>
    <div><p>{help}</p>{Object.entries(options).map(([id, name]) => <label key={id}>
      <input type="checkbox" aria-label={`${label} · ${name}`} checked={value.includes(id)}
        onChange={event => onChange(event.target.checked ? [...value, id] : value.filter(item => item !== id))} />{name}
    </label>)}</div>
  </details>;
}

function leadsToField(start: CustomFieldDefinition, targetId: string, fields: Map<string, CustomFieldDefinition>) {
  const visited = new Set<string>();
  let field: CustomFieldDefinition | undefined = start;
  while (field && !visited.has(field.id)) {
    if (field.id === targetId) return true;
    visited.add(field.id);
    const match: CustomFieldVisibility['fieldMatch'] | undefined = field.visibleWhen?.fieldMatch;
    field = match ? fields.get(match.fieldId) : undefined;
  }
  return false;
}

function VisibilitySettings({ label, field, fields, statuses, onChange }: {
  label: string;
  field: CustomFieldDefinition;
  fields: Map<string, CustomFieldDefinition>;
  statuses: Record<string, string>;
  onChange: (rule: CustomFieldVisibility | undefined) => void;
}) {
  const rule: CustomFieldVisibility = field.visibleWhen ?? { statusIds: [], fieldMatch: null };
  const controllers = [...fields.values()].filter(candidate => candidate.id && !candidate.archived
    && (candidate.kind === 'checkbox' || candidate.kind === 'select' && candidate.options.some(option => !option.archived))
    && fieldScopeCovers(candidate, field) && !leadsToField(candidate, field.id, fields));
  const match = rule.fieldMatch;
  const source = match ? fields.get(match.fieldId) : undefined;
  const availableSource = controllers.some(candidate => candidate.id === source?.id);
  const missingStatuses = rule.statusIds.filter(id => !Object.hasOwn(statuses, id));
  const statusOptions = { ...statuses, ...Object.fromEntries(missingStatuses.map(id => [id, `${id} (사용할 수 없음)`])) };
  const options = source?.kind === 'select' ? source.options.filter(option => option.id && !option.archived) : [];
  const selectValue = typeof match?.value === 'string' ? match.value : '_invalid';
  const staleValue = Boolean(match && match.value !== '' && (source?.kind === 'checkbox'
    ? typeof match.value !== 'boolean'
    : source?.kind === 'select' && (typeof match.value !== 'string' || !options.some(option => option.id === match.value))));

  function update(next: CustomFieldVisibility) {
    onChange(next.statusIds.length || next.fieldMatch ? next : undefined);
  }

  return <section className="issue-schema-visibility" aria-label={`${label} 표시 조건`}>
    <div className="issue-schema-visibility-heading">
      <h3>표시 조건</h3>
      {(rule.statusIds.length > 0 || match) && <button className="btn btn-ghost" type="button"
        aria-label={`${label} 표시 조건 지우기`} onClick={() => onChange(undefined)}>조건 지우기</button>}
    </div>
    <p>업무 상태와 기준 값이 모두 맞으면 표시합니다. 기존 값은 계속 보존되며 워크플로에서 필수로 지정한 속성은 표시됩니다.</p>
    <div className="issue-schema-visibility-grid">
      <div className="issue-schema-visibility-status"><span>표시 상태</span>
        <ScopeSelect label={`${label} 표시 상태`} options={statusOptions} value={rule.statusIds} emptyLabel="모든 상태"
          help="선택하지 않으면 모든 상태에 표시합니다." onChange={statusIds => update({ ...rule, statusIds })} />
      </div>
      <label>기준 속성<select className="field" aria-label={`${label} 표시 기준 속성`} value={match?.fieldId ?? ''}
        onChange={event => {
          const fieldId = event.target.value;
          update({ ...rule, fieldMatch: fieldId ? { fieldId, value: '' } : null });
        }}>
        <option value="">기준 속성 없음</option>
        {match && !availableSource && <option disabled value={match.fieldId}>{source?.name || match.fieldId} (사용할 수 없음)</option>}
        {controllers.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.id}</option>)}
      </select></label>
      {match && source?.kind === 'checkbox' && <label>기준 값<select className="field" aria-label={`${label} 표시 기준 값`}
        required={availableSource && match.value === ''} value={typeof match.value === 'boolean' ? String(match.value) : ''}
        onChange={event => update({ ...rule, fieldMatch: { ...match, value: event.target.value === 'true' } })}>
        <option value="" disabled>{staleValue ? `${String(match.value)} (사용할 수 없음)` : '기준 값 선택'}</option>
        <option value="true">예</option><option value="false">아니요</option>
      </select></label>}
      {match && source?.kind === 'select' && <label>기준 값<select className="field" aria-label={`${label} 표시 기준 값`}
        required={availableSource && match.value === ''} value={selectValue}
        onChange={event => update({ ...rule, fieldMatch: { ...match, value: event.target.value } })}>
        <option value="" disabled>기준 값 선택</option>
        {staleValue && <option value={selectValue} disabled>{source.options.find(option => option.id === match.value)?.name || String(match.value)} (사용할 수 없음)</option>}
        {options.map(option => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}
      </select></label>}
    </div>
    {missingStatuses.length > 0 && <p className="issue-schema-visibility-warning" role="status">현재 프로젝트에 없는 상태를 조건에서 선택 해제하세요.</p>}
    {match && (!availableSource || staleValue) && <p className="issue-schema-visibility-warning" role="status">
      {availableSource ? '현재 설정에서 사용할 수 없는 기준 값입니다. 기준 값을 다시 선택하세요.' : '현재 설정에서 사용할 수 없는 기준 속성입니다. 기준 속성을 다시 선택하세요.'}
    </p>}
  </section>;
}
