import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { atomicJson, paths } from "./local-files.js"
import type { PaywaitResponse } from "./types.js"

const DEFAULT_BACKEND = "https://paywait-ads.com/api"
const ALLOWED_BACKEND = "https://paywait-ads.com"

function validatedBackend(backend: string): string {
  if (!backend.startsWith(ALLOWED_BACKEND)) {
    console.error("[PayWait] Backend non autorisé, valeur par défaut utilisée.")
    return DEFAULT_BACKEND
  }
  return backend
}

export async function requestAd(token: string, backend: string, sessionID: string, activityID: string): Promise<PaywaitResponse> {
  const safeBackend = validatedBackend(backend)
  const now = Date.now(); let pending: any
  try { pending = JSON.parse(await readFile(paths.pending, "utf8")) } catch {}
  if (!pending || pending.token_fingerprint !== token.slice(0, 8) || now - pending.created_at >= 60_000) {
    pending = { request_id: randomUUID(), prompt_id: `opencode:${sessionID}:${activityID}`, token_fingerprint: token.slice(0, 8), created_at: now }
    await atomicJson(paths.pending, pending)
  }
  const url = new URL(`${safeBackend}/ad`)
  url.searchParams.set("token", token); url.searchParams.set("prompt_id", pending.prompt_id)
  url.searchParams.set("request_id", pending.request_id); url.searchParams.set("session_id", sessionID)
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json() as PaywaitResponse
  if (data.request_id === pending.request_id) await rm(paths.pending, { force: true })
  return data
}

export function presence(token: string, backend: string, sessionID: string, activityID: string) {
  const safeBackend = validatedBackend(backend)
  void fetch(`${safeBackend}/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(1000), body: JSON.stringify({ token, prompt_id: `opencode:${sessionID}:${activityID}`, session_id: sessionID }) }).catch(() => {})
}
