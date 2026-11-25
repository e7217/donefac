'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ClipboardList, Link2, Plus, RefreshCw, X } from 'lucide-react';
import { PRIORITY, type CustomFieldValue, type FeatureProps, type Issue, type IssueIntakePage, type IssueIntakeRequest, type IssueIntakeResult, type WorkspaceSnapshot } from '../../shared/types';
import { projectIssueSchema, requiredFieldLabels } from '../../shared/issue-schema';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { projectWorkflow, requiredFieldsFor } from '../../shared/workflow-helpers';
import { api, ApiError } from '../lib/api';
import { createIssueAttempt, isDefiniteIssueCreationFailure, type IssueCreationAttempt } from '../lib/issue-creation';
import { afterAcceptedNavigation } from '../lib/navigation';
import { CustomFields, initialIssueType, IssueTypeSelect } from './CustomFields';
import { PlanningSelect, PLAN_LABELS } from './PlanningSelectors';
import './issue-intake.css';

type Props = FeatureProps & {
  composeFromLink: boolean;
  selectedRequestId: string | null;
  issueOverlayOpen: boolean;
  onChangeRequest: (id: string | null) => boolean;
  onCloseCompose: () => boolean;
  onCopySubmissionLink: () => Promise<boolean>;
  onCopyRequestLink: (id: string) => Promise<boolean>;
  onOpenLinkedIssue: (id: string) => Promise<boolean>;
};
type QueueState = 'pending' | 'closed';
type QueueFilter = { state: QueueState; offset: number; query: string; mine: boolean };
type Decision = 'accept' | 'duplicate' | 'reject';
type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: T };

const stateLabels = { pending: '처리 대기', accepted: '업무로 등록', duplicate: '기존 업무에 연결', rejected: '반려' } as const;
const decisionLabels = { accept: '업무로 등록', duplicate: '기존 업무에 연결', reject: '반려' } as const;
const utcLabel = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' });
const readMessage = (cause: unknown) => cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.';
const conflictReason = (cause: ApiError) => cause.details && typeof cause.details === 'object' && 'reason' in cause.details
  ? cause.details.reason : undefined;

function person(data: WorkspaceSnapshot, id: string | null) {
  return data.users.find(user => user.id === id)?.name ?? '이전 팀원';
}

function IntakeTime({ value }: { value: string }) {
  return <time dateTime={value}>{utcLabel.format(new Date(value))}</time>;
}

function validResult(value: IssueIntakeResult, projectId: string, exactId?: string) {
  const item = value?.item;
  return item?.id && item.projectId === projectId && (!exactId || item.id === exactId) &&
    Object.hasOwn(stateLabels, item.status) && typeof value.duplicate === 'boolean';
}

