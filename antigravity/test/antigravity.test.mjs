import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  acquireRefreshTicket,
  atomicWriteJson,
  cleanupAntigravityArtifacts,
  getPendingRequest,
  paywaitPaths,
  readCachedResponse,
  readJson,
  sessionPaths,
  transitionSession,
} from '../local-files.mjs';
import { installAntigravity } from '../install-antigravity.mjs';
import { runWorker } from '../refresh-worker.mjs';
import {
  appendDiagnosticEvent,
  buildDiagnosticEvent,
  DIAGNOSTIC_ENV_VAR,
  DIAGNOSTIC_LOG_FILE,
  diagnosticEnabled,
  display,
  hexToRgb,
  link,
  parseStatusInput,
  runStatusline,
  safeText,
  safeUrl,
  visibleDomain,
  workFor,
} from '../statusline.mjs';
import { uninstallAntigravity } from '../uninstall-antigravity.mjs';

const SESSION_A = '8da8d34a-6ad4-4a54-9ba4-4eef0a636d96';
const SESSION_B = '7103af7a-c92f-4539-bf4c-96112a2f6d42';

async function temporaryHome() {
  return mkdtemp(join(tmpdir(), 'paywait-antigravity-'));
}

async function configure(home, backend = 'http://127.0.0.1:1/api') {
  const paths = paywaitPaths(home);
  await atomicWriteJson(paths.config, { token: 'abcdefgh-token', backend });
  return paths;
}

