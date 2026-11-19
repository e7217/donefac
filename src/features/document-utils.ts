import type { RichContent } from '../../shared/types';
import { ISSUE_SUMMARY_GROUP_LABELS, documentPlainText, isIssueSummaryGroupBy } from '../../shared/document-nodes';

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

export function contentText(node: RichContent): string { return documentPlainText(node); }

function summaryHtml(node: RichContent): string {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  if (node.type === 'hardBreak') return '<br>';
  if (node.type !== 'text') return (node.content || []).map(summaryHtml).join('');
  let text = escape(node.text || '');
  for (const mark of node.marks || []) {
    const tag = ({bold:'strong',italic:'em',strike:'s',code:'code',underline:'u'} as Record<string,string>)[mark.type];
    if (tag) text = `<${tag}>${text}</${tag}>`;
    if (mark.type === 'link' && /^(?:https?:\/\/|mailto:|#|\/)/i.test(String(mark.attrs?.href || ''))) text = `<a href="${escape(String(mark.attrs?.href))}">${text}</a>`;
  }
  return text;
}

export function contentMarkdown(node: RichContent): string {
  const inline = () => (node.content || []).map(contentMarkdown).join('');
  if (node.type === 'text') {
    let text = (node.text || '').replace(/([\\`*_[\]])/g, '\\$1');
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') text = `**${text}**`;
      if (mark.type === 'italic') text = `*${text}*`;
      if (mark.type === 'strike') text = `~~${text}~~`;
      if (mark.type === 'code') text = '`' + (node.text || '').replace(/`/g, '\\`') + '`';
      if (mark.type === 'link') text = `[${text}](${String(mark.attrs?.href || '').replace(/[()]/g, encodeURIComponent)})`;
    }
    return text;
  }
  switch (node.type) {
    case 'doc': return inline().trim() + '\n';
    case 'paragraph': return inline() + '\n\n';
    case 'heading': return '#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1))) + ' ' + inline() + '\n\n';
    case 'hardBreak': return '  \n';
    case 'issueReference': return `[${String(node.attrs?.label || node.attrs?.issueId || '업무').replace(/([\\\[\]])/g, '\\$1')}](#/all/issues?issue=${encodeURIComponent(String(node.attrs?.issueId || ''))})\n\n`;
    case 'documentReference': return `[${String(node.attrs?.label || node.attrs?.documentId || '문서').replace(/([\\\[\]])/g, '\\$1')}](#/all/documents/${encodeURIComponent(String(node.attrs?.documentId || ''))})\n\n`;
    case 'documentInclude': return `> 문서 포함: [${String(node.attrs?.label || node.attrs?.documentId || '문서').replace(/([\\\[\]])/g, '\\$1')}](#/all/documents/${encodeURIComponent(String(node.attrs?.documentId || ''))})\n\n`;
    case 'issueList':
    case 'issueSummary': {
      const projectId = String(node.attrs?.projectId || '');
      const savedViewId = typeof node.attrs?.savedViewId === 'string' ? node.attrs.savedViewId : null;
      const escape = (value: string) => value.replace(/\s+/g, ' ').replace(/([\\`*_\[\]<>])/g, '\\$1');
      const blockLabel = node.type === 'issueSummary' ? '업무 현황' : '업무 목록';
      const label = escape(String(node.attrs?.label || projectId || blockLabel));
      const path = encodeURIComponent(projectId).replace(/\(/g, '%28').replace(/\)/g, '%29');
      const groupBy = isIssueSummaryGroupBy(node.attrs?.groupBy) ? node.attrs.groupBy : 'status';
      const group = node.type === 'issueSummary' ? ` · ${ISSUE_SUMMARY_GROUP_LABELS[groupBy]} 기준` : '';
      const prefix = node.type === 'issueSummary' ? '업무 현황 ·' : '업무 목록:';
      return `> ${prefix} [${label}](#/${path}/issues)${savedViewId ? ` · 공유 보기 ${escape(savedViewId)}` : ''}${group}\n\n`;
    }
    case 'details': return `<details>\n${inline()}</details>\n\n`;
    case 'detailsSummary': return `<summary>${summaryHtml(node)}</summary>\n\n`;
    case 'detailsContent': return inline();
    case 'horizontalRule': return '\n---\n\n';
    case 'codeBlock': return '```' + (node.attrs?.language || '') + '\n' + contentText(node).trimEnd() + '\n```\n\n';
    case 'blockquote': return inline().trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    case 'bulletList': return (node.content || []).map(child => '- ' + contentMarkdown(child).trim().replace(/\n/g, '\n  ')).join('\n') + '\n\n';
    case 'orderedList': return (node.content || []).map((child, index) => `${Number(node.attrs?.start || 1) + index}. ` + contentMarkdown(child).trim().replace(/\n/g, '\n   ')).join('\n') + '\n\n';
    case 'taskList': return inline() + '\n';
    case 'taskItem': return `- [${node.attrs?.checked ? 'x' : ' '}] ` + inline().trim() + '\n';
    case 'image': return `![${String(node.attrs?.alt || '').replace(/\]/g, '\\]')}](${String(node.attrs?.src || '').replace(/[()]/g, encodeURIComponent)})\n\n`;
    case 'table': {
      const rows = (node.content || []).map(row => (row.content || []).map(cell => contentMarkdown(cell).trim().replace(/\n/g, '<br>').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      return '| ' + rows[0].join(' | ') + ' |\n| ' + rows[0].map(() => '---').join(' | ') + ' |\n' + rows.slice(1).map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
    }
    default: return inline();
  }
}

export function downloadDocument(filename: string, value: string, mime: string) {
  const url = URL.createObjectURL(new Blob([value], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
