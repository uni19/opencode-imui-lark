import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import path from "node:path"
import type {
  Attachment,
  AssistantOutbound,
  ConnState,
  ImSession,
  InboundMessage,
  Outbound,
  Pending,
  PendingAttachment,
  QueueJob,
  RepoPref,
  Task,
} from "../src/contracts.ts"
import { createSqliteStore } from "../src/storage/db.ts"

function file() {
  return path.join("/tmp", `opencode-feishu-imui-${crypto.randomUUID()}.sqlite`)
}

function session(input?: Partial<ImSession>): ImSession {
  return {
    id: "ims_1",
    platform: "feishu",
    tenant_id: "tenant",
    chat_id: "chat",
    user_id: "user",
    session_id: "ses_1",
    directory: "/tmp/work",
    workspace_id: "ws_1",
    state: "active",
    created_at: 1,
    updated_at: 1,
    ...input,
  }
}

function inbound(input?: Partial<InboundMessage>): InboundMessage {
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
    ...input,
  }
}

function task(input?: Partial<Task>): Task {
  return {
    id: "tsk_1",
    im_session_id: "ims_1",
    session_id: "ses_1",
    inbound_id: "in_1",
    reply_anchor_message_id: "msg_1",
    directory: "/tmp/work",
    workspace_id: "ws_1",
    status: "running",
    created_at: 1,
    updated_at: 1,
    ...input,
  }
}

