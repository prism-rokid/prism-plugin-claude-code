# Prism Claude Code 插件

插件只提供 `mod` 一种运行模式。Prism 通过用户级 Claude Code Mod 控制正在运行的原生 CLI；终端和 Panel 使用同一个 Claude 会话。Claude Agent SDK 执行模式、旧 Managed 输入租约和 zsh 命令包装不再使用。

需要 Claude Code 2.1.287 或更新版本，以及 Hub 提供的 Node.js 22 插件运行时；终端用户无需额外安装一套 Node。沿用用户已有的 Claude 配置，包括 API Key、第三方兼容 API 地址和模型配置；不依赖 Claude 官方账户的远程同步服务。

## 安装和迁移

Hub 加载插件时自动安装或更新 `prism-terminal-control@prism-local` 用户级 Mod。无需用户给每次 `claude` 启动添加参数。桌面 Hub 会自动发现 PATH、Claude 原生安装目录、Homebrew 和 nvm 中的 CLI，不要求从终端启动 Hub。首次能力检测会安装 Mod；临时安装失败后可重试。普通终端和 zsh IDE 内置终端都继续运行原来的 `claude` 命令，`--resume` 等原生参数保持可用。不同 `CLAUDE_CONFIG_DIR` 的配置需要分别安装。

安装成功后，迁移程序仅删除 Prism 以前写入 `.zshrc` 的精确标记和 source 行，保留用户自己的配置。已经打开的旧 shell 可能仍缓存旧的 `claude` 函数，需重新打开终端；已经运行的旧 Claude 进程可能需要退出后重新打开才能加载 Mod。迁移不会主动结束用户的任务。

也可以手动管理 Mod：

```bash
node scripts/install-mod.mjs install
node scripts/install-mod.mjs update
node scripts/install-mod.mjs uninstall
```

Mod 使用带随机凭据的本机回环连接，连接描述文件仅允许当前用户读取。Hub 或插件断线时，Claude 原生终端仍可使用；恢复连接后重新握手。关闭 Hooks、禁用该 Mod、安全模式或项目信任尚未确认时，Prism 不会使用另一条写入路径绕过限制。

## 会话和输入

- 手动启动的原生 Claude 会话通过 Mod 注册；历史和会话名称来自本地 Claude transcript 文件。
- 对于已结束且没有活跃所有者的会话，Panel 继续聊天时使用原生 `--resume`，并打开本地终端。仍有活跃 CLI 但没有 Mod 连接时，拒绝启动第二个写入者。
- 本地草稿和光标由 Claude 自己管理，Panel 提交文本不会通过模拟按键清空本地输入。忙碌时拒绝新的远程提交，不自动重复发送。
- 请求通过本地记录去重；提交回执与回合开始、完成分别处理。无法确定请求归属时标记不确定，拒绝自动重试和可能误中止本地任务的操作。
- `/clear` 等改变原生会话 ID 的操作需要重新握手；旧请求不能继续控制新会话。

回复通过官方 `turn.step` 流式钩子逐个转发主会话的可见文本块，不做定时合并。所有原生文本、思考、工具调用和引擎块保持原样传给 Claude；子智能体的文本不混入主会话。Panel 使用现有实时历史通道更新同一回合，最终以本地 transcript 校准，消除预览与落盘消息的重复。浏览器重连能恢复插件内存中的当前预览；插件重启或增量丢失后，从已落盘历史恢复，未落盘内容不保证恢复。

权限使用 Claude 原生规则，不自动批准项目信任或工具执行。附件和原生 `@file`、粘贴图片等富输入尚未等价支持；远程附件明确拒绝，不静默丢弃。远程文本中的 `@file` 不能视为原生终端的文件引用。

本地历史能够恢复已落盘内容；实时通知回执不等价于已被浏览器显示。新模式发布前仍应在目标系统完成 Terminal.app、IDE 终端、实际 API 提供方以及完整 Panel 链路验收。

## 开发与发布

```bash
npm ci --registry=https://registry.npmmirror.com
npm test
PRISM_PLATFORM=macos-arm64 node scripts/verify-release.mjs
node dist/index.js
```

`dist/index.js` 的 stdout 仅用于 PluginBridge JSON 行协议。PluginBridge SDK 0.1.3 使用 `vendor/` 内固定包，它负责 Hub 插件协议，不是 Claude Agent SDK。

构建会清理旧的 `dist`，避免被删除的模式进入发布包。`node-pty` 仅用于原生终端的生命周期和显示；构建产物需在目标平台组装。发布验证包含协议探测、PTY 探测和版本一致性检查；本地通过不代表其他平台的原生 UI 已验收。
