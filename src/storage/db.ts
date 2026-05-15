import type {
  Attachment,
  AssistantOutbound,
  ConnState,
  ImSession,
  InboundEvent,
  Outbound,
  Pending,
  PendingAttachment,
  QueueJob,
  RepoPref,
  SessionModelPref,
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

function parseRows<T>(rows: Array<{ data: string }>) {
  return rows.flatMap((row) => {
    const item = parse<T>(row.data)
    return item ? [item] : []
  })
}

function sortByCreatedAt<T extends { created_at: number }>(rows: T[]) {
  rows.sort((a, b) => a.created_at - b.created_at)
  return rows
}

function sortAssistantOutbounds(rows: AssistantOutbound[]) {
  rows.sort((a, b) => a.seq - b.seq || a.created_at - b.created_at || a.id.localeCompare(b.id))
  return rows
}

function taskPendingFromLegacy(task: Task, legacy: Pending, origin_message_id?: string): PendingAttachment {
  return {
    task_id: task.id,
    session_id: legacy.session_id,
    origin_inbound_id: legacy.inbound_id,
    origin_message_id: origin_message_id ?? task.reply_anchor_message_id,
    assets: legacy.assets,
    created_at: legacy.created_at,
    updated_at: legacy.updated_at,
  }
}

export function createMemoryStore(): Store {
  const sessionByMapKey = new Map<string, ImSession>()
  const sessionByOpencodeId = new Map<string, ImSession>()
  const sessionModelPrefs = new Map<string, SessionModelPref>()
  const prefs = new Map<string, RepoPref>()
  const tasks = new Map<string, Task>()
  const inboundEvents = new Map<string, InboundEvent>()
  const jobs = new Map<string, QueueJob>()
  const outboundByTaskId = new Map<string, Outbound>()
  const assistantOutboundById = new Map<string, AssistantOutbound>()
  const attachments = new Map<string, Attachment>()
  const legacyPendingBySessionId = new Map<string, Pending>()
  const taskPendingByTaskId = new Map<string, PendingAttachment>()
  const seen = new Set<string>()
  const conn = new Map<string, ConnState>()

  return {
    async get_session(input) {
      return sessionByMapKey.get(key(input.tenant_id, input.chat_id, input.thread_id)) ?? null
    },

    async get_session_by_opencode(session_id) {
      return sessionByOpencodeId.get(session_id) ?? null
    },

    async save_session(input) {
      const mapKey = key(input.tenant_id, input.chat_id, input.thread_id)
      const old = sessionByMapKey.get(mapKey)
      const hit = sessionByOpencodeId.get(input.session_id)
      if (old && old.session_id !== input.session_id) sessionByOpencodeId.delete(old.session_id)
      if (hit) {
        sessionByMapKey.delete(key(hit.tenant_id, hit.chat_id, hit.thread_id))
      }
      sessionByMapKey.set(mapKey, input)
      sessionByOpencodeId.set(input.session_id, input)
    },

    async get_session_model_pref(session_id) {
      return sessionModelPrefs.get(session_id) ?? null
    },

    async save_session_model_pref(session_id, input) {
      sessionModelPrefs.set(session_id, input)
    },

    async move_session_model_pref(from_session_id, to_session_id) {
      if (from_session_id === to_session_id) return
      const hit = sessionModelPrefs.get(from_session_id)
      if (!hit) return
      sessionModelPrefs.set(to_session_id, hit)
      sessionModelPrefs.delete(from_session_id)
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
      const rows = [...tasks.values()].filter((item) => item.inbound_id === inbound_id)
      sortByCreatedAt(rows)
      return rows.at(-1) ?? null
    },

    async get_last_task(session_id) {
      const rows = [...tasks.values()].filter((item) => item.session_id === session_id)
      sortByCreatedAt(rows)
      return rows.at(-1) ?? null
    },

    async get_task_by_req(req) {
      const rows = [...tasks.values()].filter((item) => item.req_id === req || item.req === req)
      sortByCreatedAt(rows)
      return rows.at(-1) ?? null
    },

    async list_tasks(input) {
      const rows = [...tasks.values()].filter((item) => {
        if (input?.status?.length && !input.status.includes(item.status)) return false
        if (input?.session_id && item.session_id !== input.session_id) return false
        if (input?.inbound_id && item.inbound_id !== input.inbound_id) return false
        return true
      })
      sortByCreatedAt(rows)
      return rows
    },

    async save_inbound(input) {
      inboundEvents.set(input.id, input)
    },

    async get_inbound(id) {
      return inboundEvents.get(id) ?? null
    },

    async save_job(input) {
      jobs.set(input.id, input)
    },

    async get_job(id) {
      return jobs.get(id) ?? null
    },

    async claim_job() {
      const rows = [...jobs.values()]
        .filter((item) => item.status === "queued")
        .sort((a, b) => a.created_at - b.created_at)
      const row = rows.at(0)
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
      outboundByTaskId.set(input.task_id, input)
    },

    async get_outbound(task_id) {
      return outboundByTaskId.get(task_id) ?? null
    },

    async save_assistant_outbound(input) {
      assistantOutboundById.set(input.id, input)
    },

    async get_assistant_outbound(id) {
      return assistantOutboundById.get(id) ?? null
    },

    async list_assistant_outbounds(task_id) {
      return sortAssistantOutbounds([...assistantOutboundById.values()].filter((item) => item.task_id === task_id))
    },

    async list_open_waits(task_id) {
      return sortAssistantOutbounds(
        [...assistantOutboundById.values()].filter((item) => item.task_id === task_id && item.state === "open"),
      )
    },

    async save_attachment(input) {
      attachments.set(attachment(input.message_id, input.key), input)
    },

    async get_attachment(input) {
      return attachments.get(attachment(input.message_id, input.key)) ?? null
    },

    async save_pending(input) {
      legacyPendingBySessionId.set(input.session_id, input)
    },

    async get_pending(session_id) {
      return legacyPendingBySessionId.get(session_id) ?? null
    },

    async drop_pending(session_id) {
      legacyPendingBySessionId.delete(session_id)
    },

    async save_task_pending(input) {
      taskPendingByTaskId.set(input.task_id, input)
    },

    async get_task_pending(task_id) {
      const hit = taskPendingByTaskId.get(task_id)
      if (hit) return hit
      const task = tasks.get(task_id)
      if (!task) return null
      const legacy = legacyPendingBySessionId.get(task.session_id)
      if (!legacy) return null
      const origin = inboundEvents.get(task.inbound_id)
      const migrated = taskPendingFromLegacy(task, legacy, origin?.message_id)
      taskPendingByTaskId.set(task_id, migrated)
      legacyPendingBySessionId.delete(task.session_id)
      return migrated
    },

    async drop_task_pending(task_id) {
      taskPendingByTaskId.delete(task_id)
      const task = tasks.get(task_id)
      if (task) legacyPendingBySessionId.delete(task.session_id)
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

  const getSessionStmt = db.query<{ data: string }, [string, string, string]>(
    "select data from im_session where tenant_id = ?1 and chat_id = ?2 and thread_id = ?3 limit 1",
  )
  const getSessionByOpencodeStmt = db.query<{ data: string }, [string]>(
    "select data from im_session where opencode_session_id = ?1 limit 1",
  )
  const getSessionMapStmt = db.query<{ opencode_session_id: string | null }, [string]>(
    "select opencode_session_id from im_session where map_key = ?1 limit 1",
  )
  const saveSessionStmt = db.query(
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
  const dropSessionStmt = db.query("delete from im_session where opencode_session_id = ?1")
  const getSessionModelPrefStmt = db.query<{ data: string }, [string]>(
    "select data from session_model_pref where opencode_session_id = ?1 limit 1",
  )
  const saveSessionModelPrefStmt = db.query(
    `
      insert into session_model_pref (opencode_session_id, data, updated_at)
      values (?1, ?2, ?3)
      on conflict(opencode_session_id) do update set
        data = excluded.data,
        updated_at = excluded.updated_at
    `,
  )
  const dropSessionModelPrefStmt = db.query("delete from session_model_pref where opencode_session_id = ?1")
  const getPrefStmt = db.query<{ data: string }, [string]>("select data from repo_pref where pref_key = ?1 limit 1")
  const savePrefStmt = db.query(
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
  const saveTaskStmt = db.query(
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
  const getTaskStmt = db.query<{ data: string }, [string]>("select data from task where id = ?1 limit 1")
  const getTaskByInboundStmt = db.query<{ data: string }, [string]>(
    "select data from task where json_extract(data, '$.inbound_id') = ?1 order by created_at desc limit 1",
  )
  const getLastTaskStmt = db.query<{ data: string }, [string]>(
    "select data from task where session_id = ?1 order by created_at desc limit 1",
  )
  const getTaskByReqStmt = db.query<{ data: string }, [string]>(
    "select data from task where req = ?1 order by created_at desc limit 1",
  )
  const listTasksStmt = db.query<{ data: string }, []>("select data from task order by created_at asc")
  const saveInboundStmt = db.query(
    `
      insert into inbound_event (id, data)
      values (?1, ?2)
      on conflict(id) do update set
        data = excluded.data
    `,
  )
  const getInboundStmt = db.query<{ data: string }, [string]>("select data from inbound_event where id = ?1 limit 1")
  const saveJobStmt = db.query(
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
  const getJobStmt = db.query<{ data: string }, [string]>("select data from queue_job where id = ?1 limit 1")
  const pickJobStmt = db.query<{ data: string }, []>(
    "select data from queue_job where status = 'queued' order by created_at asc limit 1",
  )
  const listJobStmt = db.query<{ data: string }, []>("select data from queue_job order by created_at asc")
  const saveOutboundStmt = db.query(
    `
      insert into outbound_message (task_id, data)
      values (?1, ?2)
      on conflict(task_id) do update set
        data = excluded.data
    `,
  )
  const getOutboundStmt = db.query<{ data: string }, [string]>(
    "select data from outbound_message where task_id = ?1 limit 1",
  )
  const saveAssistantOutboundStmt = db.query(
    `
      insert into assistant_outbound (
        id,
        task_id,
        session_id,
        seq,
        kind,
        action,
        state,
        req_key,
        terminal,
        created_at,
        updated_at,
        data
      ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      on conflict(id) do update set
        task_id = excluded.task_id,
        session_id = excluded.session_id,
        seq = excluded.seq,
        kind = excluded.kind,
        action = excluded.action,
        state = excluded.state,
        req_key = excluded.req_key,
        terminal = excluded.terminal,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        data = excluded.data
    `,
  )
  const getAssistantOutboundStmt = db.query<{ data: string }, [string]>(
    "select data from assistant_outbound where id = ?1 limit 1",
  )
  const listAssistantOutboundsStmt = db.query<{ data: string }, [string]>(
    "select data from assistant_outbound where task_id = ?1 order by seq asc, created_at asc",
  )
  const listOpenWaitsStmt = db.query<{ data: string }, [string]>(
    "select data from assistant_outbound where task_id = ?1 and state = 'open' order by seq asc, created_at asc",
  )
  const saveAttachmentStmt = db.query(
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
  const getAttachmentStmt = db.query<{ data: string }, [string]>(
    "select data from attachment where attachment_key = ?1 limit 1",
  )
  const savePendingStmt = db.query(
    `
      insert into pending_attachment (session_id, data)
      values (?1, ?2)
      on conflict(session_id) do update set
        data = excluded.data
    `,
  )
  const getPendingStmt = db.query<{ data: string }, [string]>(
    "select data from pending_attachment where session_id = ?1 limit 1",
  )
  const dropPendingStmt = db.query("delete from pending_attachment where session_id = ?1")
  const saveTaskPendingStmt = db.query(
    `
      insert into pending_attachment_task (task_id, session_id, created_at, updated_at, data)
      values (?1, ?2, ?3, ?4, ?5)
      on conflict(task_id) do update set
        session_id = excluded.session_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        data = excluded.data
    `,
  )
  const getTaskPendingStmt = db.query<{ data: string }, [string]>(
    "select data from pending_attachment_task where task_id = ?1 limit 1",
  )
  const dropTaskPendingStmt = db.query("delete from pending_attachment_task where task_id = ?1")
  const getSeenStmt = db.query<{ key: string }, [string]>("select key from seen_event where key = ?1 limit 1")
  const saveSeenStmt = db.query(
    `
      insert into seen_event (key, created_at)
      values (?1, ?2)
      on conflict(key) do nothing
    `,
  )
  const saveConnStmt = db.query(
    `
      insert into conn_state (name, data)
      values (?1, ?2)
      on conflict(name) do update set
        data = excluded.data
    `,
  )
  const getConnStmt = db.query<{ data: string }, [string]>("select data from conn_state where name = ?1 limit 1")

  const readTask = (id: string) => parse<Task>(getTaskStmt.get(id)?.data ?? null)
  const readInbound = (id: string) => parse<InboundEvent>(getInboundStmt.get(id)?.data ?? null)
  const readLegacyPending = (session_id: string) => parse<Pending>(getPendingStmt.get(session_id)?.data ?? null)

  const migrateLegacyPending = (task_id: string) => {
    const task = readTask(task_id)
    if (!task) return null
    const legacy = readLegacyPending(task.session_id)
    if (!legacy) return null
    const origin = readInbound(task.inbound_id)
    const migrated = taskPendingFromLegacy(task, legacy, origin?.message_id)
    if (live) {
      saveTaskPendingStmt.run(
        migrated.task_id,
        migrated.session_id ?? null,
        migrated.created_at,
        migrated.updated_at,
        text(migrated),
      )
      dropPendingStmt.run(task.session_id)
    }
    return migrated
  }

  return {
    async get_session(input) {
      return parse<ImSession>(getSessionStmt.get(input.tenant_id, input.chat_id, input.thread_id ?? "")?.data ?? null)
    },

    async get_session_by_opencode(session_id) {
      return parse<ImSession>(getSessionByOpencodeStmt.get(session_id)?.data ?? null)
    },

    async save_session(input) {
      if (!live) return
      const mapKey = key(input.tenant_id, input.chat_id, input.thread_id)
      const old = getSessionMapStmt.get(mapKey)?.opencode_session_id
      dropSessionStmt.run(input.session_id)
      if (old && old !== input.session_id) dropSessionStmt.run(old)
      saveSessionStmt.run(
        mapKey,
        input.session_id,
        input.tenant_id,
        input.chat_id,
        input.thread_id ?? "",
        text(input),
        input.updated_at,
      )
    },

    async get_session_model_pref(session_id) {
      return parse<SessionModelPref>(getSessionModelPrefStmt.get(session_id)?.data ?? null)
    },

    async save_session_model_pref(session_id, input) {
      if (!live) return
      saveSessionModelPrefStmt.run(session_id, text(input), Date.now())
    },

    async move_session_model_pref(from_session_id, to_session_id) {
      if (!live || from_session_id === to_session_id) return
      const hit = getSessionModelPrefStmt.get(from_session_id)?.data ?? null
      if (!hit) return
      saveSessionModelPrefStmt.run(to_session_id, hit, Date.now())
      dropSessionModelPrefStmt.run(from_session_id)
    },

    async get_pref(input) {
      return parse<RepoPref>(getPrefStmt.get(pref(input.scope, input.tenant_id, input.chat_id, input.user_id))?.data ?? null)
    },

    async save_pref(input) {
      if (!live) return
      savePrefStmt.run(
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
      saveTaskStmt.run(input.id, input.session_id, input.req_id ?? input.req ?? null, input.created_at, text(input))
    },

    async get_task(id) {
      return readTask(id)
    },

    async get_task_by_inbound(inbound_id) {
      return parse<Task>(getTaskByInboundStmt.get(inbound_id)?.data ?? null)
    },

    async get_last_task(session_id) {
      return parse<Task>(getLastTaskStmt.get(session_id)?.data ?? null)
    },

    async get_task_by_req(req) {
      return parse<Task>(getTaskByReqStmt.get(req)?.data ?? null)
    },

    async list_tasks(input) {
      const rows = parseRows<Task>(listTasksStmt.all())
      return rows.filter((item) => {
        if (input?.status?.length && !input.status.includes(item.status)) return false
        if (input?.session_id && item.session_id !== input.session_id) return false
        if (input?.inbound_id && item.inbound_id !== input.inbound_id) return false
        return true
      })
    },

    async save_inbound(input) {
      if (!live) return
      saveInboundStmt.run(input.id, text(input))
    },

    async get_inbound(id) {
      return readInbound(id)
    },

    async save_job(input) {
      if (!live) return
      saveJobStmt.run(input.id, input.status, input.created_at, input.updated_at, text(input))
    },

    async get_job(id) {
      return parse<QueueJob>(getJobStmt.get(id)?.data ?? null)
    },

    async claim_job() {
      const row = parse<QueueJob>(pickJobStmt.get()?.data ?? null)
      if (!row || !live) return row
      const next = {
        ...row,
        status: "running" as const,
        updated_at: Date.now(),
      }
      saveJobStmt.run(next.id, next.status, next.created_at, next.updated_at, text(next))
      return next
    },

    async done_job(id) {
      if (!live) return
      const row = parse<QueueJob>(getJobStmt.get(id)?.data ?? null)
      if (!row) return
      const next = {
        ...row,
        status: "done" as const,
        err: undefined,
        updated_at: Date.now(),
      }
      saveJobStmt.run(next.id, next.status, next.created_at, next.updated_at, text(next))
    },

    async fail_job(input) {
      if (!live) return
      const row = parse<QueueJob>(getJobStmt.get(input.id)?.data ?? null)
      if (!row) return
      const next = {
        ...row,
        status: "failed" as const,
        err: input.err,
        updated_at: Date.now(),
      }
      saveJobStmt.run(next.id, next.status, next.created_at, next.updated_at, text(next))
    },

    async reset_jobs(input) {
      if (!live) return
      const time = Date.now()
      for (const row of parseRows<QueueJob>(listJobStmt.all())) {
        if (!input.from.includes(row.status)) continue
        const next = {
          ...row,
          status: input.to,
          updated_at: time,
        }
        saveJobStmt.run(next.id, next.status, next.created_at, next.updated_at, text(next))
      }
    },

    async save_outbound(input) {
      if (!live) return
      saveOutboundStmt.run(input.task_id, text(input))
    },

    async get_outbound(task_id) {
      return parse<Outbound>(getOutboundStmt.get(task_id)?.data ?? null)
    },

    async save_assistant_outbound(input) {
      if (!live) return
      saveAssistantOutboundStmt.run(
        input.id,
        input.task_id,
        input.session_id,
        input.seq,
        input.kind,
        input.action,
        input.state,
        input.req_key ?? null,
        input.terminal ? 1 : 0,
        input.created_at,
        input.updated_at,
        text(input),
      )
    },

    async get_assistant_outbound(id) {
      return parse<AssistantOutbound>(getAssistantOutboundStmt.get(id)?.data ?? null)
    },

    async list_assistant_outbounds(task_id) {
      return parseRows<AssistantOutbound>(listAssistantOutboundsStmt.all(task_id))
    },

    async list_open_waits(task_id) {
      return parseRows<AssistantOutbound>(listOpenWaitsStmt.all(task_id))
    },

    async save_attachment(input) {
      if (!live) return
      saveAttachmentStmt.run(
        attachment(input.message_id, input.key),
        input.message_id,
        input.key,
        text(input),
        input.updated_at,
      )
    },

    async get_attachment(input) {
      return parse<Attachment>(getAttachmentStmt.get(attachment(input.message_id, input.key))?.data ?? null)
    },

    async save_pending(input) {
      if (!live) return
      savePendingStmt.run(input.session_id, text(input))
    },

    async get_pending(session_id) {
      return readLegacyPending(session_id)
    },

    async drop_pending(session_id) {
      if (!live) return
      dropPendingStmt.run(session_id)
    },

    async save_task_pending(input) {
      if (!live) return
      saveTaskPendingStmt.run(input.task_id, input.session_id ?? null, input.created_at, input.updated_at, text(input))
    },

    async get_task_pending(task_id) {
      const hit = parse<PendingAttachment>(getTaskPendingStmt.get(task_id)?.data ?? null)
      if (hit) return hit
      return migrateLegacyPending(task_id)
    },

    async drop_task_pending(task_id) {
      if (!live) return
      dropTaskPendingStmt.run(task_id)
      const task = readTask(task_id)
      if (task) dropPendingStmt.run(task.session_id)
    },

    async seen(val) {
      return !!getSeenStmt.get(val)
    },

    async mark(val) {
      if (!live) return
      saveSeenStmt.run(val, Date.now())
    },

    async get_conn(name) {
      return parse<ConnState>(getConnStmt.get(name)?.data ?? null)
    },

    async set_conn(input) {
      if (!live) return
      saveConnStmt.run(input.name, text(input))
    },

    async close() {
      if (!live) return
      live = false
      db.close(false)
    },
  }
}
