import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  acquireRefreshTicket,
  paywaitPaths,
  readCachedResponse,
  readConfig,
  transitionSession,
} from './local-files.mjs';

const R = '\x1b[0m';
const ESC = '\x1b';
const ST = '\x1b\\';

function isControlChar(char) {
  const code = char.codePointAt(0);
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function badge(background, text) {
  return `\x1b[1;30;48;2;${background}m ${text} ${R}`;
}

/** N'accepte que #RRGGBB strict (casse libre) ; toute autre valeur retombe sur blanc. */
export function hexToRgb(hex) {
  const value = String(hex ?? '');
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return '255;255;255';
  return `${parseInt(value.slice(1, 3), 16)};${parseInt(value.slice(3, 5), 16)};${parseInt(value.slice(5, 7), 16)}`;
}

/** Retire tout caractère de contrôle (ESC, BEL, retours à la ligne, C1...) des champs dynamiques du serveur. */
export function safeText(value) {
  return Array.from(String(value ?? ''))
    .filter(char => !isControlChar(char))
    .join('')
    .trim();
}

/** N'autorise que http(s) sans caractère de contrôle ; toute autre valeur devient '' (non cliquable). */
export function safeUrl(value) {
  const raw = String(value ?? '');
  if (Array.from(raw).some(char => isControlChar(char))) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** Domaine de secours affiché quand url_display est absent. */
export function visibleDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Lien OSC 8 ; sans URL validée, renvoie le texte visible tel quel (pas de séquence ouverte). */
export function link(url, text) {
  if (!url) return text;
  return `${ESC}]8;;${url}${ST}${text}${ESC}]8;;${ST}`;
}

export function display(response, terminalWidth) {
  let line = 'PayWait';
  switch (response?.type) {
    case 'init':
      line = 'PayWait — Send a prompt to receive ads';
      break;
    case 'ad': {
      const rgb = hexToRgb(response.color);
      const brandName = safeText(response.brand_name);
      const text = safeText(response.text);
      const earnings = safeText(response.earnings);
      const total = safeText(response.total);
      const urlReal = safeUrl(response.url_real);
      const urlDisplay = safeText(response.url_display) || visibleDomain(urlReal);
      line = `${badge('245;158;11', 'SPONSORED')}\x1b[1;38;2;${rgb}m ${brandName} ${R}\x1b[38;2;${rgb}m${text} ${R}\x1b[2;37m${link(urlReal, `↗ ${urlDisplay}`)}${R}\x1b[1;32m  +${earnings}€${R}\x1b[1;37m  |  Total : ${total}€${R}`;
      break;
    }
    case 'waiting':
      line = 'PayWait — Send a prompt to receive new ads';
      break;
    case 'error':
      line = `${badge('200;30;30', 'ERREUR')}\x1b[1;31m ${safeText(response.text) || 'Token invalide — vérifiez votre installation'}${R}`;
      break;
    default:
      break;
  }
  // ANSI-aware truncation is intentionally deferred: clipping escape codes can
  // corrupt the TUI. terminal_width is read but never persisted or transmitted.
  void terminalWidth;
  return line;
}

export function parseStatusInput(input) {
  const value = JSON.parse(input);
  return {
    sessionId: typeof value?.session_id === 'string' ? value.session_id : undefined,
    state: typeof value?.agent_state === 'string' ? value.agent_state : undefined,
    terminalWidth: Number.isFinite(value?.terminal_width) ? value.terminal_width : undefined,
  };
}

export function workFor({ cycleId, newCycle, cached }) {
  const cachedType = cached?.response?.type;
  const forcedAtCycleStart = Boolean(
    newCycle && (cachedType === 'waiting' || cachedType === 'init' || cachedType === 'welcome' || !cached),
  );
  return {
    presence: Boolean(newCycle && cycleId),
    // Cache freshness belongs to the whole local PayWait installation, not to
    // one window's state.  Reuse an existing cycle while idle; never invent
    // one for an initial idle Antigravity session.
    refresh: Boolean(cycleId && (!cached?.fresh || forcedAtCycleStart)),
    forceRefresh: forcedAtCycleStart,
  };
}

export function spawnWorker(workerPath, payload) {
  const child = spawn(process.execPath, [workerPath, JSON.stringify(payload)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Diagnostic mode: off unless PAYWAIT_ANTIGRAVITY_DEBUG=1. Never touches
// trigger decisions — read-only observability appended after they're made.
export const DIAGNOSTIC_ENV_VAR = 'PAYWAIT_ANTIGRAVITY_DEBUG';
export const DIAGNOSTIC_LOG_FILE = 'antigravity-diagnostic.log';

export function diagnosticEnabled(env = process.env) {
  return env[DIAGNOSTIC_ENV_VAR] === '1';
}

/** Ne construit que les champs de diagnostic autorisés : jamais prompt, email, cwd, transcript, modèle, token ni contenu publicitaire. */
export function buildDiagnosticEvent({ sessionId, agentState, session, work, cached, lockAcquired, workerKind, now = Date.now() }) {
  return {
    timestamp: new Date(now).toISOString(),
    session_id: sessionId ?? null,
    agent_state: agentState ?? null,
    transition: session?.newCycle ? 'new_cycle' : session?.active ? 'continued' : 'idle',
    cycle_id: session?.cycleId ?? null,
    force_refresh: Boolean(work?.forceRefresh),
    cache_type: cached?.response?.type ?? null,
    cache_fresh: cached ? Boolean(cached.fresh) : null,
    refresh_lock: lockAcquired,
    worker_launched: workerKind,
  };
}

export async function appendDiagnosticEvent(event, paths, env = process.env) {
  if (!diagnosticEnabled(env)) return false;
  const { appendFile, mkdir } = await import('node:fs/promises');
  await mkdir(paths.base, { recursive: true, mode: 0o700 });
  await appendFile(join(paths.base, DIAGNOSTIC_LOG_FILE), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return true;
}

export async function runStatusline({ home = process.env.HOME, input, workerPath, spawnDetached = spawnWorker, env = process.env } = {}) {
  const parsed = parseStatusInput(input ?? await stdinText());
  if (!parsed.sessionId || !parsed.state) return { line: display(undefined, parsed.terminalWidth), worker: false };

  const paths = paywaitPaths(home);
  const { token } = await readConfig(paths);
  if (!token) {
    return { line: display({ type: 'error', text: 'Token manquant — installez PayWait sur elenabenoit.com' }, parsed.terminalWidth), worker: false };
  }

  const session = await transitionSession(paths, parsed.sessionId, parsed.state);
  const cached = await readCachedResponse(paths, token);
  const line = display(cached?.response, parsed.terminalWidth);
  const work = workFor({ cycleId: session.cycleId, newCycle: session.newCycle, cached });
  let worker = false;
  let lockAcquired = null;
  let workerKind = 'none';

  if (work.refresh) {
    if (await acquireRefreshTicket(paths)) {
      lockAcquired = true;
      spawnDetached(workerPath ?? resolve(dirname(fileURLToPath(import.meta.url)), 'refresh-worker.mjs'), {
        session_id: parsed.sessionId,
        cycle_id: session.cycleId,
        presence: work.presence,
        refresh: true,
        force_refresh: work.forceRefresh,
      });
      worker = true;
      workerKind = 'refresh';
    } else {
      lockAcquired = false;
      if (work.presence) {
        spawnDetached(workerPath ?? resolve(dirname(fileURLToPath(import.meta.url)), 'refresh-worker.mjs'), {
          session_id: parsed.sessionId,
          cycle_id: session.cycleId,
          presence: true,
          refresh: false,
          force_refresh: false,
        });
        worker = true;
        workerKind = 'presence';
      }
    }
  } else if (work.presence) {
    spawnDetached(workerPath ?? resolve(dirname(fileURLToPath(import.meta.url)), 'refresh-worker.mjs'), {
      session_id: parsed.sessionId,
      cycle_id: session.cycleId,
      presence: true,
      refresh: false,
      force_refresh: false,
    });
    worker = true;
    workerKind = 'presence';
  }

  if (diagnosticEnabled(env)) {
    await appendDiagnosticEvent(
      buildDiagnosticEvent({ sessionId: parsed.sessionId, agentState: parsed.state, session, work, cached, lockAcquired, workerKind }),
      paths,
      env,
    ).catch(() => {});
  }

  return { line, worker, session, cached };
}

async function main() {
  try {
    const result = await runStatusline();
    process.stdout.write(`${result.line}\n`);
  } catch {
    process.stdout.write('PayWait\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
