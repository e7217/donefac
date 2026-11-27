'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Filter, Plus, Trash2, X } from 'lucide-react';
import type {
  CustomFieldDefinition,
  FeatureProps,
  IssueFieldFilter,
  IssueFieldOperator,
  IssueFieldRule,
  ProjectIssueSchema,
  User,
} from '../../shared/types';
import {
  fieldFilterOperators,
  MAX_FIELD_FILTER_RULES,
  parseIssueFieldFilter,
} from '../../shared/issue-field-filter';
import { afterAcceptedNavigation } from '../lib/navigation';
import './issue-field-filters.css';

export interface IssueFieldFiltersProps {
  schema: ProjectIssueSchema;
  users: User[];
  value: IssueFieldFilter | undefined;
  onApply: (filter: IssueFieldFilter | undefined) => void;
  notify: FeatureProps['notify'];
}

type DraftRule = { id: number; fieldId: string; operator: IssueFieldOperator; input: string };
type Draft = { match: 'all' | 'any'; rules: DraftRule[] };
const OPERATOR_LABELS: Record<IssueFieldOperator, string> = {
  is_set: '값이 있음',
  is_empty: '값이 없음',
  equals: '같음',
  not_equals: '다름',
  contains: '문자열 포함',
  gte: '이상',
  lte: '이하',
  includes: '선택 항목 포함',
  excludes: '선택 항목 제외',
};
const needsValue = (operator: IssueFieldOperator) => operator !== 'is_set' && operator !== 'is_empty';
const copyDraft = (draft: Draft): Draft => ({
  match: draft.match,
  rules: draft.rules.map((rule) => ({ ...rule })),
});
const comparable = (draft: Draft) =>
  JSON.stringify({
    match: draft.match,
    rules: draft.rules.map(({ fieldId, operator, input }) => ({
      fieldId,
      operator,
      input: needsValue(operator) ? input : '',
    })),
  });

function fromFilter(value: IssueFieldFilter | undefined): Draft {
  return {
    match: value?.match ?? 'all',
    rules: (value?.rules ?? []).map((rule, index) => ({
      id: index,
      fieldId: rule.fieldId,
      operator: rule.operator,
      input: rule.value === undefined ? '' : String(rule.value),
    })),
  };
}

function ruleValue(
  rule: DraftRule,
  field: CustomFieldDefinition | undefined,
  index: number,
): IssueFieldRule {
  const result: IssueFieldRule = { fieldId: rule.fieldId, operator: rule.operator };
  if (!needsValue(rule.operator)) return result;
  if (field?.kind === 'number') {
    const raw = rule.input.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) {
      throw new Error(`조건 ${index + 1}에 유효한 숫자를 입력하세요.`);
    }
    result.value = Number(raw);
  } else if (field?.kind === 'checkbox') {
    if (rule.input !== 'true' && rule.input !== 'false')
      throw new Error(`조건 ${index + 1}의 예·아니요 값을 선택하세요.`);
    result.value = rule.input === 'true';
  } else {
    result.value = rule.input;
  }
  return result;
}

