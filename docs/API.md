# 자동화 API

설정의 **API 키**에서 현재 작업자의 키를 발급한다. 읽기/쓰기 권한, 전체 또는 선택한 프로젝트, 만료 시각을 지정할 수 있다. 원문 키는 발급 직후 한 번만 표시된다. 서버에는 해시만 보관하며 목록·워크스페이스 백업에는 원문이 포함되지 않는다.

자동화 클라이언트는 `/api/v1` 경로와 `Authorization: Bearer ...` 헤더를 사용한다. 키를 회수하거나 만료되면 사용할 수 없다. 변경 이력의 작업자는 키 소유자로 고정된다. 요청의 `X-Actor-Id`나 `actorId`로 다른 작업자를 지정하지 않는다.

```bash
export TEAMSPACE_API_KEY='발급받은 키'
curl --fail-with-body \
  -H "Authorization: Bearer $TEAMSPACE_API_KEY" \
  http://127.0.0.1:5181/api/v1/projects
```

개발 웹 서버를 통해 호출할 때는 같은 경로를 `http://127.0.0.1:5173/api/v1`에서 사용할 수 있다. 외부 공개 주소는 아직 배포하지 않았다.

## 지원 범위

| 요청 | 동작 |
| --- | --- |
| `GET /projects` | 키 범위의 프로젝트 목록 |
| `GET /projects/:id/workflow` | 업무 상태·허용 전이·필수 속성 규칙 |
| `GET /projects/:id/issue-schema` | 업무 유형·사용자 정의 필드·선택지의 고유 ID와 입력 규칙 |
| `GET /projects/:id/issue-order` · `PATCH /projects/:id/issue-order` | 프로젝트 업무 순서 조회, 이웃 티켓 기준 이동과 선택적 상태 전이 |
| `GET /projects/:id/schedule-analysis` | 현재 근무일 계획의 예상 완료일·업무별 여유·중요 연결·제외 목록 조회 |
| `GET /projects/:id/workload` · `GET /projects/:id/workload-capacity` | 조회 기간의 담당자별 계획 시간·가용 시간·초과 및 프로젝트 설정 |
| `POST /projects/:id/field-breakdown` · `POST /projects/:id/field-breakdown/issues` | 사용자 정의 필드의 현재 값별 집계와 그룹 업무 조회 |
| `GET /users` | 담당자 지정에 필요한 팀원 ID·이름·색상 |
| `GET /planning-items?projectId=...&kind=cycle` | 프로젝트별 사이클·모듈·릴리스 조회 |
| `GET /planning-items/:id` | 계획 항목 조회 |
| `GET /issues?projectId=...` · `GET /issues/:id` | 업무 조회 |
| `GET`·`POST /issues/:id/relations` · `PATCH`·`DELETE /issues/:id/relations/:relationId` | 양쪽이 키 범위에 있는 업무 관계 조회와 직접 만든 관계의 추가·수정·해제 |
| `GET /issues/:id/gitlab-links` | 프로젝트 범위 안 업무의 브랜치·커밋·MR·파이프라인 조회 |
| `GET /documents?projectId=...` · `GET /documents/:id` | 문서 조회 |
| `GET /documents/:id/revisions` | 문서 버전 조회 |
| `GET /documents/:id/publication` · `GET /documents/:id/publication/snapshot` | 현재 검토·발행 상태와 고정 저장본 조회 |
| `GET /comments?resourceType=issue&resourceId=...` | 업무 또는 문서 댓글 조회 |
| `GET /attachments?resourceType=issue&resourceId=...` · `GET /attachments/:id/versions` | 업무·문서의 첨부 목록, 각 첨부의 버전 이력 |
| `GET /attachments/:id/content` · `GET /attachment-versions/:id/download` | 지정된 파일 버전의 바이너리 |
| `POST /issues` · `PATCH /issues/:id` · `DELETE /issues/:id` | 업무 생성·수정·휴지통 이동 |
| `POST /documents` · `PATCH /documents/:id` · `DELETE /documents/:id` | 문서 생성·수정·휴지통 이동 |
| `POST /documents/:id/publication` | 검토 요청·발행·수정 요청·철회 |
| `POST /comments` | 업무 또는 문서 댓글 작성 |
| `POST /attachments` · `POST /attachments/:id/versions` | 첨부 생성 또는 새 버전 업로드 |
| `PATCH /projects/:id/workload-capacity` | 프로젝트·팀원·날짜별 가용 시간 변경 |

표의 경로 앞에는 `/api/v1`이 붙는다. 읽기 키는 조회만 허용하며 쓰기 키는 조회와 표의 변경 요청을 허용한다. 프로젝트 범위는 조회·원래 대상·이동 대상·상위 항목·계획 참조에 적용한다. 공통 문서는 전체 프로젝트 키로 접근한다.

백업·가져오기·연동 설정·키 관리·팀 알림함·휴지통 관리·공동 편집 소켓 등 표에 없는 경로는 자동화 API에서 허용하지 않는다. 계획 항목은 현재 관리 화면에서 생성하며 자동화 API로 조회하고 티켓에 연결할 수 있다.

업무와 문서의 `DELETE`는 휴지통으로 이동하며 응답의 `trashEntryId`는 해당 이동을 식별한다. 복원과 영구 삭제는 워크스페이스의 **휴지통**에서 처리한다. 연결된 외부 웹훅에서는 휴지통 이동이 기존 `*.deleted`, 복원이 `*.created`와 `origin: "restore"`로 전달된다.

## 티켓 사이의 업무 관계

`GET /api/issues/:id/relations`는 현재 티켓이 양쪽 중 하나인 `IssueRelation[]`을 반환한다. `POST`로 `{otherIssueId,type,direction}`을 보낸다. `type`은 `related`, `blocks`, `duplicates`다. `direction`이 `outgoing`이면 URL의 티켓이 차단하는 쪽 또는 중복 티켓이며, `incoming`이면 상대 티켓이 그 역할이다. `related`는 두 티켓을 ID 순서로 저장한다. 같은 관계를 다시 보내면 이미 저장된 행과 `200`을 반환하고, 새 연결은 `201`을 반환한다.

직접 만든 관계에는 `origin: "teamspace"`가 있다. `PATCH /api/issues/:id/relations/:relationId`에 `{expectedVersion,type,direction}`을 보내 유형과 방향을 변경한다. `DELETE`는 같은 경로의 `?expectedVersion=…`을 사용한다. 버전이 바뀌면 `409`로 최신 버전을 알려준다. 이관한 관계는 원래 이름을 반환하며 읽기 전용이다. 관계 자체와 양쪽 활동 이력은 함께 저장한다. 자체 백업 형식 51은 직접 만든 관계를 보존하고 복원 시 버전을 높인다.

`/api/v1`의 동일한 경로에서 양쪽 프로젝트가 키의 허용 범위에 있어야 한다. 조회에는 읽기 키를 사용할 수 있으며, 관계 추가·수정·해제에는 쓰기 키가 필요하다.

## 선후행 업무 연결

브라우저의 `POST /api/dependencies`로 `{predecessorId,successorId,type?,lagDays?}`를 보낸다. 관계는 `FS`, `SS`, `FF`, `SF`를 지원하고 기본값은 `FS`와 `0`이다. `lagDays`는 −3,650~3,650 사이의 정수 근무일이다. 같은 프로젝트 안에서 방향별 업무 쌍은 한 번만 연결할 수 있으며 순환 관계는 거절한다.

`PATCH /api/dependencies/:id`로 `{expectedVersion,type?,lagDays?,reverse?}`를 보내 연결 유형과 간격을 바꾼다. `reverse: true`는 같은 연결 ID에서 선행 업무와 후행 업무를 서로 바꾼다. 반대 방향이 순환을 만들면 변경을 거절한다. 기존 자료에서 `version`이 생략된 경우 버전 1을 사용한다. `DELETE /api/dependencies/:id?expectedVersion=...`로 조회 당시 버전을 검사하고 연결을 해제할 수 있다. 연결의 변경은 업무 날짜를 유지하며, 날짜를 변경하는 자동 일정은 별도 미리보기와 적용을 사용한다.

## 일정 여유 분석

`GET /projects/:id/schedule-analysis`는 프로젝트의 저장된 업무·근무 달력·선후행 연결을 읽는다. `projectedFinish`는 계산 가능한 진행 업무의 예상 완료일이며, `tasks`는 업무별 가장 이른 시작·종료, 가장 늦은 시작·종료, `slackDays`와 `critical`을 포함한다. `criticalDependencyIds`는 여유 0일 업무 사이에서 완료일에 영향을 주는 연결이다.

`excluded`에는 제외된 이유가 담기며, 분석 범위가 일부이면 `partial`이 `true`다. 계산할 수 있는 진행 업무가 없으면 `projectedFinish`는 `null`이다. 완료·취소 업무는 각각 `completedCount`와 `cancelledCount`에 표시한다. 요청당 프로젝트 업무 10,000개와 연결 50,000개까지 조회한다. 날짜를 바꾸려면 별도 일정 변경 API를 사용한다. [일정·간트 사용법](SCHEDULING.md)

## 담당자 작업량

업무 생성·수정의 `plannedEffortMinutes`에는 0~1,000,000 정수 분 또는 `null`을 보낸다. 포인트 필드 `estimate`와 별도이다. `GET /projects/:id/workload?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`로 최대 180일을 양끝 날짜 포함으로 조회한다. 응답의 `rows`에는 팀원별 일자와 `scheduledMinutes`, `availableMinutes`, 업무별 `allocations`가 있다. `incomplete`에는 배분에 필요한 정보가 부족한 업무와 이유를 반환한다.

`GET /projects/:id/workload-capacity`의 `version`을 `expectedVersion`으로 보내고 `defaultDailyMinutes`, `members` 또는 `exceptions`를 지정해 변경한다. `members`는 `{userId,dailyMinutes}`, `exceptions`는 `{userId,date,availableMinutes}` 배열이다. 배열을 보낼 때 해당 목록을 교체하며 빈 배열로 초기화할 수 있다. 가용 시간 허용 범위는 0~1,440분이다. 이전 버전으로 저장하면 `409`를 반환한다.

브라우저의 `GET /api/workload?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`로 프로젝트 간 작업량을 조회한다. 조회할 프로젝트를 고를 때는 `projectId`를 프로젝트마다 한 번 보낸다. 생략하면 전체를 조회한다. 양끝 날짜를 포함해 최대 180일·100개 프로젝트·10,000개 대상 업무를 조회한다. 요청 한도에는 팀원과 날짜 조합 36,000개, 날짜별 업무 배분 100,000개도 적용된다. 응답의 `capacityVersion`은 사용한 팀 가용 시간의 버전이다. 배분과 입력 확인에는 원래 `projectId`가 포함된다.

`GET /api/workload-capacity`의 `version`으로 `PATCH /api/workload-capacity`를 호출한다. `workingWeekdays`는 일요일 0부터 토요일 6까지이고, `calendarExceptions`는 `{date,isWorking,label}` 배열이다. `defaultDailyMinutes`, `members`, `exceptions`의 형식은 프로젝트 설정과 같다. 팀원 날짜 예외는 팀 근무일 여부보다 우선한다. 팀 전역 설정과 합산 조회는 브라우저 API에서 사용한다.

## 첨부와 버전

최초 업로드는 `POST /attachments?resourceType=document&resourceId=<문서 ID>&filename=<파일명>`을 사용한다. 업무의 `resourceType`은 `issue`다. 업로드 본문은 최대 20MiB의 `application/octet-stream`이며 `filename`은 URL 인코딩한다. 응답의 `id`는 첨부에 고정되고 `currentVersionId`는 최신 파일을 가리킨다. 파일명·MIME·크기·SHA-256·작성자·시각은 최신 파일 기준이다. `versionCount`는 최초 파일과 이관 이력을 함께 센다.

새 버전은 `POST /attachments/<id>/versions`에 `filename`과 목록에서 확인한 `expectedVersionId=<currentVersionId>`를 전달한다. 먼저 다른 버전이 저장되면 서버는 `409`와 `details.currentVersionId`를 반환한다. 이때 첨부 목록을 다시 읽고 최신 파일을 확인한다.

