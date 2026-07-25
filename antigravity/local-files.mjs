import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_BACKEND = 'https://paywait-ads.com/api';
const ALLOWED_BACKEND = 'https://paywait-ads.com';
export const REFRESH_LOCK_TTL_MS = 3_500;
export const SESSION_LOCK_TTL_MS = 1_000;
export const PENDING_REQUEST_TTL_MS = 60_000;
export const SESSION_TOUCH_MS = 60_000;
export const SESSION_TTL_MS = 10 * 60_000;
export const CLEANUP_INTERVAL_MS = 60_000;

export function paywaitPaths(home = process.env.HOME) {
  if (!home) throw new Error('HOME manquant');
  const base = join(home, '.paywait');
  return {
    base,
    config: join(base, 'config.json'),
    response: join(base, 'last-response.json'),
    refreshLock: join(base, 'refresh.lock'),
    pending: join(base, 'pending-request.json'),
    sessions: join(base, 'sessions'),
    cleanupLock: join(base, 'antigravity-cleanup.lock'),
  };
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function readConfig(paths) {
  const config = await readJson(paths.config);
  let backend = typeof config?.backend === 'string' && config.backend ? config.backend : DEFAULT_BACKEND;
  if (!backend.startsWith(ALLOWED_BACKEND)) {
    console.error('[PayWait] Backend non autorisé, valeur par défaut utilisée.');
    backend = DEFAULT_BACKEND;
  }
  return {
    token: typeof config?.token === 'string' ? config.token : '',
    backend,
  };
}

export async function readCachedResponse(paths, token, now = Date.now()) {
  const cached = await readJson(paths.response);
  if (
    cached?.version !== 1 ||
    cached?.token_fingerprint !== token.slice(0, 8) ||
    typeof cached?.fresh_until !== 'number' ||
    !cached?.response
  ) {
    return undefined;
  }
  return { ...cached, fresh: now < cached.fresh_until };
}

export async function writeLastResponse(paths, token, sessionId, response, now = Date.now()) {
  await atomicWriteJson(paths.response, {
    version: 1,
    token_fingerprint: token.slice(0, 8),
    generation: randomUUID(),
    owner_session_id: sessionId,
    credited_request_id: response?.request_id || null,
    written_at: now,
    fresh_until: now + Math.max(10_000, Number(response?.retry_after_ms) || 10_000),
    response,
  });
}

export async function acquireRefreshTicket(paths, now = Date.now()) {
  await mkdir(paths.base, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(paths.refreshLock, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({
          owner: randomUUID(),
          started_at: now,
          expires_at: now + REFRESH_LOCK_TTL_MS,
        }));
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (now - (await stat(paths.refreshLock)).mtimeMs <= REFRESH_LOCK_TTL_MS) return false;
        await rename(paths.refreshLock, `${paths.refreshLock}.stale.antigravity.${randomUUID()}`);
      } catch (staleError) {
        if (staleError?.code !== 'ENOENT') throw staleError;
      }
    }
  }
  return false;
}

function safeSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ? sessionId
    : undefined;
}

export function sessionPaths(paths, sessionId) {
  const safeId = safeSessionId(sessionId);
  if (!safeId) return undefined;
  // The session id is intentionally the filename suffix: it is the sole
  // Antigravity identifier retained locally and is not user content.
  return {
    state: join(paths.sessions, `antigravity-${safeId}.json`),
    lock: join(paths.sessions, `antigravity-${safeId}.lock`),
  };
}

function knownSession(value) {
  return value?.version === 1 && value?.tool === 'antigravity' &&
    typeof value?.active === 'boolean' &&
    (value?.cycle_id === null || typeof value?.cycle_id === 'string')
    ? value
    : undefined;
}

async function releaseOwnedLock(path, owner) {
  const current = await readJson(path);
  if (current?.owner !== owner) return;
  try {
    await rm(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function acquireSessionLock(path, now) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = randomUUID();
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({
          owner,
          started_at: now,
          expires_at: now + SESSION_LOCK_TTL_MS,
        }));
      } finally {
        await file.close();
      }
      return owner;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (now - (await stat(path)).mtimeMs <= SESSION_LOCK_TTL_MS) return undefined;
        await rename(path, `${path}.stale.${randomUUID()}`);
      } catch (staleError) {
        if (staleError?.code !== 'ENOENT') throw staleError;
      }
    }
  }
  return undefined;
}

