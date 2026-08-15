/**
 * Direct Factory Droid LlmAdapter — no CLIProxyAPI hop.
 *
 * Routes by model family:
 *   anthropic → POST /api/llm/a/v1/messages   (Anthropic SSE)
 *   openai    → POST /api/llm/o/v1/responses  (Responses SSE)
 *   common    → POST /api/llm/o/v1/chat/completions
 */

import { sanitizeToolName } from '../cursor/prompt.js'
import { proxyEffortValue } from './catalog.js'
import {
  DROID_SYSTEM_PREFIX,
  FACTORY_API,
  factoryModelKind,
  factoryUpstreamModelId,
} from './factory.js'

function isDshWebSearchTool(name) {
  const value = String(name ?? '')
  return value === 'web_search' || value === 'webSearch'
}

function withoutDshWebSearch(tools) {
  return (tools ?? []).filter((tool) => !isDshWebSearchTool(tool.name))
}

function dataUrl(image) {
  return `data:${image.mimeType || 'image/png'};base64,${image.data}`
}

function textOfBlocks(blocks) {
  return (blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

async function imagePartsOf(blocks, readImage) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block.type !== 'image' || !block.attachment || !readImage) continue
    const image = await readImage(block.attachment)
    parts.push({ type: 'image_url', image_url: { url: dataUrl(image) } })
  }
  return parts
}

async function toOpenAiMessages({ system, messages, readImage, toolNameOf }) {
  const output = []
  if (system) output.push({ role: 'system', content: system })

  for (const message of messages ?? []) {
    const blocks = message.content ?? []

    if (message.role === 'assistant') {
      const text = textOfBlocks(blocks)
      const toolCalls = blocks
        .filter((block) => block.type === 'tool-call')
        .map((block) => ({
          id: String(block.id),
          type: 'function',
          function: {
            name: toolNameOf(block.name),
            arguments: typeof block.arguments === 'string'
              ? block.arguments
              : JSON.stringify(block.arguments ?? {}),
          },
        }))
      const entry = { role: 'assistant' }
      if (text) entry.content = text
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      if (text || toolCalls.length > 0) output.push(entry)
      continue
    }

    const pendingImages = []
    for (const block of blocks) {
      if (block.type !== 'tool-result') continue
      const body = textOfBlocks(block.content)
        || (block.isError ? 'Tool failed.' : '(no output)')
      output.push({
        role: 'tool',
        tool_call_id: String(block.toolCallId ?? block.id ?? ''),
        content: block.isError ? `ERROR: ${body}` : body,
      })
      const images = await imagePartsOf(block.content, readImage)
      if (images.length > 0) {
        pendingImages.push({
          note: `Image output of tool call ${String(block.toolCallId ?? '')}:`,
          images,
        })
      }
    }

    const text = textOfBlocks(blocks)
    const images = await imagePartsOf(blocks, readImage)
    const parts = []
    if (text) parts.push({ type: 'text', text })
    parts.push(...images)
    for (const bundle of pendingImages) {
      parts.push({ type: 'text', text: bundle.note }, ...bundle.images)
    }
    if (parts.length === 1 && parts[0].type === 'text') {
      output.push({ role: message.role === 'system' ? 'system' : 'user', content: parts[0].text })
    } else if (parts.length > 0) {
      output.push({ role: 'user', content: parts })
    }
  }
  return output
}

function toOpenAiTools(tools, aliases) {
  if (!tools?.length) return undefined
  return tools.map((tool) => {
    const wireName = sanitizeToolName(tool.name)
    aliases.set(wireName, tool.name)
    return {
      type: 'function',
      function: {
        name: wireName,
        description: tool.description || tool.name,
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', additionalProperties: true },
      },
    }
  })
}

function textContentOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
        return part.text ?? ''
      }
      return ''
    })
    .join('')
}

function toResponsesInput(messages) {
  const input = []
  for (const message of messages ?? []) {
    if (!message || message.role === 'system') continue
    const text = textContentOf(message.content)
    if (message.role === 'assistant') {
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      continue
    }
    if (message.role === 'user' && text) {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      })
    }
  }
  return input
}

async function* sseEvents(body, signal) {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield data
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // done
    }
  }
}

/** Anthropic-event SSE: event lines + data lines. */
async function* anthropicSseEvents(body, signal) {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let eventType
        const dataLines = []
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        const data = dataLines.join('\n')
        if (!data) continue
        try {
          const parsed = JSON.parse(data)
          if (eventType && !parsed.type) parsed.type = eventType
          yield parsed
        } catch {
          // skip
        }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // done
    }
  }
}

