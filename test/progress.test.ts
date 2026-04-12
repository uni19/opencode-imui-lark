import { describe, expect, test } from "bun:test"
import { on_progress } from "../src/app/boot.ts"
import type { ImSession, InboundMessage, OpencodeEvent, RenderOut, Task } from "../src/contracts.ts"
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

function tick() {
  const list: Array<{ session_id: string; chat_id: string; out: RenderOut }> = []
  return {
    list,
    async push(session_id: string, chat_id: string, out: RenderOut) {
      list.push({ session_id, chat_id, out })
    },
  }
}

describe("on_progress", () => {
  test("dedups repeated busy status for same task", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const render = createRender()
    const push = tick()
    const ses = session("ses_busy")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_busy"))
    await store.save_task(row("tsk_busy", ses.session_id, "in_busy"))

    const event = {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "busy",
        },
      },
    } satisfies OpencodeEvent

    expect(await on_progress(store, task, render, push, event)).toBe(true)
    expect(await on_progress(store, task, render, push, event)).toBe(true)
    expect(push.list).toEqual([
      {
        session_id: ses.session_id,
        chat_id: "chat",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "blue",
            text: "正在处理，请稍候…",
          },
        },
      },
    ])
    expect((await store.get_task("tsk_busy"))?.note).toBe("正在处理")
  })

  test("allows retry updates when attempt changes", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const render = createRender()
    const push = tick()
    const ses = session("ses_retry")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_retry"))
    await store.save_task(row("tsk_retry", ses.session_id, "in_retry"))

    await on_progress(store, task, render, push, {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "retry",
          attempt: 1,
          message: "rate limited",
        },
      },
    } satisfies OpencodeEvent)

    await on_progress(store, task, render, push, {
      type: "session.status",
      properties: {
        sessionID: ses.session_id,
        status: {
          type: "retry",
          attempt: 2,
          message: "rate limited",
        },
      },
    } satisfies OpencodeEvent)

    expect(push.list).toHaveLength(2)
    expect(push.list[0]?.out).toMatchObject({
      body: {
        step: "重试第 1 次",
      },
    })
    expect(push.list[1]?.out).toMatchObject({
      body: {
        step: "重试第 2 次",
      },
    })
    expect((await store.get_task("tsk_retry"))?.note).toBe("重试第 2 次：rate limited")
  })

  test("dedups repeated assistant message.updated by message id", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const render = createRender()
    const push = tick()
    const ses = session("ses_msg")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_msg"))
    await store.save_task(row("tsk_msg", ses.session_id, "in_msg"))

    const event = {
      type: "message.updated",
      properties: {
        sessionID: ses.session_id,
        info: {
          id: "msg_assistant_1",
          sessionID: ses.session_id,
          role: "assistant",
          agent: "build",
          modelID: "gpt-5.4",
        },
      },
    } satisfies OpencodeEvent

    expect(await on_progress(store, task, render, push, event)).toBe(true)
    expect(await on_progress(store, task, render, push, event)).toBe(true)
    expect(push.list).toHaveLength(1)
    expect(push.list[0]?.out).toMatchObject({
      body: {
        step: "开始处理: build / gpt-5.4",
        text: "正在生成回复…",
      },
    })
    expect((await store.get_task("tsk_msg"))?.note).toBe("开始处理: build / gpt-5.4")
  })

  test("dedups repeated message.part.updated with same time", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const render = createRender()
    const push = tick()
    const ses = session("ses_part")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_part"))
    await store.save_task(row("tsk_part", ses.session_id, "in_part"))

    const event = {
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
    } satisfies OpencodeEvent

    expect(await on_progress(store, task, render, push, event)).toBe(true)
    expect(await on_progress(store, task, render, push, event)).toBe(true)
    expect(push.list).toHaveLength(1)
    expect(push.list[0]?.out).toMatchObject({
      body: {
        step: "正在执行 ls -la",
        text: "处理中…",
      },
    })
    expect((await store.get_task("tsk_part"))?.note).toBe("正在执行 ls -la")
  })
})
