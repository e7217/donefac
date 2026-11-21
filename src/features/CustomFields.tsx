'use client';

import type { CustomFieldDefinition, CustomFieldValue, Issue, IssueRequiredField, WorkspaceSnapshot } from '../../shared/types';
import { fieldApplies, fieldValueLabel, hasCustomValue, issueTypeMeta, projectIssueSchema, projectIssueTypes, visibleIssueFieldIds } from '../../shared/issue-schema';
import './custom-fields.css';

type FieldValues = Record<string, CustomFieldValue>;
type SchemaData = Pick<WorkspaceSnapshot, 'issueSchemas' | 'users'>;
export function initialIssueType(data: SchemaData, projectId: string) { const types = projectIssueTypes(data, projectId); return types.find(type => type.id === '작업')?.id || types[0]?.id || ''; }
export function IssueTypeSelect({ data, projectId, value, existingType, onChange, disabled, name, ariaLabel = '유형' }: { data: SchemaData; projectId: string; value: string; existingType?: string; onChange: (value: string) => void; disabled?: boolean; name?: string; ariaLabel?: string }) {
  const types = projectIssueTypes(data, projectId, { includeArchived: true }).filter(type => !type.archived || type.id === existingType || type.id === value);
  return <select className="field" aria-label={ariaLabel} name={name} value={value} disabled={disabled} required onChange={event => onChange(event.target.value)}>{!types.some(type => type.id === value) && <option value={value} disabled>{value ? `${value} (현재 사용 불가)` : '유형 선택'}</option>}{types.map(type => <option key={type.id} value={type.id} disabled={type.archived && type.id !== existingType}>{type.name}{type.archived ? ' (보관됨)' : ''}</option>)}</select>;
}
export function IssueTypeName({ data, issue }: { data: SchemaData; issue: Pick<Issue, 'projectId' | 'type'> }) { const meta = issueTypeMeta(data, issue.projectId, issue.type); return <span className="custom-type-name" style={{ color: meta.color }}>{meta.name}{meta.archived ? ' · 보관됨' : ''}</span>; }

