import readline from "node:readline"
import type { ConnState, FeishuConn, InboundMessage } from "../contracts.js"
import { parseInbound, parseMessage } from "./map.js"

type Input = {
  mode: "stdin" | "long_conn" | "off"
  app_id?: string
  app_secret?: string
  on_msg: (input: InboundMessage) => Promise<void>
  on_state?: (input: ConnState) => Promise<void>
}

function state(status: ConnState["status"], err?: string, attempt?: number): ConnState {
  return {
    name: "message",
    status,
    updated_at: Date.now(),
    err,
    attempt,
  }
}

export function createFeishuConn(input: Input): FeishuConn {
  let rl: readline.Interface | undefined
  let stop: (() => Promise<void>) | undefined
  let last = ""
  let prev: ConnState | undefined
  let count = 0

  const handle = async (line: string) => {
    await input.on_msg(parseInbound(line))
  }

  const save = async (item: ConnState) => {
    const next = [item.name, item.status, item.err ?? "", item.attempt ?? "", item.wait_ms ?? ""].join(":")
    if (last === next) return
    last = next
    prev = item
    await input.on_state?.(item)
  }

  return {
    async start() {
      if (input.mode === "off") {
        await save(state("stopped"))
        return
      }
      if (input.mode === "long_conn") {
        if (!input.app_id || !input.app_secret) {
          throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET")
        }

        const Lark = await import("@larksuiteoapi/node-sdk")
        const logger = {
          trace: () => undefined,
          debug: (...args: unknown[]) => {
            const text = args.map(String).join(" ")
            if (text.includes("client closed")) {
              count = prev?.status === "reconnecting" ? Math.max(1, count) : count + 1
              save(state("reconnecting", "ws closed", count)).catch((err) => {
                console.error("[feishu.conn]", err)
              })
            }
          },
          info: (...args: unknown[]) => {
            const text = args.map(String).join(" ")
            if (text.includes("ws client ready")) {
              count = 0
              save(state("ready")).catch((err) => {
                console.error("[feishu.conn]", err)
              })
              return
            }
            if (text.includes("reconnect")) {
              count = prev?.status === "reconnecting" ? Math.max(1, count) : count + 1
              save(state("reconnecting", undefined, count)).catch((err) => {
                console.error("[feishu.conn]", err)
              })
            }
          },
          warn: (...args: unknown[]) => {
            console.warn(...args)
          },
          error: (...args: unknown[]) => {
            const text = args.map(String).join(" ")
            save(state("error", text, count || undefined)).catch((err) => {
              console.error("[feishu.conn]", err)
            })
            console.error(...args)
          },
        }
        const ws = new Lark.WSClient({
          appId: input.app_id,
          appSecret: input.app_secret,
          loggerLevel: Lark.LoggerLevel.info,
          logger,
        })

        const eventDispatcher = new Lark.EventDispatcher({}).register({
          "im.message.receive_v1": async (data: unknown) => {
            const item = parseMessage(data)
            if (!item) return
            await input.on_msg(item)
          },
          "im.message.message_read_v1": async () => undefined,
        })

        await save(state("connecting"))
        Promise.resolve(ws.start({ eventDispatcher })).catch((err) => {
          save(state("error", err instanceof Error ? err.message : String(err))).catch((item) => {
            console.error("[feishu.conn]", item)
          })
          console.error("[feishu.conn]", err)
        })

        stop = async () => {
          await Promise.resolve(ws.close?.())
          await save(state("stopped"))
        }
        return
      }
      await save(state("ready"))
      rl = readline.createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
      })
      rl.on("line", (line) => {
        if (!line.trim()) return
        handle(line).catch((err) => {
          console.error("[feishu.conn]", err)
        })
      })
    },

    async stop() {
      rl?.close()
      await stop?.()
      await save(state("stopped"))
    },
  }
}
