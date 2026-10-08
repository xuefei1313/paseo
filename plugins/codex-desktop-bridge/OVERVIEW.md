在 Paseo 手机上查看获准的 Codex Desktop 项目，打开已有对话或新建对话，并在原生聊天页继续工作。手机和电脑使用同一个 Desktop thread。

需要 macOS 上已配置的 codex-lark-bridge controller，以及本 fork 的 daemon。支持官方 Paseo iOS 0.11.0 和更新的 0.11.x 客户端。插件设置的 bridgeSource 指向 bridge 代码目录，bridgeConfig 指向当前运行配置；默认复用 Discord bridge，也可指定飞书 bridge。

消息通过现有 codex queue 进入 Desktop，原生新任务通过现有 controller 创建。项目与完整 roots 使用 bridge 当前授权，插件不会修改授权、机器人凭据、通知或 Desktop 数据库。独立请求记录让重连和重启可以恢复关联，排队不确定时不会自动重发。

历史页展示最近 150 条消息与工具记录，每两秒读取已落盘的进展。第一版接收文本，可使用 iPhone 系统听写。模型、停止操作和工具审批使用电脑端设置；手机端当前不能处理这些 Desktop 控制操作。Paseo 的原生聊天界面负责消息显示和输入。
