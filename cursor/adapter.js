import { contentHasImage } from './prompt.js'
import { contextForEffort, listCatalogModels, loadCatalog, resolveCatalogModel, toCursorSelection } from './catalog.js'
import { dropSession, getSession, sessionKey } from './session.js'

export function createCursorAdapterClass({ LlmAdapter, LlmError, CallId, ReasoningEffortId }) {
  return class CursorAdapter extends LlmAdapter {
    constructor(hooks) {
      super()
      this.hooks = hooks
    }

    providerInfo(provider) {
      return { id: provider, name: 'Cursor' }
    }

    providerRetryPolicy() {
      return this.hooks.options().retryPolicy
    }

    async listModels(provider) {
      const connection = this.hooks.options()
      const apiKey = await this.hooks.resolveApiKey(connection).catch(() => undefined)
      const catalog = await loadCatalog(apiKey)
      return listCatalogModels(provider, catalog, connection.models)
    }

    async resolveModel(provider, model) {
      const connection = this.hooks.options()
      const apiKey = await this.hooks.resolveApiKey(connection).catch(() => undefined)
      const catalog = await loadCatalog(apiKey)
      return resolveCatalogModel(provider, model, catalog, ReasoningEffortId)
    }

    async * stream(options) {
      let readImage
      if ((options.messages ?? []).some((message) => contentHasImage(message.content))) {
        const attachments = this.hooks.resolveAttachments?.()
        if (!attachments) {
          throw new LlmError(
            'Cursor image input requires the DSH attachment service, which is unavailable.',
            'UNSUPPORTED_CONTENT',
          )
        }
        readImage = async (ref) => {
          const stored = await attachments.readImage(ref, options.signal)
          return {
            data: Buffer.from(stored.data).toString('base64'),
            mimeType: stored.ref.mediaType,
            ...stored.ref.width && stored.ref.height
              ? { dimension: { width: stored.ref.width, height: stored.ref.height } }
              : {},
          }
        }
      }

      const connection = this.hooks.options()
      const apiKey = await this.hooks.resolveApiKey(connection)
      const catalog = await loadCatalog(apiKey)
      const resolved = resolveCatalogModel(options.provider, options.model, catalog, ReasoningEffortId)
      const modelSelection = toCursorSelection(options.model, options.reasoningEffort, resolved)
      const key = sessionKey(options)
      const oneshot = options.purpose === 'compaction' || options.purpose === 'session-title'
      const session = getSession(key, {
        apiKey,
        model: options.model,
        modelSelection,
        contextWindow: contextForEffort(resolved, options.reasoningEffort),
        LlmError,
      })

      let nextIndex = 0
      let textBlock
      let reasoningBlock
      const toolBlocks = []
      let finished = false

      const open = (kind) => {
        const block = { index: nextIndex, kind, text: '', id: '', name: '' }
        nextIndex += 1
        return block
      }

      const closeOpenBlocks = function* () {
        if (reasoningBlock) {
          yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
        }
        if (textBlock) {
          yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
        }
        for (const block of toolBlocks) {
          yield {
            type: 'block-end',
            index: block.index,
            block: {
              type: 'tool-call',
              id: CallId(block.id),
              name: block.name,
              arguments: block.text,
            },
          }
        }
      }

      const finish = function* (reason) {
        if (finished) return
        finished = true
        yield* closeOpenBlocks()
        yield { type: 'finish', reason }
      }

      try {
        await session.beginTurn({
          system: options.system,
          messages: options.messages ?? [],
          tools: options.tools,
          signal: options.signal,
          oneshot,
          readImage,
        })

        for await (const event of session.pull(options.signal)) {
          if (event.type === 'reasoning') {
            if (!reasoningBlock) {
              reasoningBlock = open('reasoning')
              yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
            }
            reasoningBlock.text += event.text
            yield { type: 'reasoning-delta', index: reasoningBlock.index, text: event.text }
            continue
          }
          if (event.type === 'text') {
            if (!textBlock) {
              textBlock = open('text')
              yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
            }
            textBlock.text += event.text
            yield { type: 'text-delta', index: textBlock.index, text: event.text }
            continue
          }
          if (event.type === 'tool-calls') {
            for (const call of event.calls) {
              const block = open('tool-call')
              block.id = call.id
              block.name = call.name
              block.text = call.arguments
              toolBlocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: CallId(call.id),
                name: call.name,
                argumentsDelta: call.arguments,
              }
            }
            yield* finish({ kind: 'tool-calls' })
            return
          }
          if (event.type === 'done') {
            if (oneshot) await dropSession(key)
            if (!textBlock && !reasoningBlock && toolBlocks.length === 0) {
              const detail = [
                session.lastError,
                session.seenTypes?.length ? `events=${session.seenTypes.join(',')}` : 'no stream events',
                `model=${modelSelection.id}`,
                modelSelection.params?.length
                  ? `params=${modelSelection.params.map((param) => `${param.id}=${param.value}`).join('|')}`
                  : 'params=default',
              ].filter(Boolean).join('; ')
              yield* finish({
                kind: 'error',
                failure: {
                  message: session.lastError
                    ? `Cursor run failed: ${detail}`
                    : `Cursor returned a completed response with no content (${detail})`,
                  code: session.lastError ? 'TRANSPORT' : 'EMPTY_RESPONSE',
                },
              })
              return
            }
            yield* finish({ kind: 'stop' })
            return
          }
        }

        if (!finished) yield* finish({ kind: 'stop' })
      } catch (error) {
        if (oneshot) await dropSession(key)
        if (options.signal?.aborted) {
          throw new LlmError('Cursor request aborted by caller', 'ABORTED', { cause: error })
        }
        if (error instanceof LlmError) throw error
        const message = error instanceof Error ? error.message : String(error)
        const code = /401|403|auth|api key/i.test(message) ? 'AUTH' : 'TRANSPORT'
        throw new LlmError(`Cursor SDK stream failed: ${message}`, code, { cause: error })
      }
    }
  }
}
