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

HTTPS 리버스 프록시 배포에서는 공개 주소를 명시적으로 전달하여 세션과 진입 Cookie에 `Secure` 속성을 설정합니다.

```powershell
pnpm start -- --data-dir .\data --public-url https://hub.example.com
```

상위 `CarMediaHub` 디렉터리에서 Docker를 사용합니다.

```powershell
docker compose -f carmediahub/compose.yaml up --build
```

Compose 포트는 의도적으로 `127.0.0.1`에만 바인딩되며 Core 명령은 Secure Cookie를 요구합니다. 운영자가 관리하는 리버스 프록시에서 TLS를 종료하고 공개 주소를 노출하세요. 다른 프로덕션 실행 방식에서는 `--public-url https://hub.example.com` 또는 `--cookie-secure`를 전달합니다.
