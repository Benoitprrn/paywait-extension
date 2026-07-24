// @bun
// src/tui.tsx
import { createSignal } from "solid-js";

// src/local-coordination.ts
import { open, rename as rename2, stat } from "fs/promises";
import { randomUUID as randomUUID2 } from "crypto";

// src/local-files.ts
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import { randomUUID } from "crypto";
var base = `${process.env.HOME}/.paywait`;
var paths = {
  config: `${base}/config.json`,
  refreshLock: `${base}/refresh.lock`,
  response: `${base}/last-response.json`,
  pending: `${base}/pending-request.json`,
  sessions: `${base}/sessions`
};
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 384 });
  await rename(temp, path);
}
var DEFAULT_BACKEND = "https://elenabenoit.com/api";
var ALLOWED_BACKEND = "https://elenabenoit.com";
async function config() {
  const value = JSON.parse(await readFile(paths.config, "utf8"));
  let backend = String(value.backend ?? DEFAULT_BACKEND);
  if (!backend.startsWith(ALLOWED_BACKEND)) {
    console.error("[PayWait] Backend non autoris\xE9, valeur par d\xE9faut utilis\xE9e.");
    backend = DEFAULT_BACKEND;
  }
  return { token: String(value.token ?? ""), backend };
}
async function fresh(token) {
  try {
    const value = JSON.parse(await readFile(paths.response, "utf8"));
    if (value.version !== 1 || value.token_fingerprint !== token.slice(0, 8) || Date.now() >= value.fresh_until)
      return;
    return value;
  } catch {
    return;
  }
}
async function writeResponse(token, sessionID, response) {
  const now = Date.now();
  await atomicJson(paths.response, {
    version: 1,
    token_fingerprint: token.slice(0, 8),
    generation: randomUUID(),
    owner_session_id: sessionID,
    credited_request_id: response.request_id ?? null,
    written_at: now,
    fresh_until: now + Math.max(1e4, Number(response.retry_after_ms) || 1e4),
    response
  });
}

// src/local-coordination.ts
var lease = 3500;
async function acquireRefreshTicket() {
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      const file = await open(paths.refreshLock, "wx", 384);
      const now = Date.now();
      await file.writeFile(JSON.stringify({ owner: randomUUID2(), started_at: now, expires_at: now + lease }));
      await file.close();
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST")
        throw error;
      try {
        if (Date.now() - (await stat(paths.refreshLock)).mtimeMs <= lease)
          return false;
        await rename2(paths.refreshLock, `${paths.refreshLock}.stale.${randomUUID2()}`);
      } catch (stale) {
        if (stale?.code !== "ENOENT")
          throw stale;
      }
    }
  }
  return false;
}