/** Keep the exact actor, URL and serialized payload while a write's outcome is uncertain. */
function useIntakeMutation(actorId: string, projectId: string, notify: FeatureProps['notify'], onClose: () => void) {
  const attempt = useRef<(IssueCreationAttempt & { path: string; exactId?: string }) | null>(null);
  const dirty = useRef(false);
  const running = useRef(false);
  const closing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState<{ message: string; conflict?: boolean } | null>(null);
  const [changed, setChanged] = useState(false);

  function mayClose() {
    if (running.current) {
      notify('접수 요청이 끝난 뒤 이동해 주세요.', 'error');
      return false;
    }
    if (attempt.current) return window.confirm('접수 처리가 이미 저장됐을 수 있습니다. 결과를 확인하지 않고 닫을까요?');
    return !dirty.current || window.confirm('작성 중인 접수 내용을 버리고 닫을까요?');
  }
  function dismiss() {
    if (!mayClose()) return;
    closing.current = true;
    try { onClose(); } finally { closing.current = false; }
  }
  function markDirty() {
    dirty.current = true;
    setChanged(true);
  }
  function discard() {
    if (!mayClose()) return false;
    attempt.current = null;
    dirty.current = false;
    setChanged(false);
    setFailure(null);
    setUncertain(false);
    return true;
  }

  useEffect(() => {
    const beforeNavigation = (event: Event) => {
      if (event.defaultPrevented || closing.current) return;
      if (!mayClose()) event.preventDefault();
      else afterAcceptedNavigation(event, () => { attempt.current = null; dirty.current = false; });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current && !running.current && !attempt.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', beforeNavigation);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('teamspace:navigate', beforeNavigation);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });

  async function submit(path: string, build: () => Record<string, unknown>, exactId?: string) {
    if (running.current) return;
    const replay = attempt.current !== null;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const request = attempt.current ?? { ...createIssueAttempt(actorId, build()), path, exactId };
      attempt.current = request;
      const result = await api<IssueIntakeResult>(request.path, {
        method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body,
      });
      if (!validResult(result, projectId, request.exactId)) throw new Error('접수 결과를 읽을 수 없습니다.');
      dirty.current = false;
      attempt.current = null;
      setChanged(false);
      setUncertain(false);
      return result.item;
    } catch (cause) {
      if (attempt.current && !isDefiniteIssueCreationFailure(cause, replay)) {
        setUncertain(true);
        setFailure({ message: '접수 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.' });
      } else {
        attempt.current = null;
        setUncertain(false);
        const conflict = cause instanceof ApiError && cause.status === 409 && conflictReason(cause) !== 'request_reused';
        setFailure({ message: readMessage(cause), conflict });
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, uncertain, failure, setFailure, changed, markDirty, dismiss, discard, submit };
}

function IntakeModal({ modal, title, description, children }: {
  modal: ReturnType<typeof useIntakeMutation>; title: string; description?: ReactNode; children: ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const { uncertain, busy, dismiss } = modal;
  useEffect(() => {
    const current = dialog.current;
    if (!current) return;
    current.showModal();
    current.querySelector<HTMLElement>('[data-intake-dialog-focus]')?.focus();
    return () => current.close();
  }, []);
  useEffect(() => {
    if (uncertain && !busy) dialog.current?.querySelector<HTMLElement>('[data-intake-retry]')?.focus();
  }, [uncertain, busy]);
  return <dialog ref={dialog} className="issue-intake-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); modal.dismiss(); }}>
    <header className="issue-intake-dialog-heading">
      <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
      <button type="button" className="btn btn-ghost issue-intake-icon" aria-label="접수 창 닫기"
        data-intake-dialog-focus={!description || undefined} disabled={busy} onClick={dismiss}><X size={19} aria-hidden="true" /></button>
    </header>
    {children}
  </dialog>;
}

export function IssueIntake(props: Props) {
  return <IssueIntakeProject key={JSON.stringify([props.projectId, props.actorId, props.data.restoreGeneration])} {...props} />;
}

function IssueIntakeProject(props: Props) {
  const { data, actorId, projectId, selectedRequestId, composeFromLink, issueOverlayOpen, onChangeRequest, onCloseCompose, onCopySubmissionLink } = props;
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<QueueFilter>({ state: 'pending', offset: 0, query: '', mine: false });
  const [queue, setQueue] = useState<Load<IssueIntakePage>>({ kind: 'loading' });
  const [listRevision, setListRevision] = useState(0);
  const [receipt, setReceipt] = useState<IssueIntakeRequest | null>(null);
  const path = `/projects/${encodeURIComponent(projectId)}/intake`;
  const project = data.projects.find(project => project.id === projectId);
  const compose = !selectedRequestId && (creating || composeFromLink);

  useEffect(() => {
    const request = new AbortController();
    const query = new URLSearchParams({ state: filter.state, offset: String(filter.offset) });
    if (filter.query.trim()) query.set('q', filter.query.trim());
    if (filter.mine) query.set('mine', '1');
    const timer = window.setTimeout(() => {
      void api<IssueIntakePage>(`${path}?${query}`, { signal: request.signal, cache: 'no-store', headers: { 'X-Actor-Id': actorId } })
        .then(value => {
          if (request.signal.aborted) return;
          if (!value || !Array.isArray(value.items) || !value.counts || !Number.isSafeInteger(value.total) || !value.limit) {
            throw new Error('업무 접수 목록을 읽을 수 없습니다.');
          }
          if (filter.offset > 0 && value.items.length === 0 && value.total <= filter.offset) {
            setFilter(current => ({ ...current, offset: value.total > 0 ? Math.floor((value.total - 1) / value.limit) * value.limit : 0 }));
            return;
          }
          setQueue({ kind: 'ready', value });
        })
        .catch(cause => { if (!request.signal.aborted) setQueue({ kind: 'error', message: readMessage(cause) }); });
    }, filter.query ? 160 : 0);
    return () => { window.clearTimeout(timer); request.abort(); };
  }, [path, actorId, filter, listRevision]);

  function chooseFilter(next: Partial<QueueFilter>) {
    setQueue({ kind: 'loading' });
    setFilter(previous => ({ ...previous, offset: 0, ...next }));
  }
  function readQueueAgain() {
    setQueue({ kind: 'loading' });
    setListRevision(revision => revision + 1);
  }
  function closeCompose() {
    if (composeFromLink && !onCloseCompose()) return;
    setCreating(false);
  }
  function receiveSubmission(item: IssueIntakeRequest) {
    closeCompose();
    setReceipt(item);
    chooseFilter({ state: 'pending', query: '', mine: false });
    props.notify('업무 요청을 접수했습니다.');
  }
  function receiveDecision() {
    setReceipt(null);
    readQueueAgain();
  }

  const ready = queue.kind === 'ready' ? queue.value : null;
  const queueStatus = ready && ready.total > 0
    ? `${ready.offset + 1}~${ready.offset + ready.items.length} / ${ready.total.toLocaleString('ko-KR')}건` : '0건';

  return <section className="issue-intake">
    <div className="feature-heading">
      <div><h1>업무 접수</h1>{project && <p>{project.name}</p>}</div>
      <div className="issue-intake-actions">
        <button type="button" className="btn" onClick={() => void onCopySubmissionLink()}><Link2 size={15} aria-hidden="true" /> 접수 링크 복사</button>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> 요청 작성</button>
      </div>
    </div>
    {receipt && <div className="issue-intake-receipt">
      <p role="status">접수했습니다. <strong>{receipt.title}</strong></p>
      <button type="button" className="btn" onClick={() => onChangeRequest(receipt.id)}>접수한 요청 열기<ArrowRight size={15} aria-hidden="true" /></button>
    </div>}
    <div className="card issue-intake-queue">
      <div className="issue-intake-filters">
        <div role="group" aria-label="요청 상태" className="issue-intake-toggle">
          {(['pending', 'closed'] as const).map(state => <button type="button" className="btn" key={state}
            aria-pressed={filter.state === state} onClick={() => {
              if (filter.state !== state) chooseFilter({ state });
            }}>{state === 'pending' ? '처리 대기' : '처리 완료'}{ready && <span>{ready.counts[state].toLocaleString('ko-KR')}</span>}</button>)}
        </div>
        <label className="issue-intake-mine"><input type="checkbox" checked={filter.mine}
          onChange={event => chooseFilter({ mine: event.currentTarget.checked })} />내 요청만</label>
        <label className="issue-intake-search"><span>요청 검색</span>
          <input type="search" className="field" value={filter.query} maxLength={200} placeholder="제목·요청 내용"
            onChange={event => chooseFilter({ query: event.currentTarget.value })} />
        </label>
        <button type="button" className="btn issue-intake-icon" onClick={readQueueAgain} disabled={queue.kind === 'loading'} aria-label="접수 목록 새로고침">
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      {queue.kind === 'loading' ? <p className="issue-intake-feedback" role="status">요청을 불러오는 중입니다.</p> : queue.kind === 'error' ?
        <div className="issue-intake-feedback"><p role="alert">{queue.message}</p><button type="button" className="btn" onClick={readQueueAgain}>다시 불러오기</button></div>
        : queue.value.items.length === 0 ? <div className="issue-intake-feedback issue-intake-empty"><ClipboardList size={24} aria-hidden="true" />
          <p>{filter.query || filter.mine ? '조건에 맞는 요청이 없습니다.' : filter.state === 'pending' ? '처리 대기 중인 요청이 없습니다.' : '처리 완료된 요청이 없습니다.'}</p></div>
          : <ul className="issue-intake-list" aria-label="접수 요청">
            {queue.value.items.map(item => <li key={item.id}>
              <button type="button" className="issue-intake-row" onClick={() => onChangeRequest(item.id)}>
                <span className="issue-intake-row-title"><strong>{item.title}</strong>
                  <small>{person(data, item.reporterId)} · <IntakeTime value={item.createdAt} /></small></span>
                <span className="issue-intake-state" data-state={item.status}>{stateLabels[item.status]}</span>
                {item.issueKey && <span className="issue-intake-work-key">{item.issueKey}</span>}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </li>)}
          </ul>}
      {ready && ready.total > 0 && <div className="issue-intake-pagination">
        <button type="button" className="btn" aria-label="이전 요청 페이지" disabled={ready.offset === 0}
          onClick={() => chooseFilter({ offset: Math.max(0, ready.offset - ready.limit) })}><ArrowLeft size={15} aria-hidden="true" /></button>
        <span>{queueStatus}</span>
        <button type="button" className="btn" aria-label="다음 요청 페이지" disabled={ready.offset + ready.limit >= ready.total}
          onClick={() => chooseFilter({ offset: ready.offset + ready.limit })}><ArrowRight size={15} aria-hidden="true" /></button>
      </div>}
    </div>
    {compose && <IntakeSubmission {...props} path={path} onClose={closeCompose} onSaved={receiveSubmission} projectName={project?.name ?? ''} />}
    {selectedRequestId && !issueOverlayOpen && <IntakeReview key={selectedRequestId} {...props} id={selectedRequestId} path={path}
      onClose={() => onChangeRequest(null)} onSaved={receiveDecision} />}
  </section>;
}

function IntakeSubmission({ actorId, projectId, data, notify, path, projectName, onClose, onSaved }: Props & {
  path: string; projectName: string; onClose: () => void; onSaved: (item: IssueIntakeRequest) => void;
}) {
  const modal = useIntakeMutation(actorId, projectId, notify, onClose);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitted || !modal.uncertain && (!title.trim() || !data.restoreGeneration)) return;
    const item = await modal.submit(path, () => ({
      restoreGeneration: data.restoreGeneration, title: title.trim(), description: description.trim(),
    }));
    if (item) {
      setSubmitted(true);
      onSaved(item);
    }
  }
  return <IntakeModal modal={modal} title="업무 요청 작성" description={projectName}>
    <form className="issue-intake-form" onSubmit={event => void submit(event)} onChange={modal.markDirty}>
      <fieldset disabled={modal.busy || modal.uncertain || submitted}>
        <label>요청 제목<input className="field" data-intake-dialog-focus required maxLength={200} value={title}
          onChange={event => setTitle(event.currentTarget.value)} /></label>
        <label>요청 내용<textarea className="field" maxLength={5000} rows={5} value={description}
          onChange={event => setDescription(event.currentTarget.value)} /></label>
      </fieldset>
      {modal.failure && <p className="issue-intake-error" role="alert">{modal.failure.message}</p>}
      <div className="issue-intake-modal-actions">
        <button className="btn" type="button" disabled={modal.busy} onClick={modal.dismiss}>취소</button>
        <button className="btn btn-primary" type="submit" data-intake-retry
          disabled={modal.busy || submitted || !modal.uncertain && (!title.trim() || !data.restoreGeneration)}>
          {modal.busy ? '저장 중…' : modal.uncertain ? '같은 요청 다시 확인' : '요청 접수'}
        </button>
      </div>
    </form>
  </IntakeModal>;
}

function IntakeReview({ id, path, onClose, onSaved, data, projectId, actorId, notify, onCopyRequestLink, onOpenLinkedIssue }: Props & {
  id: string; path: string; onClose: () => void; onSaved: () => void;
}) {
  const modal = useIntakeMutation(actorId, projectId, notify, onClose);
  const detailPath = `${path}/${encodeURIComponent(id)}`;
  const [loaded, setLoaded] = useState<Load<IssueIntakeRequest>>({ kind: 'loading' });
  const [latestData, setLatestData] = useState(data);
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const checkingRef = useRef(false);
  const current = loaded.kind === 'ready' ? loaded.value : null;
  useEffect(() => {
    const request = new AbortController();
    void api<IssueIntakeRequest>(detailPath, { cache: 'no-store', signal: request.signal, headers: { 'X-Actor-Id': actorId } })
      .then(value => {
        if (request.signal.aborted) return;
        if (value?.id !== id || value.projectId !== projectId || !Object.hasOwn(stateLabels, value.status)) {
          throw new Error('접수 요청을 읽을 수 없습니다.');
        }
        setLoaded({ kind: 'ready', value });
      })
      .catch(cause => { if (!request.signal.aborted) setLoaded({ kind: 'error', message: readMessage(cause) }); });
    return () => request.abort();
  }, [detailPath, projectId, id, actorId, revision]);

  async function readLatest() {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const headers = { 'X-Actor-Id': actorId };
      const [value, workspace] = await Promise.all([
        api<IssueIntakeRequest>(detailPath, { cache: 'no-store', headers }),
        api<WorkspaceSnapshot>('/workspace', { cache: 'no-store', headers }),
      ]);
      if (value?.id !== id || value.projectId !== projectId || !Object.hasOwn(stateLabels, value.status) || !workspace?.restoreGeneration) {
        throw new Error('최신 접수 요청이나 프로젝트 설정을 읽을 수 없습니다.');
      }
      setLatestData(workspace);
      setLoaded({ kind: 'ready', value });
      modal.setFailure(null);
      if (value.status !== 'pending') onSaved();
    } catch (cause) {
      modal.setFailure({ message: readMessage(cause), conflict: true });
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  const issueId = current?.issueId;
  async function openLinkedIssue() {
    if (!issueId || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      if (!await onOpenLinkedIssue(issueId)) notify('연결된 업무를 열지 못했습니다.', 'error');
    } catch {
      notify('업무 목록을 불러오지 못했습니다. 다시 시도해 주세요.', 'error');
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  function closeEdit() {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  }

  return <IntakeModal modal={modal} title="접수 요청 검토">
    {!current ? <div className="issue-intake-feedback">
      {loaded.kind === 'error' ? <><p role="alert">{loaded.message}</p><button type="button" className="btn" onClick={() => {
        setLoaded({ kind: 'loading' }); setRevision(value => value + 1);
      }}>다시 불러오기</button></> : <p role="status">요청을 불러오는 중입니다.</p>}
    </div> : <>
      <section className="issue-intake-original" aria-label="접수 원문">
        <div className="issue-intake-original-heading"><span className="issue-intake-state" data-state={current.status}>{stateLabels[current.status]}</span>
          <button type="button" className="btn" onClick={async () => setCopyStatus(await onCopyRequestLink(id) ? 'copied' : 'failed')}>
            <Link2 size={15} aria-hidden="true" /> 요청 링크 복사
          </button></div>
        {copyStatus && <p role="status" className="issue-intake-meta">{copyStatus === 'copied' ? '요청 링크를 복사했습니다.' : '요청 링크를 복사하지 못했습니다.'}</p>}
        <h3>{current.title}</h3>
        <p className="issue-intake-original-meta">{person(latestData, current.reporterId)} · <IntakeTime value={current.createdAt} /></p>
        {current.description && <p className="issue-intake-text">{current.description}</p>}
        {!editing && current.status === 'pending' && current.reporterId === actorId &&
          <button type="button" className="btn" ref={editButton} disabled={checking || modal.changed || modal.busy || modal.uncertain}
            onClick={() => setEditing(true)}>요청 수정</button>}
      </section>
      {editing ? <IntakeOriginalEdit item={current} generation={latestData.restoreGeneration} modal={modal} checking={checking}
        readLatest={readLatest} onCancel={() => { if (modal.discard()) closeEdit(); }} onSubmit={async fields => {
          const result = await modal.submit(`${detailPath}/edit`, fields, id);
          if (!result) return;
          setLoaded({ kind: 'ready', value: result });
          closeEdit();
          onSaved();
          notify('업무 요청을 수정했습니다.');
        }} /> : <IntakeDecision item={current} snapshot={latestData} modal={modal} checking={checking}
        readLatest={readLatest} onSubmit={async fields => {
          const result = await modal.submit(`${detailPath}/decision`, fields, id);
          if (!result) return;
          setLoaded({ kind: 'ready', value: result });
          onSaved();
          notify('접수 요청의 처리 결과를 저장했습니다.');
        }} />}
      {current.status !== 'pending' && <section className="issue-intake-result" aria-label="처리 결과">
        <h3>처리 결과</h3>
        <p>{stateLabels[current.status]} · {person(latestData, current.reviewerId)} · <IntakeTime value={current.updatedAt} /></p>
        {current.reason && <p className="issue-intake-text">{current.reason}</p>}
        {current.issueId && <button type="button" className="btn btn-primary" onClick={() => void openLinkedIssue()} disabled={checking}>
          {current.issueKey ? `${current.issueKey} 업무 열기` : '업무 열기'} <ArrowRight size={15} aria-hidden="true" />
        </button>}
      </section>}
    </>}
  </IntakeModal>;
}

function IntakeOriginalEdit({ item, generation, modal, checking, readLatest, onCancel, onSubmit }: {
  item: IssueIntakeRequest; generation: WorkspaceSnapshot['restoreGeneration']; modal: ReturnType<typeof useIntakeMutation>;
  checking: boolean; readLatest: () => Promise<void>; onCancel: () => void;
  onSubmit: (input: () => Record<string, unknown>) => Promise<void>;
}) {
  const titleInput = useRef<HTMLInputElement>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [descriptionEdit, setDescriptionEdit] = useState<string | null>(null);
  const title = titleEdit ?? item.title;
  const description = descriptionEdit ?? item.description;
  const open = item.status === 'pending';
  const locked = !open || modal.busy || modal.uncertain || checking;
  const blocked = !generation || !title.trim() || Boolean(modal.failure?.conflict) ||
    title.trim() === item.title && description.trim() === item.description;
  useEffect(() => { titleInput.current?.focus(); }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open || checking || !modal.uncertain && blocked) return;
    void onSubmit(() => ({ restoreGeneration: generation, expectedVersion: item.version, title: title.trim(), description: description.trim() }));
  }

  return <form aria-label="요청 수정" className="issue-intake-form" onSubmit={submit} onChange={modal.markDirty}>
    {!open && <p role="status">요청은 이미 처리됐습니다. 입력한 내용을 확인할 수 있습니다.</p>}
    <fieldset disabled={locked}>
      <label>요청 제목<input className="field" ref={titleInput} value={title} maxLength={200} required
        onChange={event => setTitleEdit(event.currentTarget.value === item.title ? null : event.currentTarget.value)} /></label>
      <label>요청 내용<textarea className="field" value={description} maxLength={5000} rows={5}
        onChange={event => setDescriptionEdit(event.currentTarget.value === item.description ? null : event.currentTarget.value)} /></label>
    </fieldset>
    {modal.failure && <div className="issue-intake-error"><p role="alert">{modal.failure.message}</p>
      {modal.failure.conflict && <button type="button" className="btn" disabled={checking} onClick={() => void readLatest()}>
        {checking ? '확인 중…' : '최신 상태 확인'}
      </button>}
    </div>}
    <div className="issue-intake-modal-actions">
      <button type="button" className="btn" disabled={modal.busy || checking} onClick={onCancel}>수정 취소</button>
      <button type="submit" className="btn btn-primary" data-intake-retry disabled={!open || modal.busy || checking || !modal.uncertain && blocked}>
        {modal.busy ? '저장 중…' : modal.uncertain ? '같은 요청 다시 확인' : '수정 저장'}
      </button>
    </div>
  </form>;
}

function IntakeDecision({ item, snapshot, modal, checking, readLatest, onSubmit }: {
  item: IssueIntakeRequest; snapshot: WorkspaceSnapshot; modal: ReturnType<typeof useIntakeMutation>; checking: boolean;
  readLatest: () => Promise<void>; onSubmit: (input: () => Record<string, unknown>) => Promise<void>;
}) {
  const { projectId } = item;
  const [decision, setDecision] = useState<Decision>('accept');
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [descriptionEdit, setDescriptionEdit] = useState<string | null>(null);
  const title = titleEdit ?? item.title;
  const description = descriptionEdit ?? item.description;
  const [type, setType] = useState(() => initialIssueType(snapshot, projectId));
  const workflow = projectWorkflow(snapshot, projectId);
  const [status, setStatus] = useState(() => workflow.initialStatusId);
  const [customFields, setCustomFields] = useState<Record<string, CustomFieldValue>>({});
  const [target, setTarget] = useState<Pick<Issue, 'id' | 'key' | 'title' | 'version'> | null>(null);
  const [reason, setReason] = useState('');
  const required = requiredFieldsFor(snapshot, projectId, type, status);
  const targetIssue = target && snapshot.issues.find(issue => issue.id === target.id && issue.projectId === projectId);
  const targetChanged = target !== null && (!targetIssue || target.version !== targetIssue.version);
  const open = item.status === 'pending';
  const locked = !open || modal.busy || modal.uncertain || checking;
  const blocked = Boolean(!snapshot.restoreGeneration || modal.failure?.conflict ||
    (decision === 'accept' && (!title.trim() || !workflow.statuses.some(value => value.id === status))) ||
    (decision === 'duplicate' && (!target || targetChanged)) || (decision === 'reject' && !reason.trim()));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open || checking || !modal.uncertain && blocked) return;
    const form = event.currentTarget;
    void onSubmit(() => {
      const base = { restoreGeneration: snapshot.restoreGeneration, expectedVersion: item.version, decision,
        ...(decision !== 'accept' && reason.trim() ? { reason: reason.trim() } : {}) };
      if (decision === 'duplicate') return { ...base, issueId: target?.id, expectedIssueVersion: target?.version };
      if (decision === 'reject') return base;
      const fields = new FormData(form);
      const text = (name: string) => String(fields.get(name) ?? '');
      const nullable = (name: string) => text(name) || null;
      const number = (name: string) => text(name) === '' ? null : Number(text(name));
      return { ...base, expectedWorkflowVersion: workflow.version, expectedIssueSchemaVersion: projectIssueSchema(snapshot, projectId).version,
        issue: { title: title.trim(), description, type, status, priority: text('priority'), assigneeId: nullable('assigneeId'),
          startDate: nullable('startDate'), endDate: nullable('endDate'), dueDate: nullable('dueDate'), labels: text('labels').split(',')
            .map(value => value.trim()).filter(Boolean), parentId: nullable('parentId'), collaboratorIds: fields.getAll('collaboratorIds'),
          cycleId: nullable('cycleId'), moduleId: nullable('moduleId'), releaseId: nullable('releaseId'), estimate: number('estimate'),
          plannedEffortMinutes: number('plannedEffortMinutes'), customFields } };
    });
  }

  return <form className="issue-intake-form" hidden={!open && !modal.changed} onSubmit={submit} onChange={modal.markDirty}>
    {!open && <p role="status">요청은 이미 처리됐습니다. 작성 중이던 검토 내용을 확인할 수 있습니다.</p>}
    <fieldset disabled={locked}>
      <label>처리 방식<select className="field" value={decision} onChange={event => setDecision(event.currentTarget.value as Decision)}>
        {Object.entries(decisionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <fieldset hidden={decision !== 'accept'} disabled={decision !== 'accept'}>
        <label>업무 제목<input className="field" required value={title} maxLength={300}
          onChange={event => setTitleEdit(event.currentTarget.value === item.title ? null : event.currentTarget.value)} /></label>
        <label>업무 설명<textarea className="field" value={description} rows={4} maxLength={200000}
          required={required.includes('description')} onChange={event => setDescriptionEdit(event.currentTarget.value === item.description ? null : event.currentTarget.value)} /></label>
        <div className="issue-intake-field-grid">
          <label>유형<IssueTypeSelect data={snapshot} projectId={projectId} value={type} onChange={setType} /></label>
          <label>상태<select className="field" value={status} required onChange={event => setStatus(event.currentTarget.value)}>
            {!workflow.statuses.some(value => value.id === status) && <option value={status} disabled>{status} (현재 사용 불가)</option>}
            {workflow.statuses.map(value => <option value={value.id} key={value.id}>{value.label}</option>)}
          </select></label>
          <label>우선순위<select className="field" name="priority" defaultValue="medium">
            {Object.entries(PRIORITY).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <label>담당자<select className="field" name="assigneeId" required={required.includes('assigneeId')} defaultValue="">
            <option value="">미지정</option>{snapshot.users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}
          </select></label>
          <label>목표 마감일<input className="field" type="date" name="dueDate" required={required.includes('dueDate')} /></label>
        </div>
        <CustomFields data={snapshot} projectId={projectId} issueType={type} status={status} values={customFields} disabled={locked || decision !== 'accept'}
          onChange={value => { modal.markDirty(); setCustomFields(value); }} requiredFields={required} />
        {required.length > 0 && <p className="issue-intake-meta">필수 속성 · {requiredFieldLabels(snapshot, projectId, required).join(', ')}</p>}
        <details className="issue-intake-details"
          open={required.some(field => ['startDate', 'endDate', 'estimate', 'labels', 'parentId', 'collaboratorIds', 'cycle', 'module', 'release'].includes(field)) || undefined}>
          <summary>추가 속성</summary>
          <div className="issue-intake-field-grid">
            <label>시작일<input className="field" type="date" name="startDate" required={required.includes('startDate')} /></label>
            <label>종료일<input className="field" type="date" name="endDate" required={required.includes('endDate')} /></label>
            <label>예상 소요 (포인트)<input className="field" type="number" name="estimate" min={0} step="any" required={required.includes('estimate')} /></label>
            <label>계획 작업 시간 (분)<input className="field" type="number" name="plannedEffortMinutes" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} /></label>
            <label>라벨<input className="field" name="labels" placeholder="쉼표로 구분" required={required.includes('labels')} /></label>
            <label>상위 업무<select className="field" name="parentId" required={required.includes('parentId')} defaultValue=""><option value="">미지정</option>
              {snapshot.issues.filter(issue => issue.projectId === projectId)
                .map(issue => <option value={issue.id} key={issue.id}>{issue.key} · {issue.title}</option>)}</select></label>
            {(['cycle', 'module', 'release'] as const).map(kind => <label key={kind}>{PLAN_LABELS[kind]}<PlanningSelect data={snapshot} projectId={projectId}
              kind={kind} required={required.includes(kind)} /></label>)}
            <label>참여자<select className="field" name="collaboratorIds" required={required.includes('collaboratorIds')} multiple>
              {snapshot.users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select></label>
          </div>
        </details>
      </fieldset>
      <fieldset hidden={decision !== 'duplicate'} disabled={decision !== 'duplicate'}>
        <IntakeDuplicatePicker issues={snapshot.issues} projectId={projectId} target={target}
          onChoose={issue => { modal.markDirty(); setTarget(issue); }} />
        {targetChanged && <p role="status">선택한 업무가 변경됐습니다. 목록에서 최신 업무를 다시 선택해 주세요.</p>}
      </fieldset>
      <label hidden={decision === 'accept'}>{decision === 'reject' ? '반려 사유' : '연결 메모'}
        <textarea className="field" maxLength={1000} rows={3} value={reason} required={decision === 'reject'}
          disabled={decision === 'accept'} onChange={event => setReason(event.currentTarget.value)} /></label>
    </fieldset>
    {modal.failure && <div className="issue-intake-error"><p role="alert">{modal.failure.message}</p>
      {modal.failure.conflict && <button type="button" className="btn" disabled={checking} onClick={() => void readLatest()}>
        {checking ? '확인 중…' : '최신 상태 확인'}
      </button>}
    </div>}
    {open && <div className="issue-intake-modal-actions">
      <button type="button" className="btn" disabled={modal.busy} onClick={modal.dismiss}>닫기</button>
      <button type="submit" className="btn btn-primary" data-intake-retry disabled={modal.busy || checking || !modal.uncertain && blocked}>
        {modal.busy ? '저장 중…' : modal.uncertain ? '같은 요청 다시 확인' : decisionLabels[decision]}
      </button>
    </div>}
  </form>;
}

function IntakeDuplicatePicker({ issues, projectId, target, onChoose }: {
  issues: readonly Issue[]; projectId: string; target: Pick<Issue, 'id' | 'key' | 'title' | 'version'> | null;
  onChoose: (issue: Pick<Issue, 'id' | 'key' | 'title' | 'version'>) => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  const matching = issues.filter(issue => issue.projectId === projectId && (!needle ||
    `${issue.key} ${issue.title}`.toLocaleLowerCase('ko-KR').includes(needle)))
    .sort((a, b) => Number(b.key.toLowerCase() === needle) - Number(a.key.toLowerCase() === needle) || b.updatedAt.localeCompare(a.updatedAt));
  return <div className="issue-intake-picker">
    <label>기존 업무 검색<input className="field" type="search" value={query} maxLength={200}
      placeholder="업무 번호·제목" onChange={event => setQuery(event.currentTarget.value)} /></label>
    {target && <p className="issue-intake-meta">선택한 업무 · <strong>{target.key} {target.title}</strong></p>}
    {matching.length > 0 ? <ul aria-label="연결할 기존 업무">{matching.slice(0, 20).map(issue => <li key={issue.id}>
      <button type="button" className="btn" aria-pressed={target?.id === issue.id && target.version === issue.version}
        onClick={() => onChoose({ id: issue.id, key: issue.key, title: issue.title, version: issue.version })}>
        <span>{issue.key}</span><strong>{issue.title}</strong>
      </button>
    </li>)}</ul> : <p role="status">이 프로젝트에서 검색 조건에 맞는 업무가 없습니다.</p>}
    {matching.length > 20 && <small>20건을 표시합니다. 더 자세한 검색어를 입력해 주세요.</small>}
  </div>;
}