async function anthropicMessages({ system, messages, readImage, toolNameOf, aliases }) {
  const out = []
  for (const message of messages ?? []) {
    const blocks = message.content ?? []
    if (message.role === 'assistant') {
      const content = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool-call') {
          const wireName = toolNameOf(block.name)
          aliases.set(wireName, block.name)
          let input = block.arguments
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input || '{}')
            } catch {
              input = {}
            }
          }
          content.push({
            type: 'tool_use',
            id: String(block.id),
            name: wireName,
            input: input && typeof input === 'object' ? input : {},
          })
        }
      }
      if (content.length > 0) out.push({ role: 'assistant', content })
      continue
    }

    const content = []
    for (const block of blocks) {
      if (block.type === 'tool-result') {
        const body = textOfBlocks(block.content)
          || (block.isError ? 'Tool failed.' : '(no output)')
        content.push({
          type: 'tool_result',
          tool_use_id: String(block.toolCallId ?? block.id ?? ''),
          content: block.isError ? `ERROR: ${body}` : body,
          ...(block.isError ? { is_error: true } : {}),
        })
      } else if (block.type === 'text' && block.text) {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'image' && block.attachment && readImage) {
        const image = await readImage(block.attachment)
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mimeType || 'image/png',
            data: image.data,
          },
        })
      }
    }
    if (content.length > 0) {
      out.push({ role: message.role === 'system' ? 'user' : 'user', content })
    }
  }

  // Anthropic requires alternating user/assistant; merge consecutive same-role.
  const merged = []
  for (const msg of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role && Array.isArray(last.content) && Array.isArray(msg.content)) {
      last.content.push(...msg.content)
    } else {
      merged.push(msg)
    }
  }

  return {
    system: DROID_SYSTEM_PREFIX + (system ?? ''),
    messages: merged,
  }
}

function toAnthropicTools(tools, aliases) {
  if (!tools?.length) return undefined
  return tools.map((tool) => {
    const wireName = sanitizeToolName(tool.name)
    aliases.set(wireName, tool.name)
    return {
      name: wireName,
      description: tool.description || tool.name,
      input_schema: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', additionalProperties: true },
    }
  })
}