async function withHome(run) {
  const home = await temporaryHome();
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withApi(run) {
  const requests = [];
  let adResponse = requestId => ({ type: 'init', total: '0.0000', retry_after_ms: 10_000, request_id: requestId });
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, method: request.method, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.url.startsWith('/api/ad')) {
        const requestId = new URL(request.url, 'http://local').searchParams.get('request_id');
        response.end(JSON.stringify(adResponse(requestId)));
      } else response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({
      requests,
      backend: `http://127.0.0.1:${server.address().port}/api`,
      setAdResponse: value => { adResponse = value; },
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('idle → working crée un cycle UUID', async () => withHome(async home => {
  const paths = await configure(home);
  await transitionSession(paths, SESSION_A, 'idle');
  const result = await transitionSession(paths, SESSION_A, 'working');
  assert.equal(result.active, true);
  assert.equal(result.newCycle, true);
  assert.match(result.cycleId, /^[0-9a-f-]{36}$/i);
}));

test('idle → reviewing crée un cycle UUID', async () => withHome(async home => {
  const paths = await configure(home);
  await transitionSession(paths, SESSION_A, 'idle');
  const result = await transitionSession(paths, SESSION_A, 'reviewing');
  assert.equal(result.active, true);
  assert.equal(result.newCycle, true);
  assert.match(result.cycleId, /^[0-9a-f-]{36}$/i);
}));

test('working → reviewing conserve le même cycle', async () => withHome(async home => {
  const paths = await configure(home);
  const working = await transitionSession(paths, SESSION_A, 'working');
  const reviewing = await transitionSession(paths, SESSION_A, 'reviewing');
  assert.equal(reviewing.newCycle, false);
  assert.equal(reviewing.cycleId, working.cycleId);
}));

test('les appels simultanés d’une session créent un seul cycle', async () => withHome(async home => {
  const paths = await configure(home);
  const calls = await Promise.all(Array.from({ length: 20 }, () => transitionSession(paths, SESSION_A, 'working')));
  const stored = await readJson(sessionPaths(paths, SESSION_A).state);
  assert.match(stored.cycle_id, /^[0-9a-f-]{36}$/i);
  assert.equal(new Set(calls.map(call => call.cycleId).filter(Boolean)).size, 1);
  assert.equal((await transitionSession(paths, SESSION_A, 'working')).cycleId, stored.cycle_id);
}));

test('deux sessions Antigravity ont des états séparés', async () => withHome(async home => {
  const paths = await configure(home);
  const [first, second] = await Promise.all([
    transitionSession(paths, SESSION_A, 'working'),
    transitionSession(paths, SESSION_B, 'reviewing'),
  ]);
  assert.notEqual(first.cycleId, second.cycleId);
  assert.equal((await readJson(sessionPaths(paths, SESSION_A).state)).last_state, 'working');
  assert.equal((await readJson(sessionPaths(paths, SESSION_B).state)).last_state, 'reviewing');
}));

test('deux outils concurrents obtiennent un seul refresh.lock global', async () => withHome(async home => {
  const paths = await configure(home);
  const tickets = await Promise.all([
    acquireRefreshTicket(paths), // Antigravity
    acquireRefreshTicket(paths), // Claude Code
    acquireRefreshTicket(paths), // OpenCode
  ]);
  assert.equal(tickets.filter(Boolean).length, 1);
}));

test('deux sessions avec cache expiré lancent un seul worker de refresh global', async () => withHome(async home => {
  await configure(home);
  const workers = [];
  const input = session => JSON.stringify({ session_id: session, agent_state: 'working', terminal_width: 80 });
  await Promise.all([
    runStatusline({ home, input: input(SESSION_A), spawnDetached: (_path, payload) => workers.push(payload) }),
    runStatusline({ home, input: input(SESSION_B), spawnDetached: (_path, payload) => workers.push(payload) }),
  ]);
  assert.equal(workers.filter(worker => worker.refresh).length, 1);
  assert.equal(workers.filter(worker => !worker.refresh && worker.presence).length, 1);
}));

test('verrou global périmé est récupéré', async () => withHome(async home => {
  const paths = await configure(home);
  await mkdir(paths.base, { recursive: true });
  await writeFile(paths.refreshLock, JSON.stringify({ owner: 'dead' }), { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await utimes(paths.refreshLock, old, old);
  assert.equal(await acquireRefreshTicket(paths), true);
}));

test('cache frais ne déclenche aucun worker pour un cycle déjà actif', async () => withHome(async home => {
  const paths = await configure(home);
  await atomicWriteJson(paths.response, {
    version: 1,
    token_fingerprint: 'abcdefgh',
    fresh_until: Date.now() + 10_000,
    response: { type: 'init', total: '0.0000' },
  });
  await transitionSession(paths, SESSION_A, 'working');
  let spawned = 0;
  const result = await runStatusline({
    home,
    input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80, email: 'never-used@example.test' }),
    spawnDetached: () => { spawned += 1; },
  });
  assert.equal(result.cached.fresh, true);
  assert.equal(spawned, 0);
  assert.equal(workFor({ cycleId: 'cycle', newCycle: false, cached: result.cached }).refresh, false);
}));

test('cache corrompu est ignoré sans erreur', async () => withHome(async home => {
  const paths = await configure(home);
  await mkdir(paths.base, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
  await writeFile(paths.response, '{invalide', { mode: 0o600 });
  assert.equal(await readCachedResponse(paths, 'abcdefgh-token'), undefined);
}));

test('session corrompue est remplacée sans erreur', async () => withHome(async home => {
  const paths = await configure(home);
  await mkdir(paths.sessions, { recursive: true });
  await writeFile(sessionPaths(paths, SESSION_A).state, '{invalide', { mode: 0o600 });
  const result = await transitionSession(paths, SESSION_A, 'working');
  assert.equal(result.newCycle, true);
  assert.match((await readFile(sessionPaths(paths, SESSION_A).state, 'utf8')), /"tool":"antigravity"/);
}));

test('un crash conserve et réutilise le request_id en attente', async () => withHome(async home => {
  const paths = await configure(home);
  const first = await getPendingRequest(paths, 'abcdefgh-token', 'antigravity:test:one');
  const retried = await getPendingRequest(paths, 'abcdefgh-token', 'antigravity:test:two');
  assert.equal(retried.request_id, first.request_id);
  assert.equal(retried.prompt_id, first.prompt_id);
}));

test('le worker n’envoie que les champs PayWait autorisés et écrit le cache', async () => withHome(async home => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, method: request.method, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.url.startsWith('/api/ad')) {
        response.end(JSON.stringify({ type: 'init', total: '0.0000', retry_after_ms: 10_000, request_id: new URL(request.url, 'http://local').searchParams.get('request_id') }));
      } else response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const paths = await configure(home, `http://127.0.0.1:${port}/api`);
    const cycleId = '33a8d34a-6ad4-4a54-9ba4-4eef0a636d96';
    const result = await runWorker({ session_id: SESSION_A, cycle_id: cycleId, presence: true, refresh: true, force_refresh: false }, { home });
    assert.equal(result.refreshed, true);
    assert.equal(requests.length, 2);
    const presence = requests.find(request => request.url === '/api/presence');
    const presenceBody = JSON.parse(presence.body);
    assert.deepEqual(Object.keys(presenceBody).sort(), ['prompt_id', 'session_id', 'token']);
    const adUrl = new URL(requests.find(request => request.url.startsWith('/api/ad')).url, 'http://local');
    assert.deepEqual([...adUrl.searchParams.keys()].sort(), ['prompt_id', 'request_id', 'session_id', 'token']);
    assert.equal((await readCachedResponse(paths, 'abcdefgh-token')).fresh, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}));

test('le parseur ne retient que session_id, agent_state et terminal_width', () => {
  assert.deepEqual(parseStatusInput(JSON.stringify({
    session_id: SESSION_A,
    agent_state: 'working',
    terminal_width: 81,
    email: 'private@example.test',
    transcript_path: '/private/transcript.jsonl',
    quota: { left: 1 },
    cwd: '/private',
    model: { id: 'private' },
  })), { sessionId: SESSION_A, state: 'working', terminalWidth: 81 });
});

test('installation sauvegarde statusLine, réinstallation est idempotente et désinstallation restaure', async () => withHome(async home => {
  const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const oldStatusLine = { type: 'command', command: 'node /custom/statusline.mjs', enabled: false, custom: { keep: true } };
  await atomicWriteJson(settingsPath, { theme: 'dark', statusLine: oldStatusLine, untouched: { value: 1 } });
  const sourceDirectory = resolve('extension/antigravity');
  const first = await installAntigravity({ home, sourceDirectory });
  const afterFirst = await readJson(settingsPath);
  assert.deepEqual(afterFirst.statusLine, { type: 'command', command: first.command, enabled: true });
  assert.deepEqual(afterFirst.untouched, { value: 1 });
  const second = await installAntigravity({ home, sourceDirectory });
  assert.equal(second.installed, false);
  assert.deepEqual((await readJson(settingsPath)).statusLine, afterFirst.statusLine);
  assert.deepEqual(await uninstallAntigravity({ home }), { restored: true });
  assert.deepEqual((await readJson(settingsPath)).statusLine, oldStatusLine);
}));

test('la désinstallation refuse d’écraser une statusline modifiée après installation', async () => withHome(async home => {
  const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  await atomicWriteJson(settingsPath, { statusLine: { type: 'command', command: 'node /old.mjs', enabled: true } });
  await installAntigravity({ home, sourceDirectory: resolve('extension/antigravity') });
  const settings = await readJson(settingsPath);
  settings.statusLine = { type: 'command', command: 'node /user-choice.mjs', enabled: true };
  await atomicWriteJson(settingsPath, settings);
  assert.deepEqual(await uninstallAntigravity({ home }), { restored: false, reason: 'modified' });
  assert.equal((await readJson(settingsPath)).statusLine.command, 'node /user-choice.mjs');
}));

test('idle avec cache expiré réutilise le cycle, rafraîchit puis affiche EN PAUSE', async () => withHome(async home => {
  await withApi(async ({ backend, setAdResponse }) => {
    const paths = await configure(home, backend);
    const active = await transitionSession(paths, SESSION_A, 'working');
    await transitionSession(paths, SESSION_A, 'idle');
    await atomicWriteJson(paths.response, {
      version: 1,
      token_fingerprint: 'abcdefgh',
      fresh_until: Date.now() - 1,
      response: { type: 'ad', text: 'ancienne pub' },
    });
    const workers = [];
    const idle = await runStatusline({
      home,
      input: JSON.stringify({ session_id: SESSION_A, agent_state: 'idle', terminal_width: 80 }),
      spawnDetached: (_path, payload) => workers.push(payload),
    });
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0], { session_id: SESSION_A, cycle_id: active.cycleId, presence: false, refresh: true, force_refresh: false });
    setAdResponse(requestId => ({ type: 'waiting', total: '0.1234', retry_after_ms: 10_000, request_id: requestId }));
    await runWorker(workers[0], { home });
    const paused = await runStatusline({
      home,
      input: JSON.stringify({ session_id: SESSION_A, agent_state: 'idle', terminal_width: 80 }),
      spawnDetached: () => assert.fail('un cache fresh ne doit pas déclencher de worker'),
    });
    assert.match(paused.line, /EN PAUSE/);
    assert.equal(idle.session.cycleId, active.cycleId);
  });
}));

test('démarrage initial idle reste neutre sans cycle_id ni worker', async () => withHome(async home => {
  await configure(home);
  let spawned = 0;
  const result = await runStatusline({
    home,
    input: JSON.stringify({ session_id: SESSION_A, agent_state: 'idle', terminal_width: 80 }),
    spawnDetached: () => { spawned += 1; },
  });
  assert.equal(result.session.cycleId, undefined);
  assert.equal(spawned, 0);
}));

test('deux nouveaux cycles expirés produisent un refresh et deux présences distinctes', async () => withHome(async home => {
  await withApi(async ({ backend, requests }) => {
    await configure(home, backend);
    const workers = [];
    const input = session => JSON.stringify({ session_id: session, agent_state: 'working', terminal_width: 80 });
    await Promise.all([
      runStatusline({ home, input: input(SESSION_A), spawnDetached: (_path, payload) => workers.push(payload) }),
      runStatusline({ home, input: input(SESSION_B), spawnDetached: (_path, payload) => workers.push(payload) }),
    ]);
    assert.equal(workers.filter(worker => worker.refresh).length, 1);
    assert.equal(workers.filter(worker => !worker.refresh && worker.presence).length, 1);
    await Promise.all(workers.map(worker => runWorker(worker, { home })));
    const presences = requests.filter(request => request.url === '/api/presence').map(request => JSON.parse(request.body));
    assert.equal(presences.length, 2);
    assert.equal(new Set(presences.map(body => body.session_id)).size, 2);
    assert.equal(requests.filter(request => request.url.startsWith('/api/ad')).length, 1);
  });
}));

test('un nouveau cycle qui perd refresh.lock lance un worker présence-only', async () => withHome(async home => {
  const paths = await configure(home);
  assert.equal(await acquireRefreshTicket(paths), true);
  const workers = [];
  await runStatusline({
    home,
    input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
    spawnDetached: (_path, payload) => workers.push(payload),
  });
  assert.deepEqual(workers, [{ session_id: SESSION_A, cycle_id: workers[0].cycle_id, presence: true, refresh: false, force_refresh: false }]);
}));

test('réinstallation refuse une statusline modifiée par l’utilisateur', async () => withHome(async home => {
  const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const original = { type: 'command', command: 'node /before.mjs', enabled: true };
  await atomicWriteJson(settingsPath, { statusLine: original });
  await installAntigravity({ home, sourceDirectory: resolve('extension/antigravity') });
  const settings = await readJson(settingsPath);
  settings.statusLine = { type: 'command', command: 'node /mine.mjs', enabled: true, extra: { keep: true } };
  await atomicWriteJson(settingsPath, settings);
  const reinstall = await installAntigravity({ home, sourceDirectory: resolve('extension/antigravity') });
  assert.equal(reinstall.refused, true);
  assert.match(reinstall.message, /modifiée par l’utilisateur/);
  assert.deepEqual((await readJson(settingsPath)).statusLine, settings.statusLine);
}));

test('réinstallation est autorisée si statusLine correspond à installed_statusLine', async () => withHome(async home => {
  const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  await atomicWriteJson(settingsPath, { statusLine: { type: 'command', command: 'node /before.mjs', enabled: true } });
  const first = await installAntigravity({ home, sourceDirectory: resolve('extension/antigravity') });
  const second = await installAntigravity({ home, sourceDirectory: resolve('extension/antigravity') });
  assert.equal(first.refused, false);
  assert.equal(second.refused, false);
  assert.equal(second.installed, false);
  assert.equal((await readJson(settingsPath)).statusLine.command, first.command);
}));

test('HOME contenant des espaces produit une commande citée et reste désinstallable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'paywait antigravity-'));
  try {
    const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
    await atomicWriteJson(settingsPath, { statusLine: { type: 'command', command: 'node /before.mjs', enabled: true } });
    const install = await installAntigravity({ home, sourceDirectory: resolve('extension/antigravity') });
    assert.match(install.command, /^node '\/.*paywait antigravity-.*\/\.paywait\/antigravity\/statusline\.mjs'$/);
    assert.equal((await readJson(settingsPath)).statusLine.command, install.command);
    assert.equal((await uninstallAntigravity({ home })).restored, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('nettoyage Antigravity retire les artefacts anciens sans toucher aux autres sessions', async () => withHome(async home => {
  const paths = await configure(home);
  await mkdir(paths.sessions, { recursive: true });
  const oldSession = sessionPaths(paths, SESSION_A).state;
  const recentSession = sessionPaths(paths, SESSION_B).state;
  const oldLock = sessionPaths(paths, SESSION_A).lock;
  const oldStale = `${oldLock}.stale.dead`;
  const oldTemp = `${oldSession}.123.dead.tmp`;
  const claudeSession = join(paths.sessions, `${SESSION_A}.json`);
  const openCodeSession = join(paths.sessions, 'opencode-session.json');
  const refreshStale = `${paths.refreshLock}.stale.antigravity.dead`;
  const old = new Date(Date.now() - 20 * 60_000);
  for (const path of [oldSession, oldLock, oldStale, oldTemp, claudeSession, openCodeSession, refreshStale]) {
    await writeFile(path, '{}', { mode: 0o600 });
    await utimes(path, old, old);
  }
  await writeFile(recentSession, '{}', { mode: 0o600 });
  const results = await Promise.all([
    cleanupAntigravityArtifacts(paths),
    cleanupAntigravityArtifacts(paths),
  ]);
  assert.equal(results.filter(result => result.ran).length, 1);
  assert.equal(await readJson(oldSession), undefined);
  assert.equal(await readJson(oldLock), undefined);
  assert.equal(await readJson(oldStale), undefined);
  assert.equal(await readJson(oldTemp), undefined);
  assert.equal(await readJson(refreshStale), undefined);
  assert.deepEqual(await readJson(recentSession), {});
  assert.deepEqual(await readJson(claudeSession), {});
  assert.deepEqual(await readJson(openCodeSession), {});
}));

test('parcours complet idle → working → reviewing → idle → waiting', async () => withHome(async home => {
  await withApi(async ({ backend, setAdResponse }) => {
    const paths = await configure(home, backend);
    await transitionSession(paths, SESSION_A, 'idle');
    const working = await transitionSession(paths, SESSION_A, 'working');
    const reviewing = await transitionSession(paths, SESSION_A, 'reviewing');
    assert.equal(reviewing.cycleId, working.cycleId);
    await transitionSession(paths, SESSION_A, 'idle');
    await atomicWriteJson(paths.response, {
      version: 1, token_fingerprint: 'abcdefgh', fresh_until: Date.now() - 1, response: { type: 'ad' },
    });
    const workers = [];
    await runStatusline({
      home,
      input: JSON.stringify({ session_id: SESSION_A, agent_state: 'idle', terminal_width: 80 }),
      spawnDetached: (_path, payload) => workers.push(payload),
    });
    setAdResponse(requestId => ({ type: 'waiting', total: '0.0000', retry_after_ms: 10_000, request_id: requestId }));
    await runWorker(workers[0], { home });
    const rendered = await runStatusline({
      home,
      input: JSON.stringify({ session_id: SESSION_A, agent_state: 'idle', terminal_width: 80 }),
      spawnDetached: () => assert.fail('cache fresh'),
    });
    assert.match(rendered.line, /EN PAUSE/);
  });
}));

test('cache waiting frais + idle → working force présence et refresh', async () => withHome(async home => {
  const paths = await configure(home);
  await atomicWriteJson(paths.response, {
    version: 1,
    token_fingerprint: 'abcdefgh',
    fresh_until: Date.now() + 60_000,
    response: { type: 'waiting', total: '0.0000' },
  });
  await transitionSession(paths, SESSION_A, 'idle');
  const workers = [];
  await runStatusline({
    home,
    input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
    spawnDetached: (_path, payload) => workers.push(payload),
  });
  assert.deepEqual(workers, [{
    session_id: SESSION_A,
    cycle_id: workers[0].cycle_id,
    presence: true,
    refresh: true,
    force_refresh: true,
  }]);
}));

test('le worker termine /presence avant de lancer /api/ad', async () => withHome(async home => {
  const order = [];
  let presenceCompleted = false;
  const server = createServer((request, response) => {
    if (request.url === '/api/presence') {
      order.push('presence-start');
      setTimeout(() => {
        presenceCompleted = true;
        order.push('presence-end');
        response.end(JSON.stringify({ ok: true }));
      }, 30);
      return;
    }
    order.push('ad');
    assert.equal(presenceCompleted, true);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ type: 'ad', retry_after_ms: 10_000, request_id: new URL(request.url, 'http://local').searchParams.get('request_id') }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const paths = await configure(home, `http://127.0.0.1:${server.address().port}/api`);
    await runWorker({
      session_id: SESSION_A,
      cycle_id: '43a8d34a-6ad4-4a54-9ba4-4eef0a636d96',
      presence: true,
      refresh: true,
      force_refresh: true,
    }, { home });
    assert.deepEqual(order, ['presence-start', 'presence-end', 'ad']);
    assert.equal((await readCachedResponse(paths, 'abcdefgh-token')).response.type, 'ad');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}));

test('cache ad frais + nouveau cycle envoie une présence sans nouvel /api/ad', async () => withHome(async home => {
  await withApi(async ({ backend, requests }) => {
    const paths = await configure(home, backend);
    await atomicWriteJson(paths.response, {
      version: 1,
      token_fingerprint: 'abcdefgh',
      fresh_until: Date.now() + 60_000,
      response: { type: 'ad', text: 'partagée' },
    });
    const workers = [];
    await runStatusline({
      home,
      input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
      spawnDetached: (_path, payload) => workers.push(payload),
    });
    assert.equal(workers.length, 1);
    assert.equal(workers[0].refresh, false);
    assert.equal(workers[0].presence, true);
    assert.equal(workers[0].force_refresh, false);
    await runWorker(workers[0], { home });
    assert.equal(requests.filter(request => request.url === '/api/presence').length, 1);
    assert.equal(requests.filter(request => request.url.startsWith('/api/ad')).length, 0);
  });
}));

test('deux fenêtres avec cache waiting frais envoient deux présences et un seul /api/ad forcé', async () => withHome(async home => {
  await withApi(async ({ backend, requests }) => {
    const paths = await configure(home, backend);
    await atomicWriteJson(paths.response, {
      version: 1,
      token_fingerprint: 'abcdefgh',
      fresh_until: Date.now() + 60_000,
      response: { type: 'waiting', total: '0.0000' },
    });
    const workers = [];
    const input = session => JSON.stringify({ session_id: session, agent_state: 'working', terminal_width: 80 });
    await Promise.all([
      runStatusline({ home, input: input(SESSION_A), spawnDetached: (_path, payload) => workers.push(payload) }),
      runStatusline({ home, input: input(SESSION_B), spawnDetached: (_path, payload) => workers.push(payload) }),
    ]);
    assert.equal(workers.filter(worker => worker.refresh).length, 1);
    assert.equal(workers.find(worker => worker.refresh).force_refresh, true);
    assert.equal(workers.filter(worker => !worker.refresh && worker.presence).length, 1);
    await Promise.all(workers.map(worker => runWorker(worker, { home })));
    assert.equal(requests.filter(request => request.url === '/api/presence').length, 2);
    assert.equal(requests.filter(request => request.url.startsWith('/api/ad')).length, 1);
  });
}));

test('échec de /presence ne bloque pas le refresh forcé', async () => withHome(async home => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/presence') {
      response.statusCode = 503;
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.end(JSON.stringify({ type: 'ad', retry_after_ms: 10_000, request_id: new URL(request.url, 'http://local').searchParams.get('request_id') }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await configure(home, `http://127.0.0.1:${server.address().port}/api`);
    const result = await runWorker({
      session_id: SESSION_A,
      cycle_id: '53a8d34a-6ad4-4a54-9ba4-4eef0a636d96',
      presence: true,
      refresh: true,
      force_refresh: true,
    }, { home });
    assert.equal(result.refreshed, true);
    assert.deepEqual(requests, ['/api/presence', requests[1]]);
    assert.match(requests[1], /^\/api\/ad\?/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}));

test('premier refresh forcé remplace waiting par une publicité sans attendre fresh_until', async () => withHome(async home => {
  await withApi(async ({ backend, setAdResponse }) => {
    const paths = await configure(home, backend);
    await atomicWriteJson(paths.response, {
      version: 1,
      token_fingerprint: 'abcdefgh',
      fresh_until: Date.now() + 60_000,
      response: { type: 'waiting', total: '0.0000' },
    });
    setAdResponse(requestId => ({ type: 'ad', brand_name: 'Rapide', text: 'disponible', retry_after_ms: 10_000, request_id: requestId }));
    const workers = [];
    await runStatusline({
      home,
      input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
      spawnDetached: (_path, payload) => workers.push(payload),
    });
    await runWorker(workers[0], { home });
    const rendered = await runStatusline({
      home,
      input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
      spawnDetached: () => assert.fail('cache ad fresh'),
    });
    assert.match(rendered.line, /SPONSORED/);
  });
}));

test('#FF5500 produit la séquence RGB attendue', () => {
  assert.equal(hexToRgb('#FF5500'), '255;85;0');
});

test('une couleur invalide ou absente retombe sur blanc', () => {
  assert.equal(hexToRgb('not-a-color'), '255;255;255');
  assert.equal(hexToRgb(undefined), '255;255;255');
  assert.equal(hexToRgb('FF5500'), '255;255;255');
});

test('brand_name et text utilisent la couleur personnalisée et le badge SPONSORED reste fixe', () => {
  const line = display({
    type: 'ad',
    color: '#FF5500',
    brand_name: 'Acme',
    text: 'Promo',
    url_display: 'acme.test',
    url_real: 'https://acme.test',
    earnings: '0,005',
    total: '4,32',
  });
  assert.match(line, /\x1b\[1;38;2;255;85;0m Acme /);
  assert.match(line, /\x1b\[38;2;255;85;0mPromo /);
  assert.match(line, /48;2;245;158;11m SPONSORED /);
});

test('une URL HTTPS valide produit une séquence OSC 8 complète', () => {
  const line = display({
    type: 'ad',
    brand_name: 'Acme',
    text: 'Promo',
    url_display: 'acme.test',
    url_real: 'https://acme.test',
  });
  assert.match(line, /\x1b\]8;;https:\/\/acme\.test\/\x1b\\↗ acme\.test\x1b\]8;;\x1b\\/);
});

test('une URL HTTP valide est acceptée', () => {
  const line = display({
    type: 'ad',
    url_display: 'acme.test',
    url_real: 'http://acme.test',
  });
  assert.match(line, /\x1b\]8;;http:\/\/acme\.test\/\x1b\\/);
});

test('javascript:, data:, file: et mailto: sont refusés', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'mailto:x@y.test']) {
    assert.equal(safeUrl(url), '', url);
  }
});

test('une URL invalide reste visible comme texte sans devenir cliquable', () => {
  const line = display({
    type: 'ad',
    brand_name: 'Acme',
    url_display: 'acme.test',
    url_real: 'not a url',
  });
  assert.doesNotMatch(line, /\x1b\]8;;/);
  assert.match(line, /↗ acme\.test/);
});

test('domaine de secours affiché quand url_display est absent', () => {
  const line = display({
    type: 'ad',
    brand_name: 'Acme',
    url_real: 'https://sub.acme.test/path',
  });
  assert.match(line, /↗ sub\.acme\.test/);
  assert.equal(visibleDomain('https://www.acme.test'), 'acme.test');
});

test('les caractères de contrôle sont supprimés des champs dynamiques', () => {
  assert.equal(safeText('A\x1bB\x07C\nD\x7fE'), 'ABCDE');
});

test('une tentative d’injection OSC dans les champs dynamiques ne produit aucune séquence supplémentaire', () => {
  const line = display({
    type: 'ad',
    brand_name: 'Acme\x1b]8;;https://evil.test\x1b\\INJECT\x1b]8;;\x1b\\',
    text: 'Promo\x1b]8;;https://evil2.test\x07',
    url_display: 'acme.test\x1b]8;;https://evil3.test\x1b\\',
    url_real: 'https://acme.test',
  });
  assert.equal((line.match(/\x1b\]8;;/g) || []).length, 2);
});

test('la sortie se termine avec un reset ANSI et aucun lien OSC 8 ouvert', () => {
  const withLink = display({ type: 'ad', brand_name: 'Acme', url_real: 'https://acme.test', url_display: 'acme.test' });
  assert.ok(withLink.endsWith('\x1b[0m'));
  assert.equal((withLink.match(/\x1b\]8;;/g) || []).length, 2);
  const withoutLink = display({ type: 'ad', brand_name: 'Acme', url_real: 'not a url' });
  assert.ok(withoutLink.endsWith('\x1b[0m'));
  assert.equal((withoutLink.match(/\x1b\]8;;/g) || []).length, 0);
});

