'use client';

import { ArrowDown, Files, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LegacyPackageSummary } from '../../shared/types';
import { ApiError } from '../lib/api';
import { LEGACY_FILE_ACCEPT, MAX_LEGACY_INSTANCE_LENGTH, legacyFileProblem, legacySizeLabel, uploadLegacyFile, type LegacyImportProduct } from './legacy-import-upload';
import './legacy-import-batch.css';

interface Props {
  actorId: string;
  disabled: boolean;
  packages: readonly LegacyPackageSummary[];
  defaults: { instanceKey: string; product: LegacyImportProduct };
  onBegin: () => boolean;
  onEnd: () => void;
  onDraftChange: (dirty: boolean, discard: () => void) => void;
  onConfirmed: (summary: LegacyPackageSummary) => void;
  readInventory: () => Promise<LegacyPackageSummary[] | undefined>;
  onOpenPackage: (id: string) => void;
  onPrepareMigration: (packages: LegacyPackageSummary[]) => boolean;
}

type RowState = 'waiting' | 'running' | 'saved' | 'reused' | 'failed' | 'unknown';
type BatchRow = { id: number; file: File; instanceKey: string; product: LegacyImportProduct; state: RowState; summary?: LegacyPackageSummary; error?: string };
const MAX_FILES = 20;
const labels: Record<RowState, string> = { waiting: '분석 대기', running: '분석 중', saved: '분석 완료', reused: '기존 분석 재사용', failed: '분석 실패', unknown: '결과 확인 필요' };
const UNCONFIRMED = '분석 결과를 확인하지 못했습니다. 같은 파일과 원본 식별값으로 다시 확인해 주세요.';

function ready(row: BatchRow) {
  return !legacyFileProblem(row.file) && Boolean(row.instanceKey.trim()) && row.instanceKey.length <= MAX_LEGACY_INSTANCE_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(row.instanceKey);
}

function recordedPackage(row: BatchRow, inventory: ReadonlyMap<string, LegacyPackageSummary>) {
  const recorded = row.summary;
  const current = recorded && inventory.get(recorded.id);
  return current && current.sha256 === recorded.sha256 && current.version === recorded.version &&
    current.source.product === recorded.source.product && current.source.instanceKey === recorded.source.instanceKey ? current : undefined;
}

function confirmedPackages(rows: BatchRow[], inventory: ReadonlyMap<string, LegacyPackageSummary>) {
  return [...new Map(rows.flatMap(row => {
    const summary = recordedPackage(row, inventory);
    return summary ? [[summary.id, summary] as const] : [];
  })).values()];
}

