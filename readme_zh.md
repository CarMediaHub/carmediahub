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
