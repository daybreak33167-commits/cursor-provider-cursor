/**
 * Grok-backed WebSearchProvider for DSH `ctx.web`.
 *
 * Routes through the managed CLIProxyAPI (Grok Build / xAI OAuth) and prefers
 * the Responses API `web_search` tool; falls back to Chat Completions
 * `search_parameters` while that path still works.
 */

export const GROK_SEARCH_PROVIDER_ID = 'grok'
export const GROK_SEARCH_DEFAULT_MODEL = 'grok-4-1-fast'

function searchUserPrompt(query) {
  return [
    `Perform a web search for the query: ${query}`,
    '',
    'After searching, write a concise factual answer with concrete details',
    '(dates, numbers, names, status). Prefer authoritative sources. Cite URLs.',
  ].join('\n')
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function uniqueUrls(urls) {
  const seen = new Set()
  const out = []
  for (const url of urls) {
    if (typeof url !== 'string' || !url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function sourcesFromCitations(citations, content) {
  const urls = []
  if (Array.isArray(citations)) {
    for (const item of citations) {
      if (typeof item === 'string') urls.push(item)
      else if (item && typeof item.url === 'string') urls.push(item.url)
    }
  }
  return {
    ...(content ? { content } : {}),
    sources: uniqueUrls(urls).map((url) => ({ url })),
    truncated: false,
  }
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

function extractResponsesCitations(payload) {
  if (Array.isArray(payload?.citations)) return payload.citations
  const urls = []
  for (const item of payload?.output ?? []) {
    for (const block of item?.content ?? []) {
      for (const ann of block?.annotations ?? []) {
        if (ann?.type === 'url_citation' && ann.url) urls.push(ann.url)
      }
    }
  }
  return urls
}

/**
 * @param {{ WebError: typeof Error, resolveOptions: () => object }} args
 */
export function createGrokSearchProvider({ WebError, resolveOptions }) {
  const searchAborted = (signal, fallback) =>
    new WebError('Grok search aborted', 'WEB_ABORTED', {
      cause: signal?.aborted === true ? signal.reason : fallback,
    })

  const throwIfAborted = (signal) => {
    if (signal?.aborted === true) throw searchAborted(signal)
  }

  async function resolveModel(options) {
    if (options.model) return options.model
    try {
      const models = await options.listModels?.()
      const ids = (models ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter(Boolean)
      const preferred = ids.find((id) => /^grok-4/i.test(id))
        ?? ids.find((id) => /^grok-3/i.test(id))
        ?? ids.find((id) => /^grok/i.test(id))
      if (preferred) return preferred
    } catch {
      // Fall through to default.
    }
    return GROK_SEARCH_DEFAULT_MODEL
  }

  async function postJson(url, apiKey, body, signal) {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    return { response, text, parsed }
  }

  function errorMessage(parsed, status, text) {
    const detail = typeof parsed?.error === 'string'
      ? parsed.error
      : parsed?.error?.message ?? parsed?.detail ?? parsed?.message
    if (detail) return String(detail)
    if (text?.trim()) return text.trim().slice(0, 240)
    return `Grok/CPA API error (HTTP ${status})`
  }

  return {
    id: GROK_SEARCH_PROVIDER_ID,
    available() {
      const options = resolveOptions()
      return options.hasCredential?.() === true
        && typeof options.getBaseUrl === 'function'
        && typeof options.resolveApiKey === 'function'
        && Boolean(options.getBaseUrl?.())
    },
    async search(request, signal) {
      const options = resolveOptions()
      throwIfAborted(signal)
      if (!options.hasCredential?.()) {
        throw new WebError(
          'Grok search unavailable; log in to Grok Build in 设置 → 订阅',
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      const base = String(options.getBaseUrl?.() || '').replace(/\/$/, '')
      if (!base) {
        throw new WebError('CLIProxyAPI base URL is not ready', 'WEB_PROVIDER_ERROR')
      }
      let apiKey
      try {
        apiKey = await options.resolveApiKey?.()
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(
          `Grok search credential resolution failed: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
      if (!apiKey) {
        throw new WebError('CLIProxyAPI API key missing', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      }
      throwIfAborted(signal)
      const model = await resolveModel(options)
      const prompt = searchUserPrompt(request.query)

      // Prefer Responses + built-in web_search (current xAI path).
      try {
        const { response, text, parsed } = await postJson(
          `${base}/v1/responses`,
          apiKey,
          {
            model,
            input: [{ role: 'user', content: prompt }],
            tools: [{ type: 'web_search' }],
          },
          signal,
        )
        if (response.ok && parsed) {
          const content = extractResponsesText(parsed)
          const citations = extractResponsesCitations(parsed)
          if ((citations?.length ?? 0) > 0 || content) {
            return sourcesFromCitations(citations, content)
          }
        }
        // Non-OK or empty: try chat completions fallback below unless aborted.
        if (!response.ok && response.status !== 404 && response.status !== 405) {
          // Keep the message for fallback context; still attempt search_parameters.
          options.logger?.warn?.(
            `grok responses search HTTP ${response.status}: ${errorMessage(parsed, response.status, text)}`,
          )
        }
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        options.logger?.warn?.(`grok responses search failed: ${error instanceof Error ? error.message : error}`)
      }

      throwIfAborted(signal)
      const { response, text, parsed } = await postJson(
        `${base}/v1/chat/completions`,
        apiKey,
        {
          model,
          messages: [
            { role: 'system', content: 'You are a web research assistant. Always search before answering.' },
            { role: 'user', content: prompt },
          ],
          search_parameters: { mode: 'on', return_citations: true },
        },
        signal,
      ).catch((error) => {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(`Grok search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      })

      if (!response.ok) {
        throw new WebError(errorMessage(parsed, response.status, text), 'WEB_PROVIDER_ERROR')
      }
      const content = typeof parsed?.choices?.[0]?.message?.content === 'string'
        ? parsed.choices[0].message.content.trim()
        : undefined
      const citations = parsed?.citations
        ?? parsed?.choices?.[0]?.message?.citations
        ?? parsed?.choices?.[0]?.citations
      return sourcesFromCitations(citations, content)
    },
  }
}
