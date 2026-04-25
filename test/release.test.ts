import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { check, list, names } from "../src/release/check.ts"

describe("release check", () => {
  test("passes static release readiness checks", async () => {
    const out = await check(new URL("..", import.meta.url).pathname)

    expect(out).toEqual({
      ok: true,
      out: [],
    })
  })

  test("extracts slash commands from README and checklist sections", () => {
    const readme = [
      "## 当前支持的 IM 命令",
      "- `/session <session_id>`: 切换当前会话",
      "- `/repo --chat <directory>`: 为当前聊天设置默认目录",
      "- `/workspaces`: 查看当前目录下可用 workspace",
      "- `/model reset`: 恢复当前会话到默认模型",
      "",
      "## 其他段落",
    ].join("\n")

    const rel = [
      "## B. Slash 命令主链",
      "- [ ] `/session <id>`",
      "- [ ] `/repo --chat <directory>`",
      "- [ ] `/workspaces`",
      "- [ ] `/model reset`",
      "- [ ] 未命中的 slash 能正确透传或明确失败",
      "",
      "## C. 审批与追问",
    ].join("\n")

    expect(names(list(readme, "## 当前支持的 IM 命令"))).toEqual(["/session", "/repo", "/workspaces", "/model"])
    expect(names(list(rel, "## B. Slash 命令主链"))).toEqual(["/session", "/repo", "/workspaces", "/model"])
  })

  test("flags machine-specific absolute paths in README", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oc-feishu-release-"))

    try {
      await mkdir(path.join(root, "docs"), { recursive: true })
      await writeFile(
        path.join(root, ".env.example"),
        [
          "LOG_LEVEL=info",
          "IMUI_DB_PATH=.data/imui.db",
          "IMUI_CONFIG_DIR=",
          "IMUI_DATA_DIR=",
          "IMUI_ASSET_CACHE_DIR=",
          "IMUI_BACKUP_DIR=",
          "IMUI_ASSET_TTL_HOURS=168",
          "IMUI_ASSET_MAX_MB=1024",
          "IMUI_BACKUP_RETENTION_DAYS=14",
          "FEISHU_MODE=stdin",
          "FEISHU_APP_ID=",
          "FEISHU_APP_SECRET=",
          "FEISHU_BOT_OPEN_ID=",
          "OPENCODE_BASE_URL=http://127.0.0.1:4096",
          "OPENCODE_USERNAME=opencode",
          "OPENCODE_PASSWORD=",
          "OPENCODE_DIRECTORY=",
          "OPENCODE_WORKSPACE=",
          "OPENCODE_AGENT=",
          "OPENCODE_MODEL=",
          "",
        ].join("\n"),
      )
      await writeFile(path.join(root, ".gitignore"), [".data", "*.log", ".cache", "tmp", ".env", ""].join("\n"))
      await writeFile(
        path.join(root, "README.md"),
        [
          "# Demo",
          "",
          "[docs/11-packaging-and-install.md](docs/11-packaging-and-install.md)",
          "[docs/12-operations-and-maintenance.md](docs/12-operations-and-maintenance.md)",
          "[docs/13-feishu-scope-minimum.md](docs/13-feishu-scope-minimum.md)",
          "[docs/14-end-user-readme.md](docs/14-end-user-readme.md)",
          "[docs/10-release-checklist.md](/Users/bytedance/workspace/opencode-feishu-imui/docs/10-release-checklist.md)",
          "",
          "## 当前支持的 IM 命令",
          "- `/help`: 查看帮助",
          "- `/status`: 查看当前会话状态",
          "- `/abort`: 取消当前执行",
          "- `/new`: 新建会话",
          "- `/session`: 查看或切换当前会话",
          "- `/repo`: 查看或绑定目录 / workspace",
          "- `/sessions`: 查看当前目录 / workspace 下最近会话",
          "- `/workspaces`: 查看当前目录下可用 workspace",
          "- `/model`: 查看或切换当前模型",
          "- `/skills`: 查看当前目录 / workspace 下可用技能",
          "- `/commands`: 查看当前目录 / workspace 下可转发 slash 命令",
          "- `/agents`: 查看当前目录 / workspace 下可用 agent",
          "- `/models`: 查看当前目录 / workspace 下已连接 provider / model",
          "- `/mcps`: 查看当前目录 / workspace 下 MCP 状态",
          "",
          "bun test",
          "bun run typecheck",
          "bun run release:doctor",
          "bun run release:check",
          "bun run release:gate",
          "bun run db:migrate",
          "bun run db:backup",
          "bun run release:build",
          "bun run release:smoke",
          "",
        ].join("\n"),
      )
      await writeFile(
        path.join(root, "docs/10-release-checklist.md"),
        [
          "## B. Slash 命令主链",
          "- [ ] `/help`",
          "- [ ] `/status`",
          "- [ ] `/abort`",
          "- [ ] `/new`",
          "- [ ] `/session <id>`",
          "- [ ] `/repo --chat <directory>`",
          "- [ ] `/sessions`",
          "- [ ] `/workspaces`",
          "- [ ] `/model`",
          "- [ ] `/commands`",
          "",
          "文件 + 图片 + 说明",
          "连续补多次附件",
          "bun test",
          "bun run typecheck",
          "bun run release:doctor",
          "bun run release:check",
          "bun run release:gate",
          "bun run db:migrate",
          "bun run db:backup",
          "bun run release:build",
          "bun run release:smoke",
          "",
        ].join("\n"),
      )
      await writeFile(path.join(root, "docs/11-packaging-and-install.md"), "# packaging\n")
      await writeFile(path.join(root, "docs/12-operations-and-maintenance.md"), "# ops\n")
      await writeFile(path.join(root, "docs/13-feishu-scope-minimum.md"), "# scope\n")
      await writeFile(path.join(root, "docs/14-end-user-readme.md"), "# user\n")
      await writeFile(
        path.join(root, "docs/06-delivery-plan.md"),
        ["Task Pack 4", "Task Pack 5", "Task Pack 6", ""].join("\n"),
      )
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          scripts: {
            test: "bun test",
            typecheck: "tsc --noEmit",
            "release:check": "bun src/release/check.ts",
            "release:doctor": "bun src/release/doctor.ts",
            "release:gate": "bun src/release/gate.ts",
            "release:build": "bun src/release/package.ts",
            "release:smoke": "bun src/release/smoke.ts",
            "db:backup": "bun src/release/db.ts backup",
            "db:migrate": "bun src/release/db.ts migrate",
          },
        }),
      )

      const out = await check(root)

      expect(out.ok).toBeFalse()
      expect(out.out).toContain("README.md 含本机绝对路径，请改为相对链接或通用占位路径")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
