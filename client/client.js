window.__ModuleLoader__.load({
  id: 'dsh-subscriptions',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const h = react.createElement

    const palette = {
      text: '#ececec',
      muted: '#9a9aa2',
      faint: '#7f8188',
      ok: '#8ee59b',
      warn: '#ffce73',
      err: '#ff8d85',
      cardBg: '#18191c',
      cardBorder: '#2a2b2f',
      rowBorder: '#232428',
      accent: '#4f8cff',
      buttonBg: '#26272b',
      buttonBorder: '#3a3b40',
    }

    const styles = {
      root: { padding: '20px 24px 40px', maxWidth: 820, color: palette.text, font: '14px/1.6 ui-sans-serif, system-ui, sans-serif' },
      headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
      h1: { fontSize: 20, fontWeight: 700, margin: 0 },
      sub: { color: palette.muted, margin: '0 0 18px', fontSize: 13 },
      card: { border: `1px solid ${palette.cardBorder}`, borderRadius: 14, background: palette.cardBg, padding: '14px 16px', marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      title: { fontWeight: 600, fontSize: 15 },
      muted: { color: palette.muted, fontSize: 13 },
      faint: { color: palette.faint, fontSize: 12, marginTop: 6, wordBreak: 'break-all' },
      ok: { color: palette.ok },
      warn: { color: palette.warn },
      err: { color: palette.err },
      button: {
        padding: '6px 12px', borderRadius: 9, border: `1px solid ${palette.buttonBorder}`,
        background: palette.buttonBg, color: palette.text, font: 'inherit', cursor: 'pointer',
      },
      primaryButton: {
        padding: '6px 12px', borderRadius: 9, border: `1px solid ${palette.accent}`,
        background: palette.accent, color: '#fff', font: 'inherit', fontWeight: 600, cursor: 'pointer',
      },
      accountRow: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
        padding: '7px 0', borderTop: `1px solid ${palette.rowBorder}`, fontSize: 13,
      },
      code: { color: '#d7d7d7', background: '#202126', borderRadius: 6, padding: '1px 6px', fontFamily: 'ui-monospace, monospace' },
      notice: { marginTop: 10, fontSize: 13 },
    }

    async function api(path, options) {
      const response = await fetch(path, { headers: { accept: 'application/json' }, ...options })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    function phaseDescriptor(proxy) {
      const map = {
        running: ['运行中', styles.ok],
        starting: ['启动中…', styles.warn],
        installing: ['正在下载 CLIProxyAPI…', styles.warn],
        stopped: ['已停止', styles.err],
        error: ['错误', styles.err],
        idle: ['未启动', styles.warn],
        'external-ok': ['外部实例已连接', styles.ok],
        'external-unreachable': ['外部实例不可达', styles.err],
      }
      return map[proxy?.phase] || [proxy?.phase || '未知', styles.muted]
    }

    function Button({ primary, onClick, disabled, children }) {
      return h('button', {
        style: { ...primary ? styles.primaryButton : styles.button, ...disabled ? { opacity: 0.5, cursor: 'default' } : {} },
        disabled,
        onClick,
      }, children)
    }

    function SubscriptionsSection() {
      const [data, setData] = react.useState(undefined)
      const [error, setError] = react.useState(undefined)
      const [notice, setNotice] = react.useState(undefined)
      const [pending, setPending] = react.useState(undefined)
      const [busy, setBusy] = react.useState('')
      const aliveRef = react.useRef(true)
      const pendingRef = react.useRef(undefined)
      pendingRef.current = pending

      const refresh = react.useCallback(async () => {
        try {
          const next = await api('/subscriptions/api/overview')
          if (!aliveRef.current) return
          setData(next)
          setError(undefined)
        } catch (cause) {
          if (!aliveRef.current) return
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      react.useEffect(() => {
        aliveRef.current = true
        refresh()
        const timer = setInterval(refresh, 12_000)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
        }
      }, [refresh])

      react.useEffect(() => {
        if (!pending?.state) return undefined
        let cancelled = false
        const tick = async () => {
          if (cancelled || pendingRef.current?.state !== pending.state) return
          try {
            const result = await api(`/subscriptions/api/login/status?state=${encodeURIComponent(pending.state)}`)
            if (cancelled) return
            if (result.status === 'ok') {
              setNotice({ text: `${pending.label} 登录成功`, kind: 'ok' })
              setPending(undefined)
              refresh()
              return
            }
            if (result.status === 'error') {
              setNotice({ text: `${pending.label} 登录失败：${result.error || '未知错误'}`, kind: 'err' })
              setPending(undefined)
              refresh()
              return
            }
          } catch (cause) {
            if (cancelled) return
            setNotice({ text: `登录状态查询失败：${cause.message}`, kind: 'err' })
          }
          setTimeout(tick, 2_000)
        }
        const timer = setTimeout(tick, 1_500)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [pending, refresh])

      const login = async (provider, label) => {
        setBusy(`login:${provider}`)
        setNotice(undefined)
        try {
          const started = await post('/subscriptions/api/login', { provider })
          if (started.kind === 'cursor') {
            setNotice({ text: '已打开 Cursor 登录页，完成后回到这里即可。', kind: 'ok' })
            setTimeout(refresh, 4_000)
            return
          }
          setPending({
            provider,
            label,
            state: started.state,
            userCode: started.userCode,
            url: started.url,
            flow: started.flow,
          })
        } catch (cause) {
          setNotice({ text: `登录启动失败：${cause.message}`, kind: 'err' })
        } finally {
          setBusy('')
        }
      }

      const logout = async (provider, name, label) => {
        setBusy(`logout:${provider}:${name ?? ''}`)
        try {
          await post('/subscriptions/api/logout', { provider, name })
          setNotice({ text: `${label} 已退出`, kind: 'ok' })
          await refresh()
        } catch (cause) {
          setNotice({ text: `退出失败：${cause.message}`, kind: 'err' })
        } finally {
          setBusy('')
        }
      }

      const restartProxy = async () => {
        setBusy('proxy:restart')
        try {
          await post('/subscriptions/api/proxy/restart')
          setNotice({ text: '代理已重启', kind: 'ok' })
          await refresh()
        } catch (cause) {
          setNotice({ text: `重启失败：${cause.message}`, kind: 'err' })
        } finally {
          setBusy('')
        }
      }

      const header = h('div', null,
        h('div', { style: styles.headRow },
          h('h1', { style: styles.h1 }, '订阅'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { onClick: refresh }, '刷新'),
            h(Button, { onClick: () => window.open('/subscriptions', '_blank') }, '独立页面'))),
        h('p', { style: styles.sub }, '通过 OAuth 复用 Cursor、Claude Code、Codex、Antigravity、Kimi、Grok 等订阅。登录凭证由本机 CLIProxyAPI 保管。'))

      if (error && !data) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.card }, h('span', { style: styles.err }, `加载失败：${error}`)),
          h('div', { style: styles.muted }, '也可以直接打开 /subscriptions 独立页面。'))
      }
      if (!data) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.card }, h('span', { style: styles.muted }, '加载中…')))
      }

      const [phaseText, phaseStyle] = phaseDescriptor(data.proxy)
      const proxyCard = h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('div', null,
            h('div', { style: styles.title }, 'CLIProxyAPI 代理'),
            h('div', { style: styles.muted },
              `${data.proxy.mode === 'managed' ? '托管模式' : '外部模式'} · ${data.proxy.baseUrl}`
              + (data.proxy.version ? ` · v${data.proxy.version}` : '')
              + (data.proxy.pid ? ` · pid ${data.proxy.pid}` : '')),
            h('div', { style: phaseStyle }, phaseText + (data.proxy.error ? `：${data.proxy.error}` : ''))),
          h(Button, { onClick: restartProxy, disabled: busy === 'proxy:restart' }, '重启代理')))

      const cursorLoggedIn = data.cursor?.status === 'logged-in'
      const cursorCard = h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('div', null,
            h('div', { style: styles.title }, 'Cursor'),
            h('div', { style: cursorLoggedIn ? styles.ok : styles.muted },
              cursorLoggedIn
                ? `已登录${data.cursor.email ? ` · ${data.cursor.email}` : ''}`
                : '未登录')),
          cursorLoggedIn
            ? h(Button, { onClick: () => logout('cursor', undefined, 'Cursor'), disabled: busy.startsWith('logout:cursor') }, '退出')
            : h(Button, { primary: true, onClick: () => login('cursor', 'Cursor'), disabled: busy === 'login:cursor' }, '登录')))

      const providerCards = (data.providers ?? []).map((provider) => {
        const hasAccounts = provider.accounts.length > 0
        const isPending = pending?.provider === provider.id
        const accountRows = provider.accounts.map((account) => h('div', { key: account.name, style: styles.accountRow },
          h('span', null,
            h('span', { style: account.disabled || account.unavailable ? styles.err : styles.ok },
              account.disabled ? '⏸ ' : '● '),
            account.email || account.name,
            ' ',
            h('span', { style: styles.muted }, account.status || '')),
          h(Button, {
            onClick: () => logout(provider.id, account.name, `${provider.label} · ${account.email || account.name}`),
            disabled: busy === `logout:${provider.id}:${account.name}`,
          }, '退出')))

        return h('div', { key: provider.id, style: styles.card },
          h('div', { style: styles.row },
            h('div', null,
              h('div', { style: styles.title }, provider.label),
              h('div', { style: styles.muted },
                hasAccounts
                  ? `${provider.accounts.length} 个账号`
                  : provider.canLogin ? '未登录' : '需要先在 CLIProxyAPI 安装对应插件')),
            provider.canLogin
              ? h(Button, {
                primary: !hasAccounts,
                onClick: () => login(provider.id, provider.label),
                disabled: busy === `login:${provider.id}` || isPending,
              }, hasAccounts ? '再登录一个' : '登录')
              : null),
          accountRows.length > 0 ? h('div', { style: { marginTop: 8 } }, accountRows) : null,
          isPending
            ? h('div', { style: { ...styles.notice, ...styles.warn } },
              '等待浏览器授权完成…',
              pending.userCode ? h('span', null, ' 设备码：', h('span', { style: styles.code }, pending.userCode)) : null,
              pending.url
                ? h('span', null, ' ',
                  h('a', { href: pending.url, target: '_blank', rel: 'noreferrer', style: { color: palette.accent } }, '重新打开登录页'))
                : null)
            : null,
          provider.models?.length > 0
            ? h('div', { style: styles.faint },
              `模型：${provider.models.slice(0, 10).join(', ')}${provider.models.length > 10 ? ` 等 ${provider.models.length} 个` : ''}`)
            : null)
      })

      const notes = []
      if (data.managementError) {
        notes.push(h('div', { key: 'mgmt-error', style: styles.card },
          h('span', { style: styles.err }, `管理 API 不可用：${data.managementError}`)))
      }
      if (notice) {
        notes.push(h('div', { key: 'notice', style: styles.card },
          h('span', { style: notice.kind === 'err' ? styles.err : styles.ok }, notice.text)))
      }

      return h('div', { style: styles.root }, header, proxyCard, cursorCard, providerCards, notes)
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'subscriptions',
        order: 30,
        label: () => '订阅',
      }, SubscriptionsSection))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
