/**
 * Search-provider router for DSH `ctx.web`.
 *
 * Pins a single seam id (`subscriptions`) so DSH never hits
 * WEB_PROVIDER_AMBIGUOUS. The user picks a concrete search model from the
 * live catalog (Grok / Cursor / Factory / DeepSeek); preference is persisted.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { importHost } from '../host.js'
import { factoryUpstreamModelId } from './factory.js'
import {
  FACTORY_SEARCH_PROVIDER_ID,
  createFactorySearchProvider,
  FACTORY_SEARCH_DEFAULT_BASE_URL,
  FACTORY_SEARCH_DEFAULT_MODEL,
  FACTORY_SEARCH_DEFAULT_API_VERSION,
  FACTORY_SEARCH_DEFAULT_MAX_TOKENS,
  FACTORY_SEARCH_DEFAULT_MAX_USES,
} from './web-search-factory.js'
import {
  GROK_SEARCH_PROVIDER_ID,
  createGrokSearchProvider,
} from './web-search-grok.js'
import {
  CURSOR_SEARCH_PROVIDER_ID,
  createCursorSearchProvider,
} from './web-search-cursor.js'

export const SEARCH_ROUTER_ID = 'subscriptions'
export const SEARCH_DEFAULT_PREFERRED = GROK_SEARCH_PROVIDER_ID

const BACKEND_META = {
  [GROK_SEARCH_PROVIDER_ID]: {
    label: 'Grok Build',
    hint: '需在「订阅」登录 Grok Build（走 CLIProxyAPI）',
  },
  [CURSOR_SEARCH_PROVIDER_ID]: {
    label: 'Cursor',
    hint: '需登录 Cursor；对话走 Cursor 模型时同时开放原生 webSearch',
  },
  [FACTORY_SEARCH_PROVIDER_ID]: {
    label: 'Factory',
    hint: '需添加 Factory 账号（Anthropic 原生 web_search）',
  },
  'deepseek-official': {
    label: 'DeepSeek',
    hint: '需配置 DEEPSEEK_API_KEY（Models / 凭证）',
    peer: true,
  },
}

const PREFERRED_FALLBACK_ORDER = [
  GROK_SEARCH_PROVIDER_ID,
  CURSOR_SEARCH_PROVIDER_ID,
  FACTORY_SEARCH_PROVIDER_ID,
  'deepseek-official',
]

const MODELS_CACHE_MS = 8_000

function readPreference(path, fallbackProvider) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const provider = typeof raw?.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw?.model === 'string' ? raw.model.trim() : ''
    return {
      provider: provider || fallbackProvider,
      model: model || '',
    }
  } catch {
    return { provider: fallbackProvider, model: '' }
  }
}

function writePreference(path, preference) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(preference, null, 2)}\n`, 'utf8')
}

function parseSelection(provider, model) {
  const rawProvider = String(provider || '').trim()
  const rawModel = String(model || '').trim()
  if (rawProvider.includes(':') && !rawModel) {
    const index = rawProvider.indexOf(':')
    return {
      provider: rawProvider.slice(0, index),
      model: rawProvider.slice(index + 1),
    }
  }
  return { provider: rawProvider, model: rawModel }
}

function defaultModelFor(provider, groups) {
  const group = (groups ?? []).find((entry) => entry.id === provider)
  const models = group?.models ?? []
  if (models.length === 0) return ''
  if (provider === GROK_SEARCH_PROVIDER_ID) {
    return models.find((item) => /grok-4/i.test(item.id))?.id
      ?? models.find((item) => /grok/i.test(item.id))?.id
      ?? models[0].id
  }
  if (provider === CURSOR_SEARCH_PROVIDER_ID) {
    return models.find((item) => /grok-4/i.test(item.id))?.id
      ?? models.find((item) => item.id === 'composer-2.5')?.id
      ?? models[0].id
  }
  if (provider === FACTORY_SEARCH_PROVIDER_ID) {
    return models.find((item) => /grok-4\.6/i.test(item.id))?.id
      ?? models.find((item) => /grok/i.test(item.id))?.id
      ?? models.find((item) => /sonnet-4-6/i.test(item.id))?.id
      ?? models[0].id
  }
  return models[0].id
}

function resolveActive(backends, preferred) {
  if (preferred && backends.get(preferred)?.available()) return preferred
  for (const id of PREFERRED_FALLBACK_ORDER) {
    if (backends.get(id)?.available()) return id
  }
  for (const [id, provider] of backends) {
    if (provider.available()) return id
  }
  return undefined
}

function createRouterProvider({ WebError, getBackends, getPreferred }) {
  return {
    id: SEARCH_ROUTER_ID,
    available() {
      return [...getBackends().values()].some((provider) => provider.available())
    },
    async search(request, signal) {
      const backends = getBackends()
      const preferred = getPreferred()
      const activeId = resolveActive(backends, preferred)
      if (!activeId) {
        throw new WebError(
          '没有可用的搜索模型：请登录 Grok Build / Cursor、添加 Factory 账号，或配置 DeepSeek API Key',
          'WEB_PROVIDER_UNAVAILABLE',
        )
      }
      const provider = backends.get(activeId)
      if (!provider) {
        throw new WebError(
          `search backend "${activeId}" is missing`,
          'WEB_PROVIDER_CONFIGURED_MISSING',
        )
      }
      return provider.search(request, signal)
    },
  }
}

/**
 * Register the subscriptions search router on `ctx.web`.
 *
 * @returns {{ status: () => object, describe: () => Promise<object>, setPreferred: Function, getPreferred: Function }}
 */
