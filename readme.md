# CarMediaHub Core

CarMediaHub Core provides the self-hosted runtime, Agent, administration surface, gateway and capability services for the platform.

Language: English · [简体中文](readme_zh.md) · [한국어](readme_ko.md)

See the SDK and documentation repositories for plugin contracts, deployment and integration guidance.

## Development

This repository currently contains the v0 Core foundation: an explicit data directory, SQLite state, local bootstrap user, cookie session, application registry, revocable entry keys, managed-component records and service bindings.

```powershell
pnpm install
pnpm test
pnpm build
pnpm start -- --data-dir .\data
```

Docker development deployment (from the parent `CarMediaHub` directory):

```powershell
docker compose -f carmediahub/compose.yaml up --build
```

The Compose port is intentionally bound to `127.0.0.1` and its Core command requires Secure cookies. Terminate TLS and expose a public address through an operator-managed reverse proxy. For another production launcher, pass either `--public-url https://hub.example.com` or `--cookie-secure`.

The Core does not require runtime environment variables or executables discovered through `PATH`. Components such as AList, rclone and FFmpeg are registered through versioned managed-component metadata and explicit service bindings. Their full packaged adapters are delivered in later milestones.

For an HTTPS reverse-proxy deployment, pass the public address explicitly so session and entry cookies receive the `Secure` attribute:

```powershell
pnpm start -- --data-dir .\data --public-url https://hub.example.com
```
