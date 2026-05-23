/// <reference types="bun-types" />
import { afterEach, expect, test } from "bun:test"
import { cfg } from "../src/app/cfg.ts"

const env0 = { ...process.env }

afterEach(() => {
  const keys = new Set([...Object.keys(process.env), ...Object.keys(env0)])
  for (const key of keys) {
    const val = env0[key]
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
})

test("cfg normalizes blank opencode workspace env to undefined", () => {
  process.env.OPENCODE_WORKSPACE = "   "
  expect(cfg().opencode.workspace).toBeUndefined()
})

test("cfg preserves non-empty opencode workspace env", () => {
  process.env.OPENCODE_WORKSPACE = "wrk_demo"
  expect(cfg().opencode.workspace).toBe("wrk_demo")
})

test("cfg normalizes invalid opencode workspace env to undefined", () => {
  process.env.OPENCODE_WORKSPACE = " ws_bad "
  expect(cfg().opencode.workspace).toBeUndefined()
})