export function registerSubscriptionsWebSearch(ctx, deps) {
  let router
  let owned
  let webRef
  let modelsCache = { at: 0, groups: [] }

  const preferencePath = deps.preferencePath
  let preference = readPreference(preferencePath, deps.defaultPreferred || SEARCH_DEFAULT_PREFERRED)

  const getPreferred = () => preference.provider
  const getPreference = () => preference

  const getBackends = () => {
    const map = new Map(owned ?? [])
    if (webRef?.searchProviders instanceof Map) {
      for (const id of deps.peerIds ?? []) {
        if (map.has(id)) continue
        const peer = webRef.searchProviders.get(id)
        if (peer) map.set(id, peer)
      }
    }
    return map
  }

  const knownProviders = () => new Set([
    ...PREFERRED_FALLBACK_ORDER,
    ...(owned ? owned.keys() : []),
    ...(deps.peerIds ?? []),
  ])

  const modelForBackend = (backend, groups) => {
    if (preference.provider === backend && preference.model) return preference.model
    return defaultModelFor(backend, groups)
  }

  async function listGroups({ force = false } = {}) {
    if (!force && Date.now() - modelsCache.at < MODELS_CACHE_MS && modelsCache.groups.length > 0) {
      return modelsCache.groups
    }
    const groups = []
    try {
      const listed = await deps.listSearchModels?.() ?? []
      for (const group of listed) {
        if (group?.id && Array.isArray(group.models) && group.models.length > 0) {
          groups.push(group)
        }
      }
    } catch (error) {
      deps.logger?.warn?.(
        `search model list failed: ${error instanceof Error ? error.message : error}`,
      )
    }
    const backends = getBackends()
    const deepseek = backends.get('deepseek-official')
    if (deepseek?.available?.() && !groups.some((group) => group.id === 'deepseek-official')) {
      groups.push({
        id: 'deepseek-official',
        label: BACKEND_META['deepseek-official'].label,
        available: true,
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      })
    }
    modelsCache = { at: Date.now(), groups }
    return groups
  }

  function snapshot(groups) {
    const backends = getBackends()
    const preferred = preference.provider
    const active = router ? resolveActive(backends, preferred) : undefined
    const preferredModel = preference.model || defaultModelFor(preferred, groups)
    const activeModel = active
      ? (active === preferred ? preferredModel : defaultModelFor(active, groups))
      : null

    const ids = new Set([
      ...PREFERRED_FALLBACK_ORDER,
      ...backends.keys(),
      ...groups.map((group) => group.id),
    ])
    const backendList = [...ids].map((id) => {
      const meta = BACKEND_META[id] ?? { label: id, hint: '' }
      const provider = backends.get(id)
      const group = groups.find((entry) => entry.id === id)
      const available = group?.available === true || provider?.available?.() === true
      let detail = meta.hint
      if (available) detail = '可用'
      else if (!provider && !group) detail = meta.peer ? (meta.hint || '未注册') : (meta.hint || '未启用')
      return {
        id,
        label: meta.label,
        available,
        preferred: preferred === id,
        active: active === id,
        peer: meta.peer === true,
        detail,
      }
    })

    const decorated = groups.map((group) => ({
      ...group,
      available: group.available === true || backends.get(group.id)?.available?.() === true,
      models: (group.models ?? []).map((model) => ({
        ...model,
        selected: preferred === group.id && preferredModel === model.id,
        active: active === group.id && activeModel === model.id,
      })),
    }))

    return {
      seamId: SEARCH_ROUTER_ID,
      preferred,
      preferredModel: preferredModel || null,
      active: active ?? null,
      activeModel,
      backends: backendList,
      groups: decorated,
    }
  }

  const status = () => snapshot(modelsCache.groups)

  const describe = async () => snapshot(await listGroups())

  const setPreferred = async (provider, model) => {
    const next = parseSelection(provider, model)
    if (!next.provider) throw new Error('missing provider id')
    if (!knownProviders().has(next.provider)) {
      throw new Error(`unknown search provider: ${next.provider}`)
    }
    preference = { provider: next.provider, model: next.model }
    writePreference(preferencePath, preference)
    modelsCache = { at: 0, groups: modelsCache.groups }
    return describe()
  }

  const run = async (webCtx) => {
    let WebError
    try {
      const web = await importHost('@deepseek-ai/dsh-web')
      WebError = web.WebError
    } catch (error) {
      deps.logger?.warn?.(
        `subscriptions web search skipped: dsh-web unavailable (${error instanceof Error ? error.message : error})`,
      )
      return
    }
    if (!WebError || !webCtx.web?.registerSearchProvider) {
      deps.logger?.warn?.('subscriptions web search skipped: web seam missing registerSearchProvider')
      return
    }
    webRef = webCtx.web

    owned = new Map()
    owned.set(
      GROK_SEARCH_PROVIDER_ID,
      createGrokSearchProvider({
        WebError,
        resolveOptions: () => ({
          hasCredential: deps.grok?.hasCredential,
          getBaseUrl: deps.grok?.getBaseUrl,
          resolveApiKey: deps.grok?.resolveApiKey,
          listModels: deps.grok?.listModels,
          model: modelForBackend(GROK_SEARCH_PROVIDER_ID, modelsCache.groups) || undefined,
          logger: deps.logger,
        }),
      }),
    )
    owned.set(
      CURSOR_SEARCH_PROVIDER_ID,
      createCursorSearchProvider({
        WebError,
        resolveOptions: () => ({
          hasCredential: deps.cursor?.hasCredential,
          resolveApiKey: deps.cursor?.resolveApiKey,
          model: modelForBackend(CURSOR_SEARCH_PROVIDER_ID, modelsCache.groups) || undefined,
        }),
      }),
    )
    owned.set(
      FACTORY_SEARCH_PROVIDER_ID,
      createFactorySearchProvider({
        WebError,
        resolveOptions: () => ({
          resolveApiKey: deps.factory?.resolveApiKey,
          hasCredential: deps.factory?.hasCredential,
          baseURL: deps.factory?.baseURL || FACTORY_SEARCH_DEFAULT_BASE_URL,
          model: factoryUpstreamModelId(
            modelForBackend(FACTORY_SEARCH_PROVIDER_ID, modelsCache.groups)
            || FACTORY_SEARCH_DEFAULT_MODEL,
          ),
          apiVersion: deps.factory?.apiVersion || FACTORY_SEARCH_DEFAULT_API_VERSION,
          maxTokens: deps.factory?.maxTokens || FACTORY_SEARCH_DEFAULT_MAX_TOKENS,
          maxUses: deps.factory?.maxUses || FACTORY_SEARCH_DEFAULT_MAX_USES,
          recordRequest: () => {},
        }),
      }),
    )

    router = createRouterProvider({
      WebError,
      getBackends,
      getPreferred,
    })

    const disposer = webCtx.web.registerSearchProvider(router)
    deps.logger?.info?.(
      `registered web search router: ${SEARCH_ROUTER_ID} (preferred=${preference.provider}${preference.model ? `/${preference.model}` : ''})`,
    )
    return disposer
  }

  try {
    ctx.inject(['web'], (webCtx) => {
      void run(webCtx)
    })
  } catch (error) {
    deps.logger?.warn?.(
      `subscriptions web search inject failed: ${error instanceof Error ? error.message : error}`,
    )
  }

  return { status, describe, setPreferred, getPreferred, getPreference }
}
