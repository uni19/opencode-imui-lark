/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { dispatch_event } from "../src/app/boot.ts"
import type { FeishuApi, ImSession, InboundMessage, OpencodeEvent, OpencodeResult, OpencodeSvc, RenderOut, Task } from "../src/contracts.ts"
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
    directory: "/tmp",
    status,
    created_at: 1,
    updated_at: 1,
  }
}

function feishu(order: string[]) {
  const list: Array<{ kind: "send" | "reply" | "patch"; out: RenderOut }> = []
  return {
    api: {
      async send(input) {
        order.push("send")
        list.push({ kind: "send", out: input.out })
        return { id: "out_send" }
      },
      async reply(input) {
        order.push("reply")
        list.push({ kind: "reply", out: input.out })
        return { id: "out_reply" }
      },
      async patch(input) {
        order.push("patch")
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

function tick(order: string[]) {
  const list: Array<{ session_id: string; chat_id: string; out: RenderOut; meta?: { kind: string; terminal?: boolean } }> = []
  return {
    list,
    async push(session_id: string, chat_id: string, out: RenderOut, meta?: { kind: string; terminal?: boolean }) {
      order.push("push")
      list.push({ session_id, chat_id, out, meta })
    },
    async flush(session_id: string) {
      order.push(`flush:${session_id}`)
    },
  }
}

describe("dispatch_event", () => {
  test("flushes progress before repeated idle settlement", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const render = createRender()
    const order: string[] = []
    const ui = feishu(order)
    const stream = tick(order)
    const ses = session("ses_1")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_1"))
    await store.save_task(row("tsk_1", ses.session_id, "in_1"))

    await dispatch_event(store, task, ui.api, render, opencode("done"), stream, {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "busy",
        },
      },
    } satisfies OpencodeEvent)

    await dispatch_event(store, task, ui.api, render, opencode("done"), stream, {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "idle",
        },
      },
    } satisfies OpencodeEvent)

    const checkpointed = await store.get_task("tsk_1")
    expect(order).toEqual(["push", `flush:${ses.session_id}`, "reply"])
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "done" }),
      },
    ])

    await dispatch_event(
      store,
      task,
      ui.api,
      render,
      opencode(undefined, {
        state: "ok",
        text: "done",
        completed: true,
      }),
      stream,
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

    expect(order[0]).toBe("push")
    expect(order).toContain(`flush:${ses.session_id}`)
    expect(order.indexOf(`flush:${ses.session_id}`)).toBeLessThan(order.indexOf("reply"))
    expect(order.filter((item) => item === "reply")).toHaveLength(2)
    expect((await store.get_task("tsk_1"))?.status).toBe("completed")
    expect(ui.list[ui.list.length - 1]?.out).toEqual(render.final({ text: "done" }))
  })

  test("flushes progress before session error event", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const render = createRender()
    const order: string[] = []
    const ui = feishu(order)
    const stream = tick(order)
    const ses = session("ses_2")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_2"))
    await store.save_task(row("tsk_2", ses.session_id, "in_2"))

    await dispatch_event(store, task, ui.api, render, opencode(), stream, {
      type: "message.updated",
      properties: {
        sessionID: ses.session_id,
        info: {
          id: "msg_1",
          sessionID: ses.session_id,
          role: "assistant",
          agent: "build",
          modelID: "gpt-5.4",
        },
      },
    } satisfies OpencodeEvent)

    await dispatch_event(store, task, ui.api, render, opencode(), stream, {
      type: "session.error",
      properties: {
        sessionID: ses.session_id,
        error: {
          name: "BrokenPipe",
        },
      },
    } satisfies OpencodeEvent)

    expect(order).toEqual(["push", `flush:${ses.session_id}`, "reply"])
    expect((await store.get_task("tsk_2"))?.status).toBe("failed")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
      },
    })
    const text = ((ui.list[ui.list.length - 1]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("出错了：BrokenPipe")
    expect(text).toContain("建议：可稍后重试；若仍失败，请重新发送上一条消息。")
  })

  test("flushes before permission card update", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const render = createRender()
    const order: string[] = []
    const ui = feishu(order)
    const stream = tick(order)
    const ses = session("ses_3")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3"))
    await store.save_task(row("tsk_3", ses.session_id, "in_3"))

    await dispatch_event(store, task, ui.api, render, opencode(), stream, {
      type: "message.part.updated",
      properties: {
        sessionID: ses.session_id,
        time: 100,
        part: {
          id: "part_1",
          sessionID: ses.session_id,
          messageID: "msg_1",
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "ls -la",
            },
          },
        },
      },
    } satisfies OpencodeEvent)

    await dispatch_event(store, task, ui.api, render, opencode(), stream, {
      type: "permission.asked",
      properties: {
        sessionID: ses.session_id,
        id: "req_3",
        permission: "external_directory",
        metadata: {
          filepath: "/tmp",
        },
      },
    } satisfies OpencodeEvent)

    expect(order).toEqual(["push", `flush:${ses.session_id}`, "reply"])
    expect((await store.get_task("tsk_3"))?.status).toBe("waiting_permission")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        type: "approval",
        req: "req_3",
      },
    })
  })
})
