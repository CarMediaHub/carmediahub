# CarMediaHub Core

CarMediaHub Core는 플랫폼에 필요한 자체 호스팅 런타임, Agent, 관리 화면, 게이트웨이와 capability 서비스를 제공합니다.

언어: [English](readme.md) · [简体中文](readme_zh.md) · 한국어

플러그인 계약, 배포와 통합 안내는 SDK 및 문서 저장소를 참고하세요.

## 로컬 개발

```powershell
pnpm install
pnpm verify
pnpm start -- --data-dir .\data
```

`pnpm verify`는 로컬 배포 게이트, 관리 화면 타입 검사와 운영 빌드, Core 테스트, 시작 smoke, 업그레이드 검사와 Native bundle/서비스 사양 테스트를 실행합니다. Docker와 PostgreSQL 통합은 명시적인 CI 또는 대상 환경에서 별도로 실행해야 합니다.

로컬 시작 smoke 검사를 실행합니다(임시 데이터, 초기화, liveness 및 readiness):

```text
pnpm smoke:startup
```

Core는 명시적 데이터 디렉터리를 사용하며 런타임 환경 변수나 시스템 `PATH`로 암시적으로 컴포넌트를 찾지 않습니다.

운영자가 관리하는 구성요소 릴리스를 준비할 때는 일반 바이너리를 명시적으로 staging하고 digest가 연결된 서명 전 릴리스 레코드를 생성할 수 있습니다.

```powershell
pnpm component:prepare-release -- --data-dir .\data --artifact .\downloads\ffmpeg.exe --component-id ffmpeg --artifact-id ffmpeg-7 --version 7.0.0 --platform windows-x64 --key-id 0123456789abcdef --output .\releases\ffmpeg-7.json
```

`--artifact`는 실행 파일과 함께 DLL/리소스 파일을 포함하는 디렉터리를 가리킬 수도 있습니다. 디렉터리 릴리스는 정규화된 상대 경로 트리 digest를 사용하며 링크와 특수 파일을 거부합니다. provenance를 제공하는 경우 `--source-url`과 `--license-spdx`를 함께 제공해야 합니다.

이 명령은 개인 키를 읽거나 서명하거나 설치하거나 기존 staging 아티팩트를 덮어쓰지 않습니다. Core에 제출하기 전에 운영자가 제어하는 서명 절차로 서명을 완료해야 합니다.

관리자 컴포넌트 등록 API는 메타데이터만 기록하며 등록 결과를 "검증되지 않음"으로 표시합니다. 검증되지 않은 기록은 조회하고 상태를 점검할 수 있지만 Core가 실행하거나 브라우저 엔진으로 시작하거나 관리 런타임 컴포넌트로 사용할 수 없습니다. 신뢰된 서명 검증을 통과한 릴리스만 "검증됨"으로 표시됩니다.

플러그인 데이터는 SDK의 범위가 지정된 논리 API와 버전별 마이그레이션 원장을 통해서만 접근합니다. 물리적 SQLite/PostgreSQL 구조는 Core가 관리하며 플러그인에는 데이터베이스 연결, DSN, Schema 이름 또는 SQL 채널을 제공하지 않습니다.

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

Native 배포는 `config/core.json` JSON 구성 파일을 사용하거나 `--config <경로>`로 파일을 지정할 수 있습니다. 시작점으로 `config/core.example.json`을 복사하고 편집기/설치 도구 검증에는 `config/core.schema.json`을 사용하십시오. 파일에는 `dataDir`, `host`, `port`, `publicUrl`, `cookieSecure`만 허용됩니다. 명령줄 옵션이 파일 값을 덮어쓰며, 알 수 없는 필드나 잘못된 값이 있으면 시작이 중단됩니다. 비밀번호, 쿠키, 토큰 또는 데이터베이스 자격 증명을 이 파일에 넣지 마십시오. 기본 파일은 없어도 되지만 명시한 `--config` 파일은 반드시 존재해야 합니다.

Docker 이미지는 저장소에 포함된 관리 대상 컴포넌트 카탈로그, 스키마 및 예제 구성만 복사합니다. 로컬 `config/core.json`은 이미지에 포함되지 않으며, 배포 구성은 명시적 실행 인자나 마운트한 배포 파일로 제공해야 합니다.

Compose 포트는 의도적으로 `127.0.0.1`에만 바인딩되며 Core 명령은 Secure Cookie를 요구합니다. 운영자가 관리하는 리버스 프록시에서 TLS를 종료하고 공개 주소를 노출하세요. 다른 프로덕션 실행 방식에서는 `--public-url https://hub.example.com` 또는 `--cookie-secure`를 전달합니다.

오프라인 백업과 복구는 명시적인 명령으로 실행합니다. 스냅샷을 만들기 전에 Core를 중지하고, 복구는 새로운 빈 디렉터리에만 수행합니다.

```powershell
pnpm backup backup --data-dir .\data --output .\snapshots\cmh-01
pnpm backup restore --snapshot .\snapshots\cmh-01 --data-dir .\restored-data
```

Native 번들을 변경하기 전에 명시적이고 검증된 스냅샷으로 읽기 전용 업그레이드 사전 검사를 실행하세요.

```powershell
pnpm upgrade-preflight -- --bundle-root <bundle-root> --data-dir <data-dir> --snapshot <snapshot>
```

검사는 번들 메타데이터, 데이터베이스 스키마 호환성과 스냅샷 데이터베이스가 현재 데이터와 일치하는지 확인합니다. Core를 중지하거나 스냅샷을 만들거나 번들을 설치하거나 롤백하지는 않습니다.

설치 프로그램은 같은 검사를 통과한 뒤 플랫폼별 dry-run 설치 계획을 만들 수 있습니다.

```powershell
pnpm native-install-plan -- --platform <windows|linux> --bundle-root <bundle-root> --config <config-path> --data-dir <data-dir> --node <runtime-path> --service-name <service-name> --description <description> --required-free-bytes <bytes>
```

계획에는 `sc.exe` 또는 systemd 사양과 번들/구성/데이터 디렉터리의 명시적 ACL 의도가 포함됩니다. 기본값은 관리자 권한이 아닌 서비스 계정(Windows `LocalService`, Linux `carmediahub`)이지만 계정을 만들거나 시스템 서비스를 등록하거나 배포 파일을 쓰지는 않습니다.
