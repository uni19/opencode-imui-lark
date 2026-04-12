import type { AppCfg, OpencodeModel } from "../contracts.js"
import path from "node:path"

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
  return path.resolve(val)
}

export function cfg(): AppCfg {
  return {
    log: {
      level: level(),
    },
    storage: {
      path:
        process.env.IMUI_DB_PATH === ":memory:"
          ? ":memory:"
          : path.resolve(process.cwd(), process.env.IMUI_DB_PATH ?? ".data/imui.db"),
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
