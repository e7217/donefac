# 업무 상세 화면 개편 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 업무 상세를 넓은 오버레이의 "본문 + 접는 속성 칸" 구조로 바꾸고, 본문을 Markdown 저장·서식 편집으로, 저장을 즉시·자동 저장으로 전환한다.

**Architecture:** 순수 로직(Markdown 변환, 저장 대기열·충돌 병합, 초안 보관)을 먼저 테스트와 함께 만들고, 그 위에 편집기·속성 칸·활동 탭 컴포넌트를 올린 뒤 `IssuePanel.tsx`를 새 구조로 재배선한다. 서버 API는 바꾸지 않는다(`PATCH /api/issues/:id`, `POST /api/attachments`, `POST /api/issues/:id/schedule-save-preview`를 그대로 사용). 마지막에 기존 브라우저 검사를 새 상호작용에 맞게 옮긴다.

**Tech Stack:** React 19, TypeScript, TipTap 3.34(@tiptap/react·starter-kit·task-list·table·image), marked 18, radix-ui 1.6(Popover·DropdownMenu·Tabs), Tailwind v4 + shadcn, lucide-react, node:test(tsx), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-issue-detail-redesign-design.md`

## Global Constraints

- 해시 주소를 바꾸지 않는다: `#/{project}/issues?issue={id}`와 기존 쿼리(`gitlab`, 검토 순서)가 그대로 열려야 한다.
- 색은 `app/tokens.css` 의미 토큰, 글자·굵기·모서리·그림자는 `@theme` 토큰만 쓴다. 기능 CSS에 hex·rgb·px 글자 크기를 새로 쓰지 않는다.
- 새 화면 요소는 Tailwind 유틸리티와 `src/components/ui`의 shadcn 컴포넌트로 만든다. 한 요소에서 기존 기능 CSS와 유틸리티로 같은 속성을 섞지 않는다.
- 아이콘은 `lucide-react`만 쓴다. 글자 기호를 아이콘으로 쓰지 않는다.
- 업무 데이터의 원본은 서버다. 브라우저 저장소는 보기 설정(속성 칸 접힘)과 미저장 초안에만 쓴다.
- 모든 업무 변경은 `expectedVersion`을 보내고, 복원 세대가 있으면 `requestId`·`expectedRestoreGeneration`을 함께 보낸다. 미저장 입력을 조용히 버리지 않는다.
- 업무 설명 저장 형식은 Markdown 문자열이다. 새 업무와 처음 편집 저장된 업무의 `descriptionFormat`은 `'markdown'`이다.
- 화면 문구는 한국어다. 설계 문서가 정하지 않은 동작은 Plane 또는 Notion 방식을 따른다.
- 브라우저 검사는 고유한 합성 데이터를 만들고 정리하며, 동시에 실행하는 Playwright 검사는 서로 다른 `--output` 디렉터리를 쓴다.
- 각 작업 끝에 관련 `npm test` 대상과 `npm run typecheck`가 통과해야 한다. UI 작업은 관련 브라우저 검사를 함께 통과해야 한다.

## Review Focus

1. 첫 응답이 오기 전에 속성을 연달아 두 번 바꾸면 두 변경이 순서대로 모두 저장되고 409가 나지 않아야 한다. → Task 2 `serializes back-to-back changes using the previous response version`.
2. 평문 설명에 `*강조*`, `# 제목`, `1. 항목` 같은 글자가 있을 때 업무를 열고 닫기만 하면 서버에 아무 요청도 가지 않고 설명이 그대로여야 한다. → Task 1 `plain text round-trips literally`와 Task 7 브라우저 `opening a plain description sends no save`.
3. 본문 자동 저장 응답이 끊긴 뒤 새로고침하면 입력이 복원되고 같은 요청으로 결과를 확인해야 한다. → Task 3 `keeps draft until server version covers it`와 Task 7 브라우저 `restores unsaved body after reload`.
4. 이미지를 붙여넣고 업로드가 끝나기 전에 계속 타이핑하면 자동 저장이 미뤄졌다가 이미지와 글이 함께 저장되어야 한다. → Task 5 브라우저 `defers autosave until pasted image upload finishes`.
5. 새 상태에서만 보이는 필수 사용자 정의 필드가 있을 때 상태를 고르면 입력 단계가 열리고, 취소하면 상태가 바뀌지 않아야 한다. → Task 6 브라우저 `status needing hidden required field opens input step`.

---

### Task 1: 업무 설명 Markdown 변환 모듈