test('les types waiting, init, welcome et error restent correctement affichés', () => {
  assert.match(display({ type: 'init' }), /PAYWAIT/);
  assert.match(display({ type: 'waiting', total: '1.23' }), /EN PAUSE/);
  assert.match(display({ type: 'error', text: 'oops' }), /ERREUR/);
  assert.equal(display({ type: 'welcome' }), 'PayWait');
});

test('link() ne produit aucune séquence sans URL', () => {
  assert.equal(link('', 'texte'), 'texte');
  assert.equal(link(undefined, 'texte'), 'texte');
});

test('le diagnostic est désactivé par défaut', () => {
  assert.equal(diagnosticEnabled({}), false);
  assert.equal(diagnosticEnabled({ [DIAGNOSTIC_ENV_VAR]: '0' }), false);
  assert.equal(diagnosticEnabled({ [DIAGNOSTIC_ENV_VAR]: '1' }), true);
});

test('buildDiagnosticEvent ne contient que les champs autorisés', () => {
  const event = buildDiagnosticEvent({
    sessionId: SESSION_A,
    agentState: 'working',
    session: { newCycle: true, active: true, cycleId: 'cycle-1' },
    work: { forceRefresh: true },
    cached: { response: { type: 'waiting' }, fresh: false },
    lockAcquired: true,
    workerKind: 'refresh',
    now: 0,
  });
  assert.deepEqual(Object.keys(event).sort(), [
    'agent_state',
    'cache_fresh',
    'cache_type',
    'cycle_id',
    'force_refresh',
    'refresh_lock',
    'session_id',
    'timestamp',
    'transition',
    'worker_launched',
  ]);
  for (const forbidden of ['prompt', 'email', 'cwd', 'transcript', 'transcript_path', 'model', 'token', 'quota', 'brand_name', 'text', 'url_real', 'url_display']) {
    assert.equal(Object.prototype.hasOwnProperty.call(event, forbidden), false, forbidden);
  }
  assert.equal(event.session_id, SESSION_A);
  assert.equal(event.agent_state, 'working');
  assert.equal(event.transition, 'new_cycle');
  assert.equal(event.cycle_id, 'cycle-1');
  assert.equal(event.force_refresh, true);
  assert.equal(event.cache_type, 'waiting');
  assert.equal(event.cache_fresh, false);
  assert.equal(event.refresh_lock, true);
  assert.equal(event.worker_launched, 'refresh');
});

