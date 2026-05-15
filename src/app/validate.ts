import { accessSync, constants, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { AppCfg } from "../contracts.js"

export type ValidateReport = {
  ok: boolean
  errors: string[]
  warnings: string[]
}

function add(list: string[], text: string) {
  if (!list.includes(text)) list.push(text)
}

function validURL(text: string) {
  try {
    const url = new URL(text)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function writable(file: string) {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  accessSync(dir, constants.W_OK)
}

export function validateAppCfg(conf: AppCfg, env: NodeJS.ProcessEnv = process.env): ValidateReport {
  const errors: string[] = []
  const warnings: string[] = []

  if (!validURL(conf.opencode.base_url)) {
    add(errors, "OPENCODE_BASE_URL 必须是 http(s) URL。")
  }

  if (!conf.opencode.password) {
    add(errors, "OPENCODE_PASSWORD 未配置。")
  }

  if (env.OPENCODE_MODEL && !conf.opencode.model) {
    add(errors, "OPENCODE_MODEL 格式应为 <provider>/<model_id>[@<variant>]。")
  }

  if (conf.feishu.mode === "long_conn") {
    if (!conf.feishu.app_id) add(errors, "FEISHU_MODE=long_conn 时必须配置 FEISHU_APP_ID。")
    if (!conf.feishu.app_secret) add(errors, "FEISHU_MODE=long_conn 时必须配置 FEISHU_APP_SECRET。")
    if (!conf.feishu.bot_id) add(warnings, "未配置 FEISHU_BOT_OPEN_ID，群聊首条 @bot 判断会退回到名称匹配。")
  }

  if (!conf.opencode.directory && !conf.opencode.workspace) {
    add(warnings, "未配置 OPENCODE_DIRECTORY 或 OPENCODE_WORKSPACE，新会话需要用户先绑定目录或 workspace。")
  }

  if (conf.opencode.directory && !existsSync(conf.opencode.directory)) {
    add(errors, `OPENCODE_DIRECTORY 不存在：${conf.opencode.directory}`)
  }

  if (conf.storage.path !== ":memory:") {
    try {
      writable(conf.storage.path)
    } catch {
      add(errors, `IMUI_DB_PATH 所在目录不可写：${path.dirname(conf.storage.path)}`)
    }
  }

  if (conf.runtime) {
    try {
      writable(path.join(conf.runtime.asset_dir, ".keep"))
    } catch {
      add(errors, `附件缓存目录不可写：${conf.runtime.asset_dir}`)
    }

    try {
      writable(path.join(conf.runtime.backup_dir, ".keep"))
    } catch {
      add(errors, `备份目录不可写：${conf.runtime.backup_dir}`)
    }

    if (conf.runtime.asset_ttl_hours < 1) {
      add(errors, "IMUI_ASSET_TTL_HOURS 必须大于等于 1。")
    }
    if (conf.runtime.asset_max_mb < 16) {
      add(warnings, "IMUI_ASSET_MAX_MB 小于 16，附件缓存可能很快被清空。")
    }
    if (conf.runtime.backup_retention_days < 1) {
      add(errors, "IMUI_BACKUP_RETENTION_DAYS 必须大于等于 1。")
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  }
}
