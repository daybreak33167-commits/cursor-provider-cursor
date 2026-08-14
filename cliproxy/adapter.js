import { sanitizeToolName } from '../cursor/prompt.js'
import { providerLabel } from './providers.js'

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

    // User-and-system-side messages: tool results become `tool` messages;
    // any remaining text/images become a `user` message.
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
    const rest = buffer.trim()
    if (rest.startsWith('data:')) {
      const data = rest.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) yield data
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Stream already finished.
    }
  }
}

export function createProxyAdapterClass({ LlmAdapter, LlmError, CallId, ReasoningEffortId }) {
  return class CliproxyAdapter extends LlmAdapter {
    constructor(hooks) {
      super()
      // hooks: { catalog, getBaseUrl, getApiKey, retryPolicy, resolveAttachments, describeLoginHint }
      this.hooks = hooks
    }

    providerInfo(provider) {
      return { id: provider, name: providerLabel(provider) }
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
      const readImage = this.makeImageReader(options)
      const aliases = new Map()
      const toolNameOf = (name) => sanitizeToolName(name)
      const messages = await toOpenAiMessages({
        system: options.system,
        messages: options.messages ?? [],
        readImage,
        toolNameOf,
      })
      const tools = toOpenAiTools(options.tools, aliases)

      const body = {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }
      if (tools) body.tools = tools
      if (options.maxTokens) body.max_tokens = options.maxTokens
      if (options.provider === 'codex' && options.reasoningEffort) {
        body.reasoning_effort = String(options.reasoningEffort)
      }

      const base = this.hooks.getBaseUrl().replace(/\/+$/, '')
      const apiKey = await this.hooks.getApiKey()

      let response
      try {
        response = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw new LlmError('CLIProxyAPI request aborted', 'ABORTED', { cause: error })
        const hint = this.hooks.describeLoginHint?.() ?? ''
        throw new LlmError(
          `CLIProxyAPI is unreachable at ${base}: ${error instanceof Error ? error.message : error}${hint}`,
          'TRANSPORT',
          { cause: error },
        )
      }

      if (!response.ok) {
        const raw = await response.text().catch(() => '')
        let detail = raw.slice(0, 400)
        try {
          const parsed = JSON.parse(raw)
          detail = parsed?.error?.message ?? parsed?.error ?? detail
        } catch {
          // keep raw slice
        }
        if (response.status === 401 || response.status === 403) {
          throw new LlmError(
            `CLIProxyAPI rejected the request (${response.status}): ${detail}. `
            + `请打开 设置 → 订阅 登录 ${providerLabel(options.provider)} 账号。`,
            'AUTH',
          )
        }
        throw new LlmError(`CLIProxyAPI request failed (${response.status}): ${detail}`, 'TRANSPORT')
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
                message: `CLIProxyAPI returned an empty completion (model=${options.model}, finish=${finishReason ?? 'none'})`,
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
            const message = chunk.error?.message ?? JSON.stringify(chunk.error)
            throw new LlmError(`CLIProxyAPI stream error: ${message}`, 'TRANSPORT')
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
          throw new LlmError('CLIProxyAPI request aborted', 'ABORTED', { cause: error })
        }
        if (error instanceof LlmError) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new LlmError(`CLIProxyAPI stream failed: ${message}`, 'TRANSPORT', { cause: error })
      }
    }

    makeImageReader(options) {
      const attachments = this.hooks.resolveAttachments?.()
      if (!attachments) return undefined
      return async (ref) => {
        const stored = await attachments.readImage(ref, options.signal)
        return {
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        }
      }
    }
  }
}
