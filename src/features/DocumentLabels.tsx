'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { documentLabelKey, MAX_DOCUMENT_LABEL_LENGTH, MAX_DOCUMENT_LABELS, normalizeDocumentLabel, normalizeDocumentLabels } from '../../shared/document-labels';
import './document-labels.css';

type Props = {
  labels: string[];
  activeKey?: string | null;
  disabled: boolean;
  onChange: (labels: string[]) => void;
  onFilter?: (key: string | null) => void;
};

export function DocumentLabels({ labels, activeKey, disabled, onChange, onFilter }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();

  function addLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !value.trim()) return;
    const label = normalizeDocumentLabel(value);
    if (!label) {
      setError(`라벨은 ${MAX_DOCUMENT_LABEL_LENGTH}자 이내로 입력해 주세요.`);
      return;
    }
    if (labels.some(item => documentLabelKey(item) === documentLabelKey(label))) {
      setError('이미 추가한 라벨입니다.');
      return;
    }
    const next = normalizeDocumentLabels([...labels, label]);
    if (!next) {
      setError(`라벨은 문서당 ${MAX_DOCUMENT_LABELS}개까지 추가할 수 있습니다.`);
      return;
    }
    onChange(next);
    setValue('');
    setError('');
    input.current?.focus();
  }

  return <div className="docs-label-editor">
    {labels.length > 0 && <ul className="docs-label-chips" aria-label="문서에 적용한 라벨">
      {labels.map(label => {
        const key = documentLabelKey(label);
        return <li className={`docs-label-chip ${activeKey === key ? 'is-active' : ''}`} key={key}>
          {onFilter ? <button type="button" aria-pressed={activeKey === key} onClick={() => onFilter(activeKey === key ? null : key)}>{label}</button> : <span>{label}</span>}
          <button type="button" className="docs-label-remove" aria-label={`라벨 삭제: ${label}`} disabled={disabled} onClick={() => {
            onChange(labels.filter(item => item !== label));
            setError('');
            input.current?.focus();
          }}><X size={13} aria-hidden="true" /></button>
        </li>;
      })}
    </ul>}
    <form className="docs-label-form" onSubmit={addLabel}>
      <input ref={input} value={value} placeholder="문서 라벨" aria-label="문서 라벨" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} disabled={disabled} onChange={event => { setValue(event.target.value); setError(''); }} />
      <button type="submit" disabled={disabled || !value.trim()}><Plus size={14} aria-hidden="true" /> 라벨 추가</button>
    </form>
    {error && <p className="docs-label-error" id={errorId} role="alert">{error}</p>}
  </div>;
}
