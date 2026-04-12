import type { Job, Queue, Store } from "../contracts.js"

type Handler = (job: Job) => Promise<void>
type Fail = (job: Job, err: unknown) => Promise<void>

const now = () => Date.now()

export function createQueue(store: Store, handler: Handler, fail?: Fail): Queue {
  const wait: Array<() => void> = []
  let live = false
  let task: Promise<void> | undefined

  const next = () => {
    const fn = wait.shift()
    if (fn) fn()
  }

  const pull = async () => {
    while (live) {
      const job = await store.claim_job()
      if (job) return job
      await new Promise<void>((resolve) => wait.push(resolve))
    }
  }

  const loop = async () => {
    while (live) {
      const job = await pull()
      if (!job) continue
      await handler(job)
        .then(async () => {
          await store.done_job(job.id)
        })
        .catch(async (err) => {
          await store.fail_job({
            id: job.id,
            err: err instanceof Error ? err.message : String(err),
          })
          console.error("[queue]", err)
          await fail?.(job, err).catch((item) => {
            console.error("[queue.fail]", item)
          })
        })
    }
  }

  return {
    async push(input) {
      const row = await store.get_job(input.id)
      if (row && row.status !== "failed") {
        next()
        return
      }
      await store.save_job({
        id: input.id,
        status: "queued",
        err: undefined,
        created_at: row?.created_at ?? now(),
        updated_at: now(),
      })
      next()
    },

    async start() {
      if (live) return
      await store.reset_jobs({
        from: ["running"],
        to: "queued",
      })
      live = true
      task = loop()
      next()
    },

    async stop() {
      if (!live) return
      live = false
      next()
      await task
    },
  }
}
