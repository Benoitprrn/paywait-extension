import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteJson, readJson } from './local-files.mjs';

function pathsFor(home) {
  const paywait = join(home, '.paywait');
  return {
    settings: join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    state: join(paywait, 'antigravity-install-state.json'),
  };
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

export async function uninstallAntigravity({ home = process.env.HOME } = {}) {
  if (!home) throw new Error('HOME manquant');
  const paths = pathsFor(home);
  const saved = await readJson(paths.state);
  if (!saved || saved.version !== 1 || !saved.installed_statusLine) return { restored: false, reason: 'no-state' };

  const settings = await readJson(paths.settings);
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
    return { restored: false, reason: 'settings-invalid' };
  }
  if (!sameJson(settings.statusLine, saved.installed_statusLine)) {
    return { restored: false, reason: 'modified' };
  }

  if (saved.had_statusLine) settings.statusLine = saved.previous_statusLine;
  else delete settings.statusLine;
  await atomicWriteJson(paths.settings, settings);
  await rm(paths.state, { force: true });
  return { restored: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  uninstallAntigravity().then(
    result => process.stdout.write(result.restored ? 'Statusline Antigravity restaurée.\n' : `Statusline Antigravity non modifiée (${result.reason}).\n`),
    error => { process.stderr.write(`Restauration Antigravity ignorée: ${error.message}\n`); process.exitCode = 1; },
  );
}
