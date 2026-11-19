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

이 명령은 파일럿을 빌드하고 임시 데이터와 루프백 포트에서 실행한다. Chromium 브라우저에서 간트·문서·첨부, 두 작업자의 공동 편집을 확인한다. 파일럿 실행 중 백업 거절, 종료 후 백업·복원, 변조 검출, 복원본의 업무·문서·이관 원본·첨부 읽기와 복원된 GitLab 토큰을 사용하는 모의 서버 조회를 검증한다. 검사에 사용한 임시 데이터는 종료 후 정리한다.