**Files:**
- Create: `shared/issue-description-markdown.ts`
- Modify: `shared/document-markdown-import.ts` (`MarkdownArchiveConversion`에 옵션 추가, 첫 H1 제목 추출 분기 `:120`, `:143`)
- Test: `tests/server/issue-description-markdown.test.ts`

**Interfaces:**
- Consumes: `readArchiveMarkdown(source, options)`(document-markdown-import), `renderTicketDescriptionMarkdown(content, links)`, `escapeMarkdownText(value)`(document-export-markdown), `RichContent`, `IssueDescriptionFormat`(shared/types).
- Produces:
  - `export const ISSUE_BODY_NODE_TYPES: readonly string[]` — 허용 노드: `doc, paragraph, heading, text, hardBreak, bulletList, orderedList, listItem, taskList, taskItem, blockquote, codeBlock, horizontalRule, table, tableRow, tableHeader, tableCell, image`. 허용 마크: `bold, italic, strike, code, link`.
  - `export function issueMarkdownToContent(markdown: string, format: IssueDescriptionFormat): RichContent`
  - `export function issueContentToMarkdown(content: RichContent): string`
  - `export function isIssueMarkdownEditable(markdown: string, format: IssueDescriptionFormat): boolean` — 서식 편집기로 열어도 되는지(왕복 무손실 + 허용 노드만).
  - `export function plainTextToIssueMarkdown(text: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
test('plain text round-trips literally', () => {
  const plain = '*강조 아님*\n# 제목 아님\n1. 목록 아님\n<b>태그</b>';
  const markdown = plainTextToIssueMarkdown(plain);
  const content = issueMarkdownToContent(plain, 'plain');
  assert.equal(issueContentToMarkdown(content), markdown);
  assert.equal(documentPlainText(content).replace(/\n+/g, '\n').trim(), plain);
});
test('canonical markdown round-trips unchanged', () => {
  for (const md of ['# 제목\n\n본문 **굵게** _기울임_ ~~취소~~ `코드` [링크](https://example.invalid)',
    '- 하나\n- 둘\n\n1. 첫째\n2. 둘째', '- [ ] 할 일\n- [x] 끝남', '> 인용', '```ts\nconst a = 1;\n```', '---',
    '| 가 | 나 |\n| --- | --- |\n| 1 | 2 |', '![그림](/api/attachments/00000000-0000-4000-8000-000000000000/content?inline=1)']) {
    assert.equal(issueContentToMarkdown(issueMarkdownToContent(md, 'markdown')), md);
    assert.equal(isIssueMarkdownEditable(md, 'markdown'), true);
  }
});
test('leading H1 stays in the body', () => {
  assert.equal(issueMarkdownToContent('# 제목\n\n본문', 'markdown').content?.[0]?.type, 'heading');
});
test('non-canonical markdown is not editable in the rich editor', () => {
  for (const md of ['* 별표 목록', '<details><summary>a</summary>b</details>', '각주[^1]\n\n[^1]: 설명', '제목\n===']) {
    assert.equal(isIssueMarkdownEditable(md, 'markdown'), false);
  }
});
test('plain descriptions are always editable', () => {
  assert.equal(isIssueMarkdownEditable('* 그대로', 'plain'), true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test tests/server/issue-description-markdown.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Add option `keepLeadingTitle?: boolean` to `MarkdownArchiveConversion` in `shared/document-markdown-import.ts`**

`true`이면 첫 H1을 `suggestedTitle`로 빼지 않고(`omittedBlocks`에 넣지 않음) 섹션 표지(section marker) 처리도 하지 않는다. 기존 호출의 동작은 그대로다.

- [ ] **Step 4: Implement `shared/issue-description-markdown.ts`**

`issueMarkdownToContent`: `format === 'plain'`이면 `plainTextToIssueMarkdown`을 먼저 적용한다. 그다음 `readArchiveMarkdown(md, { keepLeadingTitle: true }).build().content`를 쓰고, 제목 노드에서 섹션 ID 속성을 제거한다. `issueContentToMarkdown`: `renderTicketDescriptionMarkdown(content, { href: h => h, reference: () => undefined })`. `plainTextToIssueMarkdown`: 줄마다 `escapeMarkdownText`를 적용하고, 빈 줄은 문단 경계로, 단일 줄바꿈은 `\` 줄바꿈(hardBreak)으로 만든다. `isIssueMarkdownEditable`: plain이면 true, 아니면 변환 결과에 허용 외 노드가 없고 `issueContentToMarkdown(issueMarkdownToContent(md)) === md.trim()`일 때 true다.

- [ ] **Step 5: Run tests**

Run: `npx tsx --test tests/server/issue-description-markdown.test.ts tests/server/document-markdown-import.test.ts tests/server/document-export-markdown.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/issue-description-markdown.ts shared/document-markdown-import.ts tests/server/issue-description-markdown.test.ts
git commit -m "Add issue description markdown conversion"
```

### Task 2: 즉시 저장 대기열과 필드 단위 병합

**Files:**
- Create: `src/features/issue-autosave.ts`
- Test: `tests/server/issue-autosave.test.ts`

**Interfaces:**
- Consumes: `Issue`(shared/types), `api`, `ApiError`(src/lib/api).
- Produces:
  - `export type IssueFieldGroup = 'title' | 'body' | 'typeStatus' | 'priority' | 'assigneeId' | 'reporterId' | 'collaboratorIds' | 'dates' | 'estimate' | 'plannedEffortMinutes' | 'parentId' | 'cycleId' | 'moduleId' | 'releaseId' | 'labels' | \`custom:${string}\``
  - `export interface IssueFieldChange { group: IssueFieldGroup; patch: Record<string, unknown> }` — `body`는 `{description, descriptionFormat}`, `typeStatus`는 `{type?, status?, customFields?}`, `dates`는 `{startDate?, endDate?, dueDate?, schedulePreviewId?}`를 함께 담는다(설계: 묶어 보내야 하는 필드).
  - `export function changedGroups(base: Issue, latest: Issue): Set<IssueFieldGroup>` — `customFields`는 키마다 `custom:{id}`로 나눈다.
  - `export function rebaseChange(base: Issue, latest: Issue, change: IssueFieldChange): { kind: 'rebased' } | { kind: 'conflict'; groups: IssueFieldGroup[] }` — 내가 바꾸려는 그룹이 `changedGroups(base, latest)`에 있으면 충돌이다. 목록(labels, collaboratorIds)은 그룹 전체를 한 단위로 본다.
  - `export interface IssueSaveQueue { enqueue(change: IssueFieldChange): Promise<Issue>; pending(): number; retry(): Promise<Issue | null>; dispose(): void }`
  - `export function createIssueSaveQueue(options: { issueId: string; actorId: string; base: () => Issue; restoreGeneration: () => string | undefined; send: (body: string) => Promise<Issue>; latest: () => Promise<Issue>; onSaved: (issue: Issue) => void; onConflict: (groups: IssueFieldGroup[], change: IssueFieldChange) => void; onUncertain: (change: IssueFieldChange) => void; newRequestId: () => string }): IssueSaveQueue`

