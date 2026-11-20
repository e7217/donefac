'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { PRIORITY, type FeatureProps, type IssuePastePreview, type IssuePasteResult, type Project } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import './issue-paste.css';

type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify'> & { project: Project; onClose: () => void };
type Pending = 'preview' | 'apply';
type Recovery = { kind: 'request' } | { kind: 'refresh'; receipt: IssuePasteResult } | { kind: 'unavailable' };

const example = [
  ['제목', '설명', '시작일', '종료일', '목표 마감일', '라벨'],
  ['요구사항 검토', '팀 피드백 정리', '2027-01-12', '2027-01-15', '2027-01-19', '검토,문서'],
  ['검토 결과 공유', '', '', '', '2027-01-20', '문서'],
].map(cells => cells.join('\t')).join('\n');

function allowDiscard(text: string, recovery: Recovery | null, prompt: string) {
  if (recovery?.kind === 'request') return window.confirm(`업무가 이미 생성됐을 수 있습니다. 목록에서 결과를 확인할 수 있습니다. ${prompt}`);
  if (recovery?.kind === 'refresh') return window.confirm(`업무를 만들었습니다. 목록을 다시 불러오면 확인할 수 있습니다. ${prompt}`);
  return !text || recovery?.kind === 'unavailable' || window.confirm(`붙여넣은 입력이 삭제됩니다. ${prompt}`);
}

