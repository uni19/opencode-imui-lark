import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { configDir, dataDir, envFileArg, loadAppEnv, parseEnv } from "../src/app/env.ts"

describe("app env", () => {
  test("parses plain env text", () => {
    expect(
      parseEnv(
        [
          "# comment",
          "LOG_LEVEL=debug",
          "export FEISHU_MODE=long_conn",
          "OPENCODE_PASSWORD='abc'",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      LOG_LEVEL: "debug",
      FEISHU_MODE: "long_conn",
      OPENCODE_PASSWORD: "abc",
    })
  })

  test("reads --env-file from argv", () => {
    expect(envFileArg(["node", "app", "--env-file", "/tmp/demo.env"])).toBe("/tmp/demo.env")
    expect(envFileArg(["node", "app", "--env-file=/tmp/demo.env"])).toBe("/tmp/demo.env")
  })

  test("prefers cwd .env over config home fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-feishu-env-"))
    const home = path.join(root, "home")
    const conf = path.join(home, ".config", "opencode-feishu-imui")

    try {
      await mkdir(conf, { recursive: true })
      await writeFile(path.join(root, ".env"), "LOG_LEVEL=debug\n")
      await writeFile(path.join(conf, ".env"), "LOG_LEVEL=warn\n")
      const env: NodeJS.ProcessEnv = { HOME: home }

      const out = await loadAppEnv({ cwd: root, env, argv: ["node", "app"] })

      expect(out.source).toBe("cwd")
      expect(out.file).toBe(path.join(root, ".env"))
      expect(out.config_dir).toBe(root)
      expect(env.LOG_LEVEL).toBe("debug")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("falls back to config home when cwd .env is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-feishu-env-"))
    const home = path.join(root, "home")
    const conf = path.join(home, ".config", "opencode-feishu-imui")

    try {
      await mkdir(conf, { recursive: true })
      await writeFile(path.join(conf, ".env"), "LOG_LEVEL=error\n")
      const env: NodeJS.ProcessEnv = { HOME: home }

      const out = await loadAppEnv({ cwd: root, env, argv: ["node", "app"] })

      expect(out.source).toBe("config")
      expect(out.file).toBe(path.join(conf, ".env"))
      expect(out.config_dir).toBe(conf)
      expect(env.LOG_LEVEL).toBe("error")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("derives config and data directories from XDG or HOME", () => {
    expect(configDir({ cwd: "/repo", env: { XDG_CONFIG_HOME: "/tmp/xdg" } })).toBe("/tmp/xdg/opencode-feishu-imui")
    expect(dataDir({ cwd: "/repo", env: { HOME: "/home/demo" } })).toBe("/home/demo/.local/share/opencode-feishu-imui")
  })
})
