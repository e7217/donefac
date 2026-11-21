import type { RichContent } from '../../shared/types';

const paragraph = (text = ''): RichContent => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
const heading = (text: string): RichContent => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });

export const DOCUMENT_TEMPLATES = [
  { id: 'blank', name: '빈 문서', description: '생각을 자유롭게 기록하세요.', icon: '📄' },
  { id: 'meeting', name: '회의록', description: '안건, 논의, 결정사항과 다음 할 일', icon: '💬' },
  { id: 'design', name: '설계 문서', description: '배경부터 구조와 검증 계획까지', icon: '📐' },
  { id: 'weekly', name: '주간 공유', description: '이번 주의 진행 상황과 다음 계획', icon: '🗓️' },
  { id: 'decision', name: '의사결정 기록', description: '선택의 이유와 영향을 남기세요.', icon: '💡' },
] as const;

export function templateContent(id: string): RichContent {
  const sections: Record<string, [string, string][]> = {
    meeting: [['회의 정보', '일시 · 참석자'], ['안건', '오늘 함께 이야기할 주제를 적어주세요.'], ['논의 내용', ''], ['결정사항', ''], ['다음 할 일', '담당자와 완료 예정일을 함께 적어주세요.']],
    design: [['배경과 문제', '어떤 문제를 해결하려고 하나요?'], ['목표와 범위', ''], ['설계', '구성과 데이터 흐름, 중요한 선택의 이유를 기록하세요.'], ['검증 계획', ''], ['열린 질문', '']],
    weekly: [['이번 주 진행', ''], ['완료한 일', ''], ['막힌 부분과 필요한 도움', ''], ['다음 주 계획', '']],
    decision: [['상태', '제안'], ['배경', '이 결정이 필요한 이유를 설명해주세요.'], ['검토한 선택지', ''], ['결정', ''], ['영향과 후속 작업', '']],
  };
  return { type: 'doc', content: sections[id] ? sections[id].flatMap(([title, body]) => [heading(title), paragraph(body)]) : [paragraph()] };
}
