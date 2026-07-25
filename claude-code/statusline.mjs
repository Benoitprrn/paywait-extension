const TOKEN_FILE = `${process.env.HOME}/.paywait/config.json`;
const DEFAULT_BACKEND = 'https://paywait-ads.com/api';
const PAYWAIT_DIR = `${process.env.HOME}/.paywait`;
const REFRESH_LOCK_FILE = `${PAYWAIT_DIR}/refresh.lock`;
const LAST_RESPONSE_FILE = `${PAYWAIT_DIR}/last-response.json`;
const PENDING_REQUEST_FILE = `${PAYWAIT_DIR}/pending-request.json`;
const SESSIONS_DIR = `${PAYWAIT_DIR}/sessions`;
const PENDING_REQUEST_TTL_MS = 60_000;
const SESSION_TTL_MS = 10 * 60_000;
const REFRESH_LOCK_TTL_MS = 3_500;
const ESC = '\x1b';
const ST  = '\x1b\\';
const R   = '\x1b[0m';

function link(url, text) {
  if (!url) return text;
  return `${ESC}]8;;${url}${ST}${text}${ESC}]8;;${ST}`;
}

function badge(bg, text) {
  return `\x1b[1;30;48;2;${bg}m ${text} ${R}`;
}

function safeText(str) {
  if (typeof str !== 'string') return '';
  // Supprime les séquences ANSI (\x1b[ ... m) et OSC (\x1b] ... \x07)
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return '255;255;255';
  return `${r};${g};${b}`;
}

function display(data) {
  switch (data.type) {
    case 'init':
      process.stdout.write('PayWait — Send a prompt to receive ads\n');
      break;
    case 'welcome':
      process.stdout.write('PayWait — Send a prompt to receive ads\n');
      break;
    case 'ad': {
      const rgb = hexToRgb(safeText(data.color) || '#FFFFFF');
      const brandName = safeText(data.brand_name);
      const text = safeText(data.text);
      const earnings = safeText(data.earnings);
      const total = safeText(data.total);
      const urlDisplay = safeText(data.url_display);
      const urlReal = safeText(data.url_real);
      process.stdout.write(`${badge('245;158;11', 'SPONSORED')}\x1b[1;38;2;${rgb}m ${brandName} ${R}\x1b[38;2;${rgb}m${text} ${R}\x1b[2;37m${link(urlReal, '↗ ' + urlDisplay)}${R}\x1b[1;32m  +${earnings}€${R}\x1b[1;37m  |  Total : ${total}€${R}\n`);
      break;
    }
    case 'waiting':
      process.stdout.write('PayWait — Send a prompt to receive new ads\n');
      break;
    case 'error':
      process.stdout.write(`${badge('200;30;30', 'ERREUR')}\x1b[1;31m ${safeText(data.text) || 'Token invalide — vérifiez votre installation'}${R}\n`);
      break;
    default:
      process.stdout.write('PayWait\n');
  }
}

