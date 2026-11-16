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
| `GET /users` | 담당자 지정에 필요한 팀원 ID·이름·색상 |
| `GET /planning-items?projectId=...&kind=cycle` | 프로젝트별 사이클·모듈·릴리스 조회 |
| `GET /planning-items/:id` | 계획 항목 조회 |
| `GET /issues?projectId=...` · `GET /issues/:id` | 업무 조회 |
| `GET /documents?projectId=...` · `GET /documents/:id` | 문서 조회 |
| `GET /documents/:id/revisions` | 문서 버전 조회 |
| `GET /comments?resourceType=issue&resourceId=...` | 업무 또는 문서 댓글 조회 |
| `POST /issues` · `PATCH /issues/:id` · `DELETE /issues/:id` | 업무 생성·수정·삭제 |
| `POST /documents` · `PATCH /documents/:id` · `DELETE /documents/:id` | 문서 생성·수정·삭제 |
| `POST /comments` | 업무 또는 문서 댓글 작성 |

표의 경로 앞에는 `/api/v1`이 붙는다. 읽기 키는 조회만 허용하며 쓰기 키는 조회와 표의 변경 요청을 허용한다. 프로젝트 범위는 조회·원래 대상·이동 대상·상위 항목·계획 참조에 적용한다. 공통 문서는 전체 프로젝트 키로 접근한다.

백업·가져오기·연동 설정·키 관리·공동 편집 소켓 등 표에 없는 경로는 자동화 API에서 허용하지 않는다. 계획 항목은 현재 관리 화면에서 생성하며 자동화 API로 조회하고 티켓에 연결할 수 있다.

## 업무 생성·수정

프로젝트 ID와 상태·유형·팀원·계획 ID는 조회 응답으로 확인한다. 기본 상태는 프로젝트 워크플로에 따르며, 같은 필수 입력·상태 전이 규칙을 적용한다.

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

## 키와 실행 환경

현재 브라우저용 `/api`와 작업자 선택은 신뢰하는 로컬 팀 개발 환경을 위한 기능이며 로그인 인증을 제공하지 않는다. API 키의 권한 검사는 `/api/v1`에 적용된다. 키 발급이 애플리케이션 전체의 로그인이나 외부 접근 제한을 대신하지 않는다. 운영 배포에서는 브라우저 접근 경계와 자동화 API 공개 경로를 함께 정해야 한다.

자체 백업에는 API 키가 포함되지 않는다. 백업 가져오기는 팀원·프로젝트를 교체하므로 기존 키를 모두 회수한다. 복원 후 필요한 키를 다시 발급한다. 실패한 가져오기는 키와 기존 데이터를 유지한다.
