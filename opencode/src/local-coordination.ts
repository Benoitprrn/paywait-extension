import { open, rename, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { paths } from "./local-files.js"

const lease = 3_500

export async function acquireRefreshTicket(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(paths.refreshLock, "wx", 0o600)
      const now = Date.now()
      await file.writeFile(JSON.stringify({ owner: randomUUID(), started_at: now, expires_at: now + lease }))
      await file.close()
      return true
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
      try {
        if (Date.now() - (await stat(paths.refreshLock)).mtimeMs <= lease) return false
        await rename(paths.refreshLock, `${paths.refreshLock}.stale.${randomUUID()}`)
      } catch (stale: any) {
        if (stale?.code !== "ENOENT") throw stale
      }
    }
  }
  return false
}
