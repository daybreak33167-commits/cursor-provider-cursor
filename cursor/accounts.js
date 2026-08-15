import { Cursor } from '@cursor/sdk'

// All Cursor accounts live in one DSH credential as a JSON list. The legacy
// single-key credential (CURSOR_API_KEY by default) is kept in sync with the
// first usable account so older consumers keep working.
const ACCOUNTS_REF = 'CURSOR_ACCOUNTS'
const AUTH_COOLDOWN_MS = 5 * 60_000
const EXPIRY_MARGIN_MS = 60_000

export function createAccountStore({ getCredentials, getApiKeyEnv, logger }) {
  let cache
  let loaded = false
  let rotation = 0
  const cooldown = new Map()

  const warn = (message) => logger?.warn?.(`subscriptions cursor: ${message}`)
  const keyOf = (account) => account.email || `key:${account.apiKey.slice(-12)}`

  async function read(ref) {
    try {
      return (await getCredentials?.()?.resolve?.(ref))?.value
    } catch {
      return undefined
    }
  }

  async function write(ref, value) {
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
      .filter((account) => account && typeof account.apiKey === 'string' && account.apiKey)
      .map((account) => ({
        email: typeof account.email === 'string' ? account.email : '',
        apiKey: account.apiKey,
        expiresAt: Number.isFinite(account.expiresAt) ? account.expiresAt : undefined,
        disabled: account.disabled === true,
        addedAt: Number.isFinite(account.addedAt) ? account.addedAt : Date.now(),
      }))
  }

  async function load() {
    if (loaded && cache) return cache
    const credentials = getCredentials?.()
    // Credentials may register after this plugin applies; don't latch an
    // empty list before the service is up.
    if (!credentials?.resolve) return cache ?? []
    const raw = await read(ACCOUNTS_REF)
    if (raw) {
      try {
        cache = normalize(JSON.parse(raw))
      } catch {
        warn(`credential ${ACCOUNTS_REF} holds invalid JSON; starting empty`)
        cache = []
      }
    } else {
      cache = cache ?? []
      const legacy = await read(getApiKeyEnv())
      if (legacy && !cache.some((account) => account.apiKey === legacy)) {
        const sdk = await Cursor.auth.status().catch(() => undefined)
        cache.push({
          email: sdk?.email ?? '',
          apiKey: legacy,
          expiresAt: sdk?.apiKeyExpiresAtMs,
          disabled: false,
          addedAt: Date.now(),
        })
        await persist()
      }
    }
    loaded = true
    return cache
  }

  async function persist() {
    await write(ACCOUNTS_REF, JSON.stringify(cache ?? []))
    const first = (cache ?? []).find(usable) ?? (cache ?? [])[0]
    await write(getApiKeyEnv(), first?.apiKey)
  }

  function usable(account) {
    if (account.disabled) return false
    if (account.expiresAt && account.expiresAt < Date.now() + EXPIRY_MARGIN_MS) return false
    if ((cooldown.get(keyOf(account)) ?? 0) > Date.now()) return false
    return true
  }

  async function list() {
    const accounts = await load()
    return accounts.map((account) => ({
      email: account.email,
      expiresAt: account.expiresAt,
      disabled: account.disabled,
      addedAt: account.addedAt,
      expired: Boolean(account.expiresAt && account.expiresAt < Date.now()),
      coolingDown: (cooldown.get(keyOf(account)) ?? 0) > Date.now(),
    }))
  }

  async function add({ email, apiKey, expiresAt }) {
    await load()
    cache = cache ?? []
    const id = email || ''
    const existing = id
      ? cache.find((account) => account.email === id)
      : cache.find((account) => account.apiKey === apiKey)
    if (existing) {
      cooldown.delete(keyOf(existing))
      existing.apiKey = apiKey
      existing.expiresAt = expiresAt
      existing.disabled = false
      if (id) existing.email = id
    } else {
      cache.push({ email: id, apiKey, expiresAt, disabled: false, addedAt: Date.now() })
    }
    await persist()
    return { count: cache.length, updated: Boolean(existing) }
  }

  async function remove(email) {
    await load()
    const before = cache?.length ?? 0
    cache = email ? (cache ?? []).filter((account) => account.email !== email) : []
    await persist()
    return before - cache.length
  }

  async function setDisabled(email, disabled) {
    await load()
    const hit = (cache ?? []).find((account) => account.email === email)
    if (!hit) throw new Error(`Cursor 账号不存在：${email}`)
    hit.disabled = disabled === true
    if (!hit.disabled) cooldown.delete(keyOf(hit))
    await persist()
  }

  // Round-robin over usable accounts; falls back to any enabled account when
  // everything is cooling down or near expiry.
  async function pick({ advance = true } = {}) {
    const accounts = await load()
    if (accounts.length === 0) return undefined
    const healthy = accounts.filter(usable)
    const pool = healthy.length > 0 ? healthy : accounts.filter((account) => !account.disabled)
    if (pool.length === 0) return undefined
    const index = rotation % pool.length
    if (advance) rotation += 1
    return pool[index]
  }

  function reportAuthFailure(apiKey) {
    const hit = (cache ?? []).find((account) => account.apiKey === apiKey)
    if (!hit) return
    cooldown.set(keyOf(hit), Date.now() + AUTH_COOLDOWN_MS)
    warn(`account ${hit.email || '(unknown)'} hit an auth error; cooling down for ${AUTH_COOLDOWN_MS / 60_000} minutes`)
  }

  function hasUsable() {
    return (cache ?? []).some(usable)
  }

  return { list, add, remove, setDisabled, pick, reportAuthFailure, hasUsable }
}
