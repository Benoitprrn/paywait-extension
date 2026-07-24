import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  clearPendingRequestIfConfirmed,
  cleanupAntigravityArtifacts,
  DEFAULT_BACKEND,
  getPendingRequest,
  paywaitPaths,
  promptIdFor,
  readCachedResponse,
  readConfig,
  writeLastResponse,
} from './local-files.mjs';

const ALLOWED_BACKEND = 'https://elenabenoit.com';

function validPayload(value) {
  return value &&
    typeof value.session_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.session_id) &&
    typeof value.cycle_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.cycle_id) &&
    typeof value.presence === 'boolean' &&
    typeof value.refresh === 'boolean' &&
    typeof value.force_refresh === 'boolean'
    ? value
    : undefined;
}

async function postPresence(backend, token, sessionId, cycleId) {
  const response = await fetch(`${backend}/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, prompt_id: promptIdFor(sessionId, cycleId), session_id: sessionId }),
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await response.arrayBuffer();
}

export async function runWorker(payload, { home = process.env.HOME } = {}) {
  const work = validPayload(payload);
  if (!work) return { ran: false };
  const paths = paywaitPaths(home);
  const { token, backend: configBackend } = await readConfig(paths);
  let backend = configBackend;
  if (!backend.startsWith(ALLOWED_BACKEND)) {
    console.error('[PayWait] Backend non autorisé, valeur par défaut utilisée.');
    backend = DEFAULT_BACKEND;
  }
  if (!token) return { ran: false };
  await cleanupAntigravityArtifacts(paths);

  if (work.presence) {
    // The backend must observe this new synthetic activity before it decides
    // whether /ad is active or waiting. Failures are intentionally tolerated.
    await postPresence(backend, token, work.session_id, work.cycle_id).catch(() => undefined);
  }

  if (!work.refresh) {
    return { ran: true, refreshed: false };
  }

  const cached = await readCachedResponse(paths, token);
  if (!work.force_refresh && cached?.fresh) {
    return { ran: true, refreshed: false };
  }

  const pending = await getPendingRequest(paths, token, promptIdFor(work.session_id, work.cycle_id));
  const url = new URL(`${backend}/ad`);
  url.searchParams.set('token', token);
  url.searchParams.set('prompt_id', pending.prompt_id);
  url.searchParams.set('request_id', pending.request_id);
  url.searchParams.set('session_id', work.session_id);
  const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  await clearPendingRequestIfConfirmed(paths, pending, data);
  await writeLastResponse(paths, token, work.session_id, data);
  return { ran: true, refreshed: true, requestId: pending.request_id };
}

async function main() {
  try {
    const payload = JSON.parse(process.argv[2] || '{}');
    await runWorker(payload);
  } catch {
    // A detached statusline worker must never emit terminal output.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
