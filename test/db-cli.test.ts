import { describe, expect, test } from "bun:test"
import { parseArgs } from "../src/release/db.ts"

describe("release db cli", () => {
  test("parses backup args and ignores env-file passthrough", () => {
    expect(parseArgs(["node", "db", "backup", "--env-file", "/tmp/imui.env", "--db=/tmp/a.sqlite", "--out", "/tmp/b.sqlite"])).toEqual({
      command: "backup",
      db: "/tmp/a.sqlite",
      out: "/tmp/b.sqlite",
    })
  })
})
