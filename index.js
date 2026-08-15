import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { importHost } from './host.js'
import { applyCursor, CURSOR_PROVIDER, DEFAULT_CURSOR_API_KEY_ENV } from './cursor/index.js'
import { registerSubscriptionCommands } from './commands.js'
import { createProxySupervisor, proxyHome } from './cliproxy/runtime.js'
import { createManagementClient } from './cliproxy/management.js'
import { createProxyCatalog } from './cliproxy/catalog.js'
import { createProxyAdapterClass } from './cliproxy/adapter.js'
import { createFactoryAdapterClass } from './cliproxy/factory-adapter.js'
import { createFactoryCatalog } from './cliproxy/factory-catalog.js'
import { createFactoryManager, FACTORY_MODELS } from './cliproxy/factory.js'
import { registerSubscriptionsWebSearch } from './cliproxy/web-search-router.js'
import { loadCatalog, listCatalogModels } from './cursor/catalog.js'
import { createSubscriptionsController, registerSubscriptionRoutes } from './cliproxy/routes.js'
import {
  CPA_PROVIDER_IDS,
  FALLBACK_PROVIDER,
  FACTORY_PROVIDER_ID,
  PROXY_PROVIDERS,
  providerForChannel,
} from './cliproxy/providers.js'

export const name = 'subscriptions'
export const inject = ['llm']

const NS = 'subscriptions'
const DEFAULT_MANAGEMENT_KEY_ENV = 'CLIPROXY_MANAGEMENT_KEY'
const DEFAULT_PROXY_API_KEY_ENV = 'CLIPROXY_API_KEY'

const llm = await importHost('@deepseek-ai/dsh-llm')

let Schema
try {
  const schemastery = await importHost('@deepseek-ai/schemastery')
  Schema = schemastery.default ?? schemastery
} catch {
  Schema = undefined
}

const catalogModel = Schema?.object?.({
  id: Schema.string().required(),
  name: Schema.string(),
  description: Schema.string(),
})

const cursorSection = Schema?.object?.({
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_CURSOR_API_KEY_ENV),
  models: Schema.array(catalogModel),
  retryPolicy: llm.RetryPolicySchema,
}).description('Cursor 订阅（@cursor/sdk）')

const cliproxySection = Schema?.object?.({
  mode: Schema.union(['off', 'managed', 'external']).default('managed')
    .description('managed：插件内置托管 CLIProxyAPI（默认）；external：连接已有实例；off：仅 Cursor + Factory 直连'),
  port: Schema.natural().default(8317).description('托管模式下 CLIProxyAPI 监听的本地端口'),
  externalUrl: Schema.string().description('external 模式的基础地址，例如 http://127.0.0.1:8317'),
  binaryPath: Schema.string().description('自备 CLIProxyAPI 可执行文件路径（跳过自动下载）'),
  version: Schema.string().default('latest').description('托管模式下载的版本（latest 或 7.2.131 这类版本号）'),
  managementKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_MANAGEMENT_KEY_ENV),
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_PROXY_API_KEY_ENV),
  retryPolicy: llm.RetryPolicySchema,
}).description('内置 CLIProxyAPI（Claude Code / Codex / Antigravity / Kimi / Grok 等）。默认托管启动。')

export const Config = Schema?.object?.({
  cursor: cursorSection,
  cliproxy: cliproxySection,
}) ?? undefined

function cursorOptions(config) {
  const section = config?.cursor ?? ((config?.apiKeyEnv || config?.models) ? config : {})
  return {
    apiKeyEnv: section?.apiKeyEnv || DEFAULT_CURSOR_API_KEY_ENV,
    models: section?.models,
    retryPolicy: llm.resolveRetryPolicy
      ? llm.resolveRetryPolicy(section?.retryPolicy, 'subscriptions: cursor.retryPolicy')
      : undefined,
  }
}

