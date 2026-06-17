const DAEMON_BASE = (): string => process.env.GO_DAEMON_URL ?? ''
const DAEMON_SECRET = process.env.GO_INGESTION_SECRET ?? ''

if (!DAEMON_SECRET) {
  console.warn('⚠  GO_INGESTION_SECRET not set — HTTP fallback to Go Daemon is unauthenticated.')
}

function injectSecret(init: RequestInit = {}): RequestInit {
  if (!DAEMON_SECRET) return init
  return {
    ...init,
    headers: { 'X-Ingestion-Secret': DAEMON_SECRET, ...(init.headers ?? {}) },
  }
}

export function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${DAEMON_BASE()}${path}`, injectSecret(init))
}