- [ ] **Step 1: Write the failing tests** (가짜 `send`·`latest`로 서버 흉내)

```ts
test('serializes back-to-back changes using the previous response version', async () => {
  // base.version=1. enqueue(priority) and enqueue(assigneeId) without awaiting; send resolves after a tick.
  // expect: two sends, second body has expectedVersion === 2, both promises resolve, final onSaved version 3.
});
test('409 on a different field rebases onto latest and resends', async () => {
  // send #1 throws ApiError(409); latest() returns version 2 with title changed; change is priority.
  // expect: second send expectedVersion 2, patch {priority:'high'}, onConflict not called.
});
test('409 on the same field reports conflict and does not resend', async () => {
  // latest changed description; change group 'body' → onConflict(['body'], change); sends === 1.
});
test('custom fields conflict per key, lists as a whole', () => {
  // base customFields {a:1,b:1}; latest {a:2,b:1}; change custom:b → rebased; change custom:a → conflict.
  // latest labels added one; change labels → conflict.
});
test('lost response is retried with the same requestId', async () => {
  // restoreGeneration 'g1'; send rejects with TypeError('network'); onUncertain called; retry() resends identical body (same requestId).
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test tests/server/issue-autosave.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/features/issue-autosave.ts`**

대기열은 한 번에 요청 하나만 보낸다. 보낼 때 `expectedVersion`은 마지막으로 확인한 서버 버전이고, 복원 세대가 있으면 `requestId`와 `expectedRestoreGeneration`을 붙인다. 409면 `latest()`로 최신 업무를 받아 `rebaseChange`로 판단한다. 다시 보낼 수 있으면 한 번 다시 보내고, 아니면 `onConflict`를 부르고 그 변경을 대기열에서 뺀다(호출자가 입력을 유지한다). 응답이 불확실하면(`ApiError`가 아니거나 상태 5xx) `onUncertain`을 부르고, `retry()` 전까지 대기열을 멈춘다.

- [ ] **Step 4: Run tests** — Run: `npx tsx --test tests/server/issue-autosave.test.ts` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Add issue autosave queue with field-level rebase"`

### Task 3: 제목·본문 초안 보관

