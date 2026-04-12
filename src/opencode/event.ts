import type { AppCfg, ConnState, OpencodeEvent, OpencodeEventSvc, Store } from "../contracts.js"

type Input = {
  cfg: AppCfg
  store: Store
  on_event: (event: OpencodeEvent) => Promise<void>
  on_state?: (input: ConnState) => Promise<void>
}

function auth(cfg: AppCfg) {
  if (!cfg.opencode.password) return
  const token = Buffer.from([cfg.opencode.username, cfg.opencode.password].join(":")).toString("base64")
  return `Basic ${token}`
}

function state(status: ConnState["status"], err?: string, attempt?: number, wait_ms?: number): ConnState {
  return {
    name: "opencode",
    status,
    updated_at: Date.now(),
    err,
    attempt,
    wait_ms,
  }
}

function unwrap(input: unknown) {
  if (!input || typeof input !== "object") return
  if ("payload" in input && input.payload && typeof input.payload === "object" && "type" in input.payload) {
    return input.payload as OpencodeEvent
  }
  if ("type" in input) return input as OpencodeEvent
}

export function createOpencodeEvent(input: Input): OpencodeEventSvc {
  let live = false
  let ctrl: AbortController | undefined
  let task: Promise<void> | undefined
  let last = ""

  const save = async (item: ConnState) => {
    const next = [item.name, item.status, item.err ?? "", item.attempt ?? "", item.wait_ms ?? ""].join(":")
    if (last === next) return
    last = next
    await input.store.set_conn(item)
    await input.on_state?.(item)
  }

  const backoff = (count: number) => Math.min(15000, 1000 * 2 ** Math.min(count - 1, 4))

  const wait = async (ms: number, signal?: AbortSignal) => {
    await new Promise<void>((resolve) => {
      const id = setTimeout(resolve, ms)
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(id)
          resolve()
        },
        { once: true },
      )
    })
  }

  const run = async (ctrl: AbortController) => {
    const headers = new Headers({
      accept: "text/event-stream",
    })
    const token = auth(input.cfg)
    if (token) headers.set("Authorization", token)

    const res = await fetch(input.cfg.opencode.base_url + "/global/event", {
      headers,
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`opencode sse failed: ${res.status} ${res.statusText}`)
    }
    await save(state("ready"))
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ""

    while (live) {
      const item = await reader.read()
      if (item.done) break
      buf += item.value
      const chunks = buf.split("\n\n")
      buf = chunks.pop() ?? ""

      for (const chunk of chunks) {
        const line = chunk
          .split("\n")
          .find((row) => row.startsWith("data:"))
        if (!line) continue
        const raw = line.replace(/^data:\s*/, "")
        const data = unwrap(JSON.parse(raw))
        if (!data) continue
        await input.on_event(data).catch((err) => {
          console.error("[opencode.event.on_event]", err)
        })
      }
    }
    if (live && !ctrl.signal.aborted) {
      throw new Error("opencode sse closed")
    }
  }

  return {
    async start() {
      if (live) return
      live = true
      ctrl = new AbortController()
      task = (async () => {
        let count = 0
        while (live && ctrl && !ctrl.signal.aborted) {
          await save(state(count === 0 ? "connecting" : "reconnecting"))
          const err = await run(ctrl).then(() => undefined).catch((err) => err)
          if (!err || ctrl.signal.aborted || !live) return
          const val = err instanceof Error ? err.message : String(err)
          console.error("[opencode.event]", err)
          count += 1
          const ms = backoff(count)
          await save(state("error", val, count, ms))
          await save(state("reconnecting", val, count, ms))
          await wait(ms, ctrl.signal)
        }
      })()
    },

    async stop() {
      if (!live) return
      live = false
      ctrl?.abort()
      await save(state("stopped"))
      await task
      ctrl = undefined
    },
  }
}
