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

The current Compose profile runs Core with its managed SQLite state volume. PostgreSQL support is an explicit Core adapter under development and is not started or required by this Compose file yet.

Native deployments may use a JSON configuration file at `config/core.json` (or pass `--config <path>`). Copy `config/core.example.json` as a starting point and use `config/core.schema.json` for editor/install-tool validation. The file accepts only `dataDir`, `host`, `port`, `publicUrl` and `cookieSecure`; command-line options override file values, and unknown or invalid fields stop startup. Do not put passwords, cookies, tokens or database credentials in this file. The default file is optional; an explicitly supplied `--config` path must exist.

The Docker image copies only the checked-in component catalog, schema and example configuration. A local `config/core.json` is never included in the image; provide deployment configuration through explicit runtime arguments or a mounted deployment file.

The Compose port is intentionally bound to `127.0.0.1` and its Core command requires Secure cookies. Terminate TLS and expose a public address through an operator-managed reverse proxy. For another production launcher, pass either `--public-url https://hub.example.com` or `--cookie-secure`.

The Core does not require runtime environment variables or executables discovered through `PATH`. Components such as AList, rclone and FFmpeg are registered through versioned managed-component metadata and explicit service bindings. Their full packaged adapters are delivered in later milestones.

Plugin data is exposed only through the SDK's scoped logical API and versioned migration ledger. Core owns the physical SQLite/PostgreSQL schema; plugins never receive database connections, DSNs, schema names or SQL channels.

Unauthenticated deployment probes are available at `/health/live`, `/health/ready` and `/health/diagnostic`. They return only bounded status and aggregate counts; they never expose paths, URLs, credentials or user content. Readiness returns HTTP 503 until the local deployment has been initialized.

Offline backup and restore use explicit commands. Stop Core before creating a snapshot; restore only targets a new empty directory:

```powershell
pnpm backup backup --data-dir .\data --output .\snapshots\cmh-01
pnpm backup restore --snapshot .\snapshots\cmh-01 --data-dir .\restored-data
```

Before changing a Native bundle, run the read-only upgrade preflight with an explicit, verified snapshot:

```powershell
pnpm upgrade-preflight -- --bundle-root <bundle-root> --data-dir <data-dir> --snapshot <snapshot>
```

The check validates bundle metadata, database schema compatibility and that the snapshot database matches the current data. It does not stop Core, create a snapshot, install a bundle or roll back a deployment.

An installer can generate a platform-specific dry-run plan after the same checks:

```powershell
pnpm native-install-plan -- --platform <windows|linux> --bundle-root <bundle-root> --config <config-path> --data-dir <data-dir> --node <runtime-path> --service-name <service-name> --description <description> --required-free-bytes <bytes>
```

The plan contains the `sc.exe` or systemd specification plus explicit Bundle/config/data ACL intents. It defaults to a non-administrator service identity (`LocalService` on Windows and `carmediahub` on Linux), but does not create the identity, register a service or write deployment files.

For an HTTPS reverse-proxy deployment, pass the public address explicitly so session and entry cookies receive the `Secure` attribute:

```powershell
pnpm start -- --data-dir .\data --public-url https://hub.example.com
```
