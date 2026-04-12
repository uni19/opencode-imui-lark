import { createApp } from "./boot.js"

const app = createApp()

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
