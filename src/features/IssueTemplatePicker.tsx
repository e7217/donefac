'use client';

import { useEffect, useRef, useState } from 'react';
import type { IssueTemplate } from '../../shared/types';
import { api } from '../lib/api';
import './issue-templates.css';

export function IssueTemplatePicker({ projectId, applied, error, notice, onApply, onDetach }: {
  projectId: string;
  applied: IssueTemplate | null;
  error: string;
  notice: string;
  onApply: (template: IssueTemplate) => void;
  onDetach: () => void;
}) {
  const [templates, setTemplates] = useState<IssueTemplate[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [request, setRequest] = useState(0);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const selected = templates?.find(template => template.id === selectedId);

  useEffect(() => {
    const controller = new AbortController();
    api<IssueTemplate[]>(`/projects/${encodeURIComponent(projectId)}/issue-templates`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setTemplates(result); })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [projectId, request]);

  useEffect(() => {
    if (error) errorMessage.current?.focus();
  }, [error]);

  function reload() {
    setLoadError(false);
    setTemplates(null);
    setRequest(previous => previous + 1);
  }

  if (!templates?.length && !loadError && !applied && !error) return null;
  return <div className="issue-template-picker">
    {Boolean(templates?.length) && <div className="issue-template-actions">
      <label className="issue-form-label">업무 템플릿
        <select className="field" value={selected ? selectedId : ''} onChange={event => {
          event.stopPropagation();
          setSelectedId(event.currentTarget.value);
        }}>
          <option value="">템플릿 선택</option>
          {templates?.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
      <button type="button" className="btn" disabled={!selected} onClick={() => selected && onApply(selected)}>템플릿 적용</button>
    </div>}
    {applied && <div className="issue-template-actions">
      <span role="status">적용한 템플릿 <strong>{applied.name}</strong> · 버전 {applied.version}</span>
      <button type="button" className="btn btn-ghost" onClick={onDetach}>템플릿 연결 해제</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p ref={errorMessage} tabIndex={-1} role="alert">{error}</p>}
    {loadError && <p role="alert">업무 템플릿을 불러오지 못했습니다.</p>}
    {(loadError || error) && <button type="button" className="btn btn-ghost" disabled={!templates && !loadError} onClick={reload}>
      최신 템플릿 불러오기
    </button>}
    {!templates && !loadError && <p role="status">업무 템플릿을 불러오는 중입니다.</p>}
    {templates?.length === 0 && applied && error && <p role="status">사용할 수 있는 템플릿이 없습니다.</p>}
  </div>;
}
