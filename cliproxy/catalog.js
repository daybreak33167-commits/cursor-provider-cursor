import { FALLBACK_PROVIDER, providerForModel, providerLabel } from './providers.js'

const CACHE_MS = 60_000

const FAMILY_CONTEXT = {
  'claude-code': { window: 200_000, maxWindow: 1_000_000 },
  codex: { window: 272_000, maxWindow: 272_000 },
  antigravity: { window: 1_000_000, maxWindow: 1_000_000 },
  'gemini-cli': { window: 1_000_000, maxWindow: 1_000_000 },
  'qwen-code': { window: 256_000, maxWindow: 256_000 },
  'kimi-code': { window: 256_000, maxWindow: 256_000 },
  'grok-build': { window: 256_000, maxWindow: 256_000 },
  factory: { window: 200_000, maxWindow: 1_000_000 },
  iflow: { window: 128_000, maxWindow: 128_000 },
  [FALLBACK_PROVIDER.id]: { window: 128_000, maxWindow: 128_000 },
}

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']
const FACTORY_EFFORTS = ['low', 'medium', 'high']
const CLAUDE_EFFORTS = ['low', 'medium', 'high']
const DEFAULT_MAX_TOKENS = 32_768

function effortName(effort) {
  return effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

function displayName(model) {
  const raw = model.display_name || model.name
  if (raw && String(raw).trim()) return String(raw).trim()
  return String(model.id)
}

function familyLimits(provider) {
  return FAMILY_CONTEXT[provider] ?? FAMILY_CONTEXT[FALLBACK_PROVIDER.id]
}

function effortIdsFor(provider) {
  if (provider === 'codex') return CODEX_EFFORTS
  if (provider === 'factory') return FACTORY_EFFORTS
  if (provider === 'claude-code') return CLAUDE_EFFORTS
  return []
}

/** Strip UI compound ids down to the upstream reasoning_effort value. */
export function proxyEffortValue(reasoningEffort) {
  if (!reasoningEffort) return undefined
  const raw = String(reasoningEffort)
  if (raw.includes('=')) {
    for (const part of raw.split('|')) {
      if (part.startsWith('effort=')) return part.slice('effort='.length)
    }
    return raw.split('|')[0]
  }
  // Compound ids are `effort` or `effort|ctxmax` (context flag must not be
  // mistaken for thinking level `max`).
  const effort = raw.split('|')[0]
  if (!effort || effort === 'default' || effort === 'ctxmax') return undefined
  return effort
}

function buildReasoning(provider, ReasoningEffortId) {
  const brand = typeof ReasoningEffortId === 'function' ? ReasoningEffortId : (id) => id
  const limits = familyLimits(provider)
  const baseK = Math.round(limits.window / 1000)
  const maxK = Math.round(limits.maxWindow / 1000)
  const contexts = limits.maxWindow > limits.window
    ? [
      { flag: '', label: `${baseK}K`, window: limits.window },
      { flag: 'max', label: `Max ${maxK}K`, window: limits.maxWindow },
    ]
    : [{ flag: '', label: `${baseK}K`, window: limits.window }]

  const effortIds = effortIdsFor(provider)
  const levels = effortIds.length > 0 ? effortIds : ['default']
  const efforts = []
  for (const effort of levels) {
    for (const context of contexts) {
      const effortLabel = effort === 'default' ? 'Default' : effortName(effort)
      const id = context.flag
        ? (effort === 'default' ? `default|${context.flag}` : `${effort}|${context.flag}`)
        : (effort === 'default' ? 'default' : effort)
      efforts.push({
        id: brand(id),
        name: `${effortLabel} · ${context.label}`,
        description: `effort:${effortLabel}|context:${context.label}|ctx:${context.window}`,
      })
    }
  }
  const defaultId = effortIds.includes('medium')
    ? brand('medium')
    : efforts[0]?.id
  return {
    efforts,
    ...defaultId ? { defaultEffort: defaultId } : {},
    contextWindow: limits.maxWindow,
  }
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
    const snap = await snapshot()
    const record = (snap.byProvider.get(provider) ?? []).find((model) => model.id === modelId)
    const reasoning = buildReasoning(provider, ReasoningEffortId)
    return {
      provider,
      id: modelId,
      name: record?.name ?? modelId,
      inputModalities: ['text', 'image'],
      context: {
        contextWindow: reasoning.contextWindow,
      },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning: {
        efforts: reasoning.efforts,
        ...reasoning.defaultEffort ? { defaultEffort: reasoning.defaultEffort } : {},
      },
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
