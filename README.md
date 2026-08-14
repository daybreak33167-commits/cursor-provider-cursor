# dsh-llm-cursor

DeepSeek Harness provider adapter that lets **Cursor models** drive DSH.

DSH keeps the agent loop, workspace tools, and approvals. This plugin registers the `cursor` provider route and streams Cursor model output (including tool calls) back into that loop through the official `@cursor/sdk`.

## Install

Requires [DSH](https://github.com/deepseek-ai/deepseek-harness) and Node.js 22.13+.

```powershell
dsh plugin --profile web add C:\Users\Administrator\dsh-llm-cursor
dsh plugin --profile headless add C:\Users\Administrator\dsh-llm-cursor
```

The bundle sets the default model to `cursor / composer-2.5`. Change it in **Settings → Models** if you want another Cursor model.

## Credentials

Preferred: in the DSH composer run `/login`. That opens the official Cursor login page in the browser and writes the minted key into DSH as `CURSOR_API_KEY`. `/logout` signs out. `/login status` shows the current session.

You can also open `/oauth` and click **使用 Cursor 登录**.

Resolve order after that:

1. DSH credentials store (`CURSOR_API_KEY`)
2. Process environment `CURSOR_API_KEY`
3. The key stored by `Cursor.auth.login()` in `~/.cursor/sdk/auth.json`

## Use

```powershell
dsh web
```

Pick a Cursor model in the picker, then chat as usual. DSH tools still run inside DSH; the Cursor SDK agent is not given filesystem or shell tools.

The picker lists the full Cursor catalog (Claude / GPT / Gemini / Grok / Kimi / Composer / Auto), not only the few IDs an API key happens to advertise. After you pick a model, the **Effort** pane is where you switch thinking level and context length (for example `High · Max 1000K`). DSH itself has no separate context-length control; this adapter folds Max mode into that pane and sends `{ id, params }` to the Cursor SDK.

Headless:

```powershell
dsh --profile headless "Summarize this repository"
```

## Notes

- Cursor does not publish a raw OpenAI-compatible chat API. This adapter uses the local Cursor SDK agent with built-in IDE tools disabled (`tools: ['mcp']`) and parks DSH tool calls so Harness executes them.
- Image input is supported: attachments are read from DSH's attachment store and sent to the Cursor SDK as base64 (user messages and image-bearing tool results).
- Developer-preview DSH may change the adapter seam.
