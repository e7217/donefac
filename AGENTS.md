# Teamspace 개발 규칙

## 제품 목표

Jira·Confluence의 팀 업무를 대체하고 Plane·Docmost의 사용 방식을 참고하는 독립 제품이다. 초기 사용자는 20명 이하이다. 복잡한 보안, SSO, 기업용 계정 체계는 현재 범위에서 제외한다. 기존 운영 서비스나 데이터를 개발용으로 변경하지 않는다.

## 소스와 데이터

- `shared/types.ts`가 웹/API의 공통 타입 계약이다.
- 업무·문서·관계는 서버의 영속 저장소가 원본이다. 브라우저 저장소는 보기 설정과 미저장 초안 보관에만 사용한다.
- 변경은 버전 충돌을 검사하고 미저장 내용을 조용히 버리지 않는다.
- `data/`, 연결 토큰, 암호화 키, 브라우저 검사 결과는 Git에 포함하지 않는다.
- 구현 범위와 남은 작업은 `docs/PLAN.md`, `docs/STATUS.md`에 실제 상태대로 기록한다. 첫 파일럿을 전체 제품 완료로 재정의하지 않는다.

## 화면과 디자인 시스템

- 색은 `app/tokens.css`의 의미 토큰(`--bg-*`, `--fg-*`, `--border-*`, `--brand*`, 상태 `--danger|warning|success|info*`, 범주 `--chart-1~8`)만 사용한다. 글자 크기·굵기·모서리·그림자는 `app/globals.css`의 `@theme` 토큰(`--text-*`, `--font-weight-*`, `--radius-*`, `--shadow-*`)을 사용한다. 기능 CSS에 hex·rgb·px 글자 크기를 새로 쓰지 않는다. 업무·팀원·프로젝트 색처럼 데이터로 저장되는 색은 예외다.
- 새 화면 요소는 Tailwind 유틸리티와 `src/components/ui`의 shadcn 컴포넌트로 만든다. Tailwind 기본 색 팔레트는 비활성화되어 의미 색 유틸리티(`bg-surface-1`, `text-fg-secondary`, `border-border-subtle`, `bg-primary` 등)만 쓸 수 있다. 기존 기능 CSS는 레이어 밖에 있어 유틸리티보다 우선하므로 한 요소에서 같은 속성을 섞지 않는다.
- 메뉴는 `src/components/navigation/nav-groups.ts`의 묶음(팀 개요·업무·사이클·문서)과 탭으로 관리한다. 새 화면은 사이드바 항목을 늘리기보다 기존 묶음의 탭이나 더보기에 넣는다. 해시 주소는 바꾸지 않는다.
- 워크스페이스 설정은 `src/features/workspace-settings-sections.ts`의 섹션에 카드를 추가한다. 섹션은 숨겨도 마운트를 유지한다.


변경에 맞춰 `npm test`, `npm run typecheck`, `npm run build`와 필요한 브라우저 시나리오를 실행한다. 기존에 통과한 검사는 관련 변경·실패가 있을 때 반복한다. 브라우저 검사는 고유한 합성 데이터를 만들고 정리한다. 동시에 실행하는 Playwright 검사는 서로 다른 출력 디렉터리를 사용한다.

외부 GitLab 검사는 기본적으로 로컬 모의 서버를 사용한다. 실제 연결은 사용자가 설정한 주소와 자격 증명으로만 수행한다.
