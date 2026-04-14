import path from "node:path"
import type {
  Attachment,
  ConnState,
  ImSession,
  InboundEvent,
  Outbound,
  Pending,
  QueueJob,
  RepoPref,
  Store,
  Task,
} from "../contracts.js"
import { openSqlite } from "./admin.js"

const key = (tenant_id: string, chat_id: string, thread_id?: string) => [tenant_id, chat_id, thread_id ?? ""].join(":")
const pref = (scope: "chat" | "user", tenant_id: string, chat_id?: string, user_id?: string) =>
  [scope, tenant_id, chat_id ?? "", user_id ?? ""].join(":")
const attachment = (message_id: string, asset_key: string) => [message_id, asset_key].join(":")

function text(val: unknown) {
  return JSON.stringify(val)
}

function parse<T>(val: string | null) {
  if (!val) return null
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

export function createMemoryStore(): Store {
  const sessions = new Map<string, ImSession>()
  const list = new Map<string, ImSession>()
  const prefs = new Map<string, RepoPref>()
  const tasks = new Map<string, Task>()
  const inbound = new Map<string, InboundEvent>()
  const jobs = new Map<string, QueueJob>()
  const outbound = new Map<string, Outbound>()
  const attachments = new Map<string, Attachment>()
  const pending = new Map<string, Pending>()
  const seen = new Set<string>()
  const conn = new Map<string, ConnState>()

  return {
    async get_session(input) {
      return sessions.get(key(input.tenant_id, input.chat_id, input.thread_id)) ?? null
    },

    async get_session_by_opencode(session_id) {
      return list.get(session_id) ?? null
    },

    async save_session(input) {
      const old = sessions.get(key(input.tenant_id, input.chat_id, input.thread_id))
      const hit = list.get(input.session_id)
      if (old && old.session_id !== input.session_id) list.delete(old.session_id)
      if (hit) {
        sessions.delete(key(hit.tenant_id, hit.chat_id, hit.thread_id))
      }
      sessions.set(key(input.tenant_id, input.chat_id, input.thread_id), input)
      list.set(input.session_id, input)
    },

    async get_pref(input) {
      return prefs.get(pref(input.scope, input.tenant_id, input.chat_id, input.user_id)) ?? null
    },

    async save_pref(input) {
      prefs.set(pref(input.scope, input.tenant_id, input.chat_id, input.user_id), input)
    },

    async save_task(input) {
      tasks.set(input.id, input)
    },

    async get_task(id) {
      return tasks.get(id) ?? null
    },

    async get_task_by_inbound(inbound_id) {
      const all = [...tasks.values()].filter((item) => item.inbound_id === inbound_id)
      all.sort((a, b) => a.created_at - b.created_at)
      return all.at(-1) ?? null
    },

    async get_last_task(session_id) {
      const all = [...tasks.values()].filter((item) => item.session_id === session_id)
      all.sort((a, b) => a.created_at - b.created_at)
      return all.at(-1) ?? null
    },

    async get_task_by_req(req) {
      const all = [...tasks.values()].filter((item) => item.req === req)
      all.sort((a, b) => a.created_at - b.created_at)
      return all.at(-1) ?? null
    },

    async list_tasks(input) {
      const all = [...tasks.values()]
      const list = all.filter((item) => {
        if (input?.status?.length && !input.status.includes(item.status)) return false
        if (input?.session_id && item.session_id !== input.session_id) return false
        if (input?.inbound_id && item.inbound_id !== input.inbound_id) return false
        return true
      })
      list.sort((a, b) => a.created_at - b.created_at)
      return list
    },

    async save_inbound(input) {
      inbound.set(input.id, input)
    },

    async get_inbound(id) {
      return inbound.get(id) ?? null
    },

    async save_job(input) {
      jobs.set(input.id, input)
    },

    async get_job(id) {
      return jobs.get(id) ?? null
    },

    async claim_job() {
      const list = [...jobs.values()]
        .filter((item) => item.status === "queued")
        .sort((a, b) => a.created_at - b.created_at)
      const row = list.at(0)
      if (!row) return null
      const next = {
        ...row,
        status: "running" as const,
        updated_at: Date.now(),
      }
      jobs.set(row.id, next)
      return next
    },

    async done_job(id) {
      const row = jobs.get(id)
      if (!row) return
      jobs.set(id, {
        ...row,
        status: "done",
        err: undefined,
        updated_at: Date.now(),
      })
    },

    async fail_job(input) {
      const row = jobs.get(input.id)
      if (!row) return
      jobs.set(input.id, {
        ...row,
        status: "failed",
        err: input.err,
        updated_at: Date.now(),
      })
    },

    async reset_jobs(input) {
      const time = Date.now()
      for (const row of jobs.values()) {
        if (!input.from.includes(row.status)) continue
        jobs.set(row.id, {
          ...row,
          status: input.to,
          updated_at: time,
        })
      }
    },

    async save_outbound(input) {
      outbound.set(input.task_id, input)
    },

    async get_outbound(task_id) {
      return outbound.get(task_id) ?? null
    },

    async save_attachment(input) {
      attachments.set(attachment(input.message_id, input.key), input)
    },

    async get_attachment(input) {
      return attachments.get(attachment(input.message_id, input.key)) ?? null
    },

    async save_pending(input) {
      pending.set(input.session_id, input)
    },

    async get_pending(session_id) {
      return pending.get(session_id) ?? null
    },

    async drop_pending(session_id) {
      pending.delete(session_id)
    },

    async seen(val) {
      return seen.has(val)
    },

    async mark(val) {
      seen.add(val)
    },

    async get_conn(name) {
      return conn.get(name) ?? null
    },

    async set_conn(input) {
      conn.set(input.name, input)
    },
  }
}

export function createSqliteStore(file: string): Store {
  const db = openSqlite(file)
  let live = true

  const get_session = db.query<{ data: string }, [string, string, string]>(
    "select data from im_session where tenant_id = ?1 and chat_id = ?2 and thread_id = ?3 limit 1",
  )
  const get_session_by_opencode = db.query<{ data: string }, [string]>(
    "select data from im_session where opencode_session_id = ?1 limit 1",
  )
  const get_session_map = db.query<{ opencode_session_id: string | null }, [string]>(
    "select opencode_session_id from im_session where map_key = ?1 limit 1",
  )
  const save_session = db.query(
    `
      insert into im_session (
        map_key,
        opencode_session_id,
        tenant_id,
        chat_id,
        thread_id,
        data,
        updated_at
      ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      on conflict(map_key) do update set
        opencode_session_id = excluded.opencode_session_id,
        tenant_id = excluded.tenant_id,
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        data = excluded.data,
        updated_at = excluded.updated_at
    `,
  )
  const drop_session = db.query("delete from im_session where opencode_session_id = ?1")
  const get_pref = db.query<{ data: string }, [string]>("select data from repo_pref where pref_key = ?1 limit 1")
  const save_pref = db.query(
    `
      insert into repo_pref (pref_key, scope, tenant_id, chat_id, user_id, data)
      values (?1, ?2, ?3, ?4, ?5, ?6)
      on conflict(pref_key) do update set
        scope = excluded.scope,
        tenant_id = excluded.tenant_id,
        chat_id = excluded.chat_id,
        user_id = excluded.user_id,
        data = excluded.data
    `,
  )
  const save_task = db.query(
    `
      insert into task (id, session_id, req, created_at, data)
      values (?1, ?2, ?3, ?4, ?5)
      on conflict(id) do update set
        session_id = excluded.session_id,
        req = excluded.req,
        created_at = excluded.created_at,
        data = excluded.data
    `,
  )
  const get_task = db.query<{ data: string }, [string]>("select data from task where id = ?1 limit 1")
  const get_task_by_inbound = db.query<{ data: string }, [string]>(
    "select data from task where json_extract(data, '$.inbound_id') = ?1 order by created_at desc limit 1",
  )
  const get_last_task = db.query<{ data: string }, [string]>(
    "select data from task where session_id = ?1 order by created_at desc limit 1",
  )
  const get_task_by_req = db.query<{ data: string }, [string]>(
    "select data from task where req = ?1 order by created_at desc limit 1",
  )
  const list_tasks = db.query<{ data: string }, []>("select data from task order by created_at asc")
  const save_inbound = db.query(
    `
      insert into inbound_event (id, data)
      values (?1, ?2)
      on conflict(id) do update set
        data = excluded.data
    `,
  )
  const get_inbound = db.query<{ data: string }, [string]>("select data from inbound_event where id = ?1 limit 1")
  const save_job = db.query(
    `
      insert into queue_job (id, status, created_at, updated_at, data)
      values (?1, ?2, ?3, ?4, ?5)
      on conflict(id) do update set
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        data = excluded.data
    `,
  )
  const get_job = db.query<{ data: string }, [string]>("select data from queue_job where id = ?1 limit 1")
  const pick_job = db.query<{ data: string }, []>(
    "select data from queue_job where status = 'queued' order by created_at asc limit 1",
  )
  const list_job = db.query<{ data: string }, []>("select data from queue_job order by created_at asc")
  const save_outbound = db.query(
    `
      insert into outbound_message (task_id, data)
      values (?1, ?2)
      on conflict(task_id) do update set
        data = excluded.data
    `,
  )
  const get_outbound = db.query<{ data: string }, [string]>(
    "select data from outbound_message where task_id = ?1 limit 1",
  )
  const save_attachment = db.query(
    `
      insert into attachment (attachment_key, message_id, asset_key, data, updated_at)
      values (?1, ?2, ?3, ?4, ?5)
      on conflict(attachment_key) do update set
        message_id = excluded.message_id,
        asset_key = excluded.asset_key,
        data = excluded.data,
        updated_at = excluded.updated_at
    `,
  )
  const get_attachment = db.query<{ data: string }, [string]>(
    "select data from attachment where attachment_key = ?1 limit 1",
  )
  const save_pending = db.query(
    `
      insert into pending_attachment (session_id, data)
      values (?1, ?2)
      on conflict(session_id) do update set
        data = excluded.data
    `,
  )
  const get_pending = db.query<{ data: string }, [string]>(
    "select data from pending_attachment where session_id = ?1 limit 1",
  )
  const drop_pending = db.query("delete from pending_attachment where session_id = ?1")
  const get_seen = db.query<{ key: string }, [string]>("select key from seen_event where key = ?1 limit 1")
  const save_seen = db.query(
    `
      insert into seen_event (key, created_at)
      values (?1, ?2)
      on conflict(key) do nothing
    `,
  )
  const save_conn = db.query(
    `
      insert into conn_state (name, data)
      values (?1, ?2)
      on conflict(name) do update set
        data = excluded.data
    `,
  )
  const get_conn = db.query<{ data: string }, [string]>("select data from conn_state where name = ?1 limit 1")

  return {
    async get_session(input) {
      return parse<ImSession>(get_session.get(input.tenant_id, input.chat_id, input.thread_id ?? "")?.data ?? null)
    },

    async get_session_by_opencode(session_id) {
      return parse<ImSession>(get_session_by_opencode.get(session_id)?.data ?? null)
    },

    async save_session(input) {
      if (!live) return
      const map = key(input.tenant_id, input.chat_id, input.thread_id)
      const old = get_session_map.get(map)?.opencode_session_id
      drop_session.run(input.session_id)
      if (old && old !== input.session_id) drop_session.run(old)
      save_session.run(
        map,
        input.session_id,
        input.tenant_id,
        input.chat_id,
        input.thread_id ?? "",
        text(input),
        input.updated_at,
      )
    },

    async get_pref(input) {
      return parse<RepoPref>(get_pref.get(pref(input.scope, input.tenant_id, input.chat_id, input.user_id))?.data ?? null)
    },

    async save_pref(input) {
      if (!live) return
      save_pref.run(
        pref(input.scope, input.tenant_id, input.chat_id, input.user_id),
        input.scope,
        input.tenant_id,
        input.chat_id ?? null,
        input.user_id ?? null,
        text(input),
      )
    },

    async save_task(input) {
      if (!live) return
      save_task.run(input.id, input.session_id, input.req ?? null, input.created_at, text(input))
    },

    async get_task(id) {
      return parse<Task>(get_task.get(id)?.data ?? null)
    },

    async get_task_by_inbound(inbound_id) {
      return parse<Task>(get_task_by_inbound.get(inbound_id)?.data ?? null)
    },

    async get_last_task(session_id) {
      return parse<Task>(get_last_task.get(session_id)?.data ?? null)
    },

    async get_task_by_req(req) {
      return parse<Task>(get_task_by_req.get(req)?.data ?? null)
    },

    async list_tasks(input) {
      const all = list_tasks.all().flatMap((item) => {
        const row = parse<Task>(item.data)
        return row ? [row] : []
      })
      return all.filter((item) => {
        if (input?.status?.length && !input.status.includes(item.status)) return false
        if (input?.session_id && item.session_id !== input.session_id) return false
        if (input?.inbound_id && item.inbound_id !== input.inbound_id) return false
        return true
      })
    },

    async save_inbound(input) {
      if (!live) return
      save_inbound.run(input.id, text(input))
    },

    async get_inbound(id) {
      return parse<InboundEvent>(get_inbound.get(id)?.data ?? null)
    },

    async save_job(input) {
      if (!live) return
      save_job.run(input.id, input.status, input.created_at, input.updated_at, text(input))
    },

    async get_job(id) {
      return parse<QueueJob>(get_job.get(id)?.data ?? null)
    },

    async claim_job() {
      const row = parse<QueueJob>(pick_job.get()?.data ?? null)
      if (!row || !live) return row
      const next = {
        ...row,
        status: "running" as const,
        updated_at: Date.now(),
      }
      save_job.run(next.id, next.status, next.created_at, next.updated_at, text(next))
      return next
    },

    async done_job(id) {
      if (!live) return
      const row = parse<QueueJob>(get_job.get(id)?.data ?? null)
      if (!row) return
      const next = {
        ...row,
        status: "done" as const,
        err: undefined,
        updated_at: Date.now(),
      }
      save_job.run(next.id, next.status, next.created_at, next.updated_at, text(next))
    },

    async fail_job(input) {
      if (!live) return
      const row = parse<QueueJob>(get_job.get(input.id)?.data ?? null)
      if (!row) return
      const next = {
        ...row,
        status: "failed" as const,
        err: input.err,
        updated_at: Date.now(),
      }
      save_job.run(next.id, next.status, next.created_at, next.updated_at, text(next))
    },

    async reset_jobs(input) {
      if (!live) return
      const time = Date.now()
      for (const row of list_job.all().flatMap((item) => {
        const row = parse<QueueJob>(item.data)
        return row ? [row] : []
      })) {
        if (!input.from.includes(row.status)) continue
        const next = {
          ...row,
          status: input.to,
          updated_at: time,
        }
        save_job.run(next.id, next.status, next.created_at, next.updated_at, text(next))
      }
    },

    async save_outbound(input) {
      if (!live) return
      save_outbound.run(input.task_id, text(input))
    },

    async get_outbound(task_id) {
      return parse<Outbound>(get_outbound.get(task_id)?.data ?? null)
    },

    async save_attachment(input) {
      if (!live) return
      save_attachment.run(
        attachment(input.message_id, input.key),
        input.message_id,
        input.key,
        text(input),
        input.updated_at,
      )
    },

    async get_attachment(input) {
      return parse<Attachment>(get_attachment.get(attachment(input.message_id, input.key))?.data ?? null)
    },

    async save_pending(input) {
      if (!live) return
      save_pending.run(input.session_id, text(input))
    },

    async get_pending(session_id) {
      return parse<Pending>(get_pending.get(session_id)?.data ?? null)
    },

    async drop_pending(session_id) {
      if (!live) return
      drop_pending.run(session_id)
    },

    async seen(val) {
      return !!get_seen.get(val)
    },

    async mark(val) {
      if (!live) return
      save_seen.run(val, Date.now())
    },

    async get_conn(name) {
      return parse<ConnState>(get_conn.get(name)?.data ?? null)
    },

    async set_conn(input) {
      if (!live) return
      save_conn.run(input.name, text(input))
    },

    async close() {
      if (!live) return
      live = false
      db.close(false)
    },
  }
}
