/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { on_card_action } from "../src/app/boot.ts"
import type { FeishuApi, ImSession, InboundCardAction, InboundMessage, OpencodeResult, OpencodeStatus, OpencodeSvc, RenderOut, Task } from "../src/contracts.ts"
import { createTaskSvc } from "../src/gateway/task.ts"
import { createRender } from "../src/render/text.ts"
import { createMemoryStore } from "../src/storage/db.ts"

type ApprovalCardAction = Extract<InboundCardAction, { action: "approval" }>
type QuestionCardAction = Extract<InboundCardAction, { action: "question" }>

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
    text: "",
    message_id: "msg_1",
    assets: [],
    mentions: [],
    ...input,
  }
}

function approvalCardAction(input?: Partial<ApprovalCardAction>): ApprovalCardAction {
  return {
    id: "in_card_1",
    platform: "feishu",
    kind: "card_action",
    event_id: "evt_card_1",
    tenant_id: "tenant",
    chat_id: "chat",
    user_id: "user",
    message_id: "out_1",
    raw: {},
    created_at: 1,
    action: "approval",
    req: "req_1",
    reply: "once",
    ...input,
  }
}

function questionCardAction(input?: Partial<QuestionCardAction>): QuestionCardAction {
  return {
    id: "in_card_q_1",
    platform: "feishu",
    kind: "card_action",
    event_id: "evt_card_q_1",
    tenant_id: "tenant",
    chat_id: "chat",
    user_id: "user",
    message_id: "out_q_1",
    raw: {},
    created_at: 1,
    action: "question",
    req: "req_1",
    answers: [["A"]],
    ...input,
  }
}

function row(input?: Partial<Task>): Task {
  return {
    id: "tsk_1",
    im_session_id: "ims_1",
    session_id: "ses_1",
    inbound_id: "in_1",
    status: "running",
    created_at: 1,
    updated_at: 1,
    ...input,
  }
}

function session(input?: Partial<ImSession>): ImSession {
  return {
    id: "ims_1",
    platform: "feishu",
    tenant_id: "tenant",
    chat_id: "chat",
    user_id: "user",
    session_id: "ses_1",
    directory: "/tmp",
    state: "active",
    created_at: 1,
    updated_at: 1,
    ...input,
  }
}

function feishu() {
  const list: Array<{ kind: "send" | "reply" | "patch"; out: RenderOut }> = []
  return {
    api: {
      async send(item) {
        list.push({ kind: "send", out: item.out })
        return { id: "out_send" }
      },
      async reply(item) {
        list.push({ kind: "reply", out: item.out })
        return { id: "out_reply" }
      },
      async patch(item) {
        list.push({ kind: "patch", out: item.out })
      },
      async fetch() {
        throw new Error("not used")
      },
      async sync() {},
      names() {
        return []
      },
    } satisfies FeishuApi,
    list,
  }
}

