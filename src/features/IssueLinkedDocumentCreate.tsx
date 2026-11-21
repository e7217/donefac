'use client';

import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import type { DocPage, DocumentTemplateSummary, FeatureProps, Issue, LinkedDocumentCreationResult } from '../../shared/types';
import { api } from '../lib/api';
import { newRequestId } from '../lib/request-id';
import { DocumentTemplatePicker, isDefiniteTemplateFailure, templateErrorReason, useDocumentTemplates } from './DocumentTemplates';
import { DOCUMENT_TEMPLATES, templateContent } from './document-built-in-templates';
import './issue-linked-document-create.css';

type Props = Pick<FeatureProps, 'actorId' | 'data' | 'refresh'> & {
  issue: Issue;
  onClose: () => void;
  onCreated: (result: LinkedDocumentCreationResult) => void;
  onDraftChange: (dirty: boolean, pending: boolean, uncertain: boolean) => void;
};
type BuiltIn = typeof DOCUMENT_TEMPLATES[number]['id'];
type Attempt = { actorId: string; issueId: string; projectId: string | null; body: string };
type Stage =
  | { kind: 'editing' | 'unavailable' }
  | { kind: 'recover'; attempt: Attempt }
  | { kind: 'reflect'; result: LinkedDocumentCreationResult };

const UNKNOWN_RESULT = '문서 저장 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.';
const TITLE_LIMIT = 240;

function documentParents(documents: readonly DocPage[], projectId: string | null) {
  const documentsById = new Map(documents.filter(page => page.projectId === projectId).map(page => [page.id, page]));
  return [...documentsById.values()].map(page => {
    const titles = [page.title];
    const visited = new Set([page.id]);
    let parent = page.parentId ? documentsById.get(page.parentId) : undefined;
    while (parent && !visited.has(parent.id)) {
      titles.unshift(parent.title);
      visited.add(parent.id);
      parent = parent.parentId ? documentsById.get(parent.parentId) : undefined;
    }
    return { id: page.id, label: titles.join(' / ') };
  }).sort((left, right) => left.label.localeCompare(right.label, 'ko'));
}

function verifiedResult(result: LinkedDocumentCreationResult, attempt: Attempt): boolean {
  const document = result?.document;
  const link = result?.link;
  return Boolean(document && typeof document.id === 'string' && document.id && typeof document.title === 'string' &&
    document.projectId === attempt.projectId && document.authorId === attempt.actorId &&
    link && typeof link.id === 'string' && link.id && link.issueId === attempt.issueId && link.documentId === document.id);
}

