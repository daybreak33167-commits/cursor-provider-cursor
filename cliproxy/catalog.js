import { FALLBACK_PROVIDER, providerForModel, providerLabel } from './providers.js'

const CACHE_MS = 60_000

const FAMILY_CONTEXT = {
  'claude-code': 200_000,
  codex: 272_000,
  antigravity: 1_000_000,
  'gemini-cli': 1_000_000,
  'qwen-code': 256_000,
  'kimi-code': 256_000,
  'grok-build': 256_000,
  iflow: 128_000,
  [FALLBACK_PROVIDER.id]: 128_000,
}

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']
const DEFAULT_MAX_TOKENS = 32_768

function displayName(model) {
  const raw = model.display_name || model.name
  if (raw && String(raw).trim()) return String(raw).trim()
  return String(model.id)
}

export function createProxyCatalog({ getBaseUrl, getApiKey, logger }) {
  let cache = { at: 0, byProvider: new Map(), error: undefined }
  let inflight

  async function fetchModels() {
    const base = getBaseUrl().replace(/\/+$/, '')
    const apiKey = await getApiKey()
    const response = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`GET /v1/models -> ${response.status}`)
    const payload = await response.json()
    const items = Array.isArray(payload) ? payload : payload?.data ?? payload?.models ?? []
    return items.filter((item) => item && item.id)
  }

  async function refresh() {
    const byProvider = new Map()
    const seen = new Set()
    const items = await fetchModels()
    for (const item of items) {
      const id = String(item.id)
      if (seen.has(id)) continue
      seen.add(id)
      const provider = providerForModel(id)
      if (!byProvider.has(provider)) byProvider.set(provider, [])
      byProvider.get(provider).push({
        id,
        name: displayName(item),
        ownedBy: item.owned_by,
      })
    }
    for (const models of byProvider.values()) {
      models.sort((a, b) => a.id.localeCompare(b.id))
    }
    cache = { at: Date.now(), byProvider, error: undefined }
    return cache
  }

  async function snapshot({ force = false } = {}) {
    if (!force && Date.now() - cache.at < CACHE_MS && cache.byProvider.size > 0) return cache
    inflight ??= refresh()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`cliproxy catalog: ${message}`)
        // Serve the previous snapshot when the proxy is briefly unreachable.
        cache = { ...cache, at: cache.byProvider.size > 0 ? Date.now() : 0, error: message }
        return cache
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  async function listModels(provider) {
    const snap = await snapshot()
    const models = snap.byProvider.get(provider) ?? []
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text', 'image'],
    }))
  }

  async function resolveModel(provider, modelId, ReasoningEffortId) {
    const brand = typeof ReasoningEffortId === 'function' ? ReasoningEffortId : (id) => id
    const snap = await snapshot()
    const record = (snap.byProvider.get(provider) ?? []).find((model) => model.id === modelId)
    const efforts = provider === 'codex'
      ? CODEX_EFFORTS.map((effort) => ({
        id: brand(effort),
        name: effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1),
      }))
      : []
    return {
      provider,
      id: modelId,
      name: record?.name ?? modelId,
      inputModalities: ['text', 'image'],
      context: {
        contextWindow: FAMILY_CONTEXT[provider] ?? FAMILY_CONTEXT[FALLBACK_PROVIDER.id],
      },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      ...efforts.length > 0
        ? { reasoning: { efforts, defaultEffort: brand('medium') } }
        : {},
    }
  }

  async function overview() {
    const snap = await snapshot()
    return {
      at: snap.at,
      error: snap.error,
      providers: [...snap.byProvider.entries()].map(([provider, models]) => ({
        id: provider,
        label: providerLabel(provider),
        models: models.map((model) => model.id),
      })),
    }
  }

  function invalidate() {
    cache = { at: 0, byProvider: cache.byProvider, error: cache.error }
  }

  return { snapshot, listModels, resolveModel, overview, invalidate }
}
