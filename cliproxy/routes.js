import { openInBrowser } from '../cursor/oauth.js'
import { FALLBACK_PROVIDER, PROXY_PROVIDERS, loginTargets, providerForChannel } from './providers.js'

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
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

function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function createSubscriptionsController({ supervisor, mgmt, catalog, cursorOauth, logger }) {
  let pluginsCache = { at: 0, items: [] }

  async function plugins() {
    if (Date.now() - pluginsCache.at < 60_000) return pluginsCache.items
    try {
      pluginsCache = { at: Date.now(), items: await mgmt.plugins() }
    } catch {
      pluginsCache = { at: Date.now(), items: pluginsCache.items }
    }
    return pluginsCache.items
  }

  async function overview() {
    const proxy = supervisor.status()
    const cursor = await cursorOauth.publicStatus().catch((error) => ({
      status: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    }))

    let accounts = []
    let managementError
    try {
      accounts = await mgmt.authFiles()
    } catch (error) {
      managementError = error instanceof Error ? error.message : String(error)
    }

    const targets = loginTargets(await plugins().catch(() => []))
    const canLogin = new Set(targets.map((target) => target.id))

    const modelOverview = await catalog.overview().catch(() => ({ providers: [], error: undefined }))
    const modelsByProvider = new Map(modelOverview.providers.map((entry) => [entry.id, entry.models]))

    const grouped = new Map()
    for (const file of accounts) {
      const providerId = providerForChannel(file.provider)
      if (!grouped.has(providerId)) grouped.set(providerId, [])
      grouped.get(providerId).push({
        name: file.name,
        email: file.email ?? file.account ?? '',
        status: file.status ?? '',
        statusMessage: file.status_message ?? '',
        disabled: file.disabled === true,
        unavailable: file.unavailable === true,
        provider: file.provider,
        source: file.source,
        success: file.success ?? 0,
        failed: file.failed ?? 0,
        lastRefresh: file.last_refresh ?? '',
      })
    }

    const providers = [...PROXY_PROVIDERS, FALLBACK_PROVIDER].map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      flow: descriptor.flow ?? 'redirect',
      canLogin: canLogin.has(descriptor.id),
      accounts: grouped.get(descriptor.id) ?? [],
      models: modelsByProvider.get(descriptor.id) ?? [],
    }))

    return {
      proxy,
      cursor,
      providers,
      managementError,
      catalogError: modelOverview.error,
    }
  }

  async function login(providerId) {
    if (providerId === 'cursor') {
      const started = await cursorOauth.startLogin()
      return { kind: 'cursor', url: started.loginUrl }
    }
    const targets = loginTargets(await plugins().catch(() => []))
    const target = targets.find((entry) => entry.id === providerId)
    if (!target) {
      throw new Error(`Provider "${providerId}" has no OAuth route. `
        + 'Gemini CLI / Qwen / iFlow 需要先在 CLIProxyAPI 插件商店安装对应插件。')
    }
    const started = await mgmt.startAuth(target.authPath)
    if (started?.url) {
      openInBrowser(started.url).catch((error) => {
        logger?.warn?.(`subscriptions: could not open browser: ${error instanceof Error ? error.message : error}`)
      })
    }
    return {
      kind: 'cliproxy',
      provider: providerId,
      url: started?.url,
      state: started?.state,
      flow: started?.flow ?? target.flow,
      userCode: started?.user_code,
      expiresIn: started?.expires_in,
    }
  }

  async function loginStatus(state) {
    const result = await mgmt.authStatus(state)
    if (result?.status === 'ok') catalog.invalidate()
    return result
  }

  async function logout(providerId, name) {
    if (providerId === 'cursor') {
      await cursorOauth.logout()
      return { removed: 'cursor' }
    }
    const files = await mgmt.authFiles()
    const matches = files.filter((file) => (
      providerForChannel(file.provider) === providerId
      && file.source !== 'memory'
      && (!name || file.name === name)
    ))
    for (const file of matches) {
      await mgmt.deleteAuthFile(file.name)
    }
    catalog.invalidate()
    return { removed: matches.map((file) => file.name) }
  }

  return { overview, login, loginStatus, logout, plugins }
}