export function IssueLinkedDocumentCreate({ issue, data, actorId, refresh, onClose, onCreated, onDraftChange }: Props) {
  const titleId = useId();
  const sourceId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const request = useRef<AbortController | null>(null);
  const customizedTitle = useRef(false);

  const [initialProjectId] = useState(issue.projectId);
  const [reviewedIssueProjectId, setReviewedIssueProjectId] = useState(issue.projectId);
  const [projectId, setProjectId] = useState<string | null>(issue.projectId);
  const [parentId, setParentId] = useState('');
  const [title, setTitle] = useState('');
  const [builtIn, setBuiltIn] = useState<BuiltIn>('blank');
  const [teamTemplate, setTeamTemplate] = useState<DocumentTemplateSummary | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'editing' });
  const [pending, setPending] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState('');

  const { catalog, reload: reloadTemplates } = useDocumentTemplates(projectId, true);
  const parents = useMemo(() => documentParents(data.documents, projectId), [data.documents, projectId]);
  const destination = data.projects.find(project => project.id === projectId);
  const issueProject = data.projects.find(project => project.id === issue.projectId);
  const selectedProjectMissing = projectId !== null && !destination;
  const selectedParentMissing = Boolean(parentId && !parents.some(parent => parent.id === parentId));
  const currentTemplate = teamTemplate && catalog?.state === 'ready' ? catalog.templates.find(item => item.id === teamTemplate.id) : null;
  const templateNeedsReview = Boolean(teamTemplate && currentTemplate?.version !== teamTemplate.version);
  const issueMoved = reviewedIssueProjectId !== issue.projectId;
  const editing = stage.kind === 'editing';
  const uncertain = stage.kind === 'recover';
  const dirty = uncertain || editing && Boolean(title || builtIn !== 'blank' || teamTemplate || parentId || projectId !== initialProjectId);
  const canSubmit = Boolean(actorId && title.trim() && !needsRefresh && !issueMoved && !selectedProjectMissing && !selectedParentMissing && !templateNeedsReview);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    titleInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element?.close();
      onDraftChange(false, false, false);
    };
  }, [onDraftChange]);

  useLayoutEffect(() => { onDraftChange(dirty, pending, uncertain); }, [dirty, onDraftChange, pending, uncertain]);

  useLayoutEffect(() => {
    if (pending || !error) return;
    if (stage.kind === 'unavailable') alert.current?.focus();
    else if (!editing) primary.current?.focus();
  }, [editing, error, pending, stage.kind]);

  function close() {
    if (request.current) return;
    if (dirty && !window.confirm(uncertain ? '문서가 이미 저장됐을 수 있습니다. 저장 결과 확인을 닫을까요?'
      : '입력한 문서 정보를 버릴까요?')) return;
    onClose();
  }

  function chooseBuiltIn(id: BuiltIn) {
    setBuiltIn(id);
    setTeamTemplate(null);
    setError('');
    if (!customizedTitle.current) setTitle(id === 'blank' ? '' : DOCUMENT_TEMPLATES.find(template => template.id === id)?.name ?? '');
  }

  function chooseTeamTemplate(template: DocumentTemplateSummary | null) {
    if (!template) { chooseBuiltIn('blank'); return; }
    setTeamTemplate(template);
    setError('');
    if (!customizedTitle.current) setTitle(template.name);
  }

  async function run(perform: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    onDraftChange(dirty, true, uncertain);
    setPending(true);
    setError('');
    try {
      await perform(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '문서 요청을 처리하지 못했습니다.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }

  async function reflect(result: LinkedDocumentCreationResult, signal: AbortSignal) {
    setStage({ kind: 'reflect', result });
    try {
      await refresh();
    } catch {
      if (!signal.aborted) setError('문서와 연결을 저장했습니다. 문서 목록을 다시 불러와 확인할 수 있습니다.');
      return;
    }
    if (!signal.aborted) onCreated(result);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage.kind === 'recover') {
      if (stage.attempt.actorId !== actorId) {
        setError('저장을 요청한 작업자로 전환한 뒤 저장 결과를 다시 확인해 주세요.');
        return;
      }
    } else if (!editing || !canSubmit) return;

    const attempt = stage.kind === 'recover' ? stage.attempt : {
      actorId, issueId: issue.id, projectId,
      body: JSON.stringify({ requestId: newRequestId(), expectedIssueProjectId: reviewedIssueProjectId, projectId, parentId: parentId || null, title: title.trim(),
        ...(teamTemplate ? { templateId: teamTemplate.id, expectedTemplateVersion: teamTemplate.version }
          : { content: templateContent(builtIn), icon: DOCUMENT_TEMPLATES.find(template => template.id === builtIn)?.icon ?? '📄' }) }),
    };
    void run(async signal => {
      let result: LinkedDocumentCreationResult;
      try {
        result = await api<LinkedDocumentCreationResult>(`/issues/${encodeURIComponent(attempt.issueId)}/documents`, {
          method: 'POST', body: attempt.body, headers: { 'X-Actor-Id': attempt.actorId }, signal,
        });
        if (!verifiedResult(result, attempt)) throw new Error(UNKNOWN_RESULT);
      } catch (cause) {
        if (signal.aborted) return;
        if (!isDefiniteTemplateFailure(cause)) {
          setStage({ kind: 'recover', attempt });
          setError(UNKNOWN_RESULT);
          return;
        }
        const reason = templateErrorReason(cause);
        setError(cause.message);
        if (reason === 'request_conflict' || reason === 'result_unavailable') {
          setStage({ kind: 'unavailable' });
        } else {
          setStage({ kind: 'editing' });
          if (reason === 'template_version_conflict' || reason === 'template_archived' || reason === 'template_not_found') reloadTemplates();
          else if (reason === 'issue_project_changed' || cause.status === 404) setNeedsRefresh(true);
        }
        return;
      }
      if (!signal.aborted) await reflect(result, signal);
    });
  }

  function recheckIssue() {
    void run(async signal => {
      await refresh();
      if (!signal.aborted) setNeedsRefresh(false);
    });
  }

  return <dialog ref={dialog} className="document-templates-dialog issue-linked-document-create" aria-labelledby={titleId} aria-describedby={sourceId}
    aria-busy={pending} onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <header className="document-templates-header">
        <div>
          <h2 id={titleId}>연결 문서 만들기</h2>
          <p id={sourceId}>{issue.key} · {issue.title}</p>
        </div>
        <button type="button" className="issue-icon-button" aria-label="연결 문서 만들기 닫기" disabled={pending} onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      <fieldset className="issue-linked-document-fields" disabled={!editing || pending}>
        <label>문서 제목<input className="field" ref={titleInput} value={title} required maxLength={TITLE_LIMIT} onChange={event => {
          customizedTitle.current = true;
          setTitle(event.currentTarget.value);
          setError('');
        }} /></label>
        <div className="issue-linked-document-location">
          <label>공간<select className="field" value={projectId ?? ''} onChange={event => {
            setProjectId(event.currentTarget.value || null);
            setParentId('');
            setError('');
          }}>
            {selectedProjectMissing && <option value={projectId!} disabled>현재 사용할 수 없는 공간</option>}
            <option value="">팀 공통 문서</option>
            {data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select></label>
          <label>상위 문서<select className="field" value={parentId} onChange={event => { setParentId(event.currentTarget.value); setError(''); }}>
            {selectedParentMissing && <option value={parentId} disabled>현재 사용할 수 없는 상위 문서</option>}
            <option value="">최상위에 만들기</option>
            {parents.map(parent => <option value={parent.id} key={parent.id}>{parent.label}</option>)}
          </select></label>
        </div>
        <label>기본 템플릿<select className="field" value={teamTemplate ? '' : builtIn} onChange={event => chooseBuiltIn(event.currentTarget.value as BuiltIn)}>
          {teamTemplate && <option value="" disabled>팀 템플릿 사용 중</option>}
          {DOCUMENT_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select></label>
        <DocumentTemplatePicker catalog={catalog} reload={reloadTemplates} value={teamTemplate?.id ?? ''}
          projectName={destination?.name} disabled={!editing || pending} onChoose={chooseTeamTemplate} />
        {teamTemplate && <p className="issue-linked-document-template">
          {teamTemplate.projectId === null ? '팀 공통' : data.projects.find(project => project.id === teamTemplate.projectId)?.name ?? '프로젝트'}
          {' · '}템플릿 버전 {teamTemplate.version}{teamTemplate.attachmentCount ? ` · 첨부 ${teamTemplate.attachmentCount}개` : ''}
        </p>}
        {editing && templateNeedsReview && <div className="document-template-picker-status document-template-review">
          <span>{currentTemplate ? `현재 템플릿 버전 ${currentTemplate.version}을 확인해 주세요.` : catalog?.state === 'ready'
            ? '이 공간에서 사용할 템플릿을 다시 선택해 주세요.' : '팀 템플릿 목록을 확인하고 있습니다.'}</span>
          {currentTemplate && <button type="button" className="btn" onClick={() => chooseTeamTemplate(currentTemplate)}>최신 템플릿 사용</button>}
        </div>}
      </fieldset>
      {editing && (needsRefresh || issueMoved) && <div className="document-template-picker-status document-template-review">
        <span>{needsRefresh ? '티켓과 문서 위치를 다시 확인해 주세요.' : `티켓의 현재 위치는 ${issueProject?.name ?? '현재 프로젝트'}입니다.`}</span>
        <button type="button" className="btn" disabled={pending} onClick={needsRefresh ? recheckIssue : () => {
          setReviewedIssueProjectId(issue.projectId);
          setError('');
        }}>{needsRefresh ? '최신 위치 불러오기' : '현재 티켓 위치 사용'}</button>
      </div>}
      {error && <p className="document-template-error" ref={alert} role="alert" tabIndex={-1}>{error}</p>}
      {pending && <p className="issue-linked-document-progress" role="status">문서와 연결을 확인하는 중입니다.</p>}
      <footer className="issue-linked-document-footer">
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={close}>{editing ? '취소' : '닫기'}</button>
        {stage.kind === 'reflect' ? <button ref={primary} type="button" className="btn btn-primary" disabled={pending}
          onClick={() => void run(signal => reflect(stage.result, signal))}>문서 목록 다시 불러오기</button>
          : stage.kind !== 'unavailable' && <button ref={primary} type="submit" className="btn btn-primary" disabled={pending || (editing && !canSubmit)}>
            <Plus size={15} aria-hidden="true" />{uncertain ? '저장 결과 다시 확인' : '문서 만들기'}
          </button>}
      </footer>
    </form>
  </dialog>;
}
