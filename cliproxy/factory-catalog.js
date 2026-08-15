import {
  FACTORY_MODEL_PREFIX,
  allFactoryModelEntries,
} from './factory.js'
import { proxyEffortValue } from './catalog.js'

const DEFAULT_MAX_TOKENS = 32_768
const WINDOW = 200_000
const MAX_WINDOW = 1_000_000
const FALLBACK_EFFORTS = ['low', 'medium', 'high']

function effortName(effort) {
  if (effort === 'xhigh') return 'Extra High'
  if (effort === 'off') return 'Off'
  if (effort === 'max') return 'Max'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Drop wire-only placeholders; keep real selectable thinking levels. */
function uiEfforts(entry) {
  const raw = Array.isArray(entry?.efforts) && entry.efforts.length > 0
    ? entry.efforts
    : FALLBACK_EFFORTS
  return raw.filter((effort) => effort && effort !== 'none')
}

function buildReasoning(entry, ReasoningEffortId) {
  const brand = typeof ReasoningEffortId === 'function' ? ReasoningEffortId : (id) => id
  const levels = uiEfforts(entry)
  const baseK = Math.round(WINDOW / 1000)
  const maxK = Math.round(MAX_WINDOW / 1000)
  const contexts = [
    { flag: '', label: `${baseK}K`, window: WINDOW },
    { flag: 'ctxmax', label: `Max ${maxK}K`, window: MAX_WINDOW },
  ]
  const efforts = []
  for (const effort of levels) {
    for (const context of contexts) {
      const effortLabel = effortName(effort)
      // Use ctxmax (not max) for the context flag so compound ids like
      // `max|ctxmax` stay unambiguous vs thinking level `max`.
      const id = context.flag ? `${effort}|${context.flag}` : effort
      efforts.push({
        id: brand(id),
        name: `${effortLabel} · ${context.label}`,
        description: `effort:${effortLabel}|context:${context.label}|ctx:${context.window}`,
      })
    }
  }
  const preferred = entry?.defaultEffort && levels.includes(entry.defaultEffort)
    ? entry.defaultEffort
    : (levels.includes('medium') ? 'medium' : levels[0])
  return {
    efforts,
    defaultEffort: brand(preferred),
    contextWindow: MAX_WINDOW,
  }
}

export function createFactoryCatalog() {
  const models = allFactoryModelEntries().map((entry) => ({
    id: `${FACTORY_MODEL_PREFIX}${entry.name}`,
    name: entry.display,
    kind: entry.kind,
    upstream: entry.name,
    efforts: entry.efforts,
    defaultEffort: entry.defaultEffort,
  }))

  async function listModels(provider) {
    if (provider !== 'factory') return []
    return models.map((model) => ({
      provider: 'factory',
      id: model.id,
      name: model.name,
      inputModalities: ['text', 'image'],
    }))
  }

  async function resolveModel(provider, modelId, ReasoningEffortId) {
    const record = models.find((model) => model.id === modelId)
    const reasoning = buildReasoning(record, ReasoningEffortId)
    return {
      provider,
      id: modelId,
      name: record?.name ?? modelId,
      inputModalities: ['text', 'image'],
      context: { contextWindow: reasoning.contextWindow },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning: {
        efforts: reasoning.efforts,
        defaultEffort: reasoning.defaultEffort,
      },
    }
  }

  async function overview() {
    return {
      at: Date.now(),
      error: undefined,
      providers: [{
        id: 'factory',
        label: 'Factory Droid',
        models: models.map((model) => model.id),
      }],
    }
  }

  function invalidate() {
    // Static catalog — nothing to refresh.
  }

  return { listModels, resolveModel, overview, invalidate, proxyEffortValue }
}
