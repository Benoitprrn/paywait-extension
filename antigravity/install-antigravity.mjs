import { cp, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteJson, readJson } from './local-files.mjs';

function pathsFor(home) {
  const paywait = join(home, '.paywait');
  return {
    source: dirname(fileURLToPath(import.meta.url)),
    target: join(paywait, 'antigravity'),
    settings: join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    state: join(paywait, 'antigravity-install-state.json'),
  };
}

function configuredStatusLine(command) {
  return { type: 'command', command, enabled: true };
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

export async function installAntigravity({ home = process.env.HOME, sourceDirectory } = {}) {
  if (!home) throw new Error('HOME manquant');
  const paths = pathsFor(home);
  const source = sourceDirectory ? resolve(sourceDirectory) : paths.source;
  const settings = await readJson(paths.settings);
  if (settings === undefined) {
    // A malformed existing file must never be silently replaced.
    const exists = await stat(paths.settings).then(() => true).catch(error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new Error('settings.json Antigravity invalide');
  }
  const nextSettings = settings ?? {};
  if (!nextSettings || Array.isArray(nextSettings) || typeof nextSettings !== 'object') {
    throw new Error('settings.json Antigravity invalide');
  }

  const target = paths.target;
  const command = `node ${shellQuote(join(target, 'statusline.mjs'))}`;
  const desired = configuredStatusLine(command);
  const saved = await readJson(paths.state);
  const currentIsPaywait = sameJson(nextSettings.statusLine, desired);
  const currentMatchesSaved = Boolean(saved?.installed_statusLine) && sameJson(nextSettings.statusLine, saved.installed_statusLine);

  if (saved && !currentIsPaywait && !currentMatchesSaved) {
    return {
      command,
      installed: false,
      refused: true,
      message: 'Statusline Antigravity modifiée par l’utilisateur : installation PayWait non appliquée.',
      settingsPath: paths.settings,
    };
  }

  await mkdir(target, { recursive: true, mode: 0o700 });
  if (source !== resolve(target)) {
    for (const name of ['statusline.mjs', 'refresh-worker.mjs', 'local-files.mjs']) {
      await cp(join(source, name), join(target, name), { force: true });
    }
  }

  if (!currentIsPaywait && !saved) {
    await atomicWriteJson(paths.state, {
      version: 1,
      settings_path: paths.settings,
      had_statusLine: Object.prototype.hasOwnProperty.call(nextSettings, 'statusLine'),
      previous_statusLine: nextSettings.statusLine ?? null,
      installed_statusLine: desired,
    });
  }

  if (!currentIsPaywait) {
    nextSettings.statusLine = desired;
    await atomicWriteJson(paths.settings, nextSettings);
  }

  if (saved && !sameJson(saved.installed_statusLine, desired)) {
    await atomicWriteJson(paths.state, { ...saved, installed_statusLine: desired });
  }
  return { command, installed: !currentIsPaywait, refused: false, settingsPath: paths.settings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installAntigravity().then(
    ({ installed, refused, message }) => {
      process.stdout.write(refused ? `${message}\n` : installed ? 'Antigravity PayWait installé.\n' : 'Antigravity PayWait déjà installé.\n');
      if (refused) process.exitCode = 2;
    },
    error => { process.stderr.write(`Installation Antigravity ignorée: ${error.message}\n`); process.exitCode = 1; },
  );
}
