/**
 * Factory-backed WebSearchProvider for DSH `ctx.web`.
 *
 * Same shape as `@deepseek-ai/dsh-web-search-deepseek`: one Anthropic Messages
 * call with the native `web_search_20250305` server tool. Factory's Claude
 * route requires the Droid system prefix or it returns 403.
 */

import { importHost } from '../host.js'
import { FACTORY_API, factoryUpstreamModelId } from './factory.js'

export const FACTORY_SEARCH_PROVIDER_ID = 'factory'
export const FACTORY_SEARCH_DEFAULT_BASE_URL = 'https://api.factory.ai/api/llm/a/v1'
export const FACTORY_SEARCH_DEFAULT_MODEL = 'claude-sonnet-4-6'
export const FACTORY_SEARCH_DEFAULT_API_VERSION = '2023-06-01'
export const FACTORY_SEARCH_DEFAULT_MAX_TOKENS = 4096
export const FACTORY_SEARCH_DEFAULT_MAX_USES = 5
const FACTORY_GROK_SEARCH_MAX_TOKENS = 1024

const DROID_SYSTEM_PREFIX = 'You are Droid, an AI software engineering agent built by Factory.\n\n'
const USER_AGENT = 'factory-cli/0.175.0'

function searchUserPrompt(query) {
  return [
    `Perform a web search for the query: ${query}`,
    '',
    'After the search tool returns, write a concise factual answer that extracts the concrete details needed to answer the query (temperatures, conditions, dates, numbers, names, status). Prefer authoritative / official sources. Do not reply with only a link list — include the extracted facts in your answer text, and cite sources.',
  ].join('\n')
}

function citationSnippets(blocks) {
  const map = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      if (!cite?.url || !cite.cited_text) continue
      const text = String(cite.cited_text).trim()
      if (!text) continue
      const prev = map.get(cite.url)
      if (!prev) map.set(cite.url, text)
      else if (!prev.includes(text)) map.set(cite.url, `${prev} ${text}`)
    }
  }
  return map
}

/** Join assistant text blocks into the seam's optional answer `content`. */
function answerContent(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    const text = typeof block.text === 'string' ? block.text.trim() : ''
    if (text) parts.push(text)
  }
  const joined = parts.join('\n\n').trim()
  return joined.length > 0 ? joined : undefined
}

function mapAnthropicResponse(response, WebError) {
  const blocks = response?.content ?? []
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new WebError(
      'Factory returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }
  const snippets = citationSnippets(blocks)
  const content = answerContent(blocks)
  const seen = new Set()
  const sources = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
      })
    }
  }
  return {
    ...(content ? { content } : {}),
    sources,
    truncated: false,
  }
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isFactoryGrok(model) {
  return /^grok/i.test(factoryUpstreamModelId(model))
}

function extractResponsesText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }
  const parts = []
  for (const item of payload?.output ?? []) {
    if (item?.type !== 'message') continue
    for (const block of item.content ?? []) {
      if (block?.type === 'output_text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
  }
  return parts.join('\n\n').trim() || undefined
}

function extractResponsesUrls(payload) {
  const urls = []
  if (Array.isArray(payload?.citations)) {
    for (const item of payload.citations) {
      if (typeof item === 'string') urls.push(item)
      else if (item && typeof item.url === 'string') urls.push(item.url)
    }
  }
  for (const item of payload?.output ?? []) {
    for (const block of item?.content ?? []) {
      for (const ann of block?.annotations ?? []) {
        if (ann?.url) urls.push(ann.url)
      }
      if (typeof block?.text === 'string') {
        for (const match of block.text.matchAll(/https?:\/\/[^\s)\]>'"`]+/g)) {
          urls.push(match[0].replace(/[),.;]+$/g, ''))
        }
      }
    }
  }
  const seen = new Set()
  return urls.filter((url) => {
    if (!url || seen.has(url)) return false
    seen.add(url)
    return true
  })
}

