# CarMediaHub Core

CarMediaHub Core는 플랫폼에 필요한 자체 호스팅 런타임, Agent, 관리 화면, 게이트웨이와 capability 서비스를 제공합니다.

언어: [English](readme.md) · [简体中文](readme_zh.md) · 한국어

플러그인 계약, 배포와 통합 안내는 SDK 및 문서 저장소를 참고하세요.

## 로컬 개발

```powershell
pnpm install
pnpm test
pnpm build
pnpm start -- --data-dir .\data
```

Core는 명시적 데이터 디렉터리를 사용하며 런타임 환경 변수나 시스템 `PATH`로 암시적으로 컴포넌트를 찾지 않습니다.

배포 상태 probe는 `/health/live`, `/health/ready`, `/health/diagnostic`에서 제공합니다. 경로, URL, 자격 증명 또는 사용자 콘텐츠를 노출하지 않고 제한된 상태와 집계 수만 반환합니다. 로컬 배포가 초기화되기 전에는 readiness가 HTTP 503을 반환합니다.

HTTPS 리버스 프록시 배포에서는 공개 주소를 명시적으로 전달하여 세션과 진입 Cookie에 `Secure` 속성을 설정합니다.

```powershell
pnpm start -- --data-dir .\data --public-url https://hub.example.com
```

상위 `CarMediaHub` 디렉터리에서 Docker를 사용합니다.

```powershell
docker compose -f carmediahub/compose.yaml up --build
```

현재 Compose 프로필은 Core와 관리되는 SQLite 데이터 볼륨만 실행합니다. PostgreSQL은 명시적 Core adapter로 개발 중이며 아직 이 Compose 파일에서 시작하거나 요구하지 않습니다.

Native 배포는 `config/core.json` JSON 구성 파일을 사용하거나 `--config <경로>`로 파일을 지정할 수 있습니다. 시작점으로 `config/core.example.json`을 복사하십시오. 파일에는 `dataDir`, `host`, `port`, `publicUrl`, `cookieSecure`만 허용됩니다. 명령줄 옵션이 파일 값을 덮어쓰며, 알 수 없는 필드나 잘못된 값이 있으면 시작이 중단됩니다. 비밀번호, 쿠키, 토큰 또는 데이터베이스 자격 증명을 이 파일에 넣지 마십시오. 기본 파일은 없어도 되지만 명시한 `--config` 파일은 반드시 존재해야 합니다.

Docker 이미지는 저장소에 포함된 관리 대상 컴포넌트 카탈로그, 스키마 및 예제 구성만 복사합니다. 로컬 `config/core.json`은 이미지에 포함되지 않으며, 배포 구성은 명시적 실행 인자나 마운트한 배포 파일로 제공해야 합니다.

Compose 포트는 의도적으로 `127.0.0.1`에만 바인딩되며 Core 명령은 Secure Cookie를 요구합니다. 운영자가 관리하는 리버스 프록시에서 TLS를 종료하고 공개 주소를 노출하세요. 다른 프로덕션 실행 방식에서는 `--public-url https://hub.example.com` 또는 `--cookie-secure`를 전달합니다.

오프라인 백업과 복구는 명시적인 명령으로 실행합니다. 스냅샷을 만들기 전에 Core를 중지하고, 복구는 새로운 빈 디렉터리에만 수행합니다.

```powershell
pnpm backup backup --data-dir .\data --output .\snapshots\cmh-01
pnpm backup restore --snapshot .\snapshots\cmh-01 --data-dir .\restored-data
```
