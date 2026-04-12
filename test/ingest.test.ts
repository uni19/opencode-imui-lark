import { describe, expect, test } from "bun:test"
import type { InboundMessage, Queue } from "../src/contracts.ts"
import { createGateway } from "../src/gateway/ingest.ts"
import { createMemoryStore } from "../src/storage/db.ts"

function inbound(): InboundMessage {
  return {
    id: "in_1",
    platform: "feishu",
    kind: "message",
    event_id: "evt_1",
    tenant_id: "tenant",
    chat_id: "chat",
    user_id: "user",
    raw: {},
    created_at: 1,
    text: "hello",
    message_id: "msg_1",
    assets: [],
    mentions: [],
  }
}

describe("gateway", () => {
  test("dedups the same event before enqueueing", async () => {
    const store = createMemoryStore()
    const list: string[] = []
    const queue = {
      async push(input) {
        list.push(input.id)
      },
      async start() {},
      async stop() {},
    } satisfies Queue
    const gateway = createGateway({
      store,
      queue,
    })

    await gateway.on_msg(inbound())
    await gateway.on_msg(inbound())

    expect(list).toEqual(["in_1"])
    expect(await store.get_inbound("in_1")).toMatchObject({
      event_id: "evt_1",
    })
  })
})
