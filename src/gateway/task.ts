import crypto from "node:crypto"
import type { Task, TaskSvc, Store } from "../contracts.js"

const now = () => Date.now()

export function createTaskSvc(store: Store): TaskSvc {
  const patch = async (id: string, fn: (task: Task) => Task) => {
    const task = await store.get_task(id)
    if (!task) throw new Error(`task not found: ${id}`)
    await store.save_task(fn(task))
  }

  return {
    async add(input) {
      const time = now()
      const task = {
        id: "tsk_" + crypto.randomUUID(),
        im_session_id: input.im_session_id,
        session_id: input.session_id,
        inbound_id: input.inbound_id,
        directory: input.directory,
        workspace_id: input.workspace_id,
        status: "queued",
        created_at: time,
        updated_at: time,
      } satisfies Task
      await store.save_task(task)
      return task
    },

    async ack(id) {
      await patch(id, (task) => ({
        ...task,
        status: "acked",
        updated_at: now(),
      }))
    },

    async run(id) {
      await patch(id, (task) => ({
        ...task,
        status: "running",
        updated_at: now(),
      }))
    },

    async wait(input) {
      await patch(input.id, (task) => ({
        ...task,
        status: input.req_type === "permission" ? "waiting_permission" : "waiting_question",
        req_type: input.req_type,
        req: input.req,
        updated_at: now(),
      }))
    },

    async hold(id) {
      await patch(id, (task) => ({
        ...task,
        status: "waiting_attachment",
        req_type: "attachment",
        updated_at: now(),
      }))
    },

    async done(id, note) {
      await patch(id, (task) => ({
        ...task,
        status: "completed",
        note: note ?? task.note,
        updated_at: now(),
      }))
    },

    async fail(input) {
      await patch(input.id, (task) => ({
        ...task,
        status: "failed",
        err: input.err,
        note: input.note ?? input.err,
        updated_at: now(),
      }))
    },

    async abort(id, note) {
      await patch(id, (task) => ({
        ...task,
        status: "aborted",
        note: note ?? task.note,
        updated_at: now(),
      }))
    },

    async link(input) {
      await patch(input.id, (task) => ({
        ...task,
        outbound_id: input.outbound_id,
        updated_at: now(),
      }))
    },

    async note(input) {
      await patch(input.id, (task) => ({
        ...task,
        note: input.note,
        updated_at: now(),
      }))
    },
  }
}
