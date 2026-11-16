import { Store } from './store.js';
import type { Issue, DocPage, RichContent } from '../shared/types.js';

export { documentPlainText as plain } from '../shared/document-nodes.js';
import { documentPlainText as plain } from '../shared/document-nodes.js';
export function seed(s: Store) {
  if (s.all('projects').length || s.all('users').length) return;
  s.transaction(() => {
    const now = new Date().toISOString();
    const date = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
    const users = [
      { id: 'user-min', name: '김민수', email: 'minsu@example.test', color: '#5879ed' },
      { id: 'user-seo', name: '이서연', email: 'seoyeon@example.test', color: '#a77bd4' },
      { id: 'user-jun', name: '박준호', email: 'junho@example.test', color: '#d79b56' },
      { id: 'user-yun', name: '정윤지', email: 'yunji@example.test', color: '#409d89' },
    ];
    users.forEach(u => s.put('users', u));
    const projects = [
      { id: 'project-neo', key: 'NEO', name: '엣지 플랫폼', description: '합성 예제 · 장비 연결과 데이터 수집 프로젝트', color: '#5879ed', createdAt: now },
      { id: 'project-team', key: 'TEAM', name: '팀 워크스페이스', description: '합성 예제 · 팀의 업무와 지식을 연결하는 공간', color: '#409d89', createdAt: now },
    ];
    projects.forEach(p => s.put('projects', p));
    const titles = ['장비 연결 안정화', '통신 오류 재시도 정책 구현', '설정 화면 사용성 개선', '데이터 수집 경계값 테스트', '연결 끊김 알림 누락 수정', '릴리스 검증 체크리스트', '개발 환경 설치 가이드', '수집 상태 대시보드', '팀 업무 흐름 정의', '간트 일정 입력 개선', '문서 템플릿 정리', 'GitLab 연동 검증'];
    const statuses = ['in_progress', 'review', 'todo', 'in_progress', 'done', 'todo', 'done', 'backlog', 'done', 'in_progress', 'todo', 'review'] as const;
    titles.forEach((title, i) => {
      const projectId = i < 8 ? 'project-neo' : 'project-team';
      const key = `${i < 8 ? 'NEO' : 'TEAM'}-${i < 8 ? i + 1 : i - 7}`;
      const issue: Issue = {
        id: `issue-${i + 1}`, key, projectId, title, description: `이 항목은 제품 흐름을 확인하기 위한 합성 예제입니다.\n\n목표: ${title}\n완료 조건: 구현 내용과 검증 결과를 관련 문서에 기록합니다.`,
        type: i === 0 ? '큰틀' : i === 4 ? '버그' : i === 10 ? '기획' : '작업', status: statuses[i], priority: i === 4 ? 'urgent' : i % 3 === 0 ? 'high' : 'medium',
        assigneeId: users[i % 4].id, collaboratorIds: i === 0 ? [users[1].id] : [], parentId: i === 1 || i === 3 ? 'issue-1' : null,
        labels: i < 8 ? ['플랫폼', i % 2 ? '백엔드' : '프론트엔드'] : ['팀 도구'],
        startDate: i === 7 ? null : date(-8 + i), endDate: i === 7 ? null : date(-4 + i), dueDate: date(12 + i),
        estimate: i % 3 + 2, cycle: i === 7 ? null : '11월 2차', module: i < 8 ? '장비 연결' : '업무 기반', release: '0.1',
        version: 1, createdAt: now, updatedAt: now, completedAt: statuses[i] === 'done' ? now : null,
      }; s.put('issues', issue);
    });
    s.db.prepare('INSERT INTO issue_sequences VALUES(?,?)').run('project-neo', 9);
    s.db.prepare('INSERT INTO issue_sequences VALUES(?,?)').run('project-team', 5);
    const content = (title: string, body: string): RichContent => ({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] },
      { type: 'paragraph', content: [{ type: 'text', text: '합성 예제 문서 · 실제 운영 자료가 아닙니다.', marks: [{ type: 'italic' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: body }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '완료 기준' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '담당자와 검증 항목을 합의합니다.' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '업무 티켓과 결과를 연결합니다.' }] }] },
      ] },
    ] });
    const docSpecs = [
      ['doc-overview', 'project-neo', null, '엣지 플랫폼 개요', '장비 연결, 수집, 관측 기능을 작은 업무 단위로 나누고 문서와 연결합니다.', '🛰️'],
      ['doc-retry', 'project-neo', 'doc-overview', '통신 재시도 설계', '재시도는 지수 백오프를 사용하며 중복 수집을 방지합니다. 실패 원인을 기록하고 사용자에게 상태를 표시합니다.', '🔌'],
      ['doc-team', 'project-team', null, '우리 팀의 일하는 방식', '요구사항을 티켓으로 정리하고 문서에 결정을 남깁니다. 보드와 간트는 같은 티켓을 보여 줍니다.', '🧭'],
      ['doc-weekly', 'project-team', 'doc-team', '주간 공유 템플릿', '이번 주 완료한 일, 진행 중인 일, 막힌 일, 다음 주 계획을 함께 정리합니다.', '📝'],
    ];
    docSpecs.forEach(([id, projectId, parentId, title, body, icon], i) => {
      const c = content(title!, body!);
      const d: DocPage = { id: id!, projectId: projectId!, parentId, title: title!, content: c, plainText: plain(c), icon: icon!, status: 'published', authorId: users[i % 4].id, version: 1, createdAt: now, updatedAt: now };
      s.put('documents', d);
      s.put('revisions', { id: `revision-${i + 1}`, documentId: d.id, version: 1, title: d.title, content: d.content, plainText: d.plainText, authorId: d.authorId, createdAt: now, summary: '합성 예제 최초 작성' });
    });
    [['issue-1','doc-overview'],['issue-2','doc-retry'],['issue-9','doc-team'],['issue-11','doc-weekly']].forEach(([issueId,documentId],i) => s.put('resource_links',{ id:`link-${i+1}`,issueId,documentId,kind:'관련 문서'}));
    s.put('dependencies',{id:'dep-1',predecessorId:'issue-2',successorId:'issue-6',type:'FS',lagDays:0});
    s.put('dependencies',{id:'dep-2',predecessorId:'issue-10',successorId:'issue-12',type:'FS',lagDays:0});
    s.put('comments',{ id:'comment-1',resourceType:'issue',resourceId:'issue-2',authorId:users[1].id,body:'재시도 횟수와 최대 대기 시간을 문서에 정리했습니다. 함께 검토해 주세요. (합성 예제)',createdAt:now });
    s.put('activities',{id:'activity-seed',resourceType:'workspace',resourceId:'workspace',actorId:users[0].id,action:'샘플 데이터 생성',detail:'두 프로젝트와 업무·문서를 합성 예제로 준비했습니다.',createdAt:now});
  });
}
