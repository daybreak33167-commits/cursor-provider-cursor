import { Cursor } from '@cursor/sdk'

const DEFAULT_CONTEXT = 200_000
const MAX_CONTEXT = 1_000_000
const DEFAULT_MAX_TOKENS = 65_536
const CACHE_MS = 60_000

const FAMILY = {
  auto: { contextWindow: DEFAULT_CONTEXT, optimize: ['cost', 'balanced', 'intelligence'] },
  composer: { contextWindow: DEFAULT_CONTEXT, fast: true },
  grok: { contextWindow: DEFAULT_CONTEXT, maxContextWindow: MAX_CONTEXT, efforts: ['low', 'medium', 'high', 'xhigh'], fast: true, maxMode: true },
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

const SPEED_VALUES = new Set(['standard', 'fast', 'true', 'false', 'on', 'off', '0', '1', 'default', 'normal'])
const REAL_EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'extra_high', 'extra-high', 'minimal', 'min', 'max'])

function classifyParam(id) {
  const name = String(id).toLowerCase()
  if (name === 'optimize_for' || name === 'optimization') return 'optimize'
  if (name === 'fast') return 'fast'
  if (name === 'max' || name === 'max_mode' || name === 'maxmode' || name === 'long_context') return 'max'
  if (name.includes('effort') || name === 'reasoning' || name === 'thinking') return 'effort'
  return 'other'
}

function paramValueList(parameter) {
  return (parameter?.values ?? []).map((entry) => String(entry.value ?? entry).toLowerCase())
}

/** Cursor sometimes exposes a speed toggle (standard/fast) under thinking/effort. */
function isSpeedOnlyParam(parameter) {
  const values = paramValueList(parameter)
  return values.length > 0 && values.every((value) => SPEED_VALUES.has(value))
}

function hasRealEffortValues(parameter) {
  return paramValueList(parameter).some((value) => REAL_EFFORT_VALUES.has(value))
}

function asFastParam(parameter) {
  return {
    id: 'fast',
    displayName: parameter?.displayName || 'Fast',
    values: [
      { value: 'false', displayName: 'Standard' },
      { value: 'true', displayName: 'Fast' },
    ],
  }
}

/**
 * Merge live Cursor parameters with family defaults.
 * Speed toggles must not replace real thinking levels (low/medium/high/…).
 */