export function LegacyImportBatch({
  actorId, disabled, packages, defaults, onBegin, onEnd, onDraftChange, onConfirmed, readInventory, onOpenPackage, onPrepareMigration,
}: Props) {
  const panelId = useId();
  const headingId = useId();
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const active = useRef(true);
  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState('');
  const [fileError, setFileError] = useState('');
  const inventory = useMemo(() => new Map(packages.map(summary => [summary.id, summary])), [packages]);
  const unresolved = rows.filter(row => !recordedPackage(row, inventory)).length;
  const waiting = rows.filter(row => row.state === 'waiting' && ready(row));
  const locked = disabled || running || checking;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const discard = useCallback(() => {
    stopRef.current = true;
    setRows([]);
    setProgress('');
    setFileError('');
    if (input.current) input.current.value = '';
  }, []);
  const dirty = unresolved > 0;
  useLayoutEffect(() => {
    onDraftChange(dirty, discard);
    return () => onDraftChange(false, discard);
  }, [dirty, discard, onDraftChange]);

  function addFiles(files: FileList | null) {
    if (!files?.length || runningRef.current || disabled) return;
    const selected = Array.from(files);
    if (input.current) input.current.value = '';
    if (rows.length + selected.length > MAX_FILES) {
      setFileError(`한 번에 파일 ${MAX_FILES}개까지 목록에 넣을 수 있습니다.`);
      return;
    }
    const added = selected.map(file => ({ id: ++nextId.current, file, ...defaults, state: 'waiting' as const }));
    setRows(previous => [...previous, ...added]);
    setFileError('');
    setProgress('');
  }

  function update(id: number, changes: Partial<Omit<BatchRow, 'id' | 'file'>>) {
    setRows(previous => previous.map(row => row.id === id ? { ...row, ...changes } : row));
  }

  async function run(queue: BatchRow[]) {
    if (runningRef.current || disabled || !queue.length || !onBegin()) return;
    runningRef.current = true;
    stopRef.current = false;
    setRunning(true);
    setStopping(false);
    setProgress('');
    let completed = 0;
    try {
      for (const row of queue) {
        if (!active.current || stopRef.current) break;
        update(row.id, { state: 'running', error: undefined, summary: undefined });
        try {
          const { summary, reused } = await uploadLegacyFile(row.file, row.instanceKey, row.product, actorId);
          if (!active.current) break;
          update(row.id, { state: reused ? 'reused' : 'saved', summary });
          onConfirmed(summary);
        } catch (cause) {
          if (!active.current) break;
          const failed = cause instanceof ApiError && cause.status < 500 && ![408, 425, 429, 499].includes(cause.status);
          update(row.id, { state: failed ? 'failed' : 'unknown', error: failed ? cause.message : UNCONFIRMED });
        }
        completed++;
      }
      if (active.current) {
        setProgress(completed < queue.length ? '진행 중이던 파일 처리 후 중지했습니다. 남은 파일을 이어서 분석할 수 있습니다.'
          : '선택한 파일 처리를 마쳤습니다. 파일별 결과를 확인하세요.');
      }
    } finally {
      runningRef.current = false;
      if (active.current) { setRunning(false); setStopping(false); }
      onEnd();
    }
  }

  function removeRow(id: number) {
    if (runningRef.current || disabled) return;
    setRows(previous => previous.filter(row => row.id !== id));
    setFileError('');
    setProgress('');
  }

  async function prepareMigration() {
    if (locked || unresolved || !rows.length || !onBegin()) return;
    setChecking(true);
    setFileError('');
    try {
      const latest = await readInventory();
      if (!active.current) return;
      if (!latest) { setFileError('최신 분석 목록을 불러오지 못했습니다. 다시 시도해 주세요.'); return; }
      const latestInventory = new Map(latest.map(summary => [summary.id, summary]));
      if (rows.some(row => !recordedPackage(row, latestInventory))) {
        setFileError('보관한 분석 목록이 변경되었습니다. 해당 파일의 결과를 확인해 주세요.');
        return;
      }
      onPrepareMigration(confirmedPackages(rows, latestInventory));
    } finally {
      if (active.current) setChecking(false);
      onEnd();
    }
  }

  return <div className="legacy-batch-entry">
    <button className="btn" type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={locked}
      onClick={() => setOpen(value => !value)}><Files size={16} aria-hidden="true" />여러 원본 파일 분석</button>
    {open && <section id={panelId} className="legacy-batch" aria-labelledby={headingId}>
      <header><h3 id={headingId}>여러 원본 파일 분석</h3>
        <p>ZIP·XML·CSV·JSON 파일을 최대 {MAX_FILES}개, 파일당 64 MiB까지 선택하세요. 같은 서버에서 받은 파일에는 같은 원본 인스턴스 식별값을 사용하세요.</p>
      </header>
      <label className="legacy-batch-picker">분석할 원본 파일 여러 개
        <input ref={input} type="file" className="field" accept={LEGACY_FILE_ACCEPT} multiple disabled={locked}
          onChange={event => addFiles(event.currentTarget.files)} />
      </label>
      {fileError && <p className="legacy-error" role="alert">{fileError}</p>}
      {rows.length > 0 && <ul className="legacy-batch-rows" role="list" aria-label="분석할 파일 목록">
        {rows.map(row => {
          const fileProblem = legacyFileProblem(row.file);
          const summary = recordedPackage(row, inventory);
          const removed = Boolean(row.summary && !summary);
          const sealed = Boolean(summary || row.state === 'unknown');
          const state = fileProblem || removed ? 'failed' : row.state;
          const error = fileProblem || (removed ? '보관한 분석 목록에서 이 패키지를 찾을 수 없습니다.' : row.error);
          return <li key={row.id} data-batch-filename={row.file.name} data-state={state}>
            <div className="legacy-batch-row-head"><strong>{row.file.name}</strong><small>{legacySizeLabel(row.file.size)}</small>
              <span className="legacy-batch-state">{labels[state]}</span>
            </div>
            <fieldset aria-label={`${row.file.name} 원본 설정`} disabled={locked || sealed || Boolean(fileProblem)}>
              <label>원본 도구<select className="field" value={row.product}
                onChange={event => update(row.id, { product: event.currentTarget.value as LegacyImportProduct, error: undefined })}>
                <option value="auto">자동 판별</option><option value="jira">Jira</option><option value="confluence">Confluence</option>
              </select></label>
              <label>원본 인스턴스 식별값<input className="field" value={row.instanceKey} placeholder="예: jira-team-original"
                maxLength={MAX_LEGACY_INSTANCE_LENGTH} onChange={event => update(row.id, { instanceKey: event.currentTarget.value, error: undefined })} /></label>
            </fieldset>
            {summary && <p className="legacy-batch-result">{summary.source.product === 'jira' ? 'Jira' : 'Confluence'} · 오류 {summary.errors}건 · 경고 {summary.warnings}건</p>}
            {error && <p className="legacy-error" role="alert">{error}</p>}
            <div className="legacy-batch-actions">
              <button className="btn btn-ghost" type="button" disabled={locked} onClick={() => removeRow(row.id)}><Trash2 size={14} aria-hidden="true" />파일 제외</button>
              {summary && <button className="btn btn-ghost" type="button" disabled={locked} onClick={() => onOpenPackage(summary.id)}>분석 상세 보기</button>}
              {(state === 'failed' || state === 'unknown') && !fileProblem && <button className="btn" type="button" disabled={locked || !ready(row)}
                onClick={() => void run([row])}>{state === 'unknown' ? '같은 요청으로 다시 확인' : '다시 분석'}</button>}
            </div>
          </li>;
        })}
      </ul>}
      {(running || progress) && <p className="legacy-batch-progress" role="status">{running ? (stopping ? '현재 파일의 분석을 마치면 중지합니다.' : '파일을 차례대로 분석하는 중입니다.') : progress}</p>}
      <div className="legacy-batch-actions legacy-batch-footer">
        <button className="btn btn-primary" type="button" disabled={locked || !waiting.length} onClick={() => void run(waiting)}>
          <Upload size={16} aria-hidden="true" />원본 파일 순차 분석
        </button>
        {running && <button className="btn" type="button" disabled={stopping} onClick={() => { stopRef.current = true; setStopping(true); }}>현재 분석 후 중지</button>}
        <button className="btn" type="button" disabled={locked || unresolved > 0 || !rows.length} onClick={() => void prepareMigration()}>
          <ArrowDown size={15} aria-hidden="true" />분석한 패키지로 이관 매핑
        </button>
      </div>
      {unresolved > 0 && !running && <p className="legacy-batch-progress">분석 결과가 없는 파일 {unresolved}개가 있습니다. 남은 파일을 분석하거나 목록에서 제외하면 이관 매핑을 열 수 있습니다.</p>}
    </section>}
  </div>;
}
