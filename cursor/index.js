import { importHost } from '../host.js'
import { createAccountStore } from './accounts.js'
import { createCursorAdapterClass } from './adapter.js'
import { createOAuthController, registerOAuthRoutes } from './oauth.js'

export const CURSOR_PROVIDER = 'cursor'
export const DEFAULT_CURSOR_API_KEY_ENV = 'CURSOR_API_KEY'

async function resolveApiKey(ctx, connection, assertUsableApiKey) {
  const ref = connection.apiKeyEnv
  const credentials = ctx.get?.('credentials')
  if (credentials) {
    const hit = await credentials.resolve(ref)
    if (hit?.value) return assertUsableApiKey(hit.value, 'subscriptions', ref)
  }

  let environment
  try {
    const launch = await importHost('@deepseek-ai/dsh-launch-environment')
    environment = launch.launchEnvironmentOf?.(ctx)?.get?.(ref)
  } catch {
    environment = undefined
  }
  if (environment?.value) return assertUsableApiKey(environment.value, 'subscriptions', ref)

  const ambient = process.env[ref]
  if (ambient) return assertUsableApiKey(ambient, 'subscriptions', ref)

  // @cursor/sdk can still use a stored Cursor.auth.login() key.
  return undefined
}

export function applyCursor(ctx, { llm, options, allowNativeSearch }) {
  const { LlmAdapter, LlmError, CallId, ReasoningEffortId, assertUsableApiKey } = llm
  const CursorAdapter = createCursorAdapterClass({ LlmAdapter, LlmError, CallId, ReasoningEffortId })

  const accounts = createAccountStore({
    getCredentials: () => ctx.get?.('credentials'),
    getApiKeyEnv: () => options().apiKeyEnv,
    logger: ctx.logger,
  })

  const adapter = new CursorAdapter({
    options,
    // Rotate across stored accounts; fall back to the single-key resolution
    // (credential / launch env / process env) when the store is empty.
    resolveApiKey: async (connection, { advance = true } = {}) => {
      const picked = await accounts.pick({ advance })
      if (picked?.apiKey) return picked.apiKey
      return resolveApiKey(ctx, connection, assertUsableApiKey)
    },
    reportAuthFailure: (apiKey) => accounts.reportAuthFailure(apiKey),
    resolveAttachments: () => ctx.get?.('attachments'),
    allowNativeSearch: () => allowNativeSearch?.() === true,
  })
  ctx.llm.registerAdapter([CURSOR_PROVIDER], adapter)

  const oauth = createOAuthController({
    getApiKeyEnv: () => options().apiKeyEnv,
    getCredentials: () => ctx.get?.('credentials'),
    accounts,
    logger: ctx.logger,
  })
  ctx.inject(['webServer'], (webCtx) => registerOAuthRoutes(webCtx, oauth))

  return { oauth, accounts }
}