function normalizeLiveParameters(liveParameters, family) {
  const inferred = inferParameters(family)
  if (!liveParameters?.length) return inferred

  const liveByKind = new Map()
  for (const parameter of liveParameters) {
    let kind = classifyParam(parameter.id)
    let next = parameter
    if (kind === 'effort' && isSpeedOnlyParam(parameter)) {
      kind = 'fast'
      next = asFastParam(parameter)
    }
    if (kind === 'other') continue
    if (kind === 'effort' && !hasRealEffortValues(parameter)) continue
    liveByKind.set(kind, next)
  }

  const merged = new Map()
  for (const parameter of inferred) {
    const kind = classifyParam(parameter.id)
    if (kind !== 'other') merged.set(kind, parameter)
  }
  for (const [kind, parameter] of liveByKind) {
    if (kind === 'effort' && !hasRealEffortValues(parameter)) continue
    merged.set(kind, parameter)
  }
  return [...merged.values()]
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
    parameters: normalizeLiveParameters(item.parameters, family),
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

function recordParameters(record) {
  return normalizeLiveParameters(record.parameters, record.family ?? familyOf(record.id))
}

function groupedParams(parameters) {
  const groups = { effort: undefined, fast: undefined, max: undefined, optimize: undefined }
  for (const parameter of parameters ?? []) {
    const kind = classifyParam(parameter.id)
    if (kind !== 'other' && !groups[kind]) groups[kind] = parameter
  }
  return groups
}

/**
 * Build selectable reasoningEffort rows.
 * When both thinking-level and Max-context exist, emit the cartesian product so
 * the UI can expose three independent pickers (model / effort / context) while
 * DSH still validates a single opaque reasoningEffort id.
 */
function effortChoices(record) {
  const groups = groupedParams(recordParameters(record))
  const choices = []

  const baseWindow = record.contextWindow ?? DEFAULT_CONTEXT
  const maxWindow = record.maxContextWindow ?? baseWindow
  const fixedContextName = `${Math.round(baseWindow / 1000)}K`

  if (groups.optimize) {
    for (const value of paramValues(groups.optimize)) {
      const params = [{ id: groups.optimize.id, value: value.value }]
      choices.push({
        id: encodeParams(params),
        name: `${value.name} · ${fixedContextName}`,
        params,
        contextWindow: baseWindow,
        effortLabel: value.name,
        contextLabel: fixedContextName,
      })
    }
    return choices
  }

  const effortValues = groups.effort
    ? paramValues(groups.effort)
    : groups.fast
      ? paramValues(groups.fast).map((value) => ({
        value: value.value,
        name: value.value === 'true' || value.value === '1' ? 'Fast' : 'Standard',
        fast: true,
      }))
      : [{ value: '', name: 'Default' }]

  // Always expose a context dimension so the third picker stays visible.
  // With Max mode: 200K / Max 1000K; otherwise a single fixed window.
  const contextValues = groups.max && maxWindow > baseWindow
    ? paramValues(groups.max).map((value) => {
      const maxOn = value.value === 'true' || value.value === '1' || /max|1m|long/i.test(`${value.value} ${value.name}`)
      const window = maxOn ? maxWindow : baseWindow
      return {
        value: value.value,
        name: maxOn ? `Max ${Math.round(window / 1000)}K` : `${Math.round(window / 1000)}K`,
        window,
      }
    })
    : [{ value: '', name: fixedContextName, window: baseWindow }]

  for (const effort of effortValues) {
    for (const context of contextValues) {
      const params = []
      if (groups.effort && effort.value !== '') {
        params.push({ id: groups.effort.id, value: effort.value })
      } else if (effort.fast && groups.fast) {
        params.push({ id: groups.fast.id, value: effort.value })
      }
      if (groups.max && context.value !== '') {
        params.push({ id: groups.max.id, value: context.value })
      }
      const parts = []
      if (effort.name && effort.name !== 'Default') parts.push(effort.name)
      if (context.name) parts.push(context.name)
      choices.push({
        id: encodeParams(params) || 'default',
        name: parts.join(' · ') || effort.name || 'Default',
        params,
        contextWindow: context.window,
        effortLabel: effort.name || 'Default',
        contextLabel: context.name,
      })
    }
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
  if (implied?.length) {
    const hit = choices.find((choice) => (
      implied.every((param) => choice.params.some((item) => item.id === param.id && item.value === param.value))
    ))
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
  return preferred ?? choices[0] ?? {
    id: 'default',
    name: 'Default',
    params: [],
    contextWindow: record.contextWindow ?? DEFAULT_CONTEXT,
    effortLabel: undefined,
    contextLabel: undefined,
  }
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
  const effortImplied = [
    ...implied.filter((param) => classifyParam(param.id) !== 'fast'),
    ...variantParams,
  ]
  let fallback = defaultChoice(record, effortImplied)
  if (choices.length > 0 && !choices.some((choice) => choice.id === fallback.id)) {
    fallback = choices[0]
  }
  if (choices.length === 0) {
    fallback = {
      id: 'default',
      name: 'Default',
      params: [],
      contextWindow: record.contextWindow ?? DEFAULT_CONTEXT,
      effortLabel: undefined,
      contextLabel: undefined,
    }
    choices.push(fallback)
  }

  const hasContextDim = choices.some((choice) => choice.contextLabel)
  const hasEffortDim = choices.some((choice) => choice.effortLabel)
  const efforts = choices.map((choice) => ({
    id: brand(choice.id),
    name: choice.name,
    // Custom 3-pane UI reads these; stock UI shows name + description.
    description: [
      choice.effortLabel ? `effort:${choice.effortLabel}` : '',
      choice.contextLabel ? `context:${choice.contextLabel}` : '',
      `ctx:${choice.contextWindow}`,
    ].filter(Boolean).join('|'),
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
      dimensions: {
        effort: hasEffortDim,
        context: hasContextDim,
      },
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
      ...modelId.includes('::') ? decodeEffort(modelId.split('::')[1] ?? '') : [],
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
