# 파일럿 실행과 복원

## 독립 실행

Linux에 Node.js 24 이상, GNU coreutils, util-linux의 `flock`을 준비한다. 저장소 루트에서 의존성을 설치하고 파일럿 웹 번들을 빌드한다. 데이터 디렉터리에는 절대 경로를 지정하고 상위 디렉터리를 먼저 만든다.

```bash
npm ci
npm run build:pilot
mkdir -p "$HOME/teamspace-pilot"
TEAMSPACE_DATA_DIR="$HOME/teamspace-pilot/workspace" npm run start:pilot
```

브라우저는 `http://127.0.0.1:5190`을 연다. 정적 웹, `/api`와 공동 편집 WebSocket을 같은 Node 프로세스와 같은 주소에서 제공한다. 파일럿 프로세스는 데이터 경로 끝에 `.teamspace.lock`을 붙인 형제 파일의 잠금을 실행 동안 유지한다. 같은 데이터를 사용하는 파일럿과 백업 명령은 이 잠금을 공유한다.

- 빈 데이터에서는 **워크스페이스 설정**에서 첫 팀원을 등록한 뒤 프로젝트를 만든다.
- 별도의 예시 데이터 디렉터리에서 `TEAMSPACE_PILOT_DEMO=1`을 지정하면 합성 자료로 시작한다.
- 포트는 `TEAMSPACE_PILOT_PORT`로 바꾼다. 포트 `0`을 지정하면 운영체제가 고른 루프백 포트를 시작 로그에서 확인할 수 있다.
- 격리 복원 테스트는 `TEAMSPACE_PILOT_OUTBOUND=0`으로 시작한다. 이 값은 보관된 외부 웹훅의 자동 전송을 일시 중지한다.
- 복원 직후의 티켓 건수와 예약을 대조할 때 `TEAMSPACE_PILOT_RECURRING_ISSUES=0`으로 실행하면 반복 업무의 예약 확인을 일시 중지할 수 있다. 예약 규칙과 실행 기록은 조회할 수 있다.
- `TEAMSPACE_PILOT_DEADLINE_REMINDERS=0`을 지정하면 마감 알림의 자동 확인을 일시 중지한다. 이미 저장된 알림은 그대로 조회한다.

## 팀 접속 주소

