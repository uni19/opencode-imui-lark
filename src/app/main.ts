import { createApp } from "./boot.js"
import { help, loadAppEnv } from "./env.js"
import { cfg } from "./cfg.js"
import { validateAppCfg } from "./validate.js"

if (process.argv.slice(2).includes("--help")) {
  console.log(help())
  process.exit(0)
}

const runtime = await loadAppEnv()
const conf = cfg()
const report = validateAppCfg(conf)

if (report.warnings.length > 0) {
  console.warn(
    JSON.stringify({
      type: "validate",
      level: "warn",
      items: report.warnings,
    }),
  )
}

if (report.errors.length > 0) {
  console.error(
    JSON.stringify({
      type: "validate",
      level: "error",
      items: report.errors,
    }),
  )
  process.exit(1)
}

const app = createApp(conf)

function safe() {
  return {
    ...app.cfg,
    storage: {
      ...app.cfg.storage,
    },
    feishu: {
      ...app.cfg.feishu,
      app_secret: app.cfg.feishu.app_secret ? "***" : undefined,
    },
    opencode: {
      ...app.cfg.opencode,
      password: app.cfg.opencode.password ? "***" : undefined,
    },
  }
}

console.log(
  JSON.stringify({
    type: "boot",
    env: {
      source: runtime.source,
      file: runtime.file,
      config_dir: runtime.config_dir,
    },
    cfg: safe(),
  }),
)

await app.start()

let stopping: Promise<void> | undefined

const stop = () =>
  (stopping ??= app
    .stop()
    .then(() => {
      process.exit(0)
    }))

process.on("SIGINT", () => {
  stop().catch((err) => {
    console.error(err)
    process.exit(1)
  })
})

process.on("SIGTERM", () => {
  stop().catch((err) => {
    console.error(err)
    process.exit(1)
  })
})
