'use client';

import { useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { Comment, FeatureProps } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import './comment-trash.css';

export const COMMENT_LIST_CHANGED = 'donefac:comments-changed';

type Props = Pick<FeatureProps, 'actorId' | 'notify' | 'refresh'> & {
  comment: Comment;
  disabled?: boolean;
  confirmation?: string;
  onArchived: (comment: Comment) => void;
};

export function CommentTrashButton({ comment, actorId, notify, refresh, disabled, confirmation, onArchived }: Props) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  if (!actorId || comment.authorId !== actorId) return null;
  const label = comment.parentCommentId ? '답글' : '댓글';

  async function archive() {
    if (busy.current || disabled || !window.confirm(confirmation ?? `${label}을 휴지통으로 옮길까요? 휴지통에서 복원할 수 있습니다.`)) return;
    busy.current = true;
    setPending(true);
    try {
      await api(`/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE', headers: { 'X-Actor-Id': actorId } });
      onArchived(comment);
      window.dispatchEvent(new Event('donefac:trash-changed'));
      notify(`${label}을 휴지통으로 옮겼습니다.`);
      void refresh().catch(() => undefined);
    } catch (error) {
      notify(error instanceof Error ? error.message : `${label}을 휴지통으로 옮기지 못했습니다.`, 'error');
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        window.dispatchEvent(new Event('donefac:trash-changed'));
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <button className="comment-trash-button" type="button" aria-label={`${label} 삭제`} title={`${label}을 휴지통으로 이동`}
    disabled={pending || disabled} aria-busy={pending} onClick={() => void archive()}>
    {pending ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
  </button>;
}
