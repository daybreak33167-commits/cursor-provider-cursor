import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Factory Droid (factory.ai) subscription support.
//
// Factory has no public OAuth client for third parties, but its droid CLI
// authenticates through WorkOS with a fixed public client id and calls
// api.factory.ai with the resulting bearer token. We manage those tokens
// (imported from the droid CLI login or pasted as a refresh token / API key)
// and bridge them into CLIProxyAPI as custom upstream credentials:
//
//   claude-api-key  -> https://api.factory.ai/api/llm/a      (+ /v1/messages)
//   codex-api-key   -> https://api.factory.ai/api/llm/o/v1   (+ /responses)
//   openai-compat   -> https://api.factory.ai/api/llm/o/v1   (+ /chat/completions)
//
// so all protocol conversion, retry and load balancing stays in the proxy.
// Models are exposed under `factory-*` aliases to keep them separate from
// real Claude Code / Codex accounts.

const ACCOUNTS_REF = 'FACTORY_ACCOUNTS'
const WORKOS_URL = 'https://api.workos.com/user_management/authenticate'
// Public client id embedded in the droid CLI (same one droid2api uses).
const WORKOS_CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB'
const FACTORY_API = 'https://api.factory.ai/api/llm'
const FACTORY_USER_AGENT = 'factory-cli/0.85.0'
// Access tokens live ~8h; refresh at 6h like the droid CLI does.
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000
const LOOP_MS = 60_000
const VERIFY_EVERY_MS = 5 * 60_000
const COMPAT_PROVIDER_NAME = 'factory-droid'

export const FACTORY_MODEL_PREFIX = 'factory-'

