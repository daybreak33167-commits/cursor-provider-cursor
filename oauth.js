import { spawn } from 'node:child_process'
import { Cursor } from '@cursor/sdk'

const LOGIN_NAME = 'DeepSeek Harness'

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
}

function wantsJson(req) {
  const accept = String(req.headers.accept ?? '')
  return accept.includes('application/json')
}

function isLoopbackHost(req) {
  const host = String(req.headers.host ?? '').split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function pathnameOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
  } catch {
    return '/'
  }
}

function renderPage(state) {
  const loggedIn = state.status === 'logged-in'
  const waiting = state.phase === 'waiting'
  const error = state.error ? `<p class="err">${escapeHtml(state.error)}</p>` : ''
  const identity = loggedIn
    ? `<p class="ok">已登录${state.email ? ` · ${escapeHtml(state.email)}` : ''}</p>`
    : '<p>尚未登录 Cursor。点下面的按钮走官方 OAuth，登录成功后密钥会写入 DSH 凭据。</p>'
  const actions = loggedIn
    ? `<a class="btn ghost" href="/oauth/logout">退出登录</a>`
    : waiting && state.loginUrl
      ? `<a class="btn" href="${escapeHtml(state.loginUrl)}">继续打开 Cursor 登录页</a>`
      : `<a class="btn" href="/oauth/login">使用 Cursor 登录</a>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cursor OAuth · DSH</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; background: #111214; color: #ececec; }
    main { width: min(440px, calc(100vw - 32px)); padding: 28px; border: 1px solid #2a2b2f;
      border-radius: 16px; background: #18191c; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 16px; color: #b3b3b3; }
    .ok { color: #8ee59b; }
    .err { color: #ff8d85; }
    .btn { display: inline-block; padding: 10px 14px; border-radius: 10px; background: #4f8cff;
      color: #fff; text-decoration: none; font-weight: 600; }
    .btn.ghost { background: transparent; border: 1px solid #3a3b40; color: #ececec; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    code { color: #d7d7d7; }
  </style>
</head>
<body>
  <main>
    <h1>Cursor OAuth</h1>
    ${identity}
    ${error}
    <div class="row">${actions}</div>
    <p style="margin-top:20px;font-size:13px">登录完成后回到 <code>/oauth</code>，或到 DSH Settings → Models 确认 Cursor 已配置。</p>
  </main>
  <script>
    const waiting = ${waiting ? 'true' : 'false'};
    if (waiting) {
      const tick = async () => {
        try {
          const res = await fetch('/oauth/status', { headers: { accept: 'application/json' } });
          const data = await res.json();
          if (data.status === 'logged-in' || data.phase === 'error') location.replace('/oauth');
        } catch {}
      };
      setInterval(tick, 1500);
    }
  </script>
</body>
</html>`
}

function openInBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function createOAuthController(hooks) {
  const state = {
    phase: 'idle',
    loginUrl: undefined,
    error: undefined,
    controller: undefined,
  }

  async function publicStatus() {
    const sdk = await Cursor.auth.status().catch(() => ({ status: 'logged-out' }))
    const credentials = hooks.getCredentials?.()
    const ref = hooks.getApiKeyEnv()
    const stored = credentials ? await credentials.describe?.(ref).catch(() => undefined) : undefined
    return {
      status: sdk.status,
      email: sdk.email,
      expiresAt: sdk.apiKeyExpiresAtMs,
      dshCredential: stored?.configured === true,
      phase: state.phase,
      loginUrl: state.phase === 'waiting' ? state.loginUrl : undefined,
      error: state.phase === 'error' ? state.error : undefined,
    }
  }

  async function persistKey(apiKey) {
    const credentials = hooks.getCredentials?.()
    const ref = hooks.getApiKeyEnv()
    if (!credentials?.set || !apiKey) return
    try {
      await credentials.set(ref, apiKey)
    } catch (error) {
      hooks.logger?.warn?.(`llm-cursor oauth: could not write DSH credential ${ref}: ${error instanceof Error ? error.message : error}`)
    }
  }

  async function startLogin() {
    if (state.phase === 'waiting' && state.loginUrl) {
      await openInBrowser(state.loginUrl)
      return { loginUrl: state.loginUrl, alreadyStarted: true }
    }
    state.controller?.abort()
    const controller = new AbortController()
    state.controller = controller
    state.phase = 'waiting'
    state.loginUrl = undefined
    state.error = undefined

    let resolveUrl
    const urlReady = new Promise((resolve) => {
      resolveUrl = resolve
    })

    const pending = Cursor.auth.login({
      openBrowser: async (url) => {
        state.loginUrl = url
        resolveUrl?.(url)
        await openInBrowser(url)
      },
      signal: controller.signal,
      apiKeyName: LOGIN_NAME,
      onLoginUrl(url) {
        state.loginUrl = url
        resolveUrl?.(url)
      },
    }).then(async (result) => {
      state.phase = 'done'
      state.loginUrl = undefined
      await persistKey(result.apiKey)
      return result
    }).catch((error) => {
      if (controller.signal.aborted) {
        state.phase = 'idle'
        state.loginUrl = undefined
        return
      }
      state.phase = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      throw error
    })

    const loginUrl = await Promise.race([
      urlReady,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Cursor login URL was not produced in time')), 15_000)
      }),
    ])
    pending.catch(() => {})
    return { loginUrl, alreadyStarted: false }
  }

  async function logout() {
    state.controller?.abort()
    state.phase = 'idle'
    state.loginUrl = undefined
    state.error = undefined
    await Cursor.auth.logout().catch(() => {})
    const credentials = hooks.getCredentials?.()
    const ref = hooks.getApiKeyEnv()
    if (credentials?.unset) {
      try {
        await credentials.unset(ref)
      } catch (error) {
        hooks.logger?.warn?.(`llm-cursor oauth: could not unset DSH credential ${ref}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  return { publicStatus, startLogin, logout }
}

export function createOAuthHandler(oauth) {
  return async function handleOAuth(req, res) {
    if (!isLoopbackHost(req)) {
      json(res, 403, { error: 'Cursor OAuth is only available on loopback' })
      return
    }

    const path = pathnameOf(req)
    const method = (req.method ?? 'GET').toUpperCase()

    if (path === '/oauth/status' && method === 'GET') {
      json(res, 200, await oauth.publicStatus())
      return
    }

    if (path === '/oauth/login' && (method === 'GET' || method === 'POST')) {
      try {
        const started = await oauth.startLogin()
        if (method === 'POST' || wantsJson(req)) {
          json(res, 200, { ok: true, ...started })
          return
        }
        redirect(res, started.loginUrl)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (wantsJson(req) || method === 'POST') {
          json(res, 500, { ok: false, error: message })
          return
        }
        html(res, 500, renderPage({ status: 'logged-out', phase: 'error', error: message }))
      }
      return
    }

    if (path === '/oauth/logout' && (method === 'GET' || method === 'POST')) {
      await oauth.logout()
      if (method === 'POST' || wantsJson(req)) {
        json(res, 200, { ok: true, status: 'logged-out' })
        return
      }
      redirect(res, '/oauth')
      return
    }

    if ((path === '/oauth' || path === '/oauth/callback') && method === 'GET') {
      html(res, 200, renderPage(await oauth.publicStatus()))
      return
    }

    json(res, 404, { error: 'not found' })
  }
}

export function registerOAuthRoutes(ctx, oauth) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/oauth',
    handler: createOAuthHandler(oauth),
  })
}

async function runLogin(oauth, force) {
  if (!force) {
    const status = await oauth.publicStatus()
    if (status.status === 'logged-in') {
      return {
        kind: 'success',
        text: `Cursor 已登录${status.email ? `（${status.email}）` : ''}。输入 /logout 退出，或打开 /oauth`,
      }
    }
  }
  try {
    await oauth.startLogin()
    return {
      kind: 'success',
      text: '已打开 Cursor 登录页。完成后回到 DSH 即可。状态页：/oauth',
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

function commandAction(rawInput) {
  const action = String(rawInput ?? '').trim().toLowerCase()
  if (!action || action.startsWith('[')) return ''
  return action
}

export function registerOAuthCommand(ctx, oauth) {
  ctx.commands.register({
    name: 'login',
    description: 'Sign in to Cursor via OAuth',
    input: { hint: '[status | again]' },
    async handler(invocation) {
      const action = commandAction(invocation.rawInput)
      if (action === 'logout') {
        await oauth.logout()
        return { kind: 'success', text: '已退出 Cursor 登录。' }
      }
      if (action === 'status') {
        const status = await oauth.publicStatus()
        if (status.status === 'logged-in') {
          return {
            kind: 'success',
            text: `Cursor 已登录${status.email ? `（${status.email}）` : ''}。输入 /logout 退出，或打开 /oauth`,
          }
        }
        return { kind: 'success', text: 'Cursor 未登录。输入 /login 开始登录，或打开 /oauth' }
      }
      return await runLogin(oauth, action === 'again')
    },
  })
  ctx.commands.register({
    name: 'logout',
    description: 'Sign out of Cursor',
    async handler() {
      await oauth.logout()
      return { kind: 'success', text: '已退出 Cursor 登录。' }
    },
  })
}