test('runStatusline n’écrit aucun journal de diagnostic quand la variable n’est pas activée', async () => withHome(async home => {
  const paths = await configure(home);
  await runStatusline({
    home,
    input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
    spawnDetached: () => {},
    env: {},
  });
  await assert.rejects(readFile(join(paths.base, DIAGNOSTIC_LOG_FILE), 'utf8'));
}));

test('runStatusline journalise un événement complet quand le diagnostic est activé', async () => withHome(async home => {
  const paths = await configure(home);
  await runStatusline({
    home,
    input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
    spawnDetached: () => {},
    env: { [DIAGNOSTIC_ENV_VAR]: '1' },
  });
  const lines = (await readFile(join(paths.base, DIAGNOSTIC_LOG_FILE), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.session_id, SESSION_A);
  assert.equal(event.agent_state, 'working');
  assert.equal(event.transition, 'new_cycle');
  assert.match(event.cycle_id, /^[0-9a-f-]{36}$/i);
  assert.equal(event.force_refresh, true);
  assert.equal(event.cache_type, null);
  assert.equal(event.cache_fresh, null);
  assert.equal(event.refresh_lock, true);
  assert.equal(event.worker_launched, 'refresh');
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
}));

test('diagnostic : un nouveau cycle Antigravity avec cache "ad" frais d’un autre outil ne déclenche ni verrou ni refresh', async () => withHome(async home => {
  const paths = await configure(home);
  await atomicWriteJson(paths.response, {
    version: 1,
    token_fingerprint: 'abcdefgh',
    owner_session_id: 'un-autre-outil',
    fresh_until: Date.now() + 60_000,
    response: { type: 'ad', brand_name: 'AutreOutil' },
  });
  await runStatusline({
    home,
    input: JSON.stringify({ session_id: SESSION_A, agent_state: 'working', terminal_width: 80 }),
    spawnDetached: () => {},
    env: { [DIAGNOSTIC_ENV_VAR]: '1' },
  });
  const lines = (await readFile(join(paths.base, DIAGNOSTIC_LOG_FILE), 'utf8')).trim().split('\n');
  const event = JSON.parse(lines[0]);
  assert.equal(event.transition, 'new_cycle');
  assert.equal(event.cache_type, 'ad');
  assert.equal(event.cache_fresh, true);
  assert.equal(event.force_refresh, false);
  assert.equal(event.refresh_lock, null);
  assert.equal(event.worker_launched, 'presence');
}));
