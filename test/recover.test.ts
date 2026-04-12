import { describe, expect, test } from "bun:test"
import { recover } from "../src/app/boot.ts"
import type { AppCfg, FeishuApi, ImSession, InboundMessage, OpencodeSvc, RenderOut, Task } from "../src/contracts.ts"
import { createRender } from "../src/render/text.ts"
import { createMemoryStore } from "../src/storage/db.ts"
import { createTaskSvc } from "../src/gateway/task.ts"

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

function task(id: string, session_id: string, inbound_id: string, status: Task["status"]): Task {
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

function opencode(input: { status?: Record<string, unknown> | null; last?: string | undefined }) {
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
      if (input.status === null) throw new Error("status failed")
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
  } satisfies OpencodeSvc
}

describe("recover", () => {
  test("fails waiting_attachment when pending context is missing", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_1")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_1"))
    await store.save_task(task("tsk_1", ses.session_id, "in_1", "waiting_attachment"))

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({}), "boot")

    expect((await store.get_task("tsk_1"))?.status).toBe("failed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
      },
    })
  })

  test("fails waiting_attachment when cached assets are no longer usable", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_bad")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_bad"))
    await store.save_task(task("tsk_bad", ses.session_id, "in_bad", "waiting_attachment"))
    await store.save_pending({
      session_id: ses.session_id,
      inbound_id: "in_bad",
      assets: [
        {
          kind: "image",
          key: "img_bad",
          name: "broken.png",
        },
      ],
      created_at: 1,
      updated_at: 1,
    })

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({}), "boot")

    expect((await store.get_task("tsk_bad"))?.status).toBe("failed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
        text: "出错了：服务恢复后，附件缓存已失效，请重新发送附件和说明。",
      },
    })
  })

  test("promotes queued task to running when remote session is still busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_2")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_2"))
    await store.save_task(task("tsk_2", ses.session_id, "in_2", "queued"))

    await recover(
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
      "boot",
    )

    expect((await store.get_task("tsk_2"))?.status).toBe("running")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
      },
    })
  })

  test("restores waiting permission card when remote session is still busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_4")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_4"))
    await store.save_task({
      ...task("tsk_4", ses.session_id, "in_4", "waiting_permission"),
      req: "req_4",
      note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent('{"filepath":"/tmp"}')}`,
    })

    await recover(
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
      "boot",
    )

    expect((await store.get_task("tsk_4"))?.status).toBe("waiting_permission")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        type: "approval",
        req: "req_4",
        tool: "external_directory",
      },
    })
  })

  test("fails stale waiting question when remote session is no longer busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_5")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_5"))
    await store.save_task({
      ...task("tsk_5", ses.session_id, "in_5", "waiting_question"),
      req: "req_5",
      note: `question:1:${encodeURIComponent("请选择")}:${encodeURIComponent("A")}|${encodeURIComponent("B")}`,
    })

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({}), "boot")

    expect((await store.get_task("tsk_5"))?.status).toBe("failed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
      },
    })
  })

  test("keeps waiting question pending when remote status probe fails", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_5b")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_5b"))
    await store.save_task({
      ...task("tsk_5b", ses.session_id, "in_5b", "waiting_question"),
      req: "req_5b",
      note: `question:1:${encodeURIComponent("请选择")}:${encodeURIComponent("A")}|${encodeURIComponent("B")}`,
    })

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({ status: null }), "boot")

    expect((await store.get_task("tsk_5b"))?.status).toBe("waiting_question")
    expect(ui.list.at(-1)?.out).toBeUndefined()
  })

  test("shows connecting hint during boot when opencode is not ready yet", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_connecting")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_connecting"))
    await store.save_task(task("tsk_connecting", ses.session_id, "in_connecting", "running"))
    await store.set_conn({
      name: "opencode",
      status: "connecting",
      updated_at: 1,
    })

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({ status: null }), "boot")

    expect((await store.get_task("tsk_connecting"))?.status).toBe("running")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "OpenCode 正在建立连接，稍后会继续同步执行状态…",
      },
    })
  })

  test("shows connecting hint during boot before opencode conn state is known", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_boot")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_boot"))
    await store.save_task(task("tsk_boot", ses.session_id, "in_boot", "running"))

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({ status: null }), "boot")

    expect((await store.get_task("tsk_boot"))?.status).toBe("running")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "OpenCode 正在建立连接，稍后会继续同步执行状态…",
      },
    })
  })

  test("finishes running task from last assistant output when remote is no longer busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_3")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3"))
    await store.save_task(task("tsk_3", ses.session_id, "in_3", "running"))

    await recover(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
        last: "final answer",
      }),
      "boot",
    )

    expect((await store.get_task("tsk_3"))?.status).toBe("completed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "green",
        text: "final answer",
      },
    })
  })

  test("finishes running task from task scope when session mapping is gone", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_inbound(inbound("in_fallback"))
    await store.save_task({
      ...task("tsk_fallback", "ses_fallback", "in_fallback", "running"),
      directory: "/tmp/fallback",
      workspace_id: "ws_fallback",
    })

    await recover(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
        last: "fallback done",
      }),
      "boot",
    )

    expect((await store.get_task("tsk_fallback"))?.status).toBe("completed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "green",
        text: "fallback done",
      },
    })
  })
})
