const sourceLabels = new Map([
  ['push', '푸시'],
  ['merge_request_event', 'MR'],
  ['schedule', '예약'],
  ['web', '웹 수동 실행'],
  ['webide', '웹 IDE'],
  ['api', 'API'],
  ['trigger', '트리거'],
  ['pipeline', '다중 프로젝트'],
  ['parent_pipeline', '하위 파이프라인'],
  ['chat', '채팅'],
  ['external', '외부 실행'],
  ['external_pull_request_event', '외부 PR'],
]);

export function gitlabPipelineSource(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : undefined;
}

export function gitlabPipelineSourceLabel(source: unknown, tag?: boolean): string {
  const verified = gitlabPipelineSource(source);
  const label = verified ? sourceLabels.get(verified) ?? '기타 실행 유형' : '실행 유형 미확인';
  return tag === true ? `태그 · ${label}` : label;
}
