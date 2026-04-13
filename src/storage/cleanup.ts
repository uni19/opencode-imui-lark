import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"

type CleanupOptions = {
  ttl_ms?: number
  max_bytes?: number
  protect_ms?: number
  now?: number
}

type Entry = {
  path: string
  size: number
  mtimeMs: number
}

export type CleanupResult = {
  root: string
  removed: number
  freed_bytes: number
  kept_bytes: number
}

async function walk(root: string): Promise<Entry[]> {
  const out: Entry[] = []

  async function read(dir: string): Promise<void> {
    let list
    try {
      list = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const item of list) {
      const file = path.join(dir, item.name)
      if (item.isDirectory()) {
        await read(file)
        continue
      }
      if (!item.isFile()) continue
      const meta = await stat(file).catch(() => null)
      if (!meta) continue
      out.push({
        path: file,
        size: meta.size,
        mtimeMs: meta.mtimeMs,
      })
    }
  }

  await read(root)
  return out
}

async function drop(list: Entry[]) {
  let freed = 0
  for (const item of list) {
    await rm(item.path, { force: true }).catch(() => undefined)
    freed += item.size
  }
  return freed
}

export async function cleanupDir(root: string, input: CleanupOptions = {}): Promise<CleanupResult> {
  const ttl_ms = input.ttl_ms ?? 0
  const max_bytes = input.max_bytes ?? 0
  const protect_ms = input.protect_ms ?? 24 * 60 * 60 * 1000
  const now = input.now ?? Date.now()
  const files = await walk(root)
  let freed = 0
  let removed = 0
  let keep = files

  if (ttl_ms > 0) {
    const stale = keep.filter((item) => now - item.mtimeMs > ttl_ms)
    if (stale.length > 0) {
      freed += await drop(stale)
      removed += stale.length
      const gone = new Set(stale.map((item) => item.path))
      keep = keep.filter((item) => !gone.has(item.path))
    }
  }

  let total = keep.reduce((sum, item) => sum + item.size, 0)
  if (max_bytes > 0 && total > max_bytes) {
    const cold = keep.filter((item) => now - item.mtimeMs > protect_ms).sort((a, b) => a.mtimeMs - b.mtimeMs)
    const trim: Entry[] = []
    for (const item of cold) {
      if (total <= max_bytes) break
      trim.push(item)
      total -= item.size
    }
    if (trim.length > 0) {
      freed += await drop(trim)
      removed += trim.length
      const gone = new Set(trim.map((item) => item.path))
      keep = keep.filter((item) => !gone.has(item.path))
    }
  }

  return {
    root,
    removed,
    freed_bytes: freed,
    kept_bytes: keep.reduce((sum, item) => sum + item.size, 0),
  }
}