// src/paywait-client.ts
import { randomUUID as randomUUID3 } from "crypto";
import { readFile as readFile2, rm } from "fs/promises";
var DEFAULT_BACKEND2 = "https://elenabenoit.com/api";
var ALLOWED_BACKEND2 = "https://elenabenoit.com";
function validatedBackend(backend) {
  if (!backend.startsWith(ALLOWED_BACKEND2)) {
    console.error("[PayWait] Backend non autoris\xE9, valeur par d\xE9faut utilis\xE9e.");
    return DEFAULT_BACKEND2;
  }
  return backend;
}
async function requestAd(token, backend, sessionID, activityID) {
  const safeBackend = validatedBackend(backend);
  const now = Date.now();
  let pending;
  try {
    pending = JSON.parse(await readFile2(paths.pending, "utf8"));
  } catch {}
  if (!pending || pending.token_fingerprint !== token.slice(0, 8) || now - pending.created_at >= 60000) {
    pending = { request_id: randomUUID3(), prompt_id: `opencode:${sessionID}:${activityID}`, token_fingerprint: token.slice(0, 8), created_at: now };
    await atomicJson(paths.pending, pending);
  }
  const url = new URL(`${safeBackend}/ad`);
  url.searchParams.set("token", token);
  url.searchParams.set("prompt_id", pending.prompt_id);
  url.searchParams.set("request_id", pending.request_id);
  url.searchParams.set("session_id", sessionID);
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.request_id === pending.request_id)
    await rm(paths.pending, { force: true });
  return data;
}
function presence(token, backend, sessionID, activityID) {
  const safeBackend = validatedBackend(backend);
  fetch(`${safeBackend}/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(1000), body: JSON.stringify({ token, prompt_id: `opencode:${sessionID}:${activityID}`, session_id: sessionID }) }).catch(() => {});
}

// src/tui.tsx
import { jsxDEV } from "@opentui/solid/jsx-dev-runtime";
var tui = async (api) => {
  const [data, setData] = createSignal();
  let timer;
  let lastActivity = "";
  let stopped = false;
  const tick = async () => {
    if (stopped)
      return;
    const route = api.route.current;
    if (route.name !== "session") {
      schedule(1e4);
      return;
    }
    const sessionID = route.params.sessionID;
    const status = api.state.session.status(sessionID)?.type ?? "idle";
    const isActive = status === "busy" || status === "retry";
    const activityID = `${sessionID}:${status}`;
    const isNew = isActive && activityID !== lastActivity;
    lastActivity = isActive ? activityID : "";
    try {
      const { token, backend } = await config();
      if (!token) {
        schedule(1e4);
        return;
      }
      const cached = await fresh(token);
      if (cached) {
        if (isNew)
          presence(token, backend, sessionID, activityID);
        setData(cached.response);
        schedule(cached.fresh_until - Date.now());
        return;
      }
      if (!await acquireRefreshTicket()) {
        if (isNew)
          presence(token, backend, sessionID, activityID);
        const retry = await fresh(token);
        if (retry?.response)
          setData(retry.response);
        schedule(1000);
        return;
      }
      const afterTicket = await fresh(token);
      if (afterTicket) {
        if (isNew)
          presence(token, backend, sessionID, activityID);
        setData(afterTicket.response);
        schedule(afterTicket.fresh_until - Date.now());
        return;
      }
      const response = await requestAd(token, backend, sessionID, activityID);
      await writeResponse(token, sessionID, response);
      setData(response);
      schedule(Math.max(1e4, Number(response.retry_after_ms) || 1e4));
    } catch {
      schedule(1e4);
    }
  };
  const schedule = (ms) => {
    if (!stopped)
      timer = setTimeout(() => void tick(), ms);
  };
  const disposeEvent = api.event.on("session.status", () => {
    if (timer)
      clearTimeout(timer);
    tick();
  });
  api.lifecycle.onDispose(() => {
    stopped = true;
    if (timer)
      clearTimeout(timer);
    disposeEvent();
  });
  api.slots.register({
    slots: {
      app_bottom: () => {
        const ad = data();
        if (!ad || ad.type !== "ad")
          return null;
        const brand = String(ad.brand_name || "");
        const text = String(ad.text || "");
        const url = String(ad.url_display || "");
        const earnings = String(ad.earnings || "");
        const total = String(ad.total || "");
        const color = String(ad.color || "#ffffff");
        return /* @__PURE__ */ jsxDEV("text", {
          wrapMode: "none",
          children: [
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: "#b45309", bg: "#000000" },
              children: " SPONSORED "
            }, undefined, false, undefined, this),
            " ",
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: color },
              children: [
                brand,
                " ",
                text
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: "#6b7280" },
              children: ` \u2197 ${url}`
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: "#4ade80" },
              children: [
                "  +",
                earnings,
                "\u20AC"
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: "#9ca3af" },
              children: [
                "  |  Total : ",
                total,
                "\u20AC"
              ]
            }, undefined, true, undefined, this)
          ]
        }, undefined, true, undefined, this);
      }
    }
  });
  tick();
};
var plugin = { id: "paywait.opencode", tui };
var tui_default = plugin;
export {
  tui_default as default
};
