const DRIVER_PREAMBLE = [
  'You are the model backend for DeepSeek Harness (DSH).',
  'DSH owns the workspace, shell, approvals, and tool execution.',
  'Call only the tools listed in this request. Do not use Cursor IDE tools,',
  'do not read or edit files yourself, and do not spawn a nested coding agent.',
  'When you need information or a side effect, call a listed tool and wait.',
].join(' ')

export function flattenText(blocks) {
  return (blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export function contentHasImage(blocks) {
  return (blocks ?? []).some((block) => block.type === 'image')
}

export function isToolResultMessage(message) {
  const blocks = message.content ?? []
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool-result')
}

export function toolResultsOf(message) {
  return (message.content ?? []).filter((block) => block.type === 'tool-result')
}

export function assistantToolCallsOf(message) {
  return (message.content ?? []).filter((block) => block.type === 'tool-call')
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' || isToolResultMessage(message)) continue
    const text = flattenText(message.content)
    if (text.length > 0) return text
  }
  return ''
}

function renderMessage(message) {
  if (isToolResultMessage(message)) {
    return toolResultsOf(message).map((block) => {
      const body = flattenText(block.content) || '(no output)'
      const flag = block.isError ? ' ERROR' : ''
      return `Tool result${flag} (${block.toolCallId}):\n${body}`
    }).join('\n\n')
  }
  if (message.role === 'assistant') {
    const text = flattenText(message.content)
    const calls = assistantToolCallsOf(message)
    const parts = []
    const reasoning = (message.content ?? [])
      .filter((block) => block.type === 'reasoning')
      .map((block) => block.text)
      .join('')
    if (reasoning) parts.push(`Reasoning:\n${reasoning}`)
    if (text) parts.push(text)
    for (const call of calls) {
      parts.push(`Tool call ${call.name} (${call.id}): ${call.arguments}`)
    }
    return `Assistant:\n${parts.join('\n')}`
  }
  const text = flattenText(message.content)
  if (message.role === 'system') return `System:\n${text}`
  return `User:\n${text}`
}

export function buildKickoffPrompt(system, messages) {
  const sections = [DRIVER_PREAMBLE]
  if (system) sections.push(`System prompt from DSH:\n${system}`)
  const body = messages.map(renderMessage).filter(Boolean).join('\n\n')
  if (body) sections.push(body)
  return sections.join('\n\n')
}

export function buildFollowUpPrompt(system, messages, consumedCount) {
  const fresh = messages.slice(consumedCount)
  const userText = lastUserText(fresh)
  if (userText) {
    return consumedCount === 0 && system
      ? `${DRIVER_PREAMBLE}\n\nSystem prompt from DSH:\n${system}\n\n${userText}`
      : userText
  }
  return buildKickoffPrompt(system, messages)
}

export function sanitizeToolName(name) {
  const cleaned = String(name).replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'tool'
}
