import { describe, expect, test } from "bun:test"
import { createQueue } from "../src/queue/bus.ts"
import { createMemoryStore } from "../src/storage/db.ts"

async function wait(fn: () => boolean | Promise<boolean>, timeout = 500) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("timeout")
}

describe("queue", () => {
  test("replays running jobs on start", async () => {
    const store = createMemoryStore()
    const seen: string[] = []

    await store.save_job({
      id: "in_1",
      status: "running",
      created_at: 1,
      updated_at: 1,
    })

    const queue = createQueue(store, async (job) => {
      seen.push(job.id)
    })

    await queue.start()
    await wait(() => seen.length === 1)
    await queue.stop()

    expect(seen).toEqual(["in_1"])
    expect(await store.get_job("in_1")).toMatchObject({
      status: "done",
    })
  })

  test("does not duplicate queued jobs", async () => {
    const store = createMemoryStore()
    const seen: string[] = []
    const queue = createQueue(store, async (job) => {
      seen.push(job.id)
    })

    await queue.start()
    await queue.push({ id: "in_2" })
    await queue.push({ id: "in_2" })
    await wait(() => seen.length === 1)
    await queue.stop()

    expect(seen).toEqual(["in_2"])
  })

  test("allows retry after failed job", async () => {
    const store = createMemoryStore()
    let count = 0
    const err = console.error
    console.error = () => undefined
    const queue = createQueue(store, async () => {
      count += 1
      if (count === 1) throw new Error("boom")
    })

    try {
      await queue.start()
      await queue.push({ id: "in_3" })
      await wait(async () => (await store.get_job("in_3"))?.status === "failed")
      await queue.push({ id: "in_3" })
      await wait(async () => (await store.get_job("in_3"))?.status === "done")
      await queue.stop()
    } finally {
      console.error = err
    }

    expect(count).toBe(2)
  })

  test("does not replay completed jobs on start", async () => {
    const store = createMemoryStore()
    const seen: string[] = []

    await store.save_job({
      id: "in_4",
      status: "done",
      created_at: 1,
      updated_at: 1,
    })

    const queue = createQueue(store, async (job) => {
      seen.push(job.id)
    })

    await queue.start()
    await Bun.sleep(50)
    await queue.stop()

    expect(seen).toEqual([])
    expect(await store.get_job("in_4")).toMatchObject({
      status: "done",
    })
  })
})
