export type PaywaitResponse = {
  type: "ad" | "init" | "waiting" | "error"
  text?: string
  brand_name?: string
  color?: string
  url_display?: string
  url_real?: string
  earnings?: string
  total?: string
  retry_after_ms?: number
  request_id?: string
}

export type CachedResponse = {
  version: 1
  token_fingerprint: string
  generation: string
  owner_session_id: string | null
  credited_request_id: string | null
  written_at: number
  fresh_until: number
  response: PaywaitResponse
}
