// Subscription providers reachable through CLIProxyAPI's management API.
// `id` doubles as the DSH provider id so each family shows up separately in
// the model picker; ids deliberately avoid pi-ai's anthropic/openai/google.
export const PROXY_PROVIDERS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    authPath: 'anthropic-auth-url',
    flow: 'redirect',
    channels: ['anthropic', 'claude'],
    match: (model) => /^claude/.test(model),
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    authPath: 'codex-auth-url',
    flow: 'redirect',
    channels: ['codex', 'openai'],
    match: (model) => /^(gpt|codex|o\d)/.test(model),
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    authPath: 'antigravity-auth-url',
    flow: 'redirect',
    channels: ['antigravity'],
    match: (model) => /^antigravity/.test(model),
  },
  {
    id: 'gemini-cli',
    label: 'Gemini',
    authPath: undefined, // Gemini CLI OAuth moved into CLIProxyAPI's plugin store in v7.
    flow: 'redirect',
    channels: ['gemini', 'gemini-cli', 'aistudio'],
    match: (model) => /^gemini/.test(model),
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    authPath: undefined,
    flow: 'redirect',
    channels: ['qwen'],
    match: (model) => /^(qwen|qwq)/.test(model),
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code',
    authPath: 'kimi-auth-url',
    flow: 'device',
    channels: ['kimi', 'moonshot'],
    match: (model) => /^kimi/.test(model),
  },
  {
    id: 'grok-build',
    label: 'Grok Build',
    authPath: 'xai-auth-url',
    flow: 'device',
    channels: ['xai', 'grok'],
    match: (model) => /^grok/.test(model),
  },
  {
    // Factory Droid: tokens + models + LLM + web search are owned by this
    // plugin directly (no CLIProxyAPI). Optional CPA sync remains available
    // when cliproxy.mode is managed/external.
    id: 'factory',
    label: 'Factory Droid',
    authPath: undefined,
    flow: 'token',
    channels: ['factory'],
    match: (model) => /^factory[-/]/.test(model),
  },
  {
    id: 'iflow',
    label: 'iFlow',
    authPath: undefined,
    flow: 'redirect',
    channels: ['iflow'],
    match: (model) => /^(iflow|tstars|glm|deepseek)/.test(model),
  },
]

// Catch-all provider for models that do not match a known family
// (openai-compatibility passthroughs, CLIProxyAPI plugin channels, ...).
export const FALLBACK_PROVIDER = { id: 'cliproxy', label: 'CLIProxyAPI' }

/** Providers whose LLM traffic goes through CLIProxyAPI (excludes Factory). */
export const CPA_PROVIDER_IDS = [
  ...PROXY_PROVIDERS.filter((entry) => entry.id !== 'factory').map((entry) => entry.id),
  FALLBACK_PROVIDER.id,
]

export const ALL_PROVIDER_IDS = [...PROXY_PROVIDERS.map((entry) => entry.id), FALLBACK_PROVIDER.id]

export const FACTORY_PROVIDER_ID = 'factory'

export function providerById(id) {
  return PROXY_PROVIDERS.find((entry) => entry.id === id)
    ?? (id === FALLBACK_PROVIDER.id ? FALLBACK_PROVIDER : undefined)
}

export function providerLabel(id) {
  return providerById(id)?.label ?? id
}

export function providerForModel(modelId) {
  const lower = String(modelId ?? '').toLowerCase()
  for (const provider of PROXY_PROVIDERS) {
    if (provider.match?.(lower)) return provider.id
  }
  return FALLBACK_PROVIDER.id
}

export function providerForChannel(channel) {
  const lower = String(channel ?? '').toLowerCase()
  for (const provider of PROXY_PROVIDERS) {
    if (provider.channels?.includes(lower)) return provider.id
  }
  return FALLBACK_PROVIDER.id
}

// Providers whose OAuth flow can be launched right now: built-in auth routes
// always work; CLIProxyAPI plugins expose the same `<provider>-auth-url`
// pattern once installed, discovered at runtime via GET /plugins.
export function loginTargets(plugins = []) {
  const targets = new Map()
  for (const provider of PROXY_PROVIDERS) {
    if (provider.authPath) targets.set(provider.id, { ...provider })
  }
  for (const plugin of plugins) {
    if (!plugin?.supports_oauth || !plugin?.oauth_provider) continue
    const channel = String(plugin.oauth_provider).toLowerCase()
    const providerId = providerForChannel(channel)
    if (targets.has(providerId)) continue
    const descriptor = providerById(providerId)
    targets.set(providerId, {
      id: providerId,
      label: descriptor?.label ?? plugin.metadata?.name ?? channel,
      authPath: `${channel}-auth-url`,
      flow: 'redirect',
      channels: [channel],
      fromPlugin: true,
    })
  }
  return [...targets.values()]
}
