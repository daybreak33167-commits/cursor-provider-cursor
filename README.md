# dsh-cpa-plus

DeepSeek Harness (DSH) 统一「订阅」插件：把 Cursor、Factory Droid 和 **内置托管的 CLIProxyAPI**
整合成一套，复用手上的 AI 编码订阅。

- **Cursor**：内置 `@cursor/sdk` 适配器（Composer / GPT / Claude / Gemini / Grok / Kimi 等 Cursor 云端模型）。
- **Factory Droid**：管理 WorkOS / API Key；聊天直连 `api.factory.ai`（避免 CPA cloak 问题）。
  Factory Claude / Grok 以及 Cursor 对话由主模型在本轮直接调用原生 `web_search`；
  其它模型仍把 DSH `web_search` 回退到设置里选的搜索模型。模型以 `factory-*` 别名单独分组。
- **CLIProxyAPI（插件内置，默认托管）**：插件自动下载并启动本地 CPA，用于 Claude Code、Codex、
  Antigravity、Kimi Code、Grok Build 等订阅；不需要你另开一个外部代理进程。

所有模型都会出现在 DSH 的模型选择器里；登录管理集中在 **设置 → 订阅** 面板（或独立页面 `/subscriptions`）。

## 安装

```bash
git clone https://github.com/daybreak33167-commits/dsh-cpa-plus.git
dsh plugin --profile web add link:/绝对路径/dsh-cpa-plus
```

然后在 profile 的 `package.json`（`~/.dsh/profiles/web/package.json`）的 `dsh.profile.bundles`
里加入 `"dsh-cpa-plus"`，重启 `dsh web` 即可。

首次启动（`cliproxy.mode: managed`）时插件会：

1. 从 GitHub Releases 下载 CLIProxyAPI 到 `~/.dsh/cliproxy/bin/`；
2. 生成 `~/.dsh/cliproxy/config.yaml`（只监听 `127.0.0.1`）；
3. 把管理密钥 / 代理 API Key 写入 DSH 凭据；
4. 启动代理并做健康检查，随 DSH 退出一并停止。

若暂时不需要 Claude Code / Codex 等 CPA 渠道，可在配置里设 `cliproxy.mode: off`
（Cursor + Factory 仍可用）。

## 登录

三种方式任选：

| 方式 | 说明 |
| --- | --- |
| 设置 → 订阅 | 供应商页签（带账号数），页签内是账号列表：登录 / 添加账号 / 停用 / 退出 |
| `/subscriptions` | 同功能的独立页面（仅本机回环可访问） |
| 斜杠命令 | `/login`（Cursor）、`/login claude`、`/login codex`、`/login antigravity`、`/login kimi`、`/login grok`、`/login factory`、`/login status`、`/logout <provider>` |

OAuth 流程全部由 CLIProxyAPI 完成（浏览器授权、token 刷新、多账号轮询）；DSH 侧只保存
代理的管理密钥，订阅 token 存放在 `~/.dsh/cliproxy/auth/`，不会下发到浏览器。

Kimi 和 Grok 是设备码流程：命令/面板会显示 `XXXX-XXXX` 设备码，在弹出的页面里输入即可。

Factory Droid 没有公开的浏览器 OAuth，三种添加方式：

- **从 droid CLI 导入**：本机运行过 `droid` 并登录后，面板会出现一键导入按钮
  （读取 `~/.factory/auth.json`，之后 token 由插件每 6 小时自动刷新并回写，droid CLI 保持可用）；
- **粘贴 refresh token**：把任意机器 `~/.factory/auth.json` 里的 `refresh_token` 粘贴到面板，
  或 `/login factory <refresh-token>`；
- **粘贴 API Key**：Factory 平台签发的固定 Key，`/login factory key <api-key>`。

## 提供商与模型分组

