/**
 * Factory-backed WebSearchProvider for DSH `ctx.web`.
 *
 * Mirrors Factory CLI WebSearch: POST /api/tools/web-search with a query.
 * No LLM is involved. FetchUrl is POST /api/tools/get-url-contents.
 */

import { importHost } from '../host.js'
import { FACTORY_USER_AGENT } from './factory.js'

export const FACTORY_SEARCH_PROVIDER_ID = 'factory'
export const FACTORY_SEARCH_TOOL_ID = 'web-search'
export const FACTORY_SEARCH_DEFAULT_BASE_URL = 'https://api.factory.ai'
export const FACTORY_SEARCH_DEFAULT_NUM_RESULTS = 10

const USER_AGENT = FACTORY_USER_AGENT

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function asText(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function snippetOf(item) {
  const description = asText(item?.description)
  if (description) return description
  const summary = asText(item?.summary)
  if (summary) return summary
  if (Array.isArray(item?.snippets) && item.snippets.length > 0) {
    return item.snippets.map((part) => asText(part)).filter(Boolean).join(' ')
  }
  if (Array.isArray(item?.excerpts) && item.excerpts.length > 0) {
    return item.excerpts.map((part) => asText(part)).filter(Boolean).join(' ')
  }
  const text = asText(item?.text)
  return text ? text.slice(0, 400) : ''
}

function publishedAtOf(item) {
  return asText(item?.publishedDate)
    || asText(item?.publish_date)
    || asText(item?.page_age)
    || ''
}

function collectItems(payload) {
  const results = payload?.results
  if (Array.isArray(results)) return results
  if (results && typeof results === 'object') {
    return [...(results.web ?? []), ...(results.news ?? [])]
  }
  return []
}

function mapSearchPayload(payload, query) {
  const seen = new Set()
  const sources = []
  const lines = [`Web Search Results for: "${query}"`]
  for (const item of collectItems(payload)) {
    const url = asText(item?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const title = asText(item?.title) || undefined
    const snippet = snippetOf(item) || undefined
    const publishedAt = publishedAtOf(item) || undefined
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    })
    lines.push('---')
    lines.push(`**${title || url}**`)
    lines.push(`URL: ${url}`)
    if (publishedAt) lines.push(`Published: ${publishedAt}`)
    if (snippet) lines.push(snippet)
  }
  if (sources.length === 0) {
    return undefined
  }
  lines.push(`Found ${sources.length} result${sources.length === 1 ? '' : 's'}`)
  return {
    content: lines.join('\n'),
    sources,
    truncated: false,
  }
}

async function readErrorMessage(response) {
  let message = `Factory API error (HTTP ${response.status})`
  try {
    const parsed = await response.json()
    const detail = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error?.message ?? parsed.detail ?? parsed.message
    if (detail) message = String(detail)
  } catch {
    // Keep the status-only message.
  }
  return message
}

export function createFactorySearchProvider({ WebError, resolveOptions }) {
  const searchAborted = (signal, fallback) =>
    new WebError('Factory search aborted', 'WEB_ABORTED', {
      cause: signal?.aborted === true ? signal.reason : fallback,
    })

  return {
    id: FACTORY_SEARCH_PROVIDER_ID,
    available() {
      const options = resolveOptions()
      return typeof options.resolveApiKey === 'function'
        || options.hasCredential?.() === true
    },
    async search(request, signal) {
      const options = resolveOptions()
      if (signal?.aborted) throw searchAborted(signal)
      let apiKey
      try {
        apiKey = await options.resolveApiKey?.()
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(
          `Factory search credential resolution failed: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
      if (!apiKey) {
        throw new WebError(
          'Factory search has no API key; add a Factory account in 设置 → 订阅',
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }

      const base = String(options.baseURL || FACTORY_SEARCH_DEFAULT_BASE_URL).replace(/\/+$/, '')
      const numResults = Number.isInteger(request.maxResults) && request.maxResults > 0
        ? request.maxResults
        : (options.numResults || FACTORY_SEARCH_DEFAULT_NUM_RESULTS)
      const body = { query: request.query, numResults }
      const endpoint = `${base}/api/tools/web-search`

      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'x-api-key': apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
            'x-factory-client': 'cli',
          },
          body: JSON.stringify(body),
          ...(signal !== undefined ? { signal } : {}),
        })
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(`Factory search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      if (!response.ok) {
        throw new WebError(await readErrorMessage(response), 'WEB_PROVIDER_ERROR')
      }

      let payload
      try {
        payload = await response.json()
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(
          `Factory returned an unprocessable response body: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }

      const mapped = mapSearchPayload(payload, request.query)
      if (!mapped) {
        throw new WebError('Factory search returned no sources', 'WEB_PROVIDER_ERROR')
      }
      return mapped
    },
  }
}

/**
 * Register Factory search on `ctx.web` once the web seam is available.
 * @param {object} ctx - cordis plugin context
 * @param {{ resolveApiKey: () => Promise<string|undefined>, hasCredential: () => boolean, logger?: { warn?: Function } }} deps
 */
export function registerFactoryWebSearch(ctx, deps) {
  const run = async (webCtx) => {
    let WebError
    try {
      const web = await importHost('@deepseek-ai/dsh-web')
      WebError = web.WebError
    } catch (error) {
      deps.logger?.warn?.(`factory web search skipped: dsh-web unavailable (${error instanceof Error ? error.message : error})`)
      return
    }
    if (!WebError || !webCtx.web?.registerSearchProvider) {
      deps.logger?.warn?.('factory web search skipped: web seam missing registerSearchProvider')
      return
    }

    const resolveOptions = () => ({
      resolveApiKey: deps.resolveApiKey,
      hasCredential: deps.hasCredential,
      baseURL: deps.baseURL || FACTORY_SEARCH_DEFAULT_BASE_URL,
      numResults: deps.numResults || FACTORY_SEARCH_DEFAULT_NUM_RESULTS,
    })

    const disposer = webCtx.web.registerSearchProvider(
      createFactorySearchProvider({ WebError, resolveOptions }),
    )
    deps.logger?.info?.(`registered web search provider: ${FACTORY_SEARCH_PROVIDER_ID}`)
    return disposer
  }

  try {
    ctx.inject(['web'], (webCtx) => {
      void run(webCtx)
    })
  } catch (error) {
    deps.logger?.warn?.(`factory web search inject failed: ${error instanceof Error ? error.message : error}`)
  }
}
