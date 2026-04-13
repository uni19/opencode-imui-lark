import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

const APP = "opencode-feishu-imui"

type LoadEnvInput = {
  argv?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type EnvLoadResult = {
  file?: string
  config_dir: string
  source: "explicit" | "cwd" | "config" | "process"
}

export function configDir(input: Pick<LoadEnvInput, "cwd" | "env"> = {}) {
  const env = input.env ?? process.env
  const cwd = input.cwd ?? process.cwd()
  const val = env.IMUI_CONFIG_DIR
  if (val) return path.resolve(cwd, val)
  if (env.XDG_CONFIG_HOME) return path.resolve(cwd, env.XDG_CONFIG_HOME, APP)
  if (env.HOME) return path.join(env.HOME, ".config", APP)
  return path.join(cwd, ".config", APP)
}

export function dataDir(input: Pick<LoadEnvInput, "cwd" | "env"> = {}) {
  const env = input.env ?? process.env
  const cwd = input.cwd ?? process.cwd()
  const val = env.IMUI_DATA_DIR
  if (val) return path.resolve(cwd, val)
  if (env.XDG_DATA_HOME) return path.resolve(cwd, env.XDG_DATA_HOME, APP)
  if (env.HOME) return path.join(env.HOME, ".local", "share", APP)
  return path.join(cwd, ".data")
}

export function help() {
  return [
    "OpenCode Feishu IMUI",
    "",
    "用法：",
    "  opencode-feishu-imui [--env-file /path/to/.env] [--help]",
    "",
    "说明：",
    "  --env-file  显式指定配置文件路径",
    "  --help      输出这段帮助并退出",
    "",
    "默认配置加载顺序：",
    "  1. --env-file <path>",
    "  2. IMUI_ENV_FILE",
    "  3. 当前工作目录下的 .env",
    "  4. ~/.config/opencode-feishu-imui/.env",
  ].join("\n")
}

export function parseEnv(text: string) {
  const out: Record<string, string> = {}

  for (const line of text.split("\n")) {
    const raw = line.trim()
    if (!raw || raw.startsWith("#")) continue
    const body = raw.startsWith("export ") ? raw.slice(7).trim() : raw
    const at = body.indexOf("=")
    if (at < 1) continue
    const key = body.slice(0, at).trim()
    let val = body.slice(at + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }

  return out
}

export function envFileArg(argv = process.argv) {
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const item = args[i]
    if (!item) continue
    if (item === "--env-file") return args[i + 1]
    if (item.startsWith("--env-file=")) return item.slice("--env-file=".length)
  }
}

export async function loadAppEnv(input: LoadEnvInput = {}): Promise<EnvLoadResult> {
  const argv = input.argv ?? process.argv
  const cwd = input.cwd ?? process.cwd()
  const env = input.env ?? process.env
  const explicit = envFileArg(argv) ?? env.IMUI_ENV_FILE

  let file: string | undefined
  let source: EnvLoadResult["source"] = "process"

  if (explicit) {
    file = path.resolve(cwd, explicit)
    source = "explicit"
    if (!existsSync(file)) throw new Error(`env file not found: ${file}`)
  } else {
    const local = path.join(cwd, ".env")
    const conf = path.join(configDir({ cwd, env }), ".env")
    if (existsSync(local)) {
      file = local
      source = "cwd"
    } else if (existsSync(conf)) {
      file = conf
      source = "config"
    }
  }

  if (file) {
    const loaded = parseEnv(await readFile(file, "utf8"))
    for (const [key, val] of Object.entries(loaded)) {
      if (env[key] === undefined) env[key] = val
    }
    if (!env.IMUI_CONFIG_DIR) env.IMUI_CONFIG_DIR = path.dirname(file)
  }

  const base = env.IMUI_CONFIG_DIR ? path.resolve(cwd, env.IMUI_CONFIG_DIR) : cwd
  return {
    file,
    config_dir: base,
    source,
  }
}
