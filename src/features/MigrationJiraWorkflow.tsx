'use client';

import { useId, useState } from 'react';
import type {
  MigrationConfiguration, MigrationJiraObservedWorkflow, MigrationJiraWorkflow, MigrationJiraWorkflowReview, MigrationJiraWorkflowStatus, MigrationOptions,
} from '../../shared/types';
import { STATUS_CATEGORY_LABELS } from '../../shared/workflow-helpers';

type WorkflowStatusOption = Pick<MigrationJiraWorkflowStatus, 'id' | 'label'>;
type WorkflowMappings = NonNullable<MigrationConfiguration['jiraWorkflows']>;
type WorkflowEdge = MigrationJiraWorkflow['transitions'][number];
type Destination = {
  key: string;
  name: string;
  states: Map<string, WorkflowStatusOption>;
};
const projectKey = /^[A-Z][A-Z0-9]{1,11}$/u;
const statusLimit = 40;
const additionalStatusIds = Array.from({ length: statusLimit }, (_, index) => `s_new_${index + 1}`);
const observedPageSize = 12;
const transitionKey = ({ from, to }: WorkflowEdge) => `${from}:${to}`;
const observedKey = (project: string, edge: WorkflowEdge) => `${project}:${transitionKey(edge)}`;

function destinations(options: MigrationOptions, projects: MigrationConfiguration['projects']) {
  const projectsByContainer = new Map(projects.map(project => [project.containerId, project]));
  const groups = new Map<string, Destination>();
  for (const status of options.jiraWorkflowStatuses ?? []) {
    for (const containerId of status.containerIds) {
      const project = projectsByContainer.get(containerId);
      if (!project) continue;
      const key = project.key.trim().toUpperCase();
      if (!projectKey.test(key)) continue;
      let group = groups.get(key);
      if (!group) {
        group = { key, name: project.name.trim(), states: new Map() };
        groups.set(key, group);
      }
      group.states.set(status.id, { id: status.id, label: status.label });
    }
  }
  return groups;
}

function statusLabels(states: readonly WorkflowStatusOption[]) {
  const counts = new Map<string, number>();
  for (const { label } of states) counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map(states.map(({ id, label }) => [id, (counts.get(label) ?? 0) > 1 ? `${label} · ${id}` : label]));
}

export function MigrationJiraWorkflowEditor({ options, configuration, onChange }: {
  options: MigrationOptions;
  configuration: MigrationConfiguration;
  onChange: (workflows: WorkflowMappings) => void;
}) {
  const groups = destinations(options, configuration.projects);
  const drafts = configuration.jiraWorkflows ?? {};
  const unassigned = Object.keys(drafts).filter(key => !groups.has(key));
  const available = [...groups.values()].filter(group => !Object.hasOwn(drafts, group.key));
  const allStatusLabels = new Map(options.jiraWorkflowStatuses?.map(({ id, label }) => [id, label]));

  function changeDraft(key: string, draft?: MigrationJiraWorkflow) {
    const next = { ...drafts };
    if (draft) next[key] = draft;
    else delete next[key];
    onChange(next);
  }

  function moveDraft(previousKey: string, key: string) {
    const next = { ...drafts, [key]: drafts[previousKey] };
    delete next[previousKey];
    onChange(next);
  }

  return <>
    <p>새 프로젝트에서 새 업무의 초기 상태와 허용할 방향을 지정할 수 있습니다. 원본 이력에서만 확인한 상태는 초기 상태나 허용 전이로 선택할 수 있습니다.</p>
    {!groups.size && <p>워크플로를 지정할 Jira 프로젝트의 키를 확인해 주세요.</p>}
    {[...groups.values()].map(group => <WorkflowEditor key={group.key} group={group} value={drafts[group.key]}
      allStatusLabels={allStatusLabels} onChange={value => changeDraft(group.key, value)} />)}
    {unassigned.map(key => <section key={key} className="migration-jira-workflow" aria-label={`대상을 확인할 워크플로 ${key}`}>
      <h4>{key}의 워크플로</h4>
      <p>이 워크플로와 연결된 프로젝트 키를 확인해 주세요. 매핑할 대상을 고르거나 이 설정을 제거할 수 있습니다.</p>
      {available.length > 0 && <label>워크플로를 옮길 프로젝트
        <select className="field" value="" onChange={event => moveDraft(key, event.target.value)}>
          <option value="" disabled>프로젝트 선택</option>
          {available.map(group => <option value={group.key} key={group.key}>{group.key} · {group.name}</option>)}
        </select>
      </label>}
      <button type="button" className="btn btn-ghost" onClick={() => changeDraft(key)}>워크플로 설정 제거</button>
    </section>)}
  </>;
}

