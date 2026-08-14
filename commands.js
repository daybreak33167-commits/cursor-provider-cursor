import { PROXY_PROVIDERS, providerLabel } from './cliproxy/providers.js'

const LOGIN_ALIASES = {
  cursor: 'cursor',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  anthropic: 'claude-code',
  codex: 'codex',
  openai: 'codex',
  gpt: 'codex',
  antigravity: 'antigravity',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  qwen: 'qwen-code',
  'qwen-code': 'qwen-code',
  kimi: 'kimi-code',
  'kimi-code': 'kimi-code',
  moonshot: 'kimi-code',
  grok: 'grok-build',
  'grok-build': 'grok-build',
  xai: 'grok-build',
  factory: 'factory',
  droid: 'factory',
  'factory-droid': 'factory',
  iflow: 'iflow',
}

function tokensOf(rawInput) {
  const raw = String(rawInput ?? '').trim()
  if (!raw || raw.startsWith('[')) return []
  return raw.split(/\s+/)
}

async function cursorLogin(oauth, force) {
  if (!force) {
    const status = await oauth.publicStatus()
    const accounts = status.accounts ?? []
    if (accounts.length > 0) {
      const names = accounts.map((account) => account.email || '未知邮箱').join('、')
      return {
        kind: 'success',
        text: `Cursor 已有 ${accounts.length} 个账号（${names}），新会话自动轮询。`
          + '\n/login again 添加另一个账号（先在浏览器退出 cursor.com 或用隐身窗口）；'
          + '/logout cursor <邮箱> 退出单个账号',
      }
    }
    if (status.status === 'logged-in') {
      return {
        kind: 'success',
        text: `Cursor 已登录${status.email ? `（${status.email}）` : ''}。/logout 退出，或打开 设置 → 订阅`,
      }
    }
  }
  await oauth.startLogin()
  return {
    kind: 'success',
    text: '已打开 Cursor 登录页。完成后回到 DSH 即可。状态见 设置 → 订阅（或 /subscriptions）',
  }
}

// /login factory                    -> import from droid CLI (if logged in)
// /login factory <refresh-token>    -> add a WorkOS refresh token
// /login factory key <api-key>      -> add a Factory API key
async function factoryLogin(subscriptions, tokens) {
  const [first, second] = tokens
  if (!first) {
    try {
      const result = await subscriptions.factoryAdd('import')
      return { kind: 'success', text: `已从 droid CLI 导入 Factory 账号：${result.email}。模型稍后出现在模型选择器（factory-* 前缀）。` }
    } catch (error) {
      return {
        kind: 'error',
        text: `${error instanceof Error ? error.message : error}\n`
          + '用法：/login factory <refresh-token>（或 /login factory key <api-key>）；'
          + '也可以在 设置 → 订阅 → Factory Droid 页签操作。',
      }
    }
  }
  if (first.toLowerCase() === 'key') {
    if (!second) return { kind: 'error', text: '用法：/login factory key <api-key>' }
    const result = await subscriptions.factoryAdd('api-key', second)
    return { kind: 'success', text: `已添加 Factory API Key 账号：${result.email}。` }
  }
  const result = await subscriptions.factoryAdd('refresh-token', first)
  return { kind: 'success', text: `已添加 Factory 账号：${result.email}。token 每 6 小时自动刷新。` }
}

async function proxyLogin(subscriptions, providerId) {
  const started = await subscriptions.login(providerId)
  const label = providerLabel(providerId)
  const parts = [`已打开 ${label} 登录页，请在浏览器完成授权。`]
  if (started.userCode) parts.push(`设备码：${started.userCode}`)
  if (started.url) parts.push(`如浏览器未弹出，请手动打开：${started.url}`)
  parts.push('完成后模型会自动出现在模型选择器；状态见 设置 → 订阅')
  return { kind: 'success', text: parts.join('\n') }
}

