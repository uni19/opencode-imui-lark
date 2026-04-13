import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { LOCAL_COMMAND_NAMES } from "../app/commands.js"

const need = [
  "LOG_LEVEL",
  "IMUI_DB_PATH",
  "IMUI_CONFIG_DIR",
  "IMUI_DATA_DIR",
  "IMUI_ASSET_CACHE_DIR",
  "IMUI_BACKUP_DIR",
  "IMUI_ASSET_TTL_HOURS",
  "IMUI_ASSET_MAX_MB",
  "IMUI_BACKUP_RETENTION_DAYS",
  "FEISHU_MODE",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BOT_OPEN_ID",
  "OPENCODE_BASE_URL",
  "OPENCODE_USERNAME",
  "OPENCODE_PASSWORD",
  "OPENCODE_DIRECTORY",
  "OPENCODE_WORKSPACE",
  "OPENCODE_AGENT",
  "OPENCODE_MODEL",
]

const keep = [".data", "dist", "*.log", ".cache", "tmp", ".env"]

const docs = [
  "README.md",
  "docs/10-release-checklist.md",
  "docs/11-packaging-and-install.md",
  "docs/12-operations-and-maintenance.md",
  "docs/13-feishu-scope-minimum.md",
  "docs/14-end-user-readme.md",
  "docs/06-delivery-plan.md",
]

const gate = ["bun test", "bun run typecheck", "bun run release:doctor", "bun run release:check", "bun run release:build"]
const admin = ["bun run db:migrate", "bun run db:backup"]

function lines(text: string) {
  return text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

function keys(text: string) {
  return lines(text)
    .filter((item) => !item.startsWith("#"))
    .map((item) => item.split("=", 1)[0]?.trim())
    .filter((item): item is string => !!item)
}

function miss(list: string[], want: string[]) {
  return want.filter((item) => !list.includes(item))
}

function has(text: string, part: string) {
  return text.includes(part)
}

export function list(text: string, head: string) {
  const row = text.split("\n")
  const at = row.findIndex((item) => item.trim() === head)
  if (at < 0) return []

  const out: string[] = []

  for (const item of row.slice(at + 1).map((item) => item.trim())) {
    if (!item.startsWith("- ")) break
    out.push(item.slice(2).trim())
  }

  return out
}

export function names(list: string[]) {
  return list
    .map((item) => item.match(/`(\/[^`\s]+)/)?.[1] ?? item.match(/^(\/\S+)/)?.[1])
    .filter((item): item is string => !!item)
    .map((item) => item.split(" ", 1)[0]!)
}

export function check(root = process.cwd()) {
  const env = readFile(path.join(root, ".env.example"), "utf8")
  const git = readFile(path.join(root, ".gitignore"), "utf8")
  const readme = readFile(path.join(root, "README.md"), "utf8")
  const rel = readFile(path.join(root, "docs/10-release-checklist.md"), "utf8")
  const plan = readFile(path.join(root, "docs/06-delivery-plan.md"), "utf8")
  const pkg = readFile(path.join(root, "package.json"), "utf8")

  return Promise.all([env, git, readme, rel, plan, pkg]).then(([env, git, readme, rel, plan, pkg]) => {
    const out: string[] = []
    const vars = keys(env)
    const ignore = lines(git)
    const gone = miss(vars, need)
    const skip = miss(ignore, keep)
    const json = JSON.parse(pkg) as { scripts?: Record<string, string> }
    const cmd = names(list(readme, "## 当前支持的 IM 命令"))
    const slash = names(list(rel, "## B. Slash 命令主链"))
    const done = [4, 5, 6].filter((item) => has(plan, `Task Pack ${item}`)).length

    if (gone.length > 0) out.push(`.env.example 缺少变量：${gone.join(", ")}`)
    if (skip.length > 0) out.push(`.gitignore 缺少忽略项：${skip.join(", ")}`)
    if (has(readme, "/Users/")) out.push("README.md 含本机绝对路径，请改为相对链接或通用占位路径")
    if (!has(readme, "docs/10-release-checklist.md")) out.push("README.md 缺少发布清单引用")
    if (!has(readme, "docs/11-packaging-and-install.md")) out.push("README.md 缺少安装包文档引用")
    if (!has(readme, "docs/12-operations-and-maintenance.md")) out.push("README.md 缺少运维文档引用")
    if (!has(readme, "docs/13-feishu-scope-minimum.md")) out.push("README.md 缺少最小 scope 文档引用")
    if (!has(readme, "docs/14-end-user-readme.md")) out.push("README.md 缺少终端用户文档引用")
    if (!has(rel, "文件 + 图片 + 说明")) out.push("发布清单缺少文件+图片+说明检查项")
    if (!has(rel, "连续补多次附件")) out.push("发布清单缺少重复附件补充检查项")
    if (!has(rel, "bun run release:doctor")) out.push("发布清单缺少启动前 doctor 命令")
    if (!has(rel, "bun run release:build")) out.push("发布清单缺少安装包构建命令")
    if (done < 3) out.push("delivery plan 缺少 Task Pack 4-6 执行记录")
    if (!docs.every((item) => existsSync(path.join(root, item)))) out.push("发布文档不完整")
    if (miss(Object.keys(json.scripts ?? {}), ["test", "typecheck", "release:check", "release:doctor", "release:build", "db:backup", "db:migrate"]).length > 0) {
      out.push("package.json 缺少发布或运维脚本")
    }
    if (miss(gate, gate.filter((item) => has(readme, item))).length > 0) out.push("README.md 缺少发布验证命令")
    if (miss(gate, gate.filter((item) => has(rel, item))).length > 0) out.push("发布清单缺少发布验证命令")
    if (miss(admin, admin.filter((item) => has(readme, item))).length > 0) out.push("README.md 缺少数据库运维命令")
    if (miss(admin, admin.filter((item) => has(rel, item))).length > 0) out.push("发布清单缺少数据库运维命令")
    if (miss(LOCAL_COMMAND_NAMES, cmd).length > 0) out.push(`README.md 缺少内建命令：${miss(LOCAL_COMMAND_NAMES, cmd).join(", ")}`)
    const requiredSlash = LOCAL_COMMAND_NAMES.filter((item) => !["/skills", "/agents", "/models", "/mcps"].includes(item))
    if (miss(requiredSlash, slash).length > 0) {
      out.push(`发布清单缺少内建 slash case：${miss(requiredSlash, slash).join(", ")}`)
    }

    return {
      ok: out.length === 0,
      out,
    }
  })
}

if (import.meta.main) {
  const out = await check()
  if (out.ok) {
    console.log("release check passed")
    process.exit(0)
  }

  console.error(out.out.join("\n"))
  process.exit(1)
}
