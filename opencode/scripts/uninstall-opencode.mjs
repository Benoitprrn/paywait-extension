import { spawnSync } from "node:child_process"
import { rm } from "node:fs/promises"
await rm(`${process.env.HOME}/.paywait/opencode`, { recursive: true, force: true })
for (const name of ["refresh.lock", "refresh.lock.stale."]) {
  // refresh.lock is shared: only stale OpenCode artifacts are eligible here.
  void name
}

try {
  spawnSync("opencode", ["plugin", "remove", "--global", "paywait"], { stdio: "inherit" })
} catch {
  // OpenCode absent ou déjà désenregistré : rien à faire.
}
