import { Cursor } from '@cursor/sdk'

const DEFAULT_CONTEXT = 200_000
const MAX_CONTEXT = 1_000_000
const DEFAULT_MAX_TOKENS = 65_536
const CACHE_MS = 60_000

const FAMILY = {
  auto: { contextWindow: DEFAULT_CONTEXT, optimize: ['cost', 'balanced', 'intelligence'] },
  composer: { contextWindow: DEFAULT_CONTEXT, fast: true },
  grok: { contextWindow: DEFAULT_CONTEXT, efforts: ['low', 'medium', 'high'], fast: true },
  claude: { contextWindow: DEFAULT_CONTEXT, maxContextWindow: MAX_CONTEXT, efforts: ['low', 'medium', 'high'], maxMode: true },
  gpt: { contextWindow: DEFAULT_CONTEXT, maxContextWindow: MAX_CONTEXT, efforts: ['low', 'medium', 'high', 'xhigh'], fast: true, maxMode: true },
  gemini: { contextWindow: MAX_CONTEXT, efforts: ['low', 'medium', 'high'] },
  kimi: { contextWindow: DEFAULT_CONTEXT, maxContextWindow: MAX_CONTEXT, maxMode: true },
}

const STATIC_MODELS = [
  { id: 'auto-smart', name: 'Auto', family: 'auto', aliases: ['auto', 'default'] },
  { id: 'composer-2.5', name: 'Composer 2.5', family: 'composer', aliases: ['composer-2.5-fast'] },
  { id: 'composer-2', name: 'Composer 2', family: 'composer' },
  { id: 'grok-4.6', name: 'Grok 4.6', family: 'grok', aliases: ['grok-4.6-fast'] },
  { id: 'grok-4.5', name: 'Grok 4.5', family: 'grok', aliases: ['grok-4.5-fast'] },
  { id: 'claude-4.6-sonnet', name: 'Claude 4.6 Sonnet', family: 'claude', aliases: ['claude-4.6-sonnet-thinking'] },
  { id: 'claude-4.6-opus', name: 'Claude 4.6 Opus', family: 'claude' },
  { id: 'claude-4.7-opus', name: 'Claude 4.7 Opus', family: 'claude' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', family: 'claude', aliases: ['claude-opus-5-fast'] },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', family: 'claude' },
  { id: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet', family: 'claude' },
  { id: 'claude-4.5-opus', name: 'Claude 4.5 Opus', family: 'claude' },
  { id: 'claude-4.5-haiku', name: 'Claude 4.5 Haiku', family: 'claude' },
  { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet', family: 'claude' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', family: 'claude' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', family: 'gpt' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', family: 'gpt' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', family: 'gpt' },
  { id: 'gpt-5.5', name: 'GPT-5.5', family: 'gpt', aliases: ['gpt-5.5-fast'] },
  { id: 'gpt-5.4', name: 'GPT-5.4', family: 'gpt', aliases: ['gpt-5.4-fast'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', family: 'gpt' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', family: 'gpt' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', family: 'gpt' },
  { id: 'gpt-5.2', name: 'GPT-5.2', family: 'gpt' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', family: 'gpt' },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', family: 'gpt' },
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', family: 'gpt' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', family: 'gpt' },
  { id: 'gpt-5', name: 'GPT-5', family: 'gpt', aliases: ['gpt-5-high', 'gpt-5-fast'] },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', family: 'gpt' },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', family: 'gpt' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', family: 'gemini' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', family: 'gemini' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', family: 'gemini' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', family: 'gemini' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', family: 'gemini' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', family: 'gemini' },
  { id: 'kimi-k3', name: 'Kimi K3', family: 'kimi' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', family: 'kimi' },
]

let cache = { at: 0, items: [] }

function titleCase(value) {
  return String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function displayName(name, id) {
  const raw = String(name || id || '').replace(/^Cursor\s+/i, '').trim()
  return raw || id
}

function familyOf(id) {
  const lower = String(id).toLowerCase()
  if (lower.startsWith('auto') || lower === 'default') return 'auto'
  if (lower.includes('composer')) return 'composer'
  if (lower.includes('grok')) return 'grok'
  if (lower.includes('claude')) return 'claude'
  if (lower.includes('gpt') || lower.includes('o3') || lower.includes('o4')) return 'gpt'
  if (lower.includes('gemini')) return 'gemini'
  if (lower.includes('kimi')) return 'kimi'
  return 'composer'
}

function classifyParam(id) {
  const name = String(id).toLowerCase()
  if (name === 'optimize_for' || name === 'optimization') return 'optimize'
  if (name === 'fast') return 'fast'
  if (name === 'max' || name === 'max_mode' || name === 'maxmode' || name === 'long_context') return 'max'
  if (name.includes('effort') || name === 'reasoning' || name === 'thinking') return 'effort'
  return 'other'
}

function encodeParams(params) {
  return params.map((param) => `${param.id}=${param.value}`).join('|')
}

export function decodeEffort(effortId) {
  if (!effortId) return []
  return String(effortId).split('|').filter(Boolean).map((part) => {
    const index = part.indexOf('=')
    if (index <= 0) return { id: part, value: 'true' }
    return { id: part.slice(0, index), value: part.slice(index + 1) }
  })
}

function paramValues(definition) {
  return (definition?.values ?? []).map((entry) => ({
    value: String(entry.value ?? entry),
    name: entry.displayName || titleCase(entry.value ?? entry),
  }))
}

function inferParameters(family) {
  const spec = FAMILY[family] ?? FAMILY.composer
  const parameters = []
  if (spec.optimize) {
    parameters.push({
      id: 'optimize_for',
      displayName: 'Mode',
      values: spec.optimize.map((value) => ({
        value,
        displayName: value === 'cost' ? 'Cost' : value === 'intelligence' ? 'Intelligence' : 'Balance',
      })),
    })
  }
  if (spec.efforts?.length) {
    parameters.push({
      id: 'effort',
      displayName: 'Effort',
      values: spec.efforts.map((value) => ({
        value,
        displayName: value === 'xhigh' ? 'Extra High' : titleCase(value),
      })),
    })
  }
  if (spec.fast) {
    parameters.push({
      id: 'fast',
      displayName: 'Fast',
      values: [
        { value: 'false', displayName: 'Standard' },
        { value: 'true', displayName: 'Fast' },
      ],
    })
  }
  if (spec.maxMode) {
    parameters.push({
      id: 'max',
      displayName: 'Context',
      values: [
        { value: 'false', displayName: 'Default' },
        { value: 'true', displayName: 'Max' },
      ],
    })
  }
  return parameters
}

function normalizeLiveItem(item) {
  const id = item.id
  const family = familyOf(id)
  const spec = FAMILY[family] ?? FAMILY.composer
  return {
    id,
    name: displayName(item.displayName ?? item.name, id),
    description: item.description,
    aliases: item.aliases ?? [],
    parameters: item.parameters?.length ? item.parameters : inferParameters(family),
    variants: item.variants ?? [],
    family,
    contextWindow: spec.contextWindow ?? DEFAULT_CONTEXT,
    maxContextWindow: spec.maxContextWindow ?? spec.contextWindow ?? DEFAULT_CONTEXT,
    live: true,
  }
}

function normalizeStatic(model) {
  const family = model.family ?? familyOf(model.id)
  const spec = FAMILY[family] ?? FAMILY.composer
  return {
    id: model.id,
    name: displayName(model.name, model.id),
    description: model.description,
    aliases: model.aliases ?? [],
    parameters: inferParameters(family),
    variants: [],
    family,
    contextWindow: spec.contextWindow ?? DEFAULT_CONTEXT,
    maxContextWindow: spec.maxContextWindow ?? spec.contextWindow ?? DEFAULT_CONTEXT,
    live: false,
  }
}

function mergeCatalog(liveItems) {
  const byId = new Map()
  for (const model of STATIC_MODELS) byId.set(model.id, normalizeStatic(model))
  for (const item of liveItems) {
    const next = normalizeLiveItem(item)
    const prev = byId.get(next.id)
    byId.set(next.id, prev
      ? {
        ...prev,
        ...next,
        aliases: [...new Set([...(prev.aliases ?? []), ...(next.aliases ?? [])])],
        parameters: next.parameters?.length ? next.parameters : prev.parameters,
        variants: next.variants?.length ? next.variants : prev.variants,
        live: true,
      }
      : next)
  }
  return [...byId.values()]
}

export async function loadCatalog(apiKey) {
  if (Date.now() - cache.at < CACHE_MS && cache.items.length > 0) return cache.items
  let live = []
  try {
    const listed = await Cursor.models.list(apiKey ? { apiKey } : {})
    live = Array.isArray(listed) ? listed : listed?.models ?? listed?.items ?? []
  } catch {
    live = []
  }
  cache = { at: Date.now(), items: mergeCatalog(live) }
  return cache.items
}

function findRecord(catalog, modelId) {
  const exact = catalog.find((model) => model.id === modelId)
  if (exact) return { record: exact, implied: [] }
  for (const model of catalog) {
    if ((model.aliases ?? []).includes(modelId)) {
      const implied = []
      if (modelId.endsWith('-fast')) implied.push({ id: 'fast', value: 'true' })
      if (modelId.endsWith('-thinking')) implied.push({ id: 'effort', value: 'high' })
      return { record: model, implied }
    }
  }
  const family = familyOf(modelId)
  return {
    record: {
      id: modelId,
      name: modelId,
      aliases: [],
      parameters: inferParameters(family),
      variants: [],
      family,
      contextWindow: (FAMILY[family] ?? FAMILY.composer).contextWindow,
      maxContextWindow: (FAMILY[family] ?? FAMILY.composer).maxContextWindow
        ?? (FAMILY[family] ?? FAMILY.composer).contextWindow,
      live: false,
    },
    implied: modelId.endsWith('-fast') ? [{ id: 'fast', value: 'true' }] : [],
  }
}

function groupedParams(parameters) {
  const groups = { effort: undefined, fast: undefined, max: undefined, optimize: undefined }
  for (const parameter of parameters ?? []) {
    const kind = classifyParam(parameter.id)
    if (kind !== 'other' && !groups[kind]) groups[kind] = parameter
  }
  return groups
}

function effortChoices(record) {
  const groups = groupedParams(record.parameters)
  const choices = []

  if (groups.optimize) {
    for (const value of paramValues(groups.optimize)) {
      choices.push({
        id: encodeParams([{ id: groups.optimize.id, value: value.value }]),
        name: value.name,
        params: [{ id: groups.optimize.id, value: value.value }],
        contextWindow: record.contextWindow,
      })
    }
    return choices
  }

  const efforts = groups.effort
    ? paramValues(groups.effort)
    : [{ value: '', name: groups.fast || groups.max ? 'Default' : 'Default' }]
  const maxes = groups.max
    ? paramValues(groups.max)
    : [{ value: '', name: '' }]

  for (const effort of efforts) {
    for (const max of maxes) {
      const params = []
      if (groups.effort && effort.value !== '') params.push({ id: groups.effort.id, value: effort.value })
      if (groups.max && max.value !== '') params.push({ id: groups.max.id, value: max.value })
      const maxOn = groups.max && (max.value === 'true' || max.value === '1' || /max|1m|long/i.test(`${max.value} ${max.name}`))
      const windowK = Math.round((maxOn ? (record.maxContextWindow ?? MAX_CONTEXT) : record.contextWindow) / 1000)
      const parts = []
      if (groups.effort && effort.name && effort.name !== 'Default') parts.push(effort.name)
      if (groups.max) parts.push(maxOn ? `Max ${windowK}K` : `${windowK}K`)
      const name = parts.join(' · ') || effort.name || 'Default'
      choices.push({
        id: encodeParams(params) || 'default',
        name,
        params,
        contextWindow: maxOn ? (record.maxContextWindow ?? record.contextWindow) : record.contextWindow,
      })
    }
  }

  if (groups.fast && !groups.effort && !groups.max) {
    return paramValues(groups.fast).map((value) => ({
      id: encodeParams([{ id: groups.fast.id, value: value.value }]),
      name: value.value === 'true' || value.value === '1' ? 'Fast' : 'Standard',
      params: [{ id: groups.fast.id, value: value.value }],
      contextWindow: record.contextWindow,
    }))
  }

  return choices
}

function defaultChoice(record, implied) {
  const choices = effortChoices(record)
  const variant = (record.variants ?? []).find((entry) => entry.isDefault)
  if (variant?.params?.length) {
    const core = variant.params.filter((param) => classifyParam(param.id) !== 'fast')
    const hit = choices.find((choice) => (
      core.every((param) => choice.params.some((item) => item.id === param.id && item.value === param.value))
      && !choice.params.some((item) => classifyParam(item.id) === 'fast')
    ))
    if (hit) return hit
  }
  if (implied.length) {
    const hit = choices.find((choice) => implied.every((param) => choice.params.some((item) => item.id === param.id && item.value === param.value)))
    if (hit) return hit
  }
  const preferred = choices.find((choice) => {
    const optimize = choice.params.find((param) => classifyParam(param.id) === 'optimize')
    if (optimize) return optimize.value === 'balanced'
    const effort = choice.params.find((param) => classifyParam(param.id) === 'effort')
    const max = choice.params.find((param) => classifyParam(param.id) === 'max')
    const maxOff = !max || max.value === 'false' || max.value === '0'
    return effort?.value === 'medium' && maxOff
  })
  return preferred ?? choices[0] ?? { id: 'default', name: 'Default', params: [], contextWindow: record.contextWindow }
}

export function listCatalogModels(provider, catalog, configured) {
  const source = configured?.length
    ? configured.map((entry) => {
      const found = findRecord(catalog, entry.id)
      return {
        ...found.record,
        id: entry.id,
        name: entry.name ?? found.record.name,
        description: entry.description ?? found.record.description,
      }
    })
    : catalog

  const seen = new Set()
  const seenNames = new Set()
  const models = []
  const add = (id, name, description) => {
    if (seen.has(id) || seenNames.has(name)) return
    seen.add(id)
    seenNames.add(name)
    models.push({
      provider,
      id,
      name,
      ...description ? { description } : {},
      inputModalities: ['text', 'image'],
    })
  }

  for (const record of source) {
    add(record.id, record.name, record.description)
    for (const alias of record.aliases ?? []) {
      if (alias.endsWith('-fast')) add(alias, `${record.name} Fast`, record.description)
      else if (alias.endsWith('-thinking')) add(alias, `${record.name} Thinking`, record.description)
    }
  }
  return models
}

export function resolveCatalogModel(provider, modelId, catalog, ReasoningEffortId) {
  const brand = typeof ReasoningEffortId === 'function' ? ReasoningEffortId : (id) => id
  let lookupId = modelId
  let variantParams = []
  if (modelId.includes('::')) {
    const [base, encoded] = modelId.split('::')
    lookupId = base
    variantParams = decodeEffort(encoded)
  }
  const { record, implied } = findRecord(catalog, lookupId)
  const choices = [...effortChoices(record)]
  const effortImplied = implied.filter((param) => classifyParam(param.id) !== 'fast')
  let fallback = defaultChoice(record, effortImplied.length ? effortImplied : variantParams)
  if (!choices.some((choice) => choice.id === fallback.id)) {
    fallback = choices[0] ?? fallback
  }
  if (choices.length === 0) {
    fallback = { id: 'default', name: 'Default', params: [], contextWindow: record.contextWindow ?? DEFAULT_CONTEXT }
    choices.push(fallback)
  }
  const contextVaries = new Set(choices.map((choice) => choice.contextWindow)).size > 1
  const efforts = choices.map((choice) => ({
    id: brand(choice.id),
    name: choice.name,
    ...contextVaries
      ? { description: `${Math.round((choice.contextWindow ?? record.contextWindow) / 1000)}K context` }
      : {},
  }))
  let name = record.name
  if (modelId.endsWith('-fast')) name = `${record.name} Fast`
  else if (modelId.endsWith('-thinking')) name = `${record.name} Thinking`
  return {
    provider,
    id: modelId,
    name,
    inputModalities: ['text', 'image'],
    context: {
      contextWindow: record.maxContextWindow ?? record.contextWindow ?? DEFAULT_CONTEXT,
    },
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    reasoning: {
      efforts,
      defaultEffort: brand(fallback.id),
    },
    cursor: {
      id: record.id,
      params: fallback.params,
      choices,
    },
  }
}

function activeParams(params) {
  return (params ?? []).filter((param) => {
    const value = String(param.value).toLowerCase()
    return value !== '' && value !== 'false' && value !== '0' && value !== 'off' && value !== 'default'
  })
}

export function toCursorSelection(modelId, reasoningEffort, resolved) {
  const select = (id, params) => {
    const next = activeParams(params)
    return { id, ...next.length ? { params: next } : {} }
  }
  const catalog = cache.items.length ? cache.items : mergeCatalog([])
  const lookupId = modelId.includes('::') ? modelId.split('::')[0] : modelId
  const { record, implied } = findRecord(catalog, lookupId)
  const merge = (params) => {
    const next = [...(params ?? [])]
    const extras = [
      ...implied.filter((param) => classifyParam(param.id) === 'fast'),
      ...modelId.endsWith('-fast') ? [{ id: 'fast', value: 'true' }] : [],
    ]
    for (const param of extras) {
      if (!next.some((item) => item.id === param.id)) next.push(param)
    }
    return next
  }
  if (resolved?.cursor && reasoningEffort) {
    const choice = resolved.cursor.choices.find((entry) => entry.id === String(reasoningEffort))
    if (choice) return select(resolved.cursor.id, merge(choice.params))
  }
  if (modelId.includes('::')) {
    const [base, encoded] = modelId.split('::')
    return select(base, merge(decodeEffort(encoded)))
  }
  return select(record.id, merge(reasoningEffort ? decodeEffort(reasoningEffort) : implied))
}

export function contextForEffort(resolved, reasoningEffort) {
  const choice = resolved?.cursor?.choices?.find((entry) => entry.id === String(reasoningEffort))
  return choice?.contextWindow ?? resolved?.context?.contextWindow ?? DEFAULT_CONTEXT
}
