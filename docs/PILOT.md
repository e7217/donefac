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

이 명령은 파일럿을 빌드하고 임시 데이터와 루프백 포트에서 실행한다. Chromium 브라우저에서 간트·문서·첨부, 두 작업자의 공동 편집과 커서 표시·해제를 확인한다. 파일럿 실행 중 백업 거절, 종료 후 백업·복원, 변조 검출, 복원본의 업무·문서·이관 원본 읽기, 휴지통의 업무를 복원한 뒤 최초 및 최신 첨부 바이트 읽기, 팀 알림의 읽음 상태, 프로젝트 가용 시간과 팀 날짜 예외·프로젝트 간 과부하, 복원된 GitLab 토큰을 사용하는 모의 서버 조회를 검증한다. 검사에 사용한 임시 데이터는 종료 후 정리한다.

휴지통에 보낸 업무가 비운 시간을 다른 프로젝트의 업무에 배정한다. 별도 물리 복원본에서 원래 업무를 다시 살린 뒤, 새 배정은 확정된 상태로 남고 원래 배정은 재검토 상태와 기존 시각을 유지하는지 확인한다.

개별 댓글과 두 버전의 첨부를 먼저 휴지통에 보내고 상위 업무도 보관한 뒤 물리 백업을 만든다. 복원본에서 상위 업무를 되살리고 개별 항목을 이어서 복구한다. 댓글의 원래 작성 정보와 두 파일 버전의 다운로드 바이트를 비교한다.

같은 검사에서 합성 Jira 관리자 XML과 별도 첨부 경로를 담은 ZIP, Confluence 공간 XML ZIP을 신규 프로젝트에 함께 적용한다. Jira 원래 키와 작성자 매핑, 91초 작업 기록, 명시적으로 제외한 공개 제한 기록, Confluence 페이지 ID와 업무 양방향 연결을 확인한다. Jira 첨부 한 건과 Confluence 첨부 두 버전의 크기·SHA-256·다운로드 바이트를 검사한다. 별도 물리 복원본에서 원본 패키지 바이트와 전체 이관 검증 결과를 다시 비교하고, 복원한 업무의 상태 변경을 확인한다.

## 오프라인 원본 이관 리허설

별도 파일럿 데이터 경로에서 **워크스페이스 설정 → 기존 도구 원본 분석**으로 Jira·Confluence 내보내기 파일을 분석한다. **실제 데이터 이관**에서 프로젝트와 팀원·상태 매핑, 변환 미리보기, 확인 항목을 검토한 뒤 적용한다.

**원본 주소와 제외 항목**에는 패키지별로 Jira·Confluence의 기본 주소를 선택해서 입력할 수 있다. `https://jira.example.test/jira`나 `https://wiki.example.test/confluence`처럼 서비스 경로까지 포함한다. Teamspace 이관 미리보기에는 원래 Jira 업무 키로 만든 `/browse/OLD-1` 주소와 Confluence 페이지 ID로 만든 `/pages/viewpage.action?pageId=100` 주소를 견본으로 표시한다. [Atlassian의 Jira와 Confluence 주소 형식](https://support.atlassian.com/migration/docs/supported-products-and-types-of-links/)

미리보기에서 **원본 링크 생성**과 **원본 링크 미생성** 건수를 확인한다. 자동 연결은 Jira 업무와 Confluence 일반 페이지를 대상으로 한다. 기본 주소가 비어 있거나 원본 키·페이지 ID를 사용할 수 없는 새 항목은 미생성 건수에 집계한다. 적용하면 업무 상세나 문서 **연결** 탭의 **기존 도구 연결**에서 주소를 열 수 있다. 원본 정보 조회에는 별도의 서버 설정을 사용한다. [원본 조회 설정](#jiraconfluence-원본-조회)

완료한 영수증의 **이관 결과 대조 → 전체 이관 검증**에서 대상이 없는 객체, 파일 누락·불일치, 원본 보관과 의도적 제외를 확인한다. **검증 결과 JSON 내보내기**로 당시 결과를 저장하고, 별도 경로 복원 뒤 영수증에서 다시 검증해 비교한다. 문서 본문·매크로·작성자 매핑은 목록의 대상과 보존 원본을 열어 함께 검토한다.

## 20명 동시 사용 리허설

```bash
npm run test:pilot:team
TEAMSPACE_PILOT_TEAM_SECONDS=120 npm run test:pilot:team
```

이 명령은 별도의 임시 파일럿을 만들고 Chromium 브라우저 컨텍스트 20개를 서로 다른 합성 팀원으로 연결한다. 모두 같은 문서를 연 뒤 여러 차례 동시에 편집하고, 각 편집이 서버에 정확히 한 번 저장되어 모든 팀원에게 보이는지 확인한다. 공동 편집 중 티켓 상태·일정을 변경하고 프로젝트와 팀의 간트 작업량을 조회한다.

연결을 끊고 편집한 내용을 같은 편집 세대로 재접속해 합친다. 저장본 복구로 세대가 바뀐 경우에는 이전 편집을 사본으로 저장하고 최신 문서에서 다시 편집한다. 파일럿 재시작과 별도 경로의 물리 복원 뒤에 문서, Yjs 상태와 복구 사본을 비교한다. 기본 동시 사용 검사 시간은 75초이고 `TEAMSPACE_PILOT_TEAM_SECONDS`에 30~1,800초의 정수를 지정할 수 있다. 브라우저 시작, 오프라인 복구와 물리 복원에는 시간이 추가된다.
