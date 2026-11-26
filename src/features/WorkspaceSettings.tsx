import { lazy, Suspense, useCallback, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Plus, Users } from 'lucide-react';
import type { FeatureProps, User } from '../../shared/types';
import { NATIVE_BACKUP_SCHEMA_VERSION, supportsNativeBackupVersion } from '../../shared/native-backup';
import { api, post } from '../lib/api';
import { cn } from '@/src/lib/utils';
import { scrollEdgeMask, useScrollEdges } from '@/src/components/navigation/use-scroll-edges';
import { clearGanttDateDrafts } from './gantt-date-draft-storage';
import { WorkspaceMemberEmailDialog } from './WorkspaceMemberEmailDialog';
import type { PrepareMigration } from './MigrationApplySettings';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './workspace-settings-sections';
const WorkflowSettings = lazy(() => import('./WorkflowSettings').then(module => ({default: module.WorkflowSettings})));
const IssueAssignmentRules = lazy(() => import('./IssueAssignmentRules').then(module => ({default: module.IssueAssignmentRules})));
const IssueSchemaSettings = lazy(() => import('./IssueSchemaSettings').then(module => ({default: module.IssueSchemaSettings})));
const IssueTemplateSettings = lazy(() => import('./IssueTemplateSettings').then(module => ({default: module.IssueTemplateSettings})));
const RecurringIssueSettings = lazy(() => import('./RecurringIssueSettings').then(module => ({default: module.RecurringIssueSettings})));
const CalendarSettings = lazy(() => import('./CalendarSettings').then(module => ({default: module.CalendarSettings})));
const DeadlineReminderSettings = lazy(() => import('./DeadlineReminderSettings').then(module => ({default: module.DeadlineReminderSettings})));
const MigrationApplySettings = lazy(() => import('./MigrationApplySettings').then(module => ({default:module.MigrationApplySettings})));
const LegacyImportSettings = lazy(() => import('./LegacyImportSettings').then(module => ({default:module.LegacyImportSettings})));
const ApiKeysSettings = lazy(() => import('./ApiKeysSettings').then(module => ({default: module.ApiKeysSettings})));

type WorkspaceSettingsProps = FeatureProps & {
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
};

/*
 * Every section stays mounted and inactive ones are only hidden, so unsaved
 * drafts, open dialogs and the legacy-import → migration wiring survive
 * switching sections.
 */
function SettingsSection({ id, active, children }: { id: SettingsSectionId; active: SettingsSectionId; children: ReactNode }) {
  const label = SETTINGS_SECTIONS.find(section => section.id === id)!.label;
  return <div id={`settings-section-${id}`} data-settings-section={id} hidden={id !== active}>
    <h2 id={`settings-section-${id}-title`} className="mb-4 text-xl font-semibold text-fg-primary">{label}</h2>
    {children}
  </div>;
}

