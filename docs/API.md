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
| `GET /projects/:id/issue-templates` | 프로젝트의 활성 업무 템플릿과 적용할 버전 조회 |
| `GET /issue-key-matches?key=...` | 현재 키·Jira 원래 키·프로젝트 이동 전 키의 정확한 후보 조회 |
| `GET /projects/:id/recurring-issues` · `POST /projects/:id/recurring-issues` · `PATCH /projects/:id/recurring-issues/:ruleId` | 주간 반복 업무 조회·등록·편집 |
| `GET /projects/:id/issue-order` · `PATCH /projects/:id/issue-order` | 프로젝트 업무 순서 조회, 이웃 티켓 기준 이동과 선택적 상태 전이 |
| `GET /projects/:id/dependencies` | 같은 프로젝트에 있는 선행·후행 업무의 연결 ID·방향·유형·간격·버전 조회 |
| `GET /projects/:id/schedule-analysis` | 현재 근무일 계획의 예상 완료일·업무별 여유·중요 연결·제외 목록 조회 |
| `GET /projects/:id/delivery-blockers` | 미해결 업무 차단·간트 충돌·GitLab 조치, 릴리스 일정 위험과 페이지 조회 |
| `GET /projects/:id/report` · `GET /projects/:id/report-snapshots` · `GET /projects/:id/report-snapshots/:snapshotId` | 기간별 업무 집계 조회와 저장된 보고서 목록·상세 |
| `POST /projects/:id/report-snapshots` | 기간별 보고서 보관본과 연결된 주간 문서 초안 생성. UUID v4 요청 ID로 재시도 |
| `GET /decision-follow-ups` · `GET /projects/:id/decision-follow-ups` · `GET /projects/:id/decision-follow-ups/:linkId/source` | 팀·프로젝트 결정 후속 업무, 접근 가능한 문서의 저장 발췌 조회 |
| `GET /projects/:id/workload` · `GET /projects/:id/workload-capacity` | 조회 기간의 담당자별 계획 시간·가용 시간·초과 및 프로젝트 설정 |
| `POST /projects/:id/field-breakdown` · `POST /projects/:id/field-breakdown/issues` | 기본·사용자 정의 필드의 현재 값별 집계, 두 기준의 교차 집계와 해당 업무 조회 |
| `GET /users` | 요청자·담당자 지정에 필요한 팀원 ID·이름·색상 |
| `GET /planning-items?projectId=...&kind=cycle` | 프로젝트별 사이클·모듈·릴리스 조회 |
| `GET /planning-items/:id` | 계획 항목 조회 |
| `POST /planning-items/:id/complete/preview` · `POST /planning-items/:id/complete` | 진행 중 사이클 완료와 미완료 업무 이월 검토·적용 |
| `GET /issues?projectId=...&reporterId=...` · `GET /issues/:id` | 업무 조회, 선택적인 프로젝트·요청자 조건 |
| `GET /issues/:id/change-history` | 티켓의 필드 변경 전후 값과 당시 표시 이름 조회 |
| `GET`·`POST /issues/:id/relations` · `PATCH`·`DELETE /issues/:id/relations/:relationId` | 양쪽이 키 범위에 있는 업무 관계 조회와 직접 만든 관계의 추가·수정·해제 |
| `GET /issues/:id/resource-links` · `GET /documents/:id/resource-links` | 업무와 문서의 직접 연결 조회 |
| `POST /resource-links` · `DELETE /resource-links/:id` | 업무와 문서의 직접 연결 추가·일반 연결 해제 |
| `POST /dependencies` · `PATCH`·`DELETE /dependencies/:id` | 선후행 연결 추가·유형·간격·방향 변경과 해제 |
| `POST /issues/:id/relations/:relationId/schedule-dependency` | 기존 차단 관계에서 선후행 연결 추가 |
| `GET /issues/:id/gitlab-links` | 프로젝트 범위 안 업무의 브랜치·커밋·MR·파이프라인 조회 |
| `GET /issues/:id/gitlab-deployments` | 프로젝트 범위 안 업무의 연결된 GitLab 배포 조회 |
| `GET /documents?projectId=...` · `GET /documents/:id` | 문서 조회 |
| `GET /documents/:id/revisions` | 문서 버전 조회 |
| `POST /documents/:id/follow-up-issues` · `POST /documents/:id/decision-links` | 문서에서 후속 업무 생성, 기존 업무에 고정한 결정 근거 추가 |
| `GET /documents/:id/publication` · `GET /documents/:id/publication/snapshot` | 현재 검토·발행 상태와 고정 저장본 조회 |
| `GET /comments?resourceType=issue&resourceId=...` | 업무 또는 문서 댓글 조회 |
| `GET /comments/:id/edit` · `PATCH /comments/:id` | 작성자가 현재 댓글을 확인하고 수정 |
| `GET /attachments?resourceType=issue&resourceId=...` · `GET /attachments/:id/versions` | 업무·문서의 첨부 목록, 각 첨부의 버전 이력 |
| `GET /attachments/:id/content` · `GET /attachment-versions/:id/download` | 지정된 파일 버전의 바이너리 |
| `POST /issues` · `PATCH /issues/:id` · `DELETE /issues/:id` | 업무 생성·수정·휴지통 이동 |
| `POST /issues/:id/clone` | 같은 프로젝트에 업무 복제와 원본 관련 관계 저장 |
| `POST /issues/:id/blocked-issues` | 다른 프로젝트에 새 업무를 만들고 원인 업무의 차단 관계를 같은 요청으로 저장 |
| `GET /projects/:id/calendar` | 허용된 프로젝트의 근무일·예외 날짜와 달력 버전 조회 |
| `POST /documents` · `PATCH /documents/:id` · `DELETE /documents/:id` | 문서 생성·수정·휴지통 이동 |
| `POST /documents/:id/publication` | 검토 요청·승인·발행·수정 요청·철회 |
| `POST /comments` | 업무 또는 문서 댓글 작성 |
| `POST /attachments` · `POST /attachments/:id/versions` | 첨부 생성 또는 새 버전 업로드 |
| `PATCH /projects/:id/workload-capacity` | 프로젝트·팀원·날짜별 가용 시간 변경 |

표의 경로 앞에는 `/api/v1`이 붙는다. 읽기 키는 조회만 허용하며 쓰기 키는 조회와 표의 변경 요청을 허용한다. 프로젝트 범위는 조회·원래 대상·이동 대상·상위 항목·계획 참조에 적용한다. 공통 문서는 전체 프로젝트 키로 접근한다.

백업·가져오기·연동 설정·키 관리·팀 알림함·휴지통 관리·공동 편집 소켓 등 표에 없는 경로는 자동화 API에서 허용하지 않는다. 계획 항목은 관리 화면에서 생성한다. 자동화 API로 계획을 조회하고 티켓에 연결하며 이월과 함께 사이클을 완료할 수 있다.

업무와 문서의 `DELETE`는 휴지통으로 이동하며 응답의 `trashEntryId`는 해당 이동을 식별한다. 복원과 영구 삭제는 워크스페이스의 **휴지통**에서 처리한다. 연결된 외부 웹훅에서는 휴지통 이동이 기존 `*.deleted`, 복원이 `*.created`와 `origin: "restore"`로 전달된다.

## 현재·이전 티켓 키 조회

`GET /api/v1/issue-key-matches?key=OLD-123`은 현재 키 또는 이전 키가 정확히 일치하는 활성 티켓을 `{issue,matchedAliases}` 배열로 반환한다. 대소문자와 전각 영숫자를 정규화한다. 현재 키가 맞는 티켓이 먼저 나오고, 같은 번호를 사용한 나머지 티켓도 배열에 각각 포함된다. 한 티켓은 한 번만 나오며 `matchedAliases` 항목은 `{key,source}` 형식이다. `source` 값은 Jira 원래 키의 `jira` 또는 Teamspace 프로젝트 이동 전 키의 `move`다.

`projectId`를 보내면 티켓의 현재 소속 프로젝트로 좁힌다. 읽기·쓰기 키 모두 키에 허용된 현재 프로젝트만 조회한다. 조건에 맞는 티켓이 없으면 빈 배열을 반환한다. 브라우저는 같은 계약의 `/api/issue-key-matches`를 사용한다.

## GitLab 참조로 티켓 찾기

브라우저용 `GET /api/search?q=…`는 `{issues,documents}`를 반환한다. `q`에 저장된 MR·활성 브랜치·커밋·파이프라인의 주소, `group/repo!91` 형식의 MR, 정확한 브랜치 이름·`refs/heads/…` 또는 전체 커밋 SHA를 넣으면 이미 연결된 활성 티켓을 찾는다. 브랜치 이름은 활성 브랜치의 링크나 다른 GitLab 활동에 기록된 이름과 대조한다. URL은 스킴·호스트·포트·설치 경로를 포함한 저장소 경로와 활동을 대조하며, URL의 사용자 정보·쿼리·프래그먼트를 무시한다. MR 약식 표기는 설치 경로가 있으면 포함한 저장소 전체 경로를 사용한다. 브랜치 이름과 저장소 경로는 대소문자를 구분한다.

빠른 검색과 전체 검색에서는 결과에 일치한 GitLab 서버·저장소·참조를 함께 표시하고 전체 검색의 공간 조건은 현재 티켓 프로젝트에 적용한다. 같은 참조에 연결된 티켓은 각각 확인할 수 있다. 텍스트 조회와 현재·이전 티켓 키 우선순위도 지원한다. 검색은 저장된 링크를 사용하며 GitLab에 요청하지 않는다.

## 원본 주소로 업무와 문서 찾기

브라우저의 `GET /api/atlassian-links/resolve?url=…`은 원본 주소 한 개를 받아 `{targets: [{targetType, targetId}]}`를 반환한다. 붙여넣은 주소는 클라이언트에서 정규화한다. Confluence Server·Data Center의 표준 짧은 주소 `/x/…`은 같은 서버와 설치 경로의 `viewpage.action?pageId=…` 주소로 변환한다. `viewpage.action`은 검색에 필요한 `pageId`를 유지하며 추적 쿼리·프래그먼트를 검색 주소에서 제거한다. 짧은 주소에 `pageId`가 함께 있으면 디코딩한 ID 하나와 일치해야 한다. 지원 형식에 맞지 않는 요청은 `400`을 반환한다.

같은 스킴·호스트·포트·설치 경로의 Jira 업무 키 또는 Confluence 페이지 ID를 저장된 링크에서 찾는다. `/display/…` 주소는 직접 저장한 제목 링크와, 같은 원본 패키지에서 제목·공간을 확인한 이관 문서를 찾는다. 이관 문서는 영수증의 서버·설치 경로, 보관된 문서와 원본의 연결, 현재 저장된 숫자 페이지 ID 링크를 함께 대조한다. 활성 업무·문서를 한 번씩 반환하며 같은 주소에 연결된 별도 대상은 각각 반환한다. 원본 서버에 접속하지 않는다. `GET /api/search?q=…`에 유효한 원본 주소를 보내면 같은 대상을 기존 `{issues, documents}` 형식으로 반환한다.

Confluence 댓글 주소에는 `focusedCommentId` 또는 `#comment-<원본 댓글 ID>`가 들어간다. 둘을 함께 쓰면 번호가 일치해야 한다. 검색용 주소는 원본 댓글 번호를 `focusedCommentId`에 보존한다. 해당 설치의 이관 영수증·페이지 연결·댓글 기록을 확인하고 활성 문서의 댓글을 하나로 찾으면 `targets`에 `{targetType:'document',targetId,commentId}`를 반환한다. `commentId`는 Teamspace 댓글 ID다. 잘못된 선택자는 `400`, 문서나 댓글의 소유 관계가 불명확하거나 대상이 휴지통에 있으면 빈 `targets`가 반환된다. `GET /api/search`는 정확한 댓글이 있을 때 문서 ID와 댓글 ID를 연결하는 `documentCommentIds`도 반환한다.

## 티켓 사이의 업무 관계

`GET /api/issues/:id/relations`는 현재 티켓이 양쪽 중 하나인 `IssueRelationView[]`을 반환한다. `POST`로 `{otherIssueId,type,direction}`을 보낸다. `type`은 `related`, `blocks`, `duplicates`다. `direction`이 `outgoing`이면 URL의 티켓이 차단하는 쪽 또는 중복 티켓이며, `incoming`이면 상대 티켓이 그 역할이다. `related`는 두 티켓을 ID 순서로 저장한다. 같은 관계를 다시 보내면 이미 저장된 행과 `200`을 반환하고, 새 연결은 `201`을 반환한다.

직접 만든 관계에는 `origin: "teamspace"`가 있다. `PATCH /api/issues/:id/relations/:relationId`에 `{expectedVersion,type,direction}`을 보내 유형과 방향을 변경한다. `DELETE`는 같은 경로의 `?expectedVersion=…`을 사용한다. 버전이 바뀌면 `409`로 최신 버전을 알려준다. 이관한 관계는 원래 이름을 반환하며 읽기 전용이다. 관계 자체와 양쪽 활동 이력은 함께 저장한다. 자체 백업 형식 51은 직접 만든 관계를 보존하고 복원 시 버전을 높인다.

`/api/v1`의 동일한 경로에서 양쪽 프로젝트가 키의 허용 범위에 있어야 한다. 조회에는 읽기 키를 사용할 수 있으며, 관계 추가·수정·해제에는 쓰기 키가 필요하다.

Jira 이관 원본에서 양쪽 업무와 방향을 확인하면 응답에 `verifiedBlockerDirection`을 포함한다. 값은 요청한 티켓 기준 `incoming` 또는 `outgoing`이다. 이관한 관계의 `sourceIssueId`, `targetIssueId`, `type`은 원래 저장값을 반환한다. 같은 방향의 직접 만든 차단 관계가 있으면 그 관계를 우선하며, Jira 관계는 원래 이름으로 계속 조회할 수 있다.

### 중복 업무 종료

`POST /api/issues/:id/close-as-duplicate`에 `{originalIssueId,status,expectedVersion,expectedOriginalVersion,expectedWorkflowVersion}`을 보낸다. `id`는 열린 중복 업무이며 원본 업무는 다른 프로젝트에도 있을 수 있다. `status`에는 현재 업무 유형의 워크플로에서 허용하는 `done` 또는 `cancelled` 범주의 상태 ID를 넣는다. 기존 상태 전이의 필수 입력, 열린 차단 업무, 자동 담당자와 목표 마감일 규칙을 적용한다.

성공 시 `200`과 `{issue,relation}`을 반환한다. 중복 업무에서 원본 업무 방향으로 관계를 저장하며 같은 Teamspace 관계를 재사용한다. 두 업무와 워크플로 버전이 일치해야 한다. 직접 만든 중복 관계에 다른 원본이 이미 지정됐거나 새 연결이 순환을 만들면 `409`를 반환한다. 상태·관계·변경 이력은 함께 저장한다. 응답을 잃은 경우 최신 업무와 관계를 조회해 적용 결과를 확인한다. `/api/v1`에는 두 업무의 프로젝트를 허용하는 쓰기 키를 사용한다.

## 업무와 문서의 직접 연결

`GET /api/v1/issues/:id/resource-links`와 `GET /api/v1/documents/:id/resource-links`는 `id`, `issueId`, `documentId`, `kind`가 포함된 배열을 반환한다. 활성 상태의 업무와 문서가 모두 키의 프로젝트 범위에 있어야 목록에 표시된다. 팀 공통 문서는 전체 프로젝트 키를 사용한다.

`POST /api/v1/resource-links`에 `{issueId,documentId,kind?}`를 보낸다. `kind`의 기본값은 `관련 문서`이며 최대 80자다. 새 연결은 `201`을 반환한다. 같은 업무와 문서의 연결이 이미 있으면 기존 종류와 연결 ID를 유지하고 `200`을 반환한다. 응답을 받지 못한 경우 같은 대상을 다시 보내 결과를 확인할 수 있다. 브라우저의 `POST /api/resource-links`도 같은 생성 규칙을 사용한다.

`DELETE /api/v1/resource-links/:id`는 양쪽 대상에 접근할 수 있는 쓰기 키를 사용하며 성공하면 `{ok: true}`를 반환한다. 결정 근거가 붙은 연결의 해제를 요청하면 `409`를 반환한다. 해당 근거는 티켓 화면에서 원문과 함께 확인할 수 있다.

브라우저의 `DELETE /api/resource-links/:id`는 일반 연결을 해제할 때 쿼리를 생략한다. 결정 근거를 확인하고 해제할 때는 당시의 `expectedDecisionRevisionId`, `expectedDecisionFrom`, `expectedDecisionTo`를 보낸다. 서버는 현재 근거가 요청한 저장본과 발췌 범위에 일치할 때 연결 해제와 업무 이력을 함께 저장한다. 근거가 새로 붙거나 변경된 경우 `409`와 `details.reason: "decision_source_changed"`를 반환한다.

## 팀 간트의 프로젝트 간 차단