**Files:**
- Create: `src/features/issue-body-draft.ts`
- Test: `tests/server/issue-body-draft.test.ts`

**Interfaces:**
- Produces:
  - `export const ISSUE_BODY_DRAFT_PREFIX = 'donefac:issue-body-draft:1:'`
  - `export interface IssueBodyDraft { title: string; description: string; descriptionFormat: IssueDescriptionFormat; baseVersion: number; requestId: string | null; savedAt: string }`
  - `export function issueBodyDraftKey(actorId: string, issueId: string, restoreGeneration: string | undefined): string` — `PREFIX + JSON.stringify([actorId, issueId, restoreGeneration ?? null])`
  - `export function readIssueBodyDraft(storage: Storage, key: string): IssueBodyDraft | null` (형식이 틀리면 null)
  - `export function writeIssueBodyDraft(storage: Storage, key: string, draft: IssueBodyDraft): boolean` (예외 시 false)
  - `export function settleIssueBodyDraft(storage: Storage, key: string, saved: Issue): void` — 서버 업무의 제목·설명·형식이 초안과 같으면 지운다.
  - `export function clearIssueBodyDrafts(storage: Storage, actorId?: string): void` — 작업자 전환·가져오기 승인 때 사용(기존 문서 초안 정리와 같은 위치에서 호출).

- [ ] **Step 1: Write failing tests**: `keeps draft until server version covers it`(설명이 다르면 유지, 같으면 삭제), `rejects malformed stored values`, `write survives quota errors`(setItem 예외 → false), `clear by actor removes only that actor's drafts`.
- [ ] **Step 2: Run and confirm failure** — `npx tsx --test tests/server/issue-body-draft.test.ts` → FAIL
- [ ] **Step 3: Implement** 모든 저장소 접근을 try/catch로 감싼다.
- [ ] **Step 4: Run tests** → PASS. 또한 `src/features/WorkspaceSettings.tsx:59`의 초안 정리 목록과 작업자 전환 초안 정리에 `clearIssueBodyDrafts`를 연결하고 `npx tsx --test tests/server/*.test.ts` 통과를 확인한다.
- [ ] **Step 5: Commit** — `git commit -m "Store unsaved issue title and body drafts"`

### Task 4: shadcn Popover·DropdownMenu·Tabs 컴포넌트

**Files:**
- Create: `src/components/ui/popover.tsx`, `src/components/ui/dropdown-menu.tsx`, `src/components/ui/tabs.tsx`

**Interfaces:**
- Produces: shadcn 표준 내보내기 — `Popover, PopoverTrigger, PopoverContent`; `DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator`; `Tabs, TabsList, TabsTrigger, TabsContent`. `radix-ui` 패키지의 `Popover`·`DropdownMenu`·`Tabs`를 쓰고, 색은 의미 유틸리티(`bg-surface-1`, `border-border-subtle`, `text-fg-secondary` 등)만 쓴다. `TabsContent`는 `forceMount` + `hidden`으로 숨겨도 마운트를 유지할 수 있어야 한다.

- [ ] **Step 1: Add the three files** (shadcn new-york 형태를 기존 `button.tsx` 스타일에 맞춘다.)
- [ ] **Step 2: Verify** — Run: `npm run typecheck && npm run lint -- src/components/ui` / Expected: 새 파일에서 오류 없음
- [ ] **Step 3: Commit** — `git commit -m "Add popover, dropdown menu and tabs ui components"`

### Task 5: 업무 본문 편집기

**Files:**
- Create: `src/features/issue-body-extensions.ts`, `src/features/IssueBodyEditor.tsx`
- Modify: `src/features/IssueDescriptionEditor.tsx` (원문 Markdown 편집 모드로만 쓰도록 형식 선택 상자 제거, 컴포넌트명 유지)
- Test: `tests/browser/issue-body-editor.spec.ts`

**Interfaces:**
- Consumes: Task 1의 `issueMarkdownToContent`, `issueContentToMarkdown`, `isIssueMarkdownEditable`, `ISSUE_BODY_NODE_TYPES`; `clipboardImageFiles`, `trackClipboardImagePosition`(src/features/document-clipboard-image.ts); `attachmentFileUrl`(src/features/Attachments.tsx).
- Produces:
  - `export function issueBodyExtensions(options: { placeholder: string }): Extensions` — StarterKit(허용 노드만, Markdown 입력 규칙 포함), Link, TaskList/TaskItem, Table 계열, Image, Placeholder.
  - `export interface IssueBodyEditorProps { value: string; format: IssueDescriptionFormat; disabled?: boolean; onChange(next: { description: string; descriptionFormat: 'markdown' }): void; onBlur?(): void; uploadImage(file: File): Promise<{ attachmentId: string; filename: string }>; onUploadingChange(uploading: boolean): void; openMigratedDocument?: IssueDescriptionEditorProps['migratedDocuments'] }`
  - `export function IssueBodyEditor(props: IssueBodyEditorProps): JSX.Element` — `isIssueMarkdownEditable`가 false면 원문 편집 모드(`IssueDescriptionEditor`)와 안내 문구 "이 설명은 원문 형식을 보존하기 위해 Markdown으로 편집합니다."와 "서식 편집기로 바꾸기" 버튼을 보여 준다.

