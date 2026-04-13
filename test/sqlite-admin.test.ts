import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import path from "node:path"
import { Database } from "bun:sqlite"
import { DB_SCHEMA_VERSION, backupSqlite, openSqlite, version } from "../src/storage/admin.ts"

function file(name: string) {
  return path.join("/tmp", `opencode-feishu-imui-${name}-${crypto.randomUUID()}.sqlite`)
}

describe("sqlite admin", () => {
  test("opens database and applies schema version", () => {
    const db = openSqlite(file("main"))

    try {
      expect(version(db)).toBe(DB_SCHEMA_VERSION)
      db.exec("insert into seen_event (key, created_at) values ('evt_1', 1)")
      expect(db.query("select count(*) as count from seen_event").get()).toEqual({
        count: 1,
      })
    } finally {
      db.close(false)
    }
  })

  test("backs up sqlite database with contents", async () => {
    const src = file("src")
    const out = file("backup")
    const db = openSqlite(src)

    try {
      db.exec("insert into seen_event (key, created_at) values ('evt_2', 2)")
    } finally {
      db.close(false)
    }

    await backupSqlite(src, out)

    const copy = new Database(out, { readonly: true, strict: true })
    try {
      expect(copy.query("select count(*) as count from seen_event").get()).toEqual({
        count: 1,
      })
      expect(version(copy)).toBe(DB_SCHEMA_VERSION)
    } finally {
      copy.close(false)
    }
  })
})