function cliproxyOptions(config) {
  const section = config?.cliproxy ?? {}
  const mode = section.mode === 'external' || section.mode === 'off' ? section.mode : 'managed'
  return {
    mode,
    port: section.port || 8317,
    externalUrl: section.externalUrl,
    binaryPath: section.binaryPath,
    version: section.version || 'latest',
    managementKeyEnv: section.managementKeyEnv || DEFAULT_MANAGEMENT_KEY_ENV,
    apiKeyEnv: section.apiKeyEnv || DEFAULT_PROXY_API_KEY_ENV,
    retryPolicy: llm.resolveRetryPolicy
      ? llm.resolveRetryPolicy(section.retryPolicy, 'subscriptions: cliproxy.retryPolicy')
      : undefined,
  }
}

function randomKey() {
  return randomBytes(24).toString('base64url')
}

// The proxy's management key and inbound API key are machine secrets: created
// once, persisted in DSH credentials, never shipped to the browser.
function makeSecretsResolver(ctx, getConf) {
  let inflight
  const persisted = new Set()

  async function persist(ref, value) {
    if (persisted.has(ref)) return
    const credentials = ctx.get?.('credentials')
    if (!credentials?.set) return
    try {
      await credentials.set(ref, value)
      persisted.add(ref)
    } catch {
      // Retried on the next getSecrets() call.
    }
  }

  // The credentials service may register after this plugin applies; wait a
  // moment so keys from previous sessions are found instead of regenerated.
  async function waitForCredentials(timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs
    for (;;) {
      const credentials = ctx.get?.('credentials')
      if (credentials?.resolve || Date.now() >= until) return credentials
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async function resolveOnce() {
    const conf = getConf()
    const credentials = await waitForCredentials()
    const read = async (ref) => {
      try {
        return (await credentials?.resolve?.(ref))?.value
      } catch {
        return undefined
      }
    }
    let managementKey = (await read(conf.managementKeyEnv)) || process.env[conf.managementKeyEnv]
    let apiKey = (await read(conf.apiKeyEnv)) || process.env[conf.apiKeyEnv]
    if (managementKey) persisted.add(conf.managementKeyEnv)
    else managementKey = randomKey()
    if (apiKey) persisted.add(conf.apiKeyEnv)
    else apiKey = randomKey()
    return { managementKey, apiKey }
  }

  return async function getSecrets() {
    inflight ??= resolveOnce()
    const secrets = await inflight
    const conf = getConf()
    await persist(conf.managementKeyEnv, secrets.managementKey)
    await persist(conf.apiKeyEnv, secrets.apiKey)
    return secrets
  }
}

export function apply(ctx, config = {}) {
  let current = () => config

  const searchControl = {
    preferred: () => 'grok',
  }
  const cursor = applyCursor(ctx, {
    llm,
    options: () => cursorOptions(current()),
    allowNativeSearch: () => searchControl.preferred() === 'cursor',
  })
  void cursor.accounts.list().catch(() => {})

  const factoryCatalog = createFactoryCatalog()
  const FactoryAdapter = createFactoryAdapterClass({
    LlmAdapter: llm.LlmAdapter,
    LlmError: llm.LlmError,
    CallId: llm.CallId,
    ReasoningEffortId: llm.ReasoningEffortId,
  })

  const proxyConf = () => cliproxyOptions(current())
  const cpaEnabled = () => {
    const mode = proxyConf().mode
    return mode === 'managed' || mode === 'external'
  }
  const getSecrets = makeSecretsResolver(ctx, proxyConf)
  const supervisor = createProxySupervisor({
    logger: ctx.logger,
    getSettings: proxyConf,
    getSecrets,
  })
  const mgmt = createManagementClient({
    getBaseUrl: supervisor.baseUrl,
    getKey: async () => (await getSecrets()).managementKey,
  })
  const proxyCatalog = createProxyCatalog({
    getBaseUrl: supervisor.baseUrl,
    getApiKey: async () => (await getSecrets()).apiKey,
    logger: ctx.logger,
  })
  const ProxyAdapter = createProxyAdapterClass({
    LlmAdapter: llm.LlmAdapter,
    LlmError: llm.LlmError,
    CallId: llm.CallId,
    ReasoningEffortId: llm.ReasoningEffortId,
  })
  const proxyAdapter = new ProxyAdapter({
    catalog: proxyCatalog,
    getBaseUrl: supervisor.baseUrl,
    getApiKey: async () => (await getSecrets()).apiKey,
    retryPolicy: () => proxyConf().retryPolicy,
    resolveAttachments: () => ctx.get?.('attachments'),
    describeLoginHint: () => '。打开 设置 → 订阅（或 /subscriptions）检查代理状态',
  })

  const factory = createFactoryManager({
    getCredentials: () => ctx.get?.('credentials'),
    mgmt,
    proxyStatus: () => supervisor.status(),
    onChanged: () => {
      factoryCatalog.invalidate()
      proxyCatalog.invalidate()
    },
    logger: ctx.logger,
  })

  const factoryAdapter = new FactoryAdapter({
    catalog: factoryCatalog,
    resolveAccount: () => factory.resolveAccount(),
    requestHeaders: (account, apiProvider) => factory.requestHeaders(account, apiProvider),
    retryPolicy: () => proxyConf().retryPolicy,
    resolveAttachments: () => ctx.get?.('attachments'),
    describeLoginHint: () => '。打开 设置 → 订阅 添加 Factory API Key 或导入 droid CLI',
  })
  ctx.llm.registerAdapter([FACTORY_PROVIDER_ID], factoryAdapter)

  if (cpaEnabled()) {
    ctx.llm.registerAdapter(CPA_PROVIDER_IDS, proxyAdapter)
  }

  ctx.llm.registerConfigurableProviders?.([
    { provider: CURSOR_PROVIDER, displayName: 'Cursor', settingsNs: NS, settingsPath: ['cursor'] },
    { provider: FACTORY_PROVIDER_ID, displayName: 'Factory Droid', settingsNs: NS, settingsPath: ['cliproxy'] },
    ...[...PROXY_PROVIDERS.filter((p) => p.id !== FACTORY_PROVIDER_ID), FALLBACK_PROVIDER].map((provider) => ({
      provider: provider.id,
      displayName: provider.label,
      settingsNs: NS,
      settingsPath: ['cliproxy'],
    })),
  ])

  const subscriptions = createSubscriptionsController({
    supervisor,
    mgmt,
    catalog: {
      overview: async () => {
        const factoryOverview = await factoryCatalog.overview()
        if (!cpaEnabled()) return factoryOverview
        const proxyOverview = await proxyCatalog.overview().catch(() => ({ providers: [], error: undefined }))
        const byId = new Map()
        for (const entry of [...factoryOverview.providers, ...(proxyOverview.providers ?? [])]) {
          byId.set(entry.id, entry)
        }
        return {
          at: Date.now(),
          error: proxyOverview.error,
          providers: [...byId.values()],
        }
      },
      invalidate: () => {
        factoryCatalog.invalidate()
        proxyCatalog.invalidate()
      },
    },
    cursorOauth: cursor.oauth,
    factory,
    webSearch: () => webSearch,
    logger: ctx.logger,
  })
  const webSearch = registerSubscriptionsWebSearch(ctx, {
    preferencePath: join(proxyHome(), 'web-search.json'),
    defaultPreferred: 'grok',
    peerIds: ['deepseek-official'],
    listSearchModels: async () => {
      const groups = []
      try {
        if (cpaEnabled()) {
          const overview = await proxyCatalog.overview().catch(() => ({ providers: [] }))
          const grok = overview.providers?.find((entry) => entry.id === 'grok-build')
          const ids = grok?.models ?? []
          if (ids.length > 0) {
            groups.push({
              id: 'grok',
              label: 'Grok Build',
              available: true,
              models: ids.map((id) => ({ id, name: id })),
            })
          }
        }
      } catch { /* skip */ }
      try {
        if (cursor.accounts.hasUsable()) {
          const picked = await cursor.accounts.pick({ advance: false })
          const catalog = await loadCatalog(picked?.apiKey)
          const models = listCatalogModels('cursor', catalog)
          if (models.length > 0) {
            groups.push({
              id: 'cursor',
              label: 'Cursor',
              available: true,
              models: models.map((model) => ({ id: model.id, name: model.name })),
            })
          }
        }
      } catch { /* skip */ }
      if (factory.hasActiveBearer()) {
        groups.push({
          id: 'factory',
          label: 'Factory',
          available: true,
          models: [
            ...FACTORY_MODELS.xai.map((model) => ({
              id: model.name,
              name: model.display,
            })),
            ...FACTORY_MODELS.anthropic.map((model) => ({
              id: model.name,
              name: model.display,
            })),
          ],
        })
      }
      return groups
    },
    factory: {
      resolveApiKey: () => factory.resolveBearer(),
      hasCredential: () => factory.hasActiveBearer(),
    },
    cursor: {
      hasCredential: () => cursor.accounts.hasUsable() === true,
      resolveApiKey: async () => {
        const picked = await cursor.accounts.pick({ advance: false })
        return picked?.apiKey
      },
    },
    grok: {
      getBaseUrl: () => supervisor.baseUrl(),
      resolveApiKey: async () => (await getSecrets()).apiKey,
      hasCredential: () => {
        if (!cpaEnabled()) return false
        const phase = supervisor.status()?.phase
        if (phase !== 'running' && phase !== 'external-ok') return false
        // Cheap sync probe: any non-disabled xai/grok auth file under auth-dir.
        try {
          const authDir = supervisor.paths?.auth
          if (!authDir) return false
          for (const name of readdirSync(authDir)) {
            if (!name.endsWith('.json')) continue
            try {
              const raw = JSON.parse(readFileSync(join(authDir, name), 'utf8'))
              const channel = String(raw?.type || raw?.provider || raw?.channel || '').toLowerCase()
              if (raw?.disabled === true) continue
              if (providerForChannel(channel) === 'grok-build' || /xai|grok/.test(channel)) return true
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
        return false
      },
      listModels: async () => {
        const overview = await proxyCatalog.overview().catch(() => ({ providers: [] }))
        const grok = overview.providers?.find((entry) => entry.id === 'grok-build')
        return grok?.models ?? []
      },
    },
    logger: ctx.logger,
  })
  searchControl.preferred = webSearch.getPreferred
  ctx.inject(['webServer'], (webCtx) => {
    registerSubscriptionRoutes(webCtx, subscriptions, {
      supervisor,
      mgmt,
      catalog: proxyCatalog,
    })
  })

  ctx.inject(['commands'], (cmdCtx) => {
    registerSubscriptionCommands(cmdCtx, { cursorOauth: cursor.oauth, subscriptions })
  })

  let started = false
  const startServices = () => {
    if (started) return
    started = true
    factory.start()
    if (cpaEnabled()) void supervisor.start()
    else ctx.logger?.info?.('CLIProxyAPI disabled (cliproxy.mode=off); Factory + Cursor run direct')
  }
  try {
    ctx.inject(['credentials'], () => startServices())
  } catch {
    startServices()
  }
  const startFallback = setTimeout(startServices, 15_000)
  if (typeof startFallback.unref === 'function') startFallback.unref()

  const stopServices = () => {
    clearTimeout(startFallback)
    factory.stop()
    void supervisor.stop()
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => stopServices, 'subscriptions: stop factory/cliproxy')
    } catch {
      ctx.on?.('dispose', stopServices)
    }
  } else {
    ctx.on?.('dispose', stopServices)
  }

  importHost('@deepseek-ai/dsh-settings').then((settings) => {
    const install = settings.installSettingsSection
    const namespace = settings.settingsNamespace?.(NS) ?? NS
    if (!install || !Config) return
    install(ctx, namespace, Config, config, {
      setSource: (source) => {
        current = source
      },
    })
  }).catch(() => {
    // Settings seam is optional: env / credentials still work.
  })
}