- [ ] **Step 1: Write the failing browser spec** `tests/browser/issue-body-editor.spec.ts` (Task 7 이후 패널에 연결되므로, 이 단계에서는 임시 하네스 대신 Task 7에서 실행된다는 표시로 `test.describe` 이름을 `issue body editor`로 두고 아래 검사를 작성):
  - `markdown shortcuts format as you type`: 본문에 `## 절` 입력 → `h2` 존재. `- 항목` → `ul li`. 저장된 `description`은 `## 절\n\n- 항목`.
  - `defers autosave until pasted image upload finishes`: `/api/attachments` 응답을 1.5초 지연시킨다. 이미지 붙여넣기 후 바로 "추가 글" 입력 → 업로드 완료 전 `PATCH /api/issues` 요청이 0건이다. 완료 후 저장된 설명에 `![` + `/content?inline=1)`와 "추가 글"이 모두 있다.
  - `failed upload never saves a broken image`: 업로드 500 → 자리 표시가 오류 상태가 되고 "다시 시도"·"삭제" 버튼이 있다. 저장된 설명에 `/api/attachments/`가 없다.
  - `non-canonical markdown opens in source mode`: 설명 `* 별표 목록` 업무 → 원문 편집칸과 안내 문구가 보이고, 열고 닫아도 PATCH가 0건이다.
- [ ] **Step 2: Implement `issue-body-extensions.ts` and `IssueBodyEditor.tsx`**

값이 바뀔 때마다 `issueContentToMarkdown`으로 변환해 `onChange`를 부른다. 외부 `value`가 바뀌어도 사용자가 편집 중이면(포커스 + 미저장) 편집기를 다시 채우지 않는다. 이미지 붙여넣기·끌어 놓기는 `trackClipboardImagePosition`으로 위치를 잡는다. 업로드하는 동안에는 `data-uploading` 속성을 가진 이미지 자리 표시를 넣고 `onUploadingChange(true)`를 부른다. 완료하면 `src`를 `attachmentFileUrl(id, true)`로 바꾸고, 실패하면 오류 상태로 바꾼다. 업로드 중이거나 오류 상태인 이미지는 `onChange`로 내보내는 Markdown에서 뺀다.
- [ ] **Step 3: Typecheck** — `npm run typecheck` → PASS (브라우저 검사는 Task 7에서 실행)
- [ ] **Step 4: Commit** — `git commit -m "Add rich markdown issue body editor"`

### Task 6: 속성 칸과 요약 칩, 넓은 오버레이 레이아웃

