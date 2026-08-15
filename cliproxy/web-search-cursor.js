/**
 * Cursor-backed WebSearchProvider for DSH `ctx.web`.
 *
 * Cursor does not expose a standalone search HTTP API. A short-lived local
 * agent with only `webSearch` (+ `webFetch`) runs the query and we map the
 * answer + cited URLs into the DSH search result shape.
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@cursor/sdk'

export const CURSOR_SEARCH_PROVIDER_ID = 'cursor'
export const CURSOR_SEARCH_DEFAULT_MODEL = 'composer-2.5'

const SCRATCH = join(tmpdir(), 'dsh-cpa-plus-scratch')
mkdirSync(SCRATCH, { recursive: true })

function searchPrompt(query) {
  return [
    `Perform a web search for this query and answer it with concrete facts.`,
    `Query: ${query}`,
    '',
    'Use the webSearch tool. After searching, write a concise factual answer',
    '(dates, numbers, names, status). Include the source URLs as a markdown',
    'list at the end. Do not edit files or run shell commands.',
  ].join('\n')
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function uniqueUrls(urls) {
  const seen = new Set()
  const out = []
  for (const raw of urls) {
    if (typeof raw !== 'string') continue
    const url = raw.replace(/[),.;]+$/g, '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function urlsFromText(text) {
  if (!text) return []
  const found = []
  for (const match of String(text).matchAll(/https?:\/\/[^\s)\]>'"`]+/g)) {
    found.push(match[0])
  }
  return found
}

function textFromSdkEvent(event) {
  if (!event || typeof event !== 'object') return ''
  const message = event.type === 'sdk_message' && event.message ? event.message : event
  const chunks = []
  if (typeof message.text === 'string') chunks.push(message.text)
  if (typeof message.result === 'string') chunks.push(message.result)
  const nested = message.message ?? message
  const content = nested?.content ?? message.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') chunks.push(block)
      if (block?.type === 'text' && typeof block.text === 'string') chunks.push(block.text)
    }
  }
  return chunks.join('')
}

function collectFromEvent(event, bag) {
  const message = event?.type === 'sdk_message' && event.message ? event.message : event
  if (!message) return
  const text = textFromSdkEvent(event)
  if (text) {
    bag.texts.push(text)
    bag.urls.push(...urlsFromText(text))
  }
  const args = message.args ?? message.arguments ?? message.input
  if (args && typeof args === 'object') {
    for (const value of Object.values(args)) {
      if (typeof value === 'string') bag.urls.push(...urlsFromText(value))
    }
  }
  const result = message.result ?? message.output ?? message.content
  if (typeof result === 'string') bag.urls.push(...urlsFromText(result))
}

export function createCursorSearchProvider({ WebError, resolveOptions }) {
  const searchAborted = (signal, fallback) =>
    new WebError('Cursor search aborted', 'WEB_ABORTED', {
      cause: signal?.aborted === true ? signal.reason : fallback,
    })

  return {
    id: CURSOR_SEARCH_PROVIDER_ID,
    available() {
      return resolveOptions().hasCredential?.() === true
    },
    async search(request, signal) {
      const options = resolveOptions()
      if (signal?.aborted) throw searchAborted(signal)
      if (!options.hasCredential?.()) {
        throw new WebError(
          'Cursor search unavailable; log in to Cursor in 设置 → 订阅',
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      let apiKey
      try {
        apiKey = await options.resolveApiKey?.()
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(
          `Cursor search credential resolution failed: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
      if (!apiKey) {
        throw new WebError(
          'Cursor search has no API key; log in to Cursor in 设置 → 订阅',
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }

      const model = options.model || CURSOR_SEARCH_DEFAULT_MODEL
      const createOptions = {
        model: { id: model },
        apiKey,
        tools: ['webSearch', 'webFetch'],
        local: {
          cwd: SCRATCH,
          settingSources: [],
        },
      }

      let agent
      try {
        agent = await Agent.create(createOptions)
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(
          `Cursor search agent failed to start: ${error instanceof Error ? error.message : error}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }

      const bag = { texts: [], urls: [] }
      try {
        const run = await agent.send(searchPrompt(request.query))
        const abort = () => {
          if (run?.supports?.('cancel')) void run.cancel()
        }
        if (signal) {
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }
        if (typeof run.stream === 'function') {
          for await (const event of run.stream()) {
            if (signal?.aborted) throw searchAborted(signal)
            collectFromEvent(event, bag)
          }
        }
        const waited = await run.wait()
        if (signal?.aborted) throw searchAborted(signal)
        if (typeof waited?.result === 'string' && waited.result.trim()) {
          bag.texts.push(waited.result.trim())
          bag.urls.push(...urlsFromText(waited.result))
        }
        if (waited?.status === 'error') {
          throw new WebError(
            waited.error?.message || waited.error?.code || 'Cursor search run failed',
            'WEB_PROVIDER_ERROR',
          )
        }
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        if (error && typeof error === 'object' && error.name === 'WebError') throw error
        throw new WebError(
          `Cursor search failed: ${error instanceof Error ? error.message : error}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      } finally {
        if (agent?.[Symbol.asyncDispose]) {
          try {
            await agent[Symbol.asyncDispose]()
          } catch {
            // Best-effort teardown.
          }
        }
      }

      const content = bag.texts.join('\n\n').trim() || undefined
      const sources = uniqueUrls(bag.urls).map((url) => ({ url }))
      if (!content && sources.length === 0) {
        throw new WebError(
          'Cursor search returned no answer or sources',
          'WEB_PROVIDER_ERROR',
        )
      }
      return {
        ...(content ? { content } : {}),
        sources,
        truncated: false,
      }
    },
  }
}