function WorkflowEditor({ group, value, allStatusLabels, onChange }: {
  group: Destination;
  value: MigrationJiraWorkflow | undefined;
  allStatusLabels: ReadonlyMap<string, string>;
  onChange: (value?: MigrationJiraWorkflow) => void;
}) {
  const [requestedFrom, setRequestedFrom] = useState('');
  const additional = value?.additionalStatuses ?? [];
  const states = [...group.states.values(), ...additional];
  const labels = statusLabels(states);
  const initial = value?.initialStatusId ?? '';
  const from = labels.has(requestedFrom) ? requestedFrom : labels.has(initial) ? initial : states[0]?.id ?? '';
  const nextAdditionalId = additionalStatusIds.find(id => !labels.has(id));
  const unknownEdges = value?.transitions.filter(edge => !labels.has(edge.from) || !labels.has(edge.to)) ?? [];
  const labelOf = (id: string) => labels.get(id) || allStatusLabels.get(id) || id;

  function addStatus() {
    if (!value || !nextAdditionalId) return;
    const number = additionalStatusIds.indexOf(nextAdditionalId) + 1;
    const status: MigrationJiraWorkflowStatus = { id: nextAdditionalId, label: `새 상태 ${number}`, category: 'todo' };
    onChange({ ...value, additionalStatuses: [...additional, status] });
  }

  function editStatus(id: string, changes: Partial<Pick<MigrationJiraWorkflowStatus, 'label' | 'category'>>) {
    if (!value) return;
    onChange({ ...value, additionalStatuses: additional.map(status => status.id === id ? { ...status, ...changes } : status) });
  }

  function removeStatus(id: string) {
    if (!value) return;
    onChange({
      ...value,
      initialStatusId: value.initialStatusId === id ? states[0].id : value.initialStatusId,
      additionalStatuses: additional.filter(status => status.id !== id),
      transitions: value.transitions.filter(edge => edge.from !== id && edge.to !== id),
    });
  }

  function toggleEdge(source: string, target: string, allowed: boolean) {
    if (!value) return;
    onChange({
      ...value,
      transitions: allowed ? [...value.transitions, { from: source, to: target }]
        : value.transitions.filter(edge => edge.from !== source || edge.to !== target),
    });
  }

  return <section className="migration-jira-workflow" aria-label={`워크플로 매핑 ${group.key}`}>
    <h4>{group.key}{group.name && ` · ${group.name}`}</h4>
    <label className="migration-jira-workflow-check">
      <input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked ? {
        initialStatusId: states[0].id, transitions: [],
      } : undefined)} />
      <span>허용 전이 직접 지정</span>
    </label>
    {value && <>
      <div className="migration-jira-workflow-fields">
        <label>초기 상태
          <select className="field" value={value.initialStatusId} onChange={event => onChange({ ...value, initialStatusId: event.target.value })}>
            {!labels.has(value.initialStatusId) && <option value={value.initialStatusId} disabled>{labelOf(value.initialStatusId)} · 다시 선택 필요</option>}
            {states.map(({ id }) => <option value={id} key={id}>{labelOf(id)}</option>)}
          </select>
        </label>
        <label>전이 출발 상태
          <select className="field" value={from} onChange={event => setRequestedFrom(event.target.value)}>
            {states.map(({ id }) => <option value={id} key={id}>{labelOf(id)}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="migration-jira-transitions">
        <legend>허용할 도착 상태</legend>
        {states.length < 2 && <small>다른 상태를 추가하면 전이를 지정할 수 있습니다.</small>}
        {states.filter(({ id }) => id !== from).map(({ id }) => <label className="migration-jira-workflow-check" key={id}>
          <input type="checkbox" aria-label={`전이 허용 ${labelOf(id)}`} checked={value.transitions.some(edge => edge.from === from && edge.to === id)}
            onChange={event => toggleEdge(from, id, event.target.checked)} />
          <span>{labelOf(id)}</span>
        </label>)}
      </fieldset>
      <p><small role="status">{value.transitions.length ? `허용 전이 ${value.transitions.length}개` : '허용 전이 0개 · 상태 변경 제한'}</small></p>
      {unknownEdges.length > 0 && <div className="migration-error">
        <p>현재 프로젝트에서 사용할 수 없는 상태가 포함된 전이를 제거해 주세요.</p>
        <ul>{unknownEdges.map(({ from, to }) => <li key={`${from}:${to}`}>
          <span>{labelOf(from)} → {labelOf(to)}</span>{' '}
          <button type="button" className="btn btn-ghost" onClick={() => toggleEdge(from, to, false)}>전이 제거</button>
        </li>)}</ul>
      </div>}
      {additional.length > 0 && <div className="migration-jira-additional">
        <p>추가 상태를 제거하면 연결된 전이도 함께 삭제됩니다. 초기 상태를 제거하면 첫 원본 상태를 초기 상태로 선택합니다.</p>
        {additional.map(status => <div className="migration-jira-workflow-fields" key={status.id}>
          <label>추가 상태 이름
            <input className="field" value={status.label} maxLength={40}
              onChange={event => editStatus(status.id, { label: event.target.value })} />
          </label>
          <label>추가 상태 분류
            <select className="field" value={status.category}
              onChange={event => editStatus(status.id, { category: event.target.value as MigrationJiraWorkflowStatus['category'] })}>
              {Object.entries(STATUS_CATEGORY_LABELS).map(([category, label]) => <option value={category} key={category}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" aria-label={`${labelOf(status.id)} 상태 제거`}
            onClick={() => removeStatus(status.id)}>상태 제거</button>
        </div>)}
      </div>}
      <button type="button" className="btn" disabled={!nextAdditionalId} onClick={addStatus}>상태 추가</button>
      <small>미리보기에서 이관 업무의 상태와 추가 상태를 합쳐 40개까지 확인합니다.</small>
    </>}
  </section>;
}

export function MigrationJiraWorkflowPreview({ workflows }: { workflows: readonly MigrationJiraWorkflowReview[] }) {
  return <section className="migration-jira-preview" aria-label="적용할 Jira 워크플로">
    <h4>적용할 Jira 워크플로</h4>
    {workflows.map(workflow => <WorkflowPreviewRow key={workflow.projectKey} workflow={workflow} />)}
  </section>;
}

export function MigrationJiraObservedWorkflowReview({ workflows, drafts, disabled, selected, onChoose, onClear, onAdopt }: {
  workflows: readonly MigrationJiraObservedWorkflow[];
  drafts: WorkflowMappings | undefined;
  disabled: boolean;
  selected: ReadonlySet<string>;
  onChoose: (id: string, checked: boolean) => void;
  onClear: () => void;
  onAdopt: (workflows: WorkflowMappings, count: number) => void;
}) {
  function adopt() {
    const next = { ...drafts };
    let count = 0;
    for (const workflow of workflows) {
      const previous = drafts?.[workflow.projectKey];
      const configured = new Set(previous?.transitions.map(transitionKey));
      const additions = workflow.transitions.filter(edge => selected.has(observedKey(workflow.projectKey, edge)) && !configured.has(transitionKey(edge)))
        .map(({ from, to }) => ({ from, to }));
      if (!additions.length) continue;
      next[workflow.projectKey] = {
        ...previous,
        initialStatusId: previous?.initialStatusId ?? workflow.initialStatusId,
        transitions: [...(previous?.transitions ?? []), ...additions],
      };
      count += additions.length;
    }
    if (count) onAdopt(next, count);
  }

  return <section className="migration-jira-preview" aria-label="Jira 이력에서 확인한 전이">
    <h4>Jira 이력에서 확인한 전이</h4>
    <p>이관할 업무의 이력에서 각 방향을 사용한 업무 수입니다. Jira의 전이 조건·검증기·후처리는 별도로 검토해 주세요.</p>
    {workflows.map(workflow => <ObservedWorkflowGroup key={workflow.projectKey} workflow={workflow}
      configured={drafts?.[workflow.projectKey]?.transitions} disabled={disabled} selected={selected} onChoose={onChoose} />)}
    <div className="migration-review-actions">
      <button type="button" className="btn" disabled={disabled || !selected.size} onClick={adopt}>선택한 전이를 매핑에 추가</button>
      {selected.size > 0 && <button type="button" className="btn btn-ghost" onClick={onClear}>전이 선택 취소</button>}
      <small role="status">전이 {selected.size.toLocaleString()}개 선택{selected.size > 0 && ' · 매핑에 추가하거나 선택을 취소한 뒤 계속해 주세요.'}</small>
    </div>
  </section>;
}

function ObservedWorkflowGroup({ workflow, configured, disabled, selected, onChoose }: {
  workflow: MigrationJiraObservedWorkflow;
  configured?: readonly WorkflowEdge[];
  disabled: boolean;
  selected: ReadonlySet<string>;
  onChoose: (id: string, checked: boolean) => void;
}) {
  const [page, setPage] = useState(0);
  const description = useId();
  const labels = statusLabels(workflow.statuses);
  const current = new Set(configured?.map(transitionKey));
  const { projectKey, transitions } = workflow;
  const start = page * observedPageSize;
  const end = Math.min(start + observedPageSize, transitions.length);
  return <fieldset className="migration-jira-workflow migration-jira-observed" aria-label={`Jira 이력 전이 ${projectKey}`} disabled={disabled}>
    <legend>{projectKey} · 방향 {transitions.length.toLocaleString()}개</legend>
    {transitions.slice(start, end).map((edge, index) => {
      const name = `${labels.get(edge.from) ?? edge.from} → ${labels.get(edge.to) ?? edge.to}`;
      const id = observedKey(projectKey, edge);
      const detailId = `${description}-${start + index}`;
      const mapped = current.has(transitionKey(edge));
      return <label className="migration-jira-workflow-check" key={id}>
        <input type="checkbox" aria-label={name} aria-describedby={detailId} disabled={mapped} checked={selected.has(id)}
          onChange={event => onChoose(id, event.target.checked)} />
        <span>{name}<small id={detailId}>업무 {edge.issueCount.toLocaleString()}개에서 확인{mapped && ' · 이미 매핑됨'}</small></span>
      </label>;
    })}
    {transitions.length > observedPageSize && <div className="migration-pagination">
      <span role="status">{start + 1}–{end} / {transitions.length.toLocaleString()}</span>
      <button type="button" className="btn btn-ghost" aria-label={`${projectKey} 관찰 전이 이전 페이지`} disabled={!page}
        onClick={() => setPage(page - 1)}>이전</button>
      <button type="button" className="btn btn-ghost" aria-label={`${projectKey} 관찰 전이 다음 페이지`} disabled={end >= transitions.length}
        onClick={() => setPage(page + 1)}>다음</button>
    </div>}
  </fieldset>;
}

function WorkflowPreviewRow({ workflow }: { workflow: MigrationJiraWorkflowReview }) {
  const [expanded, setExpanded] = useState(false);
  const labels = statusLabels(workflow.statuses);
  const labelOf = (id: string) => labels.get(id) || id;
  const count = workflow.transitions.length;
  const edges = (count <= 20 || expanded) && <ul>
    {workflow.transitions.map(({ from, to }) => <li key={`${from}:${to}`}>{labelOf(from)} → {labelOf(to)}</li>)}
  </ul>;
  return <div className="migration-jira-workflow">
    <strong>{workflow.projectKey}</strong>
    <p>초기 상태 {labelOf(workflow.initialStatusId)}</p>
    <details>
      <summary>적용 상태 {workflow.statuses.length}개</summary>
      <ul>{workflow.statuses.map(({ id, category }) => <li key={id}>{labelOf(id)} · {STATUS_CATEGORY_LABELS[category]}</li>)}</ul>
    </details>
    {count === 0 ? <p>허용 전이 0개 · 상태 변경 제한</p> : count <= 20 ? edges
      : <details onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>허용 전이 {count}개</summary>{edges}
      </details>}
  </div>;
}
