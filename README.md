# dsh-subscriptions

DeepSeek Harness (DSH) 统一「订阅」插件：不用 API Key，通过 OAuth 复用你手上的 AI 编码订阅。

- **Cursor**：内置 `@cursor/sdk` 适配器（Composer / GPT / Claude / Gemini / Grok / Kimi 等 Cursor 云端模型）。
- **CLIProxyAPI**：插件自动下载并托管 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，
  把 Claude Code、OpenAI Codex、Antigravity、Kimi Code、Grok Build 等订阅统一成本地 OpenAI 兼容端点。

所有模型都会出现在 DSH 的模型选择器里；登录管理集中在 **设置 → 订阅** 面板（或独立页面 `/subscriptions`）。

## 安装

```bash
git clone https://github.com/daybreak33167-commits/cursor-provider-cursor dsh-subscriptions
dsh plugin --profile web add link:/绝对路径/dsh-subscriptions
```

然后在 profile 的 `package.json`（`~/.dsh/profiles/web/package.json`）的 `dsh.profile.bundles`
里加入 `"dsh-subscriptions"`，重启 `dsh web` 即可。

首次启动时插件会：

1. 从 GitHub Releases 下载对应平台的 CLIProxyAPI 二进制到 `~/.dsh/cliproxy/bin/`；
2. 生成 `~/.dsh/cliproxy/config.yaml`（只监听 `127.0.0.1`）；
3. 随机生成管理密钥和代理 API Key 写入 DSH 凭据（`CLIPROXY_MANAGEMENT_KEY` / `CLIPROXY_API_KEY`）；
4. 启动代理并做健康检查，进程崩溃自动退避重启，DSH 退出时同步停止。

> Windows 上若默认端口 8317 落在系统保留端口段（Hyper-V/WinNAT），插件会自动改用可用端口，
> 无需手工处理；实际端口见 设置 → 订阅 面板。

## 登录

三种方式任选：

| 方式 | 说明 |
| --- | --- |
| 设置 → 订阅 | 每个提供商一张卡片：登录 / 退出 / 多账号 / 状态 / 模型列表 |
| `/subscriptions` | 同功能的独立页面（仅本机回环可访问） |
| 斜杠命令 | `/login`（Cursor）、`/login claude`、`/login codex`、`/login antigravity`、`/login kimi`、`/login grok`、`/login status`、`/logout <provider>` |

OAuth 流程全部由 CLIProxyAPI 完成（浏览器授权、token 刷新、多账号轮询）；DSH 侧只保存
代理的管理密钥，订阅 token 存放在 `~/.dsh/cliproxy/auth/`，不会下发到浏览器。

Kimi 和 Grok 是设备码流程：命令/面板会显示 `XXXX-XXXX` 设备码，在弹出的页面里输入即可。

## 提供商与模型分组

| DSH 提供商 id | 订阅 | OAuth 来源 |
| --- | --- | --- |
| `cursor` | Cursor | 插件内置（`@cursor/sdk`） |
| `claude-code` | Claude Pro/Max（Claude Code） | CLIProxyAPI 内置 |
| `codex` | ChatGPT Plus/Pro（Codex） | CLIProxyAPI 内置 |
| `antigravity` | Antigravity | CLIProxyAPI 内置 |
| `kimi-code` | Kimi Code | CLIProxyAPI 内置（设备码） |
| `grok-build` | Grok Build | CLIProxyAPI 内置（设备码） |
| `gemini-cli` / `qwen-code` / `iflow` | Gemini CLI / Qwen / iFlow | 需要先在 CLIProxyAPI 插件商店安装对应插件（v7 起这些渠道走 CPA 插件） |
| `cliproxy` | 其它（openai-compatibility 透传、CPA 插件渠道等） | — |

模型按前缀自动归入以上家族（`claude-*` → `claude-code`、`gpt-*`/`codex-*` → `codex`、
`gemini-*` → `gemini-cli`、`kimi-*` → `kimi-code`、`grok-*` → `grok-build`……），
未识别的进 `cliproxy`。登录成功后约 1 分钟内模型列表自动刷新。

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
- 多账号：同一提供商可登录多个账号，由 CLIProxyAPI 轮询负载均衡；面板里可单独停用/退出。

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