export function createFactorySearchProvider({ WebError, resolveOptions }) {
  const searchAborted = (signal, fallback) =>
    new WebError('Factory search aborted', 'WEB_ABORTED', {
      cause: signal?.aborted === true ? signal.reason : fallback,
    })

  const throwIfAborted = (signal) => {
    if (signal?.aborted === true) throw searchAborted(signal)
  }

  return {
    id: FACTORY_SEARCH_PROVIDER_ID,
    available() {
      const options = resolveOptions()
      // Credential presence is checked at search() time (accounts may still be
      // loading when the seam first probes availability). Mirror DeepSeek:
      // a resolver is enough for "usable" until the configured key is required.
      const canResolve = typeof options.resolveApiKey === 'function'
        || (options.hasCredential?.() === true)
      return (
        canResolve
        && URL.canParse(options.baseURL)
        && isPositiveInteger(options.maxTokens)
        && isPositiveInteger(options.maxUses)
      )
    },
    async search(request, signal) {
      const options = resolveOptions()
      throwIfAborted(signal)
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
      throwIfAborted(signal)

      const model = factoryUpstreamModelId(options.model)
      if (isFactoryGrok(model)) {
        const endpoint = `${FACTORY_API}/o/v1/responses`
        const body = {
          model,
          instructions: DROID_SYSTEM_PREFIX,
          input: [{ role: 'user', content: searchUserPrompt(request.query) }],
          tools: [{ type: 'web_search' }],
          max_output_tokens: Math.min(options.maxTokens || FACTORY_GROK_SEARCH_MAX_TOKENS, FACTORY_GROK_SEARCH_MAX_TOKENS),
          reasoning: { effort: 'low' },
        }
        options.recordRequest?.({ endpoint, body })
        let response
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'x-api-key': apiKey,
              'x-api-provider': 'xai',
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
          throw new WebError(`Factory Grok search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
        }
        if (!response.ok) {
          let message = `Factory Grok API error (HTTP ${response.status})`
          try {
            const parsed = await response.json()
            const detail = typeof parsed.error === 'string'
              ? parsed.error
              : parsed.error?.message ?? parsed.detail ?? parsed.message
            if (detail) message = detail
          } catch (error) {
            if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
          }
          throw new WebError(message, 'WEB_PROVIDER_ERROR')
        }
        const payload = await response.json()
        const content = extractResponsesText(payload)
        const sources = extractResponsesUrls(payload).map((url) => ({ url }))
        if (!content && sources.length === 0) {
          throw new WebError('Factory Grok search returned no answer or sources', 'WEB_PROVIDER_ERROR')
        }
        return {
          ...(content ? { content } : {}),
          sources,
          truncated: false,
        }
      }

      const endpoint = `${options.baseURL.replace(/\/$/, '')}/messages`
      const body = {
        model: options.model,
        max_tokens: options.maxTokens,
        system: DROID_SYSTEM_PREFIX,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: searchUserPrompt(request.query) }],
        }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: options.maxUses,
        }],
      }

      options.recordRequest?.({ endpoint, apiVersion: options.apiVersion, body })

      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'x-api-key': apiKey,
            authorization: `Bearer ${apiKey}`,
            'anthropic-version': options.apiVersion,
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
        let message = `Factory API error (HTTP ${response.status})`
        try {
          const parsed = await response.json()
          const detail = typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error?.message ?? parsed.detail ?? parsed.message
          if (detail) message = detail
        } catch (error) {
          if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        }
        throw new WebError(message, 'WEB_PROVIDER_ERROR')
      }

      try {
        return mapAnthropicResponse(await response.json(), WebError)
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        if (error && typeof error === 'object' && error.name === 'WebError') throw error
        if (error instanceof WebError) throw error
        throw new WebError(
          `Factory returned an unprocessable response body: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
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
      model: deps.model || FACTORY_SEARCH_DEFAULT_MODEL,
      apiVersion: deps.apiVersion || FACTORY_SEARCH_DEFAULT_API_VERSION,
      maxTokens: deps.maxTokens || FACTORY_SEARCH_DEFAULT_MAX_TOKENS,
      maxUses: deps.maxUses || FACTORY_SEARCH_DEFAULT_MAX_USES,
      recordRequest: () => {
        // Do not append a custom session event type here. Unknown types that
        // are not in dsh-session's known list and not marked `ignorable` make
        // history reload refuse the whole session (SessionFormatUnsupportedError).
        // Official DeepSeek search can log `web/deepseek-search-llm-request`
        // because that type is compiled into the harness vocabulary.
      },
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
