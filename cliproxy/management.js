const DEFAULT_TIMEOUT_MS = 15_000

export class ManagementError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ManagementError'
    this.status = status
  }
}

export function createManagementClient({ getBaseUrl, getKey }) {
  async function call(method, path, { query, body, timeoutMs } = {}) {
    const base = getBaseUrl().replace(/\/+$/, '')
    const url = new URL(`${base}/v0/management${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const key = await getKey()
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...body !== undefined ? { 'content-type': 'application/json' } : {},
      },
      ...body !== undefined ? { body: JSON.stringify(body) } : {},
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = { raw: text }
    }
    if (!response.ok) {
      const detail = data?.error ?? data?.message ?? text?.slice(0, 200) ?? ''
      throw new ManagementError(`management ${method} ${path} -> ${response.status}${detail ? ` (${detail})` : ''}`, response.status)
    }
    return data
  }

  return {
    call,
    config: () => call('GET', '/config'),
    authFiles: async () => (await call('GET', '/auth-files'))?.files ?? [],
    deleteAuthFile: (name) => call('DELETE', '/auth-files', { query: { name } }),
    setAuthFileDisabled: (name, disabled) => call('PATCH', '/auth-files/status', { body: { name, disabled } }),
    authFileModels: async (name) => (await call('GET', '/auth-files/models', { query: { name } }))?.models ?? [],
    modelDefinitions: async (channel) => (await call('GET', `/model-definitions/${channel}`))?.models ?? [],
    startAuth: (authPath, { webui = true } = {}) => call('GET', `/${authPath}`, {
      query: webui ? { is_webui: 'true' } : {},
      timeoutMs: 30_000,
    }),
    authStatus: (state) => call('GET', '/get-auth-status', { query: { state } }),
    cancelAuth: (state) => call('DELETE', '/oauth-session', { query: { state } }),
    plugins: async () => (await call('GET', '/plugins'))?.plugins ?? [],
    latestVersion: async () => (await call('GET', '/latest-version'))?.['latest-version'],
  }
}