**Files:**
- Create: `src/features/IssuePropertiesPanel.tsx`, `src/features/issue-properties-preference.ts`
- Modify: `src/features/IssuePanel.tsx` (레이아웃 골격, 속성 폼 `:1350-1372`을 새 컴포넌트로 교체, 머리줄 동작을 더보기 메뉴로), `src/features/issues.css` (`.issue-detail-panel` 폭, 2단 레이아웃; 새 요소는 Tailwind)
- Test: `tests/server/issue-properties-preference.test.ts`, `tests/browser/issue-properties-panel.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `IssueFieldChange`, `IssueSaveQueue`; Task 4의 Popover·DropdownMenu; `requiredFieldsFor`(shared/workflow-helpers), `CustomFields`, `PlanningSelect`, `IssueTypeSelect`, `IssueReporterSelect`(기존 컴포넌트).
- Produces:
  - `export const ISSUE_PROPERTIES_COLLAPSED_KEY = 'donefac:issue-properties-collapsed'`, `export function readPropertiesCollapsed(storage: Storage | undefined): boolean`, `export function writePropertiesCollapsed(storage: Storage | undefined, collapsed: boolean): void`
  - `export interface IssuePropertiesPanelProps { issue: Issue; data: WorkspaceSnapshot; collapsed: boolean; compact: boolean; save(change: IssueFieldChange): Promise<void>; savingGroups: ReadonlySet<IssueFieldGroup>; failedGroups: ReadonlyMap<IssueFieldGroup, string>; onRetry(group: IssueFieldGroup): void; scheduleActions: ReactNode }`
  - `export function IssuePropertiesPanel(props): JSX.Element` — 펼침: 기본 속성 10개(상태·담당자·우선순위·시작일·종료일·목표 마감일·사이클·상위 업무·라벨·참여자)와 "속성 더 보기"(유형·요청자·모듈·릴리스·예상 소요·계획 작업 시간·사용자 정의 필드)
  - `export function IssueSummaryChips(props: Pick<IssuePropertiesPanelProps, 'issue' | 'data' | 'save'>): JSX.Element` — 상태·담당자·우선순위·기간(시작–종료)·사이클 칩, 누르면 Popover로 바로 변경
- 각 속성 값은 이름표가 있는 버튼이다(`aria-label="상태: 진행 중"` 형식). 고르는 즉시 `save`를 부른다. 날짜 변경은 기존 `schedule-save-preview` 검토를 거쳐 `dates` 그룹으로 보낸다(경고·차단이 있으면 기존 `IssueScheduleSaveReview`를 연다).
- 상태 변경: 새 상태의 `requiredFieldsFor(...)` 중 비어 있거나 현재 숨겨진 필드가 있으면 Popover 안에 "필수 속성 입력" 단계를 보여 준다. 입력을 마치면 `typeStatus` 그룹에 status와 해당 필드를 함께 담아 한 번에 보낸다. 취소하면 아무것도 보내지 않는다.
- 좁은 폭 기준: 오버레이 내부 폭 < 900px이면 `compact`(항상 요약 칩 + 펼치면 세로 목록). 머리줄에 "속성 접기/펴기" 버튼(`aria-expanded`, lucide `PanelRightClose`/`PanelRightOpen`)을 둔다.

- [ ] **Step 1: Write failing unit test** `issue-properties-preference.test.ts`: 기본값 false, 쓰기·읽기 왕복, 저장소 예외 시 기본값.
- [ ] **Step 2: Write failing browser spec** `issue-properties-panel.spec.ts`:
  - `changes priority immediately without a save button`: 우선순위를 높음으로 고르면 PATCH 1건이 나가고, 새로고침 후에도 높음이다. `변경사항 저장` 버튼이 없다.
  - `collapses to summary chips and remembers it`: 접기 → 칩 5개가 보이고 속성 칸이 사라진다. 상태 칩으로 상태 변경 → 저장된다. 다시 열어도 접힌 상태다.
  - `360px starts with chips`: 뷰포트 360×820 → 칩이 보이고 속성 목록은 펼치기 전까지 숨어 있다.
  - `status needing hidden required field opens input step`: 대상 상태에서만 보이는 필수 텍스트 필드가 있는 워크플로를 만든다. 상태를 고르면 입력 단계가 열린다. 취소 → 서버 상태 그대로, 입력 후 확인 → 상태와 필드가 한 요청으로 저장된다.
  - `date change with warnings opens schedule review`: 후행 업무와 겹치는 종료일 → 기존 일정 검토 대화상자가 열리고, 확인하면 저장된다.
- [ ] **Step 3: Implement** 속성 칸·칩·선호 모듈. `IssuePanel`에서 기존 속성 폼과 저장 버튼 경로를 걷어내고, 속성 변경을 Task 2 대기열로 보낸다(제목·본문은 아직 기존 폼 상태를 유지해도 된다. Task 7에서 교체한다). 오버레이 폭은 `min(1200px, 100vw - 여백)`, 속성 칸은 약 260px이다.
- [ ] **Step 4: Run** — `npx tsx --test tests/server/issue-properties-preference.test.ts tests/server/issue-autosave.test.ts`, `npm run typecheck`, `npx playwright test --trace off --output <unique> tests/browser/issue-properties-panel.spec.ts` → PASS
- [ ] **Step 5: Commit** — `git commit -m "Show issue properties in a collapsible side panel with immediate save"`

### Task 7: 제목·본문 자동 저장과 충돌 안내

**Files:**
- Modify: `src/features/IssuePanel.tsx` (제목 입력·설명 편집기 `:1331-1342`, `save()`/`submitIssue` 경로 `:840-960`, 닫기·검토 이동 확인, 저장 상태 줄)
- Test: `tests/browser/issue-body-autosave.spec.ts` (+ Task 5의 `issue-body-editor.spec.ts`를 여기서 실행)

**Interfaces:**
- Consumes: Task 2 대기열(`group: 'title' | 'body'`), Task 3 초안 함수, Task 5 `IssueBodyEditor`.
- Produces: `IssuePanel` 안의 저장 상태 표시 `role="status"` 문구: `"저장 중…"`, `"마지막 저장 · {상대 시간}"`, `"저장하지 못했습니다"`(+ "다시 시도" 버튼), 충돌 배너 `role="alert"`: 제목 `"다른 사람의 변경사항이 있습니다"`, 버튼 `"최신 내용 보기"`·`"내 내용으로 덮어쓰기"`.

- [ ] **Step 1: Write failing browser spec** `issue-body-autosave.spec.ts`:
  - `autosaves title and body after typing stops`: 제목·본문을 고치고 1.5초 기다리면 PATCH가 1~2건 나가고 상태 문구가 "마지막 저장"으로 바뀐다. 새로고침 후에도 내용이 유지된다.
  - `opening a plain description sends no save`: 평문 설명 `*그대로* # 그대로` 업무를 열고 닫으면 PATCH 0건이고 본문 글자가 그대로 보인다.
  - `restores unsaved body after reload`: PATCH 응답을 끊고(`route.abort`) 새로고침 → 입력이 복원되고 "저장하지 않은 본문을 복원했습니다" 알림이 뜬다. 다시 시도하면 같은 `requestId`로 확인되고 중복 저장이 없다.
  - `same-field conflict keeps my text`: 동료가 API로 설명을 바꾼 뒤 내 본문을 고치면 충돌 배너가 뜨고 내 글이 유지된다. "내 내용으로 덮어쓰기" → 저장된다. "최신 내용 보기" → 동료 글이 보인다.
  - `closing while saving asks for confirmation`: 저장 응답을 지연시키고 닫기 → 확인 대화상자가 뜬다. 저장이 끝난 뒤 닫기는 확인 없이 닫힌다.
