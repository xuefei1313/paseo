# Codex Desktop 手机接入

本 fork 的 `plugins/codex-desktop-bridge` 保留 bridge 的原生 Project、完整 roots 和 Desktop thread 身份。官方 iOS App 加载插件界面，聊天使用 Paseo 原生页面。

同目录的对话复用 Paseo 已有 workspace，再创建独立 agent。这样手机关闭侧栏、目录订阅暂停后，新对话仍使用已知的 workspace 身份。

首次导入已有对话时，传入 Paseo 的展示标题按其现有 200 字符上限截取；完整标题与正文保留在原 Codex 对话中，同一 thread 重复打开复用已有绑定。

## 开发与验证

前提是 bridge 已配置并运行，controller 校验通过。只编辑源码，不直接编辑已安装的 bridge。新增生产依赖为零。

`codex queue` 只证明已排队。macOS 上插件随后通过 `codex://threads/<id>` 加载同一个目标对话（新建时加载 controller），让 `notLoaded` 对话开始处理；这会切换电脑端显示的对话，不启动另一 writer。深链接打开失败时，手机显示需打开电脑端对话的提示，原请求仍保留，不要重发。

空的新对话在首条消息前也保存项目恢复标识，daemon 重启后可继续输入首条消息；创建中的请求仍按原 ID 恢复。

```sh
npm ci
npm run build:server
npm run typecheck --workspace=@getpaseo/builtin-plugins
CODEX_DESKTOP_BRIDGE_SOURCE=/absolute/path/to/codex-lark-bridge python3 -m unittest discover -s plugins/codex-desktop-bridge/server -p 'test_*.py'
npm run test --workspace=@getpaseo/builtin-plugins -- codex-desktop-bridge/index.server.test.ts codex-desktop-bridge/server/provider.test.ts
cd packages/server
npx vitest run src/server/plugins/compiler.test.ts
```

daemon 的插件编译器新增 `.py` 文本资源支持，将 Python 适配器嵌入插件服务端 bundle。Python 标准库直接复用 bridge 的校验、队列命令和 controller 协议，保持唯一 Desktop writer。此插件需使用本 fork daemon；手机端支持官方 0.11.0 至 0.11.x。

## 本机运行

为测试选择独立 home 和未使用的回环端口。`config.json` 的 `daemon.listen` 设置监听地址，`features.webUi.enabled` 可开启本机网页；根级 `pluginsEnabled` 为插件开关。启用插件表示允许已检查的代码访问当前用户的本机资源。

```sh
node packages/cli/dist/index.js --home /absolute/path/to/paseo-home daemon start
node packages/cli/dist/index.js --home /absolute/path/to/paseo-home plugin install /absolute/path/to/paseo/plugins/codex-desktop-bridge
node packages/cli/dist/index.js --home /absolute/path/to/paseo-home plugin ls --json
node packages/cli/dist/index.js --home /absolute/path/to/paseo-home daemon pair --relay
```

插件设置 `connection.bridgeSource` 和 `connection.bridgeConfig` 为已有 bridge 的代码目录与运行配置。默认读取 `~/.codex/discord-bridge`；飞书可改为 `~/.codex/lark-bridge`。配置只读取，不复制凭据。独立请求记录位于该 Paseo home 的 `codex-desktop-bridge/requests.sqlite`。

代码更新先跑检查，再 `plugin reload codex-desktop-bridge`。服务管理、配对和停止使用上述 CLI；不要改写既有 bridge 服务、通知链或机器人状态。关闭/删除 Paseo 窗口会话不停止或归档 Desktop task。

## iPhone 验收

1. 安装官方 [Paseo iOS App](https://apps.apple.com/app/id6758887924)，需要 iOS 15.1 或以上。
2. 使用 daemon 配对二维码或链接添加本 Mac。二维码/链接含设备配对凭据，不写进 Git/Issue/日志或公开分享。
3. 侧栏打开 Codex Desktop，选择项目与已有对话；确认历史可见并能继续同一个 Desktop thread。
4. 新建短任务，确认电脑只创建一个目标会话，Project 正确，手机收到结果；再发一轮并确认仍为同一个 thread。
5. 切后台、恢复、断网重连，确认无重复创建/发送；检查键盘、长文字、深色主题。

每条发送先持久化请求 ID 和内容指纹，再排队。不确定结果不能通过自动重发恢复；同一 ID 与正文一致时只读取原请求。创建关联使用精确回执或 bridge 已校验来源的原生 delegation 输入，再校验首条正文 SHA-256 和完整 Project；迟到任务仍可恢复。

目前读取最近 150 条已落盘记录，刷新间隔两秒，不提供逐 token 流式输出。手机发文本，Desktop 保留模型、审批、停止操作；无对应接口的控件不声称可用。Mac 和 Codex Desktop 需要保持运行，休眠会中断连接。

## 停止与恢复

```sh
node packages/cli/dist/index.js --home /absolute/path/to/paseo-home plugin disable codex-desktop-bridge
node packages/cli/dist/index.js --home /absolute/path/to/paseo-home daemon stop
```

保留 home、配对身份和请求数据库以恢复。停用插件/daemon 不删除、归档或终止 Desktop 会话；先检查 journal 和原生会话，不能重放不确定请求。既有 Discord/飞书桥继续按原流程工作。