export function createFactoryAdapterClass({ LlmAdapter, LlmError, CallId, ReasoningEffortId }) {
  return class FactoryAdapter extends LlmAdapter {
    constructor(hooks) {
      super()
      // hooks: { catalog, resolveAccount, requestHeaders, retryPolicy, resolveAttachments, describeLoginHint }
      this.hooks = hooks
    }

    providerInfo() {
      return { id: 'factory', name: 'Factory Droid' }
    }

    providerRetryPolicy() {
      return this.hooks.retryPolicy?.()
    }

    async listModels(provider) {
      return await this.hooks.catalog.listModels(provider)
    }

    async resolveModel(provider, model) {
      return await this.hooks.catalog.resolveModel(provider, model, ReasoningEffortId)
    }

    async * stream(options) {
      const tried = []
      let lastAuth
      while (true) {
        const account = await this.hooks.resolveAccount({ exclude: tried })
        if (!account) {
          throw lastAuth ?? new LlmError(
            `未登录 Factory Droid${this.hooks.describeLoginHint?.() ?? '。打开 设置 → 订阅 添加 API Key 或导入 droid CLI'}`,
            'AUTH',
          )
        }
        tried.push(account.slug, account.email)
        try {
          const kind = factoryModelKind(options.model)
          if (kind === 'openai' || kind === 'xai') {
            yield* this.streamResponses(options, account, kind === 'xai' ? 'xai' : 'openai')
            return
          }
          if (kind === 'anthropic') {
            yield* this.streamAnthropic(options, account)
            return
          }
          yield* this.streamChatCompletions(options, account)
          return
        } catch (error) {
          if (!(error instanceof LlmError) || error.code !== 'AUTH') throw error
          lastAuth = error
          await this.hooks.markAuthFailed?.(account, error.message)
        }
      }
    }

    makeImageReader(options) {
      const attachments = this.hooks.resolveAttachments?.()
      if (!attachments) return undefined
      return async (ref) => {
        const stored = await attachments.readImage(ref, options.signal)
        return {
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.mimeType,
        }
      }
    }

    async * streamChatCompletions(options, account) {
      const readImage = this.makeImageReader(options)
      const aliases = new Map()
      const toolNameOf = (name) => sanitizeToolName(name)
      const messages = await toOpenAiMessages({
        system: DROID_SYSTEM_PREFIX + (options.system ?? ''),
        messages: options.messages ?? [],
        readImage,
        toolNameOf,
      })
      const tools = toOpenAiTools(options.tools, aliases)
      const body = {
        model: factoryUpstreamModelId(options.model),
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }
      if (tools) body.tools = tools
      if (options.maxTokens) body.max_tokens = options.maxTokens
      if (options.reasoningEffort) {
        const effort = proxyEffortValue(options.reasoningEffort)
        if (effort && effort !== 'default') body.reasoning_effort = effort
      }

      const response = await this.fetchFactory(
        `${FACTORY_API}/o/v1/chat/completions`,
        this.hooks.requestHeaders(account, 'fireworks'),
        body,
        options.signal,
      )
      yield* this.consumeChatCompletionsStream(response, options, aliases)
    }

    async * streamResponses(options, account, apiProvider = 'openai') {
      const readImage = this.makeImageReader(options)
      const messages = await toOpenAiMessages({
        system: undefined,
        messages: options.messages ?? [],
        readImage,
        toolNameOf: (name) => sanitizeToolName(name),
      })
      // Responses streaming does not yet round-trip DSH function tools.
      // Factory Grok can still search in-request via the native server tool.
      const tools = apiProvider === 'xai' ? [{ type: 'web_search' }] : undefined
      const body = {
        model: factoryUpstreamModelId(options.model),
        instructions: DROID_SYSTEM_PREFIX + (options.system ?? ''),
        input: toResponsesInput(messages),
        stream: true,
        store: false,
      }
      if (tools) body.tools = tools
      if (options.maxTokens) body.max_output_tokens = Math.max(16, options.maxTokens)
      if (options.reasoningEffort) {
        const effort = proxyEffortValue(options.reasoningEffort)
        if (effort && effort !== 'default') body.reasoning = { effort }
      }

      const response = await this.fetchFactory(
        `${FACTORY_API}/o/v1/responses`,
        this.hooks.requestHeaders(account, apiProvider),
        body,
        options.signal,
      )
      if (!response.ok) {
        throw await this.httpError(response, 'Factory Responses')
      }

      let nextIndex = 0
      let textBlock
      let sawContent = false
      const open = () => nextIndex++

      try {
        for await (const data of sseEvents(response.body, options.signal)) {
          let event
          try {
            event = JSON.parse(data)
          } catch {
            continue
          }
          const type = event?.type
          if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
            if (!textBlock) {
              textBlock = { index: open(), text: '' }
              yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
            }
            textBlock.text += event.delta
            sawContent = true
            yield { type: 'text-delta', index: textBlock.index, text: event.delta }
          }
          if (type === 'response.failed' || event?.response?.error) {
            const message = event?.response?.error?.message ?? event?.error?.message ?? JSON.stringify(event)
            throw new LlmError(`Factory Responses error: ${message}`, 'TRANSPORT')
          }
        }
        if (textBlock) {
          yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
        }
        if (!sawContent) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: `Factory Responses returned an empty completion (model=${options.model})`,
                code: 'EMPTY_RESPONSE',
              },
            },
          }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError('Factory request aborted', 'ABORTED', { cause: error })
        }
        if (error instanceof LlmError) throw error
        throw new LlmError(
          `Factory Responses stream failed: ${error instanceof Error ? error.message : error}`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    async * streamAnthropic(options, account) {
      const readImage = this.makeImageReader(options)
      const aliases = new Map()
      const toolNameOf = (name) => sanitizeToolName(name)
      const { system, messages } = await anthropicMessages({
        system: options.system,
        messages: options.messages ?? [],
        readImage,
        toolNameOf,
        aliases,
      })
      const clientTools = toAnthropicTools(withoutDshWebSearch(options.tools), aliases) ?? []
      const tools = [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        ...clientTools,
      ]
      const body = {
        model: factoryUpstreamModelId(options.model),
        max_tokens: Math.max(16, options.maxTokens || 32_768),
        system,
        messages,
        stream: true,
        tools,
      }
      if (options.reasoningEffort) {
        const effort = proxyEffortValue(options.reasoningEffort)
        if (effort === 'off') {
          // Explicitly disable extended thinking when the model supports Off.
        } else if (effort && effort !== 'default') {
          const budget = ({
            low: 2_000,
            medium: 8_000,
            high: 16_000,
            xhigh: 32_000,
            max: 64_000,
          })[effort] ?? 8_000
          body.thinking = { type: 'enabled', budget_tokens: budget }
        }
      }

      const headers = {
        ...this.hooks.requestHeaders(account, 'anthropic'),
        'anthropic-version': '2023-06-01',
      }
      const response = await this.fetchFactory(
        `${FACTORY_API}/a/v1/messages`,
        headers,
        body,
        options.signal,
      )
      if (!response.ok) {
        throw await this.httpError(response, 'Factory Messages')
      }

      let nextIndex = 0
      let textBlock
      let thinkingBlock
      const toolBlocks = new Map()
      let stopReason
      let sawContent = false
      const open = () => nextIndex++

      try {
        for await (const event of anthropicSseEvents(response.body, options.signal)) {
          const type = event?.type
          if (type === 'content_block_start') {
            const block = event.content_block
            const index = event.index ?? open()
            if (block?.type === 'text') {
              textBlock = { index, text: '' }
              yield { type: 'block-start', index, blockType: 'text' }
            } else if (block?.type === 'thinking') {
              thinkingBlock = { index, text: '' }
              yield { type: 'block-start', index, blockType: 'reasoning' }
            } else if (block?.type === 'tool_use' && !isDshWebSearchTool(block.name)) {
              toolBlocks.set(index, {
                index,
                id: String(block.id ?? `toolu_${crypto.randomUUID()}`),
                name: block.name ?? '',
                arguments: '',
              })
              yield { type: 'block-start', index, blockType: 'tool-call' }
            }
            // Native Anthropic web_search is a server tool: Factory runs it
            // in-request. Do not surface it as a DSH tool-call.
          } else if (type === 'content_block_delta') {
            const delta = event.delta
            const index = event.index
            if (delta?.type === 'text_delta' && delta.text) {
              if (!textBlock) {
                textBlock = { index: index ?? open(), text: '' }
                yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
              }
              textBlock.text += delta.text
              sawContent = true
              yield { type: 'text-delta', index: textBlock.index, text: delta.text }
            } else if ((delta?.type === 'thinking_delta' || delta?.type === 'reasoning_delta') && delta.thinking) {
              if (!thinkingBlock) {
                thinkingBlock = { index: index ?? open(), text: '' }
                yield { type: 'block-start', index: thinkingBlock.index, blockType: 'reasoning' }
              }
              thinkingBlock.text += delta.thinking
              sawContent = true
              yield { type: 'reasoning-delta', index: thinkingBlock.index, text: delta.thinking }
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const call = toolBlocks.get(index)
              if (call) {
                call.arguments += delta.partial_json
                sawContent = true
                yield {
                  type: 'tool-call-delta',
                  index,
                  id: CallId(call.id),
                  name: aliases.get(call.name) ?? call.name,
                  argumentsDelta: delta.partial_json,
                }
              }
            }
          } else if (type === 'content_block_stop') {
            const index = event.index
            if (textBlock && textBlock.index === index) {
              yield { type: 'block-end', index, block: { type: 'text', text: textBlock.text } }
              textBlock = undefined
            } else if (thinkingBlock && thinkingBlock.index === index) {
              yield { type: 'block-end', index, block: { type: 'reasoning', text: thinkingBlock.text } }
              thinkingBlock = undefined
            } else if (toolBlocks.has(index)) {
              const call = toolBlocks.get(index)
              const name = aliases.get(call.name) ?? call.name
              yield {
                type: 'block-end',
                index,
                block: {
                  type: 'tool-call',
                  id: CallId(call.id),
                  name,
                  arguments: call.arguments || '{}',
                },
              }
            }
          } else if (type === 'message_delta') {
            stopReason = event.delta?.stop_reason ?? stopReason
          }
        }

        if (textBlock) {
          yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
        }
        if (thinkingBlock) {
          yield { type: 'block-end', index: thinkingBlock.index, block: { type: 'reasoning', text: thinkingBlock.text } }
        }

        if (toolBlocks.size > 0) {
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (!sawContent) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: `Factory Messages returned an empty completion (model=${options.model})`,
                code: 'EMPTY_RESPONSE',
              },
            },
          }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError('Factory request aborted', 'ABORTED', { cause: error })
        }
        if (error instanceof LlmError) throw error
        throw new LlmError(
          `Factory Messages stream failed: ${error instanceof Error ? error.message : error}`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    async fetchFactory(url, headers, body, signal) {
      try {
        return await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new LlmError('Factory request aborted', 'ABORTED', { cause: error })
        throw new LlmError(
          `Factory 网关不可达: ${error instanceof Error ? error.message : error}`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    async httpError(response, label) {
      const raw = await response.text().catch(() => '')
      let detail = raw.slice(0, 400)
      try {
        const parsed = JSON.parse(raw)
        detail = parsed?.error?.message ?? parsed?.detail ?? parsed?.error ?? detail
      } catch {
        // keep
      }
      const forbidden = response.status === 403 || /forbidden/i.test(String(detail))
      return new LlmError(
        `${label} 失败 (${response.status}): ${detail}`,
        response.status === 401 ? 'AUTH' : (forbidden ? 'TRANSPORT' : 'TRANSPORT'),
      )
    }

    async * consumeChatCompletionsStream(response, options, aliases) {
      if (!response.ok) {
        throw await this.httpError(response, 'Factory Chat Completions')
      }

      let nextIndex = 0
      let textBlock
      let reasoningBlock
      const toolCalls = new Map()
      let finishReason
      let finished = false
      let sawContent = false
      const open = () => nextIndex++

      const closeOpenBlocks = function* () {
        if (reasoningBlock) {
          yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
          reasoningBlock = undefined
        }
        if (textBlock) {
          yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
          textBlock = undefined
        }
      }

      const emitToolCalls = function* () {
        const ordered = [...toolCalls.values()].sort((a, b) => a.slot - b.slot)
        for (const call of ordered) {
          const index = open()
          const name = aliases.get(call.name) ?? call.name
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index,
            id: CallId(call.id),
            name,
            argumentsDelta: call.arguments || '{}',
          }
          yield {
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: CallId(call.id), name, arguments: call.arguments || '{}' },
          }
        }
      }

      const finish = function* () {
        if (finished) return
        finished = true
        yield* closeOpenBlocks()
        if (toolCalls.size > 0) {
          yield* emitToolCalls()
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (!sawContent) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: `Factory returned an empty completion (model=${options.model})`,
                code: 'EMPTY_RESPONSE',
              },
            },
          }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }

      try {
        for await (const data of sseEvents(response.body, options.signal)) {
          if (data === '[DONE]') break
          let chunk
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }
          if (chunk?.error) {
            throw new LlmError(`Factory stream error: ${chunk.error?.message ?? JSON.stringify(chunk.error)}`, 'TRANSPORT')
          }
          const choice = chunk?.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}

          const reasoningText = delta.reasoning_content ?? delta.reasoning
          if (typeof reasoningText === 'string' && reasoningText.length > 0) {
            if (!reasoningBlock) {
              reasoningBlock = { index: open(), text: '' }
              yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
            }
            reasoningBlock.text += reasoningText
            sawContent = true
            yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoningText }
          }

          const contentText = typeof delta.content === 'string'
            ? delta.content
            : Array.isArray(delta.content)
              ? delta.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
              : ''
          if (contentText) {
            if (reasoningBlock && !textBlock) {
              yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
              reasoningBlock = undefined
            }
            if (!textBlock) {
              textBlock = { index: open(), text: '' }
              yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
            }
            textBlock.text += contentText
            sawContent = true
            yield { type: 'text-delta', index: textBlock.index, text: contentText }
          }

          for (const toolDelta of delta.tool_calls ?? []) {
            const slot = toolDelta.index ?? 0
            let call = toolCalls.get(slot)
            if (!call) {
              call = {
                slot,
                id: String(toolDelta.id ?? `call_${crypto.randomUUID()}`),
                name: toolDelta.function?.name ?? '',
                arguments: '',
              }
              toolCalls.set(slot, call)
            }
            if (toolDelta.id) call.id = String(toolDelta.id)
            if (toolDelta.function?.name) call.name = toolDelta.function.name
            if (typeof toolDelta.function?.arguments === 'string') {
              call.arguments += toolDelta.function.arguments
            }
            sawContent = true
          }

          if (choice.finish_reason) finishReason = choice.finish_reason
        }
        yield* finish()
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError('Factory request aborted', 'ABORTED', { cause: error })
        }
        if (error instanceof LlmError) throw error
        throw new LlmError(
          `Factory stream failed: ${error instanceof Error ? error.message : error}`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }
  }
}
