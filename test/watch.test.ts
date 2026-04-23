/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { sweep } from "../src/app/boot.ts"
import type { AppCfg, FeishuApi, ImSession, InboundMessage, OpencodeResult, OpencodeStatus, OpencodeSvc, RenderOut, Task } from "../src/contracts.ts"
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

function opencode(input: { status?: Record<string, OpencodeStatus> | null; last?: string | undefined; result?: OpencodeResult }) {
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
    async status(_input: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>> {
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
    async last(_input: { session_id: string; directory?: string; workspace?: string }): Promise<string | undefined> {
      return input.last
    },
    async result(_input: { session_id: string; directory?: string; workspace?: string }): Promise<OpencodeResult> {
      return input.result ?? (input.last ? { state: "ok", text: input.last } : { state: "empty" })
    },
  } satisfies OpencodeSvc
}

describe("sweep", () => {
  test("promotes stale queued task to running when remote is still busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_1")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_1"))
    await store.save_task(
      row("tsk_1", ses.session_id, "in_1", "queued"),
    )

    await sweep(
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
      60000,
      1000,
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "长时间无新事件，正在继续同步执行状态…",
      },
    })
  })

  test("checkpoints stale running task on first idle sweep and fails on repeated identical empty result", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_2")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_2"))
    await store.save_task(
      row("tsk_2", ses.session_id, "in_2", "running"),
    )

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
      }),
      60000,
      1000,
    )

    const checkpointed = await store.get_task("tsk_2")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(checkpointed?.terminal_kind).toBeUndefined()
    expect(checkpointed?.terminal_outbound_id).toBeUndefined()
    expect(ui.list).toEqual([])

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "empty",
          completed: true,
        },
      }),
      (checkpointed?.updated_at ?? 0) + 1000,
      1000,
    )

    const settled = await store.get_task("tsk_2")
    expect(settled).toMatchObject({
      status: "failed",
      terminal_kind: "error",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
        text: "出错了：长时间未收到后续事件，本次执行已结束但未生成可恢复结果，请重新发送上一条消息。",
      },
    })
  })

  test("checkpoints fallback running task on first idle sweep and settles on repeated identical output", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_inbound(inbound("in_3"))
    await store.save_task({
      ...row("tsk_3", "ses_3", "in_3", "running"),
      directory: "/tmp/fallback",
      workspace_id: "ws_fallback",
    })

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "watch done",
      }),
      60000,
      1000,
    )

    const checkpointed = await store.get_task("tsk_3")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(checkpointed?.terminal_kind).toBeUndefined()
    expect(checkpointed?.terminal_outbound_id).toBeUndefined()
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "watch done" }),
      },
    ])

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "ok",
          text: "watch done",
          completed: true,
        },
      }),
      (checkpointed?.updated_at ?? 0) + 1000,
      1000,
    )

    const settled = await store.get_task("tsk_3")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "reply", "patch"])
    expect(ui.list[ui.list.length - 2]?.out).toEqual(render.final({ text: "watch done" }))
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          title: "最终已完成",
          template: "green",
          state: "final",
          text: "请查看下方最终答复",
        },
      },
    })
  })

  test("re-patches stale waiting permission when remote is still busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_4")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_4"))
    await store.save_task({
      ...row("tsk_4", ses.session_id, "in_4", "waiting_permission"),
      req: "req_4",
      note: "approval:external_directory:%7B%22filepath%22%3A%22%2Ftmp%22%7D",
    })

    await sweep(
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
      60000,
      1000,
    )

    expect((await store.get_task("tsk_4"))?.status).toBe("waiting_permission")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        type: "approval",
        req: "req_4",
        tool: "external_directory",
      },
    })
  })

  test("fails stale waiting question when remote is no longer busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_5")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_5"))
    await store.save_task({
      ...row("tsk_5", ses.session_id, "in_5", "waiting_question"),
      req: "req_5",
      note: "question:1:%E8%AF%B7%E9%80%89%E6%8B%A9:A|B",
    })

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_5"))?.status).toBe("failed")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
        text: "出错了：长时间未收到后续事件，之前的补充问题已失效，请重新发送上一条消息。",
      },
    })
  })

  test("reminds stale waiting attachment when cached assets are still valid", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_6")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_6"))
    await store.save_task({
      ...row("tsk_6", ses.session_id, "in_6", "waiting_attachment"),
      note: "等待补充说明",
    })
    await store.save_task_pending({
      task_id: "tsk_6",
      session_id: ses.session_id,
      origin_inbound_id: "in_6",
      origin_message_id: "msg_in_6",
      assets: [
        {
          kind: "image",
          key: "img_6",
          name: "a.png",
          mime: "image/png",
          url: "file:///tmp/a.png",
        },
      ],
      created_at: 1,
      updated_at: 1,
    })

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_6"))?.status).toBe("waiting_attachment")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "长时间未继续输入，仍在等待你的补充说明。请再发一句你希望我做什么。",
      },
    })
  })

  test("fails stale waiting attachment when cached assets are unusable and clears pending", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_hold_bad")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_hold_bad"))
    await store.save_task({
      ...row("tsk_hold_bad", ses.session_id, "in_hold_bad", "waiting_attachment"),
      note: "等待补充说明",
    })
    await store.save_task_pending({
      task_id: "tsk_hold_bad",
      session_id: ses.session_id,
      origin_inbound_id: "in_hold_bad",
      origin_message_id: "msg_in_hold_bad",
      assets: [
        {
          kind: "image",
          key: "img_hold_bad",
          name: "broken.png",
        },
      ],
      created_at: 1,
      updated_at: 1,
    })

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_hold_bad"))?.status).toBe("failed")
    expect(await store.get_task_pending("tsk_hold_bad")).toBeNull()
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
      },
    })
  })

  test("does not re-show stale waiting approval while task is in background", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session("ses_front"))
    await store.save_inbound(inbound("in_bg_perm"))
    await store.save_task({
      ...row("tsk_bg_perm", "ses_bg_perm", "in_bg_perm", "waiting_permission"),
      req: "req_bg_perm",
      note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/tmp" }))}`,
    })

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_bg_perm: { type: "busy" },
        },
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_bg_perm"))?.status).toBe("waiting_permission")
    expect(ui.list).toHaveLength(0)
  })

  test("does not remind stale waiting attachment while task is in background", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session("ses_front"))
    await store.save_inbound(inbound("in_bg_hold"))
    await store.save_task({
      ...row("tsk_bg_hold", "ses_bg_hold", "in_bg_hold", "waiting_attachment"),
      note: "等待补充说明",
    })
    await store.save_task_pending({
      task_id: "tsk_bg_hold",
      session_id: "ses_bg_hold",
      origin_inbound_id: "in_bg_hold",
      origin_message_id: "msg_in_bg_hold",
      assets: [
        {
          kind: "image",
          key: "img_hold",
          name: "a.png",
          mime: "image/png",
          url: "file:///tmp/a.png",
        },
      ],
      created_at: 1,
      updated_at: 1,
    })

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_bg_hold"))?.status).toBe("waiting_attachment")
    expect(ui.list).toHaveLength(0)
  })

  test("resets checkpoint when sweep observes a different non-wait result before settling", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_chain_done")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_chain_done"))
    await store.save_task(
      row("tsk_chain_done", ses.session_id, "in_chain_done", "running"),
    )

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "watch done once",
      }),
      60000,
      1000,
    )

    const first = await store.get_task("tsk_chain_done")
    expect(first?.status).toBe("running")
    expect(typeof first?.result_hash).toBe("string")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "watch done once" }),
      },
    ])

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "watch done twice",
      }),
      (first?.updated_at ?? 0) + 1000,
      1000,
    )

    const second = await store.get_task("tsk_chain_done")
    expect(second?.status).toBe("running")
    expect(typeof second?.result_hash).toBe("string")
    expect(second?.result_hash).not.toBe(first?.result_hash)
    expect(ui.list[ui.list.length - 1]?.out).toEqual(render.intermediate({ text: "watch done twice" }))

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "ok",
          text: "watch done twice",
          completed: true,
        },
      }),
      (second?.updated_at ?? 0) + 1000,
      1000,
    )

    const settled = await store.get_task("tsk_chain_done")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(second?.result_hash)
    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "reply", "reply", "patch"])
    expect(ui.list[ui.list.length - 2]?.out).toEqual(render.final({ text: "watch done twice" }))
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          title: "最终已完成",
          template: "green",
          state: "final",
          text: "请查看下方最终答复",
        },
      },
    })

    const history = await store.list_assistant_outbounds("tsk_chain_done")
    expect(history.filter((item) => item.terminal && item.state === "emitted")).toHaveLength(1)
  })

  test("watchdog emits a single terminal update after checkpointed completion and ignores later passes", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_boot_done")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_boot_done"))
    await store.save_task(
      row("tsk_boot_done", ses.session_id, "in_boot_done", "running"),
    )

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "final after boot",
      }),
      60000,
      1000,
    )

    const checkpointed = await store.get_task("tsk_boot_done")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "final after boot" }),
      },
    ])

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "ok",
          text: "final after boot",
          completed: true,
        },
      }),
      (checkpointed?.updated_at ?? 0) + 1000,
      1000,
    )

    const settled = await store.get_task("tsk_boot_done")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "final after second sweep",
      }),
      (settled?.updated_at ?? 0) + 1000,
      1000,
    )

    expect((await store.get_task("tsk_boot_done"))?.status).toBe("completed")
    const history = await store.list_assistant_outbounds("tsk_boot_done")
    const terminals = history.filter((item) => item.terminal && item.state === "emitted")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      feishu_message_id: "out_reply",
      payload: expect.objectContaining({
        template: "green",
        state: "final",
        title: "最终完成",
        text: "final after boot",
      }),
    })
    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "reply", "patch"])
    expect(ui.list[ui.list.length - 2]?.out).toEqual(render.final({ text: "final after boot" }))
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          title: "最终已完成",
          template: "green",
          state: "final",
          text: "请查看下方最终答复",
        },
      },
    })
  })

  test("keeps stale running task alive when remote status probe fails", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_7")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_7"))
    await store.save_task(
      row("tsk_7", ses.session_id, "in_7", "running"),
    )

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: null,
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_7"))?.status).toBe("running")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "OpenCode 正在建立连接，稍后会继续同步执行状态…",
      },
    })
  })

  test("shows reconnecting hint for stale running task when opencode is reconnecting", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_8")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_8"))
    await store.save_task(
      row("tsk_8", ses.session_id, "in_8", "running"),
    )
    await store.set_conn({
      name: "opencode",
      status: "reconnecting",
      updated_at: 1,
      err: "fetch failed",
      attempt: 2,
      wait_ms: 4000,
    })

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: null,
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_8"))?.status).toBe("running")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "与 OpenCode 的连接暂时中断，正在重连…（第 2 次，约 4 秒后重试） 原因：网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。",
      },
    })
  })

  test("shows connecting hint for stale running task before opencode conn is known", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_9")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_9"))
    await store.save_task(
      row("tsk_9", ses.session_id, "in_9", "running"),
    )

    await sweep(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: null,
      }),
      60000,
      1000,
    )

    expect((await store.get_task("tsk_9"))?.status).toBe("running")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "OpenCode 正在建立连接，稍后会继续同步执行状态…",
      },
    })
  })
})