- [ ] **Step 2: Implement** 제목은 입력란, 본문은 `IssueBodyEditor`를 쓴다. 입력이 1초 멈추거나 포커스를 잃거나 닫기·이동할 때 대기열에 넣는다. 넣기 전에 초안을 쓰고, 저장되면 `settleIssueBodyDraft`로 정리한다. 열 때 초안이 서버 내용과 다르면 복원하고 알린다. 본문 업로드 중(`onUploadingChange(true)`)에는 본문 그룹 저장을 미룬다. 형식 필드는 본문을 실제로 바꿨을 때만 `'markdown'`으로 보낸다.
- [ ] **Step 3: Run** — `npm run typecheck`; `npx playwright test --trace off --output <unique> tests/browser/issue-body-autosave.spec.ts tests/browser/issue-body-editor.spec.ts tests/browser/issue-properties-panel.spec.ts` → PASS
- [ ] **Step 4: Commit** — `git commit -m "Autosave issue title and body with drafts and conflict notice"`

### Task 8: 기능 버튼 한 줄, 조건부 섹션, 활동 탭, 더보기 메뉴

**Files:**
- Create: `src/features/IssueActivityTabs.tsx`, `src/features/IssueActionBar.tsx`
- Modify: `src/features/IssuePanel.tsx` (상단 탭 `:1317-1323` 제거, 섹션 `:1381-1530`, 휴지통 영역, 머리줄)
- Test: `tests/browser/issue-detail-layout.spec.ts`

**Interfaces:**
- Consumes: 기존 섹션 컴포넌트·흐름(의존성 추가, 하위 업무 추가, 관계 추가, 문서 연결, `Attachments`), `IssueChangeHistory`, `IssueWorklogs`, `TimeReservations`, `JiraDeadlineRecovery`, `IssueJiraStatusHistory`; Task 4 Tabs·DropdownMenu.
- Produces:
  - `export type IssueActivityTab = 'comments' | 'history' | 'worklogs' | 'reservations' | 'source'`
  - `export function IssueActivityTabs(props: { value: IssueActivityTab; onChange(tab: IssueActivityTab): void; panels: Record<IssueActivityTab, ReactNode> }): JSX.Element` — 탭 이름: 댓글·변경 이력·작업 시간·시간 배정·원본 기록. 숨긴 탭도 마운트를 유지한다.
  - `export type IssueAction = 'child' | 'relation' | 'dependency' | 'document' | 'attachment'`
  - `export function IssueActionBar(props: { onAction(action: IssueAction): void; disabled?: boolean }): JSX.Element` — 버튼 이름: 하위 업무 추가·업무 관계 추가·의존성 추가·문서 연결·첨부, lucide 아이콘 `ListTree, ArrowLeftRight, Link2, FileText, Paperclip`.
