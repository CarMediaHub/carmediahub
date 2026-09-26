# CarMediaHub Core

CarMediaHub Core 提供平台所需的自托管运行时、Agent、管理端、网关和能力服务。

语言：[English](readme.md) · 简体中文 · [한국어](readme_ko.md)

插件契约、部署和集成说明请参阅 SDK 与文档仓库。

插件 Manifest 的 `sdk` 范围会在安装和升级时与当前 SDK 契约版本校验；不兼容的包不会进入运行时。

插件逻辑数据契约默认使用 SQLite，并提供由 Core 管理的显式 PostgreSQL 和 MySQL 适配器。连接字段必须显式配置；插件不会获得连接、Schema、凭据或 SQL。

## 本地开发

```powershell
pnpm install
pnpm verify
pnpm start -- --data-dir .\data
```

`pnpm verify` 会执行本地部署门禁、管理端类型检查和生产构建、Core 测试、启动烟测、升级检查以及 Native bundle/服务规格测试。Docker 和 PostgreSQL 集成仍需在显式 CI 或目标环境中执行。

运行本地启动烟测（临时数据目录、初始化、liveness 和 readiness）：

```text
pnpm smoke:startup
```

如需执行显式的本地 Browser Worker smoke（仅用于开发），请传入真实 Chromium/Chrome 可执行文件和一次性数据目录。命令不会自动发现浏览器，也不读取环境变量；它会验证允许的 Origin、未知 Origin 阻断、作用域 User Data 目录和静音启动契约：

```powershell
pnpm smoke:browser -- --runtime-executable "C:\Path\to\chrome.exe" --data-dir .\tmp\browser-smoke
```

Core 使用显式数据目录，不要求运行时环境变量或通过系统 PATH 隐式发现组件。

准备运营者自己的组件发布记录时，可以显式暂存普通二进制并生成摘要绑定的未签名记录：

```powershell
pnpm component:prepare-release -- --data-dir .\data --artifact .\downloads\ffmpeg.exe --component-id ffmpeg --artifact-id ffmpeg-7 --version 7.0.0 --platform windows-x64 --key-id 0123456789abcdef --output .\releases\ffmpeg-7.json
```

`--artifact` 也可以指向包含主可执行文件及 DLL/资源文件的目录。目录制品使用规范相对路径树摘要，并拒绝链接和特殊文件。如果提供 provenance，`--source-url` 与 `--license-spdx` 必须同时提供。

签名发布记录的机器可读契约位于 [`config/component-release.schema.json`](config/component-release.schema.json)。该 Schema 会随 Docker 和 Native 制品分发，使外部签名工具与部署环境使用和 Core 一致的字段约束。

该命令不会读取私钥、签名、安装或覆盖已有 staging artifact。提交给 Core 前，必须通过运营者自己控制的签名流程完成签名。

签名步骤必须在发布者工作站上显式执行：

```powershell
pnpm component:sign-release -- --release .\releases\ffmpeg-7.json --private-key .\secrets\component-ed25519.pem --output .\releases\ffmpeg-7.signed.json
```

CLI 要求私钥为 Ed25519，且公钥指纹必须与 `release.keyId` 一致；已有输出会被拒绝，私钥不会复制到 staging 或运行时制品。完整的平台矩阵可使用 `node scripts/validate-component-release-matrix.mjs --matrix <matrix.json>` 校验。

每个平台的记录签名完成后，使用显式平台列表组装矩阵：

```powershell
pnpm component:assemble-matrix -- --component-id ffmpeg --version 7.0.0 --platforms windows-x64,linux-x64,linux-arm64 --release-dir .\releases\ffmpeg-7 --output .\releases\ffmpeg-7-matrix.json
```

管理员的组件登记接口仅用于登记元数据，登记结果会标记为“未验证”。未验证记录可以查看并执行健康检查，但 Core 不会执行它们、将其作为浏览器引擎启动或作为正式运行时组件使用。只有通过受信任签名校验的发布记录才会标记为“已验证”。

插件数据只通过 SDK 提供的受作用域逻辑 API 和版本化迁移台账访问。物理 SQLite/PostgreSQL 结构由 Core 管理；插件不会获得数据库连接、DSN、Schema 名称或 SQL 通道。

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