최신 바이너리는 `GET /attachments/<currentVersionId>/content`에서 받는다. 버전 이력의 각 `id`도 특정 파일을 가리킨다. `GET /attachment-versions/<버전 id>/download`로 이전 바이트를 내려받을 수 있다. `?inline=1`은 서버가 이미지 형식을 확인한 PNG·JPEG·GIF·WebP에 적용한다. 프로젝트 범위는 첨부의 소유 업무·문서를 기준으로 판단한다.

## 업무 생성·수정

프로젝트 ID와 상태·유형·팀원·계획 ID는 조회 응답으로 확인한다. 유형·필드·선택지는 표시 이름 대신 `issue-schema`의 고유 ID를 전달한다. 기본 상태는 프로젝트 워크플로에 따르며, 같은 필수 입력·상태 전이 규칙을 적용한다.

```json
{
  "projectId": "조회한 프로젝트 ID",
  "title": "파이프라인 실패 원인 확인",
  "type": "버그",
  "assigneeId": "담당자 ID",
  "cycleId": "사이클 ID",
  "moduleId": null,
  "releaseId": null
}
```

수정·삭제에는 마지막 조회의 `version`을 `expectedVersion`으로 전달한다. 오래된 버전이면 `409`를 반환한다. 자동으로 재시도해 덮어쓰지 말고 최신 내용을 다시 확인한다. 계획 연결은 `cycleId`, `moduleId`, `releaseId`로 지정한다. 응답의 `cycle`, `module`, `release`는 표시용 이름이다.

```json
{
  "expectedVersion": 3,
  "status": "프로젝트에서 허용하는 상태 ID",
  "startDate": "2026-11-17",
  "endDate": "2026-11-20"
}
```

삭제할 때는 `?expectedVersion=3`처럼 전달한다. 하위 업무·문서가 있으면 삭제를 거절한다. 문서 `content`는 Tiptap JSON이며, 공동 편집 문서의 본문 교체는 편집 세대를 바꾸므로 의도한 전체 교체에만 사용한다.

문서 본문 형식 6은 블록 노드 `callout`과 인라인 노드 `statusBadge`를 지원한다. `callout`은 `attrs: {variant, title}`과 하나 이상의 하위 블록을 받는다. `variant`는 `info`, `note`, `warning`, `tip`, `panel` 중 하나이고 선택 제목은 최대 300자다. `statusBadge`는 `attrs: {label, tone}`을 받는다. 표시 이름은 필수이며 최대 120자다. 색상은 `neutral`, `blue`, `green`, `amber`, `red`, `purple` 중 하나다. 이 노드가 있는 본문을 바꾸는 `PATCH`에는 해당 본문을 지원하는 `contentSchemaVersion` 6 이상을 보내야 한다. 제목과 같은 문서 속성만 바꿀 때는 생략할 수 있다. 자체 백업 형식 46은 현재 문서와 저장 이력의 두 노드를 보존한다.

본문 형식 7은 `heading.attrs.sectionId`를 지원한다. ID는 영문자 또는 숫자로 시작하며 영문자·숫자·`_`·`-`로 구성된 1~80자다. 한 문서에 같은 ID를 두 번 지정하면 저장을 거절한다. 이 속성이 있는 본문을 수정할 때는 `contentSchemaVersion: 7`을 보낸다. 절 주소는 `#/project-id/documents/document-id?section=section-id`를 사용한다. 검토·발행 고정본 주소는 `publication=review` 또는 `publication=published`와 `revision`을 함께 넣는다. 자체 백업 형식 49와 문서 JSON 형식 7에서 절 ID를 보존한다.

## 상위 업무에서 하위 업무 만들기

브라우저의 `POST /api/issues/:id/children`에 `{requestId, expectedParentVersion, issue}`를 보낸다. `requestId`는 UUID v4다. `issue`에는 업무 생성과 같은 속성을 보낸다. `projectId`와 `parentId`는 현재 상위 업무에서 정해지며, 함께 보낼 경우 같은 ID여야 한다. 현재 프로젝트의 유형·워크플로·필수 속성을 검사한 뒤 하위 업무와 번호, 상위·하위 업무 변경 기록을 한 트랜잭션에 저장한다.

최초 생성은 `201`과 `{issue, duplicate:false}`를 반환한다. 같은 작업자가 요청을 그대로 재시도하면 해당 하위 업무와 `200`, `duplicate:true`를 반환한다. 새 요청의 상위 업무 버전이 바뀌었거나, 재시도 대상 하위 업무가 삭제 또는 다른 상위 업무로 이동한 경우에는 `409`를 반환한다. 자체 백업은 업무의 `parentId`를 보존하고 복원 시 생성 요청 기록을 초기화한다.

## 업무 일괄 편집

브라우저의 `POST /api/projects/:projectId/issues/bulk-preview`에 `{issues:[{id,expectedVersion}],changes:{status?,priority?,assigneeId?}}`를 보낸다. 같은 프로젝트의 업무 1~100개를 받는다. 생략한 필드는 유지한다. 상태 전이에서 담당자를 생략하면 배정 규칙이 실행될 수 있다. 담당자를 직접 지정하거나 해제하는 경우 `assigneeId`에 팀원 ID 또는 `null`을 보낸다.

응답의 `rows`는 업무별 `before`, `after`, `outcome`, `reason`을 반환하며 `changed`, `unchanged`, `blocked`에 건수를 담는다. 변경할 업무가 있고 모든 업무가 검증을 통과하면 30분간 유효한 `previewId`를 반환한다. 적용 전까지 업무와 변경 이력은 유지된다.

`POST /api/projects/:projectId/issues/bulk-apply`에 `{previewId}`를 보낸다. 같은 작업자와 프로젝트에서 업무·워크플로·업무 양식·배정 규칙을 다시 확인한 뒤 실제 변경이 있는 업무를 함께 저장한다. 충돌이 있으면 `409` 응답으로 전체 저장을 거절한다. 적용 응답을 받지 못하면 같은 ID를 보내 7일간 `{previewId,updated,unchanged}`를 다시 받을 수 있다. 자체 백업을 가져오면 미리보기와 재시도 기록을 초기화한다.

## 워크플로 상태 일괄 이동

