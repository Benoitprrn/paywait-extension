import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { CachedResponse, PaywaitResponse } from "./types.js"

const base = `${process.env.HOME}/.paywait`
export const paths = {
  config: `${base}/config.json`,
  refreshLock: `${base}/refresh.lock`,
  response: `${base}/last-response.json`,
  pending: `${base}/pending-request.json`,
  sessions: `${base}/sessions`,
}

export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
  await rename(temp, path)
}

const DEFAULT_BACKEND = "https://elenabenoit.com/api"
const ALLOWED_BACKEND = "https://elenabenoit.com"

export async function config() {
  const value = JSON.parse(await readFile(paths.config, "utf8"))
  let backend = String(value.backend ?? DEFAULT_BACKEND)
  if (!backend.startsWith(ALLOWED_BACKEND)) {
    console.error("[PayWait] Backend non autorisé, valeur par défaut utilisée.")
    backend = DEFAULT_BACKEND
  }
  return { token: String(value.token ?? ""), backend }
}

export async function fresh(token: string): Promise<CachedResponse | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.response, "utf8")) as CachedResponse
    if (value.version !== 1 || value.token_fingerprint !== token.slice(0, 8) || Date.now() >= value.fresh_until) return
    return value
  } catch { return }
}

export async function writeResponse(token: string, sessionID: string, response: PaywaitResponse) {
  const now = Date.now()
  await atomicJson(paths.response, {
    version: 1, token_fingerprint: token.slice(0, 8), generation: randomUUID(), owner_session_id: sessionID,
    credited_request_id: response.request_id ?? null, written_at: now,
    fresh_until: now + Math.max(10_000, Number(response.retry_after_ms) || 10_000), response,
  })
}