当前 Compose 配置只运行 Core，并使用受管的 SQLite 数据卷。Core 已提供 PostgreSQL 和 MySQL 的插件逻辑数据适配器，但本 Compose 文件尚未提供完整的替代后端部署 profile；这些适配器仍必须在目标环境中显式配置并执行 smoke 测试。

Compose 端口刻意只绑定到 `127.0.0.1`，其 Core 命令要求使用 Secure Cookie。请通过运营者管理的反向代理终止 TLS 并公开服务。其他生产启动方式可传入 `--public-url https://hub.example.com` 或 `--cookie-secure`。

离线备份和恢复使用显式命令。创建快照前请停止 Core；恢复只能写入新的空目录：

```powershell
pnpm backup backup --data-dir .\data --output .\snapshots\cmh-01
pnpm backup restore --snapshot .\snapshots\cmh-01 --data-dir .\restored-data
```

使用 Docker 时，不要让非 root Core 容器直接把快照写入宿主 bind mount，也不要恢复到已经被容器初始化过的数据目录。应由运维者先在容器可写的暂存位置生成快照并导出，再恢复到新的空目录或数据卷，验证后才启动 Core，并保留原卷用于回滚。

显式 `docker:backup-migrate` 助手要求 Node 和 Docker CLI 位于同一个运维环境中。必须传入 Docker 可执行文件绝对路径；它会拒绝已存在的恢复数据卷，并使用隔离的容器暂存路径：

```text
pnpm docker:backup-migrate -- export --docker /absolute/path/to/docker --container cmh-core --output ./snapshots/cmh-01
pnpm docker:backup-migrate -- restore --docker /absolute/path/to/docker --container cmh-core-restored --image carmediahub-core:latest --volume cmh-restored-data --snapshot ./snapshots/cmh-01
```

更换 Native 部署包前，请使用显式且已校验的快照执行只读升级预检：

```powershell
pnpm upgrade-preflight -- --bundle-root <bundle-root> --data-dir <data-dir> --snapshot <snapshot>
```

预检会校验 Bundle 元数据、数据库 schema 兼容性，以及快照中的数据库是否与当前数据一致。它不会停止 Core、创建快照、安装部署包或执行回滚。

安装器可以在相同检查之后生成平台专用的 dry-run 安装计划：

```powershell
pnpm native-install-plan -- --platform <windows|linux> --bundle-root <bundle-root> --config <config-path> --data-dir <data-dir> --node <runtime-path> --service-name <service-name> --description <description> --required-free-bytes <bytes>
```

计划包含 `sc.exe` 或 systemd 规格，以及 Bundle、配置和数据目录的明确 ACL 意图。默认使用非管理员服务身份（Windows 为 `LocalService`，Linux 为 `carmediahub`），但不会创建账号、注册系统服务或写入部署文件。

未来的特权安装器消费计划前，Core 还会再次校验序列化后的动作列表：只允许 Core 针对平台生成的命令，拒绝危险参数字节，强制检查声明的幂等策略，并且只允许 Linux systemd 单元使用 stdin。这是执行边界，不代表 Native 实机安装已经完成。

校验器还要求完整的平台动作顺序和阶段参数：Windows 的 ACL 必须指向绝对路径，并与后续服务创建、描述和启动参数对应；Linux 必须先创建账号和目录，再写入匹配的 systemd 单元、应用对应所有权、重载 systemd 并启用对应服务。缺失、重复、乱序或目标不匹配的阶段都会被拒绝。

Bundle 还包含 `config/native-install-plan.schema.json`，外部安装器可以在执行任何特权操作前独立校验计划结构。Core 随包提供的执行入口默认仍是预览模式；只有同时显式传入 `--apply` 和 `--confirm CARMEDIAHUB_APPLY` 才会执行动作，已有服务或账号会被视为不匹配而拒绝覆盖。

```powershell
pnpm native-install-apply -- --plan <plan.json>
pnpm native-install-apply -- --plan <plan.json> --apply --confirm CARMEDIAHUB_APPLY
pnpm native-install-verify -- --plan <plan.json>
```

`native-install-verify` 只读检查显式 apply 后的计划服务身份、精确 Linux systemd 单元或 Windows 服务配置，以及启用/运行状态。检查失败代表部署漂移，不会据此自动覆盖已有服务。