- 섹션 표시 규칙: 내용이 있거나 해당 버튼으로 추가를 시작한 섹션만 렌더링한다. 기존 섹션 `aria-label`은 그대로 둔다.
- 기존 탭 상태값 매핑: `details→comments`, `activity→history`, `worklogs`, `reservations`, `source`. `gitlabActivityId`가 있으면 GitLab 섹션을 펼치고 스크롤한다.
- 더보기 메뉴(`aria-label="업무 동작 더 보기"`, lucide `Ellipsis`): 업무 복제·프로젝트 이동·휴지통으로 이동. 확인 흐름은 기존과 같다.

- [ ] **Step 1: Write failing browser spec** `issue-detail-layout.spec.ts`: `empty sections are hidden until started`(새 업무 → 의존성·하위·관계·문서 섹션 없음, "하위 업무 추가" → 하위 업무 섹션과 입력이 열림), `activity tabs keep drafts`(댓글 초안 입력 → 변경 이력 탭 → 댓글 탭에 초안 유지), `more menu moves issue to trash`, `gitlab query opens gitlab section`(`?issue=..&gitlab=..`).
- [ ] **Step 2: Implement** 위 인터페이스대로 만든다.
- [ ] **Step 3: Run** — `npm run typecheck`; `npx playwright test --trace off --output <unique> tests/browser/issue-detail-layout.spec.ts` → PASS
- [ ] **Step 4: Commit** — `git commit -m "Simplify issue detail sections with action bar and activity tabs"`

### Task 9: 기존 브라우저 검사 이전

**Files:**
- Modify: 업무 상세를 여는 기존 브라우저 검사(`git grep -l "?issue=" tests/browser`, 59개). 특히 `name: '변경사항 저장'`을 누르는 26개: atlassian-links, conditional-custom-fields, custom-fields, cycle-board, decision-follow-up-open-issue, document-follow-up, gitlab-deployments, gitlab-issue-refresh, issue-assignment, issue-automation-history, issue-change-history, issue-conflict, issue-description-format, issue-relations, issue-reporter-notifications, issue-reporter, issue-status-deadline, jira-deadline-recovery, jira-status-history, kanban-wip, migration-apply, migration-jira-relations, my-work, planning, team-overview-issue-queue, workflows-settings
- Create: `tests/browser/issue-detail-helpers.ts`

**Interfaces:**
- Produces (helpers):
  - `export async function setIssueProperty(panel: Locator, name: string, value: string): Promise<void>` — 속성 버튼(`aria-label` 앞부분이 `${name}:`)을 누르고 값을 고른 뒤, 상태 문구가 "마지막 저장"이 될 때까지 기다린다.
  - `export async function editIssueBody(panel: Locator, text: string): Promise<void>` / `export async function waitIssueSaved(panel: Locator): Promise<void>`
  - `export async function openActivityTab(panel: Locator, tab: '댓글' | '변경 이력' | '작업 시간' | '시간 배정' | '원본 기록'): Promise<void>`

- [ ] **Step 1: Add helpers** and migrate specs in batches of about 8 files. 각 배치마다 해당 파일만 실행해 통과를 확인한다. 저장 버튼 클릭은 `setIssueProperty`·`waitIssueSaved`로, 상단 탭 클릭은 `openActivityTab`으로 바꾼다. 검사 의도(충돌·재시도·초안 보존)는 줄이지 않는다. 의도 자체가 사라진 단계(예: "저장 전에 여러 필드를 고친 뒤 한 번에 저장")는 즉시 저장에서 같은 보장을 확인하는 단계로 바꾸고, 커밋 메시지에 그 사실을 적는다.
- [ ] **Step 2: Batch runs** — `npx playwright test --trace off --output <unique-per-batch> <files>` → PASS (작업 전에 같은 단계에서 이미 실패하던 검사는 기존 실패로 기록하고 분리)
- [ ] **Step 3: Full checks** — `npm test`, `npm run typecheck`, `npm run build` → PASS
- [ ] **Step 4: Commit per batch** — `git commit -m "Move issue detail browser checks to immediate save"`

### Task 10: 문서 갱신

**Files:**
- Modify: `docs/STATUS.md`(구현과 검증 첫 부분에 개편 요약), `docs/PLAN.md`(업무 상세 화면 설명 부분), `README.md`(업무 편집 사용법이 있으면 갱신)

- [ ] **Step 1: Update docs** 실제 구현된 범위대로 적는다. 실시간 공동 편집은 범위 밖이라고 명시한다.
- [ ] **Step 2: Commit** — `git commit -m "Document the redesigned issue detail screen"`
