window.__ModuleLoader__.load({
  id: 'dsh-subscriptions',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const h = react.createElement

    // Follow the host theme: DSH exposes design tokens as --dsw-* CSS
    // variables on <body> (light by default, dark under [data-ds-dark-theme]).
    const v = (name, fallback) => `var(${name}, ${fallback})`
    const palette = {
      text: v('--dsw-alias-label-primary', 'rgb(21, 21, 23)'),
      muted: v('--dsw-alias-label-secondary', 'rgb(97, 102, 107)'),
      faint: v('--dsw-alias-label-tertiary', 'rgb(129, 133, 140)'),
      ok: v('--dsw-alias-state-success-primary', 'rgb(34, 197, 94)'),
      warn: v('--dsw-alias-state-warn-label', 'rgb(221, 134, 41)'),
      err: v('--dsw-alias-state-error-primary', 'rgb(236, 19, 19)'),
      cardBg: v('--dsw-alias-bg-layer-1', 'transparent'),
      cardBorder: v('--dsw-alias-border-l2', 'rgba(0, 0, 0, 0.1)'),
      rowBorder: v('--dsw-alias-border-l1', 'rgba(0, 0, 0, 0.06)'),
      accent: v('--dsw-alias-button-info-fill', 'rgb(65, 118, 230)'),
      buttonBg: v('--dsw-alias-button-elevated-fill', '#fff'),
      buttonBorder: v('--dsw-alias-border-l3', 'rgba(0, 0, 0, 0.12)'),
      tabActiveBg: v('--dsw-alias-button-ghost-active-fill', 'rgba(38, 49, 72, 0.08)'),
      tabActiveBorder: v('--dsw-alias-button-ghost-active-border', 'rgba(0, 0, 0, 0.18)'),
      codeBg: v('--dsw-alias-markdown-inline-code', 'rgba(0, 0, 0, 0.06)'),
    }

    const styles = {
      root: { padding: '20px 24px 40px', maxWidth: 860, color: palette.text, fontSize: 14, lineHeight: 1.6 },
      headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
      h1: { fontSize: 20, fontWeight: 700, margin: 0 },
      sub: { color: palette.muted, margin: '0 0 16px', fontSize: 13 },
      card: { border: `1px solid ${palette.cardBorder}`, borderRadius: 14, background: palette.cardBg, padding: '14px 16px', marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      title: { fontWeight: 600, fontSize: 15 },
      muted: { color: palette.muted, fontSize: 13 },
      faint: { color: palette.faint, fontSize: 12, marginTop: 8, wordBreak: 'break-all' },
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
      smallButton: {
        padding: '3px 10px', borderRadius: 8, border: `1px solid ${palette.buttonBorder}`,
        background: palette.buttonBg, color: palette.text, font: 'inherit', fontSize: 12, cursor: 'pointer',
      },
      tabBar: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '2px 0 12px' },
      tab: {
        padding: '5px 14px', borderRadius: 999, border: '1px solid transparent',
        background: 'transparent', color: palette.muted, font: 'inherit', fontSize: 13, cursor: 'pointer',
      },
      tabActive: {
        border: `1px solid ${palette.tabActiveBorder}`, background: palette.tabActiveBg,
        color: palette.text, fontWeight: 600,
      },
      accountRow: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
        padding: '8px 0', borderTop: `1px solid ${palette.rowBorder}`, fontSize: 13, flexWrap: 'wrap',
      },
      accountMeta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      accountActions: { display: 'flex', alignItems: 'center', gap: 6 },
      stats: { color: palette.faint, fontSize: 12 },
      code: { color: palette.text, background: palette.codeBg, borderRadius: 6, padding: '1px 6px', fontFamily: 'ui-monospace, monospace' },
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

    function Button({ primary, small, onClick, disabled, children }) {
      const base = small ? styles.smallButton : primary ? styles.primaryButton : styles.button
      return h('button', {
        style: { ...base, ...disabled ? { opacity: 0.5, cursor: 'default' } : {} },
        disabled,
        onClick,
      }, children)
    }

    function tabsOf(data) {
      const cursorCount = data.cursor?.accounts?.length ?? (data.cursor?.status === 'logged-in' ? 1 : 0)
      const tabs = [{ id: 'cursor', label: 'Cursor', count: cursorCount }]
      for (const provider of data.providers ?? []) {
        if (provider.id === 'cliproxy' && provider.accounts.length === 0 && (provider.models?.length ?? 0) === 0) continue
        tabs.push({ id: provider.id, label: provider.label, count: provider.accounts.length })
      }
      return tabs
    }

    function SubscriptionsSection() {
      const [data, setData] = react.useState(undefined)
      const [error, setError] = react.useState(undefined)
      const [notice, setNotice] = react.useState(undefined)
      const [pending, setPending] = react.useState(undefined)
      const [busy, setBusy] = react.useState('')
      const [tab, setTab] = react.useState(undefined)
      const [factoryToken, setFactoryToken] = react.useState('')
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

      // Pick the initial tab once: first provider that has accounts.
      react.useEffect(() => {
        if (tab || !data) return
        const tabs = tabsOf(data)
        const active = tabs.find((entry) => entry.count > 0) || tabs[0]
        setTab(active.id)
      }, [data, tab])

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

      const cancelLogin = async () => {
        const current = pendingRef.current
        setPending(undefined)
        if (current?.state) await post('/subscriptions/api/login/cancel', { state: current.state }).catch(() => {})
      }

      const logout = async (provider, name, label) => {
        if (!window.confirm(`确定退出 ${label} 吗？`)) return
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

      const toggleAccount = async (provider, name, disabled) => {
        setBusy(`account:${name}`)
        try {
          await post('/subscriptions/api/account', { provider, name, disabled })
          await refresh()
        } catch (cause) {
          setNotice({ text: `操作失败：${cause.message}`, kind: 'err' })
        } finally {
          setBusy('')
        }
      }

      const factoryAdd = async (mode) => {
        const value = factoryToken.trim()
        if (mode !== 'import' && !value) {
          setNotice({ text: '请先粘贴 refresh token 或 API Key。', kind: 'err' })
          return
        }
        setBusy(`factory:${mode}`)
        setNotice({ text: mode === 'import' ? '正在从 droid CLI 导入…' : '正在验证并添加…', kind: 'ok' })
        try {
          const result = await post('/subscriptions/api/factory/add', { mode, value })
          setNotice({ text: `已添加 Factory 账号：${result.email || ''}，模型稍后出现在模型选择器。`, kind: 'ok' })
          setFactoryToken('')
          await refresh()
        } catch (cause) {
          setNotice({ text: `添加失败：${cause.message}`, kind: 'err' })
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
        h('p', { style: styles.sub }, '通过 OAuth 复用你的 AI 编码订阅。同一供应商可添加多个账号，请求自动轮询负载均衡。'))

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
      const proxyStrip = h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('div', null,
            h('span', { style: styles.title }, 'CLIProxyAPI'),
            h('span', { style: { ...styles.muted, marginLeft: 10 } },
              `${data.proxy.mode === 'managed' ? '托管' : '外部'} · ${data.proxy.baseUrl}`
              + (data.proxy.version ? ` · v${data.proxy.version}` : '')),
            h('span', { style: { ...phaseStyle, marginLeft: 10, fontSize: 13 } },
              phaseText + (data.proxy.error ? `：${data.proxy.error}` : ''))),
          h(Button, { onClick: restartProxy, disabled: busy === 'proxy:restart' }, '重启代理')))

      const tabs = tabsOf(data)
      const activeTab = tabs.some((entry) => entry.id === tab) ? tab : tabs[0].id
      const tabBar = h('div', { style: styles.tabBar }, tabs.map((entry) => h('button', {
        key: entry.id,
        style: { ...styles.tab, ...(activeTab === entry.id ? styles.tabActive : {}) },
        onClick: () => setTab(entry.id),
      }, entry.count > 0 ? `${entry.label} (${entry.count})` : entry.label)))

      const pendingNotice = (providerId) => (pending?.provider === providerId
        ? h('div', { style: { ...styles.notice, ...styles.warn } },
          '等待浏览器授权完成…',
          pending.userCode ? h('span', null, ' 设备码：', h('span', { style: styles.code }, pending.userCode)) : null,
          pending.url
            ? h('span', null, ' ',
              h('a', { href: pending.url, target: '_blank', rel: 'noreferrer', style: { color: palette.accent } }, '重新打开登录页'))
            : null,
          ' ',
          h(Button, { small: true, onClick: cancelLogin }, '取消'))
        : null)

      function cursorPanel() {
        const accounts = data.cursor?.accounts ?? []
        const count = accounts.length
        const rows = accounts.map((account) => {
          const label = account.email || '未知邮箱'
          const stateStyle = account.disabled || account.coolingDown
            ? styles.warn
            : account.expired ? styles.err : styles.ok
          const dot = account.disabled ? '⏸ ' : account.expired ? '✕ ' : '● '
          return h('div', { key: label + (account.addedAt ?? ''), style: styles.accountRow },
            h('span', { style: styles.accountMeta },
              h('span', { style: stateStyle }, dot),
              h('span', null, label),
              account.expired ? h('span', { style: styles.err }, '密钥已过期，重新添加即可') : null,
              account.coolingDown ? h('span', { style: styles.warn }, '鉴权失败冷却中') : null,
              account.disabled ? h('span', { style: styles.warn }, '已停用') : null),
            h('span', { style: styles.accountActions },
              h(Button, {
                small: true,
                onClick: () => toggleAccount('cursor', account.email, !account.disabled),
                disabled: busy === `account:${account.email}`,
              }, account.disabled ? '启用' : '停用'),
              h(Button, {
                small: true,
                onClick: () => logout('cursor', account.email, `Cursor · ${label}`),
                disabled: busy === `logout:cursor:${account.email}`,
              }, '退出')))
        })
        return h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('div', null,
              h('div', { style: styles.title }, 'Cursor'),
              h('div', { style: styles.muted }, count > 0 ? `${count} 个账号 · 新会话自动轮询` : '未登录')),
            h(Button, {
              primary: count === 0,
              onClick: () => login('cursor', 'Cursor'),
              disabled: busy === 'login:cursor',
            }, count > 0 ? '添加账号' : '登录')),
          rows.length > 0 ? h('div', { style: { marginTop: 8 } }, rows) : null,
          h('div', { style: styles.faint },
            '添加另一个账号前，先在浏览器退出 cursor.com（或用隐身窗口）再授权；同一邮箱重复登录只会刷新密钥。请求按新会话在账号间轮询，鉴权失败自动冷却换号。'))
      }

      function providerPanel(provider) {
        const count = provider.accounts.length
        const accountRows = provider.accounts.map((account) => {
          const label = account.email || account.name
          const stateStyle = account.disabled ? styles.warn : account.unavailable ? styles.err : styles.ok
          const stateDot = account.disabled ? '⏸ ' : account.unavailable ? '✕ ' : '● '
          const stats = (account.success || account.failed)
            ? `成功 ${account.success ?? 0} · 失败 ${account.failed ?? 0}`
            : ''
          return h('div', { key: account.name, style: styles.accountRow },
            h('span', { style: styles.accountMeta },
              h('span', { style: stateStyle }, stateDot),
              h('span', null, label),
              account.status ? h('span', { style: styles.muted }, account.status) : null,
              account.disabled ? h('span', { style: styles.warn }, '已停用') : null,
              stats ? h('span', { style: styles.stats }, stats) : null),
            h('span', { style: styles.accountActions },
              h(Button, {
                small: true,
                onClick: () => toggleAccount(provider.id, account.name, !account.disabled),
                disabled: busy === `account:${account.name}`,
              }, account.disabled ? '启用' : '停用'),
              h(Button, {
                small: true,
                onClick: () => logout(provider.id, account.name, `${provider.label} · ${label}`),
                disabled: busy === `logout:${provider.id}:${account.name}`,
              }, '退出')))
        })

        return h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('div', null,
              h('div', { style: styles.title }, provider.label),
              h('div', { style: styles.muted },
                count > 0
                  ? `${count} 个账号 · 请求自动轮询`
                  : provider.canLogin
                    ? `未登录${provider.flow === 'device' ? ' · 设备码流程' : ''}`
                    : '需要先在 CLIProxyAPI 插件商店安装对应插件')),
            provider.canLogin
              ? h(Button, {
                primary: count === 0,
                onClick: () => login(provider.id, provider.label),
                disabled: busy === `login:${provider.id}` || pending?.provider === provider.id,
              }, count > 0 ? '添加账号' : '登录')
              : null),
          accountRows.length > 0 ? h('div', { style: { marginTop: 8 } }, accountRows) : null,
          pendingNotice(provider.id),
          provider.models?.length > 0
            ? h('div', { style: styles.faint },
              `模型 ${provider.models.length} 个：${provider.models.slice(0, 10).join(', ')}${provider.models.length > 10 ? ' …' : ''}`)
            : null)
      }

      function factoryPanel(provider) {
        const count = provider.accounts.length
        const accountRows = provider.accounts.map((account) => {
          const label = account.email || account.name
          const stateStyle = account.disabled ? styles.warn : account.unavailable ? styles.err : styles.ok
          const stateDot = account.disabled ? '⏸ ' : account.unavailable ? '✕ ' : '● '
          return h('div', { key: account.name, style: styles.accountRow },
            h('span', { style: styles.accountMeta },
              h('span', { style: stateStyle }, stateDot),
              h('span', null, label),
              account.status ? h('span', { style: styles.muted }, account.status) : null,
              account.statusMessage ? h('span', { style: styles.err }, account.statusMessage) : null,
              account.disabled ? h('span', { style: styles.warn }, '已停用') : null),
            h('span', { style: styles.accountActions },
              h(Button, {
                small: true,
                onClick: () => toggleAccount('factory', account.name, !account.disabled),
                disabled: busy === `account:${account.name}`,
              }, account.disabled ? '启用' : '停用'),
              h(Button, {
                small: true,
                onClick: () => logout('factory', account.name, `Factory Droid · ${label}`),
                disabled: busy === `logout:factory:${account.name}`,
              }, '退出')))
        })

        const inputStyle = {
          flex: 1, minWidth: 220, padding: '6px 10px', borderRadius: 9,
          border: `1px solid ${palette.buttonBorder}`, background: palette.buttonBg,
          color: palette.text, font: 'inherit', fontSize: 13,
        }
        const addRow = h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' } },
          h('input', {
            type: 'password',
            placeholder: '粘贴 WorkOS refresh token 或 Factory API Key',
            value: factoryToken,
            onChange: (event) => setFactoryToken(event.target.value),
            style: inputStyle,
          }),
          h(Button, { small: true, onClick: () => factoryAdd('refresh-token'), disabled: busy.startsWith('factory:') },
            '以 Refresh Token 添加'),
          h(Button, { small: true, onClick: () => factoryAdd('api-key'), disabled: busy.startsWith('factory:') },
            '以 API Key 添加'),
          provider.cliAuthAvailable
            ? h(Button, { small: true, primary: true, onClick: () => factoryAdd('import'), disabled: busy.startsWith('factory:') },
              '从 droid CLI 导入')
            : null)

        return h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('div', null,
              h('div', { style: styles.title }, 'Factory Droid'),
              h('div', { style: styles.muted },
                count > 0 ? `${count} 个账号 · 请求自动轮询` : '未登录 · 复用 droid CLI 的订阅'))),
          accountRows.length > 0 ? h('div', { style: { marginTop: 8 } }, accountRows) : null,
          addRow,
          h('div', { style: styles.faint },
            provider.cliAuthAvailable
              ? '检测到 ~/.factory/auth.json，可一键导入 droid CLI 登录（token 每 6 小时自动刷新，droid CLI 保持可用）。'
              : '在任意机器运行 droid CLI 登录后，复制 ~/.factory/auth.json 里的 refresh_token 粘贴到上方即可。'),
          provider.models?.length > 0
            ? h('div', { style: styles.faint },
              `模型 ${provider.models.length} 个：${provider.models.slice(0, 10).join(', ')}${provider.models.length > 10 ? ' …' : ''}`)
            : null)
      }

      const activeProvider = (data.providers ?? []).find((provider) => provider.id === activeTab)
      const panel = activeTab === 'cursor'
        ? cursorPanel()
        : activeProvider
          ? (activeProvider.id === 'factory' ? factoryPanel(activeProvider) : providerPanel(activeProvider))
          : null

      const notes = []
      if (data.managementError) {
        notes.push(h('div', { key: 'mgmt-error', style: styles.card },
          h('span', { style: styles.err }, `管理 API 不可用：${data.managementError}`)))
      }
      if (notice) {
        notes.push(h('div', { key: 'notice', style: styles.card },
          h('span', { style: notice.kind === 'err' ? styles.err : styles.ok }, notice.text)))
      }

      return h('div', { style: styles.root }, header, proxyStrip, tabBar, panel, notes)
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
