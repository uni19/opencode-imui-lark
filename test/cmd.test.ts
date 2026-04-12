import { describe, expect, test } from "bun:test"
import { parseCmd } from "../src/gateway/cmd.ts"

describe("parseCmd", () => {
  test("parses repo scope and workspace", () => {
    expect(parseCmd("/repo --chat /tmp/demo --workspace ws_local")).toEqual({
      name: "repo",
      scope: "chat",
      arg: "/tmp/demo",
      workspace: "ws_local",
    })
  })

  test("parses model reset", () => {
    expect(parseCmd("/model reset")).toEqual({
      name: "model",
      arg: "reset",
    })
  })

  test("falls through to slash forwarding", () => {
    expect(parseCmd("/init hello world")).toEqual({
      name: "slash",
      command: "init",
      arguments: "hello world",
    })
  })
})
