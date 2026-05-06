import { describe, expect, test } from "bun:test"
import { parseCmd } from "../src/gateway/cmd.ts"

describe("parseCmd", () => {
  test("parses repo scope and workspace", () => {
    expect(parseCmd("/repo --chat /tmp/demo --workspace ws_local")).toEqual({
      name: "repo",
      scope: "chat",
      arg: "/tmp/demo",
      workspace: "ws_local",
      workspace_present: true,
    })
  })

  test("records whether repo workspace flag was explicitly present", () => {
    expect(parseCmd("/repo /tmp/demo")).toEqual({
      name: "repo",
      scope: "session",
      arg: "/tmp/demo",
      workspace: undefined,
      workspace_present: false,
    })
    expect(parseCmd("/repo /tmp/demo --workspace")).toEqual({
      name: "repo",
      scope: "session",
      arg: "/tmp/demo",
      workspace: undefined,
      workspace_present: true,
    })
    expect(parseCmd("/repo --workspace --chat /tmp/demo")).toEqual({
      name: "repo",
      scope: "chat",
      arg: "/tmp/demo",
      workspace: undefined,
      workspace_present: true,
    })
  })

  test("parses model reset", () => {
    expect(parseCmd("/model reset")).toEqual({
      name: "model",
      arg: "reset",
    })
  })

  test("parses repo workspace without directory", () => {
    expect(parseCmd("/repo --workspace ws_local")).toEqual({
      name: "repo",
      scope: "session",
      arg: undefined,
      workspace: "ws_local",
      workspace_present: true,
    })
  })

  test("parses session and status commands", () => {
    expect(parseCmd("/session ses_123")).toEqual({
      name: "session",
      arg: "ses_123",
    })
    expect(parseCmd("/status")).toEqual({
      name: "status",
    })
  })

  test("parses new, sessions, and workspaces commands", () => {
    expect(parseCmd("/new")).toEqual({
      name: "new",
    })
    expect(parseCmd("/sessions")).toEqual({
      name: "sessions",
    })
    expect(parseCmd("/workspaces")).toEqual({
      name: "workspaces",
    })
  })

  test("parses user repo scope with workspace", () => {
    expect(parseCmd("/repo --me /tmp/me --workspace ws_me")).toEqual({
      name: "repo",
      scope: "user",
      arg: "/tmp/me",
      workspace: "ws_me",
      workspace_present: true,
    })
  })

  test("parses model target", () => {
    expect(parseCmd("/model openai/gpt-5.4")).toEqual({
      name: "model",
      arg: "openai/gpt-5.4",
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