async function statusSummary({ cursorOauth, subscriptions }) {
  const lines = []
  const overview = await subscriptions.overview()

  const cursor = overview.cursor
  const cursorAccounts = cursor?.accounts ?? []
  if (cursorAccounts.length > 0) {
    const names = cursorAccounts
      .map((account) => `${account.email || '未知邮箱'}${account.disabled ? '（停用）' : account.expired ? '（过期）' : ''}`)
      .join('、')
    lines.push(`Cursor：${cursorAccounts.length} 个账号轮询（${names}）`)
  } else {
    lines.push(cursor?.status === 'logged-in'
      ? `Cursor：已登录${cursor.email ? `（${cursor.email}）` : ''}`
      : 'Cursor：未登录（/login cursor）')
  }

  const proxy = overview.proxy
  const phaseText = {
    running: `运行中${proxy.version ? ` v${proxy.version}` : ''}`,
    starting: '启动中',
    installing: '正在下载',
    stopped: '已停止',
    error: `错误：${proxy.error ?? ''}`,
    'external-ok': '外部实例已连接',
    'external-unreachable': '外部实例不可达',
  }[proxy.phase] ?? proxy.phase
  lines.push(`CLIProxyAPI：${phaseText}（${proxy.baseUrl}）`)

  for (const provider of overview.providers) {
    if (provider.accounts.length === 0) continue
    const accounts = provider.accounts
      .map((account) => `${account.email || account.name}${account.disabled ? '（停用）' : ''}`)
      .join('、')
    lines.push(`${provider.label}：${accounts}`)
  }

  const loggedOut = overview.providers
    .filter((provider) => provider.canLogin && provider.accounts.length === 0)
    .map((provider) => provider.id)
  if (loggedOut.length > 0) {
    lines.push(`未登录：${loggedOut.map((id) => `/login ${id}`).join('  ')}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

export function registerSubscriptionCommands(ctx, { cursorOauth, subscriptions }) {
  const hint = [
    'cursor', ...PROXY_PROVIDERS.map((provider) => provider.id), 'status',
  ].join(' | ')

  ctx.commands.register({
    name: 'login',
    description: 'Sign in to a subscription (Cursor / Claude Code / Codex / ...)',
    input: { hint: `[${hint}]` },
    async handler(invocation) {
      const tokens = tokensOf(invocation.rawInput)
      const action = (tokens[0] ?? '').toLowerCase()
      try {
        if (action === 'status') return await statusSummary({ cursorOauth, subscriptions })
        if (action === 'logout') {
          await cursorOauth.logout()
          return { kind: 'success', text: '已退出 Cursor 登录。' }
        }
        if (!action || action === 'again' || action === 'cursor') {
          return await cursorLogin(cursorOauth, action === 'again')
        }
        const providerId = LOGIN_ALIASES[action]
        if (!providerId) {
          return {
            kind: 'error',
            text: `未知提供商 "${action}"。可用：${hint}`,
          }
        }
        if (providerId === 'cursor') return await cursorLogin(cursorOauth, false)
        if (providerId === 'factory') return await factoryLogin(subscriptions, tokens.slice(1))
        return await proxyLogin(subscriptions, providerId)
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'logout',
    description: 'Sign out of a subscription',
    input: { hint: '[cursor | claude-code | codex | ...]' },
    async handler(invocation) {
      const tokens = tokensOf(invocation.rawInput)
      const action = (tokens[0] ?? '').toLowerCase()
      try {
        if (!action || action === 'cursor') {
          const email = tokens[1]
          const removed = await cursorOauth.logout(email)
          return {
            kind: 'success',
            text: email
              ? (removed > 0 ? `已退出 Cursor 账号 ${email}。` : `Cursor 没有账号 ${email}。`)
              : `已退出 Cursor 登录${removed > 1 ? `（${removed} 个账号）` : ''}。`,
          }
        }
        const providerId = LOGIN_ALIASES[action]
        if (!providerId) {
          return { kind: 'error', text: `未知提供商 "${action}"。` }
        }
        const result = await subscriptions.logout(providerId, tokens[1])
        const removed = Array.isArray(result?.removed) ? result.removed : []
        return {
          kind: 'success',
          text: removed.length > 0
            ? `已退出 ${providerLabel(providerId)}：${removed.join('、')}`
            : `${providerLabel(providerId)} 没有已登录的账号。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
