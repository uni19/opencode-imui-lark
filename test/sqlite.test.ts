import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import path from "node:path"
import type { Attachment, ConnState, ImSession, InboundMessage, Outbound, Pending, QueueJob, RepoPref, Task } from "../src/contracts.ts"
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
      note: "note",
      outbound_id: "out_1",
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
    await a.save_attachment(asset)
    await a.save_pending(hold)
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
    expect(await b.get_attachment({ message_id: "msg_1", key: "img_1" })).toMatchObject(asset)
    expect(await b.get_pending("ses_1")).toMatchObject(hold)
    expect(await b.get_job("in_1")).toMatchObject(job)
    expect(await b.get_conn("opencode")).toMatchObject(conn)
    expect(await b.seen("evt_1")).toBe(true)
    await b.close?.()
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
