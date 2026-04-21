/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { on_event } from "../src/app/boot.ts"
import { done_msg } from "../src/app/text.ts"
import type {
  FeishuApi,
  ImSession,
  InboundMessage,
  OpencodeEvent,
  OpencodeResult,
  OpencodeSvc,
  RenderOut,
  Task,
} from "../src/contracts.ts"
import { createTaskSvc } from "../src/gateway/task.ts"
import { createRender } from "../src/render/text.ts"
import { createMemoryStore } from "../src/storage/db.ts"

function inbound(id: string): InboundMessage {
  return {
    id,
    platform: "feishu",
    kind: "message",
    event_id: "evt_" + id,
    tenant_id: "tenant",
    chat_id: "chat",
    user_id: "user",
    raw: {},
    created_at: 1,
    text: "hello",
    message_id: "msg_" + id,
    assets: [],
    mentions: [],
  }
}

function session(id: string): ImSession {
  return {
    id: "ims_" + id,
    platform: "feishu",
    tenant_id: "tenant",
    chat_id: "chat",
    user_id: "user",
    session_id: id,
    directory: "/tmp",
    state: "active",
    created_at: 1,
    updated_at: 1,
  }
}

function row(id: string, session_id: string, inbound_id: string, status: Task["status"] = "running"): Task {
  return {
    id,
    im_session_id: "ims_" + session_id,
    session_id,
    inbound_id,
    status,
    created_at: 1,
    updated_at: 1,
  }
}

