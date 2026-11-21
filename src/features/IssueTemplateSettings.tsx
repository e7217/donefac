'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FilePlus, ListChecks, Plus } from 'lucide-react';
import { PRIORITY, type CustomFieldValue, type FeatureProps, type IssueTemplate, type IssueTemplateDefaults } from '../../shared/types';
import { fieldApplies, hasCustomValue, issueTypeMeta, projectIssueSchema } from '../../shared/issue-schema';
import { api, ApiError, patch, post } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { CustomFieldInput, initialIssueType, IssueTypeSelect } from './CustomFields';
import { IssueDescriptionEditor } from './IssueDescriptionEditor';
import { isAvailableTemplateFieldValue } from './issue-template-fields';
import { errorMessage } from './schedule-utils';
import './issue-templates.css';

type Draft = { name: string } & (
  { mode: 'direct'; template?: IssueTemplate; defaults: IssueTemplateDefaults; labels: string } |
  { mode: 'capture'; sourceIssueId: string; expectedIssueVersion?: number }
);

const LABEL_SEPARATOR = ', ';

function editDraft(template: IssueTemplate): Draft {
  const labels = template.defaults.labels.join(LABEL_SEPARATOR).replace(/[\r\n]/g, '');
  return { mode: 'direct', name: template.name, template, defaults: template.defaults, labels };
}