export function IssueFieldFilters({ schema, users, value, onApply, notify }: IssueFieldFiltersProps) {
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<Draft>(() => fromFilter(value));
  const [draft, setDraft] = useState<Draft>(() => fromFilter(value));
  const [error, setError] = useState('');
  const dirtyRef = useRef(false);
  const nextId = useRef(value?.rules.length ?? 0);
  const dirty = comparable(draft) !== comparable(baseline);
  const appliedCount = value?.rules.length ?? 0;

  useEffect(() => {
    dirtyRef.current = open && dirty;
  }, [open, dirty]);

  const discard = useCallback(() => {
    setDraft(copyDraft(baseline));
    setError('');
    setOpen(false);
    dirtyRef.current = false;
  }, [baseline]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented || !dirtyRef.current) return;
      if (!window.confirm('적용하지 않은 사용자 정의 필드 필터 입력을 버리고 이동할까요?'))
        event.preventDefault();
      else afterAcceptedNavigation(event, discard);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('donefac:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('donefac:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [discard]);

  function update(next: Draft) {
    setDraft(next);
    setError('');
    dirtyRef.current = comparable(next) !== comparable(baseline);
  }

  function closeEditor() {
    if (dirtyRef.current && !window.confirm('적용하지 않은 필터 입력을 버리고 닫을까요?')) return;
    discard();
  }

  function addRule() {
    if (draft.rules.length >= MAX_FIELD_FILTER_RULES) return;
    const field = schema.fields.find((item) => !item.archived) ?? schema.fields[0];
    if (!field) return;
    const operators = fieldFilterOperators(field.kind);
    const operator = operators.includes('equals')
      ? 'equals'
      : operators.includes('includes')
        ? 'includes'
        : operators[0];
    update({
      ...draft,
      rules: [...draft.rules, { id: nextId.current++, fieldId: field.id, operator, input: '' }],
    });
  }

  function updateRule(id: number, change: Partial<DraftRule>) {
    update({
      ...draft,
      rules: draft.rules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)),
    });
  }

  function changeField(rule: DraftRule, fieldId: string) {
    const field = schema.fields.find((item) => item.id === fieldId);
    if (!field) return;
    const operators = fieldFilterOperators(field.kind);
    updateRule(rule.id, {
      fieldId,
      operator: operators.includes('equals')
        ? 'equals'
        : operators.includes('includes')
          ? 'includes'
          : operators[0],
      input: '',
    });
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    try {
      const rules = draft.rules.map((rule, index) =>
        ruleValue(
          rule,
          schema.fields.find((field) => field.id === rule.fieldId),
          index,
        ),
      );
      const next = rules.length
        ? parseIssueFieldFilter({ match: draft.match, rules }, schema, users)
        : undefined;
      const saved = fromFilter(next);
      setDraft(saved);
      setBaseline(copyDraft(saved));
      nextId.current = saved.rules.length;
      setError('');
      setOpen(false);
      dirtyRef.current = false;
      onApply(next);
      notify(next ? '사용자 정의 필드 필터를 적용했습니다.' : '사용자 정의 필드 필터를 해제했습니다.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '필터 조건을 확인하세요.');
    }
  }

  function clear() {
    const empty = fromFilter(undefined);
    setDraft(empty);
    setBaseline(copyDraft(empty));
    nextId.current = 0;
    setError('');
    setOpen(false);
    dirtyRef.current = false;
    onApply(undefined);
    notify('사용자 정의 필드 필터를 해제했습니다.');
  }

  if (!schema.fields.length && !appliedCount) return null;
  return (
    <section
      className={`issue-field-filters ${open ? 'is-open' : ''}`}
      aria-label="사용자 정의 필드 필터"
    >
      <div className="issue-field-filter-toolbar">
        <button
          className={`btn ${appliedCount ? 'issue-field-filter-active' : 'btn-ghost'}`}
          type="button"
          aria-label="사용자 정의 필드 필터 편집"
          aria-expanded={open}
          onClick={() => {
            if (open) closeEditor();
            else setOpen(true);
          }}
        >
          <Filter size={16} />
          필드 필터
          {appliedCount > 0 && (
            <span>
              {appliedCount}개 · {value?.match === 'any' ? '하나 이상' : '모두'}
            </span>
          )}
        </button>
        {appliedCount > 0 && (
          <button
            className="btn btn-ghost"
            type="button"
            aria-label="사용자 정의 필드 필터 모두 해제"
            onClick={clear}
          >
            <X size={14} />
            해제
          </button>
        )}
      </div>
      {open && (
        <form
          className="issue-field-filter-editor"
          aria-label="사용자 정의 필드 필터 편집기"
          onSubmit={apply}
          noValidate
        >
          <header>
            <div>
              <h3>사용자 정의 필드 필터</h3>
              <p>조건을 편집한 뒤 적용하면 업무 목록에 반영됩니다.</p>
            </div>
            <button
              className="btn btn-ghost"
              type="button"
              aria-label="필드 필터 편집 닫기"
              onClick={closeEditor}
            >
              <X size={18} />
            </button>
          </header>
          <div className="issue-field-filter-match">
            <label>
              조건 일치 방식
              <select
                className="field"
                aria-label="필드 필터 일치 방식"
                value={draft.match}
                onChange={(event) => update({ ...draft, match: event.target.value as Draft['match'] })}
              >
                <option value="all">모든 조건 일치 (AND)</option>
                <option value="any">하나 이상 일치 (OR)</option>
              </select>
            </label>
            <span>
              조건 {draft.rules.length} / {MAX_FIELD_FILTER_RULES}
            </span>
          </div>
          <div className="issue-field-filter-rules" aria-label="필드 필터 조건 목록">
            {draft.rules.map((rule, index) => {
              const field = schema.fields.find((item) => item.id === rule.fieldId);
              const operators = field ? fieldFilterOperators(field.kind) : [rule.operator];
              return (
                <div
                  className="issue-field-filter-rule"
                  key={rule.id}
                  role="group"
                  aria-label={`필터 조건 ${index + 1}`}
                >
                  <label>
                    필드
                    <select
                      className="field"
                      aria-label={`필터 조건 ${index + 1} 필드`}
                      value={rule.fieldId}
                      onChange={(event) => changeField(rule, event.target.value)}
                    >
                      {!field && <option value={rule.fieldId}>{rule.fieldId} · 현재 정의 없음</option>}
                      {schema.fields.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.archived ? ' · 보관됨' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    비교
                    <select
                      className="field"
                      aria-label={`필터 조건 ${index + 1} 비교`}
                      value={rule.operator}
                      onChange={(event) =>
                        updateRule(rule.id, { operator: event.target.value as IssueFieldOperator })
                      }
                    >
                      {!operators.includes(rule.operator) && (
                        <option value={rule.operator}>
                          {OPERATOR_LABELS[rule.operator]} · 현재 사용 불가
                        </option>
                      )}
                      {operators.map((operator) => (
                        <option value={operator} key={operator}>
                          {OPERATOR_LABELS[operator]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {needsValue(rule.operator) ? (
                    <label className="issue-field-filter-value">
                      값
                      <FilterValue
                        field={field}
                        value={rule.input}
                        users={users}
                        label={`필터 조건 ${index + 1} 값`}
                        onChange={(input) => updateRule(rule.id, { input })}
                      />
                    </label>
                  ) : (
                    <span className="issue-field-filter-no-value">비교값 없이 확인</span>
                  )}
                  <button
                    className="btn btn-ghost issue-field-filter-remove"
                    type="button"
                    aria-label={`필터 조건 ${index + 1} 삭제`}
                    onClick={() =>
                      update({ ...draft, rules: draft.rules.filter((item) => item.id !== rule.id) })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
            {!draft.rules.length && (
              <p className="issue-field-filter-empty">필터할 필드를 조건으로 추가하세요.</p>
            )}
          </div>
          <div className="issue-field-filter-add">
            <button
              className="btn btn-ghost"
              type="button"
              aria-label="필드 필터 조건 추가"
              disabled={!schema.fields.length || draft.rules.length >= MAX_FIELD_FILTER_RULES}
              onClick={addRule}
            >
              <Plus size={16} />
              조건 추가
            </button>
            <small>필드와 선택 항목은 이름이 바뀌어도 같은 ID로 유지됩니다.</small>
          </div>
          {error && (
            <p className="issue-field-filter-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button className="btn btn-ghost" type="button" onClick={closeEditor}>
              편집 취소
            </button>
            <button className="btn btn-ghost" type="button" onClick={clear}>
              필드 필터 모두 해제
            </button>
            <button className="btn btn-primary" type="submit">
              <Check size={16} />
              필드 필터 적용
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}

function FilterValue({
  field,
  value,
  users,
  label,
  onChange,
}: {
  field?: CustomFieldDefinition;
  value: string;
  users: User[];
  label: string;
  onChange: (value: string) => void;
}) {
  const common = { className: 'field', 'aria-label': label };
  if (field?.kind === 'checkbox')
    return (
      <select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">값 선택</option>
        {value && value !== 'true' && value !== 'false' && (
          <option value={value}>{value} · 현재 값</option>
        )}
        <option value="true">예 (true)</option>
        <option value="false">아니요 (false)</option>
      </select>
    );
  if (field?.kind === 'select' || field?.kind === 'multi_select')
    return (
      <select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">선택 항목 선택</option>
        {value && !field.options.some((option) => option.id === value) && (
          <option value={value}>{value} · 현재 정의 없음</option>
        )}
        {field.options.map((option) => (
          <option value={option.id} key={option.id}>
            {option.name}
            {option.archived ? ' · 보관됨' : ''}
          </option>
        ))}
      </select>
    );
  if (field?.kind === 'user')
    return (
      <select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">사용자 선택</option>
        {value && !users.some((user) => user.id === value) && (
          <option value={value}>{value} · 현재 팀원 없음</option>
        )}
        {users.map((user) => (
          <option value={user.id} key={user.id}>
            {user.name}
          </option>
        ))}
      </select>
    );
  return (
    <input
      {...common}
      type={field?.kind === 'date' ? 'date' : 'text'}
      inputMode={field?.kind === 'number' ? 'decimal' : field?.kind === 'url' ? 'url' : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={
        field?.kind === 'number'
          ? '예: 0, 1.5'
          : field?.kind === 'url'
            ? 'URL 또는 찾을 문자열'
            : undefined
      }
    />
  );
}