describe("sqlite store", () => {
  test("persists runtime state across reopen", async () => {
    const db = file()
    const a = createSqliteStore(db)
    const ses = session()
    const pref = {
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/repo",
      workspace_id: "ws_repo",
    } satisfies RepoPref
    const row = task({
      req: "req_1",
      req_id: "req_1",
      note: "note",
      outbound_id: "out_1",
      status_outbound_id: "out_status_1",
    })
    const out = {
      task_id: row.id,
      msg_id: "out_1",
      kind: "card",
      payload: {
        title: "OpenCode",
      },
      created_at: 1,
      updated_at: 2,
    } satisfies Outbound
    const firstAssistantOutbound = {
      id: "aso_1",
      task_id: row.id,
      session_id: row.session_id,
      seq: 1,
      kind: "question",
      action: "reply",
      state: "open",
      origin_inbound_id: row.inbound_id,
      origin_message_id: "msg_1",
      req_key: "req_1",
      terminal: false,
      feishu_message_id: "out_1",
      payload: { title: "Need input" },
      created_at: 2,
      updated_at: 2,
    } satisfies AssistantOutbound
    const secondAssistantOutbound = {
      id: "aso_2",
      task_id: row.id,
      session_id: row.session_id,
      seq: 3,
      kind: "final",
      action: "reply",
      state: "resolved",
      origin_inbound_id: row.inbound_id,
      origin_message_id: "msg_1",
      terminal: true,
      feishu_message_id: "out_2",
      payload: { title: "Done" },
      created_at: 4,
      updated_at: 4,
    } satisfies AssistantOutbound
    const thirdAssistantOutbound = {
      id: "aso_3",
      task_id: row.id,
      session_id: row.session_id,
      seq: 2,
      kind: "progress",
      action: "patch",
      state: "emitted",
      origin_inbound_id: row.inbound_id,
      origin_message_id: "msg_1",
      terminal: false,
      feishu_message_id: "out_1",
      payload: { title: "Working" },
      created_at: 3,
      updated_at: 3,
    } satisfies AssistantOutbound
    const asset = {
      message_id: "msg_1",
      key: "img_1",
      asset: {
        kind: "image",
        key: "img_1",
        name: "cat.png",
        path: "/tmp/cat.png",
      },
      created_at: 1,
      updated_at: 2,
    } satisfies Attachment
    const hold = {
      session_id: ses.session_id,
      inbound_id: "in_1",
      assets: [
        {
          kind: "file",
          key: "file_1",
          name: "report.pdf",
        },
      ],
      created_at: 1,
      updated_at: 2,
    } satisfies Pending
    const taskHold = {
      task_id: row.id,
      session_id: row.session_id,
      origin_inbound_id: row.inbound_id,
      origin_message_id: "msg_1",
      assets: [
        {
          kind: "file",
          key: "file_task_1",
          name: "task-report.pdf",
        },
      ],
      created_at: 2,
      updated_at: 4,
    } satisfies PendingAttachment
    const job = {
      id: "in_1",
      status: "queued",
      created_at: 1,
      updated_at: 2,
    } satisfies QueueJob
    const conn = {
      name: "opencode",
      status: "ready",
      updated_at: 3,
      attempt: 2,
      wait_ms: 4000,
    } satisfies ConnState

    await a.save_session(ses)
    await a.save_pref(pref)
    await a.save_inbound(inbound())
    await a.save_task(row)
    await a.save_outbound(out)
    await a.save_assistant_outbound(secondAssistantOutbound)
    await a.save_assistant_outbound(firstAssistantOutbound)
    await a.save_assistant_outbound(thirdAssistantOutbound)
    await a.save_attachment(asset)
    await a.save_pending(hold)
    await a.save_task_pending(taskHold)
    await a.save_job(job)
    await a.mark("evt_1")
    await a.set_conn(conn)
    await a.close?.()

    const b = createSqliteStore(db)

    expect(await b.get_session({ tenant_id: "tenant", chat_id: "chat" })).toMatchObject(ses)
    expect(await b.get_session_by_opencode("ses_1")).toMatchObject(ses)
    expect(await b.get_pref({ scope: "chat", tenant_id: "tenant", chat_id: "chat" })).toMatchObject(pref)
    expect(await b.get_inbound("in_1")).toMatchObject({
      message_id: "msg_1",
    })
    expect(await b.get_task("tsk_1")).toMatchObject(row)
    expect(await b.get_task_by_inbound("in_1")).toMatchObject(row)
    expect(await b.get_task_by_req("req_1")).toMatchObject(row)
    expect(await b.get_outbound("tsk_1")).toMatchObject(out)
    expect(await b.get_assistant_outbound("aso_2")).toMatchObject(secondAssistantOutbound)
    expect(await b.get_assistant_outbound("aso_3")).toMatchObject(thirdAssistantOutbound)
    expect(await b.list_assistant_outbounds("tsk_1")).toMatchObject([
      firstAssistantOutbound,
      thirdAssistantOutbound,
      secondAssistantOutbound,
    ])
    expect(await b.list_open_waits("tsk_1")).toMatchObject([firstAssistantOutbound])
    expect(await b.get_attachment({ message_id: "msg_1", key: "img_1" })).toMatchObject(asset)
    expect(await b.get_pending("ses_1")).toMatchObject(hold)
    expect(await b.get_task_pending("tsk_1")).toMatchObject(taskHold)
    expect(await b.get_job("in_1")).toMatchObject(job)
    expect(await b.get_conn("opencode")).toMatchObject(conn)
    expect(await b.seen("evt_1")).toBe(true)
    await b.close?.()
  })

  test("lazily migrates legacy session-owned pending attachments", async () => {
    const db = file()
    const raw = new Database(db, { create: true, strict: true })
    const legacyTask = task({
      id: "tsk_legacy",
      session_id: "ses_legacy",
      inbound_id: "in_legacy",
      reply_anchor_message_id: "msg_legacy",
      created_at: 11,
      updated_at: 11,
    })
    const legacyInbound = inbound({
      id: "in_legacy",
      event_id: "evt_legacy",
      message_id: "msg_legacy",
      created_at: 11,
      text: "legacy",
    })
    const legacyPending = {
      session_id: "ses_legacy",
      inbound_id: "in_legacy",
      assets: [
        {
          kind: "image",
          key: "img_legacy",
          name: "legacy.png",
        },
      ],
      created_at: 12,
      updated_at: 13,
    } satisfies Pending

    try {
      raw.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE task (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          req TEXT,
          created_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE inbound_event (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
        CREATE TABLE pending_attachment (
          session_id TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
      `)
      raw
        .query("insert into task (id, session_id, req, created_at, data) values (?1, ?2, ?3, ?4, ?5)")
        .run(legacyTask.id, legacyTask.session_id, null, legacyTask.created_at, JSON.stringify(legacyTask))
      raw.query("insert into inbound_event (id, data) values (?1, ?2)").run(legacyInbound.id, JSON.stringify(legacyInbound))
      raw
        .query("insert into pending_attachment (session_id, data) values (?1, ?2)")
        .run(legacyPending.session_id, JSON.stringify(legacyPending))
    } finally {
      raw.close(false)
    }

    const store = createSqliteStore(db)

    expect(await store.get_pending("ses_legacy")).toMatchObject(legacyPending)

    const migrated = await store.get_task_pending("tsk_legacy")

    expect(migrated).toMatchObject({
      task_id: "tsk_legacy",
      session_id: "ses_legacy",
      origin_inbound_id: "in_legacy",
      origin_message_id: "msg_legacy",
      assets: legacyPending.assets,
      created_at: legacyPending.created_at,
      updated_at: legacyPending.updated_at,
    } satisfies PendingAttachment)
    expect(await store.get_pending("ses_legacy")).toBeNull()
    await store.close?.()

    const reopened = createSqliteStore(db)
    expect(await reopened.get_task_pending("tsk_legacy")).toMatchObject(migrated!)
    expect(await reopened.get_pending("ses_legacy")).toBeNull()
    await reopened.close?.()
  })

  test("keeps only the latest session mapping", async () => {
    const db = createSqliteStore(file())
    const old = session({
      id: "ims_old",
      session_id: "ses_old",
      directory: "/tmp/old",
      updated_at: 1,
    })
    const next = session({
      id: "ims_new",
      session_id: "ses_new",
      directory: "/tmp/new",
      updated_at: 2,
    })
    const moved = session({
      id: "ims_new",
      session_id: "ses_new",
      chat_id: "chat_2",
      directory: "/tmp/moved",
      updated_at: 3,
    })

    await db.save_session(old)
    await db.save_session(next)

    expect(await db.get_session({ tenant_id: "tenant", chat_id: "chat" })).toMatchObject(next)
    expect(await db.get_session_by_opencode("ses_old")).toBeNull()

    await db.save_session(moved)

    expect(await db.get_session({ tenant_id: "tenant", chat_id: "chat" })).toBeNull()
    expect(await db.get_session({ tenant_id: "tenant", chat_id: "chat_2" })).toMatchObject(moved)
    expect(await db.get_session_by_opencode("ses_new")).toMatchObject(moved)
    await db.close?.()
  })

  test("persists queue transitions and reset semantics", async () => {
    const db = file()
    const a = createSqliteStore(db)

    await a.save_job({
      id: "job_1",
      status: "queued",
      created_at: 1,
      updated_at: 1,
    })
    await a.save_job({
      id: "job_2",
      status: "running",
      created_at: 2,
      updated_at: 2,
    })

    expect(await a.claim_job()).toMatchObject({
      id: "job_1",
      status: "running",
    })

    await a.fail_job({
      id: "job_1",
      err: "boom",
    })
    await a.reset_jobs({
      from: ["running", "failed"],
      to: "queued",
    })
    await a.done_job("job_2")
    await a.close?.()

    const b = createSqliteStore(db)

    expect(await b.get_job("job_1")).toMatchObject({
      status: "queued",
    })
    expect(await b.get_job("job_2")).toMatchObject({
      status: "done",
    })
    expect(await b.claim_job()).toMatchObject({
      id: "job_1",
      status: "running",
    })
    await b.close?.()
  })
})
