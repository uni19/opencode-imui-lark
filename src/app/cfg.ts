import type { AppCfg, OpencodeModel } from "../contracts.js"
import path from "node:path"
import { configDir, dataDir } from "./env.js"

function base() {
  return configDir()
}

function data() {
  return dataDir()
}

function level() {
  const val = process.env.LOG_LEVEL
  if (val === "debug") return val
  if (val === "warn") return val
  if (val === "error") return val
  return "info"
}

function mode() {
  if (process.env.FEISHU_MODE === "off") return "off" as const
  if (process.env.FEISHU_MODE === "long_conn") return "long_conn" as const
  return "stdin" as const
}

function model(): OpencodeModel | undefined {
  const val = process.env.OPENCODE_MODEL
  if (!val) return
  const [providerID, modelID] = val.split("/", 2)
  if (!providerID || !modelID) return
  return { providerID, modelID }
}

function dir(val?: string) {
  if (!val) return
  return path.resolve(base(), val)
}

function runtimeDir(val: string | undefined, root: string, fallback: string) {
  if (!val) return fallback
  return path.resolve(root, val)
}

function num(val: string | undefined, fallback: number) {
  if (!val?.trim()) return fallback
  const parsed = Number(val)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function cfg(): AppCfg {
  const config_dir = base()
  const data_dir = data()
  const asset_dir = runtimeDir(process.env.IMUI_ASSET_CACHE_DIR, data_dir, path.join(data_dir, "asset"))
  const backup_dir = runtimeDir(process.env.IMUI_BACKUP_DIR, data_dir, path.join(data_dir, "backup"))

  return {
    log: {
      level: level(),
    },
    storage: {
      path:
        process.env.IMUI_DB_PATH === ":memory:"
          ? ":memory:"
          : path.resolve(config_dir, process.env.IMUI_DB_PATH ?? ".data/imui.db"),
    },
    runtime: {
      config_dir,
      data_dir,
      asset_dir,
      asset_ttl_hours: num(process.env.IMUI_ASSET_TTL_HOURS, 7 * 24),
      asset_max_mb: num(process.env.IMUI_ASSET_MAX_MB, 1024),
      backup_dir,
      backup_retention_days: num(process.env.IMUI_BACKUP_RETENTION_DAYS, 14),
    },
    feishu: {
      mode: mode(),
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
      bot_id: process.env.FEISHU_BOT_OPEN_ID,
    },
    opencode: {
      base_url: process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096",
      username: process.env.OPENCODE_USERNAME ?? "opencode",
      password: process.env.OPENCODE_PASSWORD,
      directory: dir(process.env.OPENCODE_DIRECTORY),
      workspace: process.env.OPENCODE_WORKSPACE,
      agent: process.env.OPENCODE_AGENT,
      model: model(),
    },
  }
}
