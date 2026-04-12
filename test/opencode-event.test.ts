import { describe, expect, test } from "bun:test"
import type { AppCfg, ConnState } from "../src/contracts.ts"
import { createOpencodeEvent } from "../src/opencode/event.ts"
import { createMemoryStore } from "../src/storage/db.ts"

async function wait(fn: () => boolean | Promise<boolean>, timeout = 500) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("timeout")
}

function cfg() {
  return {
    log: { level: "info" },
    storage: { path: ":memory:" },
    feishu: { mode: "off" },
    opencode: {
      base_url: "http://127.0.0.1:4096",
      username: "opencode",
      directory: "/tmp",
    },
  } satisfies AppCfg
}

describe("opencode event", () => {
  test("emits error before reconnecting when sse connect fails", async () => {
    const store = createMemoryStore()
    const list: ConnState[] = []
    const fetch = globalThis.fetch
    const err = console.error
    console.error = () => undefined
    globalThis.fetch = (async () => {
      throw new Error("boom")
    }) as typeof fetch

    const svc = createOpencodeEvent({
      cfg: cfg(),
      store,
      async on_event() {},
      async on_state(item) {
        list.push(item)
      },
    })

    try {
      await svc.start()
      await wait(() => list.some((item) => item.status === "error") && list.some((item) => item.status === "reconnecting"))
      await svc.stop()
    } finally {
      globalThis.fetch = fetch
      console.error = err
    }

    expect(list.map((item) => item.status)).toEqual(["connecting", "error", "reconnecting", "stopped"])
    expect(list[1]).toMatchObject({
      status: "error",
      err: "boom",
      attempt: 1,
      wait_ms: 1000,
    })
    expect(list[2]).toMatchObject({
      status: "reconnecting",
      err: "boom",
      attempt: 1,
      wait_ms: 1000,
    })
  })
})