// Curated list mirroring the droid CLI's current catalog. Kept static so the
// aliases stay stable; unavailable upstream models simply error on use.
const FACTORY_MODELS = {
  anthropic: [
    { name: 'claude-opus-4-6', display: 'Claude Opus 4.6 (Factory)' },
    { name: 'claude-opus-4-5-20251101', display: 'Claude Opus 4.5 (Factory)' },
    { name: 'claude-sonnet-4-6', display: 'Claude Sonnet 4.6 (Factory)' },
    { name: 'claude-sonnet-4-5-20250929', display: 'Claude Sonnet 4.5 (Factory)' },
    { name: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5 (Factory)' },
  ],
  openai: [
    { name: 'gpt-5.4', display: 'GPT-5.4 (Factory)' },
    { name: 'gpt-5.4-mini', display: 'GPT-5.4 mini (Factory)' },
    { name: 'gpt-5.3-codex', display: 'GPT-5.3 Codex (Factory)' },
    { name: 'gpt-5.2', display: 'GPT-5.2 (Factory)' },
    { name: 'gpt-5.2-codex', display: 'GPT-5.2 Codex (Factory)' },
  ],
  common: [
    { name: 'glm-5', display: 'GLM-5 (Factory)' },
    { name: 'glm-4.7', display: 'GLM-4.7 (Factory)' },
    { name: 'kimi-k2.5', display: 'Kimi K2.5 (Factory)' },
  ],
}

export function factoryAuthJsonPath() {
  return join(homedir(), '.factory', 'auth.json')
}

function aliasOf(name) {
  return `${FACTORY_MODEL_PREFIX}${name}`
}

async function workosRefresh(refreshToken) {
  const response = await fetch(WORKOS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: WORKOS_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }
  if (!response.ok || !data.access_token) {
    const detail = data?.error_description ?? data?.error ?? text?.slice(0, 160) ?? ''
    throw new Error(`WorkOS refresh failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    email: data.user?.email ?? '',
  }
}

// Stable stringify so config diffing works regardless of key order.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isFactoryUpstream(entry) {
  return typeof entry?.['base-url'] === 'string' && entry['base-url'].startsWith(FACTORY_API)
}

export function createFactoryManager({ getCredentials, mgmt, proxyStatus, onChanged, logger }) {
  let cache
  let loaded = false
  let dirty = true
  let lastVerifiedAt = 0
  let loopTimer
  let syncInflight
  const refreshInflight = new Map()

  const warn = (message) => logger?.warn?.(`factory: ${message}`)
  const log = (message) => logger?.info?.(`factory: ${message}`)

  async function readCredential(ref) {
    try {
      return (await getCredentials?.()?.resolve?.(ref))?.value
    } catch {
      return undefined
    }
  }

  async function writeCredential(ref, value) {
    const credentials = getCredentials?.()
    if (!credentials) return
    try {
      if (value === undefined) await credentials.unset?.(ref)
      else await credentials.set?.(ref, value)
    } catch (error) {
      warn(`could not persist ${ref}: ${error instanceof Error ? error.message : error}`)
    }
  }

  function normalize(list) {
    return (Array.isArray(list) ? list : [])
      .filter((account) => account && (account.refreshToken || account.apiKey))
      .map((account) => ({
        slug: typeof account.slug === 'string' && account.slug ? account.slug : `acct-${randomUUID().slice(0, 8)}`,
        kind: account.kind === 'api-key' ? 'api-key' : 'oauth',
        email: typeof account.email === 'string' ? account.email : '',
        refreshToken: typeof account.refreshToken === 'string' ? account.refreshToken : undefined,
        accessToken: typeof account.accessToken === 'string' ? account.accessToken : undefined,
        apiKey: typeof account.apiKey === 'string' ? account.apiKey : undefined,
        sessionId: typeof account.sessionId === 'string' && account.sessionId ? account.sessionId : randomUUID(),
        messageId: typeof account.messageId === 'string' && account.messageId ? account.messageId : randomUUID(),
        refreshedAt: Number.isFinite(account.refreshedAt) ? account.refreshedAt : 0,
        addedAt: Number.isFinite(account.addedAt) ? account.addedAt : Date.now(),
        disabled: account.disabled === true,
        fromCli: account.fromCli === true,
        lastError: typeof account.lastError === 'string' ? account.lastError : undefined,
      }))
  }

  async function load() {
    if (loaded && cache) return cache
    const credentials = getCredentials?.()
    // Credentials may register after this plugin applies; don't latch an
    // empty list before the service is up.
    if (!credentials?.resolve) return cache ?? []
    const raw = await readCredential(ACCOUNTS_REF)
    if (raw) {
      try {
        cache = normalize(JSON.parse(raw))
      } catch {
        warn(`credential ${ACCOUNTS_REF} holds invalid JSON; starting empty`)
        cache = []
      }
    } else {
      cache = cache ?? []
    }
    loaded = true
    return cache
  }

  async function persist() {
    await writeCredential(ACCOUNTS_REF, JSON.stringify(cache ?? []))
  }

  function bearerOf(account) {
    return account.kind === 'api-key' ? account.apiKey : account.accessToken
  }

  function labelOf(account) {
    if (account.email) return account.email
    if (account.kind === 'api-key') return `api-key …${(account.apiKey ?? '').slice(-4)}`
    return account.slug
  }

  function uniqueSlug(base) {
    const cleaned = String(base || 'account').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
    let slug = cleaned
    let counter = 2
    while ((cache ?? []).some((account) => account.slug === slug)) {
      slug = `${cleaned}-${counter}`
      counter += 1
    }
    return slug
  }

  function markChanged() {
    dirty = true
    onChanged?.()
  }

  // --- account operations -------------------------------------------------

  async function addRefreshToken(refreshToken, { fromCli = false } = {}) {
    const token = String(refreshToken ?? '').trim()
    if (!token) throw new Error('缺少 refresh token')
    const result = await workosRefresh(token)
    await load()
    cache = cache ?? []
    const existing = cache.find((account) => account.kind === 'oauth' && result.email && account.email === result.email)
    if (existing) {
      existing.refreshToken = result.refreshToken
      existing.accessToken = result.accessToken
      existing.refreshedAt = Date.now()
      existing.disabled = false
      existing.fromCli = fromCli || existing.fromCli
      existing.lastError = undefined
      await persist()
      markChanged()
      return { email: labelOf(existing), updated: true }
    }
    const account = {
      slug: uniqueSlug(result.email || 'oauth'),
      kind: 'oauth',
      email: result.email,
      refreshToken: result.refreshToken,
      accessToken: result.accessToken,
      sessionId: randomUUID(),
      messageId: randomUUID(),
      refreshedAt: Date.now(),
      addedAt: Date.now(),
      disabled: false,
      fromCli,
      lastError: undefined,
    }
    cache.push(account)
    await persist()
    markChanged()
    if (fromCli) writeCliAuthJson(account)
    return { email: labelOf(account), updated: false }
  }

  async function addApiKey(apiKey) {
    const key = String(apiKey ?? '').trim()
    if (!key) throw new Error('缺少 API Key')
    await load()
    cache = cache ?? []
    const existing = cache.find((account) => account.kind === 'api-key' && account.apiKey === key)
    if (existing) {
      existing.disabled = false
      existing.lastError = undefined
      await persist()
      markChanged()
      return { email: labelOf(existing), updated: true }
    }
    const account = {
      slug: uniqueSlug(`key-${key.slice(-4)}`),
      kind: 'api-key',
      email: '',
      apiKey: key,
      sessionId: randomUUID(),
      messageId: randomUUID(),
      refreshedAt: 0,
      addedAt: Date.now(),
      disabled: false,
      fromCli: false,
      lastError: undefined,
    }
    cache.push(account)
    await persist()
    markChanged()
    return { email: labelOf(account), updated: false }
  }

  function readCliAuthJson() {
    try {
      const raw = readFileSync(factoryAuthJsonPath(), 'utf8')
      const data = JSON.parse(raw)
      if (typeof data?.refresh_token === 'string' && data.refresh_token) return data
    } catch {
      // Missing or malformed.
    }
    return undefined
  }

  // Keep the droid CLI logged in: WorkOS rotates refresh tokens on every use,
  // so after we consume the CLI's token we write the rotated pair back.
  function writeCliAuthJson(account) {
    try {
      const path = factoryAuthJsonPath()
      if (!existsSync(path)) return
      const existing = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, `${JSON.stringify({
        ...existing,
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        last_updated: new Date().toISOString(),
      }, null, 2)}\n`)
    } catch (error) {
      warn(`could not update ~/.factory/auth.json: ${error instanceof Error ? error.message : error}`)
    }
  }

  async function importFromCli() {
    const data = readCliAuthJson()
    if (!data) {
      throw new Error(`未找到 ${factoryAuthJsonPath()}。请先运行 droid CLI 并完成登录，或直接粘贴 refresh token。`)
    }
    return await addRefreshToken(data.refresh_token, { fromCli: true })
  }

  async function remove(nameOrEmail) {
    await load()
    const before = cache?.length ?? 0
    if (nameOrEmail) {
      cache = (cache ?? []).filter((account) => account.email !== nameOrEmail && account.slug !== nameOrEmail)
    } else {
      cache = []
    }
    const removed = before - (cache?.length ?? 0)
    if (removed > 0) {
      await persist()
      markChanged()
    }
    return removed
  }

  async function setDisabled(nameOrEmail, disabled) {
    await load()
    const hit = (cache ?? []).find((account) => account.email === nameOrEmail || account.slug === nameOrEmail)
    if (!hit) throw new Error(`Factory 账号不存在：${nameOrEmail}`)
    hit.disabled = disabled === true
    await persist()
    markChanged()
  }

  // --- token refresh -------------------------------------------------------

  async function refreshAccount(account) {
    const inflightKey = account.slug
    if (refreshInflight.has(inflightKey)) return refreshInflight.get(inflightKey)
    const task = (async () => {
      try {
        const result = await workosRefresh(account.refreshToken)
        account.accessToken = result.accessToken
        account.refreshToken = result.refreshToken
        if (result.email) account.email = result.email
        account.refreshedAt = Date.now()
        // Rotate the per-refresh telemetry ids like a fresh CLI session would.
        account.messageId = randomUUID()
        account.lastError = undefined
        if (account.fromCli) writeCliAuthJson(account)
        await persist()
        markChanged()
        log(`refreshed token for ${labelOf(account)}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // The droid CLI may have rotated the token underneath us; try to
        // rescue with the CLI's current token before giving up.
        if (account.fromCli) {
          const data = readCliAuthJson()
          if (data && data.refresh_token !== account.refreshToken) {
            try {
              const rescued = await workosRefresh(data.refresh_token)
              account.accessToken = rescued.accessToken
              account.refreshToken = rescued.refreshToken
              if (rescued.email) account.email = rescued.email
              account.refreshedAt = Date.now()
              account.messageId = randomUUID()
              account.lastError = undefined
              writeCliAuthJson(account)
              await persist()
              markChanged()
              log(`recovered token for ${labelOf(account)} from droid CLI auth.json`)
              return
            } catch {
              // Fall through to the original error.
            }
          }
        }
        account.lastError = message
        await persist()
        warn(`token refresh failed for ${labelOf(account)}: ${message}`)
      }
    })().finally(() => {
      refreshInflight.delete(inflightKey)
    })
    refreshInflight.set(inflightKey, task)
    return task
  }

  async function ensureFresh({ force = false } = {}) {
    const accounts = await load()
    const due = accounts.filter((account) => account.kind === 'oauth'
      && !account.disabled
      && account.refreshToken
      && (force || Date.now() - account.refreshedAt > REFRESH_AFTER_MS))
    await Promise.all(due.map((account) => refreshAccount(account)))
  }

  // --- CLIProxyAPI config sync ---------------------------------------------

  function activeAccounts() {
    return (cache ?? []).filter((account) => !account.disabled && bearerOf(account))
  }

  function factoryHeaders(account, provider) {
    return {
      authorization: `Bearer ${bearerOf(account)}`,
      'x-api-key': 'placeholder',
      'x-api-provider': provider,
      'x-factory-client': 'cli',
      'x-session-id': account.sessionId,
      'x-assistant-message-id': account.messageId,
      'user-agent': FACTORY_USER_AGENT,
    }
  }

  function desiredClaudeEntries() {
    return activeAccounts().map((account) => ({
      'api-key': bearerOf(account),
      'base-url': `${FACTORY_API}/a`,
      headers: factoryHeaders(account, 'anthropic'),
      models: FACTORY_MODELS.anthropic.map((model) => ({
        name: model.name,
        alias: aliasOf(model.name),
        'display-name': model.display,
        'force-mapping': true,
      })),
    }))
  }

  function desiredCodexEntries() {
    return activeAccounts().map((account) => ({
      'api-key': bearerOf(account),
      'base-url': `${FACTORY_API}/o/v1`,
      headers: factoryHeaders(account, 'openai'),
      models: FACTORY_MODELS.openai.map((model) => ({
        name: model.name,
        alias: aliasOf(model.name),
        'display-name': model.display,
        'force-mapping': true,
      })),
    }))
  }

  function desiredCompatEntries() {
    const accounts = activeAccounts()
    if (accounts.length === 0) return []
    const [first] = accounts
    return [{
      name: COMPAT_PROVIDER_NAME,
      'base-url': `${FACTORY_API}/o/v1`,
      'api-key-entries': accounts.map((account) => ({ 'api-key': bearerOf(account) })),
      headers: {
        'x-api-provider': 'fireworks',
        'x-factory-client': 'cli',
        'x-session-id': first.sessionId,
        'x-assistant-message-id': first.messageId,
        'user-agent': FACTORY_USER_AGENT,
      },
      models: FACTORY_MODELS.common.map((model) => ({
        name: model.name,
        alias: aliasOf(model.name),
        'display-name': model.display,
      })),
    }]
  }

  // Project both sides onto the fields we manage before comparing, so extra
  // fields CPA adds on read (weights, defaults, ...) don't force rewrites.
  function projectEntry(entry) {
    return {
      'api-key': entry?.['api-key'] ?? '',
      'base-url': entry?.['base-url'] ?? '',
      headers: entry?.headers ?? {},
      models: (entry?.models ?? []).map((model) => ({
        name: model?.name ?? '',
        alias: model?.alias ?? '',
      })),
      ...entry?.name !== undefined ? { name: entry.name } : {},
      ...entry?.['api-key-entries'] !== undefined
        ? { 'api-key-entries': (entry['api-key-entries'] ?? []).map((item) => ({ 'api-key': item?.['api-key'] ?? '' })) }
        : {},
    }
  }

  async function syncSection({ path, key, desired, isOurs }) {
    const data = await mgmt.call('GET', path)
    const currentList = Array.isArray(data?.[key]) ? data[key] : Array.isArray(data) ? data : []
    const theirs = currentList.filter((entry) => !isOurs(entry))
    const ours = currentList.filter((entry) => isOurs(entry))
    const same = ours.length === desired.length
      && canonical(ours.map(projectEntry)) === canonical(desired.map(projectEntry))
    if (same) return false
    await mgmt.call('PUT', path, { body: [...theirs, ...desired] })
    return true
  }

  async function syncNow() {
    await load()
    // CPA reloads config after every management write; back-to-back writes to
    // different sections race that reload and can drop model registrations
    // (verified empirically), so let each write settle before the next one.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 2_000))
    const changedClaude = await syncSection({
      path: '/claude-api-key',
      key: 'claude-api-key',
      desired: desiredClaudeEntries(),
      isOurs: isFactoryUpstream,
    })
    if (changedClaude) await settle()
    const changedCodex = await syncSection({
      path: '/codex-api-key',
      key: 'codex-api-key',
      desired: desiredCodexEntries(),
      isOurs: isFactoryUpstream,
    })
    if (changedCodex) await settle()
    const changedCompat = await syncSection({
      path: '/openai-compatibility',
      key: 'openai-compatibility',
      desired: desiredCompatEntries(),
      isOurs: (entry) => entry?.name === COMPAT_PROVIDER_NAME,
    })
    dirty = false
    lastVerifiedAt = Date.now()
    if (changedClaude || changedCodex || changedCompat) {
      log('CLIProxyAPI factory upstreams updated')
      onChanged?.()
    }
    return changedClaude || changedCodex || changedCompat
  }

  function sync() {
    syncInflight ??= syncNow()
      .catch((error) => {
        warn(`config sync failed: ${error instanceof Error ? error.message : error}`)
      })
      .finally(() => {
        syncInflight = undefined
      })
    return syncInflight
  }

  function proxyReady() {
    const phase = proxyStatus?.()?.phase
    return phase === 'running' || phase === 'external-ok'
  }

  async function tick() {
    const accounts = await load()
    if (accounts.length === 0 && !dirty) return
    await ensureFresh()
    if (!proxyReady()) return
    if (dirty || Date.now() - lastVerifiedAt > VERIFY_EVERY_MS) await sync()
  }

  function start() {
    if (loopTimer) return
    loopTimer = setInterval(() => {
      tick().catch((error) => warn(`loop error: ${error instanceof Error ? error.message : error}`))
    }, LOOP_MS)
    if (typeof loopTimer.unref === 'function') loopTimer.unref()
    // First pass shortly after boot (credentials + proxy need a moment).
    setTimeout(() => {
      tick().catch(() => {})
    }, 3_000).unref?.()
  }

  function stop() {
    clearInterval(loopTimer)
    loopTimer = undefined
  }

  // --- introspection --------------------------------------------------------

  async function describe() {
    const accounts = await load()
    return {
      accounts: accounts.map((account) => ({
        name: account.slug,
        email: labelOf(account),
        kind: account.kind,
        disabled: account.disabled,
        fromCli: account.fromCli,
        refreshedAt: account.refreshedAt,
        stale: account.kind === 'oauth' && Date.now() - account.refreshedAt > REFRESH_AFTER_MS + 30 * 60_000,
        error: account.lastError,
      })),
      cliAuthAvailable: existsSync(factoryAuthJsonPath()),
      modelCount: FACTORY_MODELS.anthropic.length + FACTORY_MODELS.openai.length + FACTORY_MODELS.common.length,
    }
  }

  async function add(mode, value) {
    if (mode === 'import') return await importFromCli()
    if (mode === 'api-key') return await addApiKey(value)
    if (mode === 'refresh-token') return await addRefreshToken(String(value ?? '').trim())
    throw new Error(`未知的添加方式：${mode}`)
  }

  return {
    add,
    importFromCli,
    addRefreshToken,
    addApiKey,
    remove,
    setDisabled,
    describe,
    ensureFresh,
    sync,
    start,
    stop,
  }
}
