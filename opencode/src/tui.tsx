/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { acquireRefreshTicket } from "./local-coordination.js"
import { config, fresh, writeResponse } from "./local-files.js"
import { presence, requestAd } from "./paywait-client.js"
import type { PaywaitResponse } from "./types.js"

const tui: TuiPlugin = async (api) => {
  const [data, setData] = createSignal<PaywaitResponse>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastActivity = ""
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const route = api.route.current
    if (route.name !== "session") { schedule(10_000); return }
    const sessionID = route.params.sessionID
    const status = api.state.session.status(sessionID)?.type ?? "idle"
    const isActive = status === "busy" || status === "retry"
    const activityID = `${sessionID}:${status}`
    const isNew = isActive && activityID !== lastActivity
    lastActivity = isActive ? activityID : ""
    try {
      const { token, backend } = await config()
      if (!token) { schedule(10_000); return }
      const cached = await fresh(token)
      if (cached) {
        if (isNew) presence(token, backend, sessionID, activityID)
        setData(cached.response)
        schedule(cached.fresh_until - Date.now())
        return
      }
      if (!(await acquireRefreshTicket())) {
        if (isNew) presence(token, backend, sessionID, activityID)
        const retry = await fresh(token)
        if (retry?.response) setData(retry.response)
        schedule(1000); return
      }
      const afterTicket = await fresh(token)
      if (afterTicket) {
        if (isNew) presence(token, backend, sessionID, activityID)
        setData(afterTicket.response)
        schedule(afterTicket.fresh_until - Date.now())
        return
      }
      const response = await requestAd(token, backend, sessionID, activityID)
      await writeResponse(token, sessionID, response)
      setData(response)
      schedule(Math.max(10_000, Number(response.retry_after_ms) || 10_000))
    } catch { schedule(10_000) }
  }
  const schedule = (ms: number) => { if (!stopped) timer = setTimeout(() => void tick(), ms) }
  const disposeEvent = api.event.on("session.status", () => { if (timer) clearTimeout(timer); void tick() })
  api.lifecycle.onDispose(() => { stopped = true; if (timer) clearTimeout(timer); disposeEvent() })
  api.slots.register({
    slots: {
      app_bottom: () => {
        const ad = data()
        if (ad?.type === "error") return null
        if (ad?.type === "waiting") return <text>PayWait — Send a prompt to receive new ads</text>
        if (!ad || ad.type !== "ad") return <text>PayWait — Send a prompt to receive ads</text>

        const brand = String(ad.brand_name || "")
        const text = String(ad.text || "")
        const url = String(ad.url_display || "")
        const earnings = String(ad.earnings || "")
        const total = String(ad.total || "")
        const color = String(ad.color || "#ffffff")

        return (
          <text wrapMode="none">
            <span style={{ fg: "#b45309", bg: "#000000" }}> SPONSORED </span>
            {" "}
            <span style={{ fg: color }}>{brand} {text}</span>
            <span style={{ fg: "#6b7280" }}>{` ↗ ${url}`}</span>
            <span style={{ fg: "#4ade80" }}>  +{earnings}€</span>
            <span style={{ fg: "#9ca3af" }}>  |  Total : {total}€</span>
          </text>
        )
      },
    },
  })
  void tick()
}

const plugin: TuiPluginModule & { id: string } = { id: "paywait.opencode", tui }
export default plugin