기존 HTTPS 리버스 프록시에서 팀 주소의 루트 경로를 같은 호스트의 `http://127.0.0.1:5190`으로 연결한다. 원래 `Host`와 `Origin`을 전달하고 `/api/collaboration`에서 WebSocket 업그레이드를 지원한다. 첨부와 원본 패키지를 올릴 경우 프록시에서 최대 64MiB 요청 본문을 받도록 설정한다. [Nginx WebSocket 프록시 문서](https://nginx.org/en/docs/http/websocket.html)

접속 키를 처음 만들 때는 데이터 디렉터리와 Git 저장소 밖에 별도 파일을 생성한다. `teamspace.example.internal`은 사용할 팀 주소로 바꾼다.

```bash
mkdir -p "$HOME/teamspace-pilot"
(umask 077; set -o noclobber; openssl rand -hex 32 > "$HOME/teamspace-pilot/team-access.key")
TEAMSPACE_DATA_DIR="$HOME/teamspace-pilot/workspace" \
TEAMSPACE_PILOT_ORIGIN=https://teamspace.example.internal \
TEAMSPACE_PILOT_ACCESS_FILE="$HOME/teamspace-pilot/team-access.key" npm run start:pilot
```

팀원은 브라우저에서 HTTPS 주소를 열고 공용 키를 입력한 뒤 앱에서 작업자를 선택한다. 기존 업무나 문서 링크로 들어오면 접속 뒤 같은 위치를 연다. 브라우저 세션은 12시간 유지되며, 파일럿을 재시작하면 다시 접속한다. 편집 화면을 열어 둔 상태에서 접속이 만료되면 사이드바의 **팀 접속**을 새 탭에서 열고 키를 다시 입력할 수 있다. **접속 종료**는 해당 브라우저의 세션과 공동 편집 연결을 종료한다. `/api/v1`은 개인 API 키를 사용하고 GitLab 웹훅은 별도 수신 자격 증명을 사용한다.

`npm run test:pilot:access`는 OpenSSL과 Chromium을 사용해 임시 루프백 HTTPS 프록시에서 접속, 공동 편집, 연동 경로를 검증한다.

## 상태 변경에 인수인계 남기기

프로젝트 목록의 상태 칸이나 보드 카드의 **상태 변경**에서 목표 상태와 담당자를 선택한다. **인수인계 댓글**에 처리 이유나 다음 담당자에게 전달할 내용을 적고, 필요한 팀원은 `@`로 멘션한다. **상태 변경 적용**으로 티켓과 댓글을 함께 저장한다. 응답이 끊기면 **저장 결과 다시 확인**을 누른다. 다른 사람이 먼저 상태를 바꿨다면 **최신 업무 불러오기**에서 현재 초안을 유지하고 가능한 전이를 다시 선택할 수 있다.

## GitLab 웹훅 수신 확인

처음 연결할 때는 **개발 · GitLab → GitLab 저장소 찾기**를 사용한다. GitLab 서비스 주소와 읽기 토큰을 입력하고 저장소 이름이나 `group/subgroup/repository` 전체 경로로 검색한다. 결과의 **추가**를 누르면 GitLab 프로젝트 ID 입력에 반영된다. 알고 있는 숫자 ID도 직접 입력할 수 있다. **연결 미리보기**에서 티켓 연결을 확인한 뒤 **연결 설정 저장**과 **지금 동기화**를 실행한다. [GitLab 저장소 조회](https://docs.gitlab.com/api/projects/#list-all-projects)

같은 연결 화면에서 **배포 조회 저장소**를 고른 뒤 **배포 조회 미리보기**를 누르면 현재 입력으로 배포와 포함 MR의 조회 범위를 확인한다. 배포 목록이 비어 있는 경우와 성공한 배포가 없어 포함 MR을 확인할 수 없는 경우가 구분된다. 포함 MR 일부를 읽지 못했다면 권한·요청 한도·조회 범위 안내를 확인한다. 미리보기는 연결 저장과 배포 동기화 전에 사용할 수 있다. [GitLab 환경별 배포](API.md#gitlab-환경별-배포)

동기화 후 화면을 다시 열고 **GitLab 동기화 결과**에서 저장소별 완료 시각과 마지막 성공 시각을 확인한다. 실패하면 표시된 조회 단계를 확인하고 해당 저장소만 다시 시도한다. **GitLab 배포 기록**에서도 저장소를 바꿔 최근 배포 동기화 결과와 부분 조회 여부를 확인한다.

**개발 · GitLab → GitLab 웹훅 수신 확인**에서 저장소별 **이벤트별 수신**을 펼친다. Push·Merge Request·Pipeline·배포 이벤트의 최근 인증 시각과 업무 연결 또는 배포 반영 여부를 각각 확인할 수 있다. 업무 연결이 0건이어도 수신을 표시한다. 재전송은 최근 수신에 표시하며 이벤트별로는 이전 처리 결과를 유지한다. GitLab에서 이벤트를 보낸 뒤 **수신 상태 새로고침**을 누른다.

수신이 대기 상태면 **GitLab 프로젝트 웹훅 설정 → 웹훅 설정 점검 → 최근 전송 확인**을 연다. 각 GitLab 전송의 HTTP 상태와 **같은 메시지 인증 수신**을 확인한다. **미확인**은 현재 보관한 인증 수신에서 그 메시지를 찾지 못했다는 뜻이다. **대조 불가**는 GitLab 응답에서 메시지 근거를 확인할 수 없는 경우다. 저장소 전체의 마지막 인증 수신은 목록 아래에 표시된다. 401·403은 수신 인증과 프록시 접근을, 404·리다이렉트는 수신 주소와 프록시 경로를 확인한다. HTTP 응답이 없으면 GitLab의 전송 상세에서 주소·TLS·연결을 확인한다. API 조회는 GitLab 17.3 이상과 웹훅 조회 권한이 필요하다. GitLab에서도 **Settings → Webhooks → Edit → Recent events**를 열 수 있다. [GitLab 전송 이력 API](https://docs.gitlab.com/api/project_webhooks/#list-project-webhook-events) · [GitLab 웹훅 전송 이력 화면](https://docs.gitlab.com/user/project/integrations/webhooks/#view-webhook-request-history)

기존 훅으로 배포를 받으려면 GitLab 프로젝트의 웹훅 설정에서 **Deployment events**를 켠다. 정상 배포 이벤트가 기록되면 수신 확인에 **배포 기록 반영**이 표시된다. **GitLab 배포 기록**에서 저장소를 선택해 환경·상태·시각을 대조하고, 연결된 커밋이나 병합 MR이 있으면 해당 티켓의 배포 목록에서 같은 항목을 확인한다. 새 수신부터 기록한다. [GitLab 배포 이벤트](https://docs.gitlab.com/user/project/integrations/webhook_events/#deployment-events)

기존 배포는 같은 패널의 **배포 이력 동기화**로 가져온다. GitLab이 포함 MR을 제공하면 Teamspace에 연결된 해당 MR의 티켓에서도 그 배포를 연다. 부분 조회 안내가 표시되면 GitLab 저장소의 읽기 권한과 배포 환경의 MR 추적 설정을 확인할 수 있다. [GitLab 배포별 MR 추적](https://docs.gitlab.com/ci/environments/deployments/#track-newly-included-merge-requests-per-deployment)

HTTPS 파일럿 검사는 임시 프록시로 네 유형의 합성 웹훅을 전송한다. Signing Token과 Secret Token을 함께 설정한 상태에서 서명과 원문이 일치하는 요청의 인증을 확인하고, 같은 JSON을 다시 직렬화해 바이트가 달라진 요청과 잘못된 서명은 거절되는지 검사한다. [GitLab 서명 검증](https://docs.gitlab.com/user/project/integrations/webhooks/#verify-the-signature)

티켓 키가 없는 작업은 티켓의 **GitLab 개발 활동**에서 허용 저장소를 선택하고 기존 브랜치·커밋·MR·파이프라인 주소를 붙여 넣어 연결한다. 브랜치는 해당 브랜치의 루트 페이지 주소, 커밋은 전체 SHA가 들어간 주소를 사용한다. 연결된 브랜치는 인증된 푸시로 확인한 마지막 SHA와 삭제 상태를 표시한다.

### 티켓에서 GitLab 상태 변경 검토

웹훅으로 상태가 반영되지 않았을 때 티켓의 **GitLab 개발 활동 → GitLab에서 상태 확인**을 누른다. 연결된 MR의 병합·닫기 또는 최신 파이프라인의 성공·실패가 활성 규칙과 일치하면 **GitLab 상태 변경 제안**에서 시작·목표 상태와 규칙, 연결 근거를 확인할 수 있다. 확인한 결과들이 서로 다른 목표를 가리키면 화면에 제안 보류 안내가 표시된다. [GitLab MR 단건 조회](https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request) · [GitLab 파이프라인 단건 조회](https://docs.gitlab.com/api/pipelines/#retrieve-a-single-pipeline)

확인하려는 MR이나 파이프라인이 정해져 있으면 해당 행의 **이 활동으로 상태 검토**를 누른다. 활동 목록의 이전 페이지에 있는 항목도 선택할 수 있다. 제안 카드에서 **선택한 GitLab 활동 기준**과 원본 결과를 확인한다. 더 최신인 같은 계열의 파이프라인이 확인되면 오래된 결과의 상태 제안은 보류된다.

**MR 열림** 규칙의 웹훅이 누락된 경우, 연결을 동기화한 뒤 열린 MR에서 이 활동을 검토한다. 규칙을 켠 뒤 생성한 MR이면 적용 가능한 상태를 확인할 수 있다. 티켓을 저장할 때 GitLab의 같은 MR을 다시 읽는다. 그사이 MR이 닫히거나 브랜치·커밋이 바뀌면 새 검토가 필요하다.

**MR 닫기** 제안을 저장할 때도 같은 MR을 다시 읽는다. MR이 다시 열리거나 다시 닫혀 종료 시각이 바뀌면 저장을 보류한다. 입력한 제목과 댓글을 이어 쓰면서 새 종료를 검토한 뒤 저장할 수 있다.

파이프라인으로 상태를 제안할 때는 GitLab에서 같은 참조·실행 유형·브랜치 또는 태그에 해당하는 최신 실행을 확인한다. 이전 결과에는 더 최신 실행이 있다는 안내가 표시된다. 최신 실행을 티켓에서 찾을 수 없으면 동기화하거나 해당 실행을 연결한 뒤 상태를 다시 검토한다. 검토한 뒤 새 실행이 생겨 저장이 중단돼도 작성 중인 제목과 댓글은 남는다.

배포 성공 웹훅이 누락됐으면 티켓의 **연결된 GitLab 배포**에서 **이 배포로 상태 검토**를 누른다. 이전 배포가 티켓에 표시되지 않으면 개발 화면의 **배포 이력 동기화**로 저장소의 기록을 먼저 갱신한다. 해당 배포의 성공 시각, 같은 환경의 최신 성공 여부, 티켓 자동 연결이 확인되면 적용 가능한 규칙의 제안을 검토할 수 있다.

**목표 상태로 편집**을 누르면 티켓의 상태 입력에 목표가 들어간다. 제목·설명·댓글 초안을 이어서 쓸 수 있다. 필요한 항목을 채우고 **변경사항 저장**을 누르면 현재 작업자의 변경으로 기록된다. 5분이 지나거나 검토한 업무·규칙·연결이 바뀌면 GitLab에서 다시 확인한다. 보류된 저장의 다른 입력과 댓글 초안은 유지된다.

## Jira·Confluence 원본 조회

업무 상세 또는 문서 **연결** 탭에서 **기존 도구 연결**을 사용한다. Jira는 `/browse/TEAM-17`, Confluence는 `/pages/viewpage.action?pageId=1234`, `/display/TEAM/Release+Notes`, `/spaces/TEAM/pages/1234/Release-Notes`와 Server·Data Center의 짧은 주소 `/x/ZIAB` 같은 브라우저 주소를 받는다. 기존 서버의 `/jira` 또는 `/wiki` 같은 경로도 주소에 포함한다. 예전에 저장한 본문에 짧은 주소가 있으면 그 주소를 **통합 검색**에 붙여넣어 저장된 원본 연결을 찾을 수 있다. [Confluence 주소 형식](https://support.atlassian.com/confluence/kb/the-differences-between-various-url-formats-for-a-confluence-page/)

이관 시 Confluence 원본 기본 주소를 지정한 프로젝트에서는 기존 댓글의 고정 주소를 **통합 검색**에 붙여넣는다. **Confluence 댓글 주소**로 표시된 문서를 열면 이관한 댓글 또는 답글에 초점이 이동한다. 원래 제목 주소와 번호 주소를 확인하고, 문서 제목을 바꾸거나 문서를 옮긴 뒤에도 같은 댓글이 열리는지 대조한다.

**원본 정보 조회**를 활성화하려면 파일럿 실행 환경에 사용할 기본 주소를 지정한다. 한 제품에 서버 한 곳을 설정하며, 저장한 링크의 서버 주소와 기본 경로가 설정값과 일치할 때 조회한다.

```bash
TEAMSPACE_DATA_DIR="$HOME/teamspace-pilot/workspace" \
TEAMSPACE_JIRA_BASE_URL=https://jira.example.internal/jira \
TEAMSPACE_CONFLUENCE_BASE_URL=https://wiki.example.internal \
TEAMSPACE_JIRA_AUTH_FILE=/run/secrets/teamspace-jira-auth \
TEAMSPACE_CONFLUENCE_AUTH_FILE=/run/secrets/teamspace-confluence-auth \
npm run start:pilot
```

인증 파일의 한 줄에 `Bearer <토큰>` 또는 `Basic <사용자:암호의 base64>`를 넣고 실행 계정만 읽을 수 있게 권한을 설정한다. 인증 파일은 파일럿의 데이터 디렉터리와 Git 저장소 밖에 둔다. 원본이 익명 읽기를 허용하면 해당 `AUTH_FILE` 설정을 생략한다. Teamspace에서 팀에 공유할 수 있는 범위를 읽는 계정으로 설정한다. [Atlassian 개인 액세스 토큰 지원 버전](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)

조회는 제목·상태·식별자·수정 시각을 화면에 표시한다. Confluence 문서의 본문과 첨부를 옮길 때는 오프라인 이관을 사용한다. 백업에는 연결 주소와 Teamspace 업무·문서 ID를 보존한다.

## 전체 데이터 백업

파일럿을 종료한 뒤 같은 데이터 경로에 대해 백업을 실행한다. 파일럿이 실행 중이거나 백업·복원이 같은 잠금을 쓰는 경우 명령은 종료 코드 `75`로 실패한다. 개발 서버와 파일럿의 데이터 디렉터리는 따로 사용한다.

```bash
npm run pilot:backup -- \
  "$HOME/teamspace-pilot/workspace" \
  "$HOME/teamspace-pilot/backup-2026-11-19"
```

결과 디렉터리에는 `manifest.json`과 `data/`가 있다. SQLite, 첨부 바이트, 이관 분석 원본, `.credential-key`와 재시작에 필요한 복구 저널을 포함한다. SQLite 검증과 WAL 정리는 복사본에서 수행한다. 파일별 SHA-256과 크기를 기록하고 비어 있는 디렉터리도 보존한다. 활성·휴지통 첨부파일의 모든 버전과 이관 분석 원본은 SQLite에 저장된 크기·해시와도 대조한다. 참조 파일이 누락되거나 손상되면 결과 경로를 만들기 전에 중단한다. 전체 사본에는 연결 자격 정보와 비공개 자료가 포함되므로 백업 경로의 접근 권한을 운영 데이터와 같은 수준으로 관리한다.

## 별도 경로에 복원

아직 존재하지 않는 경로를 복원 대상으로 지정한다. CLI는 매니페스트의 파일 목록·크기·해시, SQLite 무결성, SQLite가 참조하는 첨부 및 이관 원본을 검사한 뒤 복원 디렉터리를 한 번에 만든다. 첨부파일 교체 저널이 남아 있으면 다음 시작 때 보존할 디렉터리를 SQLite의 커밋 값으로 판정해 대조한다.

```bash
npm run pilot:restore -- \
  "$HOME/teamspace-pilot/backup-2026-11-19" \
  "$HOME/teamspace-pilot/restore-drill"
TEAMSPACE_DATA_DIR="$HOME/teamspace-pilot/restore-drill" \
TEAMSPACE_PILOT_PORT=5191 TEAMSPACE_PILOT_OUTBOUND=0 TEAMSPACE_PILOT_RECURRING_ISSUES=0 npm run start:pilot
```

복원 리허설은 별도 주소와 새 브라우저 프로필에서 수행한다. 물리 복원은 기존 API 키·연동 설정·공동 편집 세대도 복원한다. 실제 팀 주소로 전환할 때는 이전 브라우저의 미전송 공동 편집과 외부 웹훅 전송 대기를 확인한다. 전체 JSON 내보내기·가져오기는 별도의 데이터 이동 기능이다.

## 합성 자료로 통합 검증

검사에 사용할 Chromium을 `npx playwright install chromium`으로 설치하거나 `CHROMIUM_PATH`로 지정한다.

```bash
npm run test:pilot
```

이 명령은 파일럿을 빌드하고 임시 데이터와 루프백 포트에서 실행한다. Chromium 브라우저에서 간트·문서·첨부, 두 작업자의 공동 편집과 커서 표시·해제를 확인한다. 파일럿 실행 중 백업 거절, 종료 후 백업·복원, 변조 검출, 복원본의 업무·문서·이관 원본 읽기, 휴지통의 업무를 복원한 뒤 최초 및 최신 첨부 바이트 읽기, 팀 알림의 읽음 상태, 프로젝트 가용 시간과 팀 날짜 예외·프로젝트 간 과부하, 활성 담당자 배정 규칙과 실행 기록, 복원된 GitLab 토큰을 사용하는 모의 서버 조회를 검증한다. 검사에 사용한 임시 데이터는 종료 후 정리한다.

휴지통에 보낸 업무가 비운 시간을 다른 프로젝트의 업무에 배정한다. 별도 물리 복원본에서 원래 업무를 다시 살린 뒤, 새 배정은 확정된 상태로 남고 원래 배정은 재검토 상태와 기존 시각을 유지하는지 확인한다.

합성 GitLab에서 저장소를 검색하고 결과의 ID로 연결을 저장한다. 이관한 Jira 업무를 합성 GitLab MR의 원래 키로 연결하고, 티켓 키가 없는 브랜치와 커밋을 주소로 추가한다. 별도 물리 복원본에서 저장소의 Jira 원본 매핑과 링크를 대조한다. 같은 MR을 다시 읽어도 중복되지 않고, 복원한 브랜치는 인증된 푸시로 갱신되는지 검사한다.

합성 티켓을 착수 상태로 전환할 때 표시 조건에 따라 필수 확인 항목을 요청한다. 해당 값을 넣으면 상태와 담당자 자동 배정을 함께 적용한다. 물리 복원 뒤에도 양식 설정과 입력값을 읽고 동일한 필수 규칙을 확인한다.

같은 요청 ID로 티켓 생성 요청을 다시 보낸 뒤 업무·생성 이력·담당 알림이 각각 한 건인지 확인한다. 별도 물리 복원본에서 해당 업무가 휴지통에 있을 때 재시도는 충돌을 반환하고, 업무를 되살린 뒤에는 원래 ID와 번호를 반환하는지 대조한다.

개별 댓글과 두 버전의 첨부를 먼저 휴지통에 보내고 상위 업무도 보관한 뒤 물리 백업을 만든다. 복원본에서 상위 업무를 되살리고 개별 항목을 이어서 복구한다. 댓글의 원래 작성 정보와 두 파일 버전의 다운로드 바이트를 비교한다.

같은 검사에서 합성 Jira 관리자 XML과 별도 첨부 경로를 담은 ZIP, Confluence 공간 XML ZIP을 신규 프로젝트에 함께 적용한다. Jira 원래 키와 작성자 매핑, 91초 작업 기록, 명시적으로 제외한 공개 제한 기록, Confluence 페이지 ID와 업무 양방향 연결을 확인한다. 서로 다른 두 공간에 제목이 같은 문서를 두고 상대 참조가 원본과 같은 공간의 문서를 여는지 확인한다. 다른 공간의 동명 첨부를 가리키는 링크와 전체 첨부 버전의 크기·SHA-256·다운로드 바이트도 대조한다. 별도 물리 복원본에서 원본 패키지 바이트와 전체 이관 검증 결과를 다시 비교하고, 복원한 업무의 상태 변경을 확인한다.

## Jira Data Center에서 REST 자료 수집

관리자 내보내기 대신 현재 읽을 수 있는 Jira 업무를 이관 리허설용 ZIP으로 수집할 수 있다. 설정 파일에서 하나의 프로젝트 전체 또는 현재 업무 키 목록을 지정한다. `baseUrl`에는 `/jira` 같은 실제 서비스 경로를 포함한다. 인증 파일에는 `Bearer <토큰>` 또는 `Basic <사용자:암호의 base64>`를 한 줄로 저장한다. 인증 파일은 Git 밖에 두며 상대 경로는 설정 파일 기준이다.

```json
{
  "baseUrl": "https://jira.example.test/jira",
  "authFile": "/run/secrets/teamspace-jira-auth",
  "projectKey": "TEAM",
  "includeAttachments": true
}
```

```bash
npm run pilot:jira:collect -- /absolute/path/jira-config.json /absolute/path/jira-project.zip
```

한 번에 500개까지 수집한다. 현재 키를 알고 있는 경우 `projectKey` 대신 `"issueKeys": ["TEAM-11", "TEAM-12"]`처럼 범위를 지정해도 된다. 작업은 Jira Data Center REST v2의 GET 요청만 사용한다. 원래 업무 키·필드 이름과 스키마·댓글·작업 시간·변경 이력을 ZIP에 저장한다. 댓글과 작업 시간은 페이지의 소유 업무·원본 ID·범위 및 겹치는 내장 응답을 대조한다. 첨부는 같은 호스트와 서비스 경로에서 ID를 확인한 파일의 바이트를 가져온다. 첨부 없이 먼저 검토할 때는 `includeAttachments`를 `false`로 지정한다. [Jira 검색 API](https://developer.atlassian.com/server/jira/platform/rest/v10006/api-group-search/) · [Jira 업무 API](https://developer.atlassian.com/server/jira/platform/rest/v11000/api-group-issue/) · [첨부 메타데이터 API](https://developer.atlassian.com/server/jira/platform/rest/v11000/api-group-attachment/)

출력 ZIP은 새 파일로만 저장하며 크기와 SHA-256을 결과에 기록한다. ZIP 한도인 64MiB를 넘으면 업무 키를 나누어 수집한다. 검색 또는 댓글·작업 시간의 페이지 범위가 달라지면 ZIP 발행을 중단한다. 일부 Data Center에서는 이슈 상세의 변경 이력이 일부만 제공되고 별도 페이지 조회를 지원하지 않는다. 이 경우 받은 원본을 저장하고 `incompleteHistories`에 건수를 기록한다. 생략한 첨부, 조회할 수 없는 첨부, 20MiB를 넘긴 첨부는 메타데이터를 보존하고 각각 건수로 표시한다. 수집 결과의 범위는 해당 Jira 계정에서 열람할 수 있는 자료다. 아래 리허설에서 제한 기록·매핑·누락을 확인한다. `npm run test:pilot:jira`는 로컬 모의 Jira와 Teamspace 분석기로 이 흐름을 검사한다.

업무별 원격 링크 목록은 Jira의 `GET /rest/api/2/issue/{id}/remotelink`에서 읽어 ZIP에 함께 저장한다. 수집 명령은 Jira에만 요청하며 외부 링크의 목적지와 아이콘 주소는 원본 값으로 저장한다. `remoteLinkCount`에는 목록에서 읽은 링크를, `unavailableRemoteLinkIssues`에는 조회가 403 또는 404로 끝난 업무를 센다. 이전 ZIP에서 원격 링크 목록을 읽었는지 확인할 수 없는 경우 이 명령으로 다시 수집한다. [Jira 원격 링크 API](https://developer.atlassian.com/server/jira/platform/jira-rest-api-for-remote-issue-links/)

Jira ZIP과 Confluence 공간 XML은 함께 또는 순서대로 이관할 수 있다. Confluence 패키지의 **원본 기준 주소**에 서버 주소와 설치 경로를 넣는다. 서로 다른 시점에 이관할 때는 두 번째 미리보기의 **기존 항목과 연결할 업무·문서**에서 티켓과 문서가 있는 프로젝트를 확인한다. 미리보기 이후 기존 항목이 바뀌면 새로 검토한다. 적용한 연결은 두 번째 영수증의 업무·문서 연결 검증에서 확인할 수 있다.

### Jira 프로젝트 분할 수집

업무가 500개를 넘거나 첨부 때문에 한 ZIP의 용량을 넘을 것으로 예상되면 `projectKey` 설정으로 분할 계획을 만든다. `--batch-size`는 묶음당 1~500개이며 기본값은 100개다. 계획 하나에 Jira 계정에서 열람할 수 있는 업무 최대 10,000개를 담는다.

```bash
npm run pilot:jira:collect -- plan /absolute/path/jira-config.json /absolute/path/jira-plan.json --batch-size 250
npm run pilot:jira:collect -- batch /absolute/path/jira-config.json /absolute/path/jira-plan.json 1 /absolute/path/jira-001.zip
npm run pilot:jira:collect -- batch /absolute/path/jira-config.json /absolute/path/jira-plan.json 2 /absolute/path/jira-002.zip
```

계획은 전체 검색을 두 번 읽어 순서·업무 ID·현재 키를 대조한다. 모두 일치하면 권한 `0600`인 새 파일에 묶음별 ID와 키를 저장한다. 계획 생성 결과는 전체 업무 수·묶음 수·SHA-256을 출력한다. 원본 업무 식별자가 들어 있는 계획 파일은 팀 내부에 보관한다. [Jira 검색 페이지 조회](https://developer.atlassian.com/server/jira/platform/rest/v10006/api-group-search/#get-issues-using-jql)

출력된 묶음 수까지 번호를 바꿔 수집한다. 각 ZIP은 지정한 묶음의 업무 ID로 조회하며 현재 키·프로젝트와 계획을 대조한다. 빠진 묶음 번호가 없는지, 각 결과의 `planSha256`과 `issueCount` 합계가 계획 생성 결과의 `sha256`과 전체 업무 수에 각각 일치하는지 확인한다. 실패한 묶음은 같은 번호로 재시도할 수 있다. 원본 ID와 키가 달라졌거나 ZIP 용량 때문에 묶음을 나눠야 하면 새 계획으로 다시 확인한다. ZIP을 이관 매니페스트에 추가할 때는 같은 `instanceKey`를 사용하고, 이관 매핑에서 같은 대상 프로젝트 키와 이름을 지정한다. 리허설당 파일 20개와 합계 512MiB 한도를 적용한다. [오프라인 원본 이관 리허설](#오프라인-원본-이관-리허설)

분할 수집한 ZIP을 리허설에 넣을 때는 `stage`에 수집 계획을 함께 지정한다. 여러 프로젝트의 계획을 대조하려면 `--jira-plan`을 반복한다. `--profile`과 `--confluence-findings`도 같은 명령에서 사용할 수 있다.

```bash
npm run pilot:rehearsal -- stage /absolute/path/manifest.json /absolute/path/rehearsal \
  --jira-plan /absolute/path/jira-plan.json
```

ZIP이 매니페스트에 적힌 순서와 관계없이 계획의 각 묶음과 업무 ID·현재 키의 전체 집합을 대조한다. Jira 기준 주소와 서비스 경로, 원본 프로젝트도 확인한다. 묶음이 빠지거나 중복되거나, 같은 계획의 ZIP에 서로 다른 `instanceKey`를 지정하면 준비를 중단한다. 파일과 댓글·작업 시간·변경 이력의 누락 여부는 원본 분석과 적용 결과에서 별도로 확인한다.

수집 계획은 리허설과 물리 백업에 접근 권한 `0600`인 파일로 보관된다. `review`에서 연결된 ZIP을 다시 확인하고, `verify`에서 원본과 별도 복원본의 묶음 연결을 재검사한다. 검증 보고서의 `jiraPlans`에는 계획 SHA-256·업무 및 묶음 수·묶음 번호순 패키지 ID가 들어 있다. `source.jiraPlanCoverage`와 `restore.jiraPlanCoverage`는 각 워크스페이스에서 대조를 끝냈을 때 기록된다. Jira 업무 ID·키·서버 주소는 보고서에서 생략한다.

## Confluence 공간 XML과 현재 페이지 대조

Confluence Server에서 공간 XML ZIP을 받은 후, 같은 공간의 현재 페이지 목록과 대조할 수 있다. `baseUrl`에는 실제 서비스 경로를 포함한다. 인증 파일은 저장소 밖에 두고 서버에서 허용하는 `Basic ...` 또는 `Bearer ...` 값을 한 줄로 작성한다. `pageIds`를 생략하면 현재 계정으로 목록에 보이는 페이지를 최대 500개까지 확인한다. 페이지를 나눠 확인할 때는 문자열 ID 목록을 추가한다. 선택한 페이지의 상위 페이지도 계층과 상속된 읽기 제한을 확인할 때 조회한다. [Confluence Server 6.9.1 REST API](https://docs.atlassian.com/ConfluenceServer/rest/6.9.1/) · [페이지 제한과 상속](https://confluence.atlassian.com/conf59/page-restrictions-792498763.html)

```json
{
  "baseUrl": "https://wiki.example.test/confluence",
  "authFile": "./confluence-read-auth.txt",
  "spaceKey": "TEAM",
  "pageIds": ["12345", "12346"]
}
```

```bash
npm run pilot:confluence:audit -- /absolute/path/confluence-audit.json /absolute/path/confluence-space.zip
```

ZIP을 생략하면 현재 페이지와 제한 확인 결과만 나온다. ZIP을 지정하면 같은 공간의 현재 페이지 누락, 원본 ZIP에만 있는 페이지, 버전·상위 관계·제한 표시 차이, 본문·첨부 근거와 분석 진단을 대조한다. 명령은 Confluence에 메타데이터 읽기 요청만 보내며 ZIP은 로컬에서 분석한다. 출력은 ZIP 해시·크기·건수·판정으로 구성한다. 결과가 `observed` 또는 `matched`면 종료 코드 `0`, 제한·누락·불일치를 검토해야 하면 `2`, 연결이나 ZIP을 검사할 수 없으면 `1`이다.

`matched`는 조회한 페이지의 확인 항목이 일치했다는 뜻이다. 원본 ZIP에만 있는 페이지는 현재 계정에 보이지 않을 수 있다. 공간 권한은 보고서의 `spacePermissions`에 수동 검토로 표시된다. 이관 대상과 원본의 열람 범위, 과거 버전 및 첨부를 확인한 후 아래 리허설에서 적용을 검토한다. `npm run test:pilot:confluence`는 모의 Confluence와 Teamspace 분석기로 이 절차를 검사한다. [Atlassian의 공간 XML 내보내기 안내](https://confluence.atlassian.com/conf711/export-content-to-word-pdf-html-and-xml-1044781118.html)

페이지를 찾아 검토하려면 ZIP을 지정한 실행에 `--findings`를 추가한다.

```bash
npm run pilot:confluence:audit -- /absolute/path/confluence-audit.json /absolute/path/confluence-space.zip --findings /absolute/path/page-findings.json
```

새 검토 파일은 실행 계정만 읽고 쓸 수 있는 권한으로 저장한다. ZIP의 SHA-256·크기, 조회 범위·시각, 확인할 페이지 ID와 사유 코드가 들어간다. Confluence 형식의 숫자 ID로 확인할 수 없는 항목은 `unidentifiedPages` 건수로 남긴다. 형식 3은 ZIP의 전체 현재 페이지 수, 조회와 ID가 일치한 페이지 수, 제한 상태를 확인한 페이지 수와 정확한 ID 목록을 보관한다. 지정 범위 밖, 다른 공간, 공간을 확인할 수 없는 ZIP 페이지도 각각 집계한다. 과거 버전과 블로그 게시물은 현재 페이지 집계에서 제외한다. 읽기 제한이 확인된 페이지도 커버리지에 포함하고 별도 진단을 남긴다. 형식 1과 2도 읽을 수 있으며 개별 검토 범위는 파일에 기록된 수준으로 표시한다.

| 사유 코드 | 확인할 항목 |
| --- | --- |
| `LIVE_RESTRICTED`, `LIVE_RESTRICTION_UNKNOWN` | 현재 페이지의 직접 제한이나 상위 페이지에서 상속된 읽기 제한, 또는 제한을 확인할 수 없는 응답 |
| `LIVE_PAGE_UNAVAILABLE`, `ARCHIVE_ONLY_PAGE` | 선택했으나 계정에서 읽을 수 없는 페이지, 또는 이번 조회에 잡히지 않고 ZIP에 있는 페이지 |
| `ARCHIVE_RESTRICTED`, `RESTRICTION_MISMATCH` | ZIP에서 확인한 제한 표시, 또는 확인된 현재 제한과 ZIP 표시의 차이 |
| `MISSING_FROM_ARCHIVE`, `VERSION_MISMATCH`, `HIERARCHY_MISMATCH` | ZIP의 페이지 누락, 현재 버전 또는 상위 관계 차이 |
| `MISSING_ARCHIVE_BODY`, `ATTACHMENT_EVIDENCE_PROBLEM` | ZIP에서 페이지 본문 또는 첨부 바이트를 확인할 수 있는지 여부 |

리허설의 `stage --confluence-findings`에 이 검토 파일을 지정하면 ZIP의 SHA-256과 크기를 대조해 같은 패키지에 연결한다. 적용 전 보관한 검토 파일에서 페이지 ID를 확인하고 **원본 주소와 제외 항목**에서 같은 패키지와 `page` 종류를 고른 뒤 해당 페이지를 찾는다. 팀 열람 범위에서 제외해야 하는 페이지는 체크하고 새 미리보기에서 하위 기록까지 적용 범위를 검토한다. 검토 파일은 원본 자료와 함께 비공개로 보관한다.

## 오프라인 원본 이관 리허설

리허설 명령은 지정한 내보내기 파일을 전용 워크스페이스에 분석한다. Jira REST 수집 ZIP, Jira 관리자 XML과 첨부파일을 담은 ZIP, Confluence 공간 XML ZIP 등 [지원 형식](API.md#기존-도구-원본-분석)에 해당하는 파일을 매니페스트에 적는다. `file`은 절대 경로나 매니페스트 기준 상대 경로다. 같은 원본 시스템에서 받은 후속 파일에는 같은 `instanceKey`를 사용한다.

```json
{
  "packages": [
    { "file": "jira-project.zip", "product": "jira", "instanceKey": "team-jira" },
    { "file": "confluence-space.zip", "product": "confluence", "instanceKey": "team-wiki" }
  ]
}
```

원본을 파일럿에 올리기 전에는 워크스페이스 없이 매니페스트의 파일을 바로 점검할 수 있다.

```bash
npm run pilot:rehearsal -- profile /absolute/path/manifest.json /absolute/path/source-profile.json
```

`profile`은 파일럿 빌드나 접속 없이 원본을 읽는다. 파일 순번, 원본 제품·형식, SHA-256·크기, 객체와 첨부 분석 건수, 진단 코드 집계를 새 JSON 보고서에 저장한다. 형식 2는 실제 파일의 바이트와 매니페스트의 순서·제품·인스턴스를 함께 계산한 해시도 기록한다. 원본 이름·경로·인스턴스 식별값·객체 식별자와 본문은 보고서에서 생략한다. 기존 보고서가 있으면 새 경로를 지정한다. 한 파일 64MiB, 최대 20개와 합계 512MiB를 검사한다. 종료 코드 `0`은 분석 완료, `2`는 경고나 확인할 범위가 남은 경우, `1`은 읽기·형식·한도·중복 오류 등으로 일부 파일 분석을 마칠 수 없었거나 실행에 실패한 경우다.

Jira 관리자 백업마다 ZIP을 따로 준비한다. 첨부 디렉터리 밖에 `entities.xml`이 여러 개 있으면 `JIRA_ADMIN_BACKUP_AMBIGUOUS`를 기록하고 해당 패키지를 `blocked`로 표시한다. `activeobjects.xml`은 관리자 XML과 같은 디렉터리에 둔다. 다른 디렉터리의 파일은 `JIRA_ACTIVEOBJECTS_OUTSIDE_BACKUP_ROOT` 경고로 표시한다.

Confluence XML에서 접근 제한 대상이 정확한 원본 객체에 연결되면 `CONFLUENCE_RESTRICTED_CONTENT`는 오류로 기록하고 패키지 판정은 `review`로 남긴다. 이 경우 격리된 리허설을 준비할 수 있다. 제한 대상이나 권한 집합을 확인할 수 없거나 다른 원본 분석 오류가 있으면 `blocked`로 남는다.

```bash
npm run build:pilot
npm run pilot:rehearsal -- stage /absolute/path/manifest.json /absolute/path/rehearsal --profile /absolute/path/source-profile.json
npm run pilot:rehearsal -- review /absolute/path/rehearsal
```

`stage --profile`은 `analyzed`와 `review` 상태의 형식 2 보고서를 받는다. 이전 형식은 `profile`로 다시 분석한다. 패키지 수·순서·제품·인스턴스를 실제 업로드할 바이트와 대조한다. 저장된 분석의 원본 형식, 압축 해제 크기와 객체·파일·오류·경고 건수도 확인한다. 오류가 있는 `review` 패키지는 파일럿이 저장한 오류를 전부 읽어 각 오류가 제한 대상 객체와 연결된 `CONFLUENCE_RESTRICTED_CONTENT`인지 확인한다. 동일한 ZIP은 경로나 파일명을 바꿔 지정할 수 있다. 개별 XML·CSV·JSON은 분석에 쓰는 파일명을 유지한다. 보고서가 `blocked`거나 파일·설정·분석이 달라지면 준비를 중단하고 이번 실행이 만든 작업공간을 정리한다. 성공한 준비는 `stage.json`과 후속 검증 보고서의 `profile`에 사전 분석 보고서 자체의 SHA-256과 시각·상태를 남긴다.

`review`에서 **이관 검토 진단**의 접근 제한 오류와 원본을 확인한다. 제한된 페이지를 제외하고 미리보기를 다시 만들면 확인된 하위 페이지·본문 이력·댓글·첨부도 이관 대상에서 빠진다. 오류가 남은 미리보기는 적용할 수 없다.

Confluence 대조 파일은 같은 `stage` 명령에 별도로 연결할 수 있다.

```bash
npm run pilot:rehearsal -- stage /absolute/path/manifest.json /absolute/path/rehearsal \
  --profile /absolute/path/source-profile.json \
  --confluence-findings /absolute/path/page-findings-1.json \
  --confluence-findings /absolute/path/page-findings-2.json
```

`--confluence-findings`는 반복 지정할 수 있다. 같은 ZIP을 한 번에 최대 500페이지씩 나눠 대조했다면 각 검토 파일을 지정한다. 각 파일은 SHA-256과 크기가 일치하는 Confluence XML ZIP 패키지 한 개에 연결한다. 같은 ZIP을 여러 인스턴스에 등록해 연결 대상이 모호하거나 동일한 검토 파일을 중복 지정하면 준비를 중단한다. 파일 한 개당 64MiB, 최대 100개와 합계 128MiB까지 읽는다. `confluence-findings/<검토 파일 SHA-256>.json`에 당시 바이트를 권한 `0600`으로 보관한다. `stage.json`과 `verify` 보고서의 `confluenceReviews`에는 패키지 ID·해시·대조 범위·사유별 건수와 확인 집계가 들어간다.

`stage`, `review`, `verify`는 형식 3의 ID를 ZIP의 현재 페이지 목록과 대조한다. 같은 ZIP에서 여러 번 확인한 페이지는 한 번만 센다. ZIP에 없는 ID나 다른 전체 페이지 수를 제출하면 그 파일을 사용하기 전에 중단한다. 형식 2는 개별 파일이 ZIP 전체를 확인한 경우 그 결과를 인정한다. 여러 형식 2의 부분 집계는 범위가 겹칠 수 있으므로 각각 표시한다.

`review`는 브라우저 주소를 출력하기 전에 검토에 연결한 ZIP과 저장된 분석 기록의 원본 인스턴스를 대조한다. 대조 파일에 현재 읽기 제한이 확인된 페이지(`LIVE_RESTRICTED`)가 있으면 XML에 제한 정보가 빠져 있어도 적용을 차단한다. **이관 검토 진단**에서 해당 원본을 제외한 뒤 새 미리보기를 연다. 같은 Confluence 인스턴스에서 다른 ZIP에 들어 있는 하위 페이지·댓글·이력·첨부에도 제외가 전파된다. 선택한 ZIP에 페이지 자체가 없으면 연결을 확인한 하위 기록을 직접 제외할 수 있다. 이전 미리보기는 현재 검토 범위에서 다시 만든다. 읽기 제한 여부를 확인하지 못한 페이지와 공간 권한은 담당자가 검토한다.

실제 데이터 이관에서 연결된 ZIP을 고르면 매핑과 미리보기의 **ZIP 전체 페이지 제한 확인**에서 형식 3의 합산 결과와 아직 확인할 페이지 수를 볼 수 있다. 아래에서 각 검토의 범위·시각·진단을 확인한다. 공간 권한과 이관 후 팀의 열람 범위는 별도로 검토한다.

`--profile`은 선택 옵션이다. `stage`는 새 디렉터리의 `workspace/.teamspace-rehearsal/`에 `stage.json`과 선택한 Confluence 검토 파일을 저장한다. 옵션 선택에 관계없이 한 파일 64MiB, 최대 20개, 합계 512MiB를 파일럿 시작 전과 실제 읽을 때 검사한다. `review`가 출력한 루프백 주소에서 **워크스페이스 설정 → 실제 데이터 이관**을 열고, 프로젝트·팀원·상태 매핑과 미리보기의 확인 항목을 검토한 뒤 적용한다. 특정 객체의 경고나 오류는 **이관 검토 진단 → 원본 상세 보기**에서 해당 패키지의 본문·메타데이터·관계와 대조한다. 리허설 파일럿은 루프백에만 접속을 받고 명령을 실행한 셸의 외부 연동 자격 증명을 상속하지 않는다.

이관 리허설은 `stage`, `review`, `verify`에서 외부 웹훅 전송과 반복 업무·마감 알림의 자동 실행을 중지한다. 저장된 규칙은 조회할 수 있다. `.teamspace-rehearsal/`이 있는 워크스페이스와 복원본은 일반 API와 팀 접속 모드에서 시작할 수 없으며 `pilot:rehearsal review`로 연다.

브라우저에서 파일을 준비할 때는 **워크스페이스 설정 → 기존 도구 원본 분석 → 여러 원본 파일 분석**을 연다. 파일별로 원본 도구와 인스턴스 식별값을 확인한 뒤 순서대로 분석한다. 실패한 행은 설정을 수정해 다시 시도하거나 대기열에서 뺄 수 있다. 응답을 받지 못한 파일도 같은 내용과 인스턴스 식별값으로 확인할 수 있으며 이미 저장된 분석은 다시 사용한다. **분석한 패키지로 이관 매핑**을 누르면 확인된 패키지를 **실제 데이터 이관**에서 선택한다. 다른 패키지의 작업 중인 매핑이나 미리보기가 있으면 교체를 확인한다. **선택 패키지 매핑 불러오기**에서 매핑을 열고 미리보기를 검토해 적용한다.

여러 파일을 올렸다면 **생성할 프로젝트**에서 대상의 **원본 프로젝트·공간**을 펼쳐 파일명, 인스턴스, 이관 건수를 확인한다. 다른 원본을 각각의 프로젝트로 옮기려면 **프로젝트 매핑**에서 서로 다른 대상 키를 지정하고 새 미리보기를 만든다. 여러 원본을 한 프로젝트로 옮기기로 했다면 `PROJECT_SOURCE_MERGE` 필수 확인을 선택한 뒤 적용한다.

새 Jira 프로젝트의 미리보기에서 **Jira 이력에서 확인한 전이**를 열면 각 방향으로 이동한 원본 업무 수를 볼 수 있다. 사용할 방향을 선택해 **선택한 전이를 매핑에 추가**를 누른 뒤 새 미리보기의 **적용할 Jira 워크플로**를 확인한다. 기존에 수동으로 추가한 전이와 초기 상태도 함께 확인할 수 있다. 적용 전에 체크한 항목을 매핑에 추가하거나 선택을 해제한다. [워크플로 이관](API.md#새-jira-프로젝트의-워크플로-지정)

**사용자 매핑 → 이메일 일치 후보 검토**에서 원본 계정과 팀원의 이메일을 비교한다. 원본과 대상이 맞는 항목만 선택하고 **선택한 매핑 반영**을 누른다. 기존 수동 지정은 유지되며, 선택 결과는 새 **적용 전 미리보기**에서 확인한다. 팀원 이메일이 검토 중 변경되면 표시된 후보를 다시 확인한다. 이메일이 없거나, 근거가 충돌하거나, 이전 Jira 분석에 확인 근거가 없는 계정은 사용자 매핑 목록에서 직접 지정할 수 있다.

같은 인스턴스의 파일 여러 개를 선택한 경우 한 파일의 원본 계정에 팀원을 지정하고 **같은 원본 계정 매핑 검토**를 연다. 기존 매핑을 가져올 파일, 반영할 파일과 팀원을 확인한다. 원하는 미지정 행을 선택해 매핑에 반영하고 새 미리보기를 만든다. 같은 계정의 팀원 지정이 엇갈리거나 계정 키를 확인할 수 없으면 사용자 매핑 목록에서 해당 행을 검토한다.

검토를 중단했다 이어가려면 **이관 매핑 JSON 내보내기**로 프로젝트·팀원·상태·유형·필드·시간대·원본 주소·제외 항목과 반영한 릴리스·스프린트 선택을 저장한다. 같은 내보내기 파일을 같은 인스턴스 식별값으로 분석한 다음 **실제 데이터 이관 → 이관 매핑 파일 불러오기**에서 저장한 파일을 연다. 다시 분석해서 패키지 ID가 바뀌어도 원본 파일의 SHA-256이 같으면 복원할 수 있다. 팀원 매핑과 기존 프로젝트 추가를 선택했다면 대상도 현재 워크스페이스에서 확인되어야 한다. 복원 뒤 새 미리보기를 만들고 진단과 필수 확인 항목을 다시 검토한다. 이 파일에는 원본 식별값과 내부 설정이 들어가므로 팀 내부에 보관한다.

Jira REST 응답으로 리허설할 때는 업무 응답과 별도로 저장한 댓글·작업 시간 페이지를 같은 ZIP에 넣고 `self`, `startAt`, `total`을 포함한 원본 필드를 유지한다. 이관 전에 페이지의 업무 연결과 범위 진단을 확인한다. 응답을 받은 계정의 열람 범위는 별도로 확인한다. 이전에 분석한 패키지에는 당시 분석 결과가 남으므로, 추가 페이지를 포함한 새 ZIP을 분석한다. [REST 페이지 검증](API.md#기존-도구-원본-분석)

이관을 막는 원본 객체의 진단에서 대상 항목을 선택하고 **선택한 원본 제외로 지정**을 누르면 현재 매핑에 제외가 추가된다. 새 미리보기를 만든 뒤 직접 제외한 항목과 함께 제외된 하위 기록의 건수를 검토한다. **원본 주소와 제외 항목**에서 제외를 해제할 수 있다. 이 단계의 변경은 미리보기 설정에만 적용된다.

**이관 사전 검토 JSON 내보내기**는 미리보기 만료 시각, 패키지별 SHA-256과 분석 건수, 변환·매핑·제외 집계, 진단 코드별 건수와 적용 전 확인 항목을 저장한다. 원본 파일명·주소·객체 ID·작성자·제목·본문은 보고서에서 생략한다. 파일의 `status`는 미리보기 생성 시점의 `blocked`, `review`, `ready` 중 하나다. 브라우저에서 최신 미리보기와 확인 항목을 검토한 뒤 적용한다.

**작성자 매핑 미리보기**에서 문서·댓글·문서 버전·첨부 버전·작업 시간을 패키지별로 확인한다. 매핑이 없거나 원본 작성자 정보가 없어 이관 작업자로 기록할 항목이 나타나면 사용자 매핑을 검토하고 미리보기를 다시 만든다. 변경분을 반영하는 기존 Confluence 문서는 현재 작성자를 유지한다. 사전 검토 JSON에서 작성자 항목은 상태별 건수로 확인한다.

**보존할 팀 편집이 있습니다**가 보이면 변경 검토의 **현재 값 유지** 행에서 팀 값과 Jira·Confluence 원본 값을 확인한다. 이후 더 새로운 내보내기에서도 해당 필드를 마지막 반영 값과 비교한다. 같은 적용 요청을 재시도하면 기존 영수증을 사용한다.

**원본 주소와 제외 항목**에는 패키지별로 Jira·Confluence의 기본 주소를 선택해서 입력할 수 있다. `https://jira.example.test/jira`나 `https://wiki.example.test/confluence`처럼 서비스 경로까지 포함한다. Teamspace 이관 미리보기에는 원래 Jira 업무 키로 만든 `/browse/OLD-1` 주소와 Confluence 페이지 ID로 만든 `/pages/viewpage.action?pageId=100` 주소를 견본으로 표시한다. [Atlassian의 Jira와 Confluence 주소 형식](https://support.atlassian.com/migration/docs/supported-products-and-types-of-links/)

미리보기에서 **원본 링크 생성**과 **원본 링크 미생성** 건수를 확인한다. 자동 연결은 Jira 업무와 Confluence 일반 페이지를 대상으로 한다. 기본 주소가 비어 있거나 원본 키·페이지 ID를 사용할 수 없는 새 항목은 미생성 건수에 집계한다. 적용하면 업무 상세나 문서 **연결** 탭의 **기존 도구 연결**에서 주소를 열 수 있다. 원본 정보 조회에는 별도의 서버 설정을 사용한다. [원본 조회 설정](#jiraconfluence-원본-조회)

적용 뒤에는 같은 영수증의 **이관 후속 확인**에서 제외한 원본 수와 적용 당시 경고를 읽는다. **적용 당시 경고 보기**로 권한·워크플로·서식 등 미리보기에서 확인한 상세를 연다.

개별 기록이 지정된 진단의 **보존 원본 보기**에서 본문·메타데이터·패키지 해시를 확인할 수 있다. 사전에 분석한 파일을 목록에서 삭제한 뒤에도 영수증에 남은 원문을 읽을 수 있다. 닫으면 선택한 진단의 페이지와 원본 열기 버튼으로 돌아간다. 영수증 버전이 바뀌었다는 안내가 나오면 최신 영수증에서 다시 연다.

완료한 영수증의 **이관 결과 대조 → 전체 이관 검증**에서 **이관 당시 기록과 현재 비교**를 확인한다. 새 영수증은 패키지별 원본 수량과 SHA-256을 대조하고, 이전 영수증은 당시 기록된 수량을 표시한다. **이관 티켓·문서 대조**의 상태별 건수 또는 **대상 연결 오류**를 누르면 해당 패키지의 원본 목록을 바로 연다. **검증 결과 JSON 내보내기**로 당시 결과를 저장하고, 별도 경로 복원 뒤 영수증에서 다시 검증해 비교한다. 문서 본문·매크로·작성자 매핑은 목록의 대상과 보존 원본을 열어 함께 검토한다.

**원본 주소·키 연결 오류**는 보존된 Jira 업무 ID·원래 키 또는 Confluence 페이지 ID의 인덱스가 없거나 보존 원본과 일치하지 않는 경우다. 해당 행에서 보존 원본을 열고, 현재 대상이 확인되면 그 대상도 열 수 있다. 이 오류가 있으면 `verify`는 `receiptsWithInvalidPrimaryTargets`에 해당 영수증을 집계하고 물리 백업 전에 실패한다.

같은 검증의 **이관 작성자 검증**에서 이관 때 기록한 작성자와 현재 작성자를 비교한다. 상태 건수를 누르면 **작성자 확인 목록**에서 이관 기준 팀원과 현재 작성자를 확인하고 **보존 원본 보기**로 원본을 연다. 확인 중 대상이 달라지면 전체 검증을 다시 실행한다. 작성자 기록이 없는 이전 영수증은 비교 정보가 없다고 표시한다.

**Jira 업무 관계 검증**에서 이관 당시의 관계 건수와 현재 원본으로 추적한 건수를 확인한다. 관계가 휴지통에 보관됐는지, 양쪽 업무가 남아 있는데 관계가 빠졌는지, 원본과 불일치하는지, 한쪽 업무를 확인할 수 없는지 구분한다. 누락·불일치·확인 불가의 건수를 누르면 각 관계의 보존 원본을 열 수 있다.

**업무·문서 연결 검증**은 이관 당시 연결 ID와 연결한 티켓·문서 쌍을 확인한다. **연결 누락**, **이관 당시와 불일치**, **연결 확인 불가** 건수를 누르면 해당 ID와 확인 가능한 원래 대상의 제목을 볼 수 있다. 같은 쌍을 새로 연결한 경우에도 이관 당시 연결의 누락을 표시한다. 건수만 남은 이전 영수증과 휴지통에 보존한 연결은 확인 필요로 표시한다.

**이관 티켓·문서 대조**에서 각 파일의 Jira 업무와 Confluence 현재 페이지 수를 연결됨, 휴지통, 현재 대상 없음, 원본 보관만, 이관 제외로 나눠 확인한다. 원본 보관만 된 업무나 페이지는 해당 종류와 상태로 **이관 결과 대조** 목록을 좁혀 원본을 확인한다.

Jira가 포함된 영수증의 **Jira 상태 이력**에는 보관 원본에서 확인한 변경과 현재 티켓에 표시되는 변경의 건수가 나온다. 중복·제외·접근 제한·현재 업무 연결을 확인할 수 없는 항목을 구분하고, 표시된 항목의 시각과 작성자 미확인 건수도 확인할 수 있다. 확인 건수가 0이면 이관 파일에서 변경 이력을 제공하는지 살펴본다.

Jira 기존 업무 변경분의 **상위 업무** 행에서 현재 업무와 제안 업무의 키·제목을 확인한다. REST 응답이 최상위 이동을 명시하면 제안 값에 **최상위 업무**가 표시된다. 이전 버전에서 분석한 원본은 새로 분석하고, 적용과 복원 뒤 티켓과 간트에서 변경된 계층과 팀이 직접 편집한 계층을 대조한다.

에픽 계층을 이관할 때는 Jira Software의 `Epic Link` 유형이 들어 있는 REST·검색 XML 또는 에픽 연결이 포함된 관리자 XML을 사용한다. 먼저 에픽과 하위 업무를 함께 검토한다. 이미 옮긴 에픽에 새 업무를 추가하면 같은 Jira 원본 프로젝트의 기존 연결을 확인한다. 적용한 뒤 티켓에서 스토리의 상위 에픽을 열고, 간트의 **상위·하위 업무 일정**에서 하위 작업까지 확인한다. [Jira Epic Link](https://support.atlassian.com/jira/kb/epic-name-vs-epic-link/)

확인이 필요한 항목을 선택하면 해당하는 원본 변경 그룹만 페이지로 표시한다. 업무 연결을 확인할 수 없는 그룹에는 휴지통이나 저장된 연결 대상의 상태를 표시한다. 그룹의 원본 기록을 열어 정확한 상태 변경과 업무 식별자를 확인한다. 조회 중 업무를 복원하거나 목록이 달라지면 최신 목록을 다시 불러온다.

Confluence 변경분 리허설에서는 문서의 **라벨** 행에서 현재 목록과 반영할 목록을 비교한다. 원본에서 전체 목록을 확인할 수 없으면 기존 라벨을 유지한다. 같은 페이지 버전의 목록을 반영할 때는 원본 내보내기 순서를 확인한다. 라벨 목록 근거는 패키지를 분석할 때 기록하므로 이전 분석 자료는 새 리허설에서 다시 분석한다.

수동으로 정렬한 Confluence 형제 페이지는 미리보기의 **원본 순서를 적용할 문서 그룹**과 **기본 순서를 사용할 문서 그룹**을 확인한 뒤 문서 트리에서 원본과 대조한다. 최상위와 하위 문서의 실제 순서는 `verify` 보고서의 워크스페이스 해시로 복원본과 비교한다.

**상위 문서** 행은 현재 경로와 이관 제안 위치를 보여 준다. 함께 반영할 이동은 제안 경로에 포함된다. 최상위로 옮기려면 XML에서 해당 위치가 명시돼 있어야 한다. 이전 버전에서 분석한 파일은 상위 문서 검토 전에 다시 분석한다. 적용과 복원 뒤 문서 트리에서 변경된 위치와 팀에서 옮긴 위치를 대조한다.

Confluence 체크리스트가 있는 문서를 적용한 뒤, 항목 순서와 완료 여부, 담당자 표시와 기한 텍스트를 원본과 대조한다. 이전 이관에서 원문 코드 블록으로 저장된 문서는 **기존 Confluence 문서 변경분 반영**으로 같은 원본 버전을 다시 검토할 수 있다. 저장된 코드 블록이 보관 원본과 일치하고 본문을 변환할 수 있으면, 미리보기의 **본문** 행과 확인 항목에 복구가 표시된다.

Confluence 문장 댓글이 있는 ZIP은 이전 분석 자료를 쓰는 경우 원본 바이트로 다시 분석한다. 미리보기와 적용 영수증의 **원문 위치를 연결한 문장 댓글**과 **일반 댓글로 옮긴 위치 미확인 댓글**을 확인한다. 문서의 댓글에서 **원문 저장본 열기**를 눌러 반복 문장 중 원본 표식이 붙었던 위치와 서식을 대조한다. 같은 ZIP에 본문이 빠져 있거나 현재 팀 편집과 일치하지 않는 댓글은 일반 댓글에서 확인할 수 있다. 이미 이관한 원본 댓글은 이어서 적용할 때 기존 댓글을 사용한다.

같은 화면에서 **문장 댓글에 연결한 답글**과 **일반 댓글로 옮긴 답글**을 확인한다. 이전에 분석한 ZIP의 답글 관계도 원본 바이트로 다시 분석한다. 처음 이관하거나 기존 댓글에 과거 답글을 추가한 뒤, 답글 주소가 올바른 대화를 열고 상위 댓글의 해결 상태가 유지되는지 확인한다.

JQL이 들어 있는 Jira 목록 매크로의 **JIRA_LIST_REVIEW** 진단은 문서에서 대상 프로젝트와 검색 결과를 확인하라는 뜻이다. 문서를 적용한 뒤 보관된 매크로 코드 블록 안에 커서를 두면, Jira 이관 기록을 사용하는 공유 보기로 변환할 수 있다. 선택한 블록을 교체하기 전에 원본 검색과 Teamspace 업무를 비교한다. [문서의 Jira 목록 복원](../README.md#confluence-문서의-jira-목록-복원)

브라우저 검토를 마치고 `review`를 `Ctrl+C`로 종료한 뒤 실행한다.

```bash
npm run pilot:rehearsal -- verify /absolute/path/rehearsal
```

`verify`는 분석 때 보관한 패키지 파일의 SHA-256을 다시 계산하고, 이관 영수증의 패키지 범위와 전체 원본·첨부 검증 결과를 확인한다. 검사에 사용한 파일럿을 종료한 뒤 물리 백업을 만들고, 별도 경로에 복원해 영수증과 업무·문서·계획 데이터의 해시를 다시 비교한다. 영수증에 연결된 댓글, 문서 이력, 작업 기록, 활성 업무 관계와 티켓에 표시된 Jira 상태 이력도 건수와 SHA-256을 대조한다. 건수가 같아도 대상 내용이 달라지면 보고서의 `changedReceiptIds`에 해당 영수증이 기록된다.

영수증의 `primaryRecords`에서 준비 단계에 분석한 Jira 업무·Confluence 현재 페이지 수(`records.expected`)와 영수증에서 대조한 수(`records.observed`)를 종류별로 확인한다. 두 수가 다르거나 대상 연결에 오류가 있으면 종료 코드 `1`을 반환한다. 원본 보관만 된 업무·페이지가 있고 다른 검증 실패가 없으면 종료 코드 `2`로 검토를 남긴다. 물리 복원 후 연결 상태와 `dispositionSha256`도 비교한다. 이 항목에는 원본 키나 제목이 들어가지 않는다.

`primaryRecords[].hierarchy`에서 Jira 업무와 Confluence 페이지의 직접 상위 연결을 대조한다. 변경분을 추가로 적용한 대상에는 마지막으로 적용한 상위 항목을 기준으로 쓴다. 현재 연결이 다르거나 적용 근거를 확인할 수 없으면 종료 코드 `2`로 검토를 남긴다. 저장한 상위 항목이 대상 데이터와 다르거나 연결할 수 없는 상위 항목을 가리키면 종료 코드 `1`을 반환한다. 브라우저의 **이관 티켓·문서 대조**에서 해당 건수를 눌러 검토할 원본과 현재 대상을 연다. 물리 복원 뒤 패키지별 건수와 해시를 대조한다.

연결한 Confluence 검토 파일이 있으면 검증 보고서에 ZIP·검토 파일 해시와 사유별 집계를 기록한다. 패키지를 적용한 영수증에서는 검토 페이지를 제외, 문서 연결 기록, 원본 보관만, 영수증 원본에 없음으로 집계하고 복원본의 건수와 해시를 대조한다. 명시적 제외와 상위 페이지로 인해 함께 제외된 항목을 모두 포함한다. 형식 3의 ZIP별 합산 범위는 `confluenceReviewCoverage`에서 확인한다. 보고서는 페이지 ID를 생략하고 복원 뒤 같은 ZIP과 검토 파일에서 건수를 다시 계산한다. 읽기 제한 여부를 확인하지 못한 현재 페이지가 있는 Confluence 패키지는 `confluencePackagesWithoutFullPageCoverage`에 집계한다. 이 값이 1 이상이거나 검토 파일 상태가 `needs-review`이면 복원본이 일치해도 종료 코드 `2`로 남는다. 무결성 실패는 종료 코드 `1`로 보고한다.

영수증에서 읽기 제한이 확인된 페이지의 문서 연결을 찾으면 같은 인스턴스의 다른 ZIP으로 적용한 경우에도 종료 코드 `1`을 반환한다. `liveRestrictedCounts`에서 검토 파일별 처리 건수를, `receiptsWithLiveRestrictedConfluenceDocuments`에서 해당 문서가 연결된 영수증 수를 확인한다.

매 실행마다 `verification-*/report.json`에 결과를 남긴다. 원본 검사를 통과하고 적용 영수증이 있으면 해당 디렉터리에 물리 `backup/`과 `restored/`도 보관한다. 보고서는 건수, 해시, 내부 ID를 기록하며, 워크스페이스와 백업에는 원본과 첨부 바이트가 들어 있다.

새로 준비한 리허설은 준비 기록과 Confluence 검토 파일을 물리 백업에 포함한다. `verify`는 복원본에서 기록을 다시 읽어 원본 준비 기록의 SHA-256과 대조한 뒤 이관 증거를 비교한다. 원래 리허설이 없어도 `review`에 복원한 워크스페이스를 직접 지정할 수 있다. 두 경로 모두 같은 ZIP과 검토 근거를 사용한다.

```bash
npm run pilot:rehearsal -- review /absolute/path/rehearsal/verification-XXXXXX/restored
```

별도 위치에 보관한 백업은 `pilot:restore`로 복원한 뒤 그 경로를 `review`에 지정한다. 복원한 워크스페이스를 직접 `verify`하면 보고서는 워크스페이스 바깥의 형제 디렉터리에 저장된다. 이전 형식의 리허설은 `stage.json`과 검토 파일이 있는 기존 상위 디렉터리를 `review` 또는 `verify`에 지정한다. 그때 만들어 둔 워크스페이스 전용 백업에는 준비 기록과 검토 파일이 들어 있지 않다.

이관 제외는 팀 업무와 문서를 생성할 범위에 적용한다. 리허설의 보존 원본과 전체 백업에는 제외한 객체의 내용도 들어갈 수 있다. 팀에 제공할 워크스페이스에는 팀에서 열람해도 되는 내보내기 파일을 사용한다.

종료 코드 `0`은 자동 대조 통과, `2`는 적용 대기·원본 제외·미연결 첨부·적용 영수증 경고 또는 이전 영수증의 진단 부재 등 검토 필요, `1`은 파일·영수증 불일치 또는 실행 실패다. 권한 범위나 변환 방식에 대한 적용 당시의 경고는 복원본이 일치해도 `2`로 기록된다. 상태 이력의 접근 제한, 업무 연결·시각·작성자 미확인은 `receiptsWithJiraHistoryReview`에 집계한다. 보고서의 `source.evidence.checks`에는 `receiptsWithWarnings`와 `receiptsWithoutNotices`도 들어 있다. `source.evidence.receipts`에서 대상 영수증 ID, 진단 코드별 건수, `jiraStatusHistory` 건수와 해시를 확인한다. `npm run test:pilot:rehearsal`은 합성 Jira·Confluence 패키지로 이 절차를 재현한다.

작성자 검증은 이관 작업자로 대체된 항목, 확인할 수 없는 대상, 작성자 비교 정보가 없는 이전 영수증을 검토 필요로 기록한다. 실제 작성자나 연결 대상의 불일치가 확인되면 실패로 기록한다. 오프라인 보고서는 패키지별 건수와 복원 전후 비교에 쓸 해시를 저장한다.

`jiraRelationProjection`은 Jira 업무 관계의 현재·휴지통 상태를 이관 원본과 대조한다. 누락·불일치 또는 당시 건수를 초과하는 추적 결과는 `receiptsWithJiraRelationFailures`에 집계하고 종료 코드 `1`을 반환한다. 휴지통 보관·확인 불가·기존 영수증의 추적 근거 부족은 `receiptsWithJiraRelationReview`에 집계한다. 오프라인 보고서는 건수와 해시를 저장하며, 누락이 있으면 복원용 백업을 만들기 전에 실패를 기록한다.

`resourceLinkProjection`은 티켓·문서 연결의 집계와 검증 SHA-256을 기록한다. 누락과 불일치는 `receiptsWithResourceLinkFailures`에 집계하고 복원용 백업 전에 종료 코드 `1`을 반환한다. 건수로만 대조할 수 있는 이전 영수증, 휴지통에 보관한 연결, 확인할 수 없는 대상은 `receiptsWithResourceLinkReview`에 집계한다. 보고서는 개별 연결 ID와 티켓·문서 제목을 생략한다.

## 합성 이관 규모 검증

```bash
npm run test:pilot:rehearsal:scale
```

이 검사는 임시 디렉터리에서 Jira 티켓 1,200건, 업무 관계 1,199건, Confluence 페이지 300건, 첨부파일 24건을 생성한다. 두 ZIP의 합계는 약 48MiB다. 오프라인 원본 분석과 매핑·적용, 별도 물리 복원을 실행해 문서 계층과 Jira 참조 300건, 형제 그룹 149개의 원본 순서를 대조한다. 이관 직후와 복원 후에 모든 첨부파일을 실제 API로 내려받아 원래 해시와 비교한다. 검증 보고서에는 Jira 설명·댓글의 평문 변환과 원본 권한·워크플로 규칙 차이가 검토 대상으로 남는다.

## 20명 동시 사용 리허설

```bash
npm run test:pilot:team
TEAMSPACE_PILOT_TEAM_SECONDS=120 npm run test:pilot:team
```

이 명령은 OpenSSL로 임시 인증서를 만들고 루프백 HTTPS 프록시 뒤에 별도 파일럿을 띄운다. 먼저 합성 Jira 관리자 백업과 Confluence 공간 ZIP을 같은 프로젝트에 이관한다. 인증한 브라우저가 Confluence 문서에서 연결된 티켓을 열고 원래 Jira 키로 같은 티켓을 찾는지 확인한다. Chromium 컨텍스트 20개에서 각각 팀 접속 폼에 로그인해 서로 다른 세션 쿠키와 같은 주소의 WSS 연결을 확인한다. 모두 이관한 문서를 동시에 편집하며, 각 편집이 서버에 정확히 한 번 저장되어 모든 브라우저에 보이고 티켓 참조가 유지되는지 검사한다.

공동 편집 중 이관한 티켓의 상태와 일정을 변경한다. 이 티켓을 2근무일 이동하고 충돌을 확인한 뒤 후행 업무를 자동으로 재배치한다. 프로젝트와 팀의 작업량, 저장 보기와 연결 문서, 간트 화면의 변경 날짜와 의존성을 확인한다.

두 팀원이 각각 로그인한 상태에서 같은 업무를 포함한 일정 변경을 검토한다. 한 팀원이 시작일과 종료일을 먼저 저장하면 다른 팀원의 기존 두 건 일괄 적용이 모두 보류된다. 최신 일정에서 목표 마감일을 다시 검토하고 적용한 뒤, 두 팀원의 날짜와 변경 이력을 재시작 및 별도 복원본에서 대조한다.

같은 HTTPS 주소로 합성 GitLab 파이프라인의 서명된 웹훅을 보낸다. 원래 Jira 키만 담긴 이벤트가 이관한 업무에 연결되는지 확인한다. 키가 빠진 후속 이벤트로 기존 연결을 갱신한 뒤, 별도 성공 이벤트와 중복 전송을 보내 `진행 중`에서 `검토`로 이동한 기록이 한 건인지 확인한다. 티켓 상세에서 두 파이프라인과 원래 Jira 키를 확인하고, 재시작과 물리 복원 뒤 연동 설정·연결·수신·자동 전이 기록을 비교한다.

연결을 끊고 편집한 내용을 같은 편집 세대로 재접속해 합친다. 저장본 복구로 세대가 바뀐 경우에는 이전 편집을 사본으로 저장하고 최신 문서에서 다시 편집한다. 파일럿 재시작과 별도 경로의 물리 복원 뒤에는 검사 도구의 이전 접속 세션이 거절되는지 확인한다. 새로 접속해 공동 편집 상태·복구 사본·업무 일정·저장 보기와 이관 영수증, 원본 ZIP 해시, 원본 작업 시간, 첨부파일 네 건의 해시와 다운로드 바이트를 비교한다. 기본 동시 사용 검사 시간은 75초이고 `TEAMSPACE_PILOT_TEAM_SECONDS`에 30~1,800초의 정수를 지정할 수 있다. 브라우저 시작, 오프라인 복구와 물리 복원에는 시간이 추가된다.
