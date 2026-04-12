import { describe, expect, test } from "bun:test"
import { probe } from "../src/app/boot.ts"
import type {
  AppCfg,
  FeishuApi,
  ImSession,
  InboundMessage,
  OpencodeResult,
  OpencodeSvc,
  RenderOut,
  Task,
} from "../src/contracts.ts"
import { createTaskSvc } from "../src/gateway/task.ts"
import { createRender } from "../src/render/text.ts"
import { createMemoryStore } from "../src/storage/db.ts"

function cfg() {
  return {
    log: { level: "info" },
    storage: { path: ":memory:" },
    feishu: { mode: "off" },
    opencode: {
      base_url: "http://127.0.0.1:4096",
      username: "opencode",
      directory: "/tmp",
    },
  } satisfies AppCfg
}

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

function row(id: string, session_id: string, inbound_id: string, status: Task["status"]): Task {
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

function opencode(input: { status?: Record<string, unknown>; last?: string | undefined; result?: OpencodeResult; fail?: boolean }) {
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
      if (input.fail) throw new Error("status failed")
      return input.status ?? {}
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
      return input.last
    },
    async result() {
      if (input.result) return input.result
      if (input.last) return { state: "ok", text: input.last }
      return { state: "empty" }
    },
  } satisfies OpencodeSvc
}

describe("probe", () => {
  test("keeps stale queued task alive when remote is still busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_1")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_1"))
    await store.save_task(row("tsk_1", ses.session_id, "in_1", "queued"))

    const state = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          [ses.session_id]: { type: "busy" },
        },
      }),
      (await store.get_task("tsk_1"))!,
      true,
    )

    expect(state).toBe("busy")
    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "已重新确认：请求已提交，仍在处理中…",
      },
    })
  })

  test("finishes running task when remote session is already idle with output", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_2")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_2"))
    await store.save_task(row("tsk_2", ses.session_id, "in_2", "running"))

    const state = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
        last: "final answer",
      }),
      (await store.get_task("tsk_2"))!,
      false,
    )

    expect(state).toBe("settled")
    expect((await store.get_task("tsk_2"))?.status).toBe("completed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "green",
        text: "final answer",
      },
    })
  })

  test("fails running task when remote session is idle without output", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_3")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3"))
    await store.save_task(row("tsk_3", ses.session_id, "in_3", "running"))

    const state = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
      }),
      (await store.get_task("tsk_3"))!,
      false,
    )

    expect(state).toBe("settled")
    expect((await store.get_task("tsk_3"))?.status).toBe("failed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
        text: "出错了：已重新检查上一条执行状态：当前会话已结束，但没有可恢复结果，请重新发送上一条消息。",
      },
    })
  })

  test("completes running task when remote session is idle with filtered output only", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_3_filtered")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3_filtered"))
    await store.save_task(row("tsk_3_filtered", ses.session_id, "in_3_filtered", "running"))

    const state = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
        result: {
          state: "filtered",
        },
      }),
      (await store.get_task("tsk_3_filtered"))!,
      false,
    )

    expect(state).toBe("settled")
    expect((await store.get_task("tsk_3_filtered"))?.status).toBe("completed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "green",
        text: "本次执行已完成，但当前只拿到了内部过程或总结信息，没有适合直接展示的最终文本答复。你可以重发一句“请直接给出最终结论”再试一次。",
      },
    })
  })

  test("keeps current task unchanged when remote status probe fails", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_4")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_4"))
    await store.save_task(row("tsk_4", ses.session_id, "in_4", "running"))

    const state = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        fail: true,
      }),
      (await store.get_task("tsk_4"))!,
      true,
    )

    expect(state).toBe("unknown")
    expect((await store.get_task("tsk_4"))?.status).toBe("running")
    expect(ui.list).toEqual([])
  })
})