브라우저의 `GET /api/schedule/team-blockers`는 서로 다른 프로젝트의 현재 두 업무를 잇는 차단 관계를 조회한다. 응답 항목은 `{id, sourceIssueId, targetIssueId, version}`이며 원인에서 차단 대상 방향이다. 원본 방향과 양쪽 업무 연결이 확인된 Jira 차단 관계에는 `origin: 'jira'`가 추가된다. 같은 방향의 Teamspace 차단이 있으면 그 항목을 반환한다. 화면은 두 업무의 현재 워크플로로 진행 중인 차단을 표시한다. 방향 수정과 해제에는 기존 업무 관계 경로를 사용한다. [티켓 사이의 업무 관계](#티켓-사이의-업무-관계)

`POST /api/schedule/team-blockers`에 `{sourceIssueId, targetIssueId, expectedSourceVersion, expectedTargetVersion}`을 보낸다. 현재 서로 다른 프로젝트에 속한 열린 업무를 확인하고, 두 저장 버전이 일치하면 `blocks` 관계와 활동 이력을 함께 저장해 `201`을 반환한다. 유효한 같은 방향의 Teamspace 관계가 이미 있으면 그 관계를 `200`으로 반환한다. 업무가 사라지면 `404`, 현재 프로젝트·상태 또는 버전이 조건에 맞지 않으면 `409`를 반환한다. 버전 충돌에는 `source_version_changed` 또는 `target_version_changed`와 `currentVersion`을 표시한다.

### 다른 프로젝트에 새 차단 대상 업무 만들기

`POST /api/issues/:id/blocked-issues`에 `{requestId, expectedSourceVersion, expectedTargetCalendarVersion, issue}`를 보낸다. `:id`는 차단하는 기존 업무 ID다. `issue`에는 다른 프로젝트의 `projectId`와 일반 업무 생성 필드를 넣는다. 원인 업무와 대상 프로젝트 달력의 확인한 버전을 보내야 한다. 최신 원인 업무나 달력이 달라진 `409`는 `source_version_changed` 또는 `calendar_changed`와 `currentVersion`을 반환한다. 원인 업무가 없으면 `404`와 `source_missing`을 반환한다.

처음에는 `201`과 `{issue, relation, duplicate: false}`를 돌려준다. 새 업무와 원인에서 새 업무를 향하는 `blocks` 관계, 변경 기록과 알림을 같은 트랜잭션에 저장한다. 같은 작업자가 같은 UUIDv4·주소·입력으로 재요청하면 `200`과 기존 업무를 돌려준다. 관계가 해제됐으면 `relation`은 `null`이며 재요청으로 관계를 다시 만들지 않는다. `/api/v1`의 쓰기 키는 원인과 새 업무가 속한 프로젝트 및 입력 참조에 접근할 수 있어야 한다. 대상 달력은 같은 범위의 `GET /api/v1/projects/:id/calendar`에서 읽을 수 있다.

## 저장된 간트 데이터 갱신

브라우저의 `GET /api/workspace`는 `X-Teamspace-Gantt-Revision` 헤더를 보낸다. 마지막으로 받은 32자리 16진수 값을 `?ganttSince=…`에 보내면 같은 버전은 빈 본문의 `204`, 다른 버전은 `200`과 최신 워크스페이스다. 업무·선후행, 프로젝트 달력·계획·저장 보기·마일스톤·기준선, 작업량 설정, 프로젝트 간 차단 관계와 시간 예약이 저장될 때 간트 버전이 바뀐다. 간트 전용 설정은 팀 보드 버전을 유지한다. 한 요청에는 `teamBoardSince`와 `ganttSince` 중 하나를 사용한다.

워크스페이스 본문의 `teamScheduleBlockers`는 같은 저장 시점의 프로젝트 간 차단 목록이다. 간트는 행과 차트 변경 미리보기에서 현재 열린 후행 업무를 찾는 데 사용한다. 워크스페이스 복원 뒤 저장된 관계에서 목록을 다시 계산한다.

## 선후행 업무 연결

`GET /api/v1/projects/:id/dependencies`는 프로젝트에 두 업무가 모두 있는 연결을 `Dependency[]`로 반환한다. 각 항목에는 `id`, `predecessorId`, `successorId`, `type`, `lagDays`, `version`이 있다. 읽기 키로 조회하고 쓰기 키로 변경한다. 변경할 두 업무와 차단 관계의 두 업무는 모두 키의 허용 범위에 있어야 한다. 아래 브라우저 경로의 `/api`를 `/api/v1`으로 바꿔 자동화 키를 사용한다.

`POST /api/dependencies`로 `{predecessorId,successorId,type?,lagDays?}`를 보낸다. 관계는 `FS`, `SS`, `FF`, `SF`를 지원하고 기본값은 `FS`와 `0`이다. `lagDays`는 −3,650~3,650 사이의 정수 근무일이다. 같은 프로젝트 안에서 방향별 업무 쌍은 한 번만 연결할 수 있으며 순환 관계는 거절한다.

기존 차단 관계에서 연결할 때는 `POST /api/issues/:issueId/relations/:relationId/schedule-dependency`에 `{expectedVersion,predecessorId,successorId,type,lagDays}`를 보낸다. `expectedVersion`은 조회한 업무 관계의 버전이다. 관계에 속한 두 업무가 같은 프로젝트에 있어야 한다. 직접 만든 `blocks` 관계는 차단하는 업무를 선행으로 사용하며, 이관된 `Blocks`, `Is Blocked By`, `Blocked By`는 요청에서 방향을 선택한다. 원래 관계와 업무 날짜를 보존한 채 일정 연결을 추가한다. 새 연결이면 `201`, 같은 방향·유형·간격이 이미 저장돼 있으면 같은 연결과 `200`을 반환한다.

`PATCH /api/dependencies/:id`로 `{expectedVersion,type?,lagDays?,reverse?}`를 보내 연결 유형과 간격을 바꾼다. `reverse: true`는 같은 연결 ID에서 선행 업무와 후행 업무를 서로 바꾼다. 반대 방향이 순환을 만들면 변경을 거절한다. 기존 자료에서 `version`이 생략된 경우 버전 1을 사용한다. `DELETE /api/dependencies/:id?expectedVersion=...`로 조회 당시 버전을 검사하고 연결을 해제할 수 있다. `/api/v1`의 해제 요청에는 이 쿼리 값이 필요하다. 현재 버전이 바뀌면 `409`와 최신 버전을 반환한다. 연결의 변경은 업무 날짜를 유지하며, 날짜를 변경하는 자동 일정은 별도 미리보기와 적용을 사용한다.

### 새 선행·후행 업무 만들기

브라우저의 `POST /api/issues/:id/schedule-predecessors`에 `{requestId,expectedSuccessorVersion,expectedCalendarVersion,type,lagDays,issue}`를 보낸다. 주소의 티켓 ID는 기존 후행 업무다. `issue`에는 제목·유형·상태·담당자·일정 등 일반 업무 양식의 값을 넣는다. `projectId`를 보내면 후행 업무와 같은 프로젝트여야 한다. 네 연결 유형과 −3,650~3,650 정수 근무일 간격을 지원한다. 기존 선행 업무를 기준으로 새 후행 업무를 만들 때는 `POST /api/issues/:id/schedule-successors`와 `expectedPredecessorVersion`을 사용한다.

새 티켓의 번호·양식·날짜·이력·알림과 연결을 같은 트랜잭션에서 저장한다. 주소에 지정한 티켓의 날짜나 버전은 유지한다. 후행 업무가 없어졌으면 `404`의 `details.reason`은 `successor_missing`이다. 후행 업무나 달력이 달라진 `409`는 `successor_changed` 또는 `calendar_changed`와 `currentVersion`을 반환한다. 이후 최신 값에서 새 요청을 검토한다.

최초 `201`은 새 `Issue`를 반환한다. 같은 작업자가 같은 UUIDv4·주소·입력으로 재시도하면 `200`으로 이미 만든 업무를 읽는다. 재시도는 나중에 편집하거나 해제한 연결에 새 쓰기를 수행하지 않는다. 물리 백업에는 요청 기록과 연결을 보존한다. [간트의 새 선행 업무](SCHEDULING.md#새-선행-업무-만들기)

## 일정 여유 분석

`GET /projects/:id/schedule-analysis`는 프로젝트의 저장된 업무·근무 달력·선후행 연결을 읽는다. `projectedFinish`는 계산 가능한 진행 업무의 예상 완료일이며, `tasks`는 업무별 가장 이른 시작·종료, 가장 늦은 시작·종료, `slackDays`와 `critical`을 포함한다. `criticalDependencyIds`는 여유 0일 업무 사이에서 완료일에 영향을 주는 연결이다.

`excluded`에는 제외된 이유가 담기며, 분석 범위가 일부이면 `partial`이 `true`다. 계산할 수 있는 진행 업무가 없으면 `projectedFinish`는 `null`이다. 완료·취소 업무는 각각 `completedCount`와 `cancelledCount`에 표시한다. 요청당 프로젝트 업무 10,000개와 연결 50,000개까지 조회한다. 날짜를 바꾸려면 별도 일정 변경 API를 사용한다. [일정·간트 사용법](SCHEDULING.md)

## 진행 차단 보고서

`GET /projects/:id/delivery-blockers`에 `savedViewId`나 `releaseId`를 보내면 조건이 모두 맞는 미완료 업무를 집계한다. 둘 다 생략하면 프로젝트 전체에 적용한다. `reason`을 생략하면 모든 원인을 표시하며 `issue_block`·`schedule_conflict`·`gitlab`으로 좁힐 수 있다. `counts.open`은 선택 범위의 미완료 업무 수, `counts.affected`는 원인이 있는 업무의 중복 없는 합계다. `counts.reasons`는 원인별 업무 수이며 한 업무가 여러 원인에 포함될 수 있다. `total`은 선택한 원인의 업무 수다.

`releaseId`에는 같은 프로젝트의 릴리스 ID를 지정한다. 보관한 릴리스도 조회할 수 있다. 선택한 릴리스의 목표일을 `release.deadline`으로 쓰고, 목표일이 비어 있으면 릴리스 종료일을 사용한다. `deadlineSource`는 `targetDate`, `endDate`, `null` 중 하나다. `missing_schedule`은 시작일이나 종료일이 미정인 업무다. `after_release_date`는 업무 종료일이 릴리스 기준일 뒤인 경우다. 종료일이 같은 날이면 포함하지 않으며 기준일이 비어 있으면 초과를 집계하지 않는다. 릴리스 ID와 함께 두 원인으로 필터를 적용할 수 있다. 해당 업무의 `releaseSchedule`에 실제 `startDate`, `endDate`와 `missing`, `afterDeadline`을 반환한다. 연결된 차단 원인 업무는 릴리스 범위 밖에 있어도 키가 허용하는 경우 표시한다.

응답의 `limit`은 20이다. 다음 페이지에는 `offset`과 이전 응답의 `revision`을 보낸다. 그동안 결과가 바뀌어 `409`를 받으면 `offset`과 `revision`을 생략하고 첫 페이지부터 읽는다. 프로젝트 제한 키는 양쪽 프로젝트를 읽을 수 있는 업무 관계만 보고서의 건수와 근거에 포함한다. GitLab 근거는 이미 저장된 상태를 사용한다.

`issue_block`은 직접 만든 차단 관계와 이관 원본으로 방향 및 연결 대상을 확인한 Jira 관계를 집계한다. 같은 방향의 같은 두 업무는 직접 만든 관계를 우선해 한 번 센다. 이관 관계가 집계 근거인 경우 해당 `blockers.items` 항목에 `origin: "jira"`가 포함된다.

`gitlab` 원인은 각 업무의 `gitlab.blockedMergeRequests`, `gitlab.failedPipelines`, `gitlab.manualPipelines` 중 하나 이상이 양수일 때 한 번 집계한다. `manualPipelines`는 업무 보드와 같은 기준으로 확인한 최신 파이프라인 중 상태가 `manual`인 건수다. 식별할 수 있는 파이프라인은 GitLab 인스턴스·저장소·참조·실행 유형·태그 구분이 같은 실행끼리 묶는다. 같은 그룹에서 실행이 시작되거나 새 파이프라인이 성공하면 이전 대기 건수는 빠진다. 진행 차단과 릴리스 준비 점검의 회의 초안에는 조회 당시 건수를 기록한다.

브라우저의 `POST /api/projects/:id/delivery-blockers/meeting-draft`는 `requestId`, `revision`, 1~200자의 `title`과 선택한 `savedViewId`·`releaseId`·`reason`을 받는다. 같은 조건의 처음 20개 업무와 집계를 문서 초안으로 생성한다. 릴리스 범위에서는 기준일과 일정 근거를 함께 기록하고 문서 링크로 같은 릴리스의 현재 보고서를 연다. 검토한 릴리스·연결 업무·결과가 바뀌면 `409`의 `details.reason`이 `stale_report`로 표시된다. 저장 응답을 받지 못하면 같은 요청 ID와 입력을 보내 `{document, duplicate}`로 확인한다.

## 담당자 작업량

업무 생성·수정의 `plannedEffortMinutes`에는 0~1,000,000 정수 분 또는 `null`을 보낸다. 포인트 필드 `estimate`와 별도이다. `GET /projects/:id/workload?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`로 최대 180일을 양끝 날짜 포함으로 조회한다. 응답의 `rows`에는 팀원별 일자와 `scheduledMinutes`, `availableMinutes`, 업무별 `allocations`가 있다. `incomplete`에는 배분에 필요한 정보가 부족한 업무와 이유를 반환한다.

`GET /projects/:id/workload-capacity`의 `version`을 `expectedVersion`으로 보내고 `defaultDailyMinutes`, `members` 또는 `exceptions`를 지정해 변경한다. `members`는 `{userId,dailyMinutes}`, `exceptions`는 `{userId,date,availableMinutes}` 배열이다. 배열을 보낼 때 해당 목록을 교체하며 빈 배열로 초기화할 수 있다. 가용 시간 허용 범위는 0~1,440분이다. 이전 버전으로 저장하면 `409`를 반환한다.

브라우저의 `GET /api/workload?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`로 프로젝트 간 작업량을 조회한다. 조회할 프로젝트를 고를 때는 `projectId`를 프로젝트마다 한 번 보낸다. 생략하면 전체를 조회한다. 양끝 날짜를 포함해 최대 180일·100개 프로젝트·10,000개 대상 업무를 조회한다. 요청 한도에는 팀원과 날짜 조합 36,000개, 날짜별 업무 배분 100,000개도 적용된다. 응답의 `capacityVersion`은 사용한 팀 가용 시간의 버전이다. 배분과 입력 확인에는 원래 `projectId`가 포함된다.

`GET /api/workload-capacity`의 `version`으로 `PATCH /api/workload-capacity`를 호출한다. `workingWeekdays`는 일요일 0부터 토요일 6까지이고, `calendarExceptions`는 `{date,isWorking,label}` 배열이다. `defaultDailyMinutes`, `members`, `exceptions`의 형식은 프로젝트 설정과 같다. 팀원 날짜 예외는 팀 근무일 여부보다 우선한다. 팀 전역 설정과 합산 조회는 브라우저 API에서 사용한다.

## 첨부와 버전

최초 업로드는 `POST /attachments?resourceType=document&resourceId=<문서 ID>&filename=<파일명>`을 사용한다. 업무의 `resourceType`은 `issue`다. 업로드 본문은 최대 20MiB의 `application/octet-stream`이며 `filename`은 URL 인코딩한다. 응답의 `id`는 첨부에 고정되고 `currentVersionId`는 최신 파일을 가리킨다. 파일명·MIME·크기·SHA-256·작성자·시각은 최신 파일 기준이다. `versionCount`는 최초 파일과 이관 이력을 함께 센다.

새 버전은 `POST /attachments/<id>/versions`에 `filename`과 목록에서 확인한 `expectedVersionId=<currentVersionId>`를 전달한다. 먼저 다른 버전이 저장되면 서버는 `409`와 `details.currentVersionId`를 반환한다. 이때 첨부 목록을 다시 읽고 최신 파일을 확인한다.

최신 바이너리는 `GET /attachments/<currentVersionId>/content`에서 받는다. 버전 이력의 각 `id`도 특정 파일을 가리킨다. `GET /attachment-versions/<버전 id>/download`로 이전 바이트를 내려받을 수 있다. `?inline=1`은 서버가 이미지 형식을 확인한 PNG·JPEG·GIF·WebP에 적용한다. 프로젝트 범위는 첨부의 소유 업무·문서를 기준으로 판단한다.

브라우저의 `GET /api/documents/:id/include-revisions/:revisionId/files/:fileId`는 문서 저장본의 본문 링크가 정확히 가리킨 파일 버전을 내려준다. 링크가 없거나 파일을 찾을 수 없으면 `404`다. 활성 파일을 우선 찾아 그 버전을 내려준다. 휴지통에서는 저장본과 같은 문서가 소유한 버전만 읽는다. 응답은 다운로드로 제공하며, 저장본의 인라인 이미지는 별도의 `/images/:fileId` 경로를 사용한다.

## 업무 생성·수정

프로젝트 ID와 상태·유형·팀원·계획 ID는 조회 응답으로 확인한다. 유형·필드·선택지는 표시 이름 대신 `issue-schema`의 고유 ID를 전달한다. 기본 상태는 프로젝트 워크플로에 따르며, 같은 필수 입력·상태 전이 규칙을 적용한다.

업무 생성에 `reporterId`를 생략하면 작업자를 요청자로 기록한다. 쓰기 키에서는 키의 작업자가 기본값이다. 등록된 팀원 ID로 요청자를 지정하고, `null`로 미지정을 저장할 수 있다. `PATCH`에서 필드를 생략하면 현재 값을 유지한다. 예전 업무의 응답에 필드가 없으면 요청자 기록이 확인되지 않은 상태다. `GET /api/v1/issues`의 `reporterId` 조건에 팀원 ID를 넣으면 키의 프로젝트 범위에서 해당 요청자의 업무를 반환한다.

```json
{
  "requestId": "34ca1269-3ac2-4d0e-becb-fd6a1eba6274",
  "projectId": "조회한 프로젝트 ID",
  "title": "파이프라인 실패 원인 확인",
  "type": "버그",
  "assigneeId": "담당자 ID",
  "reporterId": "요청자 ID",
  "cycleId": "사이클 ID",
  "moduleId": null,
  "releaseId": null
}
```

업무를 생성할 때 `requestId`에 작업마다 새 UUID v4를 보낼 수 있다. 브라우저와 쓰기 API 키는 같은 형식을 사용하며 쓰기 키는 프로젝트·참조 권한 검사를 거친다. 최초 생성은 `201`과 업무를 반환한다. 같은 작업자가 같은 UUID와 입력 내용으로 다시 요청하면 `200`과 현재 업무를 반환한다. JSON 객체의 키 순서는 무관하며 생략과 `null`은 다르게 처리한다. UUID를 생략한 요청은 호출마다 새 업무를 만든다. UUID 형식이 틀리면 `400`과 `details.reason`의 `invalid_request_id`를 반환한다.

이미 사용한 UUID의 작업자나 내용이 다르면 `409`의 `details.reason`은 `request_conflict`다. 생성한 업무를 현재 조회할 수 없거나 해당 워크스페이스를 JSON 백업으로 교체했다면 `409`의 이유는 `result_unavailable`이다. 재시도 기록은 같은 데이터 디렉터리의 재시작을 거쳐 보존된다. 기록을 다른 데이터 디렉터리로 함께 옮길 때는 물리 백업을 사용한다.

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

본문 형식 8은 `documentToc` 블록을 지원한다. `attrs`에는 `minLevel`과 `maxLevel`을 1~3의 정수로, `layout`을 `list` 또는 `flat`으로 지정한다. 기본값은 각각 `1`, `3`, `list`다. 목차의 제목과 링크는 표시할 문서 버전에서 생성한다. 이 블록이 있는 본문을 교체하는 `PATCH`에는 `contentSchemaVersion` 8 이상을 보낸다. 자체 백업 형식 54와 문서 JSON 형식 8에 이 범위의 목차 설정을 보존한다.

본문 형식 9의 `documentLabelList`는 `projectId`에 프로젝트 ID 또는 팀 공통을 뜻하는 `null`을 받는다. `labels`는 문서 라벨과 같은 정규화 규칙을 사용하고, 라벨이 비어 있으면 결과가 비어 있다. `match`는 `any` 또는 `all`, `sort`는 `title`, `created`, `updated` 중 하나다. `descending`, `showLabels`, `showSpace`, `excludeCurrent`는 불리언이고 `limit`은 1~500, `title`은 최대 160 UTF-16 코드 단위다. 문서당 최대 30개 블록을 포함할 수 있다. 이 블록이 있는 본문을 교체할 때 `contentSchemaVersion: 9`를 보내며, 자체 백업 형식 59와 문서 JSON 형식 9는 목록 조건을 보존한다. 프로젝트 제한 API 키는 본문과 이력의 목록 대상도 같은 키의 허용 프로젝트에 있어야 한다.

### 하위 문서 목록

본문 형식 10의 `documentChildList`는 `scope`로 현재 문서(`current`), 그 문서가 속한 공간의 최상위(`current-space`), 명시한 문서(`document`) 또는 공간의 최상위(`space`)를 지정한다. `document`에는 `documentId`가 필요하고 `space`에는 `projectId` 또는 팀 공통을 뜻하는 `null`을 보낸다. 다른 범위에서는 두 ID를 `null`로 둔다.

`depth`는 `1`~`60` 또는 모든 하위 단계를 뜻하는 `"all"`이다. 기본값은 `1`이다. `first`는 첫 단계에서 선택하는 문서 수의 상한 `1`~`500`이며 `null`은 첫 단계 제한을 해제한다. 각 계층을 `sort`의 `title`, `created`, `updated` 기준으로 정렬하며 `descending`으로 방향을 바꾼다. `style`은 `list` 또는 `h1`~`h6`, `title`은 최대 160 UTF-16 코드 단위다. 한 문서에 블록 30개, 한 목록에 표시 문서 500개까지 지원한다.

`sort: 'manual'`은 각 상위 문서와 공간의 저장된 형제 순서를 적용한다. 사용자 지정 순서가 없는 그룹은 제목순을 사용한다. `descending`을 적용한 뒤 `first`를 계산한다. 편집 `PATCH`에는 `contentSchemaVersion` 14 이상을 보낸다. 이 옵션은 문서 JSON 형식 14, 자체 백업 형식 105부터 지원한다. 현재 공동 편집 연결은 프로토콜 15를 사용한다.

교체하는 `PATCH`에는 목록을 지원하는 `contentSchemaVersion` 10 이상을 보낸다. 형식 67 이상 자체 백업과 형식 10 이상 문서 JSON에는 목록 설정을 저장한다. 이력·검토본·발행본·고정 포함은 저장 당시 조건을 표시한다. 프로젝트 제한 API 키는 명시한 부모 문서나 대상 프로젝트도 조회 범위에 포함해야 한다.

### 문서 발췌

본문 형식 11의 `documentExcerpt`에는 `attrs: { "hidden": false }`와 하나 이상의 본문 블록을 넣는다. `hidden: true`는 원본의 일반 읽기 화면과 발행 화면에서 해당 구역을 숨긴다. 편집기와 이력에는 정의를 보존한다. 원본 문서에 여러 정의가 있으면 첫 구역을 포함에 사용한다.

`documentExcerptInclude`는 `attrs: { "documentId": "원본 문서 ID", "label": "저장 이름", "noPanel": false }`를 받는 블록이다. `noPanel: true`면 포함한 본문 위의 원본 안내를 숨긴다. 문서가 활성 상태이며 발췌 구역을 찾을 수 있으면 현재 원본의 해당 구역을 표시한다. 검토·발행·이력 화면의 포함 블록은 저장된 참조 이름을 사용한다. 자체 포함과 순환은 일반 문서 포함과 같은 기준으로 검사한다. 프로젝트 범위 API 키는 조회하거나 추가하는 포함 블록의 원본 프로젝트에도 접근할 수 있어야 한다.

두 노드가 있는 본문을 바꾸는 `PATCH`에는 `contentSchemaVersion: 11`을 보낸다. 공동 편집 프로토콜 11, 문서 JSON 형식 11, 자체 백업 형식 69가 두 노드를 보존한다.

### 문서 다단 구역

본문 형식 12의 `documentColumnLayout`에는 `attrs: { "weights": [3, 7], "border": false }`와 1~3개의 `documentColumn`을 넣는다. `weights`의 길이는 단의 수와 같으며 각 값은 1~1,000 사이의 정수 비율이다. `border`의 기본값은 `false`다. `documentColumn`에는 속성 없이 하나 이상의 본문 블록을 넣는다.

다단 구역을 편집하거나 교체하는 `PATCH`에는 `contentSchemaVersion: 12`를 보낸다. 공동 편집 프로토콜 12, 문서 JSON 형식 12, 자체 백업 형식 79에 다단 설정과 각 단의 내용을 보존한다. Markdown은 왼쪽 단의 첫 블록부터 저장 순서대로 내보내며, 배치가 바뀐 경우 ZIP의 `manifest.json`에 `layout_linearized`를 기록한다.

### 문서 속성과 보고서

본문 형식 13의 `documentProperties`는 하위 노드 없이 `attrs: {group, hidden, entries}`를 받는다. `entries`는 입력 순서로 `{name, value}`를 최대 24개 받는다. 이름과 그룹은 앞뒤 공백을 제외하고 NFC로 정규화하며 최대 80자다. 같은 블록의 이름은 정규화 뒤 유일해야 한다. 빈 값과 여러 줄을 허용하고 값은 최대 800자다. `hidden`을 켜면 일반 읽기 화면과 문서 검색 텍스트에서 해당 블록을 숨긴다. 편집, 속성 보고서와 백업에는 보존한다.

`documentPropertyReport`는 `attrs: {projectId, group, labels, match, columns, sort, descending, limit, title}`을 받는다. `projectId`는 대상 프로젝트 ID 또는 팀 공통을 뜻하는 `null`이다. 라벨은 `all` 또는 `any`로 일치시키며, 라벨이 비어 있으면 결과도 비어 있다. 비어 있지 않은 `group`은 같은 이름의 그룹만 선택한다. 현재 저장된 문서에서 일치하는 속성 블록마다 한 행을 표시한다. `columns`는 최대 24개 이름을 순서대로 지정하고 비어 있으면 결과에서 열을 찾는다. `sort`는 `title` 또는 `updated`, `limit`은 1~200, `title`은 최대 160자다.

두 블록을 한 문서에 합쳐 최대 30개를 둔다. 편집 `PATCH`와 문서 JSON에는 형식 13 이상을 사용한다. 자체 백업은 형식 96부터 활성·휴지통 문서와 이력·템플릿에서 두 블록을 보존한다. Markdown은 값을 일반 표로 내보내고 보고서의 저장 조건을 표시한다. 범위 제한 API 키는 문서와 보고서 대상 양쪽의 프로젝트를 허용해야 한다. 대상이 팀 공통인 보고서는 전체 범위 키로 읽거나 쓴다.

### 제목 단계와 본문 목차

본문 형식 16은 `heading.attrs.level`과 `documentToc.attrs.minLevel`·`maxLevel`에 1~6의 정수를 받는다. 목차의 최소 단계는 최대 단계 이하여야 하며 기본 범위는 1~3이다. 요청이나 기존 본문에 4~6단계 제목 또는 목차 범위가 있으면 본문 `PATCH`에 `contentSchemaVersion: 16`을 보낸다. 문서 제목과 같은 속성만 바꿀 때는 생략할 수 있다. 공동 편집은 프로토콜 16에서 이 형식을 사용한다. 자체 백업 형식 110은 제목 단계·절 ID와 목차 범위를 현재 문서, 이력, 휴지통, 템플릿에 보존한다.

## 티켓의 필드 변경 기록

`GET /api/v1/issues/:id/change-history`와 브라우저용 `/api/issues/:id/change-history`는 최대 20건을 티켓 저장 버전의 내림차순으로 반환한다. 다음 페이지에는 응답의 `nextBeforeVersion`을 `?beforeVersion=...`으로 보낸다. 마지막 페이지의 값은 `null`이다. 각 `entries` 항목에는 `issueId`, `issueVersion`, `actorId`, `actorName`, `origin`, `occurredAt`, 당시 양쪽 프로젝트 ID와 `changes`가 있다. `origin`은 `user` 또는 `automation`이다.

`changes`의 각 항목은 `field`, 당시 `label`, 변경 전후의 `before`와 `after`를 포함한다. 사용자 정의 필드는 `custom:<필드 ID>`로 표시한다. 전후 값에는 `value`, 당시 표시 이름인 `display`, 긴 값의 일부만 보존했을 때의 `truncated`가 있다. 자체 백업 형식 88은 이 기록을 보존한다. 프로젝트가 지정된 키는 티켓의 현재 프로젝트와 각 기록의 양쪽 프로젝트에 접근할 수 있어야 해당 기록을 읽을 수 있다.

## 티켓 설명의 서식

일반 업무 생성·수정과 복제·하위 업무 양식에서 `description`은 최대 200,000자의 원문 문자열이다. `descriptionFormat`을 `markdown`으로 지정하면 저장된 설명을 Markdown으로 표시한다. `plain`을 보내면 원문 문자열을 유지하면서 서식 설정을 해제한다. 생성 시 생략하면 평문이며, 수정 시 생략하면 현재 설정을 유지한다. 응답은 Markdown일 때 `descriptionFormat`을 포함한다. `/api/v1/issues`의 프로젝트 범위 읽기·쓰기에도 같은 규칙을 적용한다.

본래 업무의 버전 검사와 생성 요청 재확인 규칙은 설명 서식에도 적용된다. 백업 형식 78은 활성·휴지통 업무의 설명과 Markdown 설정을 보존한다. 이전 형식에서 읽은 설명은 평문으로 표시한다. 발신 웹훅은 변경한 필드 이름으로 `descriptionFormat`을 표시할 수 있다.

## 프로젝트 업무 템플릿

`GET /api/v1/projects/:id/issue-templates`는 키 범위 안 프로젝트의 활성 업무 템플릿 배열을 반환한다. 각 항목의 `id`와 `version`을 사용해 쓰기 키의 `POST /api/v1/issues`에 `projectId`, `templateId`, `expectedTemplateVersion`을 보낸다. 일반 업무 생성과 같은 `requestId`를 보내면 응답이 끊긴 뒤에도 생성 결과를 다시 확인할 수 있다. 이미 성공한 요청은 이후 템플릿이 변경되거나 보관돼도 같은 업무를 반환한다.

`defaults`에는 `title`, `description`, `descriptionFormat`, `type`, `priority`, `labels`, `customFields`가 있다. 생략한 업무 입력에 기본값을 적용하며 명시한 `customFields` 객체는 전체를 교체한다. 물려받는 사용자 정의 기본값은 현재 유형·상태에서 표시되는 필드에 반영한다. 상태와 담당자, 일정 등은 일반 생성의 기본값과 입력을 따른다. 최종 업무는 현재 워크플로와 필수 입력을 검사한다. 템플릿 버전이 바뀌거나 보관된 경우 최신 목록을 확인한다. 저장된 유형·필드·선택지에 문제가 있는 경우 현재 값을 다시 지정하거나 설정에서 템플릿을 편집한다.

브라우저의 `GET /api/projects/:id/issue-templates?includeArchived=1`은 보관된 템플릿도 조회한다. 같은 경로에 `POST {name,defaults}`로 새 템플릿을 저장하거나 `{name,sourceIssueId,expectedIssueVersion}`으로 같은 프로젝트의 티켓 저장본에서 기본값을 가져온다. `PATCH /api/projects/:id/issue-templates/:templateId`는 `expectedVersion`과 바꿀 `name`, `defaults` 또는 `archived`를 받는다. 관리 요청은 브라우저 경로를 사용한다. 자체 백업 형식 87에 템플릿과 보관 상태를 포함한다.

## 주간 반복 업무

`GET /api/v1/projects/:id/recurring-issues`로 예약 규칙과 최근 실행을 읽는다. 보관된 규칙도 필요하면 `includeArchived=1`을 붙인다. 등록·변경에는 해당 프로젝트 범위의 쓰기 키를 사용한다.

`POST /api/v1/projects/:id/recurring-issues`의 입력은 `{name,templateId,weekday,time,assigneeId,enabled,requestId}`다. `weekday`는 월요일 `1`부터 일요일 `7`까지이고, `time`은 서울 기준 `HH:mm`이다. `assigneeId`를 `null`로 보내면 담당자는 미지정이다. `requestId`는 규칙 ID로 쓸 UUID v4다. 첫 등록은 `201`을 반환한다. 같은 작업자가 같은 요청 ID와 설정을 다시 보내고 저장된 설정이 그대로면 `200`으로 기존 규칙을 반환한다. 이미 사용된 ID의 설정이 다르거나 보관된 경우에는 `409`로 현재 목록을 확인할 수 있다.

`PATCH /api/v1/projects/:id/recurring-issues/:ruleId`에 `expectedVersion`과 변경할 값만 보낸다. `enabled:false`로 일시 중지하고 `enabled:true`로 다시 시작한다. `archived:true`는 예약을 중지하고 보관한다. 응답의 `nextRunAt`와 `recentRuns[].scheduledAt`, `processedAt`은 UTC 시각이다. 실행 결과는 `outcome`의 `created` 및 생성 티켓 키, 또는 `blocked` 및 보류 사유를 포함한다.

## 업무 복제

`POST /api/issues/:id/clone`과 쓰기 키의 `POST /api/v1/issues/:id/clone`은 `{requestId,expectedSourceVersion,issue}`를 받는다. `requestId`는 UUID v4다. `issue`에는 검토한 업무 생성 값을 보낸다. 새 업무의 프로젝트는 원본에서 결정되며, 명시한 프로젝트가 다르면 요청을 거절한다. 현재 워크플로, 업무 유형·필수 입력, 날짜와 같은 프로젝트의 상위 업무·계획 항목 검증을 적용한다.

생성된 업무와 두 업무의 관련 관계를 함께 저장하고 `{issue,relation,duplicate}`를 반환한다. 최초 생성은 `201`, 같은 요청의 재확인은 `200`과 현재 저장 업무를 반환한다. 재확인 전에 관계를 해제하면 `relation`은 `null`이다. 원본 버전이 다르면 첫 저장에서 `409`와 `details.reason: 'source_version_changed'`, `currentVersion`을 반환한다. 백업 복원은 일반 업무와 관련 관계의 기존 규칙을 사용한다.

## 업무 프로젝트 이동

브라우저의 `POST /api/issues/:id/project-move/preview`는 `{expectedVersion, projectId, includeConnected, mappings}`를 받는다. `projectId`는 대상 프로젝트이고 `mappings`의 각 행은 `issueId`와 선택한 `type`, `status`, `customFields`, `cycleId`, `moduleId`, `releaseId`를 받는다. `includeConnected`를 켜면 같은 프로젝트의 상하위 업무와 선후행 연결을 따라 최대 100개를 함께 검토한다. 응답에는 업무별 새 키와 선택 값, 이동을 막는 `blockers`, 적용 시 달라지는 항목의 `warnings`가 있다. 적용할 수 있는 미리보기에는 `token`이 있다.

검토한 동일한 요청에 `token`을 추가해 `POST /api/issues/:id/project-move/apply`로 보낸다. 업무와 연결, 두 프로젝트의 설정 및 발급할 키가 미리보기와 일치할 때 한 트랜잭션으로 저장한다. `{issues, duplicate}`의 `issues`는 이동 당시 저장 결과다. 같은 작업자의 같은 요청을 재전송하면 같은 결과와 `duplicate: true`를 반환한다. 자체 백업을 가져오면 이전 미리보기와 적용 결과 확인이 만료된다.

업무 ID와 댓글·첨부·업무 관계·문서 연결·GitLab 연결, 함께 이동한 업무 사이의 일정과 상하위 구조를 보존한다. 작업 시간은 업무와 같은 트랜잭션에서 대상 프로젝트에 귀속된다. `worklogs_transferred` 경고는 이동할 업무의 활성 작업 시간 건수를 알려 준다. 저장된 기록이 검토 뒤 바뀌면 `409`로 다시 검토하게 한다. 기록 ID·작성자·날짜·시간·버전과 삭제 이력을 보존한다. 작업 시간 보고서의 귀속은 과거 날짜에도 이동한 프로젝트를 사용한다.

Jira 이관 업무의 `jira_origin_preserved` 경고는 원본 링크와 영수증을 유지하는 이동임을 알려 준다. 기존 상태 이력, 원본에서 확인한 관계와 초 단위 작업 시간을 보존한다. 차단 관계와 작업 시간의 조회 권한은 현재 프로젝트를 사용한다. 출발 프로젝트로 후속 이관을 적용할 때 이동한 업무의 원본은 보관 대상으로 표시한다. 자체 백업 형식 109는 출발·도착의 이동 기록과 당시 원본 영수증을 대조해 원본 연결을 복원한다.

기준선·완료 사이클·이정표 이력과 일부 휴지통 관계는 미리보기에서 이동을 막는다. 자체 백업 형식 83부터 출발·도착 프로젝트의 관측 기록과 이전 업무 키를 보존한다.

이동 이력이 있는 활성 업무가 있으면 브라우저의 `GET /api/workspace`에 `issueMoveOrigins`가 포함된다. 업무 ID별 출발 프로젝트 ID 목록이며, 이전 프로젝트의 간트 위치 주소를 현재 프로젝트로 연결하는 데 사용한다. 백업을 복원하면 이동 이력에서 목록을 다시 구성한다.

## 상위 업무에서 하위 업무 만들기

브라우저의 `POST /api/issues/:id/children`에 `{requestId, expectedParentVersion, issue}`를 보낸다. `requestId`는 UUID v4다. `issue`에는 업무 생성과 같은 속성을 보낸다. `projectId`와 `parentId`는 현재 상위 업무에서 정해지며, 함께 보낼 경우 같은 ID여야 한다. 현재 프로젝트의 유형·워크플로·필수 속성을 검사한 뒤 하위 업무와 번호, 상위·하위 업무 변경 기록을 한 트랜잭션에 저장한다.

최초 생성은 `201`과 `{issue, duplicate:false}`를 반환한다. 같은 작업자가 요청을 그대로 재시도하면 해당 하위 업무와 `200`, `duplicate:true`를 반환한다. 새 요청의 상위 업무 버전이 바뀌었거나, 재시도 대상 하위 업무가 삭제 또는 다른 상위 업무로 이동한 경우에는 `409`를 반환한다. 자체 백업은 업무의 `parentId`를 보존하고 복원 시 생성 요청 기록을 초기화한다.

## 스프레드시트로 새 업무 등록

브라우저의 `POST /api/projects/:projectId/issues/paste-preview`에 `{text}`를 보낸다. 표는 헤더가 있는 TSV 또는 UTF-8 CSV로 최대 100개 업무, 1,000개 선후행 연결, 128KiB를 처리한다. `제목`은 필수다. `설명`, `유형`, `상태`, `우선순위`, `담당자`, `시작일`, `종료일`, `목표 마감일`, `라벨`과 선후행 열을 추가할 수 있다. 빈 날짜는 미정이며 `업무 키` 열이 있는 행은 그 값을 비워 둔다.

새 업무마다 선택적으로 `임시 키`를 부여한다. `선행 업무`에는 같은 표의 `new:<임시 키>` 또는 현재 프로젝트의 기존 업무 키를 쓴다. 여러 선행 업무는 쉼표로 구분한다. 비어 있는 `연결 유형`과 `근무일 간격`은 `FS`와 `0`을 사용한다. 값 하나를 입력하면 모든 선행 업무에 적용하며, 쉼표로 목록을 입력하면 같은 위치의 선행 업무에 대응한다. CSV에서 쉼표를 포함한 셀은 큰따옴표로 감싼다. `FS`, `SS`, `FF`, `SF`와 `-3650`~`3650` 근무일을 지원한다. 뒤에 있는 행도 참조할 수 있으며 중복·자기 참조·순환·찾을 수 없는 키는 적용을 막는다.

| 제목 | 임시 키 | 선행 업무 | 연결 유형 | 근무일 간격 |
| --- | --- | --- | --- | --- |
| 검토 | review | `new:prep,TEAM-7` | `FS,SS` | `0,-1` |
| 준비 | prep | | | |

미리보기 `rows`에 확정한 날짜·상태와 각 행의 `predecessors`를 반환한다. 선행 업무가 새 업무면 표의 행과 임시 키, 기존 업무면 현재 키와 ID를 표시한다. 일정 미정이나 충돌은 경고로 표시하며 입력한 날짜를 유지한다. 입력 오류가 있으면 `previewId`는 `null`이다.

`POST /api/projects/:projectId/issues/paste-apply`에 `{previewId}`를 보낸다. 미리보기는 작업자별 30분 동안 유효하다. 업무 양식·워크플로, 연결한 기존 업무의 버전과 작업 달력을 다시 검사한 뒤 표의 순서로 새 업무를 생성한다. 업무·연결·이력·알림과 적용 기록은 함께 저장한다. 최초 `201`, 같은 미리보기의 7일 이내 재시도는 `200`이며, 연결을 만들었으면 응답 `{issues,duplicate}`에 최초 저장한 `dependencies`를 포함한다. 저장 후 연결을 편집하거나 해제한 경우에도 같은 요청은 기존 생성 결과만 확인한다.

## 업무 일괄 편집

브라우저의 `POST /api/projects/:projectId/issues/bulk-preview`에 `{issues:[{id,expectedVersion}],changes:{status?,priority?,assigneeId?,dueDate?,addLabels?,removeLabels?,customFields?,parentId?,cycleId?,moduleId?,releaseId?}}`를 보낸다. 같은 프로젝트의 업무 1~100개를 받는다. 상태 전이에서 담당자나 목표 마감일을 생략하면 해당 워크플로의 자동 규칙을 적용할 수 있다. 담당자를 직접 지정하거나 해제하는 경우 `assigneeId`에 팀원 ID 또는 `null`을 보낸다. `dueDate`는 `YYYY-MM-DD`로 지정하고 `null`로 해제한다.

`parentId`는 같은 프로젝트의 활성 티켓 ID로 지정하고 `null`로 연결을 해제한다. 생략하면 기존 상위를 유지한다. 미리보기는 각 티켓의 `before.parentId`, `after.parentId`와 `parents.before`, `parents.after`의 키·제목을 반환한다. 검증에 막힌 행은 `after: null`과 이유를 반환한다. 상위 업무의 소속, 자체 참조와 순환, 검토한 상위 연결을 검사한다. 적용 시 근거가 달라졌으면 `409`를 반환하고 새 미리보기를 요구한다.

`cycleId`, `moduleId`, `releaseId`는 종류에 맞는 같은 프로젝트의 계획 ID를 받는다. `null`은 해당 종류의 연결 해제이고 생략은 유지다. `rows[].before`와 `after`에 요청한 계획 ID를 포함하고 `rows[].plans`의 `cycle`, `module`, `release` 항목에 각각 `before`와 `after`의 `{id,name}` 또는 `null`을 담는다. 보관된 계획에 새로 배정하려 하면 해당 행을 차단한다. 적용 전에 검토한 계획 버전을 다시 대조한다.

`addLabels`와 `removeLabels`는 각각 중복 없는 1~100개 문자열 배열이며, 라벨 하나는 최대 60자다. 양쪽에 같은 이름을 넣으면 요청을 거절한다. 대소문자와 공백을 포함한 이름을 그대로 비교한다. 해당 티켓에 있는 제거 대상만 지우고, 없는 추가 대상을 기존 목록 뒤에 붙인다.

`customFields`에는 변경할 필드 ID와 각 값을 넣는다. 명시적인 `null`은 값을 지우고, 생략한 ID의 값은 유지한다. 숫자 `0`과 확인 여부 `false`도 입력값이다. 상태와 필드 변경을 같은 요청에서 검토할 수 있다. 업무마다 변경 후 상태·유형·필드 조건을 확인하며, 현재 양식에서 표시되거나 해당 워크플로에서 명시적으로 요구하는 활성 필드에 적용한다. `rows[].before.customFields`와 `rows[].after.customFields`에는 요청한 ID의 값만 표시하며, 비어 있는 값은 `null`로 반환한다. 사용자 정의 필드를 포함한 미리보기의 데이터가 64MiB 한도를 넘으면 `413`을 반환한다.

집계에서 선택한 업무의 미리보기에는 `fieldBreakdown`을 함께 보낸다. 집계에 사용한 `fieldId` 또는 `groupBy`, 선택 속성 `savedViewId`와 `comparisonBy`, 조회한 `revision`과 `bucketId`, 셀을 선택했으면 `comparisonBucketId`를 담는다. 미리보기와 적용의 같은 트랜잭션에서 현재 집계 버전과 각 대상의 소속을 확인한다. 범위나 선택이 달라지면 `409`와 `details.reason`의 `field_breakdown_stale`을 반환한다. 적용이 이미 완료된 요청의 재시도는 저장한 결과를 반환한다.

응답의 `rows`는 업무별 `before`, `after`, `outcome`, `reason`을 반환하며 `changed`, `unchanged`, `blocked`에 건수를 담는다. 마감일이나 라벨 편집을 요청하면 해당 필드의 전후 값도 반환한다. 전이로 자동 지정하는 마감일도 전후 값에 포함한다. 변경할 업무가 있고 모든 업무가 검증을 통과하면 30분간 유효한 `previewId`를 반환한다. 적용 전까지 업무와 변경 이력은 유지된다.

`POST /api/projects/:projectId/issues/bulk-apply`에 `{previewId}`를 보낸다. 같은 작업자와 프로젝트에서 업무·워크플로·업무 양식·배정 규칙을 다시 확인한 뒤 실제 변경이 있는 업무를 함께 저장한다. 충돌이 있으면 `409` 응답으로 전체 저장을 거절한다. 적용 응답을 받지 못하면 같은 ID를 보내 7일간 `{previewId,updated,unchanged}`를 다시 받을 수 있다. 자체 백업을 가져오면 미리보기와 재시도 기록을 초기화한다.

전체 프로젝트 보드의 `POST /api/team/issues/bulk-preview`는 `{issues:[{id,projectId,expectedVersion}],changes:{priority?,assigneeId?,dueDate?,addLabels?,removeLabels?},statuses?,workflowVersions?}`를 받는다. 현재 보드에서 선택한 업무 최대 100개를 보낸다. `statuses`에는 상태를 바꿀 프로젝트별 실제 상태 ID를 넣고, `workflowVersions`에는 같은 프로젝트 키와 조회 당시 버전을 넣는다. 공통 변경만 검토할 때는 두 항목을 생략한다. 선택한 업무·프로젝트와 워크플로 버전을 대조한 뒤 `rows[].projectId`와 각 업무의 전후 값·차단 이유를 반환한다.

팀 보드에서 받은 미리보기 ID는 `POST /api/team/issues/bulk-apply`에 `{previewId}`로 보낸다. 각 프로젝트의 설정과 업무 버전을 다시 확인하고, 실제 업무·이력·알림과 적용 결과를 한 트랜잭션으로 저장한다. 입력한 상태 전이가 하나라도 막히면 전체 적용을 보류한다. 적용 응답이 끊기면 같은 미리보기 ID로 결과를 다시 확인할 수 있다.

## 전체 프로젝트 보드의 상태 변경

브라우저의 `PATCH /api/issues/:id`에 `{expectedVersion, expectedWorkflowVersion, status}`를 보내 상태를 바꾼다. `status`는 해당 업무 프로젝트의 실제 상태 ID다. 선택 속성인 `expectedWorkflowVersion`을 보낼 때는 `status`를 함께 지정하고, 조회한 워크플로의 양의 정수 버전을 사용한다. 업무 버전과 별도로 워크플로 버전이 달라지면 `409`와 `details.reason`의 `workflow_changed`, `currentWorkflowVersion`을 반환한다. 일반 상태 전이의 필수 입력·차단 검사를 적용하며 프로젝트 내 상대 순서를 보존한다.

이 버전 검사와 함께 `assigneeId`를 지정하면 팀원 ID 또는 `null`을 상태와 함께 저장한다. 현재 값과 같아도 직접 지정한 값은 자동 배정보다 우선한다. `assigneeId`를 생략하면 현재 프로젝트의 배정 규칙을 적용한다. 전이의 필수 담당자 조건은 저장할 최종 값으로 검사한다. 검증을 통과한 경우에만 변경을 함께 커밋한다. 이 경로를 프로젝트 업무 목록과 두 보드의 상태 변경 창에서 사용한다.

브라우저의 `GET /api/workspace`는 `X-Teamspace-Board-Revision` 헤더와 `Cache-Control: no-store`를 보낸다. 조회한 32자리 16진수 버전을 `?teamBoardSince=…`로 다시 보내면 같은 버전에는 본문 없는 `204`를, 바뀐 버전에는 `200`과 최신 워크스페이스를 돌려준다. 업무·프로젝트·사용자·워크플로·업무 양식·업무 순서·GitLab 연결·선후행과 업무–문서 링크의 저장이 버전을 갱신한다. 서버 재시작과 물리 복원은 SQLite에 저장된 버전을 사용한다. 수동으로 전체 워크스페이스를 다시 읽을 때는 쿼리를 생략한다.

팀 보드의 화면 주소 `#/<projectId>/teamboard`에는 `boardGitlab` 조건을 더할 수 있다. 전체 프로젝트 간트의 주소는 같은 값의 `ganttGitlab` 조건을 받는다. 허용 값은 `open_merge_request`, `merge_blocked`, `failed_pipeline`, `running_pipeline`, `manual_pipeline`, `no_activity`다. 프로젝트·담당자·검색 조건과 함께 현재 워크스페이스를 판정한다. 값을 생략하거나 알 수 없는 값을 보내면 GitLab 조건 없이 업무를 표시하며, 주소에서 알 수 없는 값을 정리한다.

## 상태 변경과 인수인계 댓글

브라우저의 `POST /api/issues/:id/status-change`에 `{requestId,expectedVersion,expectedWorkflowVersion,restoreGeneration,status,assigneeId?,comment:{body,mentions?}}`를 보낸다. `requestId`는 UUID v4이며 `restoreGeneration`은 최근 워크스페이스 응답의 값이다. `comment`는 일반 업무 댓글과 같은 본문·멘션 규칙을 적용한다. `assigneeId`를 생략하면 자동 배정 규칙을 적용하며 `null`로 담당자를 해제할 수 있다. 허용된 상태 전이와 필수 값·차단 업무를 검증하고 티켓과 댓글, 이력, 알림을 함께 저장한다.

응답은 `{issue,receipt,duplicate}`다. `receipt`에는 `requestId`, `issueId`, `projectId`, `appliedVersion`, `status`, `assigneeId`, `commentId`가 들어간다. 같은 작업자·업무·입력으로 7일 안에 다시 요청하면 현재 `issue`, 당시의 `receipt`, `duplicate: true`를 돌려준다. 이미 쓴 ID의 용도가 다르면 `409`와 `request_reused`를 반환한다. 다른 프로젝트로 이동했거나 티켓이 없어지면 `receipt_unavailable`, 자체 백업 가져오기 후 이전 세대의 요청은 `workspace_changed`를 반환한다.

## 보드 상태별 업무 한도

브라우저의 `GET /api/projects/:projectId/workflow`에서 설정된 상태의 `statuses[].wipLimit`을 읽을 수 있다. 기존 `PATCH /api/projects/:projectId/workflow` 요청의 `expectedVersion`과 상태 목록에 `wipLimit`을 1~10,000의 정수로 전달한다. `null`은 한도를 해제한다. 속성을 생략하면 같은 ID의 기존 한도를 유지한다. 자체 백업의 형식 56에 설정을 보존한다.

한도는 보드에서 해당 상태의 전체 업무 수와 비교한다. 하위 업무와 보드의 필터 밖 업무도 포함한다. 업무 생성·상태 변경의 허용 여부는 워크플로의 전이 및 필수 속성 규칙이 결정한다.

## 상태 변경의 차단 업무 검증

브라우저의 `PATCH /api/projects/:projectId/workflow`에서 전이 항목에 `requireResolvedBlockers: true`를 보내면 해당 경로와 업무 유형에 규칙을 적용한다. `false`는 규칙을 해제하고, 생략하면 같은 출발·도착 경로에 저장된 설정을 유지한다. 기본값은 꺼짐이다. 형식 81의 자체 백업에 저장한다.

실제 상태 변경은 대상 티켓으로 들어오는 직접 차단 관계를 확인한다. Teamspace에서 만든 관계와 이관 원본에서 연결 대상과 방향을 확인한 Jira 관계가 적용된다. 원인 티켓이 있는 프로젝트의 상태 분류가 완료 또는 취소일 때 해결된 것으로 본다. 열린 원인이 있으면 일반 업무 저장과 보드 이동은 `422` 및 `details.reason: "open_issue_blockers"`를 반환한다. 범위 제한 쓰기 키에도 같은 규칙을 적용하며 응답은 원인 티켓의 식별자나 제목을 포함하지 않는다. 일괄 편집은 미리보기와 적용 시점에 다시 확인한다. GitLab은 미리보기와 실제 이벤트에 차단 사유를 기록하며 다음 새 이벤트부터 현재 상태를 평가한다. 워크플로의 상태 일괄 이관은 관리용 상태 매핑 규칙을 사용한다.

## 상태별 자동 목표 마감일

`PATCH /api/projects/:projectId/workflow`에서 상태 목록의 `defaultDueWorkdays`에 1~3,650의 정수를 지정한다. `null`은 설정을 해제하며, 속성을 생략하면 같은 상태 ID에 저장된 설정을 사용한다. `GET /api/projects/:projectId/workflow`는 설정된 상태에만 이 속성을 반환한다. 자체 백업 형식 93은 이 설정을 보존한다.

날짜가 비어 있는 티켓이 해당 상태로 이동할 때 서울 기준 상태 변경일 다음부터 프로젝트 달력의 근무일을 센다. 날짜는 상태별 필수 입력 검사 전에 계산한다. 이미 날짜가 있거나 요청에 `dueDate`를 직접 지정하면 해당 날짜나 명시적인 `null`을 우선한다. 업무 상세·보드·업무 쓰기 API·일반 업무 일괄 편집·GitLab 자동화의 상태 전이에 적용한다. 생성·이관·프로젝트 이동은 각 작업의 입력과 원본 날짜를 사용한다.

일괄 편집은 적용 전에 달력 버전과 계산된 날짜를 다시 대조한다. 달력이 바뀌거나 서울 기준일이 넘어 결과가 달라진 경우 `409`를 반환하고 새 미리보기를 요구한다. 저장된 날짜와 작업자는 티켓의 변경 이력에 기록된다.

## 티켓 저장 전 일정 검토

브라우저의 `POST /api/issues/:id/schedule-save-preview`에 `{expectedVersion,startDate,endDate,dueDate,status?}`를 보낸다. 세 날짜는 `YYYY-MM-DD` 또는 `null`이다. 상태도 바꿀 때는 상태 ID를 보내면 자동 목표 마감일과 변경 후 열리는 프로젝트 간 차단 관계를 반영한다. 응답의 `changes`에 날짜 전후 값과 `warnings`에 업무 키·필요한 날짜가 표시된다. 변경할 날짜가 있고 날짜 순서가 유효하면 30분간 유효한 `previewId`를 발급한다. 종료일이 시작일보다 빠르면 `blocking`을 반환한다.

검토 ID를 `schedulePreviewId`로 일반 `PATCH /api/issues/:id`에 보낸다. 서버는 같은 작업자·업무·버전·최종 날짜·상태와 현재 달력·관계를 대조한 뒤 전체 티켓 변경과 이력을 한 번에 저장한다. 일정 검토 근거가 바뀌거나 검토가 만료되면 `409`와 `details.reason`의 `schedule_preview_stale`을 반환한다. 티켓 자체가 변경된 경우 일반 저장의 버전 충돌 응답을 사용한다. 이 검토는 브라우저의 상세 편집에서 사용한다.

## 워크플로 상태 일괄 이동

`POST /api/projects/:projectId/workflow/status-migration-preview`에 `{fromStatusId,toStatusId,expectedWorkflowVersion}`을 보낸다. 두 상태 ID는 같은 프로젝트의 저장된 워크플로에서 고른다. 서버가 출발 상태인 활성 티켓 전체를 조회하며 최대 1,000건을 검토한다. 응답 형식은 [업무 일괄 편집](#업무-일괄-편집) 미리보기와 같다. 이동할 업무가 없거나 검증이 차단된 업무가 있으면 `previewId`가 `null`이다.

상태 매핑에는 도착 상태와 업무 양식의 필수 입력을 적용하고 해당하는 자동 배정 규칙을 평가한다. 개별 업무에 정의한 출발→도착 전이의 방향·유형·전이별 필수 입력 규칙은 일반 상태 변경에 적용된다. 미리보기의 티켓·활동·알림에는 변경이 없다.

`POST /api/projects/:projectId/workflow/status-migration-apply`에 `{previewId}`를 보낸다. 검토한 작업자와 프로젝트가 일치해야 한다. 출발 상태의 티켓이 추가·삭제·이동되거나 대상 버전과 워크플로·양식·배정 규칙이 바뀌면 전체 적용을 거절한다. 상태 변화, 필요한 완료 시각, 활동·보고서·알림·발신 이벤트를 한 트랜잭션에 기록한다. 동일한 미리보기 ID로 7일간 완료 결과를 다시 받을 수 있다. 두 단계는 브라우저용 `/api` 경로에 있다.

## 문서 생성과 Markdown 가져오기

`POST /api/documents`와 자동화용 `POST /api/v1/documents`에서 UUID v4인 `requestId`를 선택적으로 보낼 수 있다. 새 요청은 `201`, 동일한 작업자와 입력으로 다시 보내면 저장된 문서와 `200`을 반환한다. 같은 ID에 다른 입력을 보내거나 생성한 문서를 현재 범위에서 읽을 수 없으면 `409`를 반환한다. 문서·첫 이력·생성 활동·알림과 요청 기록을 함께 저장한다. 물리 백업은 요청 기록을 보존한다. 같은 워크스페이스를 이동용 JSON 백업으로 교체하면 이전 요청은 `409`를 반환한다.

문서 화면의 Markdown 가져오기는 브라우저에서 파일이나 입력 내용을 미리보기로 변환한다. 저장은 새 문서와 같은 API에 검토한 `content`를 보낸다. 미리보기 입력을 바꾸면 다시 검토한 뒤 저장한다. 첫 저장 응답을 확인할 수 없으면 같은 요청을 다시 보내고, 응답을 받은 뒤 목록이 갱신되지 않았으면 문서 열기만 다시 시도한다.

## 티켓에서 새 연결 문서 만들기

브라우저의 `POST /api/issues/:id/documents`에 `X-Actor-Id`와 `{requestId,expectedIssueProjectId,title,projectId,parentId}`를 보낸다. `requestId`는 UUID v4이고 `expectedIssueProjectId`는 검토한 티켓의 프로젝트다. `projectId: null`은 팀 공통 공간이고 `parentId: null`은 최상위다. 저장할 `content`, `icon`, `labels`를 선택적으로 보내거나 `templateId`와 `expectedTemplateVersion`을 함께 보내 팀 템플릿을 사용한다. 결과는 초안이며, 상위 문서는 선택한 공간에 있어야 한다.

신규 생성은 `{document,link}`와 `201`을 반환한다. `link`의 종류는 `관련 문서`다. 문서, 최초 이력, 팀 템플릿 첨부, 양방향 연결, 활동, 알림과 요청 기록을 한 트랜잭션에 저장한다. 같은 티켓·작업자·입력을 재전송하면 원래 문서와 연결을 `200`으로 반환한다. 다른 작업자·티켓·입력으로 같은 요청 ID를 쓰면 `409`와 `request_conflict`를 반환한다. 새 요청의 티켓이 다른 프로젝트로 이동했다면 `409`와 `issue_project_changed`를 반환하므로 현재 소속을 다시 검토한다.

확인할 수 없는 문서나 해제된 원래 연결은 `409`와 `result_unavailable`을 반환한다. 물리 백업은 생성 요청 기록을 보존한다. 이동용 JSON은 문서와 연결을 보존하며 같은 워크스페이스를 교체하면 앞서 사용한 생성 요청을 무효화한다.

## 형제 문서 순서

브라우저의 `GET /api/documents/:id/sibling-order`는 기준 문서의 현재 위치에 속한 전체 형제 순서를 `{projectId,parentId,documentIds,version}`으로 반환한다. 형제 범위는 최상위에서 공간별이며, 하위에서는 같은 상위 문서의 현재 공간을 따른다. 사용자 지정 순서가 생기기 전에는 삽입 순서를 적용한다.

워크스페이스의 `documentOrders`는 사용자가 정했거나 이관에서 확인한 그룹의 순서에 `custom: true`를 제공한다. 복제할 하위 트리 안의 사용자 지정 그룹과 자체 백업의 순서 기록도 이 구분을 보존한다.

`PATCH /api/documents/:id/sibling-order`에 `{expectedVersion,documentIds}`로 같은 위치의 전체 ID를 한 번씩 보낸다. 다른 순서가 저장됐거나 문서 구성이나 위치가 바뀌면 `409`를 반환한다. 순서 저장에는 독립된 순서 버전과 활동 기록을 사용한다. 저장 응답을 받지 못하면 `GET`으로 현재 순서와 저장하려던 순서를 대조할 수 있다.

새로 생성·복원하거나 다른 상위 문서에서 이동한 문서는 해당 형제 그룹의 끝에 놓인다. 트리가 공간을 옮기면 내부 형제 순서도 이어지고 복제는 미리보기의 형제 순서를 따른다. 자체 백업 형식 82는 사용자 지정 순서를 포함하며 복원 시 새 순서 버전을 발급한다.

## 문서 트리 복제

브라우저의 `POST /api/documents/:id/copy-preview`에 `{title,projectId,parentId,includeDescendants,expectedSourceVersion}`을 보낸다. `projectId: null`은 팀 공통 공간이고 `parentId: null`은 최상위다. 미리보기에는 선택한 문서와 버전, 복제할 파일 수와 바이트, 확인이 필요한 첨부 주소, `token`을 담는다. 활성 문서 최대 100개, 본문 합계 64MiB와 복제할 첨부 합계 64MiB·1,500개를 지원한다.

`POST /api/documents/:id/copy`에 같은 옵션과 `token`, 새 UUID v4 `requestId`를 보낸다. 서버는 작업자·원본 버전·하위 트리 구성·대상 위치와 첨부 목록을 검증한다. 변경이 생기면 `409` 및 `details.reason: "copy_preview_stale"`로 새 미리보기를 요청한다. 성공하면 새 루트 `DocPage`를 `201`로 반환한다. 이후 같은 작업자와 요청 입력으로 다시 보내면 저장한 루트 문서를 `200`으로 돌려준다.

각 복제본은 새 ID, 현재 작업자, 버전 1과 새 첫 저장본을 갖는다. 복제 대상 문서의 최신 첨부와 그 문서들이 소유한 파일 중 복제할 본문이 직접 가리키는 버전을 새 첨부로 저장한다. 함께 복제한 페이지와 절의 현재 링크는 새 ID를 사용한다. 고정 저장본의 링크는 원래 저장본을 가리킨다. 본문·버전·활동·알림·파일과 재시도 기록을 함께 저장한다. 물리 백업은 재시도 기록을 보관하며, 자체 JSON 백업으로 작업 공간을 교체하면 이전 생성 요청을 무효화한다.

## 문서 트리 Markdown ZIP 내보내기

브라우저의 `GET /api/document-exports/markdown.zip`에 `source=saved` 또는 `source=published`와 범위를 지정한다. `scope=subtree&documentId=<ID>`는 문서와 하위 트리, `scope=space&projectId=<ID>`는 해당 프로젝트, `scope=space`는 팀 공통 공간이다. `source=published`는 승인된 최신 발행본을 사용한다.

응답은 `application/zip`이며 `Content-Disposition`에 다운로드 파일명을 제공한다. ZIP의 `README.md`는 문서 트리이고 `manifest.json`의 `format`은 `teamspace-document-markdown`, `schemaVersion`은 `1`이다. `documents`에 상대 파일 경로·저장 버전·`parentId`와 `originalParentId`·발행 정보를 기록한다. 발행본만 내보낼 때 `parentId`는 패키지에 있는 가장 가까운 상위 문서다. `attachments`는 소유 문서와 파일 버전 ID·이름·크기·SHA-256·경로를 기록하고 `diagnostics`는 오프라인으로 연결할 수 없는 참조와 동적 블록을 보여준다.

최신 저장본은 현재 첨부와 본문에서 직접 참조한 과거 파일 버전을 모두 담는다. 승인·발행본은 그 본문이 직접 참조한 파일만 담는다. 같은 서비스 주소의 문서·절·파일 링크는 패키지 상대 경로로 바꾸고, 다른 주소로 저장된 링크는 진단에 기록한다. 문서 500개, 첨부 1,500개, 압축 전후 각각 64MiB까지 처리한다. 조건이 올바르지 않으면 `400`, 해당 문서나 공간 또는 내보낼 저장본이 없으면 `404`, 한도를 넘으면 `413`, 대상 파일을 읽거나 무결성을 확인할 수 없으면 `503`과 JSON 오류를 반환한다.

## 문서 트리 Markdown ZIP 가져오기

브라우저의 `POST /api/document-markdown-import/preview?projectId=<ID>&parentId=<ID>`에 `application/octet-stream` ZIP 바이트를 보낸다. `projectId`의 빈 값은 팀 공통 공간이며 `parentId`의 빈 값은 최상위다. 현재 작업자 기준으로 `{id,format,projectId,parentId,expiresAt,pages,warnings,attachmentCount}`를 반환한다. `format`은 `teamspace`, `docmost`, `markdown` 중 하나다. `pages`에는 `{path,parentPath,title,attachmentCount}`, `warnings`에는 `{path,message}`가 들어간다.

`POST /api/document-markdown-import/apply?previewId=<ID>`에 같은 작업자와 ZIP 바이트를 보낸다. 미리보기는 30분 동안 적용할 수 있다. 대상 공간과 상위 문서가 미리보기 이후 바뀌었거나 파일이 다르면 `409`로 새 미리보기를 요청한다. 성공하면 `{documentIds,rootIds,attachmentCount,duplicate}`를 `201`로 반환한다. 7일 안에 같은 요청을 다시 보내면 같은 문서 ID와 `duplicate: true`를 `200`으로 돌려준다. 문서·첫 이력·활동·첨부·적용 기록을 함께 저장하며 자체 JSON 복원 시 적용 기록을 초기화한다.

압축 전후 각각 64MiB, UTF-8 `.md` 한 파일당 512KiB, 변환한 본문 합계 64MiB, 문서 500개, 첨부 후보 1,500개와 파일당 20MiB까지 처리한다. Teamspace ZIP은 명세의 계층·첨부 소유권·크기·SHA-256을 확인한다. Docmost ZIP은 메타데이터가 지정한 계층과 순서·아이콘을 사용한다. 일반 ZIP은 상위 문서 이름과 같은 폴더, 폴더의 `index.md` 또는 `README.md`에서 상위 문서를 확인한다. Docmost·일반 ZIP은 본문 경로로 확인한 파일을 가져오며 나머지 파일은 검토 안내에 표시한다.

문서·절, 첨부 상대 링크는 새 주소로 연결한다. 단독 Markdown 이미지가 ZIP 안의 PNG·JPEG·GIF·WebP를 가리키면 이미지 블록으로 가져온다. 작업자를 각 새 초안의 작성자로 기록한다. 구조나 크기 오류가 있으면 전체 적용을 보류한다.

ZIP 안의 HTML 표는 셀의 범위가 격자와 일치하고 지원하는 마크업으로 작성된 경우 편집 가능한 표로 가져온다. 표마다 병합을 펼친 격자 30,000칸과 개별 셀의 가로·세로 병합 100칸까지 검증한다. 머리글과 일반 셀, 가로·세로 병합과 셀 정렬을 보존한다. 셀 안 본문의 문서·절 링크와 패키지 첨부는 기존 경로 규칙을 사용한다. 확인할 수 없는 표는 미리보기에 변환 안내를 남기고 HTML 원문을 텍스트로 가져온다.

## 문서 라벨

브라우저와 `/api/v1`의 문서 생성·수정 경로는 선택 필드 `labels`를 받는다. 문서당 최대 20개, 라벨당 최대 60 UTF-16 코드 단위를 허용한다. 앞뒤 공백을 제거하고 NFC로 정규화하며, 대소문자 차이는 같은 라벨로 취급한다. 같은 라벨이 반복되면 처음 입력한 표기를 유지한다. 수정에서 `labels`를 생략하면 현재 값을 유지하고 `[]`를 보내면 모두 지운다.

라벨은 공동 편집에서 본문과 별도로 저장하는 문서 속성이다. 과거 본문을 복구하면 현재 라벨을 유지한다. 자체 백업 형식 58은 문서와 휴지통의 라벨을 보존한다. 문서 목록의 주소는 `#/project-id/documents?label=…` 형태로 필터를 공유한다. `GET /api/search?q=…`의 문서 결과에는 제목·본문·라벨에서 검색어를 찾은 문서가 포함된다.

## 문서에서 후속 업무 만들기

`POST /api/v1/documents/:id/follow-up-issues`와 브라우저용 `POST /api/documents/:id/follow-up-issues`에 `{requestId, expectedDocumentVersion, issue}`를 보낸다. `requestId`는 새 요청마다 생성하는 UUID v4이며 `issue`는 일반 티켓 생성과 같은 입력을 사용한다. 프로젝트 문서라면 `issue.projectId`에 문서의 프로젝트를 지정한다. 공통 문서에서는 생성할 프로젝트를 지정한다. 신규 요청은 문서 버전을 검사하고 업무, 번호, 연결 및 활동 기록을 함께 저장한다. 최초 응답은 `201`과 `{issue, link, duplicate:false}`를 반환한다.

선택한 원문을 연결하려면 `sourceSelection`에 저장 본문의 ProseMirror 위치 `{from,to,text}`를 보낸다. 텍스트는 선택 범위에서 구한 최대 2,000 UTF-16 단위의 발췌이며, 문단과 줄바꿈은 LF로 연결한다. 서버가 저장된 본문에서 같은 범위를 다시 읽고 텍스트가 다르면 `409`를 반환한다. 정확히 일치하면 `link.documentSource`에 `{revisionId,from,to,text}`를 기록한다. 저장본이 필요하면 업무와 함께 생성한다. 원문은 `GET /api/documents/:id/include-revisions/:revisionId`에서 읽으며, 자체 백업 형식 36은 이 연결을 보존한다.

브라우저의 체크리스트 명령은 커서가 있는 항목의 첫 문단을 `sourceSelection`으로 보낸다. 새 업무의 화면은 이를 한 줄로 정리해 수정 가능한 제목에 채운다. 문서가 바뀌면서 요청이 거절되면 해당 업무 양식의 입력을 유지하고 최신 저장본에서 항목을 다시 고를 수 있다.

브라우저의 `GET /api/documents/:id/checklist-work?expectedDocumentVersion=…`는 `{documentId,documentVersion,links:[{linkId,issueId,sourceSelection,pinnedSource?}]}`를 반환한다. `sourceSelection`은 현재 저장본에서 해당 항목의 첫 문단 범위와 텍스트다. 이전 저장본에 연결한 항목이면 `pinnedSource`에 연결 당시의 `{revisionId,from,to,text}`를 반환하고 저장된 연결의 원문은 보존한다. 서버는 원래 발췌를 대조한 뒤 문서 내 `taskItem.attrs.checklistItemId`로 현재 항목을 찾는다. ID가 없는 예전 연결은 연속 저장본의 체크리스트 구조와 문구에서 동일 항목을 확인할 수 있을 때 표시한다. 항목을 확인할 수 없으면 문서의 전체 연결 목록에서 티켓을 연다. 저장 버전이 달라지면 `409`를 반환한다. 체크리스트 항목 ID는 문서 JSON·공동 편집 형식 15와 자체 백업 형식 108부터 보관한다.

문장 댓글에서 시작할 때는 `sourceComment: {commentId,revisionId}`를 사용한다. `sourceSelection`과 `sourceComment` 중 하나를 선택한다. `expectedDocumentVersion`에는 현재 문서 버전을, `revisionId`에는 댓글에 고정된 원문 저장본을 보낸다. 서버가 같은 문서에 있는 활성 문장 댓글과 저장본의 실제 텍스트·범위, API 키의 원문 범위를 확인한 뒤 `link.documentSource`에 같은 발췌를 기록한다. 댓글이 휴지통으로 이동했거나 원래 문장 댓글이 아니면 새 요청을 보류한다.

응답을 받지 못하면 같은 작업자와 문서에서 같은 요청 ID와 본문으로 재시도한다. 기존 업무와 연결을 열 수 있으면 `200`과 `{issue, link, duplicate:true}`로 응답한다. 요청 내용이나 연결 상태가 바뀌면 `409`를 반환한다. 자체 백업은 업무와 `후속 업무` 연결을 보존하며 복원 시 재시도용 기록을 초기화한다.

## 기존 업무에 문서 결정 근거 연결

`POST /api/v1/documents/:id/decision-links`와 브라우저용 `POST /api/documents/:id/decision-links`에 `{requestId, expectedDocumentVersion, issueId}`와 함께 `sourceSelection` 또는 `sourceComment` 중 하나를 보낸다. `requestId`는 UUID v4다. `sourceSelection`은 후속 업무와 같은 `{from,to,text}` 형식이며, 서버는 현재 저장 버전의 선택 범위를 읽어 발췌를 확인한다. `sourceComment`는 이 문서의 활성 문장 댓글과 그때 고정한 원문을 지정하는 `{commentId,revisionId}`다. 문서가 이후 편집됐어도 `expectedDocumentVersion`에는 현재 버전을 보내고 댓글의 발췌는 고정한 저장본에서 확인한다. 기존 문서 연결이 있으면 ID와 관계 유형을 유지하면서 근거를 추가한다. 연결이 없으면 `결정 근거` 관계를 만들고, 원문 저장본이 필요하면 같은 트랜잭션에 기록한다.

발췌를 처음 저장하면 `201`과 `{issue,link,duplicate:false}`를 반환한다. 작업자와 요청 내용이 같은 재시도, 또는 같은 저장본의 동일한 발췌는 `200`과 `duplicate:true`를 반환한다. 저장된 버전이나 선택한 텍스트가 다른 경우, 또는 문서와 티켓 사이에 다른 결정 근거가 이미 있는 경우 `409`를 반환한다. 새 요청에서 댓글이나 고정 원문을 확인할 수 없으면 `details.reason`에 `comment_source_unavailable`을 반환한다. 저장 후 댓글이 보관돼도 연결과 원문에 접근할 수 있으면 같은 요청으로 결과를 확인한다. 연결을 해제한 뒤 이전 요청을 보내면 `409`를 반환한다. 자체 백업 형식 48은 기존 업무에 저장된 발췌와 원문 저장본을 보존하고, 복원할 때 재시도 기록을 초기화한다.

두 `/api/v1` 요청에는 문서와 업무 프로젝트를 포함하는 쓰기 키가 필요하다. 공통 문서는 전체 프로젝트 쓰기 키로 연결한다. 발췌를 저장할 때는 선택한 문서 본문의 참조 범위를 확인한다. 결과를 반환하거나 재시도할 때는 문서와 현재 업무, 실제 고정 저장본을 다시 검사한다. 범위 밖 프로젝트 또는 원문이면 `403`을 반환한다. 허용된 고정 저장본은 문서의 `/api/v1/documents/:id/revisions`에서 읽을 수 있다.

## 프로젝트 결정 후속 업무

`GET /api/projects/:id/decision-follow-ups`와 `/api/v1`의 같은 경로는 결정 근거가 연결된 현재 티켓을 프로젝트 기준으로 읽는다. `status`는 `open`(기본값), `closed`, `all` 중 하나다. `assigneeId`에는 팀원 ID 또는 `unassigned`를 쓴다. `q`는 최대 160 UTF-16 코드 단위의 검색어로 현재 업무 키·제목, Jira 원래 키, 프로젝트 이동 전 업무 키와 현재·고정 문서 제목을 대소문자 없이 비교한다. 이전 키로 검색해도 행의 업무에는 현재 키를 반환한다. `unscheduledOnly=1`은 계획 시작일이나 종료일 중 하나 이상이 비어 있는 업무만 포함한다. `0`과 생략은 모든 일정 상태를 포함한다. `offset`은 기본 0이며 정수 0~1,000,000을 받는다.

`{projectId,generatedAt,revision,total,offset,limit,items}`에 조건을 통과한 연결을 20건씩 반환한다. `generatedAt`은 조회 시각이며 `revision`은 적용한 조건과 현재 페이지의 조회 버전이다. 목표 마감일 또는 계획 종료일이 이른 업무를 먼저 보여준다. 날짜가 없는 업무는 뒤에 두고 같은 날짜에서는 원문 저장 시각 내림차순, 연결 ID 오름차순으로 정렬한다. 각 행에는 `linkId`, 현재 `issue`와 `document`, 고정 `source`의 버전 ID·버전·당시 제목·시각·선택 위치를 제공한다. 업무의 `startDate`와 `endDate`는 각각 유효한 계획 날짜 또는 `null`이다. 기한 정보는 `deadline`과 `deadlineSource`에서 읽는다. 휴지통에서 업무나 문서를 복원하면 현재 활성 연결을 다시 조회할 수 있다.

`GET /api/projects/:id/decision-follow-ups/:linkId/source`와 `/api/v1`의 같은 경로는 현재 연결과 고정 저장본의 발췌를 다시 대조해 `{linkId,documentId,source}`를 반환한다. `source`의 `{revisionId,from,to,text}`를 기존 고정 원문 뷰어에 전달할 수 있다. 범위 제한 키는 업무와 원본 문서 양쪽 프로젝트를 포함해야 한다. 공통 문서는 전체 프로젝트 키로 읽는다. 목록과 합계에는 허용된 행만 포함되며, 발췌 조회에는 원문 저장본의 본문 접근 범위도 적용한다.

## 팀 결정 후속 업무

`GET /api/decision-follow-ups`와 `/api/v1/decision-follow-ups`는 프로젝트 보고서와 같은 조건으로 여러 프로젝트를 조회한다. `projectId`를 생략하면 권한이 있는 전체 프로젝트의 결과를 함께 정렬하고 응답의 `projectId`는 `null`이다. 특정 프로젝트 ID를 보내면 해당 프로젝트의 업무를 대상으로 하고 응답에 그 ID가 표시된다. 상태 분류와 이름은 각 업무가 현재 속한 프로젝트의 워크플로를 사용한다. 범위 제한 키에서는 업무와 문서의 프로젝트가 모두 허용된 항목만 합계와 목록에 포함한다. 팀 공통 문서는 전체 프로젝트 키에서 조회한다.

저장된 발췌는 각 행의 `issue.projectId`와 `linkId`를 사용해 프로젝트 보고서의 원문 경로에서 연다. 팀 보고서 화면 주소에는 `scope=team`과 선택한 경우의 `decisionProject`가 들어간다.

### 결정 후속 업무 회의 초안

브라우저의 `POST /api/projects/:id/decision-follow-ups/meeting-draft` 또는 `POST /api/decision-follow-ups/meeting-draft`에 `requestId`, 직전 GET의 `revision`, 제목 `title`, `destinationProjectId`와 현재 조회 조건을 보낸다. `requestId`는 UUID v4, 제목은 공백을 정리한 뒤 1~200자다. `destinationProjectId`는 저장할 프로젝트 ID 또는 팀 공통 문서를 뜻하는 `null`이다. `status`, `assigneeId`, `q`는 GET과 같은 조건을 사용한다. `unscheduledOnly`는 선택 불리언이고 `offset`은 정수다. 팀 경로에서만 `projectId`로 보고서의 프로젝트를 지정한다.

초안에는 해당 페이지의 결정 근거 최대 20건과 현재 티켓 상태·담당자·기한·계획 시작일과 종료일을 기록한다. 원문 저장본과 대조한 발췌를 문서에 복사하고 확인할 수 없는 발췌는 안내를 표시한다. 원래 티켓과 문서 참조, 일정 미정 조건을 포함한 같은 조건과 페이지로 돌아가는 보고서 링크를 보관한다. 신규 응답은 `201`과 `{document,duplicate:false}`다. 같은 작업자·입력의 재시도는 `200`과 저장한 문서를 반환한다. 요청한 보고서 유형, 조회 조건이나 페이지가 바뀌면 `409`의 `details.reason`은 `stale_report`다. 빈 페이지 또는 사라진 저장 위치에는 `422`를 반환하며, 저장 위치 오류의 `details.reason`은 `destination_unavailable`이다. 생성은 팀 브라우저 세션에서 사용한다.

## 문장 댓글

브라우저의 `POST /api/documents/:id/selection-comments`에 `{requestId,expectedDocumentVersion,sourceSelection,body}`를 보낸다. `requestId`는 UUID v4다. `sourceSelection`은 저장된 본문의 ProseMirror 위치 `{from,to,text}`이며 최대 2,000 UTF-16 단위를 선택한다. 댓글은 공백을 정리한 뒤 20,000자까지 받는다. 서버는 버전과 발췌를 대조하고, 필요하면 원문 저장본을 댓글·활동·알림과 함께 기록한다.

신규 응답은 `201`과 `{comment,duplicate:false}`다. 같은 작업자·문서·입력의 재시도는 `200`과 `duplicate:true`를 반환한다. 버전이나 발췌가 달라지면 `409`의 `details.reason`은 `source_version_changed` 또는 `source_selection_changed`다. 휴지통으로 옮긴 댓글의 원래 요청을 보내면 `409`를 반환한다.

일반 댓글 조회는 문장 댓글의 `documentSource: {revisionId,from,to,text}`를 포함한다. 원문은 `GET /api/documents/:id/include-revisions/:revisionId`로 읽는다. 범위 제한 `/api/v1/comments` 조회에서는 키로 읽을 수 있는 원문 저장본의 발췌를 반환한다. 자체 백업 형식 50은 활성 댓글과 휴지통 댓글의 발췌를 보존한다.

### 문장 댓글 해결과 재개

브라우저의 `PATCH /api/documents/:id/selection-comments/:commentId/resolution`에 `X-Actor-Id`와 `{state,expectedVersion}`을 보낸다. `state`는 `open` 또는 `resolved`다. 최초 열린 댓글은 별도 `resolution` 없이 버전 0으로 읽는다. 변경 응답은 `resolution`의 상태·버전·`changedAt`·`actorId`를 포함한 전체 댓글이다. 현재 버전에 같은 상태를 요청하면 같은 값을 돌려준다. 편집 버전이 오래되면 `409`와 `details.reason`의 `resolution_version_changed`, `currentVersion`을 반환한다. 경로는 해당 문서에서 현재 열 수 있는 문장 댓글을 대상으로 한다.

댓글 목록과 문장 댓글 등록의 재시도 응답에도 현재 상태가 표시된다. 자체 백업 형식 73은 활성·휴지통 문장 댓글의 처리 기록을 보존하며, 같은 작업공간의 이전 기록을 되돌릴 때 편집 버전을 높여 이전 화면의 덮어쓰기를 막는다. 댓글 주소의 `?comment=<ID>`는 문서에서 해당 댓글을 연다.

### 문장 댓글 답글

브라우저의 `POST /api/documents/:id/selection-comments/:commentId/replies`에 `{requestId,expectedResolutionVersion,body,mentions?}`를 보낸다. `requestId`는 UUID v4이고 `expectedResolutionVersion`은 원래 댓글의 현재 해결 버전이다. 해결을 아직 기록하지 않은 댓글은 버전 0을 사용한다. 브라우저에서 댓글을 작성할 때와 같은 본문·멘션 규칙을 적용한다. 새 답글은 `{comment,duplicate:false}`와 `201`을 반환하고 `comment.parentCommentId`로 원래 문장 댓글을 가리킨다.

새 답글은 같은 문서의 열린 문장 댓글에 쓴다. 해결 상태 또는 버전이 바뀌면 `409`와 `details.reason`의 `thread_resolved` 또는 `thread_changed`, `currentResolutionVersion`을 반환한다. 원래 댓글을 찾을 수 없으면 `404`와 `thread_missing`을 반환한다. 같은 작업자가 요청 ID·해결 버전·본문·멘션을 그대로 보내면 대화가 해결된 뒤에도 이미 저장한 활성 답글을 `200`과 `duplicate:true`로 반환한다. 요청 ID를 다른 입력에 재사용하면 `409`와 `request_reused`를, 저장한 답글이나 원래 댓글을 조회할 수 없으면 `409`와 `receipt_unavailable`을 반환한다.

댓글 읽기 응답에는 답글의 `parentCommentId`가 포함된다. 프로젝트 범위 키의 읽기에는 원래 댓글의 고정 원문 범위도 적용한다. 답글 알림의 `commentId`는 답글을 가리키며 `?comment=<ID>`로 열 수 있다. 자체 백업 형식 77은 문서·댓글의 활성 및 휴지통 데이터와 답글 알림을 보존한다. 원래 댓글을 휴지통에 넣을 때 함께 보관한 답글은 원래 댓글과 함께 복원한다. 별도로 휴지통에 넣은 답글은 원래 댓글이 활성일 때 복원할 수 있다. 물리 백업은 댓글 요청 기록을 보존한다.

### 등록한 댓글 수정

`GET /api/comments/:id/edit`에서 `{comment,editToken}`을 조회한다. `PATCH /api/comments/:id`에 `{editToken,requestId,body,mentions?}`를 보낸다. `requestId`는 요청마다 발급한 UUID v4다. 현재 등록된 댓글의 작성자가 수정할 수 있다. 쓰기 키의 `/api/v1`에서도 같은 계약을 사용하며, 키의 작업자가 작성자여야 한다. 대상 프로젝트와 문장 댓글 또는 답글의 고정 원문도 키의 범위 안에 있어야 한다.

응답은 `{comment,editToken,duplicate}`다. 변경한 댓글에는 `editVersion`과 `editedAt`이 붙는다. 수정은 기존 댓글 ID와 등록 시각, 원문 선택 위치, 답글과 해결 상태를 보존한다. 달라진 댓글을 이전 토큰으로 저장하면 `409`와 `comment_edit_conflict`를 반환한다. 같은 요청 ID와 입력을 다시 보내면 현재 댓글과 `duplicate:true`를 반환한다. 요청 ID를 다른 입력에 재사용하면 `409`와 `comment_edit_request_reused`를 반환한다.

수정한 본문에서 유지할 멘션의 전체 범위를 `mentions`로 보낸다. 배열을 생략하거나 비우면 현재 멘션을 해제한다. 새로 멘션한 팀원이 알림을 받는다. 자체 백업 형식 89는 활성·휴지통 댓글의 수정 시각과 버전을 보존한다. 자체 백업으로 작업공간을 교체하면 편집 토큰을 새로 받아야 한다.

### 댓글 멘션

일반 댓글 `POST /api/comments`와 문장 댓글 등록 요청에 `mentions` 배열을 추가할 수 있다. 각 항목은 `userId`, `from`, `to`를 사용한다. 양 끝의 공백을 정리한 `body`에서 `from`을 포함하고 `to`는 제외하는 UTF-16 위치다. 범위는 시작 위치순으로 최대 50개를 보내며, 각 범위가 겹치지 않고 `@`와 현재 팀원 이름을 정확히 담아야 한다. 같은 이름의 팀원은 ID로 구분한다. 배열을 생략하거나 비우면 일반 댓글과 같은 방식으로 처리한다.

저장 응답과 조회 목록에 멘션 범위를 포함한다. 문장 댓글을 재시도할 때 기존 요청 ID와 멘션을 함께 보낸다. `issue-comment-mentioned`와 `document-comment-mentioned`는 알림 대상 업무나 문서의 ID와 함께 `commentId`를 반환한다. 자체 백업 형식 71은 댓글의 멘션, 멘션 알림과 읽음 시각을 보존한다.

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

담당자별 보드 이동은 `targetAssigneeId`를 보낸다. `null`은 담당자 미지정 줄이다. 기준 카드가 있으면 대상 상태와 담당자에 속해야 한다. 줄을 바꿀 때는 같은 값의 `assigneeId`를 보내 재배정하고, 같은 줄의 순서·상태 이동에는 `targetAssigneeId`만 보낸다. `assigneeId`를 명시하면 상태 전이와 같이 일반 업무 편집 규칙을 검사하며, 지정한 담당자를 적용한다. 순서·상태·담당자와 이력은 한 트랜잭션에 저장한다. 담당자가 바뀌면 새 업무 순서 버전을 발급한다.

자동화 클라이언트는 프로젝트 범위의 키로 `/api/v1/projects/:id/issue-order`에 같은 요청을 보낸다. 이동에는 쓰기 키가 필요하다.

## 백로그 또는 사이클에서 업무 생성

브라우저의 `POST /api/projects/:id/cycle-board/issues`에 `{requestId,targetCycle,issue}`를 보낸다. `requestId`는 UUID v4다. 백로그는 `targetCycle:null`을 보내고, 사이클은 `{id,expectedVersion}`을 보낸다. `issue`는 일반 생성 양식의 필드를 사용하며, 프로젝트 ID를 보내면 주소의 프로젝트와 같아야 한다. 사이클은 `targetCycle`로 지정한다.

사이클은 같은 프로젝트의 `planned` 또는 `active` 상태여야 한다. 현재 상태·소속·버전이 선택한 대상과 다르면 `409`와 `details.reason: 'target_cycle_changed'`를 반환한다. 확인한 사이클이 같은 프로젝트에 있으면 `details.currentCycleVersion`도 반환한다. 유효한 요청은 일반 생성 규칙과 템플릿을 적용하고 업무·사이클 배정·프로젝트 순서·생성 이력을 한 트랜잭션에 저장한 뒤 `201`과 업무를 반환한다.

응답을 받지 못한 경우 같은 작업자·프로젝트·요청 ID·입력으로 다시 보낸다. 이미 저장한 요청은 `200`과 현재 업무를 반환한다. 사이클이 그 뒤 완료되거나 업무가 같은 프로젝트 안에서 다른 그룹으로 이동한 경우에도 읽을 수 있다. 같은 요청 ID에 다른 입력이나 프로젝트를 지정하면 `409`를 반환한다.

## 백로그와 사이클 사이에서 업무 이동

브라우저의 `POST /api/projects/:id/cycle-board/move`에 `requestId`(UUID v4), `issueId`, 조회한 프로젝트 순서의 `expectedVersion`, `expectedIssueVersion`, `sourceCycle`, `targetCycle`, `anchorId`, `position`을 보낸다. 사이클은 `{id,expectedVersion}`으로 지정한다. `null`은 사이클 미지정 백로그다. 출발·도착 사이클은 같은 프로젝트의 `planned` 또는 `active` 상태여야 한다.

`position`은 `before` 또는 `after`다. `anchorId`가 있으면 같은 프로젝트의 대상 그룹에 속한 업무여야 한다. `null`과 `before` 또는 `after`를 사용하면 실제 대상 그룹의 처음 또는 끝으로 이동한다. 대상 그룹이 비어 있으면 기존 프로젝트 순위를 유지한다. 순서와 업무·사이클의 버전이 일치할 때 배정·순서·이력을 한 트랜잭션에 기록한다. 다른 경로에서 사이클 배정이 바뀌어도 업무 순서 비교 버전이 갱신된다.

응답은 `{order,issue,duplicate}`다. 같은 작업자·프로젝트·요청 ID·입력으로 7일 이내에 재전송하면 현재 업무와 순서에 `duplicate:true`를 반환한다. 이전 이동이나 이력을 다시 쓰지 않는다. 현재 업무를 찾을 수 없거나 요청 ID·버전·배정이 충돌하면 `409`를 반환한다. 자체 JSON 복원은 배정과 순서를 보존하며 이동 요청 기록을 초기화한다. 물리 백업은 이동 요청 기록도 보존한다.

## Jira 필터를 공유 보기로 옮기기

`POST /api/views/jira/preview`에 `{projectId,jql}`을 보낸다. JQL에 프로젝트 조건이 없으면 선택한 Teamspace 프로젝트에서 검토한다. 원래 Jira 프로젝트 키와 ID는 이관 기록으로 소속이 확인될 때 사용할 수 있다. 현재 프로젝트의 키와 이름도 사용할 수 있다. 같은 이름의 상태·유형·팀원이 서로 다른 대상과 일치하거나 원본 프로젝트가 여러 개 합쳐진 경우에는 대응할 범위를 확인하도록 오류를 표시한다.

선택한 Teamspace 프로젝트가 Jira 원본 프로젝트 하나와 연결되면 현재 프로젝트의 이관 업무와 적용 영수증에서 원래 상태·업무 유형의 이름과 ID, 담당자·요청자 계정의 사용자 이름·사용자 키·계정 ID·확인된 이메일을 찾는다. Jira에서 담당자나 요청자로 확인한 같은 계정은 두 조건 모두에 사용할 수 있다. 여러 원본 값이 하나의 Teamspace 값에 합쳐졌거나, 하나의 검색값이 서로 다른 현재 값에 해당하면 변환을 보류한다. 미리보기에는 현재 이름을 표시하고, 저장한 보기에는 Teamspace ID를 사용한다. [Atlassian Jira Data Center JQL 필드](https://confluence.atlassian.com/jirasoftwareserver101/advanced-searching-fields-reference-1455427012.html)

최대 4,000자의 검색식에서 `AND`와 괄호를 사용할 수 있다. `project`·`status`·`issuetype`·`assignee`·`reporter`는 `=`로 비교하고, 담당자와 요청자는 `IS EMPTY`로 미지정을 확인한다. `status IN (...)`이나 상태 조건만 이어진 `OR`은 여러 상태를 고른 보기로 변환한다. `AND`로 연결된 상태 조건은 서로 겹치는 상태를 선택한다. 현재 상태를 확인할 수 없거나 겹치는 값이 없으면 오류를 표시한다. 라벨에는 `=`, `IN`, `!=`, `NOT IN`, `IS EMPTY`, `IS NOT EMPTY`를 사용할 수 있다. `labels !=`와 `labels NOT IN`은 라벨이 있는 업무에서 비교한다. 상태 외 조건이 들어간 `OR`, `currentUser()` 같은 동적 함수, 원본 이력과 텍스트 검색은 변환 오류로 표시한다. [JQL 필드](https://confluence.atlassian.com/jiracoreserver/advanced-searching-fields-reference-939937719.html) · [Atlassian JQL 연산자](https://confluence.atlassian.com/jiracoreserver/advanced-searching-operators-reference-939937721.html) · [Atlassian 빈 값 비교 안내](https://support.atlassian.com/jira/kb/why-my-jql-search-with-not-in-or-not-equals-operators-has-issues-missing/)

`due`와 `dueDate`는 따옴표로 감싼 `YYYY-MM-DD` 또는 `YYYY/MM/DD` 날짜를 `=`, `<`, `<=`, `>`, `>=`로 비교한다. `AND`로 연결한 조건들의 공통 범위를 `filters.planning.dates`의 `{mode:'due',from?,to?}`로 반환한다. 양 끝은 포함하며 `<`와 `>`의 경계는 하루 앞뒤로 옮긴다. 목표 마감일이 없는 업무는 결과에서 빠진다. 비어 있는 교집합, 상대 날짜나 날짜 함수, 날짜 집합과 빈 값 비교는 변환 오류로 표시한다. [Atlassian JQL 마감일](https://confluence.atlassian.com/jirasoftwareserver101/advanced-searching-fields-reference-1455427012.html#Advancedsearching-fieldsreference-Due)

`priority`는 `=`와 `IN`을 지원하며 `AND`의 교집합을 원본 값에서 먼저 계산한다. 이관 기록으로 한 Jira 프로젝트를 확인하면 같은 패키지의 옵션과 업무에 남은 ID·이름을 대조한다. CSV에 이름만 있으면 확인한 같은 이름의 범위를 사용할 수 있다. 숫자 ID는 해당 ID가 확인된 원본 값을 선택한다. 원본 이름이 여러 ID를 가리키거나 최종 조건이 같은 Teamspace 우선순위에 대응하는 원본 값 일부만 선택하면 변환 오류로 표시한다. 이관한 업무의 현재 값이 확인된 원본 매핑에서 어긋나거나 확인할 근거가 없는 업무가 선택한 우선순위에 있으면 저장을 보류한다. Jira 이관 연결이 없는 프로젝트에서는 Teamspace의 우선순위 코드와 한글 이름을 사용한다. 저장한 `filters.priorities`는 이후 새 티켓도 현재 값으로 조회한다. [Atlassian JQL 우선순위](https://confluence.atlassian.com/jiracoreserver/advanced-searching-fields-reference-939937719.html#Advancedsearching-fieldsreference-Priority)

미리보기는 적용할 `filters`, 읽을 수 있는 `criteria`, 입력한 `orderBy`, 조건에 맞는 업무 `total`과 처음 20개 `issues`, 검토 `revision`을 반환한다. `due`·`dueDate`, `created`·`createdDate`, `updated`·`updatedDate`에 `ASC` 또는 `DESC`를 명시하고 정렬 필드가 서로 다르면 같은 순서의 `sort`를 반환한다. Teamspace의 현재 날짜를 사용하고 비어 있는 날짜는 뒤에 표시한다. `Rank`, `priority`, 방향이 생략된 기준이나 지원하지 않는 기준이 섞인 정렬은 `requiresProjectOrderAcceptance: true`를 반환한다. [Atlassian JQL 정렬](https://support.atlassian.com/jira-software-cloud/docs/jql-keywords/) · [Atlassian Jira 우선순위 순서](https://confluence.atlassian.com/adminjiraserver/associating-priorities-with-projects-939514001.html)

`POST /api/views/jira/import`에 `{projectId,jql,name,layout,revision,acceptProjectOrder}`를 보낸다. `layout`은 `list` 또는 `board`다. `requiresProjectOrderAcceptance`가 있으면 `acceptProjectOrder:true`로 프로젝트 순서 적용을 확인한다. 변환 결과나 검토 업무가 바뀌면 `409`와 `details.code: 'stale_jira_view_preview'`를 반환한다. 성공 시 일반 공유 보기와 같은 형식으로 `filters`와 적용할 `sort`를 저장한다.

## 공유 보기의 정렬

`POST /api/views`와 `PATCH /api/views/:id`의 `sort`에 `{field,direction}` 배열을 우선순위 순으로 보낸다. `field`는 `dueDate`, `priority`, `startDate`, `endDate`, `createdAt`, `updatedAt`, `key`, `title` 중 하나이며 같은 필드를 두 번 지정할 수 없다. `direction`은 `asc` 또는 `desc`다. 날짜가 비어 있는 업무는 두 방향 모두 뒤에 배치한다. 우선순위는 `asc`일 때 낮음부터 긴급까지 정렬한다. 모든 정렬 값이 같으면 프로젝트 순서를 사용한다.

수정할 때 `sort`를 생략하면 저장값을 유지하고 `null` 또는 `[]`를 보내면 프로젝트 순서를 사용한다. 정렬 기준을 포함한 자체 백업은 형식 106을 사용한다. 목록, 보드의 각 그룹, 간트, 문서의 실시간 업무 목록과 업무 현황에서 이 순서를 사용한다.

## 공유 보기의 여러 상태

`POST /api/views`와 `PATCH /api/views/:id`의 `filters`에 `status: 'all'`과 `statusIds`를 함께 보내면, 지정한 ID 중 하나에 해당하는 업무를 고른다. 배열은 최대 40개 값이며 중복을 제거한다. 상태가 하나면 기존 `status` 필드로 저장한다. 여러 상태를 저장한 보기에서 이전 클라이언트가 `status: 'all'`만 보내면 배열을 유지한다. 모든 상태를 보려면 `statusIds: []`와 `status: 'all'`을 보내고, 단일 상태로 바꾸려면 해당 `status`를 보낸다. 현재 워크플로에서 사라진 ID는 조건에 남겨둔다. 상태 목록이 포함된 자체 백업은 형식 103을 사용한다.

`POST /api/issues/query`와 읽기 키의 `POST /api/v1/issues/query`는 `projectId`와 `statusIds` 배열로 프로젝트 업무를 조회한다. 우선순위·라벨·사용자 정의 필드와 함께 보내면 그 조건도 모두 적용한다. 빈 배열과 함께 조회하려면 다른 유효한 조건이 필요하다.

## 공유 보기의 보드 그룹

브라우저의 `POST /api/views`와 `PATCH /api/views/:id`에서 `layout: 'board'`와 `boardGrouping: 'assignee'`로 담당자별 보드를 저장한다. 수정 시 `boardGrouping`을 생략하면 설정을 유지하고 `null`을 보내면 지운다. `layout: 'list'`도 묶음을 지운다. 응답에서 `boardGrouping`이 없으면 기본 보드다. 자체 백업 형식 76은 이 표시 설정을 보존한다. 간트와 문서의 업무 목록·현황 및 보고서는 보기의 필터로 업무를 선택한다.

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
| `POST /api/integrations/gitlab/repository-search` | 저장 전 주소와 읽기 토큰으로 프로젝트 이름·네임스페이스 검색 또는 전체 경로 조회 |
| `POST /api/integrations/gitlab/sync-preview` | 저장 전 입력으로 저장소별 조회 결과와 MR·파이프라인 및 선택한 저장소 이력의 티켓 연결 후보 확인 |
| `POST /api/integrations/gitlab/sync` | 저장한 연결로 MR·파이프라인과 선택한 저장소 이력을 읽어 업무 링크 저장 |
| `GET /api/integrations/gitlab/sync-status` | 저장한 연결 설정 버전과 저장소별 최근 활동·배포 수동 동기화 결과 |
| `POST /api/integrations/gitlab/webhook` | 허용 저장소의 인증된 이벤트 수신 |
| `GET /api/integrations/gitlab/webhook-status` | 저장한 연결 설정 버전과 허용 저장소별 최근 인증 수신 및 이벤트별 반영 요약 |
| `POST /api/integrations/gitlab/project-webhook-review` | 저장한 저장소의 프로젝트 웹훅을 조회하고 수신 주소와 이벤트 설정 점검 |
| `POST /api/integrations/gitlab/project-webhook-register` | 점검에서 누락된 저장소 한 곳에 프로젝트 웹훅 등록 |
| `POST /api/integrations/gitlab/project-webhook-history` | 현재 수신 주소와 일치하는 훅의 GitLab 전송 결과와 저장소의 최근 인증 수신 조회 |
| `GET /api/automation-rules?projectId=...` | 규칙 목록 |
| `POST /api/automation-rules` | 규칙 생성 |
| `PATCH /api/automation-rules/:id` · `DELETE /api/automation-rules/:id` | `expectedVersion`으로 변경·삭제 |
| `POST /api/automation/preview` | `{rule,issueIds,sample}`로 브랜치·파이프라인·배포 환경 조건 미리보기 |
| `GET /api/automation-runs?projectId=...&limit=100` | 최근 실행·차단·무시 이유, 최대500건 |

자격 증명 `token`·`webhookSecret`·`signingToken`은 서버에 암호화한다. PATCH에서 빈 문자열을 보내면 해당 값을 지운다. 웹훅 인증 값을 생략하면 유지한다. 주소를 유지하면 생략한 읽기 토큰을 유지하고, 다른 주소를 저장할 때는 새로 제공한 토큰을 사용하거나 기존 읽기 토큰을 해제한다. 다른 주소를 저장하면 마지막 조회 결과도 초기화한다. GET은 설정 여부만 반환한다. 초기 설정 버전은 1이다. 주소·허용 저장소 변경 또는 웹훅 인증 해제 시 규칙을 비활성화하고 버전을 올린다. 설정 변경 중인 동기화와 미리보기 결과는 폐기한다.

**저장소 검색**은 `{expectedVersion,query,page?,baseUrl?,token?}`을 받는다. 검색어는 1~200자이고 페이지는 1~20이다. 프로젝트 이름이나 그룹 이름으로 검색하면 페이지당 최대 20개를 응답한다. `group/subgroup/repository`처럼 전체 경로를 입력하면 첫 페이지에서 해당 프로젝트를 조회한다. 보관된 저장소는 제외한다. 입력한 주소가 저장한 주소와 같을 때만 생략한 읽기 토큰을 재사용한다. 결과는 `settingsVersion`, `page`, `hasNextPage`와 검증한 저장소의 `id`, `name`, `pathWithNamespace`, `webUrl`을 담는다. GitLab에는 읽기 요청을 보내며 Teamspace 연결 설정·업무·활동을 저장하지 않는다. [GitLab Projects API](https://docs.gitlab.com/api/projects/#list-all-projects)

**연결 미리보기**는 현재 `expectedVersion`과 선택적인 `baseUrl`, `projectIds`, `token`, `jiraRoutes`를 받는다. 저장한 주소와 입력 주소가 일치하면 생략한 읽기 토큰을 재사용한다. 주소가 달라지면 새로 입력한 토큰이나 익명 읽기를 사용한다. 미리보기 결과에는 저장소별 조회 성공·오류, 조회한 MR·파이프라인 수, 새 연결·갱신·유지 예상 건수와 최대 100개 연결 후보가 포함된다. 설정, 티켓, 연결과 자동화 실행 기록을 읽기 전용으로 처리한다.

수동 동기화는 조회를 완료한 저장소를 반영하고 `repositories`에 저장소별 결과를 돌려준다. 성공과 실패가 섞이면 `partial: true`가 표시된다. 요청한 저장소가 모두 실패하면 새 링크를 저장하지 않고 502 응답에 저장소별 실패 사유를 전달한다. `{repositoryIds,expectedVersion,includeHistory?}`로 현재 설정에 있는 저장소만 골라 다시 시도할 수 있다. 그 사이 연결 설정이 변경되면 선택 재시도를 거절한다.

`sync-status`는 Teamspace에 저장된 `settingsVersion`과 `{repositoryId,activity,deployments}` 배열을 `repositories`로 반환한다. 각 종류의 결과가 아직 없으면 `null`이다. 기록이 있으면 이미 완료된 시도 중 가장 최근에 시작한 시도의 `completedAt`과 마지막 성공 시각 `lastSuccessfulAt`이 들어간다. 이전 성공 기록이 없으면 `lastSuccessfulAt`은 `null`이다. `activity`는 `includeHistory`와 저장소별 `result`, `deployments`는 `status`와 성공 통계 `result` 또는 오류 `error`를 담는다. 오류 요약에는 단계, 확인된 HTTP 상태와 고정 메시지만 들어간다. GitLab 주소나 읽기 토큰이 바뀌면 두 종류의 요약을 초기화한다. 저장소 제거는 해당 저장소의 두 요약, Jira 매핑 변경은 해당 저장소의 활동 요약에 적용한다. 물리 백업은 요약을 보존하며 자체 JSON 가져오기는 초기화한다.

미리보기와 동기화는 GitLab 저장소마다 최근 MR 최대 1,000개와 최근 파이프라인 50개를 읽는다. 파이프라인의 직접 티켓 키를 적용하고, MR에서 가져오는 키에는 저장소·브랜치·head SHA 일치를 요구한다. 조회당 10초와 디코딩된 응답 16MiB 한도가 적용된다. [GitLab MR 조회](https://docs.gitlab.com/api/merge_requests/), [GitLab 파이프라인 조회](https://docs.gitlab.com/api/pipelines/).

규칙에는 프로젝트, 이름, `enabled`, `trigger`, 비어 있지 않은 `gitlabProjectIds`·`fromStatuses`, `issueTypes`(빈 목록은 모든 유형), `toStatusId`, 실행 팀원 `actorId`, `priority`(0~10000)가 필요하다. MR·파이프라인 규칙의 `branchPattern`은 브랜치 또는 태그 이름에 적용하는 최대 128자 패턴이며 `*`·`?`를 와일드카드로 사용한다. 낮은 우선순위 숫자, 같은 값이면 ID 순으로 첫 조건 일치 규칙 하나만 적용한다. MR의 미리보기 `sample`은 `{trigger,gitlabProjectId,branch}`다. 미리보기는 입력 규칙과 현재 티켓으로 결과를 계산하며 티켓·규칙·이력을 저장하지 않는다.

파이프라인 규칙은 `pipelineSources` 배열과 `pipelineRefKind`(`branch` 또는 `tag`)를 선택적으로 저장한다. 실행 유형은 영문 소문자로 시작하는 1~64자의 소문자·숫자·밑줄 문자열이며, 최대 64개를 중복 없이 넣을 수 있다. 선택한 실행 유형 중 하나에 일치해야 하고 참조 유형까지 쓰면 두 조건을 모두 충족해야 한다. PATCH에서 필드를 생략하면 현재 값을 유지한다. `pipelineSources: []`, `pipelineRefKind: null`로 각 조건을 해제하거나 트리거를 파이프라인 외 유형으로 바꿔 두 조건을 해제할 수 있다. 미리보기 `sample`은 `{trigger,gitlabProjectId,branch,pipelineSource?,pipelineTag?}`다. `pipelineTag: false`는 브랜치, `true`는 태그이며 생략은 미확인이다. 규칙에 지정한 조건의 값을 확인할 수 없으면 미리보기와 실제 실행 모두에서 해당 규칙의 적용 대상에서 빠진다. 실행 기록의 `context`에는 확인한 `pipelineSource`·`pipelineTag`를 저장한다. 자체 백업 형식 112는 이 필드와 규칙을 보존하며 복원한 규칙은 비활성 상태로 시작한다. [GitLab 실행 유형](https://docs.gitlab.com/ci/jobs/job_rules/#ci_pipeline_source-predefined-variable) · [GitLab 파이프라인 웹훅](https://docs.gitlab.com/user/project/integrations/webhook_events/#pipeline-events)

트리거는 `merge_request.opened`(open/reopen), `merge_request.merged`, `merge_request.closed`, `pipeline.succeeded`, `pipeline.failed`, `deployment.succeeded`다. 현재 전이·필수 속성 검증이 실패하면 차단 이유를 남긴다. 이미 도착 상태이면 업무 버전을 유지한다. 활성화 전, 오래된 이벤트, 같은 시각의 모순, 확인할 수 없는 시각의 이벤트는 상태 변경을 생략한다. 이벤트 중복과 객체·파이프라인 순서는 서버에서 검사한다. 저장된 MR에서 파이프라인 업무를 찾을 때는 브랜치와 head SHA가 함께 일치해야 한다.

배포 성공 규칙의 `environment`는 GitLab의 정확한 환경 이름이며 대소문자를 구분한다. 공백으로 시작하거나 끝나는 문자열과 제어 문자를 제외한 1~255자를 받는다. 미리보기 `sample`은 `{trigger:'deployment.succeeded',gitlabProjectId,environment}`다. 실제 실행은 활성화 이후 발생한 인증 성공 이벤트에서 같은 저장소의 전체 SHA나 포함 MR ID·IID가 자동 업무 연결과 일치할 때만 평가한다. 첫 성공 이벤트의 처리는 배포 ID별로 한 번 기록하며 상태 이력 동기화는 읽은 배포와 MR 근거를 보관한다. 실행 기록에는 `context.objectKind: 'deployment'`, `context.objectId`, `context.environment`가 남는다. 자체 백업 형식 75는 배포 규칙과 실행 기록을 보존하며 규칙을 비활성 상태로 복원한다.

브라우저용 `GET /api/issues/:id/automation-runs`는 해당 티켓에 저장된 최근 실행을 20건씩 반환한다. `nextCursor`를 `before`로 보내 이전 기록을 연다. `issueVersion`은 조회 시점의 티켓 버전이고, `latestBlockedRunId`는 가장 최근 유효 실행이 차단됐으며 현재 출발 상태와 전이가 맞을 때 표시한다. 새 실행의 `context`에 저장소·객체·브랜치, 규칙 이름과 당시 상태 표시 이름을 담는다. 목표 상태를 사용한 편집은 일반 티켓 저장 API의 버전·전이·필수 필드 검사를 거친다.

GitLab의 Secret Token 방식은 `X-Gitlab-Token`으로 인증한다. Signing Token 방식은 `whsec_` 뒤의32바이트 Base64 키와 Standard Webhooks 헤더를 사용한다. 서명 헤더가 있으면 원문 JSON 바이트의 HMAC-SHA256와 최근5분 이내 서명 시각을 검증한다. 잘못된 서명을 Secret Token으로 우회하지 않는다. GitLab 설정 방법과 이벤트 필드는 [공식 웹훅 문서](https://docs.gitlab.com/user/project/integrations/webhooks/), [이벤트 문서](https://docs.gitlab.com/user/project/integrations/webhook_events/)를 참고한다.

`webhook-status`는 `settingsVersion`과 `repositories`를 반환한다. 각 저장소에 `repositoryId`와 `lastDelivery`가 들어간다. `lastDelivery`는 인증된 수신이 없으면 `null`이다. 수신이 있으면 `event`, `authentication`, 서버의 `receivedAt`, `duplicate`, 업무 연결 반영 수 `linked`, 자동화 기록 수 `automationRuns`를 포함한다. 자동화 기록 수에는 차단이나 무시 결과도 포함될 수 있다. 중복을 제외한 수신이 기록된 경우 `lastAcceptedByEvent`에 `push`, `merge_request`, `pipeline`, `deployment` 가운데 해당하는 유형별 최근 요약을 반환한다. 같은 유형의 재전송은 `lastDelivery`에 기록되고 유형별 요약은 유지된다. 이전 물리 사본에서는 확인 가능한 마지막 수신 한 건으로 시작한다.

원문, 헤더, 비밀값은 수신 요약에 저장하지 않는다. 주소나 웹훅 인증값을 바꾸면 요약을 초기화하고, 저장소 제거와 Jira 매핑 변경은 해당 저장소에만 적용한다. 읽기 토큰 변경은 수신 요약을 유지한다. 별도 물리 복원은 요약을 보존하며 자체 JSON 가져오기는 초기화한다.

### GitLab 프로젝트 웹훅 점검과 등록

팀 접속 모드의 `TEAMSPACE_PILOT_ORIGIN`으로 검증한 HTTPS 주소에서 수신 경로 `/api/integrations/gitlab/webhook`을 구성한다. 설정 조회의 `webhookReceiverUrl`로 확인한다. 점검과 등록에는 저장된 GitLab 주소와 저장소를 사용한다.

점검은 `{expectedVersion,repositoryId,managementToken?}`을 받는다. 관리 토큰을 생략하면 저장한 읽기 토큰으로 조회한다. 페이지당 100개씩 최대 10페이지를 읽고, 다음 페이지나 응답을 검증할 수 없으면 누락을 판정하지 않는다. 응답은 `settingsVersion`, `repositoryId`, `receiverUrl`, `authMode`, `state`와 같은 수신 경로의 `hooks` ID·설정 여부를 담는다. 필요 설정이 갖춰지면 `configured`, 주소의 세부 경로나 이벤트·SSL·브랜치·전송 조건을 검토해야 하면 `review`, 누락이 확인되면 `missing`이다. 기존 등록의 인증 성공 여부는 `webhook-status`에서 확인한다. [GitLab 프로젝트 웹훅 API](https://docs.gitlab.com/api/project_webhooks/) · [GitLab API 페이지 처리](https://docs.gitlab.com/api/rest/#pagination)

등록은 `{expectedVersion,repositoryId,reviewId,managementToken,webhookCredential}`을 받는다. `reviewId`는 인증 값이 설정된 누락 저장소의 점검 결과에 표시되며, 같은 작업자·저장소·연결 버전으로 10분간 유효하다. 관리 토큰은 저장소의 Maintainer·Owner 권한 또는 관리자 권한과 `api` 범위가 필요하다. 다시 입력한 웹훅 인증 값을 저장한 값과 대조하며, Signing Token이 설정된 경우 기능 플래그 없이 서명 등록을 지원하는 GitLab 19.1 이상인지 먼저 확인한다. 등록용 자격 증명은 저장하지 않는다. [GitLab 토큰 범위](https://docs.gitlab.com/security/tokens/access_token_scopes/) · [GitLab 프로젝트 웹훅 API](https://docs.gitlab.com/api/project_webhooks/) · [GitLab 버전 조회](https://docs.gitlab.com/api/metadata/)

등록 직전 목록과 연결 버전을 확인한다. 같은 경로의 훅이 있으면 확인 결과만 반환한다. 새 훅의 Push·Merge Request·Pipeline·Deployment와 SSL 검증을 켜고 `created`로 반환한다. 기존 훅의 `deploymentEvents`가 `false`이거나 확인할 수 없으면 `review`가 표시된다. 쓰기 응답을 확인할 수 없으면 `unknown`으로 반환하고 이후에는 목록을 조회해 확인한다. 재시작 후에도 미확인 시도를 기억한다. 목록에 계속 나타나지 않으면 GitLab에서 해당 저장소 설정을 확인한다. 제출 이후 Teamspace 설정이 바뀌면 `configurationChanged`를 반환한다.

최근 전송 조회는 `{expectedVersion,repositoryId,hookId,managementToken?}`을 받는다. 현재 HTTPS 수신 주소에 정확히 일치하는 저장소의 훅을 다시 확인한 뒤 GitLab 17.3 이상에서 제공하는 전송 이력의 첫 페이지를 최대 20건 읽는다. 응답의 `attempts`는 전송 ID, 이벤트 유형, HTTP 상태 `status`, 전송 시각 `sentAt`과 소요 밀리초 `durationMs`를 담는다. HTTP 응답이 없으면 상태는 `null`이며, GitLab이 시각·소요 시간을 제공하지 않으면 해당 값도 `null`이다. 원래 등록 주소가 다른 전송이나 해석할 수 없는 행이 있거나 다음 페이지가 있으면 `partial`을 표시한다. `localReceipt`는 해당 저장소 전체의 최근 인증 수신 요약이다. [GitLab 프로젝트 웹훅 전송 이력 API](https://docs.gitlab.com/api/project_webhooks/#list-project-webhook-events)

각 전송의 `messageReceipt.status`는 인증된 같은 메시지를 확인한 `matched`, 유효한 ID에 대응하는 인증 수신을 찾지 못한 `unconfirmed`, 비교 가능한 메시지 ID나 이벤트 유형을 확인할 수 없는 `unavailable` 중 하나다. `matched`의 `delivery`에는 확인한 최초 인증 수신의 시각·인증 방식·처리 요약이 들어 있다. 재전송은 같은 메시지의 요약을 함께 표시할 수 있다. `status`는 항상 해당 GitLab 전송 시도의 HTTP 결과다.

GitLab 인스턴스·저장소·이벤트·수신 주소 범위에서 `webhook-id` 또는 `Idempotency-Key`의 해시를 대조한다. 두 헤더가 다르거나 모호하면 대조를 보류한다. 원래 메시지 ID·헤더·요청 및 응답 본문은 이 API 응답에 포함하지 않는다. 인증 수신은 7일 동안 작업공간에 최대 10,000건을 보관한다. 웹훅 인증 값이나 GitLab 주소가 바뀌면 수신 기록을 초기화한다. 저장소 제거 또는 Jira 매핑 변경은 해당 저장소의 기록을 초기화한다. 물리 백업은 수신 기록을 보존하고 자체 JSON 복원은 초기화한다. [GitLab 전송 헤더](https://docs.gitlab.com/user/project/integrations/webhooks/#delivery-headers)

### GitLab 환경별 배포

`Deployment Hook`은 허용한 저장소에서 인증된 이벤트의 `deployment_id`, `environment`, `status`, `status_changed_at`과 정확한 전체 SHA가 있는 `commit_url`을 사용한다. 수명주기 상태는 `blocked`, `running`, `success`, `failed`, `canceled`다. GitLab 프로젝트에 속한 `deployable_url`은 `deployable_id`와 함께 검사한다. 인증된 같은 배포 ID의 더 최근 상태를 저장하고, 최종 상태 뒤에 실행 중·차단 상태가 도착하면 최종 상태를 보존한다. 배포를 저장하거나 갱신한 응답과 마지막 수신 요약에 `deploymentUpdated: true`를 표시한다. [GitLab 배포 이벤트](https://docs.gitlab.com/user/project/integrations/webhook_events/#deployment-events)

브라우저의 `GET /api/integrations/gitlab/deployments?repositoryId=42`는 저장된 연결의 해당 저장소를 조회한다. `GET /api/issues/:id/gitlab-deployments`와 범위 제한 `/api/v1/issues/:id/gitlab-deployments`는 해당 티켓의 개발 활동과 같은 인스턴스·저장소·전체 SHA의 결과를 읽는다. 연결된 커밋·파이프라인의 SHA와 대상 저장소가 확인된 병합 MR의 병합·스쿼시 SHA를 증거로 사용한다. 두 경로는 최신 변경 시각순으로 `{items,total,offset,limit}`을 반환한다. `offset` 기본값은 0이며 한 페이지는 50건이다. 자체 백업 형식 72는 `gitlabDeployments`와 `GitlabLink.mergeCommitShas`를 보존한다.

브라우저의 `POST /api/integrations/gitlab/deployments/preview`에 현재 설정의 `expectedVersion`과 `repositoryId`를 보낸다. 저장 전 입력으로 확인할 때는 `baseUrl`과 `projectIds`를 함께 보내고 그 목록의 저장소를 선택한다. `token`은 선택이며, 생략하면 정규화한 주소가 저장된 주소와 같을 때 저장된 읽기 토큰을 사용한다. 미리보기는 GitLab에서 최근 배포와 성공한 배포의 포함 MR을 읽어 건수를 반환하고 업무·배포·동기화 이력을 건드리지 않는다. [GitLab 배포 API](https://docs.gitlab.com/api/deployments/#list-all-merge-requests-associated-with-a-deployment)

응답의 `status`는 배포 조회 내역이 비면 `empty`, 조회 한도에 도달하거나 일부 포함 MR을 읽지 못하면 `partial`, 그 외에는 `ok`다. `repositoryId`, `settingsVersion`, `deploymentsRead`, `successfulDeployments`, `mergeRequestsRead`, `deploymentLimitReached`, `associationUnavailable`, `associationLimited`, `associationDenied`, `associationRateLimited`가 들어간다. MR은 배포와 MR의 확인된 연결 단위로 센다. `successfulDeployments`가 0이면 포함 MR 요청은 생략한다. `associationDenied`는 포함 MR 요청 중 GitLab HTTP 401·403을 받은 배포 수, `associationRateLimited`는 429를 받은 수다. 429 이후 건너뛴 배포는 `associationUnavailable`에 포함한다. 저장소 또는 배포 목록 읽기에 실패하면 `502`와 정리한 `{stage,httpStatus,reason}`을 반환한다. 확인 중 연결 설정이 바뀌면 `409`를 반환한다.

브라우저의 `POST /api/integrations/gitlab/deployments/sync`에 저장한 `repositoryId`와 `expectedVersion`을 보낸다. 저장소의 최근 배포 50건과 성공한 배포당 포함 MR을 최대 200건 조회한다. 같은 저장소에서 명시적으로 포함됐다고 확인한 MR의 `{id,iid}`만 저장하며, 기존 티켓 연결에 그 ID·IID가 함께 있으면 배포 목록에 표시한다. REST에서 저장한 현재 배포 상태는 `source: 'sync'`와 GitLab의 갱신 시각을 기록한다. `created`와 `skipped`도 동기화에서 읽는다. [GitLab 배포 API](https://docs.gitlab.com/api/deployments/)

동기화 응답에는 `repositoryId`, `settingsVersion`, `deploymentsRead`, `deploymentsStored`, `mergeRequestsStored`, `associationUnavailable`, `associationLimited`, `deploymentLimitReached`가 들어간다. 확인한 MR은 일부 페이지를 읽지 못해도 저장하고 기존 근거는 유지한다. 같은 저장소에서 동기화가 이미 진행 중이거나 읽는 동안 연결 설정이 변경되면 `409`를 반환한다. 새로 수신한 웹훅의 배포 상태를 우선하며, 별도로 검증한 MR 정보는 기록할 수 있다. 자체 백업 형식 74부터 배포의 `source`와 `mergeRequests`를 보존한다.

### 선택한 배포로 상태 변경 검토

브라우저의 `POST /api/issues/:id/gitlab-deployments/:instance/:repositoryId/:deploymentId/status-review`에 빈 객체를 보낸다. 현재 GitLab 연결의 티켓 배포 한 건에서 저장소·원본 배포 ID·환경 이름·전체 SHA를 대조하고 현재 상태를 `deployment`로 반환한다. 성공한 배포는 CI 작업의 완료 시각과 같은 환경의 최신 성공 목록을 확인한다. 작업 완료를 확인할 수 없거나 다른 성공 배포가 최신이면 현재 배포 상태를 돌려주고 상태 변경 제안을 보류한다. [GitLab 배포 단건 조회](https://docs.gitlab.com/api/deployments/#retrieve-a-deployment) · [GitLab 프로젝트 배포 조회](https://docs.gitlab.com/api/deployments/#list-all-project-deployments)

`state`는 `not-success`, `completion-unverified`, `superseded`, `latest-unverified`, `link-unverified`, `no-rule`, `ready` 중 하나다. `ready`는 확인한 성공에 적용할 규칙이 있어 `statusReview`를 제공한 경우다. 제안 근거에는 이번 조회에서 확인한 배포·완료 시각과 티켓 자동 연결이 들어간다. 같은 저장소에서 연결한 전체 커밋 SHA·병합 SHA 또는 이번 조회에서 확인한 포함 MR의 ID와 IID를 적용한다. 조회와 제안은 티켓 상태를 바꾸지 않는다. 일반 티켓 저장에서 제안 토큰과 업무·규칙·연결·배포의 현재 근거를 다시 검사한다. [GitLab 배포에 포함된 MR 조회](https://docs.gitlab.com/api/deployments/#list-all-merge-requests-associated-with-a-deployment)

### 이관한 Jira 키로 연결

`jiraRoutes`는 `{repositoryId, projectId, jiraInstanceKey}`의 배열이다. 허용한 GitLab 저장소당 Jira 원본 하나와 대상 Teamspace 프로젝트 하나를 지정한다. PATCH와 미리보기에서 전체 배열을 보내며 빈 배열로 매핑을 해제한다. 필드를 생략하면 같은 주소와 허용 저장소의 저장된 매핑을 사용한다. 처음 설정하는 저장소는 현재 Teamspace 키로 연결한다.

매핑한 저장소는 지정한 프로젝트의 현재 키와 지정한 Jira 원본의 이관 키를 대소문자 구분 없이 찾는다. Jira 키를 사용하면 연결 후보와 저장 링크에 `originalJiraKey`를 기록한다. 한 객체가 동일 티켓의 현재 키와 원래 키를 함께 포함하면 링크를 한 건 저장한다. 서로 다른 티켓을 가리키는 키는 보류하고 미리보기의 저장소별 `ambiguousKeys`에 최대 20개를 표시한다.

수동 동기화는 개발 활동 링크만 저장한다. 인증된 MR·파이프라인 이벤트는 활성 규칙의 기존 전이·필수 입력·시각 검증을 거친다. 매핑을 바꾸면 해당 저장소에 연결된 활성 자동화 규칙을 비활성화한다. 저장한 링크의 원래 키는 자체 백업 형식 35와 물리 백업에 들어간다. 연결 설정의 매핑은 서버에 저장되며 물리 백업에 포함된다. 자체 백업을 가져오면 복원한 데이터에 원본 프로젝트가 있는 매핑을 유지한다.

### MR 생성 전 브랜치·커밋

미리보기와 동기화에 `{includeHistory:true}`를 보내면 각 GitLab 저장소의 브랜치 최대 500개와 최근 커밋 최대 100개를 함께 읽는다. 브랜치는 이름의 티켓 키를, 커밋은 제목이나 메시지에 적힌 티켓 키를 사용한다. 미리보기의 `counts.branches`·`counts.commits`와 저장소별 `historyLimits`는 조회 건수와 한도 도달 여부를 표시한다. 동기화 결과의 `historyCounts`에는 전체 저장소의 건수를 합산한다. `historyLimits`의 각 값은 하나 이상의 저장소가 해당 조회 한도에 도달하면 `true`가 된다. [GitLab 브랜치 조회](https://docs.gitlab.com/api/branches/#list-repository-branches), [GitLab 커밋 조회](https://docs.gitlab.com/api/commits/#list-repository-commits)

GitLab 프로젝트의 **Push events**는 `refs/heads/` 이름에서 티켓 키를 찾는다. 새 커밋이 없는 브랜치도 연결하며 커밋의 제목이나 본문에 키가 있으면 그 키를 사용한다. 커밋 자체에 키가 없으면 브랜치 키를 사용한다. GitLab은 큰 푸시에서 최근 20개 커밋만 웹훅에 싣는다. [GitLab Push 이벤트](https://docs.gitlab.com/user/project/integrations/webhook_events/#push-events)

브랜치가 이어지는 변경은 이전 SHA와 다음 SHA로 확인한다. 중간 이벤트가 빠지면 마지막으로 이어진 브랜치 상태를 유지하고, 이미 받은 커밋은 이력에 남긴다. 티켓에서 브랜치를 직접 조회해 현재 SHA를 확인하면 그 지점부터 푸시 변경을 다시 추적한다. 삭제된 브랜치는 마지막 확인 SHA와 `deleted` 상태를 보존한다. 자체 백업 형식 24는 활성 티켓과 휴지통의 브랜치 관측을 보존한다.

저장소 목록 조회와 수동 연결로 처음 관측한 브랜치 링크는 `branchObservationSource: 'sync'`를 포함한다. 자체 백업 형식 28에서 활성 티켓과 휴지통의 조회 출처를 보존한다. 이후 인증된 푸시가 같은 브랜치를 갱신하면 링크 ID를 유지한 채 웹훅 관측을 사용한다. 브랜치 삭제는 인증된 푸시에서 확인한다. 수동 동기화는 개발 활동 링크만 저장한다.

이관 키를 연결할 때 이미 인증된 활성 브랜치가 있으면 조회한 브랜치의 SHA와 정확히 일치할 때 해당 관측을 사용한다. SHA가 다르거나 푸시가 브랜치 삭제를 기록한 경우에는 그 조회로 링크를 추가하지 않는다.

`GET /api/v1/issues/:id/gitlab-links`는 `{links, total, offset, limit}`을 반환한다. 선택한 `kind`는 `branch`, `commit`, `merge_request`, `pipeline`이며 `offset` 기본값은 0이다. 기록 시간이 최근인 항목부터 50개씩 반환한다. 브랜치의 `sourceBranch`와 `sourceSha`는 참조 이름과 마지막 확인 SHA다. 읽기·쓰기 키 모두 프로젝트 범위 안에서 조회할 수 있다.

### GitLab 수동 연결

브라우저의 `POST /api/issues/:id/gitlab-links`에 `{repositoryId,url,expectedSettingsVersion}`을 보낸다. 저장한 `GET /api/integrations/gitlab` 설정의 `version`과 허용 저장소 ID를 사용한다. MR은 프로젝트의 MR IID, 파이프라인은 파이프라인 ID를 사용한다. 브랜치는 `/-/tree/` 뒤의 전체 이름, 커밋은 `/-/commit/` 뒤의 전체 SHA를 확인한다. 서버는 저장한 GitLab의 읽기 API에서 프로젝트와 해당 항목을 대조하고 순수 페이지 주소를 저장한다. 쿼리와 프래그먼트를 제거하며 브랜치 주소에 참조 유형이 있으면 `heads`를 확인한다. [GitLab MR 조회](https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request) · [GitLab 파이프라인 조회](https://docs.gitlab.com/api/pipelines/#retrieve-a-single-pipeline) · [GitLab 브랜치 조회](https://docs.gitlab.com/api/branches/#retrieve-a-repository-branch) · [GitLab 커밋 조회](https://docs.gitlab.com/api/commits/#retrieve-a-commit)

응답은 저장한 `GitlabLink`다. 새 수동 연결은 `201`이며 같은 항목을 다시 확인하면 같은 ID의 `200`을 받는다. 조회 중 연결 설정이 바뀌거나 브랜치 조회가 기존 인증 푸시 기록과 다르면 `409`를 반환할 수 있다. 이 경우 마지막으로 확인된 링크를 유지한다. 인증 웹훅과 동기화는 같은 링크를 갱신하며, 티켓 키가 확인되면 기존 자동 연결 규칙을 적용한다. 브라우저에서 브랜치를 열 때는 `ref_type=heads`를 붙여 같은 이름의 태그와 구분한다. [GitLab의 브랜치·태그 주소 처리](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/122237)

수동 연결을 해제하려면 `DELETE /api/issues/:id/gitlab-links/:linkId?expectedManualLinkId=…`에 현재 행의 `manualLinkId`를 보낸다. 자체 백업 형식 52는 활성·휴지통의 MR·파이프라인 수동 연결을, 형식 60은 브랜치·커밋 수동 연결도 저장한다. 복원한 연결에는 새 `manualLinkId`를 부여한다.

### 티켓에서 GitLab 상태 다시 확인

브라우저의 `POST /api/issues/:id/gitlab-links/refresh`에 빈 객체를 보낸다. 서버는 해당 티켓에 연결된 MR·파이프라인·브랜치 중 최근에 갱신한 20건을 조회한다. 저장소의 숫자 ID와 활동의 원본 ID 또는 전체 브랜치 이름을 확인한다. GitLab 연결에 저장한 읽기 자격 증명을 사용하며 요청에 원격 주소나 토큰을 받지 않는다.

응답의 `links`는 확인한 연결, `failures`는 확인할 수 없었던 항목의 `{linkId,message}`, `skipped`는 이번 범위보다 오래된 항목 수다. 실패한 항목은 직전에 저장한 상태를 유지한다. MR·파이프라인은 조회 중 더 최신 웹훅이 반영되면 그 상태를 반환한다. 연결 설정이나 티켓의 프로젝트·키가 바뀌면 `409`로 응답한다. 이 조회에서 티켓 상태 규칙을 실행하지 않는다.

연결된 MR·파이프라인을 모두 정확히 확인했고 적용할 규칙이 있으면 `statusReview`를 반환한다. `kind: 'suggestion'`이면 `suggestion`에 업무·워크플로 버전, 현재 및 목표 상태, 규칙, GitLab 원본과 발생 시각, 가능한 차단 이유인 `blockReason`, `token`, `expiresAt`이 들어간다. `kind: 'ambiguous'`는 일치하는 결과나 같은 우선순위의 규칙이 서로 다른 목표를 요구하는 경우다. 완료 시각은 파이프라인의 `finished_at`, MR의 `merged_at` 또는 `closed_at`을 사용한다. 저장소·참조·실행 유형·태그 여부가 같은 연결 중 가장 큰 GitLab 파이프라인 ID를 사용하고, 같은 그룹일 수 있는 더 큰 인증 관측도 확인한다. [GitLab MR API](https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request) · [GitLab 파이프라인 API](https://docs.gitlab.com/api/pipelines/#retrieve-a-single-pipeline)

검토한 상태를 적용하는 브라우저의 `PATCH /api/issues/:id`에는 일반 업무 변경과 함께 `gitlabStatusSuggestionToken`을 보낸다. 토큰은 발급한 작업자에게 5분 동안 유효하다. 업무 유형·상태·버전, 워크플로·업무 양식·GitLab 설정·규칙과 관측 근거를 한 번 더 확인한다. 증거가 달라지거나 만료되면 `409`와 `details.reason: 'gitlab_status_suggestion_stale'`을 반환한다. 유효한 제안은 저장 시 현재 워크플로의 일반 상태 전이와 필수 입력을 검사한다.

브랜치 단건 조회에 성공하면 같은 저장소·이름의 기존 연결에 확인한 HEAD와 `branchObservationSource: 'read'`를 저장한다. 자체 백업 형식 102는 활성·휴지통 티켓의 확인 결과를 보존한다. 해당 브랜치의 관측이 조회 중 바뀌면 항목별 재확인 메시지를 반환한다. GitLab이 404나 권한 오류를 반환하면 기존 브랜치 상태를 보존한다. [GitLab 브랜치 조회](https://docs.gitlab.com/api/branches/#retrieve-a-repository-branch)

파이프라인 링크는 원본에서 확인한 `pipelineSource`와 태그 실행 여부인 `pipelineTag`를 선택적으로 포함한다. 저장소 목록은 실행 유형을, 단건 조회와 인증된 웹훅은 실행 유형과 태그 여부를 제공한다. 업데이트에서 값이 생략되면 앞서 확인한 값을 유지한다. 같은 파이프라인의 명시된 값이 저장값과 다르면 해당 관측을 보류한다. 자동 상태 전이는 저장소·참조·실행 유형·태그 여부가 같은 인증 관측의 순서를 기준으로 평가한다. 실행 유형이나 태그 여부를 확인할 수 없으면 같은 그룹일 수 있는 인증 기록을 포함한다. 자체 백업 형식 101은 활성 업무와 휴지통의 값을 보존한다. [GitLab 파이프라인 API](https://docs.gitlab.com/api/pipelines/) · [GitLab Pipeline Hook](https://docs.gitlab.com/user/project/integrations/webhook_events/#pipeline-events)

### 연결된 GitLab 활동 한 건 확인

브라우저의 `POST /api/issues/:id/gitlab-links/:linkId/refresh`에 빈 객체를 보낸다. 해당 티켓에 연결된 MR·파이프라인·활성 브랜치를 하나 지정한다. 최근 20건보다 오래된 연결도 지정할 수 있다. 티켓이나 소속 연결을 찾을 수 없으면 `404`, 갱신할 수 없는 종류나 삭제된 브랜치면 `400`을 반환한다. 기존 상태 확인과 같은 원본 식별자·연결 버전·최신 관측 검사와 GitLab 읽기 자격 증명을 사용한다.

응답은 선택한 연결 한 건을 `links` 또는 `failures`에 담으며 `skipped`는 `0`이다. 브랜치를 확인하면 같은 저장소·이름으로 연결된 기존 행에 HEAD를 함께 기록한다. 이 요청은 연결된 개발 활동을 갱신한다. 전체 연결을 근거로 하는 티켓 상태 제안은 위의 최근 활동 확인 경로에서 검토한다.

### 선택한 GitLab 활동으로 상태 변경 검토

브라우저의 `POST /api/issues/:id/gitlab-links/:linkId/status-review`에 빈 객체를 보낸다. 해당 티켓에 연결된 MR 또는 파이프라인 한 건을 조회하며 최근 20건 밖의 활동도 선택할 수 있다. 지정한 연결의 저장소와 원본 객체를 검증한 뒤 확인한 상태를 `links`에, 확인하지 못한 한 건을 `failures`에 담는다. `skipped`는 `0`이다. [GitLab MR 단건 조회](https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request) · [GitLab 파이프라인 단건 조회](https://docs.gitlab.com/api/pipelines/#retrieve-a-single-pipeline)

확인한 MR의 병합·닫기나 파이프라인의 성공·실패가 현재 활성 규칙에 해당하면 `statusReview`를 반환한다. 같은 우선순위의 규칙이 서로 다른 상태를 제안하면 `kind: 'ambiguous'`를 반환한다. 파이프라인은 같은 GitLab 인스턴스·저장소·참조에서 현재 티켓에 연결된 결과와 인증 수신 기록을 대조한다. 실행 유형과 태그 여부가 일치하거나 그 값이 없어 같은 실행 계열일 수 있는 더 큰 원본 ID가 있으면 제안을 보류한다. 제안은 선택한 활동을 기준으로 하며, **목표 상태로 편집**으로 연 일반 티켓 저장에서 기존 작업자·버전·규칙·워크플로·연결 및 만료 검증을 적용한다. 조회 시점에는 확인한 활동 정보를 갱신한다.

### 파이프라인 CI 작업 확인

브라우저의 `GET /api/issues/:id/gitlab-links/:linkId/pipeline-jobs`는 해당 업무에 연결한 파이프라인에서 실패(`failed`)와 수동 실행 대기(`manual`) 작업을 읽는다. 저장한 GitLab 주소와 읽기 자격 증명을 사용한다. 저장소와 파이프라인의 실제 ID, 확인 가능한 커밋 SHA를 대조한다. 작업은 50건씩 최대 4페이지를 조회하며 재실행으로 대체된 작업은 제외한다. 새 연결이나 업무 상태를 저장하는 과정과 독립된 브라우저 조회다. [GitLab Jobs API](https://docs.gitlab.com/api/jobs/#list-all-jobs-by-pipeline) · [GitLab 파이프라인 단건 조회](https://docs.gitlab.com/api/pipelines/#retrieve-a-single-pipeline)

응답은 `linkId`, `repositoryId`, `pipelineId`, 파이프라인의 `status`, 조회한 `checkedAt`, 설정 오류 여부인 `configurationError`, 후속 결과가 있을 수 있음을 뜻하는 `hasMore`와 `jobs`를 담는다. 일반 작업별로 `id`, `name`, `stage`, `status`, `failureReason`, `allowFailure`, 확인된 GitLab `webUrl`을 반환한다.

`triggerJobs`에는 상위 파이프라인의 트리거 작업 `{jobs, hasMore}`가 들어간다. 트리거 작업은 50건씩 최대 4페이지를 확인하며 일반 작업 필드와 선택적 다운스트림 정보(`downstream: {id,status,webUrl}` 또는 `null`)를 반환한다. 확인한 원본 주소가 없으면 `webUrl`은 `null`이다. 조회할 수 없으면 `triggerJobs: null`, 확인한 빈 결과는 `jobs: []`다. GitLab의 `trigger_jobs`에 `404`를 받으면 첫 요청에서 이전 `bridges` 경로로 조회한다. 다운스트림 상태는 GitLab이 트리거 응답에서 제공한 값을 표시한다. [GitLab 트리거 작업 API](https://docs.gitlab.com/api/jobs/#list-all-trigger-jobs-by-pipeline)

조회 앞뒤의 파이프라인 정보나 연결 설정, 업무 위치 또는 파이프라인 연결이 바뀌면 `409`를 반환한다. 현재 연결에서 저장소를 조회할 수 없으면 `403`, 연결이나 원본 파이프라인을 찾지 못하면 `404`, GitLab 요청 한도에 도달하면 `429`, 원본 응답을 검증할 수 없으면 `502`, 조회 시간이 지나면 `504`다. 응답은 `Cache-Control: no-store`를 사용한다.

### 파이프라인 테스트 결과 확인

브라우저의 `GET /api/issues/:id/gitlab-links/:linkId/pipeline-test-report`는 업무에 연결된 파이프라인의 GitLab 테스트 결과 요약을 읽는다. 응답에는 `linkId`, `repositoryId`, `pipelineId`, `status`, `checkedAt`, `total`, 처음 50개까지의 `suites`와 나머지 스위트의 여부인 `hasMore`가 포함된다. `total`과 각 스위트는 `count`, `passed`, `failed`, `skipped`, `errors`, `reportError`를 제공하며 스위트에는 `name`이 추가된다. 보고서 처리 오류는 `reportError`로 표시한다. GitLab에서 빈 요약을 반환하면 개수 0과 빈 목록으로 응답한다. [GitLab 테스트 결과 요약 API](https://docs.gitlab.com/api/pipelines/#retrieve-a-test-report-summary-for-a-pipeline)

CI 작업 조회와 같은 업무·저장소·파이프라인 검증 및 상태 코드를 사용한다. GitLab이 요약 자체에 `404`를 반환하면 결과를 제공하지 않는다는 메시지를 표시한다. 응답은 `Cache-Control: no-store`를 사용한다.

브라우저의 `GET /api/issues/:id/gitlab-links/:linkId/pipeline-failed-tests`는 같은 파이프라인의 실패·오류 사례를 필요할 때 읽는다. 결과에는 `linkId`, `repositoryId`, `pipelineId`, `status`, `checkedAt`, 최대 50개의 `cases`, 일부 조회인지를 나타내는 `hasMore`가 포함된다. 각 사례는 `suite`, `name`, 선택적인 `className`, `status`(`failed` 또는 `error`)를 제공한다. 출력, 스택 추적과 첨부는 GitLab의 원래 파이프라인에서 확인한다. [GitLab 상세 테스트 결과 API](https://docs.gitlab.com/api/pipelines/#retrieve-a-test-report-for-a-pipeline)

요약 조회와 같은 저장소·파이프라인·업무 연결 검증을 거친다. GitLab이 다음 페이지를 명시하면 같은 보고서에서 최대 네 페이지를 읽고, 페이지당 응답 크기는 16MiB까지 허용한다. 표시한 실패·오류 사례가 보고 건수보다 적거나, 보고서 처리 오류나 남은 범위가 있으면 `hasMore: true`를 반환한다. 첫 상세 보고서의 `404`는 상세가 제공되지 않는 경우로 표시하고, 읽기가 확인된 빈 결과는 빈 `cases`와 `hasMore: false`를 반환한다. 응답은 `Cache-Control: no-store`를 사용한다.

### 티켓에서 GitLab 브랜치 만들기

브라우저의 `POST /api/issues/:id/gitlab-branch/preview`에 `{expectedSettingsVersion,repositoryId,branch,ref?,accessToken?}`을 보낸다. 저장한 GitLab 설정의 버전과 저장소 ID를 사용한다. `ref`를 생략하면 기본 브랜치를 사용하며 브랜치 이름이나 전체 커밋 SHA를 지정할 수 있다. 조회 토큰을 별도로 입력하면 해당 요청에서만 사용한다. 같은 이름의 브랜치가 아직 없으면 응답의 `state`는 `ready`이고 `target`, `previewId`, `expiresAt`을 반환한다. `target`에는 저장소 ID·경로, 브랜치 이름, 기준 참조와 고정 SHA, 확인한 GitLab 주소가 담긴다. 같은 이름이 이미 있으면 `existing`과 현재 SHA를 반환한다. [GitLab Branches API](https://docs.gitlab.com/api/branches/)

`POST /api/issues/:id/gitlab-branch/apply`에 `{previewId,writeToken}`을 보낸다. 같은 작업자와 티켓의 위치, 설정, 브랜치 이름을 확인하고 고정한 SHA에서 생성한다. 입력한 API 쓰기 토큰은 해당 요청에서만 사용한다. 생성하고 현재 티켓에 연결한 첫 결과는 `201` 및 `{state: 'created',target,link,observedSha}`다. 같은 요청의 확인 결과는 `200`이며 `found`와 연결을 반환한다. 외부 생성 결과가 불명확하면 `pending`, GitLab 생성 후 Teamspace 연결이 보류되면 `link_needed`를 반환한다.

`POST /api/issues/:id/gitlab-branch/reconcile`에 `{expectedSettingsVersion,repositoryId,branch,accessToken?}`을 보낸다. 기록된 시도와 GitLab의 현재 이름·SHA를 조회한다. 검토한 SHA와 일치하면 연결하고 `found`를 반환한다. 접속이 끊겼을 때도 생성 시도를 물리 DB에서 찾고 조회로만 확인한다. 다른 SHA는 `conflict`, 아직 GitLab에서 찾을 수 없으면 `pending`을 반환한다. 시도 자체가 남아 있지 않으면 `404`와 `attempt_missing`을 반환하므로 다시 미리본다. 저장한 요청으로 이전에 사용한 이름은 조회 대상으로 남으며 새 브랜치를 시작할 때는 다른 이름을 고른다. 프로젝트 이동 후에도 동일한 활성 티켓 ID에서 명시적으로 연결을 확인할 수 있다. 티켓 자동 전이는 기존의 인증된 이벤트와 활성 규칙을 따른다.

### 연결 브랜치의 MR 확인

브라우저의 `GET /api/issues/:id/gitlab-links/:linkId/branch-merge-requests`는 연결된 활성 브랜치에서 같은 저장소를 대상으로 하는 열린 MR을 찾는다. 저장한 읽기 자격 증명으로 최대 50개씩 네 페이지를 조회한다. 선택적 `targetBranch`에는 같은 저장소의 브랜치 이름을 URL 인코딩해 보낸다. 열린 MR이 없고 조회가 끝났을 때 직접 입력한 브랜치 또는 저장소의 기본 브랜치를 확인한다. [GitLab MR 목록 API](https://docs.gitlab.com/api/merge_requests/#list-project-merge-requests) · [GitLab 브랜치 API](https://docs.gitlab.com/api/branches/#retrieve-a-repository-branch)

응답은 `linkId`, `repositoryId`, `sourceBranch`, `sourceSha`, `defaultBranch`, `targetBranch`, `targetSha`, `openMergeRequests`, `hasMore`, `newMergeRequestUrl`, `suggestedTitle`, `checkedAt`, `branchRevision`을 반환한다. 열린 MR마다 전역 `id`, 저장소 안의 `iid`, `title`, `targetBranch`, `webUrl`을 제공한다. 열린 MR이 없고 추가 페이지가 없으며 현재 커밋이 서로 다른 출발·대상 브랜치를 확인하면 `newMergeRequestUrl`에 GitLab 생성 화면 주소를 반환한다. 저장된 티켓 키와 제목은 복사용 `suggestedTitle`로 제공한다. 요청 중 연결·업무·브랜치가 바뀌면 `409`, 활성 연결·출발 브랜치·직접 입력한 대상을 찾지 못하면 `404`를 반환한다.

같은 경로의 `POST`에 `{mergeRequestId,mergeRequestIid,targetBranch,branchRevision}`을 보내면 열린 MR을 티켓에 연결한다. `GET`에서 확인한 전역 ID, 저장소 내 IID, 대상 브랜치와 버전을 보낸다. 서버는 저장한 읽기 자격 증명으로 MR의 현재 상태와 양쪽 저장소·브랜치를 대조하고 Teamspace 연결과 이력을 함께 저장한다. 새 연결은 `201`, 이미 연결된 항목은 `200`으로 `GitlabLink`를 반환한다. 연결 기준이 바뀌거나 첫 연결 전에 MR의 열림 상태나 브랜치가 달라지면 다시 확인을 요구한다. [GitLab MR 단건 조회](https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request)

### MR 병합 상태

열린 MR의 `GitlabLink.mergeReadiness`는 확인한 `state`, 기준 시각 `observedAt`, 출처 `source`를 담는다. `source`는 `read` 또는 `webhook`이다. 기존 MR 조회와 인증된 MR 이벤트에서 GitLab의 병합 상태를 읽는다. 확인한 사유는 `approval_required`, `changes_requested`, `conflict`, `ci_required` 등 제한된 값으로 반환한다. `checking`, `unknown` 또는 필드 부재는 별도로 표시되며 병합 확인 필터의 대상에서 빠진다. 병합하거나 닫힌 MR은 일반 링크의 수명주기 상태로 표시한다. [GitLab Merge Requests API](https://docs.gitlab.com/api/merge_requests/#merge-status) · [GitLab 웹훅](https://docs.gitlab.com/user/project/integrations/webhook_events/#merge-request-events)

같은 MR 수정 시각에 병합 조건만 바뀐 경우에도 확인한 리비전의 상태를 갱신한다. 저장소와 MR ID가 일치하면 티켓 키가 생략된 이벤트도 기존 연결에 반영할 수 있다. 인증 이벤트보다 먼저 시작한 조회가 뒤늦게 끝나면 해당 결과를 보류한다. 내보내기 또는 복원 시각보다 늦은 병합 관측이 들어 있는 백업은 복원을 거절한다.

### 연결된 MR 검토 확인

브라우저의 `GET /api/issues/:id/gitlab-links/:linkId/merge-request-review`는 현재 업무와 연결된 GitLab 저장소, 전역 MR ID 및 저장소 안의 IID를 대조한다. 사용자가 요청하면 저장한 읽기 자격 증명으로 검토자와 승인을 확인한다. 응답은 `linkId`, `repositoryId`, `mergeRequestIid`, `checkedAt`, `reviewerSource`, `reviewers`, `reviewersHasMore`, `approvals`를 반환한다. 검토자별 `id`, `username`, `name`과 검토 상태를 최대 50명까지 제공한다. [GitLab 검토자 API](https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-reviewers)

`reviewerSource`는 검토자 API로 확인한 `reviewers`, MR에 포함된 배정만 확인한 `merge_request`, 두 출처 모두 확인할 수 없는 `unavailable`이다. 배정만 확인한 경우 각 검토 상태는 `unknown`이다. 승인 응답은 승인자를 최대 50명까지 담은 `approvers`와 `hasMore`를 포함한다. `required`와 `remaining`은 GitLab이 유효한 두 값을 제공할 때만 숫자다. 승인 API를 사용할 수 없으면 `approvals`는 `null`이다. [GitLab 승인 상태 API](https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-state-for-a-merge-request)

조회 전후 MR의 확인 가능한 커밋·수정 시각·상태·검토자 배정, Teamspace의 연결 설정·업무 위치·저장된 링크를 비교한다. 이 중 하나가 바뀌면 `409`로 조회를 다시 요청하게 한다. 응답은 `Cache-Control: no-store`를 적용하고 조회 결과는 열린 검토 화면에서만 사용한다.

### 연결된 MR 최신 파이프라인

브라우저의 `GET /api/issues/:id/gitlab-links/:linkId/merge-request-pipeline`는 저장한 MR 연결의 저장소와 전역 ID·IID를 대조한 뒤 GitLab의 `head_pipeline`을 읽는다. 응답에는 MR 연결의 `linkId`, `repositoryId`, `mergeRequestIid`, `checkedAt`이 포함된다. `kind: pipeline`이면 `pipeline`에 실행 저장소 ID·파이프라인 ID·전체 SHA·상태·확인된 원본 주소·수정 시각을 반환한다. 파이프라인이 없으면 `no_pipeline`, GitLab에서 정보를 제공하지 않으면 `pipeline_unavailable`, 현재 연결에 실행 저장소가 없으면 `repository_not_connected`를 반환한다. [GitLab MR 조회](https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request), [GitLab 파이프라인 조회](https://docs.gitlab.com/api/pipelines/#retrieve-a-single-pipeline)

`GET /api/issues/:id/gitlab-links/:linkId/merge-request-pipeline-jobs`는 같은 기준으로 현재 실행을 검증하고 `jobs`를 추가한다. 작업 응답의 저장소와 파이프라인 ID는 실제 실행을 가리킨다. 조회는 MR의 소스 또는 대상 중 연결에 포함된 저장소에서만 수행한다. 파이프라인 자체 SHA와 MR 소스 HEAD를 각각 확인하고, 조회 중 MR의 HEAD나 지정한 실행 또는 Teamspace 연결이 바뀌면 `409`로 다시 확인하게 한다. 두 경로는 `Cache-Control: no-store`를 적용하는 조회 경로다.

### 연결된 MR 미해결 토론 확인

브라우저의 `GET /api/issues/:id/gitlab-links/:linkId/merge-request-discussions`는 사용자가 요청할 때만 현재 티켓에 연결된 열린 MR의 토론을 읽는다. 저장된 저장소와 전역 MR ID·IID를 대조한 뒤 GitLab에서 50개씩 최대 4페이지를 읽는다. 응답의 `linkId`, `repositoryId`, `mergeRequestIid`, `checkedAt`에 `threads`와 `hasMore`를 더한다. 확인한 미해결 토론은 최대 30개까지 표시한다. 표시 한도를 넘었거나 다음 원본 페이지가 남으면 `hasMore`는 `true`다. [GitLab 토론 API](https://docs.gitlab.com/api/discussions/#list-all-merge-request-discussion-items)

각 토론에서 표시할 수 있는 미해결 댓글 하나의 `noteId`, `author`, `excerpt`, `excerptTruncated`, `filePath`, `line`, `lineSide`를 반환한다. 발췌는 최대 300자의 평문이고 본문의 주소는 `[링크]`로 표시한다. 파일 위치와 작성자는 확인할 수 있을 때 제공한다. 개별 댓글, 시스템·내부·기밀 댓글은 조회 화면에서 제외한다. 화면에서 연결한 MR 주소에 숫자 댓글 ID를 붙여 GitLab 원문을 연다. [GitLab 댓글 주소](https://docs.gitlab.com/cli/mr/note/update/)

조회 전후의 MR 변경과 Teamspace 연결 변경을 확인하고 변경이 감지되면 `409`를 반환한다. 토론 조회 권한 또는 API가 없으면 화면에 조회 불가를 표시한다. 응답은 `Cache-Control: no-store`를 적용한다.

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

Jira REST 업무 응답과 별도로 저장한 댓글(`comments`)·작업 시간(`worklogs`) 응답을 같은 ZIP에 넣을 수 있다. 분석기는 업무와 페이지의 `self` 주소에서 Jira 서버 및 서비스 경로, 업무 ID 또는 키, 기록 ID를 대조한다. 페이지 주소가 생략된 응답은 각 기록의 `self`를 사용한다. 겹치는 동일 기록은 한 번만 가져오고, 같은 기록 ID의 소유 업무나 내용이 다르면 패키지 분석을 중단한다. 소유 업무와 연결할 수 없는 페이지는 `JIRA_ACTIVITY_PAGE_OWNER_UNRESOLVED`, 범위나 형식이 잘못된 페이지는 `JIRA_ACTIVITY_PAGE_INVALID`로 표시한다. 제공된 범위에 누락이나 불일치가 있으면 `COMMENTS_PARTIAL` 또는 `WORKLOGS_PARTIAL`이 남는다. 완전성은 응답이 보고한 범위에 대한 확인이다. [Jira 댓글 페이지](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/#api-rest-api-3-issue-issueidorkey-comment-get) · [Jira 작업 시간 페이지](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/#api-rest-api-3-issue-issueidorkey-worklog-get)

## 검토한 원본 이관 적용

| 요청 | 동작 |
| --- | --- |
| `GET /api/migrations/options?packageId=…&packageId=…` | 분석 패키지의 프로젝트·작성자·상태·유형·필드 매핑과 확인한 Jira·Confluence 추가 대상 |
| `GET /api/migrations/identity-roster` | 이메일 후보 검토에 사용할 현재 Teamspace 팀원 목록 |
| `POST /api/migrations/mapping/export` | `{configuration}`으로 다시 사용할 수 있는 이관 매핑 JSON 반환 |
| `POST /api/migrations/mapping/import` | `{mapping}`의 원본과 현재 워크스페이스를 대조해 `{options, configuration}` 반환 |
| `POST /api/migrations/preview` | `configuration`으로 프로젝트 생성 또는 업무·문서 추가 계획과 보존·누락 진단 검토 |
| `GET /api/migrations/previews/:id` | 선택한 작업자의 검사 결과 다시 읽기 |
| `POST /api/migrations/previews/:id/apply` | `expectedVersion`·`acknowledgements`로 검토한 계획 적용 |
| `GET /api/source-imports` | 적용된 프로젝트와 패키지·수량·진단 영수증 |
| `GET /api/source-imports/:id/records` · `GET /api/source-imports/:id/records/:recordId` | 원본 목록과 전체 기록 |
| `GET /api/source-imports/:id/notices/:index/source?expectedVersion=…` | 영수증 진단에 연결된 개별 보존 원본 |
| `GET /api/resource-origins?resourceType=issue&resourceId=…` | 현재 업무·문서에 연결된 원본 기록 |

오프라인 리허설 `review`에서 검토에 연결한 Confluence XML ZIP을 선택하면 옵션 조회와 매핑 불러오기의 `options.confluenceReviews`에 해당 검토의 범위·판정·건수와 공간 권한 수동 검토 표시가 포함된다. 형식 2와 3은 각 검토의 `coverage`를 제공한다. 형식 3의 확인 ID를 같은 ZIP의 현재 페이지 목록과 대조한 집계는 `options.confluenceReviewCoverage`에서 `{packageId,archivePages,permissionCheckedPages}` 배열로 제공한다. 같은 페이지는 한 번 집계한다. 원본 페이지 ID는 비공개 검토 파일에서 읽는다.
| `GET /api/issues/:id/jira-status-history?offset=0&limit=50` | 현재 티켓의 이관된 Jira 상태 변경과 각 변경의 원본 기록 ID |
| `GET` · `POST /api/issues/:id/jira-deadline-recovery` | 현재 티켓의 보존 Jira 마감일 검토와 확인한 날짜 복구 |
| `GET /api/issues/:id/relations` | 이관한 관계와 팀에서 직접 만든 업무 관계 |
| `GET /api/attachments/:id/versions` · `GET /api/attachment-versions/:id/download` | 첨부 버전 목록·파일 |

미리보기는 30분간 보관한다. 새 변환 규칙이 적용되면 미리보기를 다시 만든다. 적용 시 같은 작업자와 미리보기 버전, 필수 확인 코드 전체가 필요하다. 패키지·첨부 해시, 원본 바인딩, 새 프로젝트 키를 재검사한다. 같은 요청을 다시 보내면 기존 영수증을 반환한다. 원본 객체가 겹치는 새 이관과 이미 사용 중인 프로젝트 키는 충돌로 처리한다. 기존 작업공간에 대한 변경 권한은 현재 신뢰하는 관리 브라우저를 기준으로 한다.

`options.identities[]`의 `email`은 수동 매핑에서 참고할 원본 표시 값이다. 선택적으로 제공하는 `emailEvidence`에는 비교 가능한 `email`을 담고, 원본 계정과 프로필 사이의 연결을 확인한 경우 `accountId`도 담는다. 주소 근거가 불명확하면 `null`을 반환한다. 브라우저는 후보를 열거나 반영할 때 현재 팀원 목록을 조회한다. 사용자가 확인한 항목은 기존 `configuration.users`에 팀원 ID로 저장하며 이후 기존 미리보기·적용 절차를 사용한다.

Confluence 본문의 `/display/SPACE/제목`, `/pages/viewpage.action?pageId=…`, `/spaces/SPACE/pages/…` 주소는 `sourceBaseUrls`의 서버와 설치 경로로 대조한다. 상대 주소는 원래 패키지의 설정을 사용한다. 다른 원본을 가리키는 절대 주소는 입력한 서버·설치 경로에서 하나의 원본 페이지로 확인될 때 연결한다. 원본 관계에 페이지 ID가 명시됐으면 URL의 대상과도 일치해야 한다. 추가 이관이나 변경분 반영은 현재 연결을 확인한 기존 페이지도 대상으로 사용할 수 있다. 대상을 확인할 수 없으면 원본 주소와 진단을 남긴다. 페이지의 진단은 `UNRESOLVED_REFERENCE`, 절의 진단은 `SECTION_LINK_UNRESOLVED`다. Server·Data Center의 짧은 주소 `/x/…`도 대상 페이지를 확인하면 문서 참조로 옮긴다. 대상 페이지를 확인할 수 없는 짧은 주소에는 일반 본문 링크 규칙을 적용한다.

Confluence 본문의 `/download/attachments/{pageId}/{filename}` 다운로드 링크와 이미지는 설정된 원본 설치 경로, 첨부 소유 페이지와 파일명을 확인해 저장한 파일에 연결한다. `version`이 있으면 그 원본 버전에 대응하는 파일을 사용한다. 과거 저장본에서 원본 버전이 확인되지 않는 주소나 대상이 모호한 주소는 원본 링크로 남긴다. [Confluence 첨부 다운로드 형식](https://developer.atlassian.com/server/confluence/rest/v932/intro/#download-an-attachment)

`viewpdf`, `viewdoc`, `viewxls`, `viewppt`의 지원되는 저장 형식에서 파일명·소유 페이지와 명시된 첨부 ID가 일치하면 본문에 그 파일의 다운로드 링크를 넣는다. 화면 표시 방식이 바뀌는 경우 `CONFLUENCE_FILE_PREVIEW_LINKED`를 기록한다. 대상을 확정할 수 없으면 `UNRESOLVED_CONFLUENCE_FILE_PREVIEW`, 지원 범위를 벗어난 저장 형식이면 `CONFLUENCE_FILE_PREVIEW_UNSUPPORTED`를 기록하고 원본 매크로를 코드 블록으로 보존한다. 과거 페이지 저장본은 원래 첨부 버전을 확인할 수 있을 때만 연결한다. 변환은 새 이관과 검토 후 적용하는 원본 변경분에 사용한다. [Confluence 파일 매크로 저장 형식](https://confluence.atlassian.com/spaces/CONF53/pages/411108832/Confluence%2BStorage%2BFormat%2Bfor%2BMacros)

Jira 설명의 ADF 텍스트에 붙은 절대 `/browse/{issueKey}` 링크는 설정된 원본 서버·설치 경로와 대상을 확인한 경우 글자와 서식을 유지해 현재 티켓으로 연결한다. 원본 댓글이나 다른 세부 위치가 붙은 주소는 원래 위치를 연다. 본문 링크 변환은 새 이관이나 검토한 원본 변경분을 적용할 때 사용한다. [Atlassian Document Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)

이관 매핑 파일의 형식은 `teamspace-migration-mapping`, 버전은 `1`, 최대 크기는 16MiB다. 파일의 `packages`에는 당시 분석 ID와 원본 제품·인스턴스 식별값·내보내기 형식·SHA-256을 저장한다. 복원 시 네 원본 속성이 일치하는 현재 분석 패키지를 찾는다. 당시 ID가 같은 원본을 가리키면 이를 사용하고, 새 ID로 다시 분석했으면 일치 항목이 하나여야 한다. 패키지·매핑·제외 항목의 ID는 현재 분석 결과로 바꾼다. `mappedUsers`에는 매핑된 팀원 ID와 공백 제거·소문자 변환한 이메일의 SHA-256을 기록한다. 현재 팀원과 유일하게 일치해야 매핑을 복원한다. 기존 프로젝트 추가 설정은 현재 확인한 대상과 연결이 일치해야 복원한다.

두 브라우저 관리 경로는 파일 생성과 매핑 대조를 처리한다. 실제 이관은 복원 후 새 미리보기를 만들고 확인 항목을 검토한 뒤 적용한다. 원본 ID, 내부 주소, 대상 프로젝트명과 팀원 이메일 해시가 포함될 수 있으므로 파일은 팀 내부에서 보관한다.

객체에 연결된 `notices[].recordId`는 패키지 ID와 레코드 ID를 첫 `/`로 연결한 값이다. 진단의 **원본 상세 보기**는 두 ID를 각각 인코딩해 분석 단계의 원본 조회 경로를 사용한다.

Jira 상태 변경 내역은 브라우저 API에서 `{entries,total,offset,limit}`으로 반환한다. `limit`은 1~100이며 기본값은 50이다. 각 내역에는 `from`과 `to`의 원본 상태 ID·이름, 원본 작성자 이름, 확인한 시각이 포함된다. 시각을 확정할 수 있으면 `changedAt`을, 원본 값만 확인할 수 있으면 `originalChangedAt`을 사용한다. 티켓이 없어졌으면 `404`를, 확인된 Jira 상태 변경이 없으면 빈 목록을 반환한다.

`configuration.sourceBaseUrls`는 선택한 분석 패키지 ID별 선택 입력이다. 기본 주소는 HTTP(S) 호스트와 서비스 경로를 사용한다. 인증 정보·쿼리·프래그먼트가 포함되면 미리보기가 적용을 막는다. Jira는 원래 업무 키, Confluence는 일반 페이지의 숫자 ID로 링크를 계산한다. 응답의 `samples[].sourceUrl`에는 생성할 정규 주소가 들어간다. 미리보기와 영수증의 `counts.atlassianLinks` 및 `counts.unlinkedAtlassianRecords`는 이관 대상 중 생성할 링크와 링크를 만들 수 없는 항목의 건수다. 누락 사유는 `notices`에 기록된다. 링크를 새 대상과 같은 트랜잭션에서 저장하며 `GET /api/atlassian-links`로 현재 링크를 읽는다.

원본의 시간대가 없는 시각에는 설정한 IANA 시간대를 사용한다. Jira CSV의 영문 월 형식도 처리하며, 두 자리 연도는 2000년대로 해석한다는 확인을 요청한다. [Atlassian Jira 날짜 형식 안내](https://confluence.atlassian.com/jirakb/date-format-changes-after-exporting-to-excel-119799961.html) 해석 불가 시 기본값은 적용 차단이다. 이관 시각을 사용하는 정책을 선택하면 그 사실을 검토 결과와 영수증에 남긴다. 원본 작성자는 원래 신원으로 보존한다. 현재 팀원으로 매핑하지 않은 작성자는 현재 문서·댓글·첨부에 이관 실행자를 기록한다. 제외한 원본은 적용 대상 없이 관리용 영수증에 보관한다. 원본 권한 정책은 별도로 검토해야 한다.

자체 백업 schema9는 적용된 영수증, 원본 기록, 업무 관계, 첨부 버전 메타데이터와 바이트를 포함한다. 분석 패키지와 미리보기는 별도 보관 대상이다. 자체 백업 복원으로 미리보기가 무효화된다. 원본 이관 적용 중에는 발신 웹훅이 생성되지 않는다.

Confluence XML에서 원본 위치가 확인된 새 형제 문서 그룹이 있으면 미리보기와 영수증의 `counts.confluenceOrderedSiblingGroups`에 집계한다. 일부 위치의 누락·중복이나 범위 불일치로 순서를 적용할 수 없는 그룹은 `counts.confluenceUnresolvedSiblingGroups`와 `CONFLUENCE_SIBLING_ORDER_UNRESOLVED`에 표시한다. 적용한 순서는 문서의 [형제 순서 조회](#형제-문서-순서)에서 읽는다.

### 새 Jira 프로젝트의 워크플로 지정

`options.jiraWorkflowStatuses`에는 Jira 이관 업무에 관측된 상태의 `id`, `label`, `containerIds`가 들어 있다. `id`는 같은 원본 인스턴스·상태를 같은 값으로 분석하면 유지된다. `configuration.jiraWorkflows`는 정규화한 새 프로젝트 키마다 `{initialStatusId, transitions, additionalStatuses?}`를 받는다. 각 전이는 `{from, to}`의 한 방향이며, 빈 배열은 상태 변경을 제한한다. 추가 상태는 `{id, label, category}` 형식이고 `s_new_1`부터 `s_new_40`까지 중 하나를 사용한다. 한 프로젝트의 전체 상태는 40개까지다.

미리보기의 `jiraWorkflows`에는 검토할 프로젝트 키, 실제 초기 상태, 상태 이름·분류와 허용 전이가 포함된다. 해당 프로젝트에 이관되는 업무의 상태와 직접 추가한 상태 중에서 출발·도착 상태를 고른다. 제외한 업무에서만 관측된 상태는 미리보기에서 다시 확인한다. 직접 설정한 프로젝트는 `JIRA_WORKFLOW_REVIEW_REQUIRED` 확인 후 적용한다. 설정이 생략된 새 프로젝트에는 매핑한 상태 사이의 전이를 허용하는 기본 방식이 적용된다. 매핑 파일과 이관 영수증에 직접 설정한 내용을 보관한다. Jira의 유형별 조건·검증기·후처리는 별도 검토 항목이다.

새 프로젝트 미리보기의 선택 항목 `jiraObservedWorkflows`는 `{projectKey,initialStatusId,statuses,transitions}` 배열이다. 각 전이의 `{from,to,issueCount}`는 그 방향이 확인된 서로 다른 원본 업무 수다. 업무와 상태 ID의 소속을 확인할 수 있고 두 상태가 같은 대상 프로젝트의 이관 대상에 있을 때 집계한다. 제외·제한 원본이나 소유자가 모호한 이력은 집계에서 뺀다. 이 값을 반영하려면 원하는 방향을 `configuration.jiraWorkflows`에 지정해 새 미리보기를 만든다.

### 기존 프로젝트에 새 Jira 업무 추가

선택한 패키지의 업무가 같은 Jira 인스턴스와 하나의 원본 프로젝트에 속하고, 원본이 기존 Teamspace 프로젝트에 연결되어 있으면 옵션에 `appendTarget`과 현재 상태·유형·필드가 포함된다. `configuration.appendTo`에 `{projectId,statuses,issueTypes,fields}`를 설정한다. 각 매핑의 키는 옵션 ID이며 값은 대상 프로젝트의 상태·업무 유형·필드 ID다. 필드 값을 `null`로 지정하면 해당 값은 원본에 보관한다. 기존 프로젝트의 설정과 기존 티켓 데이터를 보존한다.

`counts.issues`는 새 업무 수, `retainedIssues`와 `retainedRecords`는 이전 이관으로 이미 처리해 원본으로 보관하는 업무와 관련 기록 수다. 휴지통이나 영구 삭제한 업무의 원본 ID도 중복 생성 방지에 사용한다. 새 업무는 현재 연결 가능한 부모나 관계를 참조할 수 있다. 적용은 대상의 설정 버전, 다음 업무 번호와 원본 연결을 다시 확인한다. 형식 37 자체 백업은 추가 이관의 대상과 매핑을 보존한다.

새 업무의 Jira 관리자 XML 숫자 우선순위는 보존한 같은 패키지의 옵션 이름과 연결을 확인한다. 명시한 값의 이름을 확인하거나 구분할 수 없으면 미리보기에 `JIRA_PRIORITY_UNRESOLVED`를 보여 주고 확인을 받아 보통으로 저장한다. 원본 값은 영수증에 보존한다.

### 이미 이관한 Jira 업무에 원본 변경분 반영

위 설정에 `appendTo.refreshExisting: true`를 지정하면 같은 프로젝트에 연결된 기존 티켓도 검토한다. 새 패키지의 실제 수정 시각이 직전 원본 기록보다 늦을 때 제목·설명·유형·상태·우선순위·담당자·요청자·라벨·시작일·종료일·마감일·예상 작업량·상위 업무 중 확인 가능한 값을 비교한다. 원본에서 생략한 필드나 Teamspace에서 별도로 편집한 필드는 현재 값이 유지된다. 사용자·상태·유형을 반영할 때는 검토한 매핑을 사용한다.

`preview.issueRefresh`는 Teamspace 업무 키, 원래 Jira 업무 키와 각 필드의 현재 값·원본 값·반영 여부를 보여준다. `updatedIssues`, `updatedFields`, `conflictingFields`, `skippedIssueUpdates`에서 반영·충돌·건너뛴 업무 건수를 확인한다. 한 요청은 기존 티켓 1,000개와 비교에 쓰는 데이터 64MiB까지 지원한다. 워크플로 전이와 필수 필드를 검증하고, 적용 전 티켓이 수정되면 새 미리보기가 필요하다. 새 티켓 추가와 기존 티켓 갱신은 하나의 이관으로 적용할 수 있다. 형식 39 자체 백업은 변경분 이관 설정과 필드별 비교 기준을 보존한다.

충돌한 필드의 원본 값이 더 새로운 내보내기에 그대로 들어 있어도 현재 값과 마지막 반영 값을 다시 비교한다. 형식 98 백업은 마지막으로 반영한 기본 필드의 원본 검증값을 함께 보존한다.

`issueRefresh[].fields`의 `parentId`는 두 상위 업무의 키와 제목 또는 최상위를 표시한다. 상위 업무가 확인되는 REST·검색 CSV·RSS XML·관리자 XML 자료를 사용한다. 생략한 필드나 모호한 연결은 현재 값을 보존한다. 같은 원본 프로젝트에서 확인한 기존 업무 또는 이번 적용에서 생성할 업무로 이동할 수 있다. 최종 트리의 순환과 관련 업무의 버전을 확인한다. 형식 100 백업은 상위 업무 비교 기준을 보존한다.

Jira Software의 `Epic Link` 유형이 확인된 REST와 RSS XML, 관리자 XML의 `jira_gh_epic_story`에서 같은 Jira 프로젝트의 에픽을 상위 업무 후보로 읽는다. REST `fields.parent`와 확인한 `Epic Link`의 `null`은 마지막으로 적용한 상위 연결과 근거가 일치할 때만 최상위 이동을 검토한다. 원래 Epic Link 값은 원본에 보관하며 확인한 전용 필드에는 별도 사용자 정의 필드 매핑이 필요 없다. [Jira Epic Link 필드](https://support.atlassian.com/jira/kb/translating-jira-agile-custom-fields/) · [Jira 에픽 링크의 원본 방향](https://support.atlassian.com/jira/kb/reindexing-jira-server-data-center-causes-a-nullpointer-error/)

### 보존 원본의 Jira 마감일 복구

브라우저의 `GET /api/issues/:id/jira-deadline-recovery`는 `{review}`를 반환한다. 최초 이관된 Jira REST 업무와 `YYYY-MM-DD` 원본 마감일, 당시 비어 있던 저장 기준을 확인한다. 후속 이관에서 업무를 갱신하지 않고 보관한 원본도 같은 Jira 인스턴스·프로젝트·업무를 확인해 비교한다. 다른 원본 근거와 모순되거나 대상 연결이 불명확하면 `review`는 `null`이다. 비교에는 관련 원본 200개와 메타데이터 4MiB까지 사용한다.

검토에는 `sourceImportId`, `sourceRecordId`, `sourceKey`, `sourceDueDate`, `currentDueDate`, `issueVersion`, `status`, `revision`이 들어 있다. `ready`는 현재 값이 비어 있고 해당 마감일에 후속 수정 이력이 없음을 확인한 경우다. `current-value`는 저장한 날짜가 있는 경우다. `local-change`는 마감일을 편집한 이력이 있었던 경우다. `history-unverified`는 마감일 편집 유무를 확인할 수 없는 경우다.

`POST /api/issues/:id/jira-deadline-recovery`에 `ready` 상태의 `{revision}`을 보낸다. 같은 트랜잭션에서 원본과 티켓 버전을 다시 대조하고, 일치하면 업무의 목표 마감일과 일반 업무 변경 이력을 저장한다. 응답은 `{issue}`다. 확인 상태가 바뀌면 `409`를 반환한다. 응답을 받지 못하면 다시 조회해 현재 날짜와 원본을 확인할 수 있다.

### 이미 이관한 Jira 업무에 사용자 정의 필드 변경분 반영

`appendTo.refreshCustomFields: true`를 지정하고 `appendTo.fields`에서 원본 속성을 기존 Teamspace 필드 ID에 연결한다. 기본 필드 옵션과 개별 또는 함께 적용할 수 있다. 원본 속성의 식별자와 기존 매핑을 확인한 뒤 새 값을 이전 이관 기준 및 현재 값과 비교한다. 생략한 원본 값, 팀이 수정한 값, 이관 기준이나 현재 표시 조건을 확인할 수 없는 값은 보존한다.

미리보기의 `issueRefresh[].customFields`는 현재 필드 이름·현재 값·원본 값·반영 여부를 반환한다. `updatedCustomFields`와 `conflictingCustomFields`에서 반영하고 보존할 필드 수를 확인한다. 같은 티켓의 기본 필드 및 사용자 정의 필드는 하나의 검증된 편집으로 저장된다. 형식 43 자체 백업은 기본 필드와 독립적으로 다음 비교에 사용할 사용자 정의 필드의 기준을 보존한다.

확인한 Jira 컴포넌트가 있는 패키지는 `GET /api/migrations/options`의 `fields`에 `sourceValue: "jira:components"`를 포함한다. 새 프로젝트 매핑은 기본값인 `multi_select`를 사용하거나 `archive`를 선택한다. 기존 프로젝트에는 활성 여러 선택 필드를 지정한다. 이관한 선택지는 같은 Jira 인스턴스의 컴포넌트 ID를 유지하고, CSV 이름은 원본 프로젝트 범위에서 대조한다. REST `fields.components: []`는 이전 이관 기준이 있는 필드의 비우기를 검토하는 근거다. 생략 또는 확인 불가 상태에서는 현재 값을 보존한다. [Jira Data Center 컴포넌트 API](https://developer.atlassian.com/server/jira/platform/rest/v11002/api-group-component/)

### 기존 Jira 업무에 댓글과 작업 시간 추가

`appendTo.refreshHistory: true`를 지정하면 같은 원본 인스턴스와 프로젝트의 기존 티켓에 새 댓글과 작업 시간 기록을 추가한다. 안정적인 원본 ID, 이전 이관으로 증명되는 대상, 팀원 작성자 매핑과 실제 시각을 확인한다. 작업 시간은 초 단위 원본과 작업일을 유지한다. 이전에 저장한 기록의 원본 ID는 팀에서 기록을 삭제한 뒤에도 중복 방지에 사용한다.

작업 시간·댓글만 있는 관리자 내보내기에서도 기존 원본 연결로 한 프로젝트를 확인할 수 있다. CSV의 위치 기반 댓글, ID 또는 작성자를 확인할 수 없는 기록과 접근이 제한된 기록은 원문으로 보관한다. 미리보기와 영수증의 `newJiraComments`, `newJiraWorklogs`에서 기존 티켓에 추가할 수를 확인한다. 기본 필드와 사용자 정의 필드 변경분 옵션을 함께 선택할 수 있다. 형식 44 자체 백업은 추가 설정과 원본 연결을 보존한다.

신규·추가 Jira 댓글의 이름 붙은 웹 링크는 `Comment.body`에 `이름 <주소>` 형식으로 저장한다. 티켓의 읽기 화면은 자격 정보가 없는 HTTP(S) 주소를 링크로 표시한다. 링크를 펼친 본문이 20,000자를 넘거나 검색 XML의 HTML 구조를 변환할 수 없을 때는 이전 방식으로 표시할 수 있는 본문을 적용하고 `JIRA_COMMENT_LINKS_ARCHIVED` 검토 항목에 원본 링크 위치를 안내한다. 원본 기록에는 이관 전 본문을 보존한다.

브라우저의 `GET /api/comments?resourceType=issue&resourceId=…`는 유일한 보존 원본과 원래 Jira 업무를 확인한 댓글에 `jiraOriginalLinksAvailable: true`를 반환할 수 있다. 이 값은 브라우저의 조회 버튼 표시용이다. 자세한 링크는 `GET /api/comments/:id/jira-original-links`가 해당 댓글을 다시 확인한 뒤 `{links:[{label,href}],limited}`로 반환한다. 접근 제한이나 중복으로 근거를 확인할 수 없거나 현재 티켓·댓글이 휴지통에 있으면 `404`를 반환한다.

원본 링크는 한 번에 20개, 원본 256KiB, 주소 2,048자까지 확인한다. 한도나 지원 범위 때문에 일부 또는 전체를 읽지 못하면 `limited: true`를 표시한다. 원본은 요청 때만 해석하며 주소에 접속하지 않고 링크의 이름과 주소를 반환한다. 읽기 응답은 `Cache-Control: no-store`를 사용한다. 이 조회는 일반 댓글 본문, 원본 기록, 백업 형식을 그대로 사용한다.

### 기존 Jira 업무에 첨부파일 추가

`appendTo.refreshAttachments: true`를 지정하면 같은 원본 인스턴스와 프로젝트에서 소유 업무를 확인할 수 있는 새 원본 첨부파일을 추가한다. 원본 ID가 같으면 이미 저장한 파일과 삭제 기록을 보존하고, 이름이 같아도 원본 ID가 다르면 별도의 파일로 추가한다. 업무 객체가 빠진 관리자 ZIP에서는 이전 이관 기록으로 연결을 확인한다.

원본 패키지에서 일치하는 바이트의 크기와 SHA-256을 미리보기 및 적용 과정에서 확인한다. 바이트나 원본 연결을 확정할 수 없는 파일은 이관 검토에서 확인한다. 미리보기와 영수증의 `newJiraAttachments`에서 기존 티켓에 추가할 파일 수를 확인한다. 댓글·작업 시간과 필드 변경분 옵션을 함께 선택할 수 있다. 형식 45 자체 백업은 추가 설정과 파일의 원본 연결을 보존한다.

### 기존 Jira 업무 사이의 관계 추가

`appendTo.refreshRelations: true`를 지정하면 같은 Jira 인스턴스에서 이관한 기존 티켓 두 건에 새 원본 업무 관계를 추가한다. 두 원본 프로젝트를 서로 다른 Teamspace 프로젝트에 이관한 경우에도 한쪽이 선택한 대상 프로젝트에 속하고 양쪽 원본 매핑이 확인되면 적용할 수 있다. REST·검색 XML의 방향 표기와 관리자 XML의 양쪽 ID를 해석한다. 관계만 있는 관리자 XML은 추가 이관 대상의 원본 프로젝트를 유일하게 확인할 수 있을 때 검토한다. [Jira Data Center 관계 API](https://developer.atlassian.com/server/jira/platform/rest/v10006/api-group-issuelink/) · [Jira 관계 방향 모델](https://developer.atlassian.com/cloud/jira/platform/issue-linking-model/)

`counts.newJiraRelations`와 `counts.skippedJiraRelations`는 기존 업무 사이에 추가할 관계와 보관할 원본 관계 건수다. `jiraRelationRefresh`에는 추가할 관계를 최대 20건 표시한다. 각 행은 원본 `recordId`, Teamspace의 `sourceKey`·`targetKey`, 원본 `type`을 담는다. 서로 다른 Teamspace 프로젝트를 잇는 행에는 `sourceProjectName`과 `targetProjectName`도 포함된다. 현재 연결과 동일함을 확인한 관계, 이미 적용한 원본, 양쪽 출처가 불분명하거나 서로 모순된 관계는 건너뛴다. 원본은 이관 기록에서 조회한다.

적용은 관련 업무·연결·원본의 변경 여부를 확인한다. 두 티켓의 변경 이력, 관계, 영수증과 원본 연결 ID(`jiraRelationId`)를 함께 저장한다. 프로젝트 간 관계의 양쪽 대상은 영수증의 `projectIds`에 포함된다. 형식 66 백업은 적용한 원본 관계 ID를 보존한다. 전체 이관 검증의 `targetContent.issueRelations`는 관계만 적용한 영수증의 연결도 집계하고 해시를 계산한다. 차단 관계의 간트 선후행은 티켓에서 방향을 검토한 뒤 별도로 저장한다.

### 기존 프로젝트에 새 Confluence 문서 추가

선택한 페이지가 같은 Confluence 인스턴스와 한 원본 공간에 속하고, 해당 공간이 기존 Teamspace 프로젝트에 연결되어 있으면 `appendPagesTarget`에 대상 프로젝트와 원본 공간이 포함된다. `configuration.appendPagesTo`에 `{projectId}`를 지정한다. 한 미리보기는 Jira 또는 Confluence 중 하나의 추가 이관을 처리한다.

`counts.documents`는 새 문서 수, `retainedPages`와 `retainedRecords`는 이전에 이관한 페이지와 함께 제출해 원본으로 보관하는 기록 수다. 이미 이관한 문서의 현재 제목·본문과 휴지통 상태를 보존한다. 새 문서는 같은 공간과 프로젝트에서 확인한 기존 문서를 상위 문서나 본문 참조에 쓸 수 있다. 적용 직전에 원본 연결과 대상 문서의 현재 프로젝트를 확인한다. 형식 38 자체 백업은 추가 이관의 대상을 보존한다.

현재 페이지 본문의 앵커는 대상이 유일한 제목 절을 확인했을 때 Teamspace 문서 절 링크로 바꾼다. 대상을 확인하기 어려운 링크는 읽을 수 있는 원본 표기를 남기고 `SECTION_LINK_UNRESOLVED`로 표시한다. 기존 문서의 절을 가리키는 계획은 적용 시 그 절이 남아 있는지 다시 확인한다.

### 이미 이관한 Confluence 문서에 원본 변경분 반영

`appendPagesTo.refreshExisting: true`를 지정하면 현재 프로젝트에 연결된 기존 문서의 제목·본문·라벨·상위 문서를 비교한다. 제목과 본문은 일반적으로 더 높은 원본 버전이나 확인 가능한 최신 수정 시각을 사용한다. 팀이 편집한 필드, 내보내기에서 생략한 본문, 참조나 첨부를 확인할 수 없는 본문은 현재 값을 보존한다.

명시적인 Confluence XML 상위 페이지나 최상위 정보가 있는 경우 `documentRefresh[].fields`의 `parentId`에서 위치를 비교한다. 상위 페이지는 같은 원본 공간의 기존 Teamspace 문서 또는 같은 적용에서 생성할 문서여야 한다. 원본 위치가 모호하거나 빠진 경우에는 현재 위치를 유지한다. 같은 원본 버전에서 위치만 바뀌면 확인 가능한 최신 수정 시각과 일관된 제목·본문 근거를 사용한다. 적용 전에 관련 문서 버전과 최종 트리의 순환을 확인한다. 형식 99 백업은 두 번째 내보내기 이후에도 마지막으로 반영한 위치를 대조할 근거를 보존한다.

체크리스트가 포함된 원본 전체가 코드 블록으로 저장된 경우, 같은 원본 버전과 제목·본문을 다시 제공해도 복구를 검토할 수 있다. 저장된 코드 블록이 당시 원문과 일치하고 정상 변환이 가능하면 `documentRefresh`의 본문 행과 `CONFLUENCE_REFRESH_CHECKLIST_RESTORED` 확인 항목에 나타난다. 적용하면 해당 문서의 새 저장본과 이관 기준이 만들어진다.

라벨은 `labels` 또는 `labellings` 컬렉션의 소유 페이지와 전체 관계를 확인한다. 전체 범위가 입증되면 명시적으로 빈 목록도 반영할 수 있다. 더 새로운 부분 내보내기에서 확인한 전역 라벨은 기존 목록에 추가할 수 있다. 제외하거나 범위를 확인하기 어려운 라벨과 생략된 목록은 삭제 근거에서 빠진다. 같은 원본 버전에서도 원본 제목·본문이 일치하고 전체 목록을 확인하면 라벨을 검토할 수 있다. 원본 순서는 적용 전에 확인한다. 기존 영수증에 라벨 비교 기준이 없으면 차이가 있는 팀 라벨을 보존한다. [Confluence 라벨 API](https://developer.atlassian.com/server/confluence/rest/v927/api-group-content-labels/)

`preview.documentRefresh`로 현재 값·원본 값·반영 여부와 서식만 바뀐 본문을 확인한다. `updatedDocuments`, `updatedDocumentFields`, `conflictingDocumentFields`, `skippedDocumentUpdates`는 검토 수량이다. 한 요청은 기존 문서 300개와 비교 데이터 64MiB까지 지원한다. 본문을 갱신할 때는 문서 버전, 현재 공동 편집 참여자, 적용 후 포함 관계의 순환 여부를 확인한다. 라벨만 반영할 때는 현재 본문과 편집 세대를 유지하며 문서 버전을 검사한다. 적용은 문서 이력과 영수증을 함께 저장한다. 형식 40 자체 백업은 제목·본문 비교 기준을, 형식 61은 라벨 비교 기준도 보존한다.

팀 편집으로 보존한 제목·본문은 다음 원본 버전에서도 마지막으로 반영한 값과 비교한다. 형식 98 백업은 마지막으로 반영한 본문의 원본 검증값을 보존한다. 같은 본문이 더 새로운 버전에 다시 포함될 때 기존에 해결한 문서·첨부 참조를 유지한다.

### 기존 Confluence 문서에 첨부와 버전 추가

`appendPagesTo.refreshAttachments: true`로 기존 문서에 새 원본 첨부를 추가하고, 이전에 연결된 첨부에는 더 높은 원본 버전 번호를 확인해 추가한다. 제목·본문의 변경분 옵션과 함께 또는 개별로 적용할 수 있다. 원본 첨부 ID, 원래 소유 페이지와 버전으로 첨부를 식별한다. 휴지통과 영구 삭제 기록이 있는 기존 첨부는 원문에 보관한다.

같은 공간의 기존 원본 첨부는 원본 ID나 확인된 소유 페이지와 파일명으로 찾아 저장한 파일의 고정 버전에 연결한다. 재사용 대상은 미리보기와 적용 시 크기·SHA-256으로 검사한다. `newConfluenceAttachments`, `newConfluenceAttachmentVersions`, `reusedConfluenceAttachmentVersions`에서 기존 문서의 새 첨부, 기존 첨부에 추가할 버전과 본문에서 재사용할 버전을 확인한다. 이전 링크는 당시 파일 ID로 열리며, 파일 목록은 팀이 직접 추가한 최신 버전을 우선한다. 형식 41 자체 백업은 추가 원본 버전과 이관 설정을 보존한다.

### 기존 Confluence 문서에 댓글과 이력 추가

`appendPagesTo.refreshHistory: true`를 지정하면 같은 원본 인스턴스와 공간에서 기존 문서로 확인된 페이지에 새 원본 댓글과 과거 저장본을 추가한다. 원본 파일에 현재 페이지나 공간 객체가 빠진 경우에는 기존 이관 기록으로 소유 페이지와 공간을 확인한다. 제목·본문, 첨부 옵션과 개별 또는 함께 적용할 수 있다. 현재 문서 버전과 팀에서 작성한 댓글을 보존한다. 이미 이관한 원본 댓글 ID와 문서의 원본 버전은 삭제 이력이 있더라도 알아본다. 소유 페이지, 본문, 버전이나 첨부를 확인할 수 없는 자료는 영수증에 원문으로 보관한다.

미리보기와 영수증의 `newConfluenceComments`, `newConfluenceRevisions`에 추가 건수가 들어간다. 문서 이력과 고정 저장본 목록에서 과거 원본 저장본의 `confluenceSourceVersion`을 읽을 수 있다. 원본 저장본에서 복구하면 새 Teamspace 문서 버전이 생성된다. 형식 42 자체 백업은 추가 이관 설정과 원본 버전 표시를 보존한다.

처음 이관하거나 기존 문서에 추가할 새 댓글의 원문 위치는 같은 XML 패키지의 댓글 속성과 소유 페이지에 있는 `ac:inline-comment-marker`로 확인한다. `confluenceInlineCommentsAnchored`에는 Teamspace 문장 댓글로 옮길 수량이, `confluenceInlineCommentsUnresolved`에는 위치 속성을 읽었으나 하나의 정확한 본문 범위를 확정하지 못해 일반 댓글로 옮길 수량이 들어간다. 원본 댓글 속성의 소유권이나 값이 불명확한 경우는 분석 진단에서 확인한다. 변경분에서는 현재 저장 본문 또는 같은 적용에서 반영할 본문과 대조하고, 적용 전 본문이 달라지면 `409`를 반환한다. 연결된 댓글의 `documentSource`는 일반 문장 댓글 조회와 자체 백업에서 읽을 수 있다.

같은 원본 페이지의 직접 답글 관계는 상위 댓글의 고정 원문을 확인해 `parentCommentId`로 보존한다. 댓글·이력 추가 이관에서는 상위 댓글 객체가 ZIP에 없을 때 같은 인스턴스와 소유 페이지의 이전 이관 기록에서 활성 댓글을 대조한다. 미리보기와 영수증에 `confluenceInlineRepliesLinked`, `confluenceInlineRepliesUnresolved`가 표시된다. 상위 댓글이 확인된 뒤 삭제되거나 연결을 확인할 수 없게 되면 적용 전체를 중단하고 `409`를 반환한다. 답글과 상위 댓글의 관계는 기존 댓글 조회, 휴지통과 자체 백업을 사용한다.

### 적용 후 대조

브라우저의 `GET /api/source-imports/:id/reconciliation`은 영수증 전체의 상태별 건수와 현재 조회의 `total`, `offset`, `limit`, `rows`를 반환한다. `kind`, `status`, `q`로 원본 종류·연결 상태·원래 키·제목을 검색한다. `offset`은 0~1,000,000, `limit`은 1~100이며 기본값은 각각 0과 30이다. 결과의 현재 대상에는 업무·문서로 이동하는 데 필요한 ID와 프로젝트가 들어 있다. 원문과 적용 당시 진단은 기존 원본 기록과 영수증에서 읽는다.

`GET /api/source-imports/:id/notices/:index/source`의 `index`는 영수증의 `notices`에서 0으로 시작하는 위치다. `expectedVersion`에는 조회한 영수증 버전을 보낸다. 일치하는 기록 하나를 `SourceRecordArchive`로 반환한다. 영수증 버전이 달라졌으면 `409`, 개별 기록이 없거나 같은 영수증과 패키지에서 원본을 하나로 확인할 수 없으면 `404`를 반환한다.

`packageId`로 이 영수증의 원본 패키지 `stagingId`를 지정하면 제품·인스턴스·원본 SHA-256이 모두 일치하는 원본을 조회한다. 다른 영수증의 패키지나 알 수 없는 ID에는 `404`를 반환한다. `counts`는 선택한 패키지 전체의 상태별 건수이고, `total`과 `rows`에는 나머지 조건을 함께 적용한다. 패키지와 `finding=invalid-primary-target`을 보내면 전체 이관 검증의 `invalidTargets`에 해당하는 티켓·페이지를 조회한다. 보존 원본의 대상 정보 오류는 `invalidPrimaryTarget: true`, 원본 ID·Jira 키의 연결 인덱스 오류는 `invalidPrimaryBinding: true`로 표시한다.

`linked`는 현재 대상, `trashed`는 휴지통에 해당 대상이 보관된 상태, `missing`은 저장한 연결에 해당하는 현재나 휴지통의 대상이 없는 상태다. `archive-only`는 직접 연결 없이 보존한 원본이다. 새 이관의 `excluded`에는 명시적으로 제외한 원본과 함께 제외된 하위 원본이 포함된다. 원본 사용자·속성 등의 매핑 자료와 직접 연결 ID가 없는 관계 자료는 원본 보관으로 표시한다.

`GET /api/source-imports/:id/records/:recordId/check-file`은 지정한 원본 첨부 버전의 저장 바이트를 기록된 파일 크기와 SHA-256으로 검사한다. `verified`, `missing`, `corrupt`, `unbound` 상태와 연결된 파일의 식별 정보를 반환한다. 휴지통에 보관한 파일 버전도 검사할 수 있다.

`GET /api/source-imports/:id/reconciliation/audit?expectedVersion=…`는 해당 영수증의 전체 대상 상태를 집계하고 활성·휴지통의 원본 첨부 버전을 검사한다. `recordCounts`와 `attachmentCounts`는 전체 건수다. `attachments`에는 원본 제품·인스턴스·패키지 해시·원본 ID·현재 대상 상태와 대상 파일 ID·기준 크기·기준 SHA-256이 들어 있다. 검증 상태는 `verified`, `missing`, `corrupt`, `unbound`, `excluded`, `unreadable`이다.

`integrity`의 `records`와 `boundAttachments`는 보존 원본 수와 대상 첨부 버전 ID가 연결된 원본 수의 이관 당시 기준(`expected`)과 검사값(`observed`)이다. `packages`는 이름·수량·원본 집합 SHA-256을 패키지별로 대조한다. `verified`는 저장된 원본 기준과 일치, `mismatch`는 불일치, `counts-only`는 당시 수량만 비교 가능, `unavailable`은 당시 기준을 읽을 수 없는 상태다. `unmatchedRecords`와 `columnMismatches`는 출처를 확인할 수 없는 기록과 저장 식별 정보 불일치를 보여준다. 원본 무결성 `verified`와 현재 대상·파일 상태는 독립된 결과다.

`primaryRecords`는 패키지마다 `packageId`, 원본 종류 `kind` (`issue` 또는 `page`), 연결 상태별 `counts`, `invalidTargets`, `dispositionSha256`을 반환한다. Jira 업무와 Confluence 현재 페이지의 원본 행을 각각 센다. 여러 원본 행이 같은 Teamspace 대상을 가리켜도 각 원본 행을 해당 패키지에서 센다. 대상 종류가 다르거나 종류·ID 중 하나만 저장됐거나, 제외한 원본에 연결이 남으면 `invalidTargets`에 집계한다. 대상이 연결된 각 행의 원본 ID와 저장된 Jira 원래 키가 같은 대상으로 이어지는지, 인덱스가 참조하는 영수증이 그 연결을 입증하는지도 대조한다. 인덱스 오류는 원본 행당 한 번 집계한다. `dispositionSha256`으로 같은 원본의 대상·상태와 인덱스 오류를 비교할 수 있다. 이 항목에는 원래 키, 제목, 본문이 들어가지 않는다.

`targetContent`의 `version`은 `1`이다. `comments`, `revisions`, `worklogs`, `issueRelations`는 각각 저장된 대상의 `count`와 `sha256`을 반환한다. 원본에 연결된 댓글과 작업 기록은 보관 데이터가 남은 휴지통과 삭제 기록도 포함한다. 문서 이력은 직접 연결한 버전과 영수증에 연결한 문서의 저장 이력을 한 번씩 센다. 업무 관계는 영수증에 연결된 활성 업무가 양쪽 중 하나에 있는 관계를 센다. 이 값은 현재 대상의 복원 전후 대조에 쓰며, `targetContent`에는 본문이나 작성자 정보가 들어가지 않는다.

이관 미리보기의 `authorAttribution`은 패키지 ID와 대상 종류별 상태 건수를 반환한다. 새 영수증은 `authorAttributionVersion: 1`을 기록하고, 전체 검증 응답의 `authorAttribution`은 `{version:1,packages,fingerprint}`를 반환한다. 종류는 `document`, `comment`, `revision`, `attachment`, `worklog`다. `mapped`는 매핑한 팀원과 일치, `unmapped-fallback`과 `missing-fallback`은 매핑 또는 원본 작성자 정보가 없어 이관 작업자로 기록, `retained`는 기존 작성자를 유지한 문서다. 확인할 대상이 없으면 `unavailable`, 기록된 대상 또는 작성자가 다르면 `mismatch`다. 매핑이 없는 작업 시간은 적용 진단과 보존 원본에서 확인한다. 이전 영수증의 작성자 검증은 `null`이다.

`GET /api/source-imports/:id/reconciliation/author-findings`에는 `expectedVersion`, `packageId`, `kind`, `status`를 보낸다. 전체 검증의 `fingerprint`를 `expectedFingerprint`로 전달하면 페이지를 조회하기 전에 같은 대상을 대조한다. 버전이나 대조 목록이 달라지면 `409`다. `offset`은 0~1,000,000, `limit`은 1~100이다. 응답의 `rows`에는 `sourceRecordId`, `sourceId`, `kind`, `status`, `targetId`, `expectedAuthorId`, `actualAuthorId`가 들어 있다. `sourceRecordId`로 보존한 원본을 조회할 수 있다. 자체 백업 형식 111이 영수증과 원본에 저장된 비교 기준을 보존한다.

Jira 패키지가 있는 영수증의 `jiraStatusHistory`는 보관 원본에서 확인한 상태 변경 수 `sourceChanges`를 반환한다. 이 값은 활성 티켓에 표시되는 `projected.count`, 다른 원본 기록과 겹치는 `duplicate`, 명시적 제외 `excluded`, 접근 제한 `restricted`, 현재 업무 연결을 확인할 수 없는 `unavailable`의 합이다. `unresolvedTime`과 `unresolvedAuthor`는 표시된 항목에서 시각과 작성자를 확정하지 못한 건수다. `projected.sha256`으로 티켓 연결 및 표시 내용의 복원 전후 일치를 대조한다. Confluence만 있는 영수증에서는 `jiraStatusHistory`가 `null`이다. 집계 범위는 이관 영수증에 저장된 원본이다.

브라우저의 `GET /api/source-imports/:id/reconciliation/jira-status-findings`에는 `expectedVersion`과 `finding`을 지정한다. 선택값은 `unavailable`, `restricted`, `excluded`, `unresolved-time`, `unresolved-author`다. `offset`은 0~1,000,000이며 기본값은 0이다. `limit`은 1~100이며 기본값은 30이다. `total`은 원본 변경 그룹 수, `totalChanges`는 해당 조건에 맞는 개별 변경 수다. 각 행의 `sourceRecordId`로 같은 영수증에서 원문을 열 수 있다. `sourceInstance`, `sourceId`, `sourceIssueId`는 원본 인스턴스와 보관된 변경 그룹·업무 식별자다. `changeCount`는 그 행의 조건 일치 건수다. `unavailable` 행은 휴지통, 저장된 연결 대상 없음, 현재 업무 연결 근거 부족을 `reason`으로 구분한다.

다음 페이지에서 첫 요청의 `fingerprint`를 `expectedFingerprint`로 보내면 같은 조건과 목록을 대조한다. 영수증 버전이나 목록이 달라지면 `409`를 반환한다. 상태·작성자·시각의 상세는 개별 원본 기록으로 확인한다.

전체 이관 검증의 `jiraRelationProjection`은 `jiraRelationId`가 저장된 원본 관계를 대조한 `{version:1,expected,counts,sha256}`이다. `expected`는 이관 당시 관계 건수이며, 기록이 없을 때는 `null`이다. `counts`는 현재 연결 `linked`, 휴지통에 정확한 관계가 보관된 `trashed`, 양쪽 업무가 보존됐지만 관계가 없어진 `missing`, 원본과 연결이 다른 `mismatch`, 업무 연결 근거를 확인할 수 없는 `unavailable`로 나뉜다. 원본에 관계 식별자가 없으면 당시 건수와 추적 건수의 차이로 나타날 수 있다. Confluence만 있는 영수증에서는 `jiraRelationProjection`이 `null`이다.

`GET /api/source-imports/:id/reconciliation/jira-relation-findings`에 `expectedVersion`, `expectedSha256`, `finding`을 지정한다. `finding`은 `missing`, `mismatch`, `unavailable` 중 하나다. `offset`의 범위는 0~1,000,000이며 기본값은 0이다. `limit`의 범위는 1~100이며 기본값은 20이다. 영수증 버전이나 전체 검증의 `jiraRelationProjection.sha256`과 조회 결과가 달라졌으면 `409`를 반환한다. 각 행의 `sourceRecordId`로 같은 영수증의 개별 보존 원본을 열 수 있다.

서버는 파일을 순서대로 읽고, 보존 원본에 크기·해시가 있으면 그 값도 대조한다. 검증 중 영수증·보존 원본·대상·첨부 메타데이터가 바뀌거나 워크스페이스가 복원되면 `409`를 반환한다. 시작·완료 시각은 검증 구간을 나타낸다. 워크스페이스당 한 번씩 실행하며, 진행 중 다른 전체 검증 요청은 `429`를 반환한다. 이 경로는 브라우저용이다.


## 프로젝트 보고서와 주간 문서

| 브라우저 경로 | 동작 |
| --- | --- |
| `GET /api/projects/:id/report` | 필수 `startDate`·`endDate`(YYYY-MM-DD)·`timeZone`(IANA), 선택 `issueType`·`assigneeId` 조건으로 집계 |
| `GET /api/projects/:id/report-snapshots` | 최근 보관본 최대 100개의 제목·기준 시각·문서 ID·조회 조건 |
| `GET /api/projects/:id/report-snapshots/:snapshotId` | 당시 조건·집계·업무 목록을 포함한 보관본 조회 |
| `POST /api/projects/:id/report-snapshots` | `{title, query}`로 다시 집계하고 보관본과 주간 문서 초안을 같은 트랜잭션에 생성. `query`는 경로와 같은 `projectId` 및 조회 조건을 포함. 신규 생성 시 `201` |

자동화에서는 경로 앞의 `/api`를 `/api/v1`으로 바꾼다. 조회에는 프로젝트 범위의 읽기 또는 쓰기 키를 사용한다. 보관본 목록과 상세에는 URL 쿼리 매개변수가 없다. 업무가 이동하거나 삭제된 뒤에도 출발 프로젝트에서 관측해 저장한 값은 해당 프로젝트의 보관본에 남는다. 연결된 문서의 현재 본문은 `GET /api/v1/documents/:id`로 조회하며 문서의 현재 프로젝트 범위가 적용된다.

`POST /api/v1/projects/:id/report-snapshots`는 쓰기 키와 `{requestId, title, query}`를 받는다. `requestId`는 호출자가 생성한 UUID v4다. `query`에 경로와 일치하는 `projectId`, `startDate`, `endDate`, `timeZone`을 보낸다. `issueType`, `assigneeId`는 생략할 수 있다. 보관본의 작성자는 API 키 소유자다.

최초 요청은 `201`과 보관본(`ReportSnapshot`)을 반환한다. 같은 작업자가 같은 요청 ID로 동일한 제목과 조회 조건을 다시 보내면 `200`과 저장한 당시의 보관본을 받는다. 이후 업무와 문서의 편집은 보관본에 반영되지 않는다. 이미 사용한 ID의 입력이나 작업자가 달라지면 `409`다. 연결 문서가 다른 프로젝트로 이동했거나 휴지통에 있거나 자체 백업 복원으로 생성 기록이 무효화되면 재시도는 `409`로 응답한다. 남아 있는 보관본은 상세 경로에서 조회할 수 있다.

보고서는 요청 시점의 상태·마감과 기간 중 사건을 분리한다. 조회 기간은 현지 시작일 자정부터 종료일 다음 날 경계 직전까지 1~92일이다. 마감은 명시한 마감일을 우선하며 없으면 일정 종료일을 사용한다. 마감 임박은 조회 시점의 현지 오늘부터 7일 뒤까지다. 기간별 유형·담당자 필터는 각 변경의 당시 값으로 적용한다. 업무 행은 현재 또는 기간 내 관측 조건에 해당하는 최대 5,000개까지 조회할 수 있다.

완료 업무 수는 적어도 한 번 완료 상태로 이동한 고유 업무 수다. 완료 전이에서 해당 업무 수를 뺀 값이 재완료 수다. 재개는 완료에서 진행 가능한 상태로 이동한 횟수다. 워크플로 상태 정의 변경과 기존·이관 업무의 수집 기준점은 별도로 기록한다. 소요 시간은 실제로 관측한 진행 또는 검토 시작부터 완료 전이까지의 경과 시간이며 표본 수와 함께 표시한다. 관측 구간별 날짜 마감 시점 상태를 계산하고, 마감 시점의 데이터가 없으면 상태가 `null`이다.

보고서 정의 2의 `statusDuration.completedVisits`는 상태 ID별 실제 이탈을 집계한다. 유형·담당자 조건에는 각 이탈 직전 값을 쓰고, 같은 관측 구간의 진입이 확인된 `samples`에만 `medianHours`와 `maxHours`를 계산한다. 그 밖의 이탈은 `unknownEntries`에 포함한다. `statusDuration.openIssues`는 `generatedAt` 당시의 미완료 업무이며 유형·담당자 조건에는 현재 값을 쓴다. 선택한 날짜 범위 밖에서 진입한 업무도 포함한다. 진입을 확인할 수 없는 행의 `enteredAt`과 `elapsedHours`는 `null`이다. 기존 정의 1 보관본은 당시 집계를 제공한다. 정의 2 보관본은 자체 백업 형식 55에 저장한다.

제목은 앞뒤 공백을 제거한 뒤 1~200자다. 서버가 집계하고 저장한 값을 읽기 전용으로 제공하며 주간 문서는 계속 편집할 수 있다. 문서의 업무 참조는 최대 30개이고 전체 행은 보관본에서 확인한다.

자체 백업 schema10 이상은 `reportingLedger`와 `reportSnapshots`를 포함한다. 백업은 내보낸 시각까지의 이력을 저장한다. 복원 시 새 수집 구간과 당시의 업무 기준 상태를 만든다. schema1~9 복원에는 이전 보고 이력이 없으며 복원 시각부터 수집한다.


## 간트 수동 일정 변경

브라우저의 `POST /api/schedule/manual-preview`에 `{issueIds,days,workingDays}`를 보내 여러 업무를 이동하거나 `{changes:[{id,expectedVersion,startDate,endDate}]}`로 날짜를 직접 지정한다. 대상은 1~1,000개이며, 이동 일수의 범위는 −3,650~3,650이다. 날짜를 직접 지정할 때는 두 날짜에 각각 `YYYY-MM-DD` 또는 `null`을 보낸다. 여러 프로젝트가 포함된 근무일 이동은 각 업무가 속한 프로젝트의 달력을 사용한다.

직접 지정, 선택 업무 이동, 상위·하위 이동에 `rescheduleSuccessors: true`를 함께 보내면 각 프로젝트의 직접·간접 후행을 검토한다. 직접 지정은 현재 값과 같은 날짜 쌍도 기준으로 계산하고, 이동은 이동 일수로 날짜가 달라진 업무를 기준으로 삼는다. 기준 날짜를 고정하고 공통 후행은 모든 연결 조건을 적용해 한 번 계산한다. `changes`에는 날짜가 달라지는 업무를 반환하며, 후행 조정으로 날짜가 달라진 업무는 `followUpIssueIds`에도 기록한다. 1,000개 변경 한도는 모든 프로젝트의 기준과 후행 변경을 합산한다. 적용 시 검토한 후행 업무와 연결, 프로젝트 규칙을 함께 확인한다.

상위 업무와 하위 업무를 함께 이동할 때는 `{hierarchy:{id,expectedVersion},days,workingDays}`를 보낸다. 서버가 기준 업무와 같은 프로젝트의 전체 하위 단계에서 최대 1,000개까지 계산한다. 완료·취소 상태와 시작일·종료일이 모두 없는 업무는 `skipped`의 `{id,key,title,reason}`에 기록된다. `reason`은 각각 `closed`, `unscheduled`다. 한쪽 날짜만 저장한 업무는 그 날짜를 이동한다. 적용 시 하위 업무 구성과 각 업무의 상위 연결도 확인한다.

응답은 `changes`, 관련 업무의 `warnings`와 적용 가능한 경우 `previewId`·`expiresAt`을 반환한다. 변경할 날짜가 없거나 `blocking`에 확인할 이유가 있으면 적용 ID를 발급하지 않는다. `POST /api/schedule/manual-apply`에는 `{previewId}`를 보내며, 같은 작업자의 미리보기와 선택 업무·관련 업무·선후행 연결·프로젝트 규칙을 확인한다. 검토한 조건이 달라지면 `409`로 응답하고 날짜는 유지한다.

성공 시 `{undoId,updated,warnings}`를 반환한다. 날짜와 되돌리기 정보, 적용 결과는 한 트랜잭션으로 저장한다. 미사용 미리보기는 30분간 유효하며, 같은 미리보기의 적용 결과는 7일 안에 다시 조회할 수 있다. `POST /api/schedule/undo`에 `{undoId}`를 보내 해당 날짜 변경을 되돌린다.

### 수동 날짜 변경의 프로젝트 간 차단 경고

수동 일정, 날짜 일괄 편집, 일정 붙여넣기, 업무 행 편집은 열린 프로젝트 간 차단 관계에서 선행 종료일 또는 후행 시작일이 바뀌는 경우를 검토한다. 방향이 확인된 Jira 관계를 포함하고, 같은 방향에 Teamspace 관계가 있으면 한 건으로 합친다. 같은 미리보기에서 양쪽을 바꾸면 두 제안 날짜를 사용한다. 후행 업무 달력의 FS·0근무일 조건에 어긋나거나 필요한 날짜가 비어 있으면 `teamBlockerWarnings`와 `warnings`에 표시한다. 일반 날짜 변경에서는 경고를 검토한 뒤 그대로 적용할 수 있다. 업무 버전, 활성 관계 또는 후행 달력이 달라지면 새 미리보기를 요구한다. 검토 당시 관계가 없었어도 새로 해당하는 관계가 생기면 적용은 `409`를 반환한다.

### 프로젝트 간 날짜와 차단 관계 함께 적용

`POST /api/schedule/team-blocker-edit/preview`에 `{source:{id,expectedVersion,dates?},target:{id,expectedVersion,dates?}}`를 보낸다. `dates`에 바꿀 `startDate`와 `endDate`만 넣는다. 날짜는 `YYYY-MM-DD` 또는 `null`이며 빠진 칸은 현재 값을 쓴다. 서로 다른 프로젝트의 열린 업무를 검토하며, 같은 방향의 기존 Teamspace 관계나 확인된 Jira 차단이 있으면 `409`를 반환한다. `changes`와 `warnings`에 변경 날짜와 대상 달력의 FS·0근무일 조건, 관련 연결의 경고를 반환한다.

`POST /api/schedule/team-blocker-edit/apply`에 `{previewId}`와 팀 간트의 되돌리기 범위를 보낸다. 작업자와 두 업무·달력·워크플로·관련 업무 및 연결을 대조한 뒤 새 관계, 날짜와 적용 결과를 함께 저장한다. 적용 시 검토 조건이 달라졌으면 `409`를 반환한다. 결과는 `{undoId,updated,warnings,relation}`이다. 미리보기는 30분 동안 유효하고, 적용 결과는 같은 미리보기로 7일 안에 다시 확인할 수 있다. 되돌리기 결과의 `relationChanges`는 제거한 새 차단 관계의 수다.

## 마지막 일정 변경 되돌리기

브라우저의 일정 적용 요청은 `X-Teamspace-Schedule-Undo-Scope`에 적용을 시작한 화면을 보낸다. 값은 `team`, `project:<프로젝트 ID>` 또는 기준 티켓의 `issue:<업무 ID>`다. ID는 URI 구성 요소로 인코딩한다. 티켓 범위는 해당 티켓에서 검토한 일정과 연결 편집에 사용한다.

`GET /api/schedule/undo/latest?scope=team`으로 전체 프로젝트 간트의 마지막 변경을 읽는다. 프로젝트와 티켓은 각각 `scope=project&id=<ID>` 또는 `scope=issue&id=<ID>`를 사용한다. 작업자와 화면이 일치하는 최근 7일의 마지막 변경을 `{undo:{undoId,appliedAt,issueCount,dependencyChanges,planCount,relationChanges?}}`로 반환한다. 대상이 바뀌었거나 이미 되돌렸으면 `{undo:null}`을 반환한다. 한 단계 되돌리기여서 이전 변경으로 자동 이동하지 않는다.

`POST /api/schedule/undo`에 `{undoId}`를 보낸다. 이 기록을 만든 작업자와 현재 업무·계획·연결의 버전을 검사하고 한 트랜잭션에서 복원한다. 요청에 화면 헤더가 있으면 저장한 범위와 그 범위의 최신 변경을 대조한다. 다른 탭에서 새 변경을 저장했다면 이전 ID는 `409`를 반환한다. 응답은 `{updated,warnings,plan?,dependencyChanges?,relationChanges?}`다. 응답을 잃었으면 같은 ID로 `POST /api/schedule/undo?retry=true`를 보낸다. 7일 안에 완료한 경우 저장된 결과와 `duplicate:true`를 반환한다. 일반 요청에서 이미 실행한 ID는 `409`를 반환한다. 물리 복원은 관련 기록을 보존하며 자체 JSON 복원은 초기화한다.

## 기준 업무와 후행 일정 함께 적용

브라우저의 `POST /api/schedule/auto-preview`에 `{projectId, anchorChange: {id, expectedVersion, startDate, endDate}}`를 보낸다. 양쪽 날짜는 `YYYY-MM-DD` 또는 `null`이다. 기준 날짜를 그대로 사용해 프로젝트 안의 직접·간접 후행 업무를 계산한다. 이 모드에는 일반 자동 일정의 `issueIds`, `anchorDate`, `defaultDuration`, `seedChanges`를 함께 보내지 않는다. 반환값의 `changes`는 검토할 날짜이고 `blocking`은 함께 적용하기 전에 해결할 항목이다.

`POST /api/schedule/auto-apply`에 `{previewId}`를 보낸다. 작업자와 미리보기의 업무·연결·달력·워크플로·양식 버전을 확인한다. 정상 적용은 같은 트랜잭션에서 업무 날짜와 되돌리기 기록을 저장하고, 동일 미리보기의 재요청은 저장한 결과를 반환한다. `GET /api/schedule/auto-result/:previewId`에서 같은 작업자가 `{applied:false}` 또는 기존 `{undoId,updated,warnings}`를 읽을 수 있다. 미사용 미리보기의 유효 시간은 30분이며 적용 결과는 7일간 보관된다.

## 프로젝트 간 후행 일정 검토

브라우저의 `POST /api/schedule/team-follow-up-preview`에 `/api/schedule/team-blockers`에서 확인한 `{relationId,expectedVersion}` 또는 `{relations:[{relationId,expectedVersion}]}`을 보낸다. 배열에는 같은 선행 업무에서 출발하는 관계를 중복 없이 1~100개 넣는다. 각 관계의 두 업무는 서로 다른 프로젝트에 있어야 하고 현재 진행 대상이어야 한다. 차단은 선행 종료 이후 첫 후행 프로젝트 근무일을 계산하며, 선택한 대상에서 이어지는 프로젝트 내부 연결과 열린 Teamspace 차단, 직접 고른 Jira 이관 관계를 확인한다. 여러 갈래에서 같은 후행 업무에 도달하면 조건을 합쳐 한 번 계산한다. 전체 업무 10,000개와 연결 50,000개 이하에서 후행 업무 최대 1,000개를 계산한다.

선행 업무의 날짜도 바꾸려면 `anchorChange: {id,expectedVersion,startDate,endDate}`를 함께 보낸다. `id`와 내부 `expectedVersion`은 선택한 관계의 선행 업무에 해당한다. 날짜는 `YYYY-MM-DD` 또는 `null`을 사용한다. 입력한 날짜를 고정하고, 선행 업무로 들어오는 연결과 선행 업무부터 이어지는 모든 프로젝트 내부 연결·열린 Teamspace 차단 및 선택한 Jira 관계를 검사한다. 이 경우 선행 업무를 포함해 최대 1,000개를 계산한다. 날짜가 바뀐 선행 업무는 후행 업무와 함께 `changes`에 들어간다. 선행 업무 버전이 바뀌면 미리보기와 적용은 `409` 및 `details.reason: "stale_team_follow_up_source"`와 현재 `currentVersion`, `startDate`, `endDate`를 반환한다.

미리보기의 `teamFollowUp`에는 선택한 관계 ID·버전, 양쪽 업무 ID와 계산에 사용할 `sourceEndDate`가 포함된다. 배열 요청에서는 이 필드가 선택한 첫 관계를 가리키고, `relations`에 전체 선택의 `{relationId,expectedVersion,targetIssueId}`가 들어간다. `sourceSchedule`은 서버에 저장된 선행 업무의 `version`, `startDate`, `endDate`를 제공한다. `changes`는 각 업무의 `projectId`와 날짜 전후 값을, `warnings`는 마감 초과 등을, `blocking`은 적용 전에 해결할 항목을 표시한다. 저장은 모든 선택 관계의 버전과 현재 대상, 관련 업무의 소속·버전, 참여 프로젝트의 달력·워크플로·양식 및 현재 연결을 다시 검사한다.

검토 범위에 들어온 업무에 방향을 확인한 추가 Jira 선행 연결이 있으면 완료 후 시작 제약으로 계산한다. 범위 밖 원인 업무는 저장한 일정으로 계산하고, 필요한 종료일이 비어 있으면 `blocking`에 표시한다. 미리보기 뒤 원인 일정이나 이관 근거가 바뀌면 적용할 때 새 미리보기를 요구한다.

`POST /api/schedule/team-follow-up-apply`에 `{previewId}`를 보내면 한 트랜잭션으로 일정을 적용한다. `GET /api/schedule/team-follow-up-result/:previewId`는 같은 작업자에게 미적용 상태 또는 저장한 `{undoId,updated,warnings}`를 돌려준다. 미리보기는 30분, 적용 결과는 7일간 보관한다. `/api/schedule/undo`에 `undoId`를 보내 여러 프로젝트의 변경 날짜를 함께 복원할 수 있다. 원인 티켓에서는 `X-Teamspace-Schedule-Undo-Scope: issue:<원인 업무 ID>` 헤더로 적용과 되돌리기를 요청한다. 원인 날짜를 그대로 두고 후행만 변경해도 `GET /api/schedule/undo/latest?scope=issue&id=…`로 같은 티켓의 마지막 변경을 찾을 수 있다.

## 선택 업무의 날짜 일괄 편집

브라우저의 `POST /api/schedule/bulk-dates/preview`에 업무 ID와 화면에서 확인한 버전을 최대 100개 보낸다. `projectId`가 프로젝트 ID이면 해당 프로젝트에서 선택한 업무를 검사한다. 전체 프로젝트 간트는 `projectId: null`을 명시한다. 이때 서버는 선택 업무의 현재 소속을 조회하고 응답의 `projectIds`에 해당 프로젝트 ID를 표시한다.

```json
{
  "projectId": "project-id",
  "issues": [{"id": "issue-id", "expectedVersion": 3}],
  "changes": {"endDate": "2026-12-11", "dueDate": null}
}
```

`startDate`, `endDate`, `dueDate` 중 수정할 속성을 하나 이상 지정한다. 생략한 속성은 각 업무의 현재 값을 유지한다. `null`은 날짜를 지우고 문자열은 유효한 YYYY-MM-DD 날짜를 지정한다. 예시에서는 각 시작일을 유지하고 종료일을 지정하며 목표 마감일을 지운다.

미리보기의 `changes`에는 변경할 업무의 시작·종료일과 `fromDue`·`toDue`가 포함된다. 업무가 없거나 버전이 달라지거나 날짜 검증에 실패하면 해당 업무를 `errors`에 표시한다. 프로젝트 ID를 명시한 요청은 소속이 다른 업무도 오류로 처리한다. 오류가 있거나 변경할 업무가 없으면 `previewId`는 `null`이다. 각 프로젝트의 달력으로 계산한 선후행 경고를 함께 표시한다.

`POST /api/schedule/bulk-dates/apply`에 검토한 `{previewId}`를 보낸다. 작업자, 선택·연결 업무의 버전과 소속, 각 대상 프로젝트의 연결·달력·워크플로·양식 버전을 확인한다. 다른 변경이 있으면 전체 적용을 보류한다. 유효한 요청은 모든 프로젝트의 변경 날짜와 적용 결과를 같은 트랜잭션에 저장한다. 미리보기는 30분 동안 유효하며 같은 ID의 성공 결과는 7일 안에 다시 읽을 수 있다. 응답의 `undoId`를 `POST /api/schedule/undo`로 보내 이 요청이 변경한 날짜를 함께 복원한다. 같은 작업공간의 재시작과 물리 백업은 적용 결과와 되돌리기 기록을 유지하며 자체 JSON 복원은 해당 기록을 초기화한다.

## 스프레드시트 일정 붙여넣기

브라우저의 `POST /api/schedule/paste-preview`에 `{projectId, text, rescheduleSuccessors?}`를 보낸다. 한 프로젝트로 좁히려면 `projectId`에 해당 ID를 보내고 전체 프로젝트에서 찾으려면 명시적으로 `null`을 보낸다. 두 업무 키 열은 대소문자를 구분하지 않는다. 조회 범위에서 현재 키가 하나면 우선 사용한다. 현재 키가 없으면 확인된 이전 키와 일치하는 업무가 하나일 때 적용 대상으로 삼는다. 현재 키가 중복되거나 이전 키로 여러 업무가 일치하면 오류를 반환한다. 선후행 연결의 양쪽 업무는 같은 프로젝트에 있어야 한다.

`text`는 헤더가 있는 TSV 또는 CSV다. `key`(`업무 키`)와 `startDate`(`시작일`), `endDate`(`종료일`), `dueDate`(`목표 마감일`), `predecessor`(`선행 업무`) 중 한 열 이상이 필요하다. 빈 날짜 값은 유지하고 `-`는 지운다. 선행 업무 키가 있으면 `dependency type`(`연결 유형`)과 `lag days`(`근무일 간격`)도 사용할 수 있다. 유형 `-`는 지정한 관계를 해제한다. 빈 유형과 간격은 기존 값을 사용하며 새 연결의 기본값은 `FS`·`0`이다. 다른 헤더가 명시된 열은 무시한다. 최대 500행, UTF-8 128KiB를 처리한다.

같은 후행 업무 키를 서로 다른 선행 업무 행에 반복할 수 있다. 후행·선행 쌍마다 한 행을 쓰고, 선행 업무가 비어 있는 행은 후행 업무별 하나까지 허용한다. 날짜는 여러 행에 나눠 입력할 수 있다. 현재 키와 이전 키가 같은 업무를 가리켜도 중복과 날짜 충돌을 업무 ID로 검사한다. 시작일·종료일·목표 마감일을 합친 뒤 범위와 워크플로를 검사하므로 `changes`에는 업무당 날짜 변경이 최대 한 건 들어간다.

응답의 `changes`는 업무별 현재·제안 일정이며, 목표 마감일이 바뀌는 업무에는 `fromDue`와 `toDue`를 포함한다. `dependencyChanges`는 행 번호와 선행·후행 업무의 키·제목, 변경 전후의 `{type,lagDays}`를 담는다. 새 연결의 `before` 또는 해제하는 연결의 `after`는 `null`이다. 전체 프로젝트 응답에는 `projectIds`가 포함되고 날짜와 연결 변경 항목마다 해당 `projectId`가 들어간다. `warnings`는 프로젝트별 달력으로 계산한 선후행 날짜 조건 경고이며 `errors`는 적용을 막는 진단이다. `unchanged`는 날짜와 연결이 모두 바뀌지 않는 행 수다. 오류 없이 변경이 있는 경우에만 `previewId`와 `expiresAt`을 발급한다.

`keyMappings`가 있으면 이전 키로 찾은 업무와 이전 키보다 우선한 현재 키를 `{inputKey,issueId,key,title,projectId,source}`로 돌려준다. `source`는 `jira`, `move`, `current` 중 하나다. 다른 업무의 이전 키와 겹쳐 현재 키를 우선한 경우 `currentKeyConflict: true`가 함께 들어간다. `retainedDependencies`는 검토한 행 중 유형·간격을 그대로 유지할 기존 연결을 담는다.

`rescheduleSuccessors: true`는 입력에서 시작일·종료일이 실제로 바뀐 업무의 제안 기간을 고정하고, 새 연결이나 유형·간격 변경을 포함한 각 프로젝트의 최종 연결을 기준으로 후행을 계산한다. 조정한 업무 ID를 `followUpIssueIds`로 돌려준다. 목표 마감일 입력은 후행 조정 결과와 함께 저장하며 전체 날짜 변경은 최대 1,000개 업무다. 필요한 날짜를 계산할 수 없거나 고정 일정이 새 조건과 충돌하면 `errors`와 `previewId: null`을 반환한다. 계산 범위에 속한 후행과 연결된 선행 업무도 적용 직전 검증한다. 옵션이 없거나 `false`이면 입력한 날짜와 연결의 기존 검토 방식을 사용한다.

`POST /api/schedule/paste-apply`에 `{previewId}`를 보낸다. 미리보기 작업자와 정책·달력·선후행·업무 버전을 검사해 30분 이내의 계획을 적용한다. 같은 범위에서 업무 키를 다시 찾아 미리보기의 대상과 일치하는지 확인한다. 연결을 추가할 때 최종 그래프의 순환 여부도 검사한다. 같은 ID의 적용을 7일 안에 재요청하면 같은 `{undoId,updated,warnings}`를 반환하며 연결 변경이 있으면 `dependencyChanges` 건수도 포함한다. 각 프로젝트의 날짜·연결·이력·되돌리기 기록·적용 응답을 같은 트랜잭션으로 저장한다. `POST /api/schedule/undo`는 대상 업무와 연결이 현재 상태와 일치하고 복구할 연결이 순환을 만들지 않을 때 해당 요청의 모든 날짜와 연결을 함께 복원한다. 미리보기와 영수증은 자체 백업 범위 밖에 있으며 복원 시 초기화한다.

## 간트 업무의 날짜와 연결 함께 편집

`POST /api/schedule/row-edit/preview`는 `{projectId,issue:{id,expectedVersion},changes?,relatedDates?,dependencies?,rescheduleSuccessors?,reviewIncomingTeamBlockers?}`를 받는다. `changes`는 `startDate`, `endDate`, `dueDate` 중 바꿀 항목을 보낸다. 날짜는 `YYYY-MM-DD`로 지정하며 `null`로 비운다. `dependencies`에는 같은 기준 업무의 연결 작업을 최대 100건까지 보낸다. 기존 단일 작업용 `dependency`도 쓸 수 있으며 두 필드 중 하나를 선택한다. 각 작업의 `relatedIssue`는 `{id,expectedVersion}`으로 지정하며 기준 업무와 같은 프로젝트에 있어야 한다.

연결 추가는 `{action:'add',relatedIssue,direction,type,lagDays}`를 사용한다. `direction`이 `predecessor`이면 `relatedIssue`가 기준 업무의 선행 업무이며, `successor`이면 후행 업무다. 기존 연결의 유형·간격 변경은 `{action:'update',id,expectedVersion,relatedIssue,type,lagDays}`를 사용하고, 해제는 `{action:'remove',id,expectedVersion,relatedIssue}`를 사용한다. 유형은 `FS`, `SS`, `FF`, `SF`를 지원하며 간격은 -3,650~3,650의 정수 근무일이다. 같은 연결이나 같은 방향의 업무 쌍에 대한 작업은 한 건만 지정한다. 순환 검사는 모든 추가·수정·해제를 적용한 상태를 기준으로 한다.

연결할 상대 업무의 일정도 저장하려면 `relatedDates`에 `{issue:{id,expectedVersion},changes}`를 보낸다. 같은 프로젝트에 있는 별도 업무 한 건과 최소 한 개의 날짜 필드를 지정한다. 검토할 연결 변경을 반영한 뒤에도 두 업무 사이에 선후행 연결이 있어야 한다. 연결 경고는 두 업무의 제안 날짜를 사용해 계산한다.

날짜 또는 연결을 바꾸면서 `rescheduleSuccessors: true`를 보내면 기준 업무와 `relatedDates` 업무의 입력 날짜를 고정하고 연결 변경 후의 선후행 관계로 후행 일정을 계산한다. 바뀌는 직접·간접 후행 업무도 `changes`에 포함된다. 모든 조건을 이미 충족하는 후행 업무는 날짜를 유지한다. 종료일이 목표 마감일을 넘으면 `warnings`에 표시하고, 필요한 날짜나 기존 근무일 기간을 계산할 수 없거나 고정 일정과 충돌하면 `errors`에 표시한다. 적용은 날짜가 바뀌지 않는 후행 업무 및 별도 선행 업무에 대한 변경도 검사한다. 생략하거나 `false`를 보내면 직접 지정한 날짜와 연결만 검토한다.

날짜 제안으로 시작일 또는 종료일을 바꿀 때는 `reviewIncomingTeamBlockers: true`를 보낸다. 서버는 일반 날짜 변경의 차단 경고와 함께 시작일 또는 종료일을 바꾼 각 입력 업무로 들어오는 열린 프로젝트 간 차단 관계를 검증한다. 프로젝트 달력으로 FS·0근무일 조건을 확인하며, 선행 조건 충돌은 `errors`, 필요한 날짜가 미정인 관계는 `warnings`에 표시한다. 적용 시 선행 업무 버전과 관계의 방향·출처·버전을 비교한다. 확인한 관계가 없어도 새 관계가 생기면 적용은 `409`를 반환한다.

응답은 일정 붙여넣기와 같은 변경 전후·경고·진단 정보를 제공한다. 배열 입력의 연결 요약과 항목별 진단은 1부터 시작하는 위치를 `line`으로 돌려준다. 오류 없이 유효한 변경이 있으면 `previewId`를 발급한다. `POST /api/schedule/row-edit/apply`에 `{previewId}`를 보내 날짜와 연결을 같은 트랜잭션에서 저장한다. 적용 시 기준 업무와 관련 업무·연결, 달력·워크플로·업무 양식의 변경을 확인한다. 같은 작업자가 같은 ID를 재전송하면 이미 저장한 결과를 받는다. `POST /api/schedule/undo`에 결과의 `{undoId}`를 보내 날짜와 연결을 함께 되돌릴 수 있다.

## 선택 업무의 선후행 일괄 연결

브라우저의 `POST /api/schedule/bulk-links/preview`에서 `projectId`, `anchor`, `issues`, `direction`으로 공통 기준 연결의 대상을 지정한다. `anchor`와 `issues`의 각 업무는 `{id,expectedVersion}` 형식이다. 한 프로젝트에 속한 2~100개의 서로 다른 업무와 별도의 공통 업무를 지정한다. `direction`은 공통 업무의 역할이며 `predecessor` 또는 `successor`다.

목록의 순서대로 연결할 때는 `mode:'chain'`, `projectId`, `issues`로 대상을 지정한다. `issues`에 두 업무를 연속으로 넣으면 앞 업무를 선행, 뒤 업무를 후행으로 검토한다. 예를 들어 A·B·C를 지정하면 A→B와 B→C를 검토한다. 업무마다 버전과 같은 프로젝트 소속을 확인한다.

두 요청 모두 `operation`으로 연결 작업을 지정할 수 있다. `type`은 `FS`, `SS`, `FF`, `SF`를 받고, `lagDays`는 −3,650~3,650 사이의 정수 근무일을 받는다.

- `add`는 `type`과 `lagDays`를 모두 받고 연결이 없는 쌍에 새 연결을 추가한다. `operation`을 생략하면 `add`를 적용한다.
- `update`는 `type`과 `lagDays` 중 하나 이상을 받고 같은 방향의 기존 연결에서 지정한 값만 바꾼다. 연결 ID는 유지한다.
- `remove`는 같은 방향의 기존 연결을 해제한다. 요청에서 `type`과 `lagDays`를 생략한다.

두 요청에 선택적으로 `dates: [{issue:{id,expectedVersion},changes}]`를 보낼 수 있다. 선택 업무나 공통 기준 업무의 ID와 같은 조회 버전을 사용하고 업무마다 한 번 지정한다. `changes`에 변경할 날짜 칸만 보내며 `null`로 날짜를 지운다. 응답의 `changes`에는 날짜 변경 전후를 담는다. 일정 누락과 충돌은 제안한 날짜와 연결을 기준으로 검토한다.

두 요청 모두 `rescheduleSuccessors: true`를 받는다. 실제로 변경한 시작일·종료일과 추가·수정한 선후행 관계가 영향을 주는 같은 프로젝트의 직접·간접 후행 업무를 계산한다. 계산은 해제할 연결을 제외한 최종 그래프를 사용한다. 직접 바꾼 시작일·종료일이 있는 업무는 제안 날짜를 고정한다. 나머지 업무는 기존 근무일 기간을 유지해 조건을 충족하는 데 필요한 만큼 늦춘다. 계산한 변경도 `changes`에 포함하고 해당 업무 ID를 `followUpIssueIds`에 담는다. 바뀌는 업무의 한도는 직접 변경과 후행 조정을 합쳐 1,000개다. 계산에 필요한 날짜가 없거나 고정 일정이 충돌하면 `errors`에 이유를 표시한다.

응답의 `dependencyChanges`에는 변경할 연결의 `before`와 `after`가 담긴다. 추가의 `before`와 해제의 `after`는 `null`이다. 유지할 기존 연결은 `unchanged` 건수와 `retainedDependencies`에 기록한다. 수정·해제에서 같은 방향의 연결을 찾지 못한 업무 쌍은 `missingDependencies`에 담는다. 업무 위치·버전이 일치하지 않거나 새 연결 때문에 순환이 생기면 `errors`와 빈 `previewId`를 반환한다. 날짜와 연결의 실질 변경이 모두 없으면 적용 ID 없이 검토 결과를 반환한다.

`POST /api/schedule/bulk-links/apply`에 `{previewId}`를 보내 검토한 날짜와 연결을 한 트랜잭션에서 저장한다. 검토 뒤 관련 업무·연결·프로젝트 규칙이 바뀌면 `409`가 반환된다. 후행 일정 계산에서 날짜가 유지된 업무와 미리보기에서 연결이 없던 쌍도 대조 범위에 포함한다. 같은 작업자는 같은 ID로 이미 저장한 결과를 확인할 수 있다. 결과의 `undoId`를 `POST /api/schedule/undo`에 보내 직접 입력한 날짜, 조정한 후행 일정과 이 요청의 연결 변경을 복원한다.

## 차단 관계의 선후행 일괄 연결

브라우저의 `GET /api/schedule/blocker-links?projectId=…&offset=0`은 같은 프로젝트 안의 방향이 확인된 차단 관계를 25개씩 조회한다. 결과는 `{items,offset,total}`이다. 각 항목은 관계 `id`, `version`, 차단하는 `sourceIssueId`, 차단되는 `targetIssueId`를 담는다. 검증한 이관 관계는 `origin: 'jira'`를 포함한다. 같은 방향에 Teamspace 관계와 Jira 관계가 있으면 Teamspace 관계가 우선한다.

`GET /api/schedule/blocker-links?scope=team&offset=0`은 모든 프로젝트에서 양쪽 업무가 같은 프로젝트에 속한 차단 관계를 조회한다. 팀 응답의 각 행에는 소속 `projectId`가 포함된다.

`POST /api/schedule/blocker-links/preview`에 `{projectId,relations:[{id,version}]}`을 보내 1~100개를 검토한다. `dependencyChanges`에는 FS·0근무일로 새로 추가할 연결이, `retainedDependencies`에는 기존 유형·간격을 유지할 연결이 담긴다. 날짜 미정과 일정 충돌은 `warnings`로 돌려준다. 방향이 반대인 기존 일정 연결이나 순환을 포함해 적용을 막는 조건이 있으면 `errors`에 표시한다. 적용할 새 연결이 있는 유효한 미리보기에 `previewId`를 발급한다.

여러 프로젝트를 함께 검토하려면 `{projectId:null,relations:[{id,version,projectId}]}`을 보낸다. 서버는 각 관계·버전·양쪽 업무의 소속을 확인해 행 오류를 반환한다. 팀 미리보기는 `projectIds`와 새로 추가하거나 유지하는 각 행의 `projectId`를 반환하고 프로젝트별 달력으로 경고를 계산한다.

`POST /api/schedule/blocker-links/apply`에 `{previewId}`를 보낸다. 원래 관계나 확인한 원본 방향, 업무·소속·관련 연결·일정 규칙이 바뀌면 `409`를 반환한다. 모든 대상 프로젝트의 새 연결은 한 트랜잭션에 저장된다. 같은 작업자가 같은 ID로 저장 결과를 확인할 수 있다. 결과의 `{undoId}`를 `POST /api/schedule/undo`에 보내 추가한 일정 연결만 한 번에 해제한다.

## 사이클 완료와 업무 이월

`POST /api/planning-items/:id/complete/preview`는 `{expectedVersion,destinationId}`를 받는다. 원래 사이클은 진행 중이어야 한다. 같은 프로젝트의 다른 계획·진행 중 사이클로 보내려면 ID를, 백로그에 두려면 명시적으로 `null`을 보낸다. `/api/v1`의 두 완료 경로에는 해당 프로젝트의 쓰기 키가 필요하다.

미리보기의 `cycle`과 `destination`은 ID·이름·버전을 담으며 백로그의 `destination`은 `null`이다. `issues`의 각 업무는 상태 라벨과 `disposition`을 담는다. 프로젝트 워크플로의 완료(`done`)·취소(`cancelled`) 업무는 유지하고 나머지 업무는 이월(`carry`)한다. `counts.blocked`는 `carry` 중 필수 속성 등의 검증을 통과하지 못한 건수다. 차단 사유는 업무의 `blockedReason`에 포함되며 적용 ID는 `null`이다. 적용 가능한 `previewId`는 30분간 유효하다.

`POST /api/planning-items/:id/complete`에 `{previewId}`를 보낸다. 작업자·사이클과 미리보기 이후의 연결 업무·계획 버전·업무 설정을 확인한다. 업무의 사이클 연결과 이력, 이전 사이클의 완료 상태, 당시 업무 기록과 적용 결과를 한 번에 저장한다. 새 응답은 `cycle`, `destination`, `counts`, `recordId`를 담는다. 같은 작업자가 같은 ID의 결과를 7일간 다시 받을 수 있으며, 이전 버전에서 발급한 결과에는 `recordId`가 없을 수 있다. 자체 JSON 복원은 미리보기와 재확인 기록을 초기화한다.

### 사이클 완료 기록

`GET /api/projects/:projectId/cycle-completion-records`는 `{items, nextCursor}`를 반환한다. `cycleId`를 보내면 그 사이클, 생략하면 프로젝트의 모든 완료 기록을 최신순으로 읽는다. 페이지의 `limit`은 기본 20이고 1~50을 지원한다. 다음 페이지 요청에는 같은 `cycleId` 조건과 응답의 `nextCursor`를 `cursor`로 보낸다. 마지막 페이지의 `nextCursor`는 `null`이다.

`GET /api/projects/:projectId/cycle-completion-records/:recordId`는 해당 기록의 `issues`를 포함한다. 기록에는 당시 사이클 이름·버전·기간, `destination`의 ID·이름·버전 또는 백로그를 뜻하는 `null`, 완료한 작업자와 시각, 분류별 건수를 저장한다. 각 업무에는 당시 업무 키·제목·상태·담당자와 `done`, `cancelled`, `carry` 중 하나의 결과를 저장한다. 해당 프로젝트에서 보관한 기록은 원래 사이클이나 업무가 사라진 뒤에도 조회할 수 있다. `/api/v1`의 같은 경로는 해당 프로젝트의 읽기 또는 쓰기 키를 사용한다. 자체 백업 형식 80의 `cycleCompletionRecords`가 이 기록을 보존한다.

### 사이클 진행 추이

`GET /api/projects/:projectId/cycles/:cycleId/progress`와 `GET /api/v1/projects/:projectId/cycles/:cycleId/progress`는 해당 프로젝트의 사이클을 서울 날짜별로 조회한다. 자동화 경로에서는 해당 프로젝트의 읽기 또는 쓰기 키를 사용한다. `throughDate`를 생략하면 마지막 날짜에서 최대 92일을 반환한다. 그보다 이전 기간은 원하는 마지막 날짜를 `YYYY-MM-DD`로 보낸다. 시작일을 지정하지 않은 사이클은 생성일을 첫 날짜로 사용한다. 완료 기록에서 현재 완료 상태를 저장한 시각을 확인할 수 있으면 당시 완료 시각까지 조회한다. 자체 백업 복원에서 버전만 갱신된 경우에도 이 시각을 보존한다. 이 조건을 만족하는 기록이 없으면 조회 시각까지의 관측을 반환한다.

`days`에는 `date`, `coverage`, `state`, `changes`가 있다. `coverage`는 `complete`, `partial`, `unobserved`다. `state`는 조회일 종료 시각 또는 당일 조회·완료 시각에 관측한 범위·남은 업무, 완료·취소 업무와 입력한 스토리 포인트를 나타낸다. 해당 시각을 관측하지 못했으면 `null`이다. 포인트 미입력 건수는 범위와 남은 업무에 따로 기록한다. `changes`는 관측한 추가·제외·완료·취소·재개·추정치 변경·워크플로 분류 변경 횟수이며 미관측 날짜에는 `null`이다. 한 업무의 반복 변경은 각각 센다.

선택한 날짜가 현재 기간에 포함되면 `date=YYYY-MM-DD`로 `evidence`를 함께 받을 수 있다. 관측 시각과 순서대로 최대 50건씩 응답하며 각 이벤트의 당시 업무 키·제목과 변경 분류, 추정치 전후 값을 담는다. 다음 페이지에는 `offset`과 이전 응답의 `revision`을 `expectedRevision`으로 보낸다. 조회 기간이나 관측 데이터가 바뀌면 `409`와 `details.reason: "stale_cycle_progress"`를 반환한다. 자체 백업 형식 97의 `reportingLedger`가 사이클 소속·추정치와 관측 시작 시점을 보존한다.

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

Jira 원본 이관 미리보기와 영수증에는 `worklogs` 및 `archivedWorklogs` 건수가 포함된다. 관리자 XML의 Worklog와 REST 업무 응답·같은 ZIP의 별도 REST 페이지·Importers JSON에 담긴 개별 작업 기록이 대상이다. 업무 단위 합계만 있는 파일에서는 개별 작업 시간을 생성하지 않는다. 원래 작성자를 팀원으로 매핑하고 작업일과 길이를 확인할 수 있는 기록을 집계에 반영한다. 시작 시각·작성자·원본 메모는 원본 기록에서도 볼 수 있다. 제한된 작업 기록은 이관에서 명시적으로 제외할 때까지 적용을 차단한다. 상대 날짜나 설정에 따라 달라지는 일·주 길이는 원본에 보관하고 진단에서 확인한다. [Jira Data Center 작업 기록 API](https://developer.atlassian.com/server/jira/platform/rest/v11003/api-group-issue/) · [Jira JSON 작업 시간 예시](https://confluence.atlassian.com/servicedeskcloud/importing-data-from-json-1097176631.html#ImportingdatafromJSON-Worklogs)


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

`POST /api/v1/issues/query`는 읽기 키로 호출할 수 있다. 브라우저의 같은 경로는 `/api/issues/query`다. `fieldFilter`로 조회할 때는 `projectId`와 함께 `fieldFilter.match`에 `all` 또는 `any`와 1~8개 조건을 보낸다. 응답은 조건에 맞는 업무 배열이다.

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

## 업무 우선순위와 라벨 조건

`POST /api/v1/issues/query`와 브라우저용 `/api/issues/query`는 `projectId`와 함께 `statusIds`, `priorities`, `labels`, `fieldFilter` 중 유효한 조건을 하나 이상 받는다. 요청에서 지정한 조건에 모두 일치하는 업무를 반환한다.

```json
{
  "projectId": "project-id",
  "priorities": ["urgent", "high"],
  "labels": {
    "include": ["배포", "검증"],
    "match": "all",
    "exclude": ["보류"]
  }
}
```

- `priorities`는 `urgent`, `high`, `medium`, `low` 중에서 선택한 값과 일치하는 업무를 고른다.
- `labels.include`는 지정한 라벨 중 하나 이상(`match: "any"`, 기본값) 또는 모두(`"all"`) 있어야 일치한다.
- `labels.exclude`는 지정한 라벨이 하나라도 있는 업무를 제외한다. 라벨이 없는 업무도 제외하려면 `presence: "set"`을 함께 보낸다. `presence: "empty"`는 빈 문자열을 제외한 라벨이 없는 업무를 고른다.
- 포함·제외 목록은 각각 최대 20개이며 값의 길이는 1~60 UTF-16 코드 단위다. 저장된 라벨의 대소문자와 공백까지 일치해야 한다.

브라우저의 `POST /api/views`와 `PATCH /api/views/:id`에서는 같은 필드를 `filters` 안에 보낸다. 수정 요청에서 각 필드를 생략하면 해당 조건을 유지한다. 우선순위 조건은 `priorities: []`, 라벨 조건은 `labels: {}`로 지운다. 자체 백업 형식 68부터 보기와 함께 두 조건을 보존한다.

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

## 공유 보기의 GitLab 조건

브라우저의 `POST /api/views`와 `PATCH /api/views/:id`에서 선택적으로 `filters.gitlab`을 사용한다. 저장된 조건은 업무 목록·보드, 간트, 문서의 업무 목록·현황, 사용자 정의 필드 집계에 적용한다.

| 값 | 표시할 업무 |
| --- | --- |
| `open_merge_request` | 저장된 연결에 열린 MR이 있는 업무 |
| `merge_blocked` | 열린 MR에 승인·충돌·파이프라인 등 확인된 병합 차단 사유가 있는 업무 |
| `failed_pipeline` | 최신 연결 파이프라인 중 하나 이상이 실패한 업무 |
| `running_pipeline` | 최신 연결 파이프라인 중 하나 이상이 자동 실행을 기다리거나 실행 중인 업무 |
| `manual_pipeline` | 최신 연결 파이프라인 중 하나 이상이 `manual` 상태로 수동 실행을 기다리는 업무 |
| `no_activity` | 저장된 GitLab 연결이 없는 업무 |

같은 업무·GitLab 인스턴스·저장소·참조 이름의 파이프라인은 실행 유형별로 가장 큰 GitLab 파이프라인 ID를 현재 상태로 사용한다. 태그로 확인된 실행은 별도로 집계한다. 실행 유형을 확인하지 못한 기존 연결은 같은 참조의 미확인 그룹으로 집계하고, 참조 이름이나 원본 ID를 확인할 수 없는 연결은 각각 평가한다. 최신 상태는 웹훅과 동기화로 저장한 자료를 읽는다. 수정 요청에서 조건을 생략하면 유지하고 `null`을 보내면 해제한다. 자체 백업 형식 57은 MR 병합 상태와 `merge_blocked` 조건을 보존한다. 기존 GitLab 조건은 형식 53에서 지원한다.

`manual_pipeline`은 GitLab이 보고한 파이프라인 상태를 기준으로 집계하며 형식 104에서 복원한다. 파이프라인의 개별 수동 작업과 실패 허용 여부는 **CI 작업 확인**에서 볼 수 있다. [GitLab 파이프라인 상태](https://docs.gitlab.com/api/pipelines/#list-project-pipelines) · [GitLab 수동 작업의 유형](https://docs.gitlab.com/ci/jobs/job_control/#types-of-manual-jobs)

## 공유 보기의 요청자 조건

브라우저의 `POST /api/views`와 `PATCH /api/views/:id`에 선택적으로 `filters.reporter`를 보낸다. `{ "kind": "member", "memberId": "팀원 ID" }`는 저장된 요청자가 해당 팀원인 업무를 조회한다. `{ "kind": "unset" }`은 `reporterId: null`인 미지정 업무, `{ "kind": "unknown" }`은 요청자 기록이 없는 업무를 조회한다.

상태·담당자·유형·검색 등 나머지 조건과 함께 적용하며 목록·보드·간트, 문서 업무 블록, 필드 집계와 진행 차단 보고서에서 같은 저장 조건을 사용한다. 수정에서 `filters.reporter`를 생략하면 이전 조건을 유지한다. 전체 요청자 범위로 바꾸려면 `null`을 보낸다. 자체 백업 형식 85는 요청자 조건을 복원하고 팀원 ID는 복원할 데이터의 팀원과 대조한다.

## 업무 필드 집계

`POST /api/v1/projects/:id/field-breakdown`에는 기본 필드를 선택하는 `groupBy`와 사용자 정의 필드를 선택하는 `fieldId` 중 하나가 필요하다. `groupBy`는 `status`, `assignee`, `reporter`, `priority`, `type`을 지원한다. 선택 항목인 `savedViewId`를 생략하거나 `null`로 보내면 전체 프로젝트를 집계한다. 보기를 지정하면 현재 저장된 검색어와 상태·담당자·요청자·유형·필드·계획·일정·GitLab 조건을 적용한다. 두 조회 경로는 같은 프로젝트 범위의 읽기 키와 브라우저의 `/api` 경로에서 사용할 수 있다.

응답에는 조회 시각 `generatedAt`, 비교 기준 `revision`, 조건에 맞는 전체 업무 수와 적용·입력·미입력·유형 미적용 업무 수, 값별 `groups`가 포함된다. 숫자 0과 확인 여부 `false`는 각각 입력된 값이다. 다중 선택은 선택지마다 그 선택지를 가진 업무를 한 번 세므로 한 업무가 여러 그룹에 나타날 수 있다. 그룹 ID는 필드 ID와 저장 값에 기반한다. 숫자 필드의 `numeric`에는 값이 있을 때 `min`, `max`, `average`, `sum`이 포함된다. 합계가 유한한 JSON 숫자 범위를 넘으면 `sum`은 `null`이다. 한 번에 선택된 업무 10,000개까지 집계하며 초과 시 `413`을 반환한다.

교차 집계의 열에는 기본 기준을 고르는 `comparisonBy` 또는 같은 프로젝트의 사용자 정의 필드를 지정하는 `comparisonFieldId` 중 하나를 추가한다. 같은 기본 기준이나 같은 사용자 정의 필드를 양쪽에 지정하면 `400`을 반환한다. 응답의 `comparison.by`는 기본 기준을, `comparison.field`는 사용자 정의 기준의 `id`, `name`, `kind`, `archived`를 담는다. `comparison.columns`는 각 열의 ID·현재 이름·조건에 해당하는 업무 수를 반환한다. `comparison.counts[행 ID][열 ID]`는 교차 업무 수이며, 생략된 셀은 0건이다. 사용자 정의 비교 열에서 값이 들어 있는 셀은 50,000개까지 반환하며 초과 시 `413`을 반환한다.

다중 선택은 한 업무를 각 선택값에 해당하는 여러 행·열에 포함할 수 있다. 각 행, 열과 셀에서는 해당 업무를 한 번씩 세며 `totalIssues`와 숫자 행의 통계도 업무마다 한 번 집계한다. 사용자 정의 열의 `missing`은 적용 유형에 값이 없는 경우, `not-applicable`은 적용 유형 밖의 업무다. 요청자 기준의 `missing`은 미지정, `unknown`은 기록 없음이며 각각 업무를 조회할 수 있다. 요청자를 행 기준으로 집계할 때 `missingIssues`는 두 건수의 합이다.

선택 항목 `measure`에는 스토리 포인트의 `{kind:'estimate'}`, 계획 작업 시간의 `{kind:'plannedEffortMinutes'}`, 또는 사용자 정의 숫자 필드의 `{kind:'custom',fieldId}`를 보낸다. 행·열에 사용한 필드와 별도로 합산할 값을 고른다. 응답의 `measure`는 `source`·`label`과 `total`·`rows` 및 교차 집계일 때 `columns`·`cells`를 제공한다. 합계 항목은 `{valueCount,sum}`을 반환한다. `valueCount`는 숫자가 저장된 업무 수이며 0도 포함한다. 값이 없거나 합계가 유한한 범위를 넘으면 `sum`은 `null`이다. 숫자가 들어 있는 셀만 `cells`에 포함된다. 행·열·셀·전체 각각은 해당 범위의 업무별 값을 한 번씩 더한다. 전체 합계는 여러 행·열의 합계를 더한 값과 다를 수 있다.

`POST /api/v1/projects/:id/field-breakdown/issues`에 집계 때 사용한 조건과 응답의 `revision`, 행의 `id`를 `bucketId`로 보낸다. `comparisonBucketId`에 열의 `id`를 추가하면 `comparisonBucket`에 열 정보를, `total`에 두 조건을 모두 충족하는 업무 수를 반환한다. 선택 항목인 `offset`은 기본값이 0이며 한 번에 최대 50개 업무의 `id`, `key`, `title`을 반환한다. 집계 뒤 업무·보기·필드 또는 비교 기준의 설정이 바뀌면 이전 `revision`의 조회는 `409`를 반환한다. 프로젝트에 없는 필드나 보기, 존재하지 않는 행이나 열은 `404`를 반환한다.

합계 항목을 비교한 셀과 일괄 편집의 집계 조건에도 같은 `measure`를 보낸다. 업무 목록은 각 업무의 `measureValue`를 반환한다. 값이 비었거나 적용 유형 밖이면 `null`이다. 합계 종류나 업무별 숫자가 바뀐 경우에도 새 `revision`으로 검토한다.

같은 업무 조회에서 `includeEditTargets: true`를 보내면 현재 페이지의 `id`, `version`, `labels`를 `editTargets`에 함께 반환한다. 일괄 편집에서 페이지를 넘겨 선택한 업무의 버전과 라벨을 확인할 때 사용한다. [업무 일괄 편집](#업무-일괄-편집)

### 이름으로 저장한 필드 집계

브라우저의 `GET /api/projects/:id/field-breakdown-presets`로 프로젝트에 저장한 집계 목록을 읽는다. 같은 경로의 `POST`에 `{name,query}`를 보낸다. 이름은 공백을 정리한 뒤 최대 80자다. `query`에는 집계와 같은 `groupBy` 또는 `fieldId`, 선택한 `comparisonBy` 또는 `comparisonFieldId`, `savedViewId`, `measure`가 들어간다. 새로운 이름은 `201`과 `{id,projectId,name,query,version,createdAt,updatedAt}`을 반환한다. 같은 이름과 조건의 요청은 기존 결과를 `200`으로 돌려주며, 같은 이름에 다른 조건을 보내면 `409`를 반환한다.

`PATCH /api/projects/:id/field-breakdown-presets/:presetId`에 `{expectedVersion,name?,query?}`를 보내 이름이나 조건을 바꾼다. 같은 경로의 `DELETE`는 `expectedVersion` 쿼리 매개변수를 검사한다. 목록에서 읽은 `query`로 현재 필드 집계 API를 호출한다. 저장 보기나 행·열·합계의 필드가 삭제된 경우 기존 기록은 목록에 남고 집계 조회는 `404`를 반환한다. 유효한 조회 조건으로 교체할 수 있다. 자체 백업 형식 92부터 저장 집계를, 형식 95부터 사용자 정의 비교 기준을, 형식 107부터 합계 항목을 복원한다. 복원 뒤 이전 버전의 수정 요청을 거절한다.

## 문서 검토·발행

`GET /api/v1/documents/:id/publication`은 현재 검토 요청, 마지막 발행 정보, 각 문서 저장본의 ID·제목·버전, 현재 초안의 `documentVersion`, 검토 상태의 `version`, `workspaceGeneration`을 반환한다. 검토 이력이 없는 문서의 상태 `version`은 0이다. 복원 전 워크스페이스의 `workspaceGeneration`은 `null`일 수 있다.

`GET /api/v1/documents/:id/publication/snapshot?kind=review&revisionId=…`에는 상태 응답의 `reviewRevision.id`를 넣는다. 마지막 발행본은 `kind=published`와 `publishedRevision.id`를 사용한다. 응답은 요청 당시 저장된 `DocRevision`이다. 저장본이 없으면 `404`, 상태가 바뀌어 다른 저장본을 가리키면 `409`를 반환한다.

`GET /api/v1/documents/:id/publication/comparison`에는 상태 응답의 `version`을 `expectedVersion`으로 보내고, `workspaceGeneration`, `publishedRevisionId`, `reviewRevisionId`를 함께 보낸다. 복원 세대가 `null`이면 `workspaceGeneration=`을 보낸다. 응답의 `published`와 `review`는 같은 조회에서 검증한 두 `DocRevision`이며 `version`과 `workspaceGeneration`도 포함한다. 문서와 두 본문의 참조 범위를 검사한다. 최신 발행본이나 검토본이 없거나, 버전·복원 세대·저장본이 달라지면 `409`를 반환한다. 브라우저의 `/api` 경로에서도 같은 계약을 사용한다.

`POST /api/v1/documents/:id/publication`에는 최신 조회 결과의 `version`을 `expectedVersion`으로, `workspaceGeneration`을 반환된 값 그대로 보낸다. 쓰기 키의 소유자를 작업자로 사용하고 브라우저 경로에서는 현재 선택한 작업자를 사용한다.

| `action` | 필요한 값과 동작 |
| --- | --- |
| `request` | 열어 본 문서의 버전을 `expectedDocumentVersion`으로 보내고, 서로 다른 팀원 1~20명의 `reviewerIds` 또는 한 명의 `reviewerId`를 지정한다. 선택 항목 `note`와 함께 현재 서버 저장본을 검토 대상으로 고정한다. |
| `approve` | 아직 처리하지 않은 지정 검토자가 선택 항목 `note`와 함께 승인한다. 마지막 승인이 해당 저장본을 발행한다. |
| `publish` | 검토자가 한 명인 요청에서 지정 검토자가 선택 항목 `note`와 함께 현재 검토본을 발행한다. |
| `request_changes` | 아직 처리하지 않은 지정 검토자가 필수 `note`와 함께 수정을 요청한다. 저장본 참조와 진행된 승인, 수정 의견을 보존한다. 새 검토 요청을 시작할 수 있다. |
| `withdraw` | 요청자가 검토를 철회한다. 기존 발행본은 유지된다. |

메모는 최대 2,000자다. 버전·복원 세대 또는 요청 직전 문서 버전이 다르면 `409`로 응답한다. 다른 작업자에게만 허용된 동작은 `403`을 반환한다. 모든 경로는 해당 문서의 프로젝트 범위를 확인한다. 브라우저에서 사용하는 동일한 경로의 접두사는 `/api`다.

그룹 검토의 `review.reviewers`에는 각 `reviewerId`와 `approval`이 들어간다. 승인한 검토자의 `approval`에는 `byId`, `at`, `note`를 기록한다. 그룹 발행의 `published.approvals`는 요청 당시의 검토자 순서대로 모든 승인 기록을 보존한다. `publishedById`는 마지막 승인자다. 자체 백업 형식 91부터 활성·휴지통 문서의 그룹 검토와 부분 승인 알림을 보존한다.

### 검토함·발행본 목록

브라우저의 `GET /api/document-publications`는 `tab`에 `assigned`(기본, 현재 작업자의 검토 대기), `requested`(현재 작업자가 보낸 대기·수정 요청), `published`(문서별 마지막 발행본)를 받는다. `scope`는 `workspace`(기본), `project`, `common`이다. `project` 범위에서는 `projectId`가 필요하다. `q`는 최대 200자의 선택 검색어다. 저장본 제목과 검색어를 유니코드 NFC로 정규화하고 소문자로 바꿔 부분 일치를 비교한다.

`offset`은 기본 0이며 한 페이지에 최대 30개를 반환한다. `total`은 현재 조건의 일치 수이고 `pendingAssigned`는 범위·탭·검색 조건과 독립적인 현재 작업자의 미처리 검토 건수다. 각 행은 문서·프로젝트·저장본 ID와 버전·고정 제목, 상태, 요청자·검토자, 상태 시각을 포함한다. 여러 검토자가 배정된 행에는 `reviewerIds`와 `approvedCount`가 포함된다. 최신 상태 시각순으로 정렬하며 같은 시각은 문서 ID 순이다. 본문과 메모는 문서별 검토·발행 경로에서 조회한다.

목록 주소 `#/<projectId>/publication/<tab>`은 `scope`, `projectId`, `q`, `offset`으로 조회 조건을 보관한다. 기본 범위는 `assigned`·`requested`에서 전체, `published`에서 주소의 프로젝트다. 목록 주소의 페이지는 30건 단위로 정리하며, 대상이 줄어 페이지가 사라졌으면 남아 있는 마지막 페이지로 이동한다. 목록은 현재 선택한 작업자로 조회한다.

`GET /api/document-publications/count`는 현재 작업자의 전체 `pendingAssigned`만 반환한다. 목록과 건수는 브라우저 경로에서 제공한다. 자동화 키는 문서별 `/api/v1/documents/:id/publication` 경로를 사용한다.

## 요청자의 업무 알림

브라우저의 `GET /api/notifications`는 선택한 작업자에게 해당하는 알림을 읽는다. 현재 요청자에게는 다른 작업자가 저장한 상태 전이와 새 댓글이 전달된다. 업무·프로젝트 구독이나 댓글의 담당자·협력자와 수신 대상이 겹치면 이벤트마다 한 건을 기록한다. 멘션된 요청자에게는 `issue-comment-mentioned`를 기록한다. 브라우저·API 키·GitLab 자동화는 상태를 실제로 저장한 작업자를 적용한다.

새 `issue-status-changed`의 `detail`은 변경 전후 상태명이고, 새 `issue-comment`의 `commentId`는 해당 업무에 저장된 댓글 ID다. 이전 알림에서 이 필드들은 생략될 수 있다. 알림에는 티켓 식별 정보와 댓글 위치가 들어가며 본문은 티켓에서 읽는다. 자체 백업 형식 86은 상태 상세와 일반 댓글 위치를 보존한다. 복원할 댓글이 있으면 업무와 작성자가 알림의 대상·작업자와 일치해야 한다.

## 개인 즐겨찾기

브라우저의 `GET /api/favorites`는 `X-Actor-Id`로 선택한 작업자가 표시한 활성 항목의 `{resourceType,resourceId,createdAt}` 배열을 최근 추가 순서로 반환한다. `resourceType`은 `issue` 또는 `document`다. `PUT /api/favorites/:resourceType/:resourceId`는 해당 작업자의 즐겨찾기를 등록하고 같은 항목 객체를 반환한다. 반복 등록은 최초 등록 시각을 유지한다. `DELETE`는 같은 경로에서 `{ok:true}`를 반환하며 재호출할 수 있다. 대상 ID는 URL 경로 한 구간으로 인코딩한다.

휴지통에 있는 항목은 조회에서 숨기고 `PUT`·`DELETE`에는 `404`를 반환한다. 해당 항목을 복원하면 즐겨찾기를 다시 조회할 수 있다. 영구 삭제는 모든 작업자의 해당 표시를 제거한다. 자체 백업 형식 94의 `favorites`에는 `userId`와 기존 항목 필드가 포함되며 활성 항목과 휴지통 항목을 함께 복원한다. 형식 1~93에서 가져오면 즐겨찾기는 빈 목록으로 초기화한다.

## 알림 구독

브라우저의 `GET /api/notifications/subscriptions/:targetType/:targetId`는 `X-Actor-Id`로 선택한 작업자의 `{ "subscribed": true }` 또는 `{ "subscribed": false }`를 반환한다. 같은 경로의 `PUT`에 `subscribed` 불리언을 보내 구독 상태를 지정한다.

| `targetType` | `targetId` | 알림 대상 |
| --- | --- | --- |
| `issue` | 업무 ID | 해당 업무의 상태 변경과 댓글 |
| `document` | 문서 ID | 해당 문서의 저장·버전 복구·발행·댓글 |
| `project` | 프로젝트 ID | 해당 프로젝트의 새 업무·상태 변경·댓글 |
| `space` | `project:<프로젝트 ID>` 또는 `common` | 지정 문서 공간의 새 문서·저장·버전 복구·발행·댓글 |

`targetId`는 URL 경로 한 구간으로 인코딩한다. 공동 편집의 저장 알림은 버전 기록을 만들 때 발송한다. 개별 구독과 프로젝트·공간 구독이 겹치면 같은 변경에 알림 한 건을 저장한다. 자체 백업 형식 29는 범위 구독과 `issue-created`·`document-created`를 보존한다.

## 담당 업무 마감 알림

`GET /api/notifications/deadline-reminders`는 `X-Actor-Id`로 선택한 팀원의 `daysBefore`, `onDueDate`, `overdue`, `version`을 반환한다. 저장 전 기본값은 `0`, `false`, `false`, `null`이다. 같은 경로로 `PUT`할 때 `daysBefore`에 0~14의 정수, `onDueDate`와 `overdue`에 불리언, `expectedVersion`에 직전에 읽은 버전을 보낸다. 최초 저장의 `expectedVersion`은 `null`이다. 성공하면 새 버전을 반환하고 이전 버전으로 저장하면 `409`를 반환한다. 두 경로는 브라우저 API로 제공하며 응답을 캐시에 저장하지 않는다.

앱 알림함은 마감 전·당일·초과를 각각 `issue-deadline-upcoming`, `issue-deadline-today`, `issue-deadline-overdue`로 반환한다. 이 세 종류의 `actorId`는 `null`이며 `detail`은 목표 마감일 또는 계획 종료일과 `YYYY-MM-DD` 날짜를 담는다. 자체 백업 형식 70은 `deadlineReminderPreferences`, 발송 기록과 읽음 시각을 보존한다. 자체 백업을 복원하면 설정의 편집 버전이 갱신된다.

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

`issueMetric`을 지정하면 응답에 `issueQueue`를 추가한다. `open`은 열린 업무, `overdue`는 기준일 전 마감, `dueSoon`은 기준일 포함 7일 이내 마감, `unscheduled`는 시작일 또는 종료일 미정, `unassigned`는 담당자 미지정이다. 선택한 지표의 `total`은 같은 응답의 집계값과 같다. `issueOffset`은 `issueMetric`과 함께 사용하며 기본값은 0이다. 목록은 10개씩 반환하고 마감일·우선순위·업무 키 순으로 정렬한다. 마감일이 비어 있는 업무는 날짜가 있는 업무 뒤에 표시한다. 각 업무에는 현재 상태, 담당자, 우선순위, 시작일·종료일과 적용한 마감일 정보가 포함된다.