export function IssuePasteDialog({ actorId, project, refresh, notify, onClose }: Props) {
  const titleId = useId();
  const inputId = `${titleId}-input`;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const [text, setText] = useState('');
  const [review, setReview] = useState<IssuePastePreview | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [error, setError] = useState('');
  const locked = Boolean(pending || recovery);
  const canApply = Boolean(review?.previewId && review.rows.length && !review.errors.length);
  const route = `/projects/${encodeURIComponent(project.id)}/issues`;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    input.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented) return;
      if (request.current) {
        event.preventDefault();
        notify('업무 붙여넣기 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if (allowDiscard(text, recovery, '이동할까요?')) {
        afterAcceptedNavigation(event, onClose);
      } else {
        event.preventDefault();
      }
    }
    function unload(event: BeforeUnloadEvent) {
      if (!request.current && (!text || recovery?.kind === 'unavailable')) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [notify, onClose, recovery, text]);

  useEffect(() => {
    if (pending) return;
    if (recovery?.kind === 'unavailable') errorNotice.current?.focus();
    else if (recovery) {
      errorNotice.current?.scrollIntoView({ block: 'nearest' });
      retryButton.current?.focus();
    }
    else if (review) reviewHeading.current?.focus();
    else if (error) input.current?.focus();
  }, [error, pending, recovery, review]);

  function close() {
    if (request.current || !allowDiscard(text, recovery, '창을 닫을까요?')) return;
    onClose();
    if (recovery) {
      void refresh().catch(() => notify('최신 업무 목록을 불러오지 못했습니다.', 'error'));
    }
  }

  function changeInput(value: string) {
    setText(value);
    setReview(null);
    setError('');
  }

  function send<T>(action: 'paste-preview' | 'paste-apply', body: object, signal: AbortSignal) {
    return api<T>(`${route}/${action}`, { method: 'POST', body: JSON.stringify(body), signal, headers: { 'X-Actor-Id': actorId } });
  }

  async function run(kind: Pending, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(kind);
    setError('');
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '업무 붙여넣기 요청을 처리하지 못했습니다.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

  function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || locked) return;
    void run('preview', async signal => {
      setReview(null);
      const result = await send<IssuePastePreview>('paste-preview', { text }, signal);
      if (!signal.aborted) setReview(result);
    });
  }

  function apply() {
    const previewId = review?.previewId;
    if (!previewId || !canApply || recovery?.kind === 'unavailable') return;
    void run('apply', async signal => {
      let receipt: IssuePasteResult;
      if (recovery?.kind === 'refresh') {
        receipt = recovery.receipt;
      } else {
        try {
          const result = await send<IssuePasteResult>('paste-apply', { previewId }, signal);
          if (typeof result?.duplicate !== 'boolean' || !Array.isArray(result.issues) || result.issues.length !== review.rows.length
            || !result.issues.every(issue => issue?.projectId === project.id && typeof issue.key === 'string')) {
            throw new Error('업무 생성 응답을 해석하지 못했습니다.');
          }
          receipt = result;
        } catch (cause) {
          if (signal.aborted) return;
          if (cause instanceof ApiError && cause.status === 409) {
            const reason = (cause.details as { reason?: string } | undefined)?.reason;
            if (reason === 'result_unavailable') {
              setRecovery({ kind: 'unavailable' });
              setError(cause.message);
              return;
            }
            if (recovery?.kind === 'request') {
              setRecovery({ kind: 'unavailable' });
              setError(`${cause.message} 업무가 이미 생성됐을 수 있습니다. 다시 붙여넣기 전에 목록에서 앞선 요청의 결과를 확인해 주세요.`);
              return;
            }
            setReview(null);
            setRecovery(null);
            setError(cause.message);
          } else if (cause instanceof ApiError && [400, 401, 403, 404, 422].includes(cause.status) && !recovery) {
            setReview(null);
            setError(cause.message);
          } else {
            setRecovery({ kind: 'request' });
            setError('업무 생성 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.');
          }
          return;
        }
      }
      if (signal.aborted) return;
      try {
        await refresh();
      } catch {
        if (!signal.aborted) {
          setRecovery({ kind: 'refresh', receipt });
          setError(`업무 ${receipt.issues.length}개를 만들었습니다. 최신 목록을 불러오지 못했습니다. 결과를 다시 확인해 주세요.`);
        }
        return;
      }
      if (signal.aborted) return;
      onClose();
      notify(`업무 ${receipt.issues.length}개를 만들었습니다.`);
    });
  }

  return <dialog ref={dialog} className="issue-paste-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <h2 id={titleId}>업무 붙여넣기</h2>
      <p><strong>{project.key} · {project.name}</strong>에 표의 행마다 새 업무를 만듭니다. 기존 업무 일정은 간트에서 붙여넣을 수 있습니다.</p>
    </header>
    <div className="issue-paste-content">
      <form className="issue-paste-form" onSubmit={preview}>
        <label htmlFor={inputId}>붙여넣을 업무</label>
        <p id={`${inputId}-help`}>첫 행에 열 이름이 있는 TSV 또는 CSV를 붙여넣으세요. 제목은 필수이며 날짜는 YYYY-MM-DD 형식입니다. 한 번에 최대 100행을 만들 수 있습니다.</p>
        <textarea className="field" id={inputId} ref={input} rows={5} aria-describedby={`${inputId}-help`}
          disabled={locked} value={text} onChange={event => changeInput(event.target.value)} spellCheck={false} />
        <div className="issue-paste-preview-actions">
          <details>
            <summary>TSV 예시</summary>
            <pre tabIndex={0} aria-label="업무 붙여넣기 예시">{example}</pre>
            <p>유형, 상태, 우선순위, 담당자 열도 추가할 수 있습니다. 담당자는 이름이나 이메일로 지정하고, 여러 라벨은 쉼표로 구분하세요.</p>
            <button type="button" className="btn btn-ghost" disabled={locked || Boolean(text)} onClick={() => { changeInput(example); input.current?.focus(); }}>예시 넣기</button>
          </details>
          <button type="submit" className="btn" disabled={locked || !text.trim()}>미리보기</button>
        </div>
      </form>
      {pending && <p role="status" className="issue-paste-message">{pending === 'preview' ? '입력한 업무를 검토 중입니다.' : '업무 생성 결과를 확인 중입니다.'}</p>}
      {error && <p role="alert" className="issue-form-error issue-paste-message" ref={errorNotice} tabIndex={-1}>{error}</p>}
      {review && <section className="issue-paste-review" aria-label="새 업무 미리보기">
        <h3 ref={reviewHeading} tabIndex={-1}>미리보기 · 업무 {review.rows.length}개</h3>
        {!!review.errors.length && <div className="issue-form-error" role="alert">
          <strong>업무를 만들려면 입력 오류 {review.errors.length}건을 수정하세요.</strong>
          <ul>{review.errors.map(({ line, message }, index) => <li key={index}>{line !== null && `${line}행 · `}{message}</li>)}</ul>
        </div>}
        {!!review.rows.length && <ol className="issue-paste-rows">{review.rows.map(row => <li key={row.line}>
          <h4><small>{row.line}행</small> {row.title}</h4>
          <dl>
            <div><dt>유형</dt><dd>{row.typeName}</dd></div>
            <div><dt>상태</dt><dd>{row.statusLabel}</dd></div>
            <div><dt>우선순위</dt><dd>{PRIORITY[row.priority]}</dd></div>
            <div><dt>담당자</dt><dd>{row.assigneeLabel ?? '미지정'}</dd></div>
            <div><dt>시작일</dt><dd>{row.startDate ?? '미정'}</dd></div>
            <div><dt>종료일</dt><dd>{row.endDate ?? '미정'}</dd></div>
            <div><dt>목표 마감일</dt><dd>{row.dueDate ?? '미정'}</dd></div>
            {!!row.labels.length && <div><dt>라벨</dt><dd>{row.labels.join(', ')}</dd></div>}
          </dl>
          {row.description && <details><summary>설명</summary><p>{row.description}</p></details>}
        </li>)}</ol>}
      </section>}
    </div>
    <footer>
      <button type="button" className="btn btn-ghost" disabled={Boolean(pending)} onClick={close}>닫기</button>
      {recovery && recovery.kind !== 'unavailable' ? <button type="button" className="btn btn-primary" ref={retryButton}
        disabled={Boolean(pending)} onClick={apply}>적용 결과 다시 확인</button>
        : !recovery && Boolean(review?.rows.length) && <button type="button" className="btn btn-primary"
          disabled={Boolean(pending) || !canApply} onClick={apply}>업무 {review?.rows.length}개 만들기</button>}
    </footer>
  </dialog>;
}
