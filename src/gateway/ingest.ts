import type { Gateway, InboundEvent, Queue, Store } from "../contracts.js"

type Input = {
  store: Store
  queue: Queue
}

async function dedup(store: Store, key: string) {
  if (await store.seen(key)) return true
  await store.mark(key)
  return false
}

export function createGateway(input: Input): Gateway {
  return {
    async on_msg(msg: InboundEvent) {
      await input.store.save_inbound(msg)
      if (await dedup(input.store, msg.event_id)) return
      await input.queue.push({
        id: msg.id,
      })
    },
  }
}