export function createSubscriptionsHandler(controller, { supervisor, mgmt, catalog }) {
  return async function handle(req, res) {
    if (!isLoopbackHost(req)) {
      json(res, 403, { error: 'subscriptions API is only available on loopback' })
      return
    }
    const path = pathnameOf(req)
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (path === '/subscriptions' && method === 'GET') {
        html(res, 200, renderSubscriptionsPage())
        return
      }
      if (path === '/subscriptions/api/overview' && method === 'GET') {
        json(res, 200, await controller.overview())
        return
      }
      if (path === '/subscriptions/api/login' && method === 'POST') {
        const body = await readBody(req)
        json(res, 200, await controller.login(String(body.provider ?? '')))
        return
      }
      if (path === '/subscriptions/api/login/status' && method === 'GET') {
        const state = queryOf(req).get('state')
        json(res, 200, state ? await controller.loginStatus(state) : { status: 'error', error: 'missing state' })
        return
      }
      if (path === '/subscriptions/api/login/cancel' && method === 'POST') {
        const body = await readBody(req)
        json(res, 200, body.state ? await mgmt.cancelAuth(String(body.state)) : { status: 'ok' })
        return
      }
      if (path === '/subscriptions/api/logout' && method === 'POST') {
        const body = await readBody(req)
        json(res, 200, await controller.logout(String(body.provider ?? ''), body.name ? String(body.name) : undefined))
        return
      }
      if (path === '/subscriptions/api/account' && method === 'POST') {
        const body = await readBody(req)
        await mgmt.setAuthFileDisabled(String(body.name ?? ''), body.disabled === true)
        catalog.invalidate()
        json(res, 200, { ok: true })
        return
      }
      if (path === '/subscriptions/api/proxy/restart' && method === 'POST') {
        await supervisor.restart()
        json(res, 200, { ok: true, proxy: supervisor.status() })
        return
      }
      if (path === '/subscriptions/api/models' && method === 'GET') {
        json(res, 200, await catalog.overview())
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function registerSubscriptionRoutes(ctx, controller, deps) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/subscriptions',
    handler: createSubscriptionsHandler(controller, deps),
  })
}

function renderSubscriptionsPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>订阅 · DSH</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 32px 16px; min-height: 100vh;
      font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; background: #111214; color: #ececec; }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .sub { color: #9a9aa2; margin: 0 0 20px; }
    .card { border: 1px solid #2a2b2f; border-radius: 14px; background: #18191c; padding: 16px 18px; margin-bottom: 14px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .title { font-weight: 600; font-size: 15px; }
    .muted { color: #9a9aa2; font-size: 13px; }
    .ok { color: #8ee59b; } .warn { color: #ffce73; } .err { color: #ff8d85; }
    button { padding: 7px 13px; border-radius: 9px; border: 1px solid #3a3b40; background: #26272b;
      color: #ececec; font: inherit; cursor: pointer; }
    button.primary { background: #4f8cff; border-color: #4f8cff; color: #fff; font-weight: 600; }
    button:disabled { opacity: .5; cursor: default; }
    .accounts { margin: 10px 0 0; padding: 0; list-style: none; }
    .accounts li { display: flex; justify-content: space-between; align-items: center; gap: 10px;
      padding: 7px 0; border-top: 1px solid #232428; font-size: 13px; }
    code { color: #d7d7d7; background: #202126; border-radius: 6px; padding: 1px 6px; }
    .models { color: #7f8188; font-size: 12px; margin-top: 6px; word-break: break-all; }
    #pending { position: fixed; right: 16px; bottom: 16px; max-width: 340px; }
  </style>
</head>
<body>
  <main>
    <h1>订阅</h1>
    <p class="sub">通过 OAuth 复用你的 AI 编码订阅。管理密钥保存在 DSH 服务端，不会下发到浏览器。</p>
    <div id="app">加载中…</div>
  </main>
  <div id="pending"></div>
  <script>
    const app = document.getElementById('app');
    const pendingBox = document.getElementById('pending');
    let pendingLogin = null;

    async function api(path, options) {
      const res = await fetch(path, { headers: { accept: 'application/json' }, ...options });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.status);
      return data;
    }

    function el(tag, attrs, ...children) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs || {})) {
        if (key === 'class') node.className = value;
        else if (key === 'onclick') node.onclick = value;
        else node.setAttribute(key, value);
      }
      for (const child of children) {
        if (child == null) continue;
        node.append(child.nodeType ? child : document.createTextNode(child));
      }
      return node;
    }

    function phaseLabel(proxy) {
      const map = {
        running: ['运行中', 'ok'], starting: ['启动中…', 'warn'], installing: ['正在下载 CLIProxyAPI…', 'warn'],
        stopped: ['已停止', 'err'], error: ['错误', 'err'], idle: ['未启动', 'warn'],
        'external-ok': ['外部实例已连接', 'ok'], 'external-unreachable': ['外部实例不可达', 'err'],
      };
      return map[proxy.phase] || [proxy.phase, 'muted'];
    }

    async function doLogin(provider) {
      try {
        const started = await api('/subscriptions/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ provider }),
        });
        if (started.kind === 'cursor') {
          pendingLogin = { provider: 'cursor' };
          notify('已打开 Cursor 登录页，完成后本页会自动刷新。');
          return;
        }
        pendingLogin = { provider, state: started.state };
        let text = '已打开 ' + provider + ' 登录页。';
        if (started.userCode) text += ' 设备码：' + started.userCode;
        notify(text + ' 等待授权完成…');
        pollLogin();
      } catch (error) {
        notify('登录启动失败：' + error.message, true);
      }
    }

    async function pollLogin() {
      if (!pendingLogin || !pendingLogin.state) return;
      try {
        const result = await api('/subscriptions/api/login/status?state=' + encodeURIComponent(pendingLogin.state));
        if (result.status === 'ok') {
          notify('登录成功。');
          pendingLogin = null;
          refresh();
          return;
        }
        if (result.status === 'error') {
          notify('登录失败：' + (result.error || '未知错误'), true);
          pendingLogin = null;
          refresh();
          return;
        }
      } catch (error) {
        notify('登录状态查询失败：' + error.message, true);
      }
      setTimeout(pollLogin, 2000);
    }

    function notify(text, isError) {
      pendingBox.replaceChildren(el('div', { class: 'card' },
        el('span', { class: isError ? 'err' : 'muted' }, text)));
      if (!isError) setTimeout(() => pendingBox.replaceChildren(), 8000);
    }

    async function doLogout(provider, name) {
      if (!confirm('确定要退出该账号吗？')) return;
      try {
        await api('/subscriptions/api/logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ provider, name }),
        });
        refresh();
      } catch (error) {
        notify('退出失败：' + error.message, true);
      }
    }

    function render(data) {
      const [phaseText, phaseClass] = phaseLabel(data.proxy);
      const proxyCard = el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('div', {},
            el('div', { class: 'title' }, 'CLIProxyAPI'),
            el('div', { class: 'muted' },
              (data.proxy.mode === 'managed' ? '托管模式' : '外部模式') + ' · ' + data.proxy.baseUrl
              + (data.proxy.version ? ' · v' + data.proxy.version : '')
              + (data.proxy.pid ? ' · pid ' + data.proxy.pid : '')),
            el('div', { class: phaseClass }, phaseText + (data.proxy.error ? '：' + data.proxy.error : ''))),
          el('button', { onclick: () => api('/subscriptions/api/proxy/restart', { method: 'POST' }).then(refresh) }, '重启代理')));

      const cursorLoggedIn = data.cursor.status === 'logged-in';
      const cursorCard = el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('div', {},
            el('div', { class: 'title' }, 'Cursor'),
            el('div', { class: cursorLoggedIn ? 'ok' : 'muted' },
              cursorLoggedIn ? '已登录' + (data.cursor.email ? ' · ' + data.cursor.email : '') : '未登录')),
          cursorLoggedIn
            ? el('button', { onclick: () => doLogout('cursor') }, '退出')
            : el('button', { class: 'primary', onclick: () => doLogin('cursor') }, '登录')));

      const providerCards = data.providers.map((provider) => {
        const hasAccounts = provider.accounts.length > 0;
        const canLogin = provider.canLogin;
        const actions = [];
        if (canLogin) {
          actions.push(el('button', { class: hasAccounts ? '' : 'primary', onclick: () => doLogin(provider.id) },
            hasAccounts ? '再登录一个账号' : '登录'));
        }
        const accountRows = provider.accounts.map((account) => el('li', {},
          el('span', {},
            el('span', { class: account.unavailable || account.disabled ? 'err' : 'ok' }, account.disabled ? '⏸ ' : '● '),
            (account.email || account.name),
            ' ',
            el('span', { class: 'muted' }, account.status || '')),
          el('button', { onclick: () => doLogout(provider.id, account.name) }, '退出')));
        return el('div', { class: 'card' },
          el('div', { class: 'row' },
            el('div', {},
              el('div', { class: 'title' }, provider.label),
              el('div', { class: 'muted' },
                hasAccounts ? provider.accounts.length + ' 个账号' : (canLogin ? '未登录' : '需要 CLIProxyAPI 插件支持'))),
            el('div', {}, ...actions)),
          hasAccounts ? el('ul', { class: 'accounts' }, ...accountRows) : null,
          provider.models.length > 0
            ? el('div', { class: 'models' }, '模型：' + provider.models.slice(0, 12).join(', ')
              + (provider.models.length > 12 ? ' 等 ' + provider.models.length + ' 个' : ''))
            : null);
      });

      const notes = [];
      if (data.managementError) {
        notes.push(el('div', { class: 'card' },
          el('span', { class: 'err' }, '管理 API 不可用：' + data.managementError)));
      }
      app.replaceChildren(proxyCard, cursorCard, ...providerCards, ...notes);
    }

    async function refresh() {
      try {
        render(await api('/subscriptions/api/overview'));
      } catch (error) {
        app.replaceChildren(el('div', { class: 'card' }, el('span', { class: 'err' }, '加载失败：' + error.message)));
      }
    }

    refresh();
    setInterval(refresh, 15000);
  </script>
</body>
</html>`
}