| DSH 提供商 id | 订阅 | OAuth 来源 |
| --- | --- | --- |
| `cursor` | Cursor | 插件内置（`@cursor/sdk`） |
| `claude-code` | Claude Pro/Max（Claude Code） | CLIProxyAPI 内置 |
| `codex` | ChatGPT Plus/Pro（Codex） | CLIProxyAPI 内置 |
| `antigravity` | Antigravity | CLIProxyAPI 内置 |
| `kimi-code` | Kimi Code | CLIProxyAPI 内置（设备码） |
| `grok-build` | Grok Build | CLIProxyAPI 内置（设备码） |
| `factory` | Factory Droid（factory.ai） | 插件管理账号；聊天直连 Factory，Claude/Grok 主模型本轮原生搜索 |
| `gemini-cli` / `qwen-code` / `iflow` | Gemini CLI / Qwen / iFlow | 需要先在 CLIProxyAPI 插件商店安装对应插件（v7 起这些渠道走 CPA 插件） |
| `cliproxy` | 其它（openai-compatibility 透传、CPA 插件渠道等） | — |

模型按前缀自动归入以上家族（`claude-*` → `claude-code`、`gpt-*`/`codex-*` → `codex`、
`gemini-*` → `gemini-cli`、`kimi-*` → `kimi-code`、`grok-*` → `grok-build`……），
未识别的进 `cliproxy`。登录成功后约 1 分钟内模型列表自动刷新。

Factory Droid 的模型走 `factory-` 前缀别名（如 `factory-claude-opus-4-6`、`factory-gpt-5.3-codex`、
`factory-kimi-k3`），与真正的 Claude Code / Codex 账号互不混淆：Claude 系走 Factory Anthropic
Messages、GPT 系走 Responses、Core（Kimi/GLM 等）走 chat-completions；账号由插件本地管理。

## 配置（设置 → 插件 → subscriptions）

```yaml
cursor:
  apiKeyEnv: CURSOR_API_KEY   # DSH 凭据名；/login cursor 成功后自动写入
  models: []                  # 可选：手工裁剪 Cursor 模型列表
cliproxy:
  mode: managed               # managed=托管；external=连接已有实例
  port: 8317                  # 托管模式期望端口（被占用/保留时自动换）
  externalUrl: ""             # external 模式的地址
  binaryPath: ""              # 自备二进制路径（跳过下载）
  version: latest             # 固定版本号可写如 7.2.131
  managementKeyEnv: CLIPROXY_MANAGEMENT_KEY
  apiKeyEnv: CLIPROXY_API_KEY
```

external 模式下需要自己把 DSH 凭据 `CLIPROXY_MANAGEMENT_KEY` / `CLIPROXY_API_KEY`
设置成目标实例的管理密钥和 API Key。

## 能力说明

- 流式输出、reasoning（`reasoning_content` → DSH 思考块；Codex 系列可选 minimal→xhigh 推理力度）。
- 工具调用：DSH 工具映射为 OpenAI function calling；Cursor 路线用自定义工具桥。
- 图片输入：DSH 附件自动转 base64（Cursor SDK images / OpenAI `image_url`）。
- 多账号：所有提供商（含 Cursor）都支持多账号轮询——CLIProxyAPI 渠道由代理负载均衡；
  Cursor 由插件按新会话轮询、鉴权失败自动冷却 5 分钟换号（账号列表存 DSH 凭据 `CURSOR_ACCOUNTS`）。
  面板里可单独停用/退出账号；`/logout cursor <邮箱>` 退出单个 Cursor 账号。
- Factory Droid：账号存 DSH 凭据 `FACTORY_ACCOUNTS`（refresh token 每 6 小时自动刷新、轮换后即时持久化），
  请求自动携带 Droid 身份系统提示；`/logout factory <邮箱>` 退出单个账号。

## 数据位置

```
~/.dsh/cliproxy/
  bin/<version>/cli-proxy-api(.exe)   二进制
  config.yaml                          生成的代理配置（127.0.0.1）
  auth/                                各订阅的 OAuth token
  logs/cliproxy.log                    代理日志
```

## 风险提示

把 Claude / ChatGPT 等订阅的 OAuth 暴露给第三方客户端使用，可能违反相应服务条款
（尤其是 Anthropic 对非官方客户端的限制），账号风险自负。本插件仅做本地转接，
不上传任何凭据。
