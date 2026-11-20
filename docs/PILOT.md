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

## GitLab 웹훅 수신 확인

**개발 · GitLab → GitLab 웹훅 수신 확인**에서 저장소별 마지막 인증 수신을 확인한다. 업무 연결이 0건이어도 수신 시각과 이벤트가 표시된다. GitLab에서 이벤트를 보낸 뒤 **수신 상태 새로고침**을 누른다. 수신이 표시되지 않으면 GitLab의 **Settings → Webhooks → Edit → Recent events**에서 전송 결과를 확인할 수 있다. [GitLab 웹훅 전송 이력](https://docs.gitlab.com/user/project/integrations/webhooks/#view-webhook-request-history)

티켓 키가 없는 작업은 티켓의 **GitLab 개발 활동**에서 허용 저장소를 선택하고 기존 브랜치·커밋·MR·파이프라인 주소를 붙여 넣어 연결한다. 브랜치는 해당 브랜치의 루트 페이지 주소, 커밋은 전체 SHA가 들어간 주소를 사용한다. 연결된 브랜치는 인증된 푸시로 확인한 마지막 SHA와 삭제 상태를 표시한다.

## Jira·Confluence 원본 조회

업무 상세 또는 문서 **연결** 탭에서 **기존 도구 연결**을 사용한다. Jira는 `/browse/TEAM-17`, Confluence는 `/pages/viewpage.action?pageId=1234`, `/display/TEAM/Release+Notes`, `/spaces/TEAM/pages/1234/Release-Notes`처럼 브라우저에서 쓰는 주소를 받는다. 기존 서버의 `/jira` 또는 `/wiki` 같은 경로도 주소에 포함한다.

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

결과 디렉터리에는 `manifest.json`과 `data/`가 있다. SQLite, 첨부 바이트, 이관 분석 원본, `.credential-key`와 재시작에 필요한 복구 저널을 포함한다. SQLite 검증과 WAL 정리는 복사본에서 수행한다. 파일별 SHA-256과 크기를 기록하고 비어 있는 디렉터리도 보존한다. 전체 사본에는 연결 자격 정보와 비공개 자료가 포함되므로 백업 경로의 접근 권한을 운영 데이터와 같은 수준으로 관리한다.

## 별도 경로에 복원

아직 존재하지 않는 경로를 복원 대상으로 지정한다. CLI는 매니페스트의 파일 목록·크기·해시와 SQLite 무결성을 검사한 뒤 복원 디렉터리를 한 번에 만든다.

```bash
npm run pilot:restore -- \
  "$HOME/teamspace-pilot/backup-2026-11-19" \
  "$HOME/teamspace-pilot/restore-drill"
TEAMSPACE_DATA_DIR="$HOME/teamspace-pilot/restore-drill" \
TEAMSPACE_PILOT_PORT=5191 TEAMSPACE_PILOT_OUTBOUND=0 npm run start:pilot
```

복원 리허설은 별도 주소와 새 브라우저 프로필에서 수행한다. 물리 복원은 기존 API 키·연동 설정·공동 편집 세대도 복원한다. 실제 팀 주소로 전환할 때는 이전 브라우저의 미전송 공동 편집과 외부 웹훅 전송 대기를 확인한다. 전체 JSON 내보내기·가져오기는 별도의 데이터 이동 기능이다.

## 합성 자료로 통합 검증

검사에 사용할 Chromium을 `npx playwright install chromium`으로 설치하거나 `CHROMIUM_PATH`로 지정한다.

```bash
npm run test:pilot
```

이 명령은 파일럿을 빌드하고 임시 데이터와 루프백 포트에서 실행한다. Chromium 브라우저에서 간트·문서·첨부, 두 작업자의 공동 편집과 커서 표시·해제를 확인한다. 파일럿 실행 중 백업 거절, 종료 후 백업·복원, 변조 검출, 복원본의 업무·문서·이관 원본 읽기, 휴지통의 업무를 복원한 뒤 최초 및 최신 첨부 바이트 읽기, 팀 알림의 읽음 상태, 프로젝트 가용 시간과 팀 날짜 예외·프로젝트 간 과부하, 활성 담당자 배정 규칙과 실행 기록, 복원된 GitLab 토큰을 사용하는 모의 서버 조회를 검증한다. 검사에 사용한 임시 데이터는 종료 후 정리한다.

휴지통에 보낸 업무가 비운 시간을 다른 프로젝트의 업무에 배정한다. 별도 물리 복원본에서 원래 업무를 다시 살린 뒤, 새 배정은 확정된 상태로 남고 원래 배정은 재검토 상태와 기존 시각을 유지하는지 확인한다.

이관한 Jira 업무를 합성 GitLab MR의 원래 키로 연결하고, 티켓 키가 없는 브랜치와 커밋을 주소로 추가한다. 별도 물리 복원본에서 저장소의 Jira 원본 매핑과 링크를 대조한다. 같은 MR을 다시 읽어도 중복되지 않고, 복원한 브랜치는 인증된 푸시로 갱신되는지 검사한다.

합성 티켓을 착수 상태로 전환할 때 표시 조건에 따라 필수 확인 항목을 요청한다. 해당 값을 넣으면 상태와 담당자 자동 배정을 함께 적용한다. 물리 복원 뒤에도 양식 설정과 입력값을 읽고 동일한 필수 규칙을 확인한다.

같은 요청 ID로 티켓 생성 요청을 다시 보낸 뒤 업무·생성 이력·담당 알림이 각각 한 건인지 확인한다. 별도 물리 복원본에서 해당 업무가 휴지통에 있을 때 재시도는 충돌을 반환하고, 업무를 되살린 뒤에는 원래 ID와 번호를 반환하는지 대조한다.

개별 댓글과 두 버전의 첨부를 먼저 휴지통에 보내고 상위 업무도 보관한 뒤 물리 백업을 만든다. 복원본에서 상위 업무를 되살리고 개별 항목을 이어서 복구한다. 댓글의 원래 작성 정보와 두 파일 버전의 다운로드 바이트를 비교한다.

같은 검사에서 합성 Jira 관리자 XML과 별도 첨부 경로를 담은 ZIP, Confluence 공간 XML ZIP을 신규 프로젝트에 함께 적용한다. Jira 원래 키와 작성자 매핑, 91초 작업 기록, 명시적으로 제외한 공개 제한 기록, Confluence 페이지 ID와 업무 양방향 연결을 확인한다. 서로 다른 두 공간에 제목이 같은 문서를 두고 상대 참조가 원본과 같은 공간의 문서를 여는지 확인한다. 다른 공간의 동명 첨부를 가리키는 링크와 전체 첨부 버전의 크기·SHA-256·다운로드 바이트도 대조한다. 별도 물리 복원본에서 원본 패키지 바이트와 전체 이관 검증 결과를 다시 비교하고, 복원한 업무의 상태 변경을 확인한다.

## 오프라인 원본 이관 리허설

리허설 명령은 지정한 내보내기 파일을 전용 워크스페이스에 분석한다. Jira 관리자 XML과 첨부파일을 담은 ZIP, Confluence 공간 XML ZIP 등 [지원 형식](API.md#기존-도구-원본-분석)에 해당하는 파일을 매니페스트에 적는다. `file`은 절대 경로나 매니페스트 기준 상대 경로다. 같은 원본 시스템에서 받은 후속 파일에는 같은 `instanceKey`를 사용한다.

```json
{
  "packages": [
    { "file": "jira-project.zip", "product": "jira", "instanceKey": "team-jira" },
    { "file": "confluence-space.zip", "product": "confluence", "instanceKey": "team-wiki" }
  ]
}
```

```bash
npm run build:pilot
npm run pilot:rehearsal -- stage /absolute/path/manifest.json /absolute/path/rehearsal
npm run pilot:rehearsal -- review /absolute/path/rehearsal
```

`stage`는 새 디렉터리에 `workspace/`와 `stage.json`을 만든다. 분석은 한 파일 64MiB, 최대 20개와 합계 512MiB까지 지원한다. `review`가 출력한 루프백 주소에서 **워크스페이스 설정 → 실제 데이터 이관**을 열고, 프로젝트·팀원·상태 매핑과 미리보기의 확인 항목을 검토한 뒤 적용한다. 특정 객체의 경고나 오류는 **이관 검토 진단 → 원본 상세 보기**에서 해당 패키지의 본문·메타데이터·관계와 대조한다. 리허설 파일럿은 루프백에만 접속을 받고 외부 연동 자격 정보 없이 실행한다.

이관을 막는 원본 객체의 진단에서 대상 항목을 선택하고 **선택한 원본 제외로 지정**을 누르면 현재 매핑에 제외가 추가된다. 새 미리보기를 만든 뒤 직접 제외한 항목과 함께 제외된 하위 기록의 건수를 검토한다. **원본 주소와 제외 항목**에서 제외를 해제할 수 있다. 이 단계의 변경은 미리보기 설정에만 적용된다.

**이관 사전 검토 JSON 내보내기**는 미리보기 만료 시각, 패키지별 SHA-256과 분석 건수, 변환·매핑·제외 집계, 진단 코드별 건수와 적용 전 확인 항목을 저장한다. 원본 파일명·주소·객체 ID·작성자·제목·본문은 보고서에서 생략한다. 파일의 `status`는 미리보기 생성 시점의 `blocked`, `review`, `ready` 중 하나다. 브라우저에서 최신 미리보기와 확인 항목을 검토한 뒤 적용한다.

**원본 주소와 제외 항목**에는 패키지별로 Jira·Confluence의 기본 주소를 선택해서 입력할 수 있다. `https://jira.example.test/jira`나 `https://wiki.example.test/confluence`처럼 서비스 경로까지 포함한다. Teamspace 이관 미리보기에는 원래 Jira 업무 키로 만든 `/browse/OLD-1` 주소와 Confluence 페이지 ID로 만든 `/pages/viewpage.action?pageId=100` 주소를 견본으로 표시한다. [Atlassian의 Jira와 Confluence 주소 형식](https://support.atlassian.com/migration/docs/supported-products-and-types-of-links/)

미리보기에서 **원본 링크 생성**과 **원본 링크 미생성** 건수를 확인한다. 자동 연결은 Jira 업무와 Confluence 일반 페이지를 대상으로 한다. 기본 주소가 비어 있거나 원본 키·페이지 ID를 사용할 수 없는 새 항목은 미생성 건수에 집계한다. 적용하면 업무 상세나 문서 **연결** 탭의 **기존 도구 연결**에서 주소를 열 수 있다. 원본 정보 조회에는 별도의 서버 설정을 사용한다. [원본 조회 설정](#jiraconfluence-원본-조회)

완료한 영수증의 **이관 결과 대조 → 전체 이관 검증**에서 **이관 당시 기록과 현재 비교**를 확인한다. 새 영수증은 패키지별 원본 수량과 SHA-256을 대조하고, 이전 영수증은 당시 기록된 수량을 표시한다. 이어서 대상이 없는 객체, 파일 누락·불일치, 원본 보관과 의도적 제외를 확인한다. **검증 결과 JSON 내보내기**로 당시 결과를 저장하고, 별도 경로 복원 뒤 영수증에서 다시 검증해 비교한다. 문서 본문·매크로·작성자 매핑은 목록의 대상과 보존 원본을 열어 함께 검토한다.

Jira가 포함된 영수증의 **Jira 상태 이력**에는 보관 원본에서 확인한 변경과 현재 티켓에 표시되는 변경의 건수가 나온다. 중복·제외·접근 제한·현재 업무 연결을 확인할 수 없는 항목을 구분하고, 표시된 항목의 시각과 작성자 미확인 건수도 확인할 수 있다. 확인 건수가 0이면 이관 파일에서 변경 이력을 제공하는지 살펴본다.

브라우저 검토를 마치고 `review`를 `Ctrl+C`로 종료한 뒤 실행한다.

```bash
npm run pilot:rehearsal -- verify /absolute/path/rehearsal
```

`verify`는 분석 때 보관한 패키지 파일의 SHA-256을 다시 계산하고, 이관 영수증의 패키지 범위와 전체 원본·첨부 검증 결과를 확인한다. 검사에 사용한 파일럿을 종료한 뒤 물리 백업을 만들고, 별도 경로에 복원해 영수증과 업무·문서·계획 데이터의 해시를 다시 비교한다. 영수증에 연결된 댓글, 문서 이력, 작업 기록, 활성 업무 관계와 티켓에 표시된 Jira 상태 이력도 건수와 SHA-256을 대조한다. 건수가 같아도 대상 내용이 달라지면 보고서의 `changedReceiptIds`에 해당 영수증이 기록된다.

매 실행마다 `verification-*/report.json`에 결과를 남긴다. 원본 검사를 통과하고 적용 영수증이 있으면 해당 디렉터리에 물리 `backup/`과 `restored/`도 보관한다. 보고서는 건수, 해시, 내부 ID를 기록하며, 워크스페이스와 백업에는 원본과 첨부 바이트가 들어 있다.

종료 코드 `0`은 자동 대조 통과, `2`는 적용 대기·원본 제외·미연결 첨부·적용 영수증 경고 또는 이전 영수증의 진단 부재 등 검토 필요, `1`은 파일·영수증 불일치 또는 실행 실패다. 권한 범위나 변환 방식에 대한 적용 당시의 경고는 복원본이 일치해도 `2`로 기록된다. 상태 이력의 접근 제한, 업무 연결·시각·작성자 미확인은 `receiptsWithJiraHistoryReview`에 집계한다. 보고서의 `source.evidence.checks`에는 `receiptsWithWarnings`와 `receiptsWithoutNotices`도 들어 있다. `source.evidence.receipts`에서 대상 영수증 ID, 진단 코드별 건수, `jiraStatusHistory` 건수와 해시를 확인한다. `npm run test:pilot:rehearsal`은 합성 Jira·Confluence 패키지로 이 절차를 재현한다.

## 20명 동시 사용 리허설

```bash
npm run test:pilot:team
TEAMSPACE_PILOT_TEAM_SECONDS=120 npm run test:pilot:team
```

이 명령은 별도의 임시 파일럿을 만들고 Chromium 브라우저 컨텍스트 20개를 서로 다른 합성 팀원으로 연결한다. 모두 같은 문서를 연 뒤 여러 차례 동시에 편집하고, 각 편집이 서버에 정확히 한 번 저장되어 모든 팀원에게 보이는지 확인한다. 공동 편집 중 티켓 상태·일정을 변경하고 프로젝트와 팀의 간트 작업량을 조회한다.

연결을 끊고 편집한 내용을 같은 편집 세대로 재접속해 합친다. 저장본 복구로 세대가 바뀐 경우에는 이전 편집을 사본으로 저장하고 최신 문서에서 다시 편집한다. 파일럿 재시작과 별도 경로의 물리 복원 뒤에 문서, Yjs 상태와 복구 사본을 비교한다. 기본 동시 사용 검사 시간은 75초이고 `TEAMSPACE_PILOT_TEAM_SECONDS`에 30~1,800초의 정수를 지정할 수 있다. 브라우저 시작, 오프라인 복구와 물리 복원에는 시간이 추가된다.
