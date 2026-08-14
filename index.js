import { importHost } from './host.js'
import { createCursorAdapterClass } from './adapter.js'
import { createOAuthController, registerOAuthCommand, registerOAuthRoutes } from './oauth.js'

export const name = 'llm-cursor'
export const inject = ['llm']

const PROVIDER = 'cursor'
const DEFAULT_API_KEY_ENV = 'CURSOR_API_KEY'
const NS = 'llm-cursor'

const llm = await importHost('@deepseek-ai/dsh-llm')
const {
  LlmAdapter,
  LlmError,
  CallId,
  ReasoningEffortId,
  assertUsableApiKey,
  resolveRetryPolicy,
} = llm

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

export const Config = Schema?.object?.({
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  models: Schema.array(catalogModel),
  retryPolicy: llm.RetryPolicySchema,
}) ?? undefined

const CursorAdapter = createCursorAdapterClass({ LlmAdapter, LlmError, CallId, ReasoningEffortId })

function resolveOptions(config) {
  return {
    apiKeyEnv: config?.apiKeyEnv || DEFAULT_API_KEY_ENV,
    models: config?.models,
    retryPolicy: resolveRetryPolicy
      ? resolveRetryPolicy(config?.retryPolicy, 'llm-cursor: retryPolicy')
      : undefined,
  }
}

async function resolveApiKey(ctx, connection) {
  const ref = connection.apiKeyEnv
  const credentials = ctx.get?.('credentials')
  if (credentials) {
    const hit = await credentials.resolve(ref)
    if (hit?.value) return assertUsableApiKey(hit.value, 'llm-cursor', ref)
  }

  let environment
  try {
    const launch = await importHost('@deepseek-ai/dsh-launch-environment')
    environment = launch.launchEnvironmentOf?.(ctx)?.get?.(ref)
  } catch {
    environment = undefined
  }
  if (environment?.value) return assertUsableApiKey(environment.value, 'llm-cursor', ref)

  const ambient = process.env[ref]
  if (ambient) return assertUsableApiKey(ambient, 'llm-cursor', ref)

  // @cursor/sdk can still use a stored Cursor.auth.login() key.
  return undefined
}

export function apply(ctx, config = {}) {
  let current = () => config
  const options = () => resolveOptions(current())
  const adapter = new CursorAdapter({
    options,
    resolveApiKey: (connection) => resolveApiKey(ctx, connection),
    resolveAttachments: () => ctx.get?.('attachments'),
  })

  ctx.llm.registerConfigurableProviders?.([
    { provider: PROVIDER, displayName: 'Cursor', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  const oauth = createOAuthController({
    getApiKeyEnv: () => options().apiKeyEnv,
    getCredentials: () => ctx.get?.('credentials'),
    logger: ctx.logger,
  })
  ctx.inject(['webServer'], (webCtx) => registerOAuthRoutes(webCtx, oauth))
  ctx.inject(['commands'], (cmdCtx) => registerOAuthCommand(cmdCtx, oauth))

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