export function IssueTemplateSettings(props: FeatureProps) {
  if (!props.data.projects.some(project => project.id === props.projectId)) return null;
  return <ProjectIssueTemplates key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectIssueTemplates({ data, projectId, refresh, notify }: FeatureProps) {
  const sectionId = useId();
  const path = `/projects/${encodeURIComponent(projectId)}/issue-templates`;
  const [templates, setTemplates] = useState<IssueTemplate[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [request, setRequest] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const pending = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const selected = draft?.mode === 'direct' ? draft.template : undefined;
  const latest = selected && templates?.find(template => template.id === selected.id);
  const projectIssues = data.issues.filter(issue => issue.projectId === projectId);
  const schema = projectIssueSchema(data, projectId);

  const reload = useCallback(() => {
    setLoadError('');
    setTemplates(null);
    setRequest(previous => previous + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<IssueTemplate[]>(`${path}?includeArchived=1`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setTemplates(result); })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(errorMessage(cause)); });
    return () => controller.abort();
  }, [path, request]);

  useEffect(() => {
    window.addEventListener('teamspace:workspace-imported', reload);
    return () => window.removeEventListener('teamspace:workspace-imported', reload);
  }, [reload]);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('업무 템플릿 저장이 끝난 뒤 이동해 주세요.', 'error');
      } else if (dirty) {
        if (!window.confirm('저장하지 않은 업무 템플릿을 버리고 이동할까요?')) event.preventDefault();
        else afterAcceptedNavigation(event, () => {
          setDraft(null);
          setBaseline(null);
          setError('');
          setConflict(false);
        });
      }
    }
    function unload(event: BeforeUnloadEvent) {
      if (!dirty && !pending.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, notify]);

  function openDraft(next: Draft | null) {
    if (pending.current || (dirty && !window.confirm('저장하지 않은 업무 템플릿을 버릴까요?'))) return;
    setDraft(next);
    setBaseline(next);
    setError('');
    setConflict(false);
    if (next) requestAnimationFrame(() => nameInput.current?.focus());
  }

  function createDraft() {
    openDraft({ mode: 'direct', name: '', labels: '', defaults: {
      title: '', description: '', descriptionFormat: 'plain', type: initialIssueType(data, projectId),
      priority: 'medium', labels: [], customFields: {},
    } });
  }

  function updateDefaults(changes: Partial<IssueTemplateDefaults>) {
    setDraft(previous => previous?.mode === 'direct' ? { ...previous, defaults: { ...previous.defaults, ...changes } } : previous);
  }

  function updateCustomField(id: string, value: CustomFieldValue) {
    if (draft?.mode !== 'direct') return;
    const customFields = { ...draft.defaults.customFields };
    if (hasCustomValue(value)) Object.defineProperty(customFields, id, { value, enumerable: true, configurable: true, writable: true });
    else delete customFields[id];
    updateDefaults({ customFields });
  }

  async function mutate(task: () => Promise<IssueTemplate>, message: string, closeEditor: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const result = await task();
      setTemplates(current => [...(current ?? []).filter(template => template.id !== result.id), result]
        .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, 'ko')));
      if (closeEditor) {
        setDraft(null);
        setBaseline(null);
      }
      notify(message);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        reload();
        if (draft?.mode === 'capture') void refresh().catch(() => {});
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !draft.name.trim()) return;
    const name = draft.name.trim();
    if (draft.mode === 'capture') {
      const { sourceIssueId, expectedIssueVersion } = draft;
      if (!sourceIssueId || !expectedIssueVersion) return;
      await mutate(() => post<IssueTemplate>(path, { name, sourceIssueId, expectedIssueVersion }), '기존 업무에서 템플릿을 만들었습니다.', true);
      return;
    }
    const { template, defaults, labels } = draft;
    const labelsArray = labels === (baseline?.mode === 'direct' ? baseline.labels : '') ? defaults.labels
      : labels.split(',').map(label => label.trim()).filter(Boolean);
    const payload = { name, defaults: { ...defaults, labels: labelsArray } };
    const defaultsChanged = !template || JSON.stringify(payload.defaults) !== JSON.stringify(template.defaults);
    await mutate(() => template
      ? patch<IssueTemplate>(`${path}/${encodeURIComponent(template.id)}`, {
        name, expectedVersion: template.version, ...(defaultsChanged ? { defaults: payload.defaults } : {}),
      })
      : post<IssueTemplate>(path, payload), '업무 템플릿을 저장했습니다.', true);
  }

  function toggleArchived(template: IssueTemplate) {
    const archived = !template.archived;
    const closesDraft = selected?.id === template.id;
    if (pending.current || (closesDraft && dirty && !window.confirm('저장하지 않은 업무 템플릿을 버릴까요?'))) return;
    void mutate(() => patch<IssueTemplate>(`${path}/${encodeURIComponent(template.id)}`, { archived, expectedVersion: template.version }),
      archived ? '업무 템플릿을 보관했습니다.' : '업무 템플릿을 복원했습니다.', closesDraft);
  }

  const direct = draft?.mode === 'direct' ? draft : null;
  const availableFields = direct ? schema.fields.filter(field => !field.archived && fieldApplies(field, direct.defaults.type)) : [];
  const unavailableFieldIds = direct ? Object.keys(direct.defaults.customFields)
    .filter(id => !availableFields.some(field => field.id === id)) : [];
  const source = draft?.mode === 'capture' ? projectIssues.find(issue => issue.id === draft.sourceIssueId) : undefined;
  const updatedSource = draft?.mode === 'capture' && source && source.version !== draft.expectedIssueVersion;

  return <section className="card settings-card issue-template-settings" aria-labelledby={sectionId}>
    <div className="card-heading"><h2 id={sectionId}><ListChecks size={19} />업무 템플릿</h2></div>
    <div className="issue-template-actions">
      <button type="button" className="btn" disabled={busy || !templates} onClick={createDraft}><Plus size={15} />새 템플릿</button>
      <button type="button" className="btn" disabled={busy || !templates || !projectIssues.length}
        onClick={() => openDraft({ mode: 'capture', name: '', sourceIssueId: '' })}><FilePlus size={15} />기존 업무에서 만들기</button>
    </div>
    {!templates && !loadError && <p role="status">템플릿을 불러오는 중입니다.</p>}
    {loadError && <div className="issue-template-actions">
      <p role="alert">{loadError}</p>
      <button type="button" className="btn" disabled={busy} onClick={reload}>템플릿 다시 불러오기</button>
    </div>}
    {templates?.length === 0 && <p className="muted">등록한 템플릿이 없습니다.</p>}
    {Boolean(templates?.length) && <ul className="issue-template-list" aria-label="프로젝트 템플릿">
      {templates?.map(template => <li key={template.id}>
        <div>
          <strong>{template.name}</strong>
          <p>{issueTypeMeta(data, projectId, template.defaults.type).name} · {PRIORITY[template.defaults.priority]}{template.archived && ' · 보관됨'}</p>
        </div>
        <div className="issue-template-actions">
          <button type="button" className="btn btn-ghost" aria-label={`${template.name} 편집`} disabled={busy}
            onClick={() => openDraft(editDraft(template))}>편집</button>
          <button type="button" className="btn btn-ghost" aria-label={`${template.name} ${template.archived ? '복원' : '보관'}`} disabled={busy}
            onClick={() => toggleArchived(template)}>{template.archived ? '복원' : '보관'}</button>
        </div>
      </li>)}
    </ul>}
    {draft && <form className="issue-template-editor" onSubmit={save}>
      <h3>{draft.mode === 'capture' ? '기존 업무에서 만들기' : selected ? '템플릿 편집' : '새 업무 템플릿'}</h3>
      <fieldset disabled={busy}>
        <label className="issue-form-label">템플릿 이름
          <input ref={nameInput} className="field" value={draft.name} maxLength={100} required onChange={event => setDraft({ ...draft, name: event.target.value })} />
        </label>
        {draft.mode === 'capture' && <>
          <label className="issue-form-label">원본 업무
            <select className="field" value={draft.sourceIssueId} required onChange={event => {
              const issue = projectIssues.find(value => value.id === event.target.value);
              setDraft({ ...draft, sourceIssueId: issue?.id ?? '', expectedIssueVersion: issue?.version });
            }}>
              <option value="">업무 선택</option>
              {projectIssues.map(issue => <option value={issue.id} key={issue.id}>{issue.key} · {issue.title}</option>)}
            </select>
          </label>
          {updatedSource && <div className="issue-template-actions">
            <p role="status">원본 업무가 변경됐습니다.</p>
            <button type="button" className="btn" onClick={() => setDraft({ ...draft, expectedIssueVersion: source.version })}>최신 원본 업무 사용</button>
          </div>}
        </>}
        {direct && <>
          <div className="issue-form-grid">
            <label className="issue-form-label issue-grid-wide">기본 제목
              <input className="field" maxLength={300} value={direct.defaults.title} onChange={event => updateDefaults({ title: event.target.value })} />
            </label>
            <label className="issue-form-label">기본 유형
              <IssueTypeSelect data={data} projectId={projectId} value={direct.defaults.type} ariaLabel="기본 유형" onChange={type => updateDefaults({ type })} />
            </label>
            <label className="issue-form-label">기본 우선순위
              <select className="field" value={direct.defaults.priority} onChange={event => updateDefaults({ priority: event.target.value as IssueTemplateDefaults['priority'] })}>
                {Object.entries(PRIORITY).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
              </select>
            </label>
            <label className="issue-form-label issue-grid-wide">기본 라벨
              <input className="field" value={direct.labels} placeholder="쉼표로 구분" onChange={event => setDraft({ ...direct, labels: event.target.value })} />
            </label>
          </div>
          <IssueDescriptionEditor value={direct.defaults.description} format={direct.defaults.descriptionFormat} disabled={busy}
            onChange={description => updateDefaults({ description })} onFormatChange={descriptionFormat => updateDefaults({ descriptionFormat })} />
          {(availableFields.length > 0 || unavailableFieldIds.length > 0) && <section className="custom-fields" aria-label="사용자 정의 기본값">
            <h3>사용자 정의 기본값</h3>
            <div className="custom-fields-grid">
              {availableFields.map(field => {
                const value = Object.hasOwn(direct.defaults.customFields, field.id) ? direct.defaults.customFields[field.id] : null;
                const unavailable = !isAvailableTemplateFieldValue(field, value, data.users);
                return <div className="custom-field" key={field.id}>
                  <div className="custom-field-heading"><span>{field.name}</span>{hasCustomValue(value) && <button type="button" className="btn btn-ghost"
                    aria-label={`기본 ${field.name} 값 지우기`} onClick={() => updateCustomField(field.id, null)}>지우기</button>}</div>
                  <CustomFieldInput field={field} value={value} label={`기본 ${field.name}`} users={data.users}
                    onChange={next => updateCustomField(field.id, next)} />
                  {unavailable && <small role="status">기본값을 사용할 수 없습니다. 가능한 값을 고르거나 지워 주세요.</small>}
                  {field.visibleWhen && <small>업무 양식의 표시 조건을 충족할 때 적용됩니다.</small>}
                </div>;
              })}
              {unavailableFieldIds.map(id => {
                const label = schema.fields.find(field => field.id === id)?.name ?? id;
                return <div className="custom-field is-historical" key={id}>
                  <div className="custom-field-heading"><span>{label} · 현재 유형에 적용 불가</span><button type="button" className="btn btn-ghost"
                    aria-label={`기본 ${label} 값 지우기`} onClick={() => updateCustomField(id, null)}>지우기</button></div>
                </div>;
              })}
            </div>
          </section>}
        </>}
      </fieldset>
      {error && <p className="issue-form-error" role="alert">{error}</p>}
      {conflict && latest && latest.version !== selected?.version && <div className="issue-template-actions">
        <p role="status">최신 버전 {latest.version}을 확인할 수 있습니다.</p>
        <button type="button" className="btn" disabled={busy} onClick={() => openDraft(editDraft(latest))}>최신 템플릿 사용</button>
      </div>}
      <div className="issue-template-actions issue-template-editor-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => openDraft(null)}>취소</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !draft.name.trim() || (draft.mode === 'capture' && (!source || Boolean(updatedSource)))}>
          {busy ? '저장 중…' : '템플릿 저장'}
        </button>
      </div>
    </form>}
    {!draft && error && <p className="issue-form-error" role="alert">{error}</p>}
  </section>;
}
