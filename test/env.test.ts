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

  test("reads --env-file from argv and prefers the last one", () => {
    expect(envFileArg(["node", "app", "--env-file", "/tmp/demo.env"])).toBe("/tmp/demo.env")
    expect(envFileArg(["node", "app", "--env-file=/tmp/demo.env"])).toBe("/tmp/demo.env")
    expect(
      envFileArg(["node", "app", "--env-file", "/tmp/default.env", "--env-file=/tmp/override.env"]),
    ).toBe("/tmp/override.env")
  })

  test("explicit argv env file overrides preloaded values and IMUI_ENV_FILE", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-feishu-env-"))
    const first = path.join(root, "first.env")
    const second = path.join(root, "second.env")

    try {
      await writeFile(first, "LOG_LEVEL=warn\nIMUI_DB_PATH=first.db\n")
      await writeFile(second, "LOG_LEVEL=trace\nIMUI_DB_PATH=second.db\n")
      const env: NodeJS.ProcessEnv = {
        IMUI_ENV_FILE: first,
        LOG_LEVEL: "debug",
        IMUI_DB_PATH: "local.db",
      }

      const out = await loadAppEnv({
        cwd: root,
        env,
        argv: ["node", "app", "--env-file", first, "--env-file", second],
      })

      expect(out.source).toBe("explicit")
      expect(out.file).toBe(second)
      expect(out.config_dir).toBe(root)
      expect(env.LOG_LEVEL).toBe("trace")
      expect(env.IMUI_DB_PATH).toBe("second.db")
      expect(env.IMUI_ENV_FILE).toBe(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("IMUI_ENV_FILE overrides preloaded values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-feishu-env-"))
    const explicit = path.join(root, "explicit.env")

    try {
      await writeFile(explicit, "LOG_LEVEL=error\nIMUI_DB_PATH=explicit.db\n")
      const env: NodeJS.ProcessEnv = {
        IMUI_ENV_FILE: explicit,
        LOG_LEVEL: "debug",
        IMUI_DB_PATH: "local.db",
      }

      const out = await loadAppEnv({ cwd: root, env, argv: ["node", "app"] })

      expect(out.source).toBe("explicit")
      expect(out.file).toBe(explicit)
      expect(out.config_dir).toBe(root)
      expect(env.LOG_LEVEL).toBe("error")
      expect(env.IMUI_DB_PATH).toBe("explicit.db")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
