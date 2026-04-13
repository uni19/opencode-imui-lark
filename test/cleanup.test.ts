import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { cleanupDir } from "../src/storage/cleanup.ts"

async function touch(file: string, size: number, mtimeMs: number) {
  await writeFile(file, "x".repeat(size))
  const when = new Date(mtimeMs)
  await utimes(file, when, when)
}

describe("cleanupDir", () => {
  test("drops stale files by ttl", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-feishu-cleanup-"))
    const now = Date.now()

    try {
      await touch(path.join(root, "old.txt"), 3, now - 10_000)
      await touch(path.join(root, "fresh.txt"), 5, now - 1_000)

      const out = await cleanupDir(root, {
        ttl_ms: 5_000,
        now,
      })

      expect(out.removed).toBe(1)
      expect(out.freed_bytes).toBe(3)
      expect(await stat(path.join(root, "fresh.txt")).then((row) => row.size)).toBe(5)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("trims oldest cold files when size exceeds limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-feishu-cleanup-"))
    const now = Date.now()

    try {
      await touch(path.join(root, "a.bin"), 6, now - 30_000)
      await touch(path.join(root, "b.bin"), 6, now - 20_000)
      await touch(path.join(root, "fresh.bin"), 6, now - 500)

      const out = await cleanupDir(root, {
        max_bytes: 10,
        protect_ms: 5_000,
        now,
      })

      expect(out.removed).toBe(2)
      expect(out.kept_bytes).toBe(6)
      expect(await stat(path.join(root, "fresh.bin")).then((row) => row.size)).toBe(6)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