function feishu() {
  const list: Array<{ kind: "send" | "reply" | "patch"; out: RenderOut }> = []
  return {
    api: {
      async send(input) {
        list.push({ kind: "send", out: input.out })
        return { id: "out_send" }
      },
      async reply(input) {
        list.push({ kind: "reply", out: input.out })
        return { id: "out_reply" }
      },
      async patch(input) {
        list.push({ kind: "patch", out: input.out })
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

function opencode(last?: string, result?: OpencodeResult) {
  return {
    async ensure() {
      return { id: "ses_1" }
    },
    async session() {
      return null
    },
    async sessions() {
      return []
    },
    async status() {
      return {}
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
      return last
    },
    async result() {
      return result ?? (last ? { state: "ok", text: last } : { state: "empty" })
    },
  } satisfies OpencodeSvc
}

describe("on_event", () => {
  test("turns permission event into waiting_permission with approval card", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_1")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_1"))
    await store.save_task(row("tsk_1", ses.session_id, "in_1"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_1",
        permission: "external_directory",
        metadata: {
          filepath: "/tmp",
        },
      },
    } satisfies OpencodeEvent)

    expect(await store.get_task("tsk_1")).toMatchObject({
      status: "waiting_permission",
      req_type: "permission",
      req: "req_1",
    })
    expect((await store.get_task("tsk_1"))?.note).toStartWith("approval:")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            type: "approval",
            title: "权限审批",
            req: "req_1",
            tool: "external_directory",
            detail: JSON.stringify({
              filepath: "/tmp",
            }),
          },
        },
      },
    ])
    expect(await store.get_outbound("tsk_1")).toMatchObject({
      msg_id: "out_reply",
    })
  })

  test("stores background permission event without surfacing approval card", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_session(session("ses_front"))
    await store.save_inbound(inbound("in_bg_perm"))
    await store.save_task(row("tsk_bg_perm", "ses_bg_perm", "in_bg_perm"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "permission.asked",
      properties: {
        sessionID: "ses_bg_perm",
        id: "req_bg_perm",
        permission: "external_directory",
        metadata: {
          filepath: "/tmp",
        },
      },
    } satisfies OpencodeEvent)

    expect(await store.get_task("tsk_bg_perm")).toMatchObject({
      status: "waiting_permission",
      req_type: "permission",
      req: "req_bg_perm",
    })
    expect(ui.list).toEqual([])
  })

  test("turns question event into waiting_question with numbered options", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_2")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_2"))
    await store.save_task(row("tsk_2", ses.session_id, "in_2"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_2",
        questions: [
          {
            question: "请选择输出形式",
            custom: true,
            options: [{ label: "总结" }, { label: "清单" }],
          },
        ],
      },
    } satisfies OpencodeEvent)

    expect(await store.get_task("tsk_2")).toMatchObject({
      status: "waiting_question",
      req_type: "question",
      req: "req_2",
    })
    expect((await store.get_task("tsk_2"))?.note).toBe(`question:1:${encodeURIComponent("请选择输出形式")}:${encodeURIComponent("总结")}|${encodeURIComponent("清单")}`)
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            type: "question",
            title: "请选择输出形式",
            req: "req_2",
            options: ["总结", "清单"],
            custom: true,
          },
        },
      },
    ])
  })

  test("stores background question event without surfacing question card", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_session(session("ses_front"))
    await store.save_inbound(inbound("in_bg_q"))
    await store.save_task(row("tsk_bg_q", "ses_bg_q", "in_bg_q"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: "ses_bg_q",
        id: "req_bg_q",
        questions: [
          {
            question: "请选择输出形式",
            custom: true,
            options: [{ label: "总结" }, { label: "清单" }],
          },
        ],
      },
    } satisfies OpencodeEvent)

    expect(await store.get_task("tsk_bg_q")).toMatchObject({
      status: "waiting_question",
      req_type: "question",
      req: "req_bg_q",
    })
    expect(ui.list).toEqual([])
  })

  test("dedups repeated permission event with same req and payload", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_dup_perm")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_dup_perm"))
    await store.save_task(row("tsk_dup_perm", ses.session_id, "in_dup_perm"))

    const event = {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_dup_perm",
        permission: "external_directory",
        metadata: {
          filepath: "/tmp",
        },
      },
    } satisfies OpencodeEvent

    await on_event(store, task, ui.api, render, opencode(), event)
    await on_event(store, task, ui.api, render, opencode(), event)

    expect((await store.get_task("tsk_dup_perm"))?.status).toBe("waiting_permission")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            type: "approval",
            title: "权限审批",
            req: "req_dup_perm",
            tool: "external_directory",
            detail: JSON.stringify({
              filepath: "/tmp",
            }),
          },
        },
      },
    ])
  })

  test("queues later permission event and only surfaces it after current one is handled", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_perm_queue")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_perm_queue_1"))
    await store.save_task(row("tsk_perm_queue_1", ses.session_id, "in_perm_queue_1"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_perm_queue_1",
        permission: "external_directory",
        metadata: { filepath: "/tmp" },
      },
    } satisfies OpencodeEvent)

    await on_event(store, task, ui.api, render, opencode(), {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_perm_queue_2",
        permission: "external_directory",
        metadata: { filepath: "/usr" },
      },
    } satisfies OpencodeEvent)

    expect(await store.get_task("tsk_perm_queue_1")).toMatchObject({
      status: "waiting_permission",
      req_type: "permission",
      req: "req_perm_queue_1",
    })
    const waits = await store.list_assistant_outbounds("tsk_perm_queue_1")
    expect(waits).toHaveLength(2)
    expect(waits.map((item) => item.req_key)).toEqual(["req_perm_queue_1", "req_perm_queue_2"])
    expect(waits.map((item) => item.action)).toEqual(["reply", "deferred"])
    expect(waits.map((item) => item.state)).toEqual(["open", "open"])
    expect(ui.list).toHaveLength(1)
  })

  test("queues later question event and only surfaces it after current one is handled", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_q_queue")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_q_queue_1"))
    await store.save_task(row("tsk_q_queue_1", ses.session_id, "in_q_queue_1"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_q_queue_1",
        questions: [{ question: "第一个问题", custom: false, options: [{ label: "A" }, { label: "B" }] }],
      },
    } satisfies OpencodeEvent)

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_q_queue_2",
        questions: [{ question: "第二个问题", custom: false, options: [{ label: "X" }, { label: "Y" }] }],
      },
    } satisfies OpencodeEvent)

    expect(await store.get_task("tsk_q_queue_1")).toMatchObject({
      status: "waiting_question",
      req_type: "question",
      req: "req_q_queue_1",
    })
    const waits = await store.list_assistant_outbounds("tsk_q_queue_1")
    expect(waits).toHaveLength(2)
    expect(waits.map((item) => item.req_key)).toEqual(["req_q_queue_1", "req_q_queue_2"])
    expect(waits.map((item) => item.action)).toEqual(["reply", "deferred"])
    expect(waits.map((item) => item.state)).toEqual(["open", "open"])
    expect(ui.list).toHaveLength(1)
  })

  // 同一个 originating task 连续触发两次权限请求时，后一个 req 必须排队在 assistant_outbound 子记录里。
  test("queues multiple permission requests under one task as assistant outbounds", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_perm_same_task")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_perm_same_task"))
    await store.save_task(row("tsk_perm_same_task", ses.session_id, "in_perm_same_task"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_perm_same_task_1",
        permission: "external_directory",
        metadata: { filepath: "/tmp" },
      },
    } satisfies OpencodeEvent)

    await on_event(store, task, ui.api, render, opencode(), {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_perm_same_task_2",
        permission: "external_directory",
        metadata: { filepath: "/etc" },
      },
    } satisfies OpencodeEvent)

    const tasks = await store.list_tasks({ session_id: ses.session_id })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: "tsk_perm_same_task",
      status: "waiting_permission",
      req: "req_perm_same_task_1",
    })
    const waits = await store.list_assistant_outbounds("tsk_perm_same_task")
    expect(waits).toHaveLength(2)
    expect(waits.map((item) => item.req_key)).toEqual(["req_perm_same_task_1", "req_perm_same_task_2"])
    expect(waits.map((item) => item.state)).toEqual(["open", "open"])
    expect(ui.list).toHaveLength(1)
  })

  // question.asked 也必须保留成 assistant_outbound 排队项，不能把同一个 task 上的 req 覆盖掉。
  test("queues multiple question requests under one task as assistant outbounds", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_q_same_task")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_q_same_task"))
    await store.save_task(row("tsk_q_same_task", ses.session_id, "in_q_same_task"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_q_same_task_1",
        questions: [{ question: "第一个问题", custom: false, options: [{ label: "A" }] }],
      },
    } satisfies OpencodeEvent)

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_q_same_task_2",
        questions: [{ question: "第二个问题", custom: true, options: [{ label: "B" }] }],
      },
    } satisfies OpencodeEvent)

    const tasks = await store.list_tasks({ session_id: ses.session_id })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: "tsk_q_same_task",
      status: "waiting_question",
      req: "req_q_same_task_1",
    })
    const waits = await store.list_assistant_outbounds("tsk_q_same_task")
    expect(waits).toHaveLength(2)
    expect(waits.map((item) => item.req_key)).toEqual(["req_q_same_task_1", "req_q_same_task_2"])
    expect(waits.map((item) => item.state)).toEqual(["open", "open"])
    expect(ui.list).toHaveLength(1)
  })

  test("allows updated question event with same req to patch card", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_update_q")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_update_q"))
    await store.save_task(row("tsk_update_q", ses.session_id, "in_update_q"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_update_q",
        questions: [
          {
            question: "请选择输出形式",
            custom: false,
            options: [{ label: "总结" }, { label: "清单" }],
          },
        ],
      },
    } satisfies OpencodeEvent)

    await on_event(store, task, ui.api, render, opencode(), {
      type: "question.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_update_q",
        questions: [
          {
            question: "请选择最终输出形式",
            custom: true,
            options: [{ label: "总结" }, { label: "清单" }, { label: "表格" }],
          },
        ],
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_update_q"))?.status).toBe("waiting_question")
    expect((await store.get_task("tsk_update_q"))?.note).toBe(
      `question:1:${encodeURIComponent("请选择最终输出形式")}:${encodeURIComponent("总结")}|${encodeURIComponent("清单")}|${encodeURIComponent("表格")}`,
    )
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            type: "question",
            title: "请选择输出形式",
            req: "req_update_q",
            options: ["总结", "清单"],
            custom: false,
          },
        },
      },
      {
        kind: "patch",
        out: {
          kind: "card",
          body: {
            type: "question",
            title: "请选择最终输出形式",
            req: "req_update_q",
            options: ["总结", "清单", "表格"],
            custom: true,
          },
        },
      },
    ])
  })

  test("checkpoints final output on first idle and completes on repeated identical idle", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_3")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3"))
    await store.save_task(row("tsk_3", ses.session_id, "in_3"))

    const event = {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent

    await on_event(store, task, ui.api, render, opencode("done"), event)

    const checkpointed = await store.get_task("tsk_3")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(checkpointed?.terminal_kind).toBeUndefined()
    expect(checkpointed?.terminal_outbound_id).toBeUndefined()
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "done" }),
      },
    ])

    await on_event(
      store,
      task,
      ui.api,
      render,
      opencode(undefined, {
        state: "ok",
        text: "done",
        completed: true,
      }),
      event,
    )

    const settled = await store.get_task("tsk_3")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "done" }),
      },
      {
        kind: "reply",
        out: render.final({ text: "done" }),
      },
    ])

    const history = await store.list_assistant_outbounds("tsk_3")
    expect(history.filter((item) => item.terminal)).toHaveLength(1)

    await on_event(store, task, ui.api, render, opencode("done"), event)

    expect((await store.get_task("tsk_3"))?.status).toBe("completed")
    expect(ui.list).toHaveLength(2)
    expect((await store.list_assistant_outbounds("tsk_3")).filter((item) => item.terminal)).toHaveLength(1)
  })

  test("checkpoints empty idle once and fails red on repeated identical idle", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_4")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_4"))
    await store.save_task(row("tsk_4", ses.session_id, "in_4"))

    const event = {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent

    await on_event(store, task, ui.api, render, opencode(), event)

    const checkpointed = await store.get_task("tsk_4")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(ui.list).toEqual([])

    await on_event(
      store,
      task,
      ui.api,
      render,
      opencode(undefined, {
        state: "empty",
        completed: true,
      }),
      event,
    )

    const settled = await store.get_task("tsk_4")
    expect(settled).toMatchObject({
      status: "failed",
      terminal_kind: "error",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "red",
      },
    })
    const errText = ((ui.list[ui.list.length - 1]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(errText).toContain("当前会话已结束，但没有可恢复结果，请重新发送上一条消息。")
  })

  test("checkpoints filtered idle once and completes on repeated identical idle", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_4_filtered")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_4_filtered"))
    await store.save_task(row("tsk_4_filtered", ses.session_id, "in_4_filtered"))

    const event = {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent

    await on_event(
      store,
      task,
      ui.api,
      render,
      opencode(undefined, {
        state: "filtered",
      }),
      event,
    )

    const checkpointed = await store.get_task("tsk_4_filtered")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(ui.list).toEqual([])

    await on_event(
      store,
      task,
      ui.api,
      render,
      opencode(undefined, {
        state: "filtered",
        completed: true,
      }),
      event,
    )

    const settled = await store.get_task("tsk_4_filtered")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.final({ text: done_msg({ state: "filtered" }) }),
      },
    ])
  })

  test("ignores late permission event after task is completed", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_5")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_5"))
    await store.save_task(row("tsk_5", ses.session_id, "in_5", "completed"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_5",
        permission: "external_directory",
        metadata: {
          filepath: "/tmp",
        },
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_5"))?.status).toBe("completed")
    expect(ui.list).toEqual([])
  })

  test("ignores late session error after task is already completed", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_6")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_6"))
    await store.save_task(row("tsk_6", ses.session_id, "in_6", "completed"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "session.error",
      properties: {
        sessionID: ses.session_id,
        error: {
          name: "LateError",
        },
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_6"))?.status).toBe("completed")
    expect(ui.list).toEqual([])
  })

  test("ignores late idle event after task is already completed", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_6_idle")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_6_idle"))
    await store.save_task(row("tsk_6_idle", ses.session_id, "in_6_idle", "completed"))

    await on_event(store, task, ui.api, render, opencode("late done"), {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_6_idle"))?.status).toBe("completed")
    expect(ui.list).toEqual([])
  })

  test("dedups repeated session error with same payload", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_dup_err")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_dup_err"))
    await store.save_task(row("tsk_dup_err", ses.session_id, "in_dup_err", "running"))

    const event = {
      type: "session.error",
      properties: {
        sessionID: ses.session_id,
        error: {
          name: "BrokenPipe",
        },
      },
    } satisfies OpencodeEvent

    await on_event(store, task, ui.api, render, opencode(), event)
    await on_event(store, task, ui.api, render, opencode(), event)

    expect((await store.get_task("tsk_dup_err"))?.status).toBe("failed")
    expect(ui.list).toHaveLength(1)
    expect(ui.list[0]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
      },
    })
  })

  test("checkpoints fallback idle once and settles on repeated identical idle", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_inbound(inbound("in_7"))
    await store.save_task(row("tsk_7", "ses_7", "in_7", "running"))

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_7",
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent

    await on_event(store, task, ui.api, render, opencode("fallback done"), event)

    const checkpointed = await store.get_task("tsk_7")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "fallback done" }),
      },
    ])

    await on_event(
      store,
      task,
      ui.api,
      render,
      opencode(undefined, {
        state: "ok",
        text: "fallback done",
        completed: true,
      }),
      event,
    )

    const settled = await store.get_task("tsk_7")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "fallback done" }),
      },
      {
        kind: "reply",
        out: render.final({ text: "fallback done" }),
      },
    ])
  })

  test("publishes session error from inbound fallback when session mapping is gone", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_inbound(inbound("in_8"))
    await store.save_task(row("tsk_8", "ses_8", "in_8", "running"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "session.error",
      properties: {
        sessionID: "ses_8",
        error: {
          name: "BrokenPipe",
        },
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_8"))?.status).toBe("failed")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "red",
            text: `出错了：BrokenPipe\n\n建议：可稍后重试；若仍失败，请重新发送上一条消息。`,
          },
        },
      },
    ])
  })
})
