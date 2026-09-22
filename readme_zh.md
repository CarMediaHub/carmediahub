# CarMediaHub Core

CarMediaHub Core 提供平台所需的自托管运行时、Agent、管理端、网关和能力服务。

语言：[English](readme.md) · 简体中文 · [한국어](readme_ko.md)

插件契约、部署和集成说明请参阅 SDK 与文档仓库。

## 本地开发

```powershell
pnpm install
pnpm test
pnpm build
pnpm start -- --data-dir .\data
```

Core 使用显式数据目录，不要求运行时环境变量或通过系统 PATH 隐式发现组件。

Native 部署可以使用 `config/core.json` JSON 配置文件，也可以通过 `--config <路径>` 指定文件。可复制 `config/core.example.json` 作为起点，并使用 `config/core.schema.json` 供编辑器和安装工具校验。文件只接受 `dataDir`、`host`、`port`、`publicUrl` 和 `cookieSecure`；命令行参数会覆盖文件值，未知字段或非法值会阻止启动。不要在该文件中写入密码、Cookie、Token 或数据库凭据。默认配置文件可以不存在；显式传入的 `--config` 文件必须存在。

Docker 镜像只复制仓库内受控的组件目录、Schema 和示例配置。本地 `config/core.json` 不会被打入镜像；部署配置应通过显式启动参数或挂载的部署文件提供。

部署探针位于 `/health/live`、`/health/ready` 和 `/health/diagnostic`。探针只返回受限的状态和聚合数量，不暴露路径、URL、凭据或用户内容。初始化完成前，readiness 探针返回 HTTP 503。

HTTPS 反向代理部署时，请显式传入公网地址，使会话和入口 Cookie 带有 `Secure` 属性：

```powershell
pnpm start -- --data-dir .\data --public-url https://hub.example.com
```

从 `CarMediaHub` 父目录使用 Docker：

```powershell
docker compose -f carmediahub/compose.yaml up --build
```

当前 Compose 配置只运行 Core，并使用受管的 SQLite 数据卷。PostgreSQL 目前是正在接入的显式 Core 适配器，尚未由此 Compose 文件启动或要求。

Compose 端口刻意只绑定到 `127.0.0.1`，其 Core 命令要求使用 Secure Cookie。请通过运营者管理的反向代理终止 TLS 并公开服务。其他生产启动方式可传入 `--public-url https://hub.example.com` 或 `--cookie-secure`。

离线备份和恢复使用显式命令。创建快照前请停止 Core；恢复只能写入新的空目录：

```powershell
pnpm backup backup --data-dir .\data --output .\snapshots\cmh-01
pnpm backup restore --snapshot .\snapshots\cmh-01 --data-dir .\restored-data
```