`POST /api/projects/:projectId/workflow/status-migration-preview`에 `{fromStatusId,toStatusId,expectedWorkflowVersion}`을 보낸다. 두 상태 ID는 같은 프로젝트의 저장된 워크플로에서 고른다. 서버가 출발 상태인 활성 티켓 전체를 조회하며 최대 1,000건을 검토한다. 응답 형식은 [업무 일괄 편집](#업무-일괄-편집) 미리보기와 같다. 이동할 업무가 없거나 검증이 차단된 업무가 있으면 `previewId`가 `null`이다.

상태 매핑에는 도착 상태와 업무 양식의 필수 입력을 적용하고 해당하는 자동 배정 규칙을 평가한다. 개별 업무에 정의한 출발→도착 전이의 방향·유형·전이별 필수 입력 규칙은 일반 상태 변경에 적용된다. 미리보기의 티켓·활동·알림에는 변경이 없다.

`POST /api/projects/:projectId/workflow/status-migration-apply`에 `{previewId}`를 보낸다. 검토한 작업자와 프로젝트가 일치해야 한다. 출발 상태의 티켓이 추가·삭제·이동되거나 대상 버전과 워크플로·양식·배정 규칙이 바뀌면 전체 적용을 거절한다. 상태 변화, 필요한 완료 시각, 활동·보고서·알림·발신 이벤트를 한 트랜잭션에 기록한다. 동일한 미리보기 ID로 7일간 완료 결과를 다시 받을 수 있다. 두 단계는 브라우저용 `/api` 경로에 있다.

## 문서에서 후속 업무 만들기

브라우저의 `POST /api/documents/:id/follow-up-issues`에 `{requestId, expectedDocumentVersion, issue}`를 보낸다. `requestId`는 새 요청마다 생성하는 UUID v4이며 `issue`는 일반 티켓 생성과 같은 입력을 사용한다. 프로젝트 문서는 현재 문서의 프로젝트를 사용하고, 공통 문서는 `issue.projectId`를 지정한다. 신규 요청은 문서 버전을 검사하고 업무, 번호, 연결 및 활동 기록을 함께 저장한다. 최초 응답은 `201`과 `{issue, link, duplicate:false}`를 반환한다.

선택한 원문을 연결하려면 `sourceSelection`에 저장 본문의 ProseMirror 위치 `{from,to,text}`를 보낸다. 텍스트는 선택 범위에서 구한 최대 2,000 UTF-16 단위의 발췌이며, 문단과 줄바꿈은 LF로 연결한다. 서버가 저장된 본문에서 같은 범위를 다시 읽고 텍스트가 다르면 `409`를 반환한다. 정확히 일치하면 `link.documentSource`에 `{revisionId,from,to,text}`를 기록한다. 저장본이 필요하면 업무와 함께 생성한다. 원문은 `GET /api/documents/:id/include-revisions/:revisionId`에서 읽으며, 자체 백업 형식 36은 이 연결을 보존한다.

응답을 받지 못하면 같은 작업자와 문서에서 같은 요청 ID와 본문으로 재시도한다. 기존 업무와 연결을 열 수 있으면 `200`과 `{issue, link, duplicate:true}`로 응답한다. 요청 내용이나 연결 상태가 바뀌면 `409`를 반환한다. 자체 백업은 업무와 `후속 업무` 연결을 보존하며 복원 시 재시도용 기록을 초기화한다. 이 경로는 브라우저 관리 API에서 제공한다.

## 기존 업무에 문서 결정 근거 연결

브라우저의 `POST /api/documents/:id/decision-links`에 `{requestId, expectedDocumentVersion, issueId, sourceSelection}`을 보낸다. `requestId`는 UUID v4다. `sourceSelection`은 후속 업무와 같은 `{from,to,text}` 형식이며, 서버는 현재 저장 버전의 선택 범위를 읽어 발췌를 확인한다. 기존 문서 연결이 있으면 ID와 관계 유형을 유지하면서 근거를 추가한다. 연결이 없으면 `결정 근거` 관계를 만들고, 원문 저장본이 필요하면 같은 트랜잭션에 기록한다.

발췌를 처음 저장하면 `201`과 `{issue,link,duplicate:false}`를 반환한다. 작업자와 요청 내용이 같은 재시도, 또는 같은 저장본의 동일한 발췌는 `200`과 `duplicate:true`를 반환한다. 저장된 버전이나 선택한 텍스트가 다른 경우, 또는 문서와 티켓 사이에 다른 결정 근거가 이미 있는 경우 `409`를 반환한다. 연결을 해제한 뒤 이전 요청을 보내면 `409`를 반환한다. 자체 백업 형식 48은 기존 업무에 저장된 발췌와 원문 저장본을 보존하고, 복원할 때 재시도 기록을 초기화한다.

## 문장 댓글

브라우저의 `POST /api/documents/:id/selection-comments`에 `{requestId,expectedDocumentVersion,sourceSelection,body}`를 보낸다. `requestId`는 UUID v4다. `sourceSelection`은 저장된 본문의 ProseMirror 위치 `{from,to,text}`이며 최대 2,000 UTF-16 단위를 선택한다. 댓글은 공백을 정리한 뒤 20,000자까지 받는다. 서버는 버전과 발췌를 대조하고, 필요하면 원문 저장본을 댓글·활동·알림과 함께 기록한다.

신규 응답은 `201`과 `{comment,duplicate:false}`다. 같은 작업자·문서·입력의 재시도는 `200`과 `duplicate:true`를 반환한다. 버전이나 발췌가 달라지면 `409`의 `details.reason`은 `source_version_changed` 또는 `source_selection_changed`다. 휴지통으로 옮긴 댓글의 원래 요청을 보내면 `409`를 반환한다.

일반 댓글 조회는 문장 댓글의 `documentSource: {revisionId,from,to,text}`를 포함한다. 원문은 `GET /api/documents/:id/include-revisions/:revisionId`로 읽는다. 범위 제한 `/api/v1/comments` 조회에서는 키로 읽을 수 있는 원문 저장본의 발췌를 반환한다. 자체 백업 형식 50은 활성 댓글과 휴지통 댓글의 발췌를 보존한다.

## 문서 참조·포함·접기

문서 본문에는 다음 블록을 넣을 수 있다. `issueReference`는 `issueId`, `documentReference`와 `documentInclude`는 `documentId`를 사용하며, `label`은 대상이 없어졌을 때 표시할 이름이다. 모든 대상은 키의 프로젝트 범위 안에 있어야 한다. 포함 원문의 내용을 현재 문서에 복사하지 않으며, 조회 응답도 참조 ID를 유지한다.

```json
{
  "expectedVersion": 5,
  "content": {
    "type": "doc",
    "content": [
      {"type": "issueReference", "attrs": {"issueId": "업무 ID", "label": "검증 업무"}},
      {"type": "documentInclude", "attrs": {"documentId": "원문 ID", "label": "설계 원문"}},
      {"type": "details", "content": [
        {"type": "detailsSummary", "content": [{"type": "text", "text": "검토 근거"}]},
        {"type": "detailsContent", "content": [
          {"type": "paragraph", "content": [{"type": "text", "text": "접혀 있어도 본문에 보존됩니다."}]}
        ]}
      ]}
    ]
  }
}
```

자기 자신 또는 순환하는 문서 포함, 새로 지정한 누락 대상, 잘못된 블록 구조는 저장하지 않는다. 삭제된 대상의 기존 참조는 유지할 수 있다. 접기·펼치기는 화면 상태이며 JSON에 `open` 같은 속성을 추가하지 않는다. 문서 본문 한도는 8MiB·30,000개 노드·60단계다. Markdown 내보내기는 내부 참조 주소와 접힌 본문을 보존하며 원문 포함을 링크로 표현한다.

`issueList` 블록은 `{"type":"issueList","attrs":{"projectId":"프로젝트 ID","savedViewId":null,"label":"표시 이름"}}` 형식이다. `issueSummary`는 같은 속성에 `groupBy`를 추가하며 `status`, `assignee`, `priority`를 사용한다. 기본값은 `status`다. `savedViewId`가 `null`이면 프로젝트 전체 업무를 사용한다. 공유 보기의 프로젝트는 블록의 프로젝트와 일치해야 한다. 프로젝트 범위 API 키는 두 블록이 참조하는 프로젝트에 쓸 권한이 필요하며, `issueSummary`가 참조하는 프로젝트는 본문 조회와 검토·발행에도 허용 범위에 있어야 한다. 문서마다 두 종류를 합쳐 최대 30개를 저장한다.

업무 현황이 있는 기존 문서의 본문을 변경하는 PATCH는 `contentSchemaVersion: 4`를 보낸다. 업무 목록만 있는 문서에서 마지막 목록을 제거할 때는 버전 `3` 또는 `4`를 보낸다. 문서 JSON 내보내기는 업무 현황이 있으면 형식 4, 업무 목록만 있으면 형식 3을 사용한다. 자체 백업 형식 22는 업무 현황의 범위와 그룹 기준을 보존한다.

## 프로젝트 업무 순서

브라우저 경로 `GET /api/projects/:id/issue-order`는 `{projectId, issueIds, version}`을 반환한다. `issueIds`에는 프로젝트의 현재 업무가 저장 순서대로 들어 있다. `version`은 비교용 문자열이다. 같은 순서가 `/api/workspace`의 `issueOrders`에도 포함된다.

`PATCH /api/projects/:id/issue-order`는 이동할 `issueId`, 조회한 순서의 `expectedVersion`, 업무의 `expectedIssueVersion`, 같은 프로젝트의 `anchorId`, `position`에 `before` 또는 `after`를 받는다. `anchorId`가 `null`이면 프로젝트 순서의 맨 앞 또는 끝을 선택한다. 선택적으로 `status`에 대상 상태 ID를 넣으면 보드에서처럼 전이와 순서를 함께 검증한다. 상태를 지정하면 기준 업무도 대상 상태에 있어야 한다. 성공 응답은 `{order, issue}`다. 순서·대상 업무·열의 상태나 구성 변경으로 조회 버전이 오래되면 409를 반환한다. 새 순서를 읽은 뒤 다시 이동한다.

자체 백업 형식 23은 프로젝트별 활성 업무의 전체 순서를 보존한다. 복원한 데이터를 새로 조회해 최신 순서 버전을 사용한다.

자동화 클라이언트는 프로젝트 범위의 키로 `/api/v1/projects/:id/issue-order`에 같은 요청을 보낸다. 이동에는 쓰기 키가 필요하다.

## 사용자 정의 필드

유형·필드 설정은 관리 화면에서 저장하고 자동화 API에서는 조회한다. 티켓의 `customFields`는 필드 ID를 키로 사용하는 객체다. 아래 값은 해당 ID와 입력 종류를 프로젝트에 먼저 등록했을 때의 예시다.

```json
{
  "expectedVersion": 4,
  "customFields": {
    "service": "서비스 이름",
    "risk_score": 0,
    "target_date": "2026-12-01",
    "severity": "선택지 ID",
    "areas": ["선택지 ID 1", "선택지 ID 2"],
    "reviewed": false,
    "reviewer": "팀원 ID",
    "reference": "https://example.com/runbooks/incident"
  }
}
```

문자·숫자·날짜·단일 선택·다중 선택·확인 여부·팀원·URL을 지원한다. 숫자 `0`과 확인 여부 `false`도 입력된 값이다. 수정 요청에서 `customFields`를 생략하면 기존 값을 유지한다. 전달할 때는 유지할 값을 포함한다. 현재 유형에 적용되는 필드가 수정을 통해 표시 조건으로 숨겨지거나 다시 표시될 때는 그 필드를 객체에서 생략해도 기존 값을 보존한다. 조건에 따라 계속 숨겨진 필드도 보존한다. 특정 값을 지울 때는 `null`을 명시한다. 값은 필수 입력 규칙을 충족해야 한다.

필드의 대상 유형·필수 여부와 상태·전이별 `custom:필드ID` 규칙은 UI와 API에서 동일하게 검사한다. 보관된 유형은 기존 업무에서 유지하거나 사용 중인 다른 유형으로 변경할 수 있으며 새로 지정할 수 없다. 보관된 선택지와 현재 유형에 적용되지 않는 과거 필드 값은 그대로 보존하거나 비울 수 있으며 새로 지정할 수 없다. 이름 변경은 저장된 ID와 값을 바꾸지 않는다. 잘못된 종류·참조·값을 보내면 티켓을 변경하지 않고 오류를 반환한다.

브라우저의 `PATCH /api/projects/:projectId/issue-schema`로 필드를 편집할 때 `visibleWhen`에 `{statusIds,fieldMatch}`를 넣을 수 있다. 빈 `statusIds`는 모든 상태에 해당한다. `fieldMatch`는 `null`이거나 `{fieldId,value}`이며 기준 필드가 표시되고 `value`가 체크 값 또는 단일 선택의 현재 선택지 ID와 일치해야 한다. 상태와 값 조건을 모두 지정하면 모두 충족해야 한다. 기준 필드의 유형 범위는 적용 대상 필드의 범위를 포함해야 한다. 활성 참조가 있는 상태·기준 필드·선택지는 설정을 먼저 수정한 뒤 제거한다. 조건은 순환할 수 없다.

필드 자체의 `required`는 표시 조건이 맞는 동안 검사한다. 워크플로의 상태·전이 필수 조건은 해당 필드를 양식에 표시하고 필수 입력을 검사한다. 숨겨진 값도 보존되며 조회 API와 필드 검색에서 사용할 수 있다. `visibleWhen`은 자체 백업 형식 34부터 포함한다.

## 키와 실행 환경

현재 브라우저용 `/api`와 작업자 선택은 신뢰하는 로컬 팀 개발 환경을 위한 기능이며 로그인 인증을 제공하지 않는다. API 키의 권한 검사는 `/api/v1`에 적용된다. 키 발급이 애플리케이션 전체의 로그인이나 외부 접근 제한을 대신하지 않는다. 운영 배포에서는 브라우저 접근 경계와 자동화 API 공개 경로를 함께 정해야 한다.

자체 백업에는 API 키가 포함되지 않는다. 백업 가져오기는 팀원·프로젝트를 교체하므로 기존 키를 모두 회수한다. 복원 후 필요한 키를 다시 발급한다. 실패한 가져오기는 키와 기존 데이터를 유지한다.

## GitLab 연결과 상태 자동화

**개발 · GitLab**에서 연결과 자동화 규칙을 관리한다. 아래 관리 경로는 브라우저용 `/api` 경로이며 `/api/v1` 키로는 사용할 수 없다.

| 요청 | 동작 |
| --- | --- |
| `GET /api/integrations/gitlab` | 주소·허용 저장소·자격 증명 설정 여부·버전·저장한 `jiraRoutes` |
| `GET /api/integrations/gitlab/jira-sources` | Jira 원본 키를 보관한 `{projectId, jiraInstanceKey}` 목록 |
| `PATCH /api/integrations/gitlab` | `expectedVersion`, `baseUrl`, `projectIds`, 선택한 자격 증명과 `jiraRoutes` 변경 |
| `POST /api/integrations/gitlab/sync-preview` | 저장 전 입력으로 저장소별 조회 결과와 MR·파이프라인 및 선택한 저장소 이력의 티켓 연결 후보 확인 |
| `POST /api/integrations/gitlab/sync` | 저장한 연결로 MR·파이프라인과 선택한 저장소 이력을 읽어 업무 링크 저장 |
| `POST /api/integrations/gitlab/webhook` | 허용 저장소의 인증된 이벤트 수신 |
| `GET /api/automation-rules?projectId=...` | 규칙 목록 |
| `POST /api/automation-rules` | 규칙 생성 |
| `PATCH /api/automation-rules/:id` · `DELETE /api/automation-rules/:id` | `expectedVersion`으로 변경·삭제 |
| `POST /api/automation/preview` | `{rule,issueIds,sample:{trigger,gitlabProjectId,branch}}` 모의 검토 |
| `GET /api/automation-runs?projectId=...&limit=100` | 최근 실행·차단·무시 이유, 최대500건 |

자격 증명 `token`·`webhookSecret`·`signingToken`은 서버에 암호화한다. PATCH에서 빈 문자열을 보내면 해당 값을 지운다. 웹훅 인증 값을 생략하면 유지한다. 주소를 유지하면 생략한 읽기 토큰을 유지하고, 다른 주소를 저장할 때는 새로 제공한 토큰을 사용하거나 기존 읽기 토큰을 해제한다. 다른 주소를 저장하면 마지막 조회 결과도 초기화한다. GET은 설정 여부만 반환한다. 초기 설정 버전은 1이다. 주소·허용 저장소 변경 또는 웹훅 인증 해제 시 규칙을 비활성화하고 버전을 올린다. 설정 변경 중인 동기화와 미리보기 결과는 폐기한다.

**연결 미리보기**는 현재 `expectedVersion`과 선택적인 `baseUrl`, `projectIds`, `token`, `jiraRoutes`를 받는다. 저장한 주소와 입력 주소가 일치하면 생략한 읽기 토큰을 재사용한다. 주소가 달라지면 새로 입력한 토큰이나 익명 읽기를 사용한다. 미리보기 결과에는 저장소별 조회 성공·오류, 조회한 MR·파이프라인 수, 새 연결·갱신·유지 예상 건수와 최대 100개 연결 후보가 포함된다. 설정, 티켓, 연결과 자동화 실행 기록을 읽기 전용으로 처리한다.

수동 동기화는 조회를 완료한 저장소를 반영하고 `repositories`에 저장소별 결과를 돌려준다. 성공과 실패가 섞이면 `partial: true`가 표시된다. 요청한 저장소가 모두 실패하면 새 링크를 저장하지 않고 502 응답에 저장소별 실패 사유를 전달한다. `{repositoryIds,expectedVersion,includeHistory?}`로 현재 설정에 있는 저장소만 골라 다시 시도할 수 있다. 그 사이 연결 설정이 변경되면 선택 재시도를 거절한다.

미리보기와 동기화는 GitLab 저장소마다 최근 MR 최대 1,000개와 최근 파이프라인 50개를 읽는다. 파이프라인의 직접 티켓 키를 적용하고, MR에서 가져오는 키에는 저장소·브랜치·head SHA 일치를 요구한다. 조회당 10초와 디코딩된 응답 16MiB 한도가 적용된다. [GitLab MR 조회](https://docs.gitlab.com/api/merge_requests/), [GitLab 파이프라인 조회](https://docs.gitlab.com/api/pipelines/).

규칙에는 프로젝트, 이름, `enabled`, `trigger`, 비어 있지 않은 `gitlabProjectIds`·`fromStatuses`, `branchPattern`, `issueTypes`(빈 목록은 모든 유형), `toStatusId`, 실행 팀원 `actorId`, `priority`(0~10000)가 필요하다. 브랜치는 `*`·`?`만 와일드카드로 사용하는 최대128자 패턴이다. 낮은 우선순위 숫자, 같은 값이면 ID 순으로 첫 조건 일치 규칙 하나만 적용한다. 미리보기는 티켓이나 실행 기록을 쓰지 않고 외부 요청도 하지 않는다.

트리거는 `merge_request.opened`(open/reopen), `merge_request.merged`, `merge_request.closed`, `pipeline.succeeded`, `pipeline.failed`다. MR의 update/approval 이벤트와 push는 상태 자동화를 실행하지 않는다. 현재 전이·필수 속성 검증이 실패하면 차단 이유를 남긴다. 다른 규칙으로 넘어가거나 연쇄 실행하지 않는다. 이미 도착 상태이면 업무 버전은 바꾸지 않는다. 활성화 전, 오래된 이벤트, 같은 시각의 모순, 확인할 수 없는 시각의 이벤트는 상태 변경을 생략한다. 이벤트 중복과 객체·파이프라인 순서는 서버에서 검사한다. 저장된 MR에서 파이프라인 업무를 찾을 때는 브랜치와 head SHA가 함께 일치해야 한다.

GitLab의 Secret Token 방식은 `X-Gitlab-Token`으로 인증한다. Signing Token 방식은 `whsec_` 뒤의32바이트 Base64 키와 Standard Webhooks 헤더를 사용한다. 서명 헤더가 있으면 원문 JSON 바이트의 HMAC-SHA256와 최근5분 이내 서명 시각을 검증한다. 잘못된 서명을 Secret Token으로 우회하지 않는다. GitLab 설정 방법과 이벤트 필드는 [공식 웹훅 문서](https://docs.gitlab.com/user/project/integrations/webhooks/), [이벤트 문서](https://docs.gitlab.com/user/project/integrations/webhook_events/)를 참고한다.

### 이관한 Jira 키로 연결

`jiraRoutes`는 `{repositoryId, projectId, jiraInstanceKey}`의 배열이다. 허용한 GitLab 저장소당 Jira 원본 하나와 대상 Teamspace 프로젝트 하나를 지정한다. PATCH와 미리보기에서 전체 배열을 보내며 빈 배열로 매핑을 해제한다. 필드를 생략하면 같은 주소와 허용 저장소의 저장된 매핑을 사용한다. 처음 설정하는 저장소는 현재 Teamspace 키로 연결한다.

매핑한 저장소는 지정한 프로젝트의 현재 키와 지정한 Jira 원본의 이관 키를 대소문자 구분 없이 찾는다. Jira 키를 사용하면 연결 후보와 저장 링크에 `originalJiraKey`를 기록한다. 한 객체가 동일 티켓의 현재 키와 원래 키를 함께 포함하면 링크를 한 건 저장한다. 서로 다른 티켓을 가리키는 키는 보류하고 미리보기의 저장소별 `ambiguousKeys`에 최대 20개를 표시한다.

수동 동기화는 개발 활동 링크만 저장한다. 인증된 MR·파이프라인 이벤트는 활성 규칙의 기존 전이·필수 입력·시각 검증을 거친다. 매핑을 바꾸면 해당 저장소에 연결된 활성 자동화 규칙을 비활성화한다. 저장한 링크의 원래 키는 자체 백업 형식 35와 물리 백업에 들어간다. 연결 설정의 매핑은 서버에 저장되며 물리 백업에 포함된다. 자체 백업을 가져오면 복원한 데이터에 원본 프로젝트가 있는 매핑을 유지한다.

### MR 생성 전 브랜치·커밋

미리보기와 동기화에 `{includeHistory:true}`를 보내면 각 GitLab 저장소의 브랜치 최대 500개와 최근 커밋 최대 100개를 함께 읽는다. 브랜치는 이름의 티켓 키를, 커밋은 제목이나 메시지에 적힌 티켓 키를 사용한다. 미리보기의 `counts.branches`·`counts.commits`와 저장소별 `historyLimits`는 조회 건수와 한도 도달 여부를 표시한다. 동기화 결과의 `historyCounts`에는 전체 저장소의 건수를 합산한다. `historyLimits`의 각 값은 하나 이상의 저장소가 해당 조회 한도에 도달하면 `true`가 된다. [GitLab 브랜치 조회](https://docs.gitlab.com/api/branches/#list-repository-branches), [GitLab 커밋 조회](https://docs.gitlab.com/api/commits/#list-repository-commits)

GitLab 프로젝트의 **Push events**는 `refs/heads/` 이름에서 티켓 키를 찾는다. 새 커밋이 없는 브랜치도 연결하며 커밋의 제목이나 본문에 키가 있으면 그 키를 사용한다. 커밋 자체에 키가 없으면 브랜치 키를 사용한다. GitLab은 큰 푸시에서 최근 20개 커밋만 웹훅에 싣는다. [GitLab Push 이벤트](https://docs.gitlab.com/user/project/integrations/webhook_events/#push-events)

브랜치가 이어지는 변경은 이전 SHA와 다음 SHA로 확인한다. 중간 이벤트가 빠지면 마지막으로 이어진 브랜치 상태를 유지하고, 이미 받은 커밋은 이력에 남긴다. 삭제된 브랜치는 마지막 확인 SHA와 `deleted` 상태를 보존한다. 자체 백업 형식 24는 활성 티켓과 휴지통의 브랜치 관측을 보존한다.

수동 조회로 확인한 브랜치 링크는 `branchObservationSource: 'sync'`를 포함한다. 자체 백업 형식 28에서 활성 티켓과 휴지통의 수동 조회 출처를 보존한다. 이후 인증된 푸시가 같은 브랜치를 갱신하면 링크 ID를 유지한 채 웹훅 관측을 사용한다. 브랜치 삭제는 인증된 푸시에서 확인한다. 수동 동기화는 개발 활동 링크만 저장한다.

이관 키를 연결할 때 이미 인증된 활성 브랜치가 있으면 조회한 브랜치의 SHA와 정확히 일치할 때 해당 관측을 사용한다. SHA가 다르거나 푸시가 브랜치 삭제를 기록한 경우에는 그 조회로 링크를 추가하지 않는다.

`GET /api/v1/issues/:id/gitlab-links`는 `{links, total, offset, limit}`을 반환한다. 선택한 `kind`는 `branch`, `commit`, `merge_request`, `pipeline`이며 `offset` 기본값은 0이다. 기록 시간이 최근인 항목부터 50개씩 반환한다. 브랜치의 `sourceBranch`와 `sourceSha`는 참조 이름과 마지막 확인 SHA다. 읽기·쓰기 키 모두 프로젝트 범위 안에서 조회할 수 있다.

## 상태별 담당자 자동 배정

프로젝트의 **설정 → 상태별 담당자 자동 배정**에서 사용한다. 관리 경로는 브라우저용 `/api`에 있다. 기존 업무의 `/api/v1` 수정 요청으로 상태가 실제로 바뀌면 같은 배정 규칙을 적용한다.

| 요청 | 동작 |
| --- | --- |
| `GET /api/projects/:projectId/assignment-rules` | 우선순위 순 규칙 목록 |
| `POST /api/projects/:projectId/assignment-rules` | 규칙 생성 |
| `PATCH /api/projects/:projectId/assignment-rules/:id` | 수정 값과 `expectedVersion` 제출 |
| `DELETE /api/projects/:projectId/assignment-rules/:id?expectedVersion=...` | 현재 버전의 규칙 삭제 |
| `POST /api/projects/:projectId/assignment-rules/preview` | `{rule,issueIds}`를 받아 `{outcomes}` 반환 |
| `GET /api/projects/:projectId/assignment-runs?offset=0&limit=20` | 최근 결과부터 `{items,total,offset,limit}` 반환. 최대 100건씩 조회 |

규칙 필드는 `name`, `enabled`, `fromStatuses`, `toStatusId`, `issueTypes`, `assigneeId`, `mode`, `priority`다. 빈 `fromStatuses`와 `issueTypes`는 각각 모든 출발 상태와 업무 유형에 일치한다. 기본값은 `enabled: false`, `mode: 'unassigned'`, `priority: 100`이다. `mode: 'replace'`는 기존 담당자도 바꿀 수 있다. 우선순위는 0~10000으로, 숫자와 ID가 앞서는 일치 규칙 하나를 사용한다. 같은 저장에서 직접 변경하거나 해제한 담당자가 우선한다.

미리보기는 선택한 최대 50개 업무에 입력한 규칙 하나를 적용해 본다. 상태·담당자와 `assigned`, `unchanged`, `skipped`, `blocked` 결과 및 이유를 반환한다. 규칙·업무·실행 기록은 그대로 유지한다.

## 외부 발신 웹훅

**개발 · GitLab → 외부 웹훅**에서 수신처를 만든다. 처음에는 비활성이며 서명 키는 생성·교체 직후 한 번만 표시한다. 수신 시스템에 저장한 뒤 활성화한다. 최대20개 수신처를 등록할 수 있다.

| 요청 | 동작 |
| --- | --- |
| `GET /api/webhook-endpoints` · `POST /api/webhook-endpoints` | 목록·비활성 수신처 생성 |
| `PATCH /api/webhook-endpoints/:id` · `DELETE /api/webhook-endpoints/:id` | `expectedVersion`으로 설정·활성화·삭제 |
| `POST /api/webhook-endpoints/:id/rotate-secret` | `expectedVersion`으로 서명 키 교체, `{endpoint,secret}` 한 번 표시 |
| `GET /api/webhook-deliveries?endpointId=...&limit=100` | 전송 이력, 최대100건 |
| `GET /api/webhook-deliveries/:id` | `{delivery,envelope}` 메타데이터 |
| `POST /api/webhook-deliveries/:id/retry` | 실패·취소 기록을 `expectedVersion`으로 재시도 |

수신처 설정은 `{name,url,projectIds,eventTypes,enabled}`다. `projectIds:null`은 공통 문서를 포함한 전체, 비어 있지 않은 ID 목록은 해당 프로젝트만 받는다. 이벤트는 `issue.created/updated/deleted`, `document.created/updated/deleted`, `comment.created`다. http(s) URL만 지원하고 리다이렉트는 따라가지 않는다.

본문에는 고정 이벤트 `id`, `type`, `occurredAt`, `actorId`, `origin`, `projectId`, `sourceEventId`, `changedFields`, 현재 `resource` 요약과 이전 `previous` 요약을 보낸다. 본문·댓글 원문, 사용자 정의 필드 값과 연결 자격 증명은 보내지 않는다. 필요한 상세는 범위가 제한된 API 키로 조회한다. 이벤트와 전송 대기는 원본 변경과 같은 트랜잭션에서 저장한다. 비활성 시기의 이벤트, 기술적인 동일 값 저장과 가져오기는 전송을 만들지 않는다.

수신 측은 원문 요청 바이트로 다음 서명을 확인한다. `whsec_`를 제거하고 Base64 디코딩한 키를 사용하며 시각의 허용 오차도 검사한다.

```text
webhook-id: 이벤트 ID (재시도에도 동일)
webhook-timestamp: 현재 시도의 Unix 초
webhook-signature: v1,<Base64(HMAC-SHA256(key, id + "." + timestamp + "." + rawBody))>
```

전송은 최대4건씩, 요청당 최대10초, 자동 최대5회다. 실패 후 기본5·10·20·40초 간격으로 재시도한다. 최소 한 번 전달 방식이므로 수신 측은 이벤트 ID를 중복 처리해야 한다. 응답 본문은 읽거나 기록하지 않는다. 설정·활성화·키 변경은 이전 대기 전송을 취소한다. 명시적 재시도는 현재 활성 수신처의 프로젝트·이벤트 범위로 검사하고 현재 키를 사용한다. 종료된 전송은30일 보관하고 전체 전송 기록 상한50000건에 도달하면 원본 변경도 함께 거절한다.

자체 백업 schema8에는 규칙 정의만 포함한다. 복원한 규칙은 비활성으로 시작한다. 외부 수신처·서명 키·전송 이력·GitLab 수신 기록은 제외하고, 가져오기가 성공하면 초기화한다. 실패한 가져오기는 기존 설정·대기 전송·세대 값을 보존한다.

## 기존 도구 원본 분석

설정의 **기존 도구 원본 분석**에서 Jira·Confluence 내보내기 XML/CSV/JSON/ZIP을 선택하고 원본 서버를 구분할 이름을 입력한다. 같은 원본 서버의 자료에는 같은 이름을 사용한다. 외부 서비스에는 연결하지 않는다. 분석 결과로 적용할 자료를 확인한 뒤 같은 설정 화면의 **실제 데이터 이관**에서 적용을 준비한다.

| 요청 | 동작 |
| --- | --- |
| `GET /api/legacy-import/packages` | 보관한 분석 요약 |
| `POST /api/legacy-import/packages?filename=...&instanceKey=...&product=auto` | `application/octet-stream` 원본 파일 분석, 신규201·동일 원본200 |
| `GET /api/legacy-import/packages/:id` | 요약·파일 크기/SHA-256·미지원 객체 종류/개수 |
| `GET /api/legacy-import/packages/:id/records?kind=issue&q=...&offset=0&limit=50` | 종류·제목·원본 ID/티켓 키 검색, 본문 없는 요약·600자 미리보기 |
| `GET /api/legacy-import/packages/:id/records/:recordId` | 정확한 원문·작성자·원래 시각·메타데이터·관계, ID는 URL 인코딩 |
| `GET /api/legacy-import/packages/:id/diagnostics?severity=warning&offset=0&limit=50` | 오류·경고·정보 진단 |
| `DELETE /api/legacy-import/packages/:id?expectedVersion=1` | 분석 메타데이터·보관 원본 삭제 |

목록 페이지 크기는1~100이다. `product`는 `auto`·`jira`·`confluence` 중 하나다. 입력/개별 ZIP 파일64MiB·총 해제256MiB·5000파일·정규화 객체100000개 한도이며, 한 번에 한 패키지를 최대25초 분석한다. 분석 원본 보관은20개·512MiB까지다. ZIP 경로·심볼릭 링크·중복 경로·CRC와 XML 선언/엔티티/구조를 검증한다. 누락 첨부나 링크는 자동 다운로드하지 않는다.

관리 경로는 `/api/v1` 키로 사용할 수 없다. 분석 패키지는 현재 신뢰하는 관리 브라우저 범위에서 접근하며, 기존 도구의 권한을 재현하는 기능은 아니다. 제한된 콘텐츠는 진단으로 표시하고 실제 적용 단계에서 검토해야 한다. 자체 JSON 백업에는 분석 패키지·원본이 포함되지 않고 백업 가져오기 후에도 유지되므로, 분석 자료까지 백업하려면 서버 DB와 `data/legacy-imports/`를 함께 보관한다.

## 검토한 원본 이관 적용

| 요청 | 동작 |
| --- | --- |
| `GET /api/migrations/options?packageId=…&packageId=…` | 분석 패키지의 프로젝트·작성자·상태·유형·필드 매핑과 확인한 Jira·Confluence 추가 대상 |
| `POST /api/migrations/preview` | `configuration`으로 프로젝트 생성 또는 업무·문서 추가 계획과 보존·누락 진단 검토 |
| `GET /api/migrations/previews/:id` | 선택한 작업자의 검사 결과 다시 읽기 |
| `POST /api/migrations/previews/:id/apply` | `expectedVersion`·`acknowledgements`로 검토한 계획 적용 |
| `GET /api/source-imports` | 적용된 프로젝트와 패키지·수량·진단 영수증 |
| `GET /api/source-imports/:id/records` · `GET /api/source-imports/:id/records/:recordId` | 원본 목록과 전체 기록 |
| `GET /api/resource-origins?resourceType=issue&resourceId=…` | 현재 업무·문서에 연결된 원본 기록 |
| `GET /api/issues/:id/relations` | 이관한 관계와 팀에서 직접 만든 업무 관계 |
| `GET /api/attachments/:id/versions` · `GET /api/attachment-versions/:id/download` | 첨부 버전 목록·파일 |

미리보기는 30분간 보관한다. 새 변환 규칙이 적용되면 미리보기를 다시 만든다. 적용 시 같은 작업자와 미리보기 버전, 필수 확인 코드 전체가 필요하다. 패키지·첨부 해시, 원본 바인딩, 새 프로젝트 키를 재검사한다. 같은 요청을 다시 보내면 기존 영수증을 반환한다. 원본 객체가 겹치는 새 이관과 이미 사용 중인 프로젝트 키는 충돌로 처리한다. 기존 작업공간에 대한 변경 권한은 현재 신뢰하는 관리 브라우저를 기준으로 한다.

객체에 연결된 `notices[].recordId`는 패키지 ID와 레코드 ID를 첫 `/`로 연결한 값이다. 진단의 **원본 상세 보기**는 두 ID를 각각 인코딩해 분석 단계의 원본 조회 경로를 사용한다.

`configuration.sourceBaseUrls`는 선택한 분석 패키지 ID별 선택 입력이다. 기본 주소는 HTTP(S) 호스트와 서비스 경로를 사용한다. 인증 정보·쿼리·프래그먼트가 포함되면 미리보기가 적용을 막는다. Jira는 원래 업무 키, Confluence는 일반 페이지의 숫자 ID로 링크를 계산한다. 응답의 `samples[].sourceUrl`에는 생성할 정규 주소가 들어간다. 미리보기와 영수증의 `counts.atlassianLinks` 및 `counts.unlinkedAtlassianRecords`는 이관 대상 중 생성할 링크와 링크를 만들 수 없는 항목의 건수다. 누락 사유는 `notices`에 기록된다. 링크를 새 대상과 같은 트랜잭션에서 저장하며 `GET /api/atlassian-links`로 현재 링크를 읽는다.

원본의 시간대가 없는 시각에는 설정한 IANA 시간대를 사용한다. Jira CSV의 영문 월 형식도 처리하며, 두 자리 연도는 2000년대로 해석한다는 확인을 요청한다. [Atlassian Jira 날짜 형식 안내](https://confluence.atlassian.com/jirakb/date-format-changes-after-exporting-to-excel-119799961.html) 해석 불가 시 기본값은 적용 차단이다. 이관 시각을 사용하는 정책을 선택하면 그 사실을 검토 결과와 영수증에 남긴다. 원본 작성자는 원래 신원으로 보존한다. 현재 팀원으로 매핑하지 않은 작성자는 현재 문서·댓글·첨부에 이관 실행자를 기록한다. 제외한 원본은 적용 대상 없이 관리용 영수증에 보관한다. 원본 권한 정책은 별도로 검토해야 한다.

자체 백업 schema9는 적용된 영수증, 원본 기록, 업무 관계, 첨부 버전 메타데이터와 바이트를 포함한다. 분석 패키지와 미리보기는 별도 보관 대상이다. 자체 백업 복원으로 미리보기가 무효화된다. 원본 이관 적용 중에는 발신 웹훅이 생성되지 않는다.

### 기존 프로젝트에 새 Jira 업무 추가

선택한 패키지의 업무가 같은 Jira 인스턴스와 하나의 원본 프로젝트에 속하고, 원본이 기존 Teamspace 프로젝트에 연결되어 있으면 옵션에 `appendTarget`과 현재 상태·유형·필드가 포함된다. `configuration.appendTo`에 `{projectId,statuses,issueTypes,fields}`를 설정한다. 각 매핑의 키는 옵션 ID이며 값은 대상 프로젝트의 상태·업무 유형·필드 ID다. 필드 값을 `null`로 지정하면 해당 값은 원본에 보관한다. 기존 프로젝트의 설정과 기존 티켓 데이터를 보존한다.

`counts.issues`는 새 업무 수, `retainedIssues`와 `retainedRecords`는 이전 이관으로 이미 처리해 원본으로 보관하는 업무와 관련 기록 수다. 휴지통이나 영구 삭제한 업무의 원본 ID도 중복 생성 방지에 사용한다. 새 업무는 현재 연결 가능한 부모나 관계를 참조할 수 있다. 적용은 대상의 설정 버전, 다음 업무 번호와 원본 연결을 다시 확인한다. 형식 37 자체 백업은 추가 이관의 대상과 매핑을 보존한다.

### 이미 이관한 Jira 업무에 원본 변경분 반영

위 설정에 `appendTo.refreshExisting: true`를 지정하면 같은 프로젝트에 연결된 기존 티켓도 검토한다. 새 패키지의 실제 수정 시각이 직전 원본 기록보다 늦을 때 제목·설명·유형·상태·우선순위·담당자·라벨·시작일·종료일·마감일·예상 작업량 중 확인 가능한 값을 비교한다. 원본에서 생략한 필드나 Teamspace에서 별도로 편집한 필드는 현재 값이 유지된다. 사용자·상태·유형을 반영할 때는 검토한 매핑을 사용한다.

`preview.issueRefresh`는 Teamspace 업무 키, 원래 Jira 업무 키와 각 필드의 현재 값·원본 값·반영 여부를 보여준다. `updatedIssues`, `updatedFields`, `conflictingFields`, `skippedIssueUpdates`에서 반영·충돌·건너뛴 업무 건수를 확인한다. 한 요청은 기존 티켓 1,000개와 비교에 쓰는 데이터 64MiB까지 지원한다. 워크플로 전이와 필수 필드를 검증하고, 적용 전 티켓이 수정되면 새 미리보기가 필요하다. 새 티켓 추가와 기존 티켓 갱신은 하나의 이관으로 적용할 수 있다. 형식 39 자체 백업은 변경분 이관 설정과 필드별 비교 기준을 보존한다.

### 이미 이관한 Jira 업무에 사용자 정의 필드 변경분 반영

`appendTo.refreshCustomFields: true`를 지정하고 `appendTo.fields`에서 원본 속성을 기존 Teamspace 필드 ID에 연결한다. 기본 필드 옵션과 개별 또는 함께 적용할 수 있다. 원본 속성의 식별자와 기존 매핑을 확인한 뒤 새 값을 이전 이관 기준 및 현재 값과 비교한다. 생략한 원본 값, 팀이 수정한 값, 이관 기준이나 현재 표시 조건을 확인할 수 없는 값은 보존한다.

미리보기의 `issueRefresh[].customFields`는 현재 필드 이름·현재 값·원본 값·반영 여부를 반환한다. `updatedCustomFields`와 `conflictingCustomFields`에서 반영하고 보존할 필드 수를 확인한다. 같은 티켓의 기본 필드 및 사용자 정의 필드는 하나의 검증된 편집으로 저장된다. 형식 43 자체 백업은 기본 필드와 독립적으로 다음 비교에 사용할 사용자 정의 필드의 기준을 보존한다.

### 기존 Jira 업무에 댓글과 작업 시간 추가

`appendTo.refreshHistory: true`를 지정하면 같은 원본 인스턴스와 프로젝트의 기존 티켓에 새 댓글과 작업 시간 기록을 추가한다. 안정적인 원본 ID, 이전 이관으로 증명되는 대상, 팀원 작성자 매핑과 실제 시각을 확인한다. 작업 시간은 초 단위 원본과 작업일을 유지한다. 이전에 저장한 기록의 원본 ID는 팀에서 기록을 삭제한 뒤에도 중복 방지에 사용한다.

작업 시간·댓글만 있는 관리자 내보내기에서도 기존 원본 연결로 한 프로젝트를 확인할 수 있다. CSV의 위치 기반 댓글, ID 또는 작성자를 확인할 수 없는 기록과 접근이 제한된 기록은 원문으로 보관한다. 미리보기와 영수증의 `newJiraComments`, `newJiraWorklogs`에서 기존 티켓에 추가할 수를 확인한다. 기본 필드와 사용자 정의 필드 변경분 옵션을 함께 선택할 수 있다. 형식 44 자체 백업은 추가 설정과 원본 연결을 보존한다.

### 기존 Jira 업무에 첨부파일 추가

`appendTo.refreshAttachments: true`를 지정하면 같은 원본 인스턴스와 프로젝트에서 소유 업무를 확인할 수 있는 새 원본 첨부파일을 추가한다. 원본 ID가 같으면 이미 저장한 파일과 삭제 기록을 보존하고, 이름이 같아도 원본 ID가 다르면 별도의 파일로 추가한다. 업무 객체가 빠진 관리자 ZIP에서는 이전 이관 기록으로 연결을 확인한다.

원본 패키지에서 일치하는 바이트의 크기와 SHA-256을 미리보기 및 적용 과정에서 확인한다. 바이트나 원본 연결을 확정할 수 없는 파일은 이관 검토에서 확인한다. 미리보기와 영수증의 `newJiraAttachments`에서 기존 티켓에 추가할 파일 수를 확인한다. 댓글·작업 시간과 필드 변경분 옵션을 함께 선택할 수 있다. 형식 45 자체 백업은 추가 설정과 파일의 원본 연결을 보존한다.

### 기존 프로젝트에 새 Confluence 문서 추가

선택한 페이지가 같은 Confluence 인스턴스와 한 원본 공간에 속하고, 해당 공간이 기존 Teamspace 프로젝트에 연결되어 있으면 `appendPagesTarget`에 대상 프로젝트와 원본 공간이 포함된다. `configuration.appendPagesTo`에 `{projectId}`를 지정한다. 한 미리보기는 Jira 또는 Confluence 중 하나의 추가 이관을 처리한다.

`counts.documents`는 새 문서 수, `retainedPages`와 `retainedRecords`는 이전에 이관한 페이지와 함께 제출해 원본으로 보관하는 기록 수다. 이미 이관한 문서의 현재 제목·본문과 휴지통 상태를 보존한다. 새 문서는 같은 공간과 프로젝트에서 확인한 기존 문서를 상위 문서나 본문 참조에 쓸 수 있다. 적용 직전에 원본 연결과 대상 문서의 현재 프로젝트를 확인한다. 형식 38 자체 백업은 추가 이관의 대상을 보존한다.

현재 페이지 본문의 앵커는 대상이 유일한 제목 절을 확인했을 때 Teamspace 문서 절 링크로 바꾼다. 대상을 확인하기 어려운 링크는 읽을 수 있는 원본 표기를 남기고 `SECTION_LINK_UNRESOLVED`로 표시한다. 기존 문서의 절을 가리키는 계획은 적용 시 그 절이 남아 있는지 다시 확인한다.

### 이미 이관한 Confluence 문서에 원본 변경분 반영

`appendPagesTo.refreshExisting: true`를 지정하면 현재 프로젝트에 연결된 기존 문서의 제목과 본문도 비교한다. 원본 페이지 버전이 이전보다 높을 때 변경을 검토하며, 버전을 비교할 수 없으면 확인 가능한 수정 시각을 사용한다. 팀이 편집한 필드, 내보내기에서 생략한 본문, 참조나 첨부를 확인할 수 없는 본문은 현재 값을 보존한다.

`preview.documentRefresh`로 현재 값·원본 값·반영 여부와 서식만 바뀐 본문을 확인한다. `updatedDocuments`, `updatedDocumentFields`, `conflictingDocumentFields`, `skippedDocumentUpdates`는 검토 수량이다. 한 요청은 기존 문서 300개와 비교 데이터 64MiB까지 지원한다. 본문을 갱신할 때는 문서 버전, 현재 공동 편집 참여자, 적용 후 포함 관계의 순환 여부를 확인한다. 적용은 새 문서 이력과 영수증을 함께 저장하며, 형식 40 자체 백업은 다음 이관에 사용할 필드별 비교 기준을 보존한다.

### 기존 Confluence 문서에 첨부와 버전 추가

`appendPagesTo.refreshAttachments: true`로 기존 문서에 새 원본 첨부를 추가하고, 이전에 연결된 첨부에는 더 높은 원본 버전 번호를 확인해 추가한다. 제목·본문의 변경분 옵션과 함께 또는 개별로 적용할 수 있다. 원본 첨부 ID, 원래 소유 페이지와 버전으로 첨부를 식별한다. 휴지통과 영구 삭제 기록이 있는 기존 첨부는 원문에 보관한다.

같은 공간의 기존 원본 첨부는 원본 ID나 확인된 소유 페이지와 파일명으로 찾아 저장한 파일의 고정 버전에 연결한다. 재사용 대상은 미리보기와 적용 시 크기·SHA-256으로 검사한다. `newConfluenceAttachments`, `newConfluenceAttachmentVersions`, `reusedConfluenceAttachmentVersions`에서 기존 문서의 새 첨부, 기존 첨부에 추가할 버전과 본문에서 재사용할 버전을 확인한다. 이전 링크는 당시 파일 ID로 열리며, 파일 목록은 팀이 직접 추가한 최신 버전을 우선한다. 형식 41 자체 백업은 추가 원본 버전과 이관 설정을 보존한다.

### 기존 Confluence 문서에 댓글과 이력 추가

`appendPagesTo.refreshHistory: true`를 지정하면 같은 원본 인스턴스와 공간에서 기존 문서로 확인된 페이지에 새 원본 댓글과 과거 저장본을 추가한다. 원본 파일에 현재 페이지나 공간 객체가 빠진 경우에는 기존 이관 기록으로 소유 페이지와 공간을 확인한다. 제목·본문, 첨부 옵션과 개별 또는 함께 적용할 수 있다. 현재 문서 버전과 팀에서 작성한 댓글을 보존한다. 이미 이관한 원본 댓글 ID와 문서의 원본 버전은 삭제 이력이 있더라도 알아본다. 소유 페이지, 본문, 버전이나 첨부를 확인할 수 없는 자료는 영수증에 원문으로 보관한다.

미리보기와 영수증의 `newConfluenceComments`, `newConfluenceRevisions`에 추가 건수가 들어간다. 문서 이력과 고정 저장본 목록에서 과거 원본 저장본의 `confluenceSourceVersion`을 읽을 수 있다. 원본 저장본에서 복구하면 새 Teamspace 문서 버전이 생성된다. 형식 42 자체 백업은 추가 이관 설정과 원본 버전 표시를 보존한다.

### 적용 후 대조

브라우저의 `GET /api/source-imports/:id/reconciliation`은 영수증 전체의 상태별 건수와 현재 조회의 `total`, `offset`, `limit`, `rows`를 반환한다. `kind`, `status`, `q`로 원본 종류·연결 상태·원래 키·제목을 검색한다. `offset`은 0~1,000,000, `limit`은 1~100이며 기본값은 각각 0과 30이다. 결과의 현재 대상에는 업무·문서로 이동하는 데 필요한 ID와 프로젝트가 들어 있다. 원문과 적용 당시 진단은 기존 원본 기록과 영수증에서 읽는다.

`linked`는 현재 대상, `trashed`는 휴지통에 해당 대상이 보관된 상태, `missing`은 저장한 연결에 해당하는 현재나 휴지통의 대상이 없는 상태다. `archive-only`는 직접 연결 없이 보존한 원본이다. 새 이관의 `excluded`에는 명시적으로 제외한 원본과 함께 제외된 하위 원본이 포함된다. 원본 사용자·속성 등의 매핑 자료와 직접 연결 ID가 없는 관계 자료는 원본 보관으로 표시한다.

`GET /api/source-imports/:id/records/:recordId/check-file`은 지정한 원본 첨부 버전의 저장 바이트를 기록된 파일 크기와 SHA-256으로 검사한다. `verified`, `missing`, `corrupt`, `unbound` 상태와 연결된 파일의 식별 정보를 반환한다. 휴지통에 보관한 파일 버전도 검사할 수 있다.

`GET /api/source-imports/:id/reconciliation/audit?expectedVersion=…`는 해당 영수증의 전체 대상 상태를 집계하고 활성·휴지통의 원본 첨부 버전을 검사한다. `recordCounts`와 `attachmentCounts`는 전체 건수다. `attachments`에는 원본 제품·인스턴스·패키지 해시·원본 ID·현재 대상 상태와 대상 파일 ID·기준 크기·기준 SHA-256이 들어 있다. 검증 상태는 `verified`, `missing`, `corrupt`, `unbound`, `excluded`, `unreadable`이다.

`integrity`의 `records`와 `boundAttachments`는 보존 원본 수와 대상 첨부 버전 ID가 연결된 원본 수의 이관 당시 기준(`expected`)과 검사값(`observed`)이다. `packages`는 이름·수량·원본 집합 SHA-256을 패키지별로 대조한다. `verified`는 저장된 원본 기준과 일치, `mismatch`는 불일치, `counts-only`는 당시 수량만 비교 가능, `unavailable`은 당시 기준을 읽을 수 없는 상태다. `unmatchedRecords`와 `columnMismatches`는 출처를 확인할 수 없는 기록과 저장 식별 정보 불일치를 보여준다. 원본 무결성 `verified`와 현재 대상·파일 상태는 독립된 결과다.

서버는 파일을 순서대로 읽고, 보존 원본에 크기·해시가 있으면 그 값도 대조한다. 검증 중 영수증·보존 원본·대상·첨부 메타데이터가 바뀌거나 워크스페이스가 복원되면 `409`를 반환한다. 시작·완료 시각은 검증 구간을 나타낸다. 워크스페이스당 한 번씩 실행하며, 진행 중 다른 전체 검증 요청은 `429`를 반환한다. 이 경로는 브라우저용이다.


## 프로젝트 보고서와 주간 문서

| 브라우저 경로 | 동작 |
| --- | --- |
| `GET /api/projects/:id/report` | 필수 `startDate`·`endDate`(YYYY-MM-DD)·`timeZone`(IANA), 선택 `issueType`·`assigneeId` 조건으로 집계 |
| `GET /api/projects/:id/report-snapshots` | 최근 보관본 최대 100개의 제목·기준 시각·문서 ID·조회 조건 |
| `GET /api/projects/:id/report-snapshots/:snapshotId` | 당시 조건·집계·업무 목록을 포함한 보관본 조회 |
| `POST /api/projects/:id/report-snapshots` | `{title, query}`로 다시 집계하고 보관본과 주간 문서 초안을 같은 트랜잭션에 생성. `query`는 경로와 같은 `projectId` 및 조회 조건을 포함. 성공 시 201 |

보고서는 요청 시점의 상태·마감과 기간 중 사건을 분리한다. 조회 기간은 현지 시작일 자정부터 종료일 다음 날 경계 직전까지 1~92일이다. 마감은 명시한 마감일을 우선하며 없으면 일정 종료일을 사용한다. 마감 임박은 조회 시점의 현지 오늘부터 7일 뒤까지다. 기간별 유형·담당자 필터는 각 변경의 당시 값으로 적용한다. 업무 행은 현재 또는 기간 내 관측 조건에 해당하는 최대 5,000개까지 조회할 수 있다.

완료 업무 수는 적어도 한 번 완료 상태로 이동한 고유 업무 수다. 완료 전이에서 해당 업무 수를 뺀 값이 재완료 수다. 재개는 완료에서 진행 가능한 상태로 이동한 횟수다. 워크플로 상태 정의 변경과 기존·이관 업무의 수집 기준점은 별도로 기록한다. 소요 시간은 실제로 관측한 진행 또는 검토 시작부터 완료 전이까지의 경과 시간이며 표본 수와 함께 표시한다. 관측 구간별 날짜 마감 시점 상태를 계산하고, 마감 시점의 데이터가 없으면 상태가 `null`이다.

제목은 공백을 제외해 1~200자다. 서버가 집계하고 저장한 값을 읽기 전용으로 제공하며 주간 문서는 계속 편집할 수 있다. 문서의 업무 참조는 최대 30개이고 전체 행은 보관본에서 확인한다. 경로는 신뢰하는 로컬 브라우저 범위에서 제공한다.

자체 백업 schema10 이상은 `reportingLedger`와 `reportSnapshots`를 포함한다. 백업은 내보낸 시각까지의 이력을 저장한다. 복원 시 새 수집 구간과 당시의 업무 기준 상태를 만든다. schema1~9 복원에는 이전 보고 이력이 없으며 복원 시각부터 수집한다.


## 스프레드시트 일정 붙여넣기

브라우저의 `POST /api/schedule/paste-preview`에 `{projectId, text}`를 보낸다. `text`는 헤더가 있는 TSV 또는 CSV다. `key`(`업무 키`)와 `startDate`(`시작일`), `endDate`(`종료일`), `predecessor`(`선행 업무`) 중 한 열 이상이 필요하다. 빈 날짜 값은 유지하고 `-`는 지운다. 선행 업무 키가 있으면 `dependency type`(`연결 유형`)과 `lag days`(`근무일 간격`)도 사용할 수 있다. 유형 `-`는 지정한 관계를 해제한다. 빈 유형과 간격은 기존 값을 사용하며 새 연결의 기본값은 `FS`·`0`이다. 업무 키는 같은 프로젝트에서 조회하며 후행 업무마다 한 행을 사용할 수 있다. 다른 헤더가 명시된 열은 무시한다. 최대 500행, UTF-8 128KiB를 처리한다.

응답의 `changes`는 업무별 현재·제안 일정이며, `dependencyChanges`는 행 번호와 선행·후행 업무의 키·제목, 변경 전후의 `{type,lagDays}`를 담는다. 새 연결의 `before` 또는 해제하는 연결의 `after`는 `null`이다. `warnings`는 선후행 날짜 조건 경고이며 `errors`는 적용을 막는 진단이다. `unchanged`는 날짜와 연결이 모두 바뀌지 않는 행 수다. 오류 없이 변경이 있는 경우에만 `previewId`와 `expiresAt`을 발급한다.

`POST /api/schedule/paste-apply`에 `{previewId}`를 보낸다. 미리보기 작업자와 정책·달력·선후행·업무 버전을 검사해 30분 이내의 계획을 적용한다. 연결을 추가할 때 최종 그래프의 순환 여부도 검사한다. 같은 ID의 적용을 7일 안에 재요청하면 같은 `{undoId,updated,warnings}`를 반환하며 연결 변경이 있으면 `dependencyChanges` 건수도 포함한다. 날짜·연결·이력·되돌리기 기록·적용 응답을 같은 트랜잭션으로 저장한다. `POST /api/schedule/undo`는 대상 업무와 연결이 현재 상태와 일치하고 복구할 연결이 순환을 만들지 않을 때 두 변경을 함께 복원한다. 미리보기와 영수증은 자체 백업 범위 밖에 있으며 복원 시 초기화한다.

## 계획과 연결 업무 일정 이동

브라우저의 `POST /api/planning-items/:id/schedule-preview`에 `{expectedPlanVersion, days, workingDays, includeLinked}`를 보낸다. `days`는 절댓값이 1~3,650인 정수다. `workingDays`가 참이면 프로젝트 달력을 적용한다. `includeLinked`가 참이면 현재 연결된 전체 업무를 대상으로 기존 일정 중 이동할 날짜를 계산한다. 프로젝트 업무 10,000개나 연결 업무 1,000개를 초과하면 `413`을 반환한다. 응답은 계획 날짜의 `plan.from`과 `plan.to`, 업무 `changes`, 제외 업무 `skipped`, 선후행 `warnings`, 적용 차단 사유 `blocking`을 담는다. 적용 가능한 변경이 있으면 30분 동안 사용할 `previewId`를 발급한다.

`POST /api/planning-items/:id/schedule-apply`는 `{previewId}`를 받아 미리보기를 만든 작업자와 계획, 검토 이후 바뀐 연관 자료를 확인한다. 일정·변경 이력·되돌리기·적용 결과를 원자적으로 저장한다. 응답은 `{plan, undoId, updated, warnings}`다. 같은 ID의 적용 결과는 7일간 다시 받을 수 있다. `POST /api/schedule/undo`에 `{undoId}`를 보내면 검토 대상의 날짜를 함께 복원하며 복원된 `plan`도 응답에 포함한다. 이 작업의 미리보기·적용 결과·되돌리기 기록은 자체 백업 복원 시 초기화한다.


## 티켓과 프로젝트 작업 시간

브라우저의 `/api`와 키로 호출하는 `/api/v1`에서 같은 작업 시간 경로를 사용한다. API 키는 설정된 프로젝트 범위와 소유자를 사용한다. 조회는 읽기 키로 가능하며 추가·수정·삭제에는 쓰기 키가 필요하다.

| 경로 | 동작 |
| --- | --- |
| `GET /issues/:id/worklogs?offset=0` | 작업일 내림차순으로 최대 50개와 전체 분·건수 조회 |
| `POST /issues/:id/worklogs` | `{requestId, workDate, minutes, note}`로 기록하고 생성 결과 반환 |
| `PATCH /issues/:id/worklogs/:entryId` | 작성자가 `{expectedVersion, workDate, minutes, note}`로 수정 |
| `DELETE /issues/:id/worklogs/:entryId` | 작성자가 JSON 본문의 `expectedVersion`으로 삭제 |
| `GET /projects/:id/worklog-report` | `startDate`·`endDate`(포함, 1~92일) 및 선택 `authorId`로 날짜·작성자·업무별 분·건수 집계 |

`workDate`는 선택한 날짜의 YYYY-MM-DD 값이다. 시간은 기록당 1~1,440분의 정수이며 메모는 선택 항목으로 2,000자까지다. 소요 포인트와 별개다. 생성 시 호출자가 소문자 UUID `requestId`를 생성하고, 응답을 받지 못하면 같은 ID와 같은 데이터로 다시 요청한다. 생성은 201을 반환하며 서버가 보관한 현재 기록을 재응답한다. 다른 데이터나 삭제된 ID를 재사용하면 409다. 수정과 삭제는 기록의 버전을 검사한다. 기록 변경은 업무 자체의 버전을 올리지 않는다.

티켓이 삭제되어도 이전에 입력한 시간은 해당 프로젝트의 집계에 남는다. 이 경우 보고서에는 기록에 남아 있는 키와 제목을 표시한다. 시간을 개별 삭제하면 합계에서 제외하고 저장된 메모를 지운다. 자체 백업 schema11 이상은 기존 업무의 시간과 삭제된 티켓의 시간, 삭제 요청을 식별할 ID를 함께 보존한다. schema1~10 복원에서는 빈 작업 시간 목록으로 시작한다.


Jira 이관 작업에는 `sourceRecordId`와 `durationSeconds`가 함께 반환된다. 이관 기록의 `minutes`와 보고서 합계는 초를 분으로 표현하므로 소수일 수 있다. 이관 기록의 PATCH에서 생략한 날짜·메모·시간은 유지된다. `minutes`를 생략하면 초 단위 시간도 유지된다. 분을 명시하면 1~1,440분 범위의 새 시간으로 변경한다. 기본 작업 기록은 분 입력이 필요하다. schema12 백업에서 이관 시간의 원본 ID와 초 단위를 보관·검증한다.

Jira 원본 이관 미리보기와 영수증에는 `worklogs` 및 `archivedWorklogs` 건수가 포함된다. 관리자 XML의 Worklog 및 업무 JSON에 포함된 REST·Importers 개별 작업 기록이 대상이다. 업무 단위 합계만 있는 파일에서는 개별 작업 시간을 생성하지 않는다. 원래 작성자를 팀원으로 매핑하고 작업일과 길이를 확인할 수 있는 기록을 집계에 반영한다. 시작 시각·작성자·원본 메모는 원본 기록에서도 볼 수 있다. 제한된 작업 기록은 이관에서 명시적으로 제외할 때까지 적용을 차단한다. 상대 날짜나 설정에 따라 달라지는 일·주 길이는 원본에 보관하고 진단에서 확인한다. [Jira Data Center 작업 기록 API](https://developer.atlassian.com/server/jira/platform/rest/v11003/api-group-issue/), [Jira JSON 작업 시간 예시](https://confluence.atlassian.com/servicedeskcloud/importing-data-from-json-1097176631.html#ImportingdatafromJSON-Worklogs).


## 사용자 정의 필드 조건

업무 화면에서 적용한 필드 조건은 검색·상태·담당자·유형 필터와 함께 적용한다. 공유 보기는 `filters.fieldFilter`에 아래 그룹을 조건과 동일한 ID로 저장한다. 가능한 연산자는 필드 종류에 따라 달라진다.

| 필드 | 비교 연산자 |
| --- | --- |
| 모든 종류 | `is_set` 값 있음, `is_empty` 값 비어 있음 |
| 문자·URL | `equals`, `not_equals`, `contains` |
| 숫자·날짜 | `equals`, `not_equals`, `gte`, `lte` |
| 확인 여부·단일 선택·팀원 | `equals`, `not_equals` |
| 다중 선택 | `includes`, `excludes` |

날짜는 YYYY-MM-DD, 숫자는 JSON 숫자, 확인 여부는 `true`·`false`, 선택지와 팀원은 각각 ID를 사용한다. 값 유무 연산자에는 `value`를 넣지 않는다. 비교의 대소문자는 전체 값 비교에서 그대로 적용하고 부분 문자열 검색에서는 구분하지 않는다. 값이 없으면 값 비교와 포함·제외 조건에 일치하지 않는다. 그 업무 유형에 적용되는 필드만 비교한다. 값 유무 검사에서 숫자 0과 `false`는 값이 있는 것으로 센다.

`POST /api/v1/issues/query`는 읽기 키로 호출할 수 있다. 브라우저의 같은 경로는 `/api/issues/query`다. `projectId`를 지정하고 `fieldFilter.match`에 `all` 또는 `any`와 1~8개 조건을 보낸다. 응답은 조건에 맞는 업무 배열이다.

```json
{
  "projectId": "project-id",
  "fieldFilter": {
    "match": "all",
    "rules": [
      {"fieldId": "risk-score", "operator": "gte", "value": 0},
      {"fieldId": "reviewed", "operator": "equals", "value": false}
    ]
  }
}
```

사용 중인 필드·선택지는 이름 변경과 보관 후에도 같은 ID로 조회할 수 있다. 필드나 선택지를 삭제하려면 이를 사용하는 공유 보기를 먼저 수정한다. 보기 저장·수정의 필터 객체에서 필드 그룹을 생략하거나 `null`로 보내면 해당 조건을 제거한다. 필드 그룹이 저장된 보기는 schema13 백업에서 복원한다. 조건 없이 저장한 기존 보기와 이전 백업도 계속 사용할 수 있다.

## 공유 보기의 계획·일정 조건

브라우저의 `POST /api/views`와 `PATCH /api/views/:id`는 `filters.planning`에 사이클·모듈·릴리스와 날짜 조건을 저장한다. 아래 조건은 릴리스의 업무 중 사이클에 배정되지 않았고 계획 기간이 지정한 날짜 범위와 겹치는 업무에 적용된다. 지정한 조건은 기존 업무 필터와 함께 모두 일치해야 한다.

```json
{
  "releaseId": "release-id",
  "cycleId": null,
  "dates": {"mode": "overlap", "from": "2026-11-20", "to": "2026-11-30"}
}
```

`cycleId`, `moduleId`, `releaseId`를 생략하면 해당 계획의 조건을 적용하지 않는다. `null`은 해당 종류의 계획에 연결되지 않은 업무를 뜻한다. ID는 같은 프로젝트의 같은 종류 계획을 가리킨다. 보관된 계획도 계속 사용할 수 있다. 계획을 삭제하려면 해당 ID를 사용하는 보기를 수정하거나 삭제해야 한다.

`dates.mode`가 `planned`이면 유효한 시작·종료일을 모두 가진 업무이고 `needs_dates`이면 날짜 확인이 필요한 업무다. `overlap`은 유효한 계획 기간이 지정 범위와 겹치는 업무를 조회하고 `due`는 목표 마감일을 조회한다. 두 범위 모드에는 YYYY-MM-DD 형식의 `from`·`to` 중 최소 하나를 보내고, 두 경계를 보낸 경우 `from`이 `to`보다 늦을 수 없다. 경계 날짜를 포함한다. 보기 수정 요청에서 `filters.planning`이 빠지면 저장된 계획 조건을 유지한다. 조건을 지우려면 빈 객체를 보낸다. 자체 백업 형식 47은 저장 조건과 계획 ID를 함께 복원한다.

## 사용자 정의 필드 집계

`POST /api/v1/projects/:id/field-breakdown`에 `fieldId`와 선택 항목인 `savedViewId`를 보낸다. 보기를 생략하거나 `null`을 보내면 전체 프로젝트를 집계한다. 보기를 지정하면 현재 저장된 검색어·상태·담당자·유형·필드 조건을 모두 적용한다. 두 조회 경로는 같은 프로젝트 범위의 읽기 키와 브라우저의 `/api` 경로에서 사용할 수 있다.

응답에는 조회 시각 `generatedAt`, 비교 기준 `revision`, 조건에 맞는 전체 업무 수와 적용·입력·미입력·유형 미적용 업무 수, 값별 `groups`가 포함된다. 숫자 0과 확인 여부 `false`는 각각 입력된 값이다. 다중 선택은 선택지마다 그 선택지를 가진 업무를 한 번 세므로 한 업무가 여러 그룹에 나타날 수 있다. 그룹 ID는 필드 ID와 저장 값에 기반한다. 숫자 필드의 `numeric`에는 값이 있을 때 `min`, `max`, `average`, `sum`이 포함된다. 합계가 유한한 JSON 숫자 범위를 넘으면 `sum`은 `null`이다. 한 번에 선택된 업무 10,000개까지 집계하며 초과 시 `413`을 반환한다.

`POST /api/v1/projects/:id/field-breakdown/issues`에 같은 `fieldId`, `savedViewId`와 응답의 `revision`, 그룹 `id`를 `bucketId`로 보낸다. 선택 항목인 `offset`은 기본값이 0이며 한 번에 최대 50개 업무의 `id`, `key`, `title`을 반환한다. 집계 자료가 바뀌어 `revision`이 달라지면 `409`를 반환한다. 그때는 집계를 다시 조회해 새 `revision`을 사용한다. 프로젝트에 없는 필드나 보기, 존재하지 않는 그룹의 응답은 `404`다.

## 문서 검토·발행

`GET /api/v1/documents/:id/publication`은 현재 검토 요청, 마지막 발행 정보, 각 문서 저장본의 ID·제목·버전, 현재 초안의 `documentVersion`, 검토 상태의 `version`, `workspaceGeneration`을 반환한다. 검토 이력이 없는 문서의 상태 `version`은 0이다. 복원 전 워크스페이스의 `workspaceGeneration`은 `null`일 수 있다.

`GET /api/v1/documents/:id/publication/snapshot?kind=review&revisionId=…`에는 상태 응답의 `reviewRevision.id`를 넣는다. 마지막 발행본은 `kind=published`와 `publishedRevision.id`를 사용한다. 응답은 요청 당시 저장된 `DocRevision`이다. 저장본이 없으면 `404`, 상태가 바뀌어 다른 저장본을 가리키면 `409`를 반환한다.

`POST /api/v1/documents/:id/publication`에는 최신 조회 결과의 `version`을 `expectedVersion`으로, `workspaceGeneration`을 반환된 값 그대로 보낸다. 쓰기 키의 소유자를 작업자로 사용하고 브라우저 경로에서는 현재 선택한 작업자를 사용한다.

| `action` | 필요한 값과 동작 |
| --- | --- |
| `request` | 열어 본 문서의 버전을 `expectedDocumentVersion`으로 보내고, 다른 팀원의 `reviewerId`를 지정한다. 선택 항목 `note`와 함께 현재 서버 저장본을 검토 대상으로 고정한다. |
| `publish` | 지정 검토자가 현재 검토본을 발행한다. 선택 항목 `note`를 발행본에 기록하고 검토 요청을 닫는다. |
| `request_changes` | 지정 검토자가 필수 `note`와 함께 수정을 요청한다. 저장본의 참조와 의견을 남긴다. 새 검토 요청을 시작할 수 있다. |
| `withdraw` | 요청자가 검토를 철회한다. 기존 발행본은 유지된다. |

메모는 최대 2,000자다. 버전·복원 세대 또는 요청 직전 문서 버전이 다르면 `409`로 응답한다. 다른 작업자에게만 허용된 동작은 `403`을 반환한다. 모든 경로는 해당 문서의 프로젝트 범위를 확인한다. 브라우저에서 사용하는 동일한 경로의 접두사는 `/api`다.

### 검토함·발행본 목록

브라우저의 `GET /api/document-publications`는 `tab`에 `assigned`(기본, 현재 작업자의 검토 대기), `requested`(현재 작업자가 보낸 대기·수정 요청), `published`(문서별 마지막 발행본)를 받는다. `scope`는 `workspace`(기본), `project`, `common`이다. `project` 범위에서는 `projectId`가 필요하다. `q`는 최대 200자의 선택 검색어다. 저장본 제목과 검색어를 유니코드 NFC로 정규화하고 소문자로 바꿔 부분 일치를 비교한다.

`offset`은 기본 0이며 한 페이지에 최대 30개를 반환한다. `total`은 현재 조건의 일치 수이고 `pendingAssigned`는 범위·탭·검색 조건과 독립적인 전체 배정 대기 건수다. 각 행은 문서·프로젝트·저장본 ID와 버전·고정 제목, 상태, 요청자·검토자, 상태 시각을 포함한다. 최신 상태 시각순으로 정렬하며 같은 시각은 문서 ID 순이다. 본문과 메모는 문서별 검토·발행 경로에서 조회한다.

`GET /api/document-publications/count`는 현재 작업자의 전체 `pendingAssigned`만 반환한다. 목록과 건수는 브라우저 경로에서 제공한다. 자동화 키는 문서별 `/api/v1/documents/:id/publication` 경로를 사용한다.

## 알림 구독

브라우저의 `GET /api/notifications/subscriptions/:targetType/:targetId`는 `X-Actor-Id`로 선택한 작업자의 `{ "subscribed": true }` 또는 `{ "subscribed": false }`를 반환한다. 같은 경로의 `PUT`에 `subscribed` 불리언을 보내 구독 상태를 지정한다.

| `targetType` | `targetId` | 알림 대상 |
| --- | --- | --- |
| `issue` | 업무 ID | 해당 업무의 상태 변경과 댓글 |
| `document` | 문서 ID | 해당 문서의 저장·버전 복구·발행·댓글 |
| `project` | 프로젝트 ID | 해당 프로젝트의 새 업무·상태 변경·댓글 |
| `space` | `project:<프로젝트 ID>` 또는 `common` | 지정 문서 공간의 새 문서·저장·버전 복구·발행·댓글 |

`targetId`는 URL 경로 한 구간으로 인코딩한다. 공동 편집의 저장 알림은 버전 기록을 만들 때 발송한다. 개별 구독과 프로젝트·공간 구독이 겹치면 같은 변경에 알림 한 건을 저장한다. 자체 백업 형식 29는 범위 구독과 `issue-created`·`document-created`를 보존한다.

## 팀원 시간 배정

시간 배정 경로는 브라우저용 `/api`에서 제공한다. 시작·종료는 `2026-11-20T00:30:00.000Z`처럼 분 단위 UTC 시각이다. 배정 기간은 최대 24시간이다. 시작은 포함하고 종료는 제외한다. 같은 팀원의 다른 프로젝트 배정과 겹치면 `409`로 응답한다.

| 경로 | 요청과 응답 |
| --- | --- |
| `GET /api/time-reservations` | 쿼리 `startAt`, `endAt`과 선택 항목 `userId`. 최대 31일에 걸친 확정 배정을 읽는다. 결과가 10,000건을 넘으면 기간이나 팀원을 좁히도록 `422`로 응답한다. |
| `GET /api/issues/:issueId/time-reservations` | 해당 업무의 확정·재검토 배정 목록을 읽는다. |
| `POST /api/issues/:issueId/time-reservations` | `userId`, `startAt`, `endAt`, UUID `requestId`를 보낸다. 첫 저장은 `201`, 같은 내용으로 재시도하면 `200`과 기존 배정을 반환한다. |
| `PATCH /api/issues/:issueId/time-reservations/:id` | `userId`, `startAt`, `endAt`, `expectedVersion`을 보낸다. 시간을 확보하면 배정을 확정한다. |
| `DELETE /api/issues/:issueId/time-reservations/:id` | 쿼리 `expectedVersion`으로 배정을 취소한다. |

배정 상태는 `reserved` 또는 `needs-review`다. 휴지통 복원 중 이미 다른 업무에 예약된 시간은 `needs-review`로 보존한다. 편집 버전이 오래되면 `409`로 응답한다. 자체 백업 형식 30부터 `timeReservations`가 포함된다.

## 개별 댓글·첨부 휴지통

브라우저의 `DELETE /api/comments/:id`는 선택한 작업자가 작성한 댓글을 휴지통으로 옮긴다. `DELETE /api/attachments/:id`는 첨부와 모든 버전을 함께 옮긴다. 파일 목록의 `currentVersionId`를 `expectedVersionId` 쿼리로 보내면, 이후 새 버전이 올라간 경우 `409`로 응답한다. 성공 시 두 경로는 `ok`와 `trashItemId`를 반환한다.

`GET /api/trash/items`로 개별 휴지통을 읽는다. `itemType`에는 `comment` 또는 `attachment`, `scope`에는 `all`·`project`·`common`을 사용할 수 있다. `scope=project`에는 `projectId`가 필요하다. `offset` 기본값은 0, `limit`은 50이며 최대 100이다. 항목에는 원래 업무·문서 ID와 `ownerAvailable`, 파일 버전 수가 표시된다.

`POST /api/trash/items/:id/restore`는 원래 ID로 복원하고 항목 요약을 반환한다. 원래 업무·문서가 휴지통에 있으면 `409`, 첨부 바이트 무결성 확인에 실패하면 `503`으로 응답한다. `DELETE /api/trash/items/:id`는 해당 댓글이나 첨부와 모든 버전을 영구 삭제한다. 자체 백업 형식 31에는 `trashItems`와 보관 중인 첨부 바이트가 포함된다.

## 팀 개요

브라우저의 `GET /api/team-overview`는 선택 항목 `projectId`, `memberId`, `date`를 받는다. `date` 기본값은 서울의 오늘 날짜다. 프로젝트를 선택하면 해당 프로젝트만 조회하며, 전체 프로젝트 범위에서는 팀 공통 문서의 검토도 포함한다.

`totals`와 `projects`는 프로젝트 워크플로에서 열린 업무의 마감 초과·오늘부터 7일 이내·일정 미정·미배정 수를 반환한다. `deadlines`에는 목표 마감일이나 계획 종료일이 해당하는 업무가 표시된다. `reviews`는 현재 검토 대기의 고정 저장본 메타데이터, `gitlab`은 기준일을 포함한 최근 7일의 저장된 티켓 연결, `reservations`는 기준일과 겹치는 확정 시간 배정이다. 한 요청에서 같은 저장 시점의 상태를 읽는다.

`memberId`는 업무와 GitLab에서 담당자 또는 협력자, 검토에서는 검토자, 시간 배정에서는 배정된 팀원과 대조한다. 각 목록은 `total`, `offset`, `limit`, `items`를 포함한다. `deadlineOffset`, `reviewOffset`, `gitlabOffset`, `reservationOffset`은 각각 기본값 0, 한 번에 10건을 반환한다.