function opencode(input?: { status?: Record<string, OpencodeStatus> | null; last?: string | undefined; result?: OpencodeResult }) {
  const svc = {
    async ensure() {
      return { id: "ses_1" }
    },
    async session() {
      return null
    },
    async sessions() {
      return []
    },
    async workspaces() {
      return []
    },
    async status(_payload: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>> {
      if (input?.status === null) throw new Error("status failed")
      return input?.status ?? {}
    },
    async commands() {
      return []
    },
    async skills() {
      return []
    },
    async agents() {
      return []
    },
    async providers() {
      return []
    },
    async mcps() {
      return []
    },
    async prompt() {},
    async abort() {},
    async allow() {},
    async answer() {},
    async reject() {},
    async command() {
      return undefined
    },
    async last() {
      return input?.last
    },
    async result() {
      if (input?.result) return input.result
      if (input?.last) return { state: "ok" as const, text: input.last }
      return { state: "empty" as const }
    },
  } satisfies OpencodeSvc
  return svc
}

async function saveWait(store: ReturnType<typeof createMemoryStore>, input: {
  id: string
  inbound_id: string
  status: Task["status"]
  req: string
  kind: "approval" | "question"
  payload: Record<string, unknown>
  outbound_id?: string
  seq?: number
  created_at?: number
  updated_at?: number
}) {
  await store.save_inbound(
    inbound({
      id: input.inbound_id,
      event_id: `evt_${input.inbound_id}`,
      message_id: `msg_${input.inbound_id}`,
    }),
  )
  const taskRow = row({
    id: input.id,
    inbound_id: input.inbound_id,
    status: input.status,
    req_type: input.kind === "approval" ? "permission" : "question",
    req: input.req,
    req_id: input.req,
    outbound_id: input.outbound_id,
    created_at: input.created_at,
    updated_at: input.updated_at,
  })
  const action: "reply" | "patch" = input.outbound_id ? "patch" : "reply"
  await store.save_task(taskRow)
  await store.save_assistant_outbound({
    id: `aso_${input.id}_${input.req}`,
    task_id: input.id,
    session_id: taskRow.session_id,
    seq: input.seq ?? 1,
    kind: input.kind,
    action,
    state: "open",
    origin_inbound_id: input.inbound_id,
    origin_message_id: `msg_${input.inbound_id}`,
    req_key: input.req,
    terminal: false,
    feishu_message_id: input.outbound_id,
    payload: input.payload,
    created_at: input.created_at ?? 1,
    updated_at: input.updated_at ?? 1,
  })
}

describe("on_card_action", () => {
  test("approval callback resolves current visible wait and surfaces next queued approval", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await saveWait(store, {
      id: "tsk_card_perm_1",
      inbound_id: "in_card_perm_1",
      status: "waiting_permission",
      req: "req_card_perm_1",
      kind: "approval",
      outbound_id: "out_card_perm_1",
      payload: {
        tool: "external_directory",
        detail: JSON.stringify({ filepath: "/tmp" }),
      },
      seq: 1,
    })
    await store.save_inbound(inbound({ id: "in_card_perm_2", event_id: "evt_card_perm_2", message_id: "msg_card_perm_2" }))
    await store.save_assistant_outbound({
      id: "aso_tsk_card_perm_1_req_card_perm_2",
      task_id: "tsk_card_perm_1",
      session_id: "ses_1",
      seq: 2,
      kind: "approval",
      action: "deferred",
      state: "open",
      origin_inbound_id: "in_card_perm_1",
      origin_message_id: "msg_in_card_perm_1",
      req_key: "req_card_perm_2",
      terminal: false,
      payload: {
        tool: "external_directory",
        detail: JSON.stringify({ filepath: "/usr" }),
      },
      created_at: 2,
      updated_at: 2,
    })
    const calls: Array<{ req: string; reply: "once" | "always" | "reject" }> = []
    const oc = {
      ...opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      async allow(input) {
        calls.push({ req: input.req, reply: input.reply })
      },
    } satisfies OpencodeSvc

    const ok = await on_card_action(
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      approvalCardAction({
        req: "req_card_perm_1",
        message_id: "out_card_perm_1",
        reply: "always",
      }),
    )

    expect(ok).toBeTrue()
    expect(calls).toEqual([{ req: "req_card_perm_1", reply: "always" }])
    expect((await store.get_task("tsk_card_perm_1"))?.status).toBe("waiting_permission")
    expect((await store.get_task("tsk_card_perm_1"))?.req).toBe("req_card_perm_2")
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
        body: {
          type: "approval",
          req: "req_card_perm_2",
        },
      },
    })
  })

  test("question callback resolves current visible wait and answers without creating new task", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await saveWait(store, {
      id: "tsk_card_q_1",
      inbound_id: "in_card_q_1",
      status: "waiting_question",
      req: "req_card_q_1",
      kind: "question",
      outbound_id: "out_card_q_1",
      payload: {
        title: "请选择",
        opts: ["A", "B"],
        custom: false,
      },
      seq: 1,
    })
    const calls: Array<{ req: string; answers: string[][] }> = []
    const oc = {
      ...opencode(),
      async answer(input) {
        calls.push({ req: input.req, answers: input.answers })
      },
    } satisfies OpencodeSvc

    const ok = await on_card_action(
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      questionCardAction({
        req: "req_card_q_1",
        message_id: "out_card_q_1",
        answers: [["B"]],
      }),
    )

    expect(ok).toBeTrue()
    expect(calls).toEqual([{ req: "req_card_q_1", answers: [["B"]] }])
    expect((await store.get_task("tsk_card_q_1"))?.status).toBe("running")
    expect(await store.list_tasks({ session_id: "ses_1" })).toHaveLength(1)
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          title: "OpenCode",
          template: "blue",
          text: "已提交补充信息",
        },
      },
    })
  })

  test("approval callback treats invalid stored task workspace as unscoped instead of inheriting session workspace", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_remote" }))
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_permission",
        req_type: "permission",
        req: "req_invalid_scope",
        req_id: "req_invalid_scope",
        outbound_id: "out_invalid_scope",
        workspace_id: "ws_bad",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/tmp" }))}`,
      }),
    )
    const calls: Array<{ req: string; reply: "once" | "always" | "reject"; workspace?: string }> = []
    const oc = {
      ...opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      async allow(input) {
        calls.push({ req: input.req, reply: input.reply, workspace: input.workspace })
      },
    } satisfies OpencodeSvc

    const ok = await on_card_action(
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      approvalCardAction({
        req: "req_invalid_scope",
        message_id: "out_invalid_scope",
        reply: "once",
      }),
    )

    expect(ok).toBeTrue()
    expect(calls).toEqual([
      {
        req: "req_invalid_scope",
        reply: "once",
        workspace: undefined,
      },
    ])
  })

  test("stale card callback does not mutate background or replaced wait", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        id: "tsk_card_old",
        status: "waiting_permission",
        req_type: "permission",
        req: "req_card_old",
        req_id: "req_card_old",
        outbound_id: "out_card_old",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/tmp" }))}`,
      }),
    )
    await store.save_session(session({ session_id: "ses_2" }))
    await store.save_inbound(inbound({ id: "in_bg", event_id: "evt_bg", message_id: "msg_bg" }))
    await saveWait(store, {
      id: "tsk_card_new",
      inbound_id: "in_bg",
      status: "waiting_permission",
      req: "req_card_new",
      kind: "approval",
      outbound_id: "out_card_new",
      payload: {
        tool: "external_directory",
        detail: JSON.stringify({ filepath: "/usr" }),
      },
      seq: 1,
    })
    const calls: Array<{ req: string; reply: "once" | "always" | "reject" }> = []
    const oc = {
      ...opencode(),
      async allow(input) {
        calls.push({ req: input.req, reply: input.reply })
      },
    } satisfies OpencodeSvc

    const staleReq = await on_card_action(
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      approvalCardAction({
        req: "req_card_old",
        message_id: "out_card_old",
        reply: "once",
      }),
    )
    const staleMsg = await on_card_action(
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      approvalCardAction({
        req: "req_card_new",
        message_id: "out_other",
        reply: "once",
      }),
    )

    expect(staleReq).toBeFalse()
    expect(staleMsg).toBeFalse()
    expect(calls).toEqual([])
    expect((await store.get_task("tsk_card_old"))?.status).toBe("waiting_permission")
    expect((await store.get_task("tsk_card_new"))?.status).toBe("waiting_permission")
    expect(ui.list).toEqual([])
  })
})
