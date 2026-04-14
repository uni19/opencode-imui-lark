import { describe, expect, test } from "bun:test"
import path from "node:path"
import { defaultArtifact, parseArgs, serviceFile, serviceManager } from "../src/release/smoke.ts"

describe("release smoke", () => {
  test("parses release smoke args", () => {
    expect(parseArgs(["node", "app"])).toEqual({
      artifact: undefined,
      outdir: "dist/release",
    })

    expect(parseArgs(["node", "app", "--artifact", "dist/release/a.tar.gz", "--outdir=tmp/release"])).toEqual({
      artifact: "dist/release/a.tar.gz",
      outdir: "tmp/release",
    })
  })

  test("maps service manager and file by platform", () => {
    expect(serviceManager("darwin")).toBe("launchd")
    expect(serviceManager("linux")).toBe("systemd")
    expect(serviceFile("/tmp/demo", "darwin")).toBe(path.join("/tmp/demo", "Library", "LaunchAgents", "com.opencode-feishu-imui.plist"))
    expect(serviceFile("/tmp/demo", "linux")).toBe(path.join("/tmp/demo", ".config", "systemd", "user", "opencode-feishu-imui.service"))
  })

  test("derives default artifact from package version and current target", async () => {
    const root = new URL("..", import.meta.url).pathname
    const out = await defaultArtifact(root)

    expect(out).toContain(path.join("dist", "release", "opencode-feishu-imui-0.1.0-"))
    expect(out.endsWith(".tar.gz")).toBeTrue()
  })
})
