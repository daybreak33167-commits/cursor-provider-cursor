import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@cursor/sdk'
import { buildFollowUpPrompt, buildKickoffPrompt, imageRefsOf, imageRefsOfBlocks, sanitizeToolName } from './prompt.js'

const SCRATCH = join(tmpdir(), 'dsh-llm-cursor-scratch')
mkdirSync(SCRATCH, { recursive: true })

const TOOL_BATCH_IDLE_MS = 40
const STREAM_CHUNK_CHARS = 16
const STREAM_CHUNK_GAP_MS = 12

function unreadSuffix(already, next) {
  if (!next) return ''
  if (!already) return next
  if (next.startsWith(already)) return next.slice(already.length)
  if (already.includes(next)) return ''
  return next
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function unwrapSdkMessage(event) {
  if (!event || typeof event !== 'object') return undefined
  if (event.type === 'sdk_message' && event.message) return unwrapSdkMessage(event.message)
  return event
}

function textFromSdkEvent(event) {
  const message = unwrapSdkMessage(event)
  if (!message) return ''
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

function isThinkingEvent(event) {
  const message = unwrapSdkMessage(event)
  return message?.type === 'thinking' || message?.type === 'reasoning' || event?.type === 'thinking' || event?.type === 'reasoning'
}

function toolCallsFromEvent(event) {
  const message = unwrapSdkMessage(event)
  if (!message) return []
  const calls = []
  if (message.type === 'tool_call' && message.status !== 'completed' && message.status !== 'error' && message.name) {
    calls.push({
      id: String(message.call_id ?? message.id ?? `call_${crypto.randomUUID()}`),
      name: message.name,
      arguments: typeof message.args === 'string' ? message.args : JSON.stringify(message.args ?? {}),
    })
  }
  const content = message.message?.content ?? message.content
  if (!Array.isArray(content)) return calls
  for (const block of content) {
    if (block?.type !== 'tool_use' && block?.type !== 'tool-call') continue
    calls.push({
      id: String(block.id ?? `call_${crypto.randomUUID()}`),
      name: block.name,
      arguments: typeof block.input === 'string'
        ? block.input
        : typeof block.arguments === 'string'
          ? block.arguments
          : JSON.stringify(block.input ?? block.arguments ?? {}),
    })
  }
  return calls
}

function statusError(event) {
  const message = unwrapSdkMessage(event)
  if (message?.type === 'status' && (message.status === 'ERROR' || message.status === 'CANCELLED')) {
    return message.message || `Cursor run ${String(message.status).toLowerCase()}`
  }
  if (event?.type === 'result' && event.status === 'error') {
    return event.errorCode || 'Cursor run failed'
  }
  return undefined
}

export class CursorSession {
  constructor(options) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.modelSelection = options.modelSelection ?? { id: options.model }
    this.LlmError = options.LlmError
    this.agent = undefined
    this.run = undefined
    this.iterator = undefined
    this.consumedCount = 0
    this.pending = new Map()
    this.toolQueue = []
    this.notify = undefined
    this.inFlight = undefined
    this.closed = false
    this.deltaQueue = []
    this.waitPromise = undefined
    this.seenTypes = []
    this.lastError = undefined
    this.emitted = false
    this.streamedText = ''
    this.streamedReasoning = ''
  }

  wake() {
    const notify = this.notify
    this.notify = undefined
    notify?.()
  }

  waitForSignal(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      this.notify = resolve
      const onAbort = () => {
        this.notify = undefined
        reject(signal.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  customTools(tools) {
    const table = {}
    const aliases = new Map()
    for (const tool of tools ?? []) {
      const name = sanitizeToolName(tool.name)
      aliases.set(name, tool.name)
      table[name] = {
        description: tool.description || tool.name,
        inputSchema: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', additionalProperties: true },
        execute: async (args, context) => {
          const id = String(context?.toolCallId ?? `call_${crypto.randomUUID()}`)
          const payload = {
            id,
            name: aliases.get(name) ?? tool.name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          }
          return await new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, name: payload.name })
            if (!this.toolQueue.some((item) => item.id === id)) this.toolQueue.push(payload)
            this.wake()
          })
        },
      }
    }
    return table
  }

  async ensureAgent(tools) {
    if (this.agent) return this.agent
    const createOptions = {
      model: this.modelSelection,
      tools: ['mcp'],
      local: {
        cwd: SCRATCH,
        settingSources: [],
        customTools: this.customTools(tools),
      },
    }
    if (this.apiKey) createOptions.apiKey = this.apiKey
    try {
      this.agent = await Agent.create(createOptions)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/tool|disallowed|unknown/i.test(message)) throw error
      createOptions.tools = undefined
      createOptions.disallowedTools = [
        'shell', 'task', 'read', 'edit', 'write', 'delete',
        'webSearch', 'webFetch', 'grep', 'glob',
      ]
      this.agent = await Agent.create(createOptions)
    }
    return this.agent
  }

  enqueueDelta(update) {
    const payload = update?.update ?? update
    if (!payload || typeof payload !== 'object') return
    const nested = payload.taskUpdate && typeof payload.taskUpdate === 'object' ? payload.taskUpdate : payload
    if ((nested.type === 'text-delta' || nested.type === 'text') && nested.text) {
      this.deltaQueue.push({ type: 'text', text: nested.text, live: true })
      this.wake()
    }
    if ((nested.type === 'thinking-delta' || nested.type === 'thinking') && nested.text) {
      this.deltaQueue.push({ type: 'reasoning', text: nested.text, live: true })
      this.wake()
    }
  }

  async * emitText(kind, text, signal, live) {
    const extra = unreadSuffix(kind === 'text' ? this.streamedText : this.streamedReasoning, text)
    if (!extra) return
    if (kind === 'text') this.streamedText += extra
    else this.streamedReasoning += extra
    this.emitted = true
    if (live || extra.length <= STREAM_CHUNK_CHARS) {
      yield { type: kind, text: extra }
      return
    }
    for (let index = 0; index < extra.length; index += STREAM_CHUNK_CHARS) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      yield { type: kind, text: extra.slice(index, index + STREAM_CHUNK_CHARS) }
      if (index + STREAM_CHUNK_CHARS < extra.length) {
        try {
          await delay(STREAM_CHUNK_GAP_MS, signal)
        } catch {
          return
        }
      }
    }
  }

  async startRun(prompt, tools, signal, images) {
    const agent = await this.ensureAgent(tools)
    this.deltaQueue = []
    this.seenTypes = []
    this.lastError = undefined
    this.emitted = false
    this.streamedText = ''
    this.streamedReasoning = ''
    this.run = await agent.send(images?.length ? { text: prompt, images } : prompt, {
      model: this.modelSelection,
      onDelta: (args) => this.enqueueDelta(args),
      local: {
        cwd: SCRATCH,
        settingSources: [],
        customTools: this.customTools(tools),
      },
    })
    this.iterator = typeof this.run.stream === 'function'
      ? this.run.stream()[Symbol.asyncIterator]()
      : undefined
    this.waitPromise = this.run.wait().catch((error) => ({ __waitError: error }))
    if (signal) {
      const abort = () => {
        if (this.run?.supports?.('cancel')) void this.run.cancel()
        this.wake()
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
  }

  async resolveToolResults(results, readImage) {
    for (const result of results) {
      const parked = this.pending.get(String(result.toolCallId))
      if (!parked) continue
      const text = (result.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('') || (result.isError ? 'Tool failed.' : '(no output)')
      const refs = readImage ? imageRefsOfBlocks(result.content) : []
      if (refs.length > 0) {
        const images = await Promise.all(refs.map((ref) => readImage(ref)))
        const content = [{ type: 'text', text }]
        for (const image of images) {
          content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
        }
        parked.resolve({ content, ...result.isError ? { isError: true } : {} })
      } else if (result.isError) {
        parked.resolve({ content: [{ type: 'text', text }], isError: true })
      } else {
        parked.resolve(text)
      }
      this.pending.delete(String(result.toolCallId))
    }
  }

  async nextSdkEvent(signal) {
    if (!this.iterator) return { done: true }
    this.inFlight ??= this.iterator.next().finally(() => {
      this.inFlight = undefined
    })
    const raced = await Promise.race([
      this.inFlight,
      this.waitForSignal(signal).then(() => ({ __woke: true })),
    ])
    if (raced?.__woke) return { woke: true }
    return raced
  }

  async finishRun() {
    const waited = this.waitPromise ? await this.waitPromise : undefined
    this.waitPromise = undefined
    this.iterator = undefined
    if (waited?.__waitError) {
      this.lastError = waited.__waitError instanceof Error
        ? waited.__waitError.message
        : String(waited.__waitError)
    } else if (waited?.status === 'error' || waited?.error) {
      this.lastError = waited.error?.message || waited.error?.code || 'Cursor run failed'
    } else if (waited?.status === 'cancelled') {
      this.lastError = 'Cursor run cancelled'
    } else if (typeof waited?.result === 'string' && waited.result.trim()) {
      const extra = unreadSuffix(this.streamedText, waited.result)
      if (extra) {
        this.run = undefined
        return { type: 'text', text: extra, live: false }
      }
    }
    this.run = undefined
    return { type: 'done' }
  }

  async * pull(signal) {
    while (!this.closed) {
      if (this.toolQueue.length > 0) {
        try {
          await delay(TOOL_BATCH_IDLE_MS, signal)
        } catch {
          return
        }
        const batch = this.toolQueue.splice(0, this.toolQueue.length)
        this.emitted = true
        yield { type: 'tool-calls', calls: batch }
        return
      }

      if (this.deltaQueue.length > 0) {
        const item = this.deltaQueue.shift()
        yield* this.emitText(item.type, item.text, signal, true)
        continue
      }

      if (!this.iterator) {
        if (this.waitPromise) {
          const leftover = await this.finishRun()
          if (leftover.type === 'text') yield* this.emitText('text', leftover.text, signal, leftover.live)
          else yield leftover
        }
        return
      }

      let step
      try {
        step = await this.nextSdkEvent(signal)
      } catch (error) {
        if (signal?.aborted) throw error
        throw error
      }

      if (step?.woke) continue
      if (step?.done) {
        if (this.deltaQueue.length > 0) continue
        const leftover = await this.finishRun()
        if (leftover.type === 'text') yield* this.emitText('text', leftover.text, signal, leftover.live)
        else yield leftover
        return
      }

      const event = step.value
      if (!event) continue
      const kind = unwrapSdkMessage(event)?.type ?? event.type
      if (kind) this.seenTypes.push(kind)
      const failed = statusError(event)
      if (failed) {
        this.lastError = failed
        continue
      }
      if (isThinkingEvent(event)) {
        yield* this.emitText('reasoning', textFromSdkEvent(event), signal, false)
        continue
      }
      const calls = toolCallsFromEvent(event)
      if (calls.length > 0) {
        for (const call of calls) {
          if (this.toolQueue.some((item) => item.id === call.id)) continue
          this.toolQueue.push(call)
        }
        continue
      }
      if (kind === 'assistant' || kind === 'message' || kind === 'task' || event.message) {
        yield* this.emitText('text', textFromSdkEvent(event), signal, false)
      }
    }
  }

  async beginTurn({ system, messages, tools, signal, oneshot, readImage }) {
    const fresh = messages.slice(this.consumedCount)
    const pendingResults = fresh
      .flatMap((message) => (message.content ?? []).filter((block) => block.type === 'tool-result'))

    if (this.iterator && pendingResults.length > 0 && this.pending.size > 0) {
      await this.resolveToolResults(pendingResults, readImage)
      this.consumedCount = messages.length
      return
    }

    const refs = readImage ? imageRefsOf(fresh) : []
    const images = refs.length > 0 ? await Promise.all(refs.map((ref) => readImage(ref))) : []

    const prompt = (oneshot || !this.agent) && this.consumedCount === 0
      ? buildKickoffPrompt(system, messages)
      : buildFollowUpPrompt(system, messages, this.consumedCount)
    await this.startRun(prompt, tools, signal, images)
    this.consumedCount = messages.length
  }

  async dispose() {
    this.closed = true
    for (const parked of this.pending.values()) {
      parked.reject(new Error('cursor session closed'))
    }
    this.pending.clear()
    this.wake()
    const agent = this.agent
    this.agent = undefined
    this.iterator = undefined
    this.run = undefined
    if (agent?.[Symbol.asyncDispose]) {
      try {
        await agent[Symbol.asyncDispose]()
      } catch {
        // Best-effort teardown.
      }
    }
  }
}

const sessions = new Map()

export function sessionKey(options) {
  if (options.purpose) return `purpose:${options.purpose}:${crypto.randomUUID()}`
  if (options.sessionId) {
    const effort = options.reasoningEffort ?? ''
    return `session:${options.sessionId}:${options.model}:${effort}`
  }
  return `ephemeral:${crypto.randomUUID()}`
}

export function getSession(key, init) {
  const existing = sessions.get(key)
  if (existing && !existing.closed) {
    existing.apiKey = init.apiKey
    existing.model = init.model
    existing.modelSelection = init.modelSelection ?? existing.modelSelection
    return existing
  }
  const created = new CursorSession(init)
  sessions.set(key, created)
  return created
}

export async function dropSession(key) {
  const existing = sessions.get(key)
  sessions.delete(key)
  if (existing) await existing.dispose()
}
