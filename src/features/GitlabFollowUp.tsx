'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { gitlabFollowUpEvidence, gitlabFollowUpPath, type GitlabFollowUpEvidence, type GitlabFollowUpPreview } from '../../shared/gitlab-follow-up';
import type { FeatureProps, GitlabLink, Issue } from '../../shared/types';
import { api } from '../lib/api';
import { NewIssueModal } from './NewIssueModal';

export type GitlabFollowUpActions = {
  eligible: ReadonlyMap<string, GitlabFollowUpEvidence>;
  disabled: boolean;
  open: (link: GitlabFollowUpEvidence, opener: HTMLButtonElement) => void;
};

type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'refresh' | 'notify' | 'openIssue'>;

export function useGitlabFollowUp(props: Props, links: readonly GitlabLink[], disabled: boolean, fallback: RefObject<HTMLElement | null>) {
  const eligible = useMemo(() => gitlabFollowUpEvidence(links), [links]);
  const controller = useRef<AbortController | null>(null);
  const openerRef = useRef<{ button: HTMLButtonElement; linkId: string } | null>(null);
  const returningFocus = useRef(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<GitlabFollowUpPreview>();
  const [created, setCreated] = useState<Pick<Issue, 'id' | 'key'>>();
  const [message, setMessage] = useState('');

  useEffect(() => () => controller.current?.abort(), []);
  const close = useCallback(() => {
    returningFocus.current = true;
    setPreview(undefined);
  }, []);
  useLayoutEffect(() => {
    if (preview || !returningFocus.current) return;
    returningFocus.current = false;
    const opener = openerRef.current;
    const current = opener?.button.isConnected && !opener.button.disabled ? opener.button
      : opener && fallback.current?.closest('section')?.querySelector<HTMLButtonElement>(
        `[data-gitlab-follow-up="${CSS.escape(opener.linkId)}"]:enabled`);
    (current ?? fallback.current)?.focus({ preventScroll: true });
  }, [fallback, preview]);

  async function open(source: GitlabFollowUpEvidence, opener: HTMLButtonElement) {
    if (disabled || preview || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    openerRef.current = { button: opener, linkId: source.linkId };
    setLoading(true);
    setMessage('');
    setCreated(undefined);
    try {
      const result = await api<GitlabFollowUpPreview>(gitlabFollowUpPath(source.issueId, source.linkId), {
        signal: request.signal, cache: 'no-store',
      });
      if (request.signal.aborted) return;
      if (result?.source?.id !== source.issueId || result.source.projectId !== props.projectId ||
          result.evidence?.linkId !== source.linkId || result.evidence.href !== source.href ||
          result.evidence.state !== source.state || result.evidence.observedAt !== source.observedAt ||
          !/^[a-f0-9]{64}$/u.test(result.revision)) {
        throw new Error('GitLab 근거가 변경되었습니다. 개발 활동을 새로고침한 뒤 다시 확인해 주세요.');
      }
      setPreview(result);
    } catch (cause) {
      if (!request.signal.aborted) {
        setMessage(cause instanceof Error ? cause.message : 'GitLab 근거를 불러오지 못했습니다.');
        requestAnimationFrame(() => opener.isConnected && opener.focus({ preventScroll: true }));
      }
    } finally {
      controller.current = null;
      if (!request.signal.aborted) setLoading(false);
    }
  }

  const actions: GitlabFollowUpActions = { eligible, disabled: disabled || loading || Boolean(preview), open };
  const content = <>
    {loading && <p className="gitlab-activity-hint" role="status">저장된 GitLab 근거를 불러오는 중입니다.</p>}
    {message && <p className="issue-form-error" role="alert">{message}</p>}
    {created && <div className="gitlab-activity-feedback">
      <p role="status"><strong>{created.key}</strong> 후속 업무를 원본과 연결했습니다.</p>
      <button className="btn" type="button" onClick={() => props.openIssue(created.id)}>{created.key} 업무 열기</button>
    </div>}
    {preview && createPortal(<NewIssueModal {...props} gitlabFollowUp={preview} onClose={close} onGitlabFollowUpCreated={setCreated} />, document.body)}
  </>;
  return { actions, content };
}
