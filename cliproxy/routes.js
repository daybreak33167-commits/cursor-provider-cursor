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
      const removed = await cursorOauth.logout(name)
      return { removed: name ? [name] : [`cursor (${removed} 个账号)`] }
    }
    const files = await mgmt.authFiles()
    const matches = files.filter((file) => (
      providerForChannel(file.provider) === providerId
      && file.source !== 'memory'
      && (!name || file.name === name || file.email === name)
    ))
    for (const file of matches) {
      await mgmt.deleteAuthFile(file.name)
    }
    catalog.invalidate()
    return { removed: matches.map((file) => file.name) }
  }

  async function setAccountDisabled(providerId, name, disabled) {
    if (providerId === 'cursor') {
      await cursorOauth.setAccountDisabled(name, disabled)
      return
    }
    await mgmt.setAuthFileDisabled(name, disabled)
    catalog.invalidate()
  }

  return { overview, login, loginStatus, logout, setAccountDisabled, plugins }
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
        await controller.setAccountDisabled(
          String(body.provider ?? ''),
          String(body.name ?? ''),
          body.disabled === true,
        )
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
    :root { color-scheme: light dark; }
    body {
      --bg: rgb(249, 250, 251); --card: #fff; --text: rgb(21, 21, 23);
      --muted: rgb(97, 102, 107); --faint: rgb(129, 133, 140);
      --border: rgba(0, 0, 0, .1); --row: rgba(0, 0, 0, .06);
      --accent: rgb(65, 118, 230);
      --ok: rgb(34, 197, 94); --warn: rgb(221, 134, 41); --err: rgb(236, 19, 19);
      --btn: #fff; --btn-border: rgba(0, 0, 0, .14);
      --tab-active: rgb(235, 238, 242); --tab-border: rgba(0, 0, 0, .18);
      --code: rgba(0, 0, 0, .06);
    }
    @media (prefers-color-scheme: dark) {
      body {
        --bg: rgb(21, 21, 23); --card: rgb(35, 35, 36); --text: rgb(249, 250, 251);
        --muted: rgb(207, 211, 214); --faint: rgb(151, 157, 166);
        --border: rgba(255, 255, 255, .12); --row: rgba(255, 255, 255, .08);
        --accent: rgb(86, 134, 254);
        --ok: rgb(78, 209, 126); --warn: rgb(247, 173, 49); --err: rgb(242, 90, 90);
        --btn: rgb(67, 69, 74); --btn-border: rgba(255, 255, 255, .16);
        --tab-active: rgb(53, 54, 56); --tab-border: rgba(255, 255, 255, .2);
        --code: rgba(255, 255, 255, .1);
      }
    }
    body { margin: 0; padding: 32px 16px; min-height: 100vh;
      font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .sub { color: var(--muted); margin: 0 0 18px; }
    .card { border: 1px solid var(--border); border-radius: 14px; background: var(--card); padding: 16px 18px; margin-bottom: 14px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .title { font-weight: 600; font-size: 15px; }
    .muted { color: var(--muted); font-size: 13px; }
    .faint { color: var(--faint); font-size: 12px; margin-top: 8px; word-break: break-all; }
    .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
    button { padding: 7px 13px; border-radius: 9px; border: 1px solid var(--btn-border); background: var(--btn);
      color: var(--text); font: inherit; cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    button.small { padding: 3px 10px; border-radius: 8px; font-size: 12px; }
    button:disabled { opacity: .5; cursor: default; }
    .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
    .tabs button { padding: 5px 14px; border-radius: 999px; border: 1px solid transparent;
      background: transparent; color: var(--muted); font-size: 13px; }
    .tabs button.active { border-color: var(--tab-border); background: var(--tab-active); color: var(--text); font-weight: 600; }
    .accounts { margin: 10px 0 0; padding: 0; list-style: none; }
    .accounts li { display: flex; justify-content: space-between; align-items: center; gap: 10px;
      padding: 8px 0; border-top: 1px solid var(--row); font-size: 13px; flex-wrap: wrap; }
    .accounts .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .accounts .actions { display: flex; align-items: center; gap: 6px; }
    .stats { color: var(--faint); font-size: 12px; }
    code { color: var(--text); background: var(--code); border-radius: 6px; padding: 1px 6px; }
    #pending { position: fixed; right: 16px; bottom: 16px; max-width: 340px; }
  </style>
</head>
<body>
  <main>
    <h1>订阅</h1>
    <p class="sub">通过 OAuth 复用你的 AI 编码订阅。同一供应商可添加多个账号，请求自动轮询负载均衡。</p>
    <div id="app">加载中…</div>
  </main>
  <div id="pending"></div>
  <script>
    const app = document.getElementById('app');
    const pendingBox = document.getElementById('pending');
    let pendingLogin = null;
    let currentTab = null;
    let lastData = null;

    async function api(path, options) {
      const res = await fetch(path, { headers: { accept: 'application/json' }, ...options });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.status);
      return data;
    }

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      });
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
        const started = await post('/subscriptions/api/login', { provider });
        if (started.kind === 'cursor') {
          pendingLogin = { provider: 'cursor' };
          notify('已打开 Cursor 登录页，完成后本页会自动刷新。');
          setTimeout(refresh, 5000);
          return;
        }
        pendingLogin = { provider, state: started.state };
        let text = '已打开登录页。';
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

    async function doLogout(provider, name, label) {
      if (!confirm('确定退出 ' + label + ' 吗？')) return;
      try {
        await post('/subscriptions/api/logout', { provider, name });
        refresh();
      } catch (error) {
        notify('退出失败：' + error.message, true);
      }
    }

    async function doToggle(provider, name, disabled) {
      try {
        await post('/subscriptions/api/account', { provider, name, disabled });
        refresh();
      } catch (error) {
        notify('操作失败：' + error.message, true);
      }
    }

    function tabsOf(data) {
      const cursorCount = (data.cursor.accounts || []).length || (data.cursor.status === 'logged-in' ? 1 : 0);
      const tabs = [{ id: 'cursor', label: 'Cursor', count: cursorCount }];
      for (const provider of data.providers) {
        if (provider.id === 'cliproxy' && provider.accounts.length === 0 && provider.models.length === 0) continue;
        tabs.push({ id: provider.id, label: provider.label, count: provider.accounts.length });
      }
      return tabs;
    }

    function cursorPanel(data) {
      const accounts = data.cursor.accounts || [];
      const count = accounts.length;
      const rows = accounts.map((account) => {
        const label = account.email || '未知邮箱';
        const dotClass = account.disabled || account.coolingDown ? 'warn' : account.expired ? 'err' : 'ok';
        const dot = account.disabled ? '⏸ ' : account.expired ? '✕ ' : '● ';
        const meta = el('span', { class: 'meta' },
          el('span', { class: dotClass }, dot),
          el('span', {}, label));
        if (account.expired) meta.append(el('span', { class: 'err' }, '密钥已过期，重新添加即可'));
        if (account.coolingDown) meta.append(el('span', { class: 'warn' }, '鉴权失败冷却中'));
        if (account.disabled) meta.append(el('span', { class: 'warn' }, '已停用'));
        return el('li', {},
          meta,
          el('span', { class: 'actions' },
            el('button', { class: 'small', onclick: () => doToggle('cursor', account.email, !account.disabled) },
              account.disabled ? '启用' : '停用'),
            el('button', { class: 'small', onclick: () => doLogout('cursor', account.email, 'Cursor · ' + label) }, '退出')));
      });
      return el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('div', {},
            el('div', { class: 'title' }, 'Cursor'),
            el('div', { class: 'muted' }, count > 0 ? count + ' 个账号 · 新会话自动轮询' : '未登录')),
          el('button', { class: count === 0 ? 'primary' : '', onclick: () => doLogin('cursor') },
            count > 0 ? '添加账号' : '登录')),
        rows.length > 0 ? el('ul', { class: 'accounts' }, ...rows) : null,
        el('div', { class: 'faint' },
          '添加另一个账号前，先在浏览器退出 cursor.com（或用隐身窗口）再授权；同一邮箱重复登录只会刷新密钥。'));
    }

    function providerPanel(provider) {
      const count = provider.accounts.length;
      const rows = provider.accounts.map((account) => {
        const label = account.email || account.name;
        const dotClass = account.disabled ? 'warn' : account.unavailable ? 'err' : 'ok';
        const dot = account.disabled ? '⏸ ' : account.unavailable ? '✕ ' : '● ';
        const meta = el('span', { class: 'meta' },
          el('span', { class: dotClass }, dot),
          el('span', {}, label));
        if (account.status) meta.append(el('span', { class: 'muted' }, account.status));
        if (account.disabled) meta.append(el('span', { class: 'warn' }, '已停用'));
        if (account.success || account.failed) {
          meta.append(el('span', { class: 'stats' }, '成功 ' + (account.success || 0) + ' · 失败 ' + (account.failed || 0)));
        }
        return el('li', {},
          meta,
          el('span', { class: 'actions' },
            el('button', { class: 'small', onclick: () => doToggle(provider.id, account.name, !account.disabled) },
              account.disabled ? '启用' : '停用'),
            el('button', { class: 'small', onclick: () => doLogout(provider.id, account.name, provider.label + ' · ' + label) }, '退出')));
      });

      return el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('div', {},
            el('div', { class: 'title' }, provider.label),
            el('div', { class: 'muted' },
              count > 0
                ? count + ' 个账号 · 请求自动轮询'
                : provider.canLogin
                  ? '未登录' + (provider.flow === 'device' ? ' · 设备码流程' : '')
                  : '需要先在 CLIProxyAPI 插件商店安装对应插件')),
          provider.canLogin
            ? el('button', { class: count === 0 ? 'primary' : '', onclick: () => doLogin(provider.id) },
              count > 0 ? '添加账号' : '登录')
            : null),
        rows.length > 0 ? el('ul', { class: 'accounts' }, ...rows) : null,
        provider.models.length > 0
          ? el('div', { class: 'faint' }, '模型 ' + provider.models.length + ' 个：'
            + provider.models.slice(0, 12).join(', ') + (provider.models.length > 12 ? ' …' : ''))
          : null);
    }

    function render(data) {
      lastData = data;
      const [phaseText, phaseClass] = phaseLabel(data.proxy);
      const proxyStrip = el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('div', {},
            el('span', { class: 'title' }, 'CLIProxyAPI'),
            el('span', { class: 'muted', style: 'margin-left:10px' },
              (data.proxy.mode === 'managed' ? '托管' : '外部') + ' · ' + data.proxy.baseUrl
              + (data.proxy.version ? ' · v' + data.proxy.version : '')),
            el('span', { class: phaseClass, style: 'margin-left:10px;font-size:13px' },
              phaseText + (data.proxy.error ? '：' + data.proxy.error : ''))),
          el('button', { onclick: () => post('/subscriptions/api/proxy/restart').then(refresh) }, '重启代理')));

      const tabs = tabsOf(data);
      if (!currentTab || !tabs.some((tab) => tab.id === currentTab)) {
        const active = tabs.find((tab) => tab.count > 0) || tabs[0];
        currentTab = active.id;
      }
      const tabBar = el('div', { class: 'tabs' }, ...tabs.map((tab) => el('button', {
        class: currentTab === tab.id ? 'active' : '',
        onclick: () => { currentTab = tab.id; render(lastData); },
      }, tab.count > 0 ? tab.label + ' (' + tab.count + ')' : tab.label)));

      const provider = data.providers.find((entry) => entry.id === currentTab);
      const panel = currentTab === 'cursor' ? cursorPanel(data) : provider ? providerPanel(provider) : null;

      const notes = [];
      if (data.managementError) {
        notes.push(el('div', { class: 'card' },
          el('span', { class: 'err' }, '管理 API 不可用：' + data.managementError)));
      }
      app.replaceChildren(proxyStrip, tabBar, ...[panel, ...notes].filter(Boolean));
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
