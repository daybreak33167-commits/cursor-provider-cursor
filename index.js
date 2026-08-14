import { randomBytes } from 'node:crypto'
import { importHost } from './host.js'
import { applyCursor, CURSOR_PROVIDER, DEFAULT_CURSOR_API_KEY_ENV } from './cursor/index.js'
import { registerSubscriptionCommands } from './commands.js'
import { createProxySupervisor } from './cliproxy/runtime.js'
import { createManagementClient } from './cliproxy/management.js'
import { createProxyCatalog } from './cliproxy/catalog.js'
import { createProxyAdapterClass } from './cliproxy/adapter.js'
import { createSubscriptionsController, registerSubscriptionRoutes } from './cliproxy/routes.js'
import { ALL_PROVIDER_IDS, FALLBACK_PROVIDER, PROXY_PROVIDERS } from './cliproxy/providers.js'

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
  mode: Schema.union(['managed', 'external']).default('managed')
    .description('managed：插件自动下载并托管 CLIProxyAPI；external：连接已有实例'),
  port: Schema.natural().default(8317).description('托管模式下 CLIProxyAPI 监听的本地端口'),
  externalUrl: Schema.string().description('external 模式的基础地址，例如 http://127.0.0.1:8317'),
  binaryPath: Schema.string().description('自备 CLIProxyAPI 可执行文件路径（跳过自动下载）'),
  version: Schema.string().default('latest').description('托管模式下载的版本（latest 或 7.2.131 这类版本号）'),
  managementKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_MANAGEMENT_KEY_ENV),
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_PROXY_API_KEY_ENV),
  retryPolicy: llm.RetryPolicySchema,
}).description('CLIProxyAPI（Claude Code / Codex / Antigravity / Kimi / Grok 等订阅）')

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
  return {
    mode: section.mode === 'external' ? 'external' : 'managed',
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

  // --- Cursor (existing @cursor/sdk adapter) ---
  const cursor = applyCursor(ctx, {
    llm,
    options: () => cursorOptions(current()),
  })

  // --- CLIProxyAPI managed proxy + OpenAI-compatible adapter ---
  const proxyConf = () => cliproxyOptions(current())
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
  const catalog = createProxyCatalog({
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
    catalog,
    getBaseUrl: supervisor.baseUrl,
    getApiKey: async () => (await getSecrets()).apiKey,
    retryPolicy: () => proxyConf().retryPolicy,
    resolveAttachments: () => ctx.get?.('attachments'),
    describeLoginHint: () => '。打开 设置 → 订阅（或 /subscriptions）检查代理状态',
  })
  ctx.llm.registerAdapter(ALL_PROVIDER_IDS, proxyAdapter)

  ctx.llm.registerConfigurableProviders?.([
    { provider: CURSOR_PROVIDER, displayName: 'Cursor', settingsNs: NS, settingsPath: ['cursor'] },
    ...[...PROXY_PROVIDERS, FALLBACK_PROVIDER].map((provider) => ({
      provider: provider.id,
      displayName: provider.label,
      settingsNs: NS,
      settingsPath: ['cliproxy'],
    })),
  ])

  const subscriptions = createSubscriptionsController({
    supervisor,
    mgmt,
    catalog,
    cursorOauth: cursor.oauth,
    logger: ctx.logger,
  })
  ctx.inject(['webServer'], (webCtx) => {
    registerSubscriptionRoutes(webCtx, subscriptions, { supervisor, mgmt, catalog })
  })

  ctx.inject(['commands'], (cmdCtx) => {
    registerSubscriptionCommands(cmdCtx, { cursorOauth: cursor.oauth, subscriptions })
  })

  // Start only once the credentials service is up so stored keys are reused
  // and a proxy left over from the previous session can be adopted instead of
  // killed over a key mismatch. Timer is a fallback for credential-less profiles.
  let proxyStarted = false
  const startProxy = () => {
    if (proxyStarted) return
    proxyStarted = true
    void supervisor.start()
  }
  try {
    ctx.inject(['credentials'], () => startProxy())
  } catch {
    startProxy()
  }
  const startFallback = setTimeout(startProxy, 15_000)
  if (typeof startFallback.unref === 'function') startFallback.unref()

  const stopProxy = () => {
    clearTimeout(startFallback)
    void supervisor.stop()
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => stopProxy, 'subscriptions: stop managed cliproxy')
    } catch {
      ctx.on?.('dispose', stopProxy)
    }
  } else {
    ctx.on?.('dispose', stopProxy)
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
