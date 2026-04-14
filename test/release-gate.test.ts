import { describe, expect, test } from "bun:test"
import { gate } from "../src/release/gate.ts"

describe("release gate", () => {
  test("builds default release gate command list", () => {
    expect(gate()).toEqual([
      ["bun", "test"],
      ["bun", "run", "typecheck"],
      ["bun", "run", "release:doctor"],
      ["bun", "run", "release:check"],
      ["bun", "run", "db:migrate"],
      ["bun", "run", "db:backup"],
      ["bun", "run", "release:build"],
      ["bun", "run", "release:smoke"],
    ])
  })

  test("passes through extra args to doctor and db commands", () => {
    expect(gate(["--env-file", "/tmp/imui.env"])).toEqual([
      ["bun", "test"],
      ["bun", "run", "typecheck"],
      ["bun", "run", "release:doctor", "--", "--env-file", "/tmp/imui.env"],
      ["bun", "run", "release:check"],
      ["bun", "run", "db:migrate", "--", "--env-file", "/tmp/imui.env"],
      ["bun", "run", "db:backup", "--", "--env-file", "/tmp/imui.env"],
      ["bun", "run", "release:build"],
      ["bun", "run", "release:smoke"],
    ])
  })
})
