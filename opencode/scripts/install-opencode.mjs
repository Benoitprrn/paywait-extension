import { cp, mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const source = resolve(dirname(new URL(import.meta.url).pathname), "..")
const target = `${process.env.HOME}/.paywait/opencode`
await mkdir(target, { recursive: true, mode: 0o700 })
await cp(source, target, { recursive: true, force: true })
const result = spawnSync("opencode", ["plugin", pathToFileURL(target).href, "--global"], { stdio: "inherit" })
process.exit(result.status ?? 1)
