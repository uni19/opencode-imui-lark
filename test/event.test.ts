import { describe, expect, test } from "bun:test"
import { on_event } from "../src/app/boot.ts"
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

  test("publishes final output and completes task when session turns idle", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_3")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3"))
    await store.save_task(row("tsk_3", ses.session_id, "in_3"))

    await on_event(store, task, ui.api, render, opencode("done"), {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_3"))?.status).toBe("completed")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "green",
            text: "done",
          },
        },
      },
    ])
  })

  test("publishes fallback completion text when idle has no final output", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_4")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_4"))
    await store.save_task(row("tsk_4", ses.session_id, "in_4"))

    await on_event(store, task, ui.api, render, opencode(), {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_4"))?.status).toBe("completed")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "green",
            text: "本次执行已完成，但没有可展示的文本输出。",
          },
        },
      },
    ])
  })

  test("publishes filtered completion hint when idle only has internal text", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_4_filtered")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_4_filtered"))
    await store.save_task(row("tsk_4_filtered", ses.session_id, "in_4_filtered"))

    await on_event(
      store,
      task,
      ui.api,
      render,
      opencode(undefined, {
        state: "filtered",
      }),
      {
        type: "session.status",
        properties: {
          sessionID: ses.session_id,
          status: {
            type: "idle",
          },
        },
      } satisfies OpencodeEvent,
    )

    expect((await store.get_task("tsk_4_filtered"))?.status).toBe("completed")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "green",
            text: "本次执行已完成，但当前只拿到了内部过程或总结信息，没有适合直接展示的最终文本答复。你可以重发一句“请直接给出最终结论”再试一次。",
          },
        },
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

  test("finishes task from inbound fallback when session mapping is gone", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_inbound(inbound("in_7"))
    await store.save_task(row("tsk_7", "ses_7", "in_7", "running"))

    await on_event(store, task, ui.api, render, opencode("fallback done"), {
      type: "session.status",
      properties: {
        sessionID: "ses_7",
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent)

    expect((await store.get_task("tsk_7"))?.status).toBe("completed")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "green",
            text: "fallback done",
          },
        },
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