async function atomicWriteJson(path, value) {
  const { mkdir, rename, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readFreshResponse(token) {
  try {
    const { readFile } = await import('node:fs/promises');
    const cached = JSON.parse(await readFile(LAST_RESPONSE_FILE, 'utf8'));
    if (
      cached.version !== 1 ||
      cached.token_fingerprint !== token.slice(0, 8) ||
      typeof cached.fresh_until !== 'number' ||
      Date.now() >= cached.fresh_until ||
      !cached.response
    ) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

async function writeLastResponse(token, sessionId, data) {
  const { randomUUID } = await import('node:crypto');
  const retryAfterMs = Math.max(10_000, Number(data?.retry_after_ms) || 10_000);
  await atomicWriteJson(LAST_RESPONSE_FILE, {
    version: 1,
    token_fingerprint: token.slice(0, 8),
    generation: randomUUID(),
    owner_session_id: sessionId,
    credited_request_id: data?.request_id || null,
    written_at: Date.now(),
    fresh_until: Date.now() + retryAfterMs,
    response: data,
  });
}

async function tryAcquireRefreshLock() {
  const { mkdir, open, rename, stat } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');

  await mkdir(PAYWAIT_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(REFRESH_LOCK_FILE, 'wx', 0o600);
      try {
        const now = Date.now();
        await handle.writeFile(JSON.stringify({
          owner: randomUUID(),
          started_at: now,
          expires_at: now + REFRESH_LOCK_TTL_MS,
        }));
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      try {
        const lockStat = await stat(REFRESH_LOCK_FILE);
        if (Date.now() - lockStat.mtimeMs <= REFRESH_LOCK_TTL_MS) {
          return false;
        }
        await rename(
          REFRESH_LOCK_FILE,
          `${REFRESH_LOCK_FILE}.stale.${randomUUID()}`,
        );
      } catch (staleErr) {
        if (staleErr?.code !== 'ENOENT') throw staleErr;
      }
    }
  }
  return false;
}

function signalPresence(backend, token, promptId, sessionId) {
  fetch(`${backend}/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, prompt_id: promptId, session_id: sessionId }),
    signal: AbortSignal.timeout(1000),
  }).catch(() => {});
}

async function cleanupExpiredSessions() {
  const { readdir, rm, stat } = await import('node:fs/promises');

  try {
    const entries = await readdir(SESSIONS_DIR);
    const now = Date.now();
    await Promise.all(entries.filter(name => name.endsWith('.json')).map(async name => {
      const path = `${SESSIONS_DIR}/${name}`;
      try {
        if (now - (await stat(path)).mtimeMs > SESSION_TTL_MS) {
          await rm(path);
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function recordSessionPrompt(sessionId, safeSessionId, promptId) {
  if (!sessionId || !safeSessionId) return false;

  const { readFile } = await import('node:fs/promises');
  const path = `${SESSIONS_DIR}/${safeSessionId}.json`;
  let previousPromptId = null;

  try {
    const session = JSON.parse(await readFile(path, 'utf8'));
    previousPromptId = typeof session.last_prompt_id === 'string'
      ? session.last_prompt_id
      : null;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // A corrupt session file is safely replaced below.
    }
  }

  const isNewPrompt = previousPromptId !== promptId;
  if (isNewPrompt) {
    await atomicWriteJson(path, {
      session_id: sessionId,
      last_prompt_id: promptId,
      updated_at: Date.now(),
    });
  }

  return isNewPrompt;
}

async function getPendingRequest(token, promptId) {
  const { randomUUID } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const tokenFingerprint = token.slice(0, 8);
  const now = Date.now();

  try {
    const pending = JSON.parse(await readFile(PENDING_REQUEST_FILE, 'utf8'));
    if (
      typeof pending.request_id === 'string' &&
      pending.request_id &&
      pending.token_fingerprint === tokenFingerprint &&
      typeof pending.created_at === 'number' &&
      now >= pending.created_at &&
      now - pending.created_at < PENDING_REQUEST_TTL_MS
    ) {
      // A retry must retain the prompt paired with this request ID as well.
      if (typeof pending.prompt_id === 'string' && pending.prompt_id) return pending;
    }
  } catch {
    // No usable pending request: create one below.
  }

  const pending = {
    request_id: randomUUID(),
    prompt_id: promptId,
    token_fingerprint: tokenFingerprint,
    created_at: now,
  };
  await atomicWriteJson(PENDING_REQUEST_FILE, pending);
  return pending;
}

async function clearPendingRequestIfConfirmed(pending, response) {
  if (response?.request_id !== pending.request_id) return;
  const { rm } = await import('node:fs/promises');
  try {
    await rm(PENDING_REQUEST_FILE);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function main() {
  try {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    const token = config.token;
    const backend = config.backend || DEFAULT_BACKEND;

    if (!token) {
      display({ type: 'error', text: 'Token manquant — installez PayWait sur paywait-ads.com' });
      return;
    }

    const chunks = [];
    process.stdin.on('data', d => chunks.push(d));
    await new Promise(resolve => process.stdin.on('end', resolve));

    const session = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const promptId = session?.prompt_id || 'unknown';
    const sessionId = session?.session_id ?? null;
    const safeSessionId = sessionId
      ? String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') || null
      : null;

    if (promptId === 'unknown') {
      display({ type: 'welcome' });
      return;
    }

    await cleanupExpiredSessions();
    const isNewPrompt = await recordSessionPrompt(sessionId, safeSessionId, promptId);

    let cached = await readFreshResponse(token);
    if (cached) {
      if (isNewPrompt) signalPresence(backend, token, promptId, sessionId);
      display(cached.response);
      return;
    }

    const hasRefreshTicket = await tryAcquireRefreshLock();
    if (!hasRefreshTicket) {
      cached = await readFreshResponse(token);
      if (isNewPrompt) signalPresence(backend, token, promptId, sessionId);
      display(cached?.response || { type: 'welcome' });
      return;
    }

    cached = await readFreshResponse(token);
    if (cached) {
      if (isNewPrompt) signalPresence(backend, token, promptId, sessionId);
      display(cached.response);
      return;
    }

    const pending = await getPendingRequest(token, promptId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    try {
      const res = await fetch(
        `${backend}/ad?token=${encodeURIComponent(token)}&prompt_id=${encodeURIComponent(pending.prompt_id)}&request_id=${encodeURIComponent(pending.request_id)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ''}`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await clearPendingRequestIfConfirmed(pending, data);
      await writeLastResponse(token, sessionId, data);
      display(data);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      process.stdout.write('PayWait — Send a prompt to receive ads\n');
    } else {
      process.stdout.write('PayWait\n');
    }
  }
}

main();