function transition(previous, state, now) {
  const prior = knownSession(previous) ?? {
    version: 1,
    tool: 'antigravity',
    cycle_id: null,
    active: false,
    last_state: 'idle',
    updated_at: 0,
  };

  if (state === 'idle') {
    return {
      value: { ...prior, active: false, last_state: state, updated_at: now },
      newCycle: false,
      changed: prior.active || prior.last_state !== state,
    };
  }

  if (state !== 'working' && state !== 'reviewing') {
    // Unknown states never create revenue activity.  If they occur between
    // two known active states, retain the active cycle to prevent a duplicate.
    return {
      value: { ...prior, last_state: state, updated_at: now },
      newCycle: false,
      changed: prior.last_state !== state,
    };
  }

  if (prior.active && prior.cycle_id) {
    return {
      value: { ...prior, active: true, last_state: state, updated_at: now },
      newCycle: false,
      changed: prior.last_state !== state || now - Number(prior.updated_at || 0) >= SESSION_TOUCH_MS,
    };
  }

  return {
    value: {
      ...prior,
      active: true,
      cycle_id: randomUUID(),
      last_state: state,
      updated_at: now,
    },
    newCycle: true,
    changed: true,
  };
}

export async function transitionSession(paths, sessionId, state, now = Date.now()) {
  const files = sessionPaths(paths, sessionId);
  if (!files) return { active: false, newCycle: false, cycleId: undefined };

  const before = knownSession(await readJson(files.state));
  const preview = transition(before, state, now);
  if (!preview.changed) {
    return { active: preview.value.active, newCycle: false, cycleId: preview.value.cycle_id || undefined };
  }

  const owner = await acquireSessionLock(files.lock, now);
  if (!owner) {
    const current = knownSession(await readJson(files.state));
    return { active: Boolean(current?.active), newCycle: false, cycleId: current?.cycle_id || undefined };
  }

  try {
    const latest = knownSession(await readJson(files.state));
    const result = transition(latest, state, now);
    if (result.changed) await atomicWriteJson(files.state, result.value);
    return { active: result.value.active, newCycle: result.newCycle, cycleId: result.value.cycle_id || undefined };
  } finally {
    await releaseOwnedLock(files.lock, owner);
  }
}

export function promptIdFor(sessionId, cycleId) {
  return `antigravity:${sessionId}:${cycleId}`;
}

export async function getPendingRequest(paths, token, promptId, now = Date.now()) {
  const pending = await readJson(paths.pending);
  if (
    typeof pending?.request_id === 'string' && pending.request_id &&
    typeof pending?.prompt_id === 'string' && pending.prompt_id &&
    pending.token_fingerprint === token.slice(0, 8) &&
    typeof pending.created_at === 'number' && now >= pending.created_at &&
    now - pending.created_at < PENDING_REQUEST_TTL_MS
  ) {
    return pending;
  }

  const next = {
    request_id: randomUUID(),
    prompt_id: promptId,
    token_fingerprint: token.slice(0, 8),
    created_at: now,
  };
  await atomicWriteJson(paths.pending, next);
  return next;
}

export async function clearPendingRequestIfConfirmed(paths, pending, response) {
  if (response?.request_id !== pending?.request_id) return;
  try {
    await rm(paths.pending);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function acquireCleanupTicket(paths, now) {
  await mkdir(paths.base, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(paths.cleanupLock, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ started_at: now, expires_at: now + CLEANUP_INTERVAL_MS }));
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (now - (await stat(paths.cleanupLock)).mtimeMs < CLEANUP_INTERVAL_MS) return false;
        await rename(paths.cleanupLock, `${paths.cleanupLock}.stale.${randomUUID()}`);
      } catch (staleError) {
        if (staleError?.code !== 'ENOENT') throw staleError;
      }
    }
  }
  return false;
}

export async function cleanupAntigravityArtifacts(paths, now = Date.now()) {
  if (!(await acquireCleanupTicket(paths, now))) return { ran: false, removed: 0 };
  let removed = 0;
  const remove = async (path, threshold) => {
    try {
      if (now - (await stat(path)).mtimeMs <= threshold) return;
      await rm(path);
      removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };

  try {
    const sessions = await readdir(paths.sessions);
    await Promise.all(sessions.map(async name => {
      const path = join(paths.sessions, name);
      if (/^antigravity-[A-Za-z0-9_-]{1,128}\.json$/.test(name)) {
        await remove(path, SESSION_TTL_MS);
      } else if (/^antigravity-[A-Za-z0-9_-]{1,128}\.lock$/.test(name)) {
        await remove(path, SESSION_LOCK_TTL_MS);
      } else if (/^antigravity-[A-Za-z0-9_-]{1,128}\.lock\.stale\.[A-Za-z0-9_-]+$/.test(name)) {
        await remove(path, SESSION_LOCK_TTL_MS);
      } else if (/^antigravity-[A-Za-z0-9_-]{1,128}\.json\.\d+\.[A-Za-z0-9-]+\.tmp$/.test(name)) {
        await remove(path, SESSION_TTL_MS);
      }
    }));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    const files = await readdir(paths.base);
    await Promise.all(files.map(async name => {
      if (
        /^refresh\.lock\.stale\.antigravity\.[A-Za-z0-9-]+$/.test(name) ||
        /^antigravity-cleanup\.lock\.stale\.[A-Za-z0-9-]+$/.test(name)
      ) {
        await remove(join(paths.base, name), SESSION_TTL_MS);
      }
    }));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { ran: true, removed };
}
