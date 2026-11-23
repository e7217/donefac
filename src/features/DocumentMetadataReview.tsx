'use client';

import { useId, useState, type FormEvent } from 'react';
import type { DocumentMetadataChoices, DocumentMetadataField } from './document-metadata-draft';
import './document-metadata-review.css';

type ReviewItem = {
  field: DocumentMetadataField;
  label: string;
  local: string;
  saved: string;
  localAllowed?: boolean;
};

export function DocumentMetadataReview({ items, disabled = false, onResolve }: {
  items: readonly ReviewItem[];
  disabled?: boolean;
  onResolve: (choices: DocumentMetadataChoices) => void;
}) {
  const id = useId();
  const [choices, setChoices] = useState<DocumentMetadataChoices>({});
  const complete = items.every(item => choices[item.field] === 'saved' ||
    (choices[item.field] === 'local' && item.localAllowed !== false));

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (complete && !disabled) onResolve(choices);
  }

  return <form className="document-metadata-review" aria-label="문서 속성 충돌 검토" onSubmit={resolve}>
    <p>선택한 값은 편집 중인 초안에 반영됩니다.</p>
    {items.map(item => {
      const fieldId = `${id}-${item.field}`;
      const unavailable = item.localAllowed === false;
      return <fieldset key={item.field} disabled={disabled}>
        <legend>{item.label}</legend>
        <div className="document-metadata-choices">
          <label className="document-metadata-choice">
            <input type="radio" name={fieldId} value="local" checked={choices[item.field] === 'local'} disabled={unavailable}
              aria-labelledby={`${fieldId}-local-label`}
              aria-describedby={`${fieldId}-local-value${unavailable ? ` ${fieldId}-unavailable` : ''}`}
              onChange={() => setChoices(previous => ({ ...previous, [item.field]: 'local' }))} />
            <span>
              <strong id={`${fieldId}-local-label`}>내 편집</strong>
              <span id={`${fieldId}-local-value`}>{item.local}</span>
              {unavailable && <small id={`${fieldId}-unavailable`}>현재 문서에서 이 상위 문서를 선택할 수 없습니다.</small>}
            </span>
          </label>
          <label className="document-metadata-choice">
            <input type="radio" name={fieldId} value="saved" checked={choices[item.field] === 'saved'}
              aria-labelledby={`${fieldId}-saved-label`} aria-describedby={`${fieldId}-saved-value`}
              onChange={() => setChoices(previous => ({ ...previous, [item.field]: 'saved' }))} />
            <span>
              <strong id={`${fieldId}-saved-label`}>서버 저장값</strong>
              <span id={`${fieldId}-saved-value`}>{item.saved}</span>
            </span>
          </label>
        </div>
      </fieldset>;
    })}
    <button className="btn btn-primary document-metadata-review-submit" type="submit" disabled={disabled || !complete}>
      선택한 내용으로 편집 계속
    </button>
  </form>;
}