export function WorkspaceSettings({ section, onSectionChange, ...props }: WorkspaceSettingsProps) {
  const [name,setName]=useState('');const [email,setEmail]=useState('');const [busy,setBusy]=useState(false);const [importData,setImportData]=useState<unknown>(null);const [importName,setImportName]=useState('');
  const [emailEdit, setEmailEdit] = useState<{ user: User; restoreGeneration?: string; opener: HTMLButtonElement } | null>(null);
  const [packageInventoryVersion, setPackageInventoryVersion] = useState(0);
  const prepareMigrationRef = useRef<PrepareMigration>(null);
  const { ref: sectionNavRef, edges: sectionNavEdges } = useScrollEdges<HTMLElement>();
  const packageInventoryChanged = useCallback(() => setPackageInventoryVersion(version => version + 1), []);
  const prepareMigration: PrepareMigration = packages => {
    if (prepareMigrationRef.current) return prepareMigrationRef.current(packages);
    props.notify('이관 매핑 화면을 불러온 뒤 다시 선택해 주세요.', 'error');
    return false;
  };
  async function restoreWorkspace() {
    setBusy(true);
    try {
      await post('/import', { data: importData });
      try { clearGanttDateDrafts(window.sessionStorage); } catch { /* The new restore generation also fences these drafts. */ }
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('teamspace:document-draft:') || key.startsWith('teamspace:document-comment-draft:') ||
          key.startsWith('teamspace:document-selection-comment-draft:')) localStorage.removeItem(key);
      }
      await props.refresh();
      window.dispatchEvent(new Event('teamspace:workspace-imported'));
      setImportData(null);
      props.notify('백업 데이터를 가져왔습니다. 기존 API 키는 회수되었습니다.');
    } catch (error) { props.notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  return <div className="page settings-page"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>팀의 작업 공간</h1><p>간단한 팀원 관리와 데이터 이동 기능을 제공합니다.</p></div></div>
    <div className="grid gap-6 min-[901px]:grid-cols-[176px_minmax(0,1fr)]">
      <nav ref={sectionNavRef} aria-label="설정 섹션" className={cn("-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 pb-1 min-[901px]:sticky min-[901px]:top-6 min-[901px]:mx-0 min-[901px]:flex-col min-[901px]:self-start min-[901px]:overflow-visible min-[901px]:px-0", scrollEdgeMask(sectionNavEdges))}>
        {SETTINGS_SECTIONS.map(item => <button key={item.id} type="button" aria-current={item.id === section ? 'page' : undefined}
          aria-controls={`settings-section-${item.id}`} onClick={() => onSectionChange(item.id)}
          className={cn('shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-base text-fg-secondary transition-colors hover:bg-layer-1-hover hover:text-fg-primary',
            item.id === section && 'bg-selected font-medium text-brand-fg hover:bg-selected-hover hover:text-brand-fg')}>{item.label}</button>)}
      </nav>
      <div className="min-w-0">
    <SettingsSection id="general" active={section}>
    <section className="card settings-card"><div className="card-heading"><h2><Users size={19}/>팀원</h2><span className="badge">{props.data.users.length}명</span></div><p className="muted">상단의 작업자를 선택하면 변경 이력에 해당 팀원이 기록됩니다. 현재는 별도의 로그인 기능을 사용하지 않습니다.</p>
    <div className="team-list">{props.data.users.map(user => <div className="team-row" key={user.id}>
      <span className="avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span><strong>{user.name}</strong><span>{user.email}</span>
      <button type="button" className="btn btn-ghost" onClick={event =>
        setEmailEdit({ user, restoreGeneration: props.data.restoreGeneration, opener: event.currentTarget })}>이메일 변경</button>
    </div>)}</div><form className="invite-form" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await post('/users',{name,email,color:'#6785b5'});setName('');setEmail('');await props.refresh();props.notify('팀원을 추가했습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}><input className="field" aria-label="새 팀원 이름" placeholder="이름" value={name} onChange={e=>setName(e.target.value)} required/><input type="email" className="field" aria-label="새 팀원 이메일" placeholder="이메일" value={email} onChange={e=>setEmail(e.target.value)} required/><button disabled={busy} className="btn btn-primary"><Plus size={16}/>팀원 추가</button></form></section>
    {emailEdit && <WorkspaceMemberEmailDialog user={emailEdit.user} restoreGeneration={emailEdit.restoreGeneration}
      actorId={props.actorId} refresh={props.refresh} notify={props.notify}
      onClose={() => {
        const { opener } = emailEdit;
        setEmailEdit(null);
        requestAnimationFrame(() => { if (opener.isConnected) opener.focus(); });
      }}/>}
    {props.actorId && <Suspense fallback={<div className="card settings-card"><p>마감 알림 설정을 불러오는 중입니다.</p></div>}>
      <DeadlineReminderSettings key={props.actorId} actorId={props.actorId}
        actorName={props.data.users.find(user => user.id === props.actorId)?.name ?? '현재 작업자'} notify={props.notify}/>
    </Suspense>}
    </SettingsSection>
    <SettingsSection id="work" active={section}>
    <Suspense fallback={<div className="card settings-card"><p>프로젝트 워크플로를 불러오는 중입니다.</p></div>}><WorkflowSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>담당자 배정 규칙을 불러오는 중입니다.</p></div>}><IssueAssignmentRules {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>업무 양식을 불러오는 중입니다.</p></div>}><IssueSchemaSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>업무 템플릿을 불러오는 중입니다.</p></div>}><IssueTemplateSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>반복 업무를 불러오는 중입니다.</p></div>}><RecurringIssueSettings {...props}/></Suspense>
    </SettingsSection>
    <SettingsSection id="calendar" active={section}>
    <Suspense fallback={<div className="card settings-card"><p>업무 달력을 불러오는 중입니다.</p></div>}><CalendarSettings {...props}/></Suspense>
    </SettingsSection>
    <SettingsSection id="integrations" active={section}>
    <Suspense fallback={<div className="card settings-card"><p>API 키를 불러오는 중입니다.</p></div>}><ApiKeysSettings actorId={props.actorId}
      projects={props.data.projects} restoreGeneration={props.data.restoreGeneration} refreshWorkspace={props.refresh} notify={props.notify}/></Suspense>
    </SettingsSection>
    <SettingsSection id="migration" active={section}>
    <Suspense fallback={<div className="card settings-card"><p>원본 이관 분석을 불러오는 중입니다.</p></div>}>
      <LegacyImportSettings {...props} onPackageInventoryChange={packageInventoryChanged} onPrepareMigration={prepareMigration}/>
    </Suspense>
    <Suspense fallback={null}>
      <MigrationApplySettings {...props} packageInventoryVersion={packageInventoryVersion} prepareMigrationRef={prepareMigrationRef}/>
    </Suspense>
    </SettingsSection>
    <SettingsSection id="data" active={section}>
    <section className="card settings-card"><div className="card-heading"><h2>데이터 내보내기 · 가져오기</h2><ArrowDownToLine size={19}/></div><p className="muted">티켓·문서·관계, 문서 검토·발행 기록, 휴지통, 개인 즐겨찾기, 팀 알림과 개인 마감 알림 설정, 작업 시간과 보고서 보관본, 변경 이력을 자체 JSON 형식으로 보관합니다. API 키, GitLab 토큰과 외부 웹훅 설정·비밀값·전송 기록은 포함되지 않습니다.</p><div className="data-actions"><button className="btn btn-secondary" onClick={async()=>{try{const payload=await api('/export');const url=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`teamspace-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);props.notify('데이터를 내보냈습니다.');}catch(e){props.notify((e as Error).message,'error');}}}><ArrowDownToLine size={16}/>전체 데이터 내보내기</button><label className="btn btn-ghost"><ArrowUpFromLine size={16}/>백업 가져오기<input className="sr-only" type="file" accept="application/json,.json" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>64*1024*1024-1024){props.notify('가져오기 파일은 64MB 미만이어야 합니다.','error');e.target.value='';return;}try{const parsed=JSON.parse(await file.text());if(!parsed || typeof parsed!=='object' || !supportsNativeBackupVersion(parsed.schemaVersion))throw new Error(`Teamspace 내보내기 파일(schemaVersion 1~${NATIVE_BACKUP_SCHEMA_VERSION})을 선택해주세요.`);setImportData(parsed);setImportName(file.name);}catch(error){props.notify(error instanceof SyntaxError ? '올바른 JSON 파일이 아닙니다.' : (error as Error).message,'error');}e.target.value='';}}/></label></div></section>
    <section className="card settings-card"><div className="card-heading"><h2>이 개발 버전의 범위</h2><span className="badge">개발 중</span></div><p>팀원 선택은 작업자 기록을 위한 기능입니다. 프로젝트별 워크플로와 공유 보기, 문서별 공동 편집, 팀 보고서와 주간 문서를 사용할 수 있습니다.</p><p className="muted">실제 Jira·Confluence 파일 이관 리허설, 운영 GitLab 연결과 팀 사용 검증이 남아 있습니다.</p></section>
    {importData !== null && <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-label="백업 가져오기 확인"><h2>백업을 가져올까요?</h2><p><strong>{importName}</strong></p><p>현재 워크스페이스의 티켓·문서·계획·관계·첨부·작업 시간·보고서·팀 알림·개인 마감 알림 설정·개인 즐겨찾기와 휴지통 데이터를 이 백업으로 교체하고 이 브라우저의 임시 문서·댓글·간트 날짜 및 마감 알림 설정 초안도 초기화합니다. 업무 양식·업무 템플릿·티켓 필드 변경 기록·기준 계획·마일스톤·업무 달력도 교체하며 백업에 없는 항목은 초기화됩니다. GitLab 자동화 규칙은 비활성으로 복원됩니다. 반복 업무는 백업의 활성 상태·다음 실행과 최근 실행 기록을 적용합니다. 외부 웹훅 설정과 대기 전송은 초기화되고 기존 API 키는 모두 회수되며 필요한 키는 다시 발급해야 합니다. 먼저 현재 데이터를 내보내어 보관해주세요.</p><div className="modal-actions"><button className="btn" onClick={()=>setImportData(null)}>취소</button><button className="btn btn-danger" disabled={busy} onClick={restoreWorkspace}>확인하고 가져오기</button></div></div></div>}
    </SettingsSection>
      </div>
    </div>
  </div>;
}
