import { mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Agencement à plat : ce script, tui.js et package.json sont téléchargés
// directement dans ~/.paywait/opencode/ par install.sh, donc le dossier
// contenant ce fichier EST déjà le plugin à enregistrer — rien à copier.
const target = resolve(dirname(new URL(import.meta.url).pathname))
await mkdir(target, { recursive: true, mode: 0o700 })
const result = spawnSync("opencode", ["plugin", pathToFileURL(target).href, "--global"], { stdio: "inherit" })
process.exit(result.status ?? 1)