export function CustomFields({ data, projectId, issueType, status, values, existingValues = {}, onChange, disabled = false, requiredFields = [], labelPrefix = '' }: { data: SchemaData; projectId: string; issueType: string; status: string; values: FieldValues; existingValues?: FieldValues; onChange: (values: FieldValues) => void; disabled?: boolean; requiredFields?: IssueRequiredField[]; labelPrefix?: string }) {
  const schema = projectIssueSchema(data, projectId);
  const visible = visibleIssueFieldIds(schema, { type: issueType, status, customFields: values });
  const fields = schema.fields.filter(field => {
    if (field.archived || !fieldApplies(field, issueType)) return hasCustomValue(values[field.id]);
    return visible.has(field.id) || requiredFields.includes(`custom:${field.id}`);
  });
  const unknown = Object.keys(values).filter(id => !schema.fields.some(field => field.id === id) && hasCustomValue(values[id]));
  if (!fields.length && !unknown.length) return null;
  const update = (id: string, value: CustomFieldValue) => onChange({ ...values, [id]: value });
  return <section className="custom-fields" aria-label="사용자 정의 속성"><h3>사용자 정의 속성</h3><div className="custom-fields-grid">{fields.map(field => {
    const value = values[field.id] ?? null, historical = field.archived || !fieldApplies(field, issueType);
    const required = !historical && (field.required || requiredFields.includes(`custom:${field.id}`));
    const label = `${labelPrefix}${field.name}`;
    const unpersisted = historical && hasCustomValue(value) && JSON.stringify(value) !== JSON.stringify(existingValues[field.id]);
    return <div className={`custom-field ${historical ? 'is-historical' : ''}`} key={field.id}><div className="custom-field-heading"><span>{field.name}{required && <b aria-label="필수"> *</b>}{historical && <small>{field.archived ? '보관됨' : '현재 유형에 미적용'}</small>}</span>{hasCustomValue(value) && <button className="btn btn-ghost" type="button" disabled={disabled} aria-label={`${label} 값 지우기`} onClick={() => update(field.id, null)}>지우기</button>}</div>{historical ? <><output aria-label={`${label} 기존 값`}>{fieldValueLabel(field, value, data.users) || '미지정'}</output><small>{unpersisted ? '새로 입력한 값은 이 유형에 저장할 수 없습니다. 값을 지우거나 원래 유형으로 돌아가세요.' : '기존 기록으로 보존합니다. 값을 바꾸려면 적용 가능한 유형을 사용하세요.'}</small></> : <CustomFieldInput field={field} value={value} label={label} users={data.users} disabled={disabled} required={required} onChange={next => update(field.id, next)} />}{field.description && <small>{field.description}</small>}</div>;
  })}{unknown.map(id => <div className="custom-field is-historical" key={id}><div className="custom-field-heading"><span>{id} · 정의를 찾을 수 없음</span><button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => { const next = { ...values }; delete next[id]; onChange(next); }} aria-label={`${id} 값 지우기`}>지우기</button></div><output>{String(values[id])}</output><small>입력은 유지됩니다. 최신 프로젝트 설정을 확인하세요.</small></div>)}</div></section>;
}
export function CustomFieldInput({ field, value, label, users, required, disabled, onChange, multipleControl = 'native', errorId }: {
  field: CustomFieldDefinition;
  value: CustomFieldValue;
  label: string;
  users: WorkspaceSnapshot['users'];
  required?: boolean;
  disabled?: boolean;
  onChange: (value: CustomFieldValue) => void;
  multipleControl?: 'native' | 'checkboxes';
  errorId?: string;
}) {
  const accessibility = { 'aria-label': label, 'aria-describedby': errorId, 'aria-invalid': errorId ? true : undefined } as const;
  const common = { className: 'field', ...accessibility, disabled, required };
  if (field.kind === 'checkbox') return <select {...common} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={event => onChange(event.target.value === '' ? null : event.target.value === 'true')}><option value="">미지정</option><option value="true">예</option><option value="false">아니요</option></select>;
  if (field.kind === 'user') return <select {...common} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value || null)}><option value="">미지정</option>{typeof value === 'string' && value && !users.some(user => user.id === value) && <option value={value} disabled>{value} (현재 팀원 없음)</option>}{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select>;
  if (field.kind === 'select' || field.kind === 'multi_select') {
    const selected = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const options = field.options.filter(option => !option.archived || selected.includes(option.id));
    if (field.kind === 'multi_select' && multipleControl === 'checkboxes') {
      const checkboxOptions = [
        ...options.map(option => ({ ...option, name: option.archived ? `${option.name} (보관됨)` : option.name })),
        ...selected.filter(id => !options.some(option => option.id === id)).map(id => ({ id, name: `${id} (현재 옵션 없음)`, archived: true })),
      ];
      return <div className="custom-field-checkbox-input" role="group" {...accessibility}>
        {checkboxOptions.map(option => {
          const checked = selected.includes(option.id);
          return <label className="custom-field-checkbox-option" key={option.id}>
            <input type="checkbox" checked={checked} disabled={disabled || option.archived && !checked}
              onChange={event => {
                const next = new Set(selected);
                if (event.currentTarget.checked) next.add(option.id);
                else next.delete(option.id);
                onChange(checkboxOptions.filter(candidate => next.has(candidate.id)).map(candidate => candidate.id));
              }} />
            <span>{option.name}</span>
          </label>;
        })}
        {!checkboxOptions.length && <small>지정할 수 있는 선택지가 없습니다.</small>}
      </div>;
    }
    return <><select {...common} multiple={field.kind === 'multi_select'} value={field.kind === 'multi_select' ? selected : selected[0] || ''} onChange={event => onChange(field.kind === 'multi_select' ? Array.from(event.target.selectedOptions).map(option => option.value) : event.target.value || null)}>{field.kind === 'select' && <option value="">미지정</option>}{selected.filter(id => !options.some(option => option.id === id)).map(id => <option key={id} value={id} disabled>{id} (현재 옵션 없음)</option>)}{options.map(option => <option key={option.id} value={option.id} disabled={option.archived}>{option.name}{option.archived ? ' (보관됨)' : ''}</option>)}</select>{field.kind === 'multi_select' && <small>Ctrl 또는 ⌘로 여러 항목 선택 · 선택한 보관 옵션은 전체 지우기로 해제할 수 있습니다.</small>}</>;
  }
  return <input {...common} type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : field.kind === 'url' ? 'url' : 'text'} step={field.kind === 'number' ? 'any' : undefined} maxLength={field.kind === 'text' ? 20000 : field.kind === 'url' ? 4000 : undefined} value={typeof value === 'string' || typeof value === 'number' ? value : ''} onChange={event => { const next = event.target.value; if (next === '') onChange(null); else if (field.kind !== 'number') onChange(next); else if (Number.isFinite(Number(next))) onChange(Number(next)); }} />;
}
export function CustomFieldSummary({ data, issue, limit = 3 }: { data: SchemaData; issue: Issue; limit?: number }) {
  const fields = projectIssueSchema(data, issue.projectId).fields.filter(field => hasCustomValue(issue.customFields?.[field.id]));
  if (!fields.length) return null;
  return <span className="custom-field-summary" aria-label="사용자 정의 속성 요약">{fields.slice(0, limit).map(field => <span key={field.id} title={`${field.name}: ${fieldValueLabel(field, issue.customFields![field.id], data.users)}`}><b>{field.name}</b> {fieldValueLabel(field, issue.customFields![field.id], data.users)}</span>)}{fields.length > limit && <span>+{fields.length - limit}</span>}</span>;
}
