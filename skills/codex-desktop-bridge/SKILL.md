---
name: codex-desktop-bridge
description: 在本 fork Paseo 上配置、验证和恢复现有 Codex Desktop bridge 手机接入。
---

触发：操作 `codex-desktop` provider 或 `codex-desktop-bridge` 插件。先读 `docs/codex-desktop-bridge.md`，复用该文档的稳定 CLI、检查与 iPhone 验收步骤。

- bridgeSource 只用现有源码或安装目录，bridgeConfig 只读取当前配置。不写 Desktop SQLite、bridge 配置、机器人状态或凭据。
- Python 适配器经本 fork 插件编译器的 `.py` 文本资源支持嵌入服务端 bundle，官方 iOS 0.11.0 至 0.11.x 可加载客户端界面。
- 项目/会话入口复用 bridge 精确授权；创建复用 controller，后续消息复用 `codex queue`。不启动第二个 writer。
- controller 为 `notLoaded` 时保留排队请求，先让 Desktop 加载已有调度器，不重复创建。原生首条 delegation 输入通过 bridge 的来源校验后可用于迟到关联和历史显示。
- 新独立 Paseo home 的安装、启用插件、配对和服务启动需属于当前用户授权。既有 home 先读取配置并保留已有设置。
- 安装或更新前运行类型、Python adapter、provider 与 compiler 检查。用 `plugin reload` 加载代码，核对 `plugin ls` 为 running。
- 不确定请求先查独立 `requests.sqlite` 与 Desktop thread，不自动重发。停止/回退保留 home 和 journal；关闭 Paseo 会话不停止 Desktop task。
- 代码验证、本机真实往返、iPhone 真机验收分开报告。第一版只发文本并轮询落盘记录，模型/审批/停止由 Desktop 操作。
