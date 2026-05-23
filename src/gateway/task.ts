import crypto from "node:crypto"
import type { Task, TaskSvc, Store, TaskTerminalKind } from "../contracts.js"
import { normalizeWorkspace } from "../workspace.js"

const now = () => Date.now()
const terminal = new Set<Task["status"]>(["completed", "failed", "aborted"])

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
        reply_anchor_message_id: input.reply_anchor_message_id,
        directory: input.directory,
        workspace_id: normalizeWorkspace(input.workspace_id),
        status: "queued",
        created_at: time,
        updated_at: time,
      } satisfies Task
      await store.save_task(task)
      return task
    },

    async rebind(input) {
      await patch(input.id, (task) => ({
        ...task,
        im_session_id: input.im_session_id ?? task.im_session_id,
        inbound_id: input.inbound_id,
        reply_anchor_message_id: input.reply_anchor_message_id,
        directory: input.directory,
        workspace_id: normalizeWorkspace(input.workspace_id),
        result_hash: input.clear_result_hash ? undefined : task.result_hash,
        superseded_by_task_id: undefined,
        updated_at: now(),
      }))
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
        req_id: input.req,
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

    async checkpoint(input) {
      await patch(input.id, (task) => ({
        ...task,
        result_hash: input.result_hash ?? task.result_hash,
        note: input.note ?? task.note,
        updated_at: now(),
      }))
    },

    async close(input) {
      const task = await store.get_task(input.id)
      if (!task) throw new Error(`task not found: ${input.id}`)
      if (terminal.has(task.status)) return false
      await store.save_task({
        ...task,
        status: input.status,
        terminal_kind: input.terminal_kind ?? defaultTerminalKind(input.status),
        terminal_outbound_id: input.terminal_outbound_id ?? task.terminal_outbound_id,
        result_hash: input.result_hash ?? task.result_hash,
        err: input.err ?? task.err,
        note: input.note ?? task.note,
        updated_at: now(),
      })
      return true
    },

    async supersede(input) {
      await patch(input.id, (task) => ({
        ...task,
        superseded_by_task_id: input.superseded_by_task_id,
        updated_at: now(),
      }))
    },

    async done(id, note) {
      await patch(id, (task) => ({
        ...task,
        status: "completed",
        terminal_kind: task.terminal_kind ?? "final",
        note: note ?? task.note,
        updated_at: now(),
      }))
    },

    async fail(input) {
      await patch(input.id, (task) => ({
        ...task,
        status: "failed",
        terminal_kind: task.terminal_kind ?? "error",
        err: input.err,
        note: input.note ?? input.err,
        updated_at: now(),
      }))
    },

    async abort(id, note) {
      await patch(id, (task) => ({
        ...task,
        status: "aborted",
        terminal_kind: task.terminal_kind ?? "aborted",
        note: note ?? task.note,
        updated_at: now(),
      }))
    },

    async link(input) {
      await patch(input.id, (task) => ({
        ...task,
        outbound_id: input.outbound_id,
        status_outbound_id: input.status_outbound_id ?? task.status_outbound_id,
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

function defaultTerminalKind(status: Extract<Task["status"], "completed" | "failed" | "aborted">): TaskTerminalKind {
  if (status === "completed") return "final"
  if (status === "failed") return "error"
  return "aborted"
}
