import { describe, expect, test } from "bun:test"
import { body, guide, holdmsg, moremsg, on_cmd, on_conn, on_msg, permit, pick, publish, recover, status_text } from "../src/app/boot.ts"
import type { AppCfg, ConnState, FeishuApi, ImSession, InboundMessage, OpencodeSession, OpencodeSvc, RenderOut, SessionSvc, Task } from "../src/contracts.ts"
import { createTaskSvc } from "../src/gateway/task.ts"
import { createRender } from "../src/render/text.ts"
import { createMemoryStore } from "../src/storage/db.ts"

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

function cfg() {
  return {
    log: { level: "info" },
    storage: { path: ":memory:" },
    feishu: { mode: "off" },
    opencode: {
      base_url: "http://127.0.0.1:4096",
      username: "opencode",
      directory: "/tmp",
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
    },
  } satisfies AppCfg
}

function feishu(input?: { patch_err?: string }) {
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
        if (input?.patch_err) throw new Error(input.patch_err)
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

function opencode(input?: { status?: Record<string, unknown> | null; last?: string }) {
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
      if (input?.last) return { state: "ok" as const, text: input.last }
      return { state: "empty" as const }
    },
  } satisfies OpencodeSvc
}

function route() {
  return {
    async resolve() {
      return session()
    },
    async reset() {
      return session({
        session_id: "ses_new",
        directory: "/tmp/new",
      })
    },
    async switch(input) {
      return session({
        session_id: input.session.id,
        directory: input.session.directory,
        workspace_id: input.session.workspace_id,
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
        },
      })
    },
    async bind(input) {
      return session({
        session_id: input.workspace_id ? "ses_bound_ws" : "ses_bound",
        directory: input.directory ?? "/tmp",
        workspace_id: input.workspace_id,
      })
    },
    async model(input) {
      return session({
        session_id: input.session_id,
        model: input.model,
      })
    },
  } satisfies SessionSvc
}

describe("boot helpers", () => {
  test("strips bot mentions from group body", () => {
    expect(
      body(
        inbound({
          chat_type: "group",
          text: "@飞书 CLI   看看这个\n",
          mention_names: ["飞书 CLI"],
        }),
      ),
    ).toBe("看看这个")
  })

  test("permission only accepts explicit numeric choices", () => {
    expect(permit("1")).toBe("once")
    expect(permit("2")).toBe("always")
    expect(permit("3")).toBe("reject")
    expect(permit("继续")).toBeUndefined()
    expect(permit("1,2")).toBeUndefined()
  })

  test("question picks numbered options", () => {
    expect(pick("1,2", ["a", "b", "c"])).toEqual(["a", "b"])
    expect(pick("2 2", ["a", "b", "c"])).toEqual(["b"])
    expect(pick("继续", ["a", "b"])).toBeUndefined()
  })

  test("adds attachment guidance only when assets are present", () => {
    expect(
      guide("这是什么", [
        {
          kind: "image",
          key: "img_1",
        },
      ]),
    ).toContain("不要把内部工具调用、读取过程、本地缓存路径或系统注入文本当作最终答案的一部分。")
    expect(
      guide("这是什么", [
        {
          kind: "image",
          key: "img_1",
        },
      ]),
    ).toContain("附件概览：1 张图片")
    expect(
      guide("这是什么", [
        {
          kind: "image",
          key: "img_1",
        },
      ]),
    ).toContain("用户要求：这是什么")
    expect(guide("普通问题", [])).toBe("普通问题")
  })

  test("includes attachment order for multi-asset prompts", () => {
    const val = guide("分别说明这些附件", [
      {
        kind: "image",
        key: "img_1",
        name: "cover.png",
      },
      {
        kind: "image",
        key: "img_2",
        name: "diagram.png",
      },
      {
        kind: "file",
        key: "file_1",
        name: "report.pdf",
      },
    ])

    expect(val).toContain("附件概览：2 张图片，1 个文件")
    expect(val).toContain("1. 图片 cover.png")
    expect(val).toContain("2. 图片 diagram.png")
    expect(val).toContain("3. 文件 report.pdf")
    expect(val).toContain("第 N 个附件")
  })

  test("formats waiting attachment hints with initial and accumulated counts", () => {
    expect(
      holdmsg([
        {
          kind: "image",
          key: "img_1",
        },
        {
          kind: "file",
          key: "file_1",
        },
      ]),
    ).toBe("已收到 1 张图片，1 个文件，请再发一句你希望我做什么。我会把这些附件和你的说明一起处理。")

    expect(
      moremsg(
        [
          {
            kind: "image",
            key: "img_2",
          },
        ],
        [
          {
            kind: "image",
            key: "img_1",
          },
          {
            kind: "file",
            key: "file_1",
          },
          {
            kind: "image",
            key: "img_2",
          },
        ],
      ),
    ).toBe("又收到 1 张图片，当前累计 2 张图片，1 个文件，请再发一句你希望我做什么。")
  })

  test("renders status report with connection and progress summary", () => {
    const message = {
      name: "message",
      status: "reconnecting",
      updated_at: 1,
      attempt: 3,
    } satisfies ConnState
    const opencode = {
      name: "opencode",
      status: "reconnecting",
      updated_at: 1,
      err: "fetch failed",
      attempt: 2,
      wait_ms: 4000,
    } satisfies ConnState

    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: "question:0:%E8%AF%B7%E9%80%89%E6%8B%A9:A|B|C|D",
          updated_at: 1710000000000,
        }),
        current: {
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
        },
        pref: {
          chat: {
            scope: "chat",
            tenant_id: "tenant",
            chat_id: "chat",
            directory: "/tmp/chat",
          },
          user: {
            scope: "user",
            tenant_id: "tenant",
            user_id: "user",
            directory: "/tmp/user",
          },
        },
        conf: cfg(),
        syncd: "unknown",
        message,
        opencode,
      }),
    ).toContain("会话状态：waiting_question（等待补充信息）")
    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: "question:0:%E8%AF%B7%E9%80%89%E6%8B%A9:A|B|C|D",
          updated_at: 1710000000000,
        }),
        current: {
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
        },
        pref: {
          chat: {
            scope: "chat",
            tenant_id: "tenant",
            chat_id: "chat",
            directory: "/tmp/chat",
          },
          user: {
            scope: "user",
            tenant_id: "tenant",
            user_id: "user",
            directory: "/tmp/user",
          },
        },
        conf: cfg(),
        syncd: "unknown",
        message,
        opencode,
      }),
    ).toContain("飞书连接：reconnecting #3")
    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: "question:0:%E8%AF%B7%E9%80%89%E6%8B%A9:A|B|C|D",
          updated_at: 1710000000000,
        }),
        current: {
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
        },
        pref: {
          chat: {
            scope: "chat",
            tenant_id: "tenant",
            chat_id: "chat",
            directory: "/tmp/chat",
          },
          user: {
            scope: "user",
            tenant_id: "tenant",
            user_id: "user",
            directory: "/tmp/user",
          },
        },
        conf: cfg(),
        syncd: "unknown",
        message,
        opencode,
      }),
    ).toContain("OpenCode 连接：reconnecting")
    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: "question:0:%E8%AF%B7%E9%80%89%E6%8B%A9:A|B|C|D",
          updated_at: 1710000000000,
        }),
        current: {
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
        },
        pref: {
          chat: {
            scope: "chat",
            tenant_id: "tenant",
            chat_id: "chat",
            directory: "/tmp/chat",
          },
          user: {
            scope: "user",
            tenant_id: "tenant",
            user_id: "user",
            directory: "/tmp/user",
          },
        },
        conf: cfg(),
        syncd: "unknown",
        message,
        opencode,
      }),
    ).toContain("OpenCode 连接：reconnecting #2 - 约 4 秒后重试 - 网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。")
    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: "question:0:%E8%AF%B7%E9%80%89%E6%8B%A9:A|B|C|D",
          updated_at: 1710000000000,
        }),
        current: {
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
        },
        pref: {
          chat: {
            scope: "chat",
            tenant_id: "tenant",
            chat_id: "chat",
            directory: "/tmp/chat",
          },
          user: {
            scope: "user",
            tenant_id: "tenant",
            user_id: "user",
            directory: "/tmp/user",
          },
        },
        conf: cfg(),
        syncd: "unknown",
        message,
        opencode,
      }),
    ).toContain("最近进展：等待补充信息：请选择 (1.A / 2.B / 3.C / ...)")
    expect(
      status_text({
        row: row({
          status: "running",
          note: "开始处理: build / gpt-5.4",
          updated_at: 1710000000000,
        }),
        current: {
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
        },
        pref: {
          chat: {
            scope: "chat",
            tenant_id: "tenant",
            chat_id: "chat",
            directory: "/tmp/chat",
          },
          user: {
            scope: "user",
            tenant_id: "tenant",
            user_id: "user",
            directory: "/tmp/user",
          },
        },
        conf: cfg(),
        message,
        opencode,
      }),
    ).toContain("下一步：当前正在等待 OpenCode 连接恢复，可稍后重试 /status，或发送 /abort 终止。")
  })

  test("renders terminal note for completed status", () => {
    expect(
      status_text({
        row: row({
          status: "completed",
          note: "最终总结内容",
        }),
        current: null,
        pref: {
          chat: null,
          user: null,
        },
        conf: cfg(),
      }),
    ).toContain("最近进展：最终总结内容")
  })

  test("message reconnect resumes waiting attachment prompt", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_attachment",
        note: "等待补充说明",
      }),
    )
    await store.save_pending({
      session_id: "ses_1",
      inbound_id: "in_1",
      assets: [
        {
          kind: "image",
          key: "img_1",
          name: "a.png",
          mime: "image/png",
          url: "file:///tmp/a.png",
        },
      ],
      created_at: 1,
      updated_at: 1,
    })

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 2,
      },
    )

    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "飞书消息连接已恢复，仍在等待你的补充说明。",
      },
    })
  })

  test("message reconnect restores waiting permission only when remote is still busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_permission",
        req: "req_1",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent('{"filepath":"/tmp"}')}`,
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("waiting_permission")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        type: "approval",
        req: "req_1",
        tool: "external_directory",
      },
    })
  })

  test("message reconnect fails stale waiting question when remote is already idle", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_question",
        req: "req_1",
        note: `question:1:${encodeURIComponent("请选择")}:${encodeURIComponent("A")}|${encodeURIComponent("B")}`,
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
      }),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("failed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "red",
        text: "出错了：飞书消息连接恢复后，之前的补充问题已失效，请重新发送上一条消息。",
      },
    })
  })

  test("message reconnect keeps waiting permission pending when remote status is unknown", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_permission",
        req: "req_1",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent('{"filepath":"/tmp"}')}`,
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: null,
      }),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("waiting_permission")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "飞书消息连接已恢复，正在继续同步执行状态…",
      },
    })
  })

  test("message reconnect promotes queued task when remote is still busy", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "queued",
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 1,
        attempt: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "飞书消息连接已恢复，正在继续同步执行状态…",
      },
    })
  })

  test("message reconnect finishes running task when remote is already idle with output", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
        last: "resume done",
      }),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 1,
        attempt: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("completed")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "green",
        text: "resume done",
      },
    })
  })

  test("message reconnect keeps running task alive when remote status is unknown", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: null,
      }),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 1,
        attempt: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "飞书消息连接已恢复，正在继续同步执行状态…",
      },
    })
  })

  test("opencode reconnect runs recover path", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "opencode",
        status: "error",
        updated_at: 1,
        err: "boom",
      },
      {
        name: "opencode",
        status: "ready",
        updated_at: 2,
      },
    )

    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "OpenCode 连接已恢复，正在继续同步执行状态…",
      },
    })
  })

  test("opencode first ready after connecting also runs recover path", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "opencode",
        status: "connecting",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "ready",
        updated_at: 2,
      },
    )

    expect(ui.list.at(-1)?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "OpenCode 连接已恢复，正在继续同步执行状态…",
      },
    })
  })

  test("boot sync hint is patched forward when opencode becomes ready", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({ status: null }), "boot")
    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "opencode",
        status: "connecting",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "ready",
        updated_at: 2,
      },
    )

    expect(ui.list).toHaveLength(2)
    expect(ui.list[0]).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "OpenCode 正在建立连接，稍后会继续同步执行状态…",
        },
      },
    })
    expect(ui.list[1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "OpenCode 连接已恢复，正在继续同步执行状态…",
        },
      },
    })
  })

  test("boot recovered queued task is not failed again after opencode first ready", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "queued",
      }),
    )

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({ status: null }), "boot")
    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "opencode",
        status: "connecting",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list).toHaveLength(2)
    expect(ui.list[0]).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "OpenCode 正在建立连接，稍后会继续同步执行状态…",
        },
      },
    })
    expect(ui.list[1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "OpenCode 连接已恢复，正在继续同步执行状态…",
        },
      },
    })
  })

  test("boot recovered running task is not finished again by later watchdog", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
      }),
    )

    await recover(cfg(), store, svc, ui.api, createRender(), opencode({ status: null }), "boot")
    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {},
        last: "done after reconnect",
      }),
      {
        name: "opencode",
        status: "connecting",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "ready",
        updated_at: 2,
      },
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("completed")
    expect(ui.list).toHaveLength(2)
    expect(ui.list[0]).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "OpenCode 正在建立连接，稍后会继续同步执行状态…",
        },
      },
    })
    expect(ui.list[1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "green",
          text: "done after reconnect",
        },
      },
    })
  })

  test("connection burst only signals reconnecting once for active task", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
        updated_at: 1,
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "ready",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "error",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "error",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 3,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
    )

    expect(ui.list).toHaveLength(1)
    expect(ui.list[0]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "与 OpenCode 的连接暂时中断，正在重连…（第 1 次，约 1 秒后重试） 原因：网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。",
      },
    })
  })

  test("repeated reconnecting states do not spam active task", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
        updated_at: 1,
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "ready",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 3,
      },
    )

    expect(ui.list).toHaveLength(1)
  })

  test("reconnecting reason change updates active task immediately", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
        updated_at: Date.now(),
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "ready",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 3,
        err: "unknown certificate verification error",
        attempt: 2,
        wait_ms: 2000,
      },
    )

    expect(ui.list).toHaveLength(2)
    expect(ui.list.at(-1)).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "与 OpenCode 的连接暂时中断，正在重连…（第 2 次，约 2 秒后重试） 原因：网络请求失败：证书校验失败，请检查代理、HTTPS 证书或企业网关配置。",
        },
      },
    })
  })

  test("new reconnect cycle after recovery is not hidden by cooldown", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
        updated_at: Date.now(),
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "ready",
        updated_at: 1,
      },
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 2,
        err: "fetch failed",
        attempt: 1,
        wait_ms: 1000,
      },
      {
        name: "opencode",
        status: "ready",
        updated_at: 3,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "opencode",
        status: "ready",
        updated_at: 3,
      },
      {
        name: "opencode",
        status: "reconnecting",
        updated_at: 4,
        err: "fetch failed",
        attempt: 2,
        wait_ms: 2000,
      },
    )

    expect(ui.list.at(-1)).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "与 OpenCode 的连接暂时中断，正在重连…（第 2 次，约 2 秒后重试） 原因：网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。",
        },
      },
    })
  })

  test("message connection burst only signals reconnecting once for active task", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
        updated_at: 1,
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "message",
        status: "ready",
        updated_at: 1,
      },
      {
        name: "message",
        status: "error",
        updated_at: 2,
        err: "ws closed",
        attempt: 1,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "message",
        status: "error",
        updated_at: 2,
        err: "ws closed",
        attempt: 1,
      },
      {
        name: "message",
        status: "reconnecting",
        updated_at: 3,
        err: "ws closed",
        attempt: 1,
      },
    )

    expect(ui.list).toHaveLength(1)
    expect(ui.list[0]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "飞书消息连接暂时中断，正在重连…（第 1 次） 原因：ws closed",
      },
    })
  })

  test("message reconnecting reason change updates active task immediately", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
        updated_at: Date.now(),
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "message",
        status: "ready",
        updated_at: 1,
      },
      {
        name: "message",
        status: "reconnecting",
        updated_at: 2,
        err: "ws closed",
        attempt: 1,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 2,
        err: "ws closed",
        attempt: 1,
      },
      {
        name: "message",
        status: "reconnecting",
        updated_at: 3,
        err: "network jitter",
        attempt: 2,
      },
    )

    expect(ui.list).toHaveLength(2)
    expect(ui.list.at(-1)).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "飞书消息连接暂时中断，正在重连…（第 2 次） 原因：网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。",
        },
      },
    })
  })

  test("new message reconnect cycle after recovery is not hidden by cooldown", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
        updated_at: Date.now(),
      }),
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "message",
        status: "ready",
        updated_at: 1,
      },
      {
        name: "message",
        status: "reconnecting",
        updated_at: 2,
        err: "ws closed",
        attempt: 1,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      {
        name: "message",
        status: "reconnecting",
        updated_at: 2,
        err: "ws closed",
        attempt: 1,
      },
      {
        name: "message",
        status: "ready",
        updated_at: 3,
      },
    )

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      createRender(),
      opencode(),
      {
        name: "message",
        status: "ready",
        updated_at: 3,
      },
      {
        name: "message",
        status: "reconnecting",
        updated_at: 4,
        err: "network jitter",
        attempt: 2,
      },
    )

    expect(ui.list.at(-1)).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "blue",
          text: "飞书消息连接暂时中断，正在重连…（第 2 次） 原因：网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。",
        },
      },
    })
  })
})

describe("publish", () => {
  test("dedups identical payload instead of patching again", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        outbound_id: "out_old",
      }),
    )
    await store.save_outbound({
      task_id: "tsk_1",
      msg_id: "out_old",
      kind: "card",
      payload: {
        title: "OpenCode",
        template: "blue",
        step: "步骤 1",
        text: "处理中…",
      },
      created_at: 1,
      updated_at: 1,
    })

    await publish(
      store,
      task,
      ui.api,
      "ses_1",
      "chat",
      {
        kind: "card",
        body: {
          title: "OpenCode",
          template: "blue",
          step: "步骤 1",
          text: "处理中…",
        },
      },
      { dedup: true },
    )

    expect(ui.list).toEqual([])
  })

  test("does not dedup when only step changes", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        outbound_id: "out_old",
        note: "处理中…",
      }),
    )
    await store.save_outbound({
      task_id: "tsk_1",
      msg_id: "out_old",
      kind: "card",
      payload: {
        title: "OpenCode",
        template: "blue",
        step: "步骤 1",
        text: "处理中…",
      },
      created_at: 1,
      updated_at: 1,
    })

    await publish(
      store,
      task,
      ui.api,
      "ses_1",
      "chat",
      {
        kind: "card",
        body: {
          title: "OpenCode",
          template: "blue",
          step: "步骤 2",
          text: "处理中…",
        },
      },
      { dedup: true },
    )

    expect(ui.list).toEqual([
      {
        kind: "patch",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "blue",
            step: "步骤 2",
            text: "处理中…",
          },
        },
      },
    ])
  })

  test("falls back to reply when patch fails", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu({ patch_err: "patch failed" })
    const warn = console.warn
    console.warn = () => undefined
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        outbound_id: "out_old",
      }),
    )

    try {
      await publish(
        store,
        task,
        ui.api,
        "ses_1",
        "chat",
        {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "green",
            text: "done",
          },
        },
      )
    } finally {
      console.warn = warn
    }

    expect(ui.list.map((item) => item.kind)).toEqual(["patch", "reply"])
    expect((await store.get_task("tsk_1"))?.outbound_id).toBe("out_reply")
    expect(await store.get_outbound("tsk_1")).toMatchObject({
      msg_id: "out_reply",
    })
  })
})

describe("commands", () => {
  test("/session shows current session with repo and model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        workspace_id: "ws_1",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
        },
      }),
    )

    const ok = await on_cmd("/session", cfg(), route(), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/session" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("当前会话：ses_1")
    expect(text).toContain("目录：/tmp (workspace=ws_1)")
    expect(text).toContain("模型：anthropic/claude-sonnet-4")
    expect(text).toContain("使用 /session <session_id> 切换当前会话。")
  })

  test("/session <id> switches and shows repo workspace and model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    const oc = {
      ...opencode(),
      async session(id: string) {
        return {
          id,
          title: "picked",
          directory: "/tmp/alt",
          workspace_id: "ws_alt",
          created_at: 1,
          updated_at: 1,
        } satisfies OpencodeSession
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/session ses_alt", cfg(), route(), svc, store, ui.api, createRender(), oc, inbound({ text: "/session ses_alt" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "已切换当前会话。",
          "session: ses_alt",
          "目录：/tmp/alt (workspace=ws_alt)",
          "模型：anthropic/claude-sonnet-4",
        ].join("\n"),
      },
    })
  })

  test("/repo shows session over chat and user defaults", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/session", workspace_id: "ws_session" }))
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat",
      workspace_id: "ws_chat",
    })
    await store.save_pref({
      scope: "user",
      tenant_id: "tenant",
      user_id: "user",
      directory: "/tmp/user",
      workspace_id: "ws_user",
    })

    const ok = await on_cmd("/repo", cfg(), route(), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/repo" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "当前目录：/tmp/session (workspace=ws_session)",
          "聊天默认：/tmp/chat (workspace=ws_chat)",
          "用户默认：/tmp/user (workspace=ws_user)",
        ].join("\n"),
      },
    })
  })

  test("/repo --chat updates chat default with workspace", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()

    const ok = await on_cmd(
      "/repo --chat /tmp/chat-next --workspace ws_chat_next",
      cfg(),
      route(),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --chat /tmp/chat-next --workspace ws_chat_next" }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_pref({ scope: "chat", tenant_id: "tenant", chat_id: "chat" })).toMatchObject({
      directory: "/tmp/chat-next",
      workspace_id: "ws_chat_next",
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已设置当前聊天默认绑定：/tmp/chat-next (workspace=ws_chat_next)",
      },
    })
  })

  test("/status explains current session and scope context", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        workspace_id: "ws_session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
        },
      }),
    )
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat",
      workspace_id: "ws_chat",
    })
    await store.save_pref({
      scope: "user",
      tenant_id: "tenant",
      user_id: "user",
      directory: "/tmp/user",
      workspace_id: "ws_user",
    })
    await store.set_conn({
      name: "message",
      status: "connected",
      updated_at: 1,
    })
    await store.set_conn({
      name: "opencode",
      status: "connected",
      updated_at: 1,
    })

    const ok = await on_cmd("/status", cfg(), route(), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/status" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("会话状态：idle")
    expect(text).toContain("目录：/tmp (workspace=ws_session)")
    expect(text).toContain("当前模型：anthropic/claude-sonnet-4")
    expect(text).toContain("聊天默认：/tmp/chat (workspace=ws_chat)")
    expect(text).toContain("用户默认：/tmp/user (workspace=ws_user)")
    expect(text).toContain("session: ses_1")
  })

  test("/sessions uses current scope and marks current session", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/chat", workspace_id: "ws_chat" }))
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat",
      workspace_id: "ws_chat",
    })
    const oc = {
      ...opencode(),
      async sessions(input: { directory?: string; roots?: boolean; limit?: number }) {
        expect(input).toEqual({
          directory: "/tmp/chat",
          roots: true,
          limit: 8,
        })
        return [
          {
            id: "ses_1",
            title: "current",
            directory: "/tmp/chat",
            workspace_id: "ws_chat",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_2",
            title: "older",
            directory: "/tmp/chat",
            workspace_id: "ws_chat",
            created_at: 1,
            updated_at: 1,
          },
        ]
      },
      async status(input: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp/chat",
          workspace: "ws_chat",
        })
        return {
          ses_1: { type: "running" },
          ses_2: { type: "idle" },
        }
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/sessions", cfg(), route(), svc, store, ui.api, createRender(), oc, inbound({ text: "/sessions" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 2 条）：")
    expect(text).toContain("[当前] [running] current")
    expect(text).toContain("session: ses_2")
    expect(text).toContain("目录: /tmp/chat (workspace=ws_chat)")
  })

  test("/new resets session with chat default scope", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat-default",
      workspace_id: "ws_chat_default",
    })
    const svc_route = {
      ...route(),
      async reset() {
        return session({
          session_id: "ses_new",
          directory: "/tmp/chat-default",
          workspace_id: "ws_chat_default",
        })
      },
    } satisfies SessionSvc

    const ok = await on_cmd("/new", cfg(), svc_route, svc, store, ui.api, createRender(), opencode(), inbound({ text: "/new" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已创建新会话。", "目录：/tmp/chat-default (workspace=ws_chat_default)"].join("\n"),
      },
    })
  })

  test("/repo --me updates user default with workspace", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()

    const ok = await on_cmd(
      "/repo --me /tmp/me-next --workspace ws_me_next",
      cfg(),
      route(),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --me /tmp/me-next --workspace ws_me_next" }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_pref({ scope: "user", tenant_id: "tenant", user_id: "user" })).toMatchObject({
      directory: "/tmp/me-next",
      workspace_id: "ws_me_next",
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已设置当前用户默认绑定：/tmp/me-next (workspace=ws_me_next)",
      },
    })
  })

  test("/repo --workspace binds current session and switches when scope changes", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())

    const ok = await on_cmd(
      "/repo --workspace ws_local",
      cfg(),
      route(),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --workspace ws_local" }),
    )

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已绑定：/tmp (workspace=ws_local)", "已切换到新会话。"].join("\n"),
      },
    })
  })

  test("/model shows current and default model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
        },
      }),
    )

    const ok = await on_cmd("/model", cfg(), route(), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/model" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "当前模型：anthropic/claude-sonnet-4",
          "默认模型：openai/gpt-5.4",
          "session: ses_1",
          "使用 /model <provider>/<model_id> 切换当前模型，或 /model reset 恢复默认。",
        ].join("\n"),
      },
    })
  })

  test("/model provider/model switches current model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    const oc = {
      ...opencode(),
      async providers() {
        return [
          {
            id: "openai",
            name: "OpenAI",
            connected: true,
            default_model: "gpt-5.4",
            models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
          },
        ]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/model openai/gpt-5.4", cfg(), route(), svc, store, ui.api, createRender(), oc, inbound({ text: "/model openai/gpt-5.4" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已切换当前模型。", "当前模型：openai/gpt-5.4", "session: ses_1"].join("\n"),
      },
    })
  })

  test("/model rejects invalid format", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()

    const ok = await on_cmd("/model badformat", cfg(), route(), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/model badformat" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "模型格式应为 <provider>/<model_id>，例如 /model cba_openai/gpt-5.4",
      },
    })
  })

  test("/model rejects unavailable target", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const oc = {
      ...opencode(),
      async providers() {
        return [
          {
            id: "openai",
            name: "OpenAI",
            connected: true,
            default_model: "gpt-5.4",
            models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
          },
        ]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/model anthropic/claude-sonnet-4", cfg(), route(), svc, store, ui.api, createRender(), oc, inbound({ text: "/model anthropic/claude-sonnet-4" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "当前没有可用模型：anthropic/claude-sonnet-4",
      },
    })
  })

  test("/model reset shows default model for current session", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
        },
      }),
    )

    const ok = await on_cmd("/model reset", cfg(), route(), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/model reset" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "已恢复默认模型。",
          "当前模型：openai/gpt-5.4",
          "session: ses_1",
        ].join("\n"),
      },
    })
  })

  test("waiting_question accepts direct text answer when custom reply is allowed", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_question",
        req_type: "question",
        req: "req_q_1",
        note: `question:1:${encodeURIComponent("要更新哪个仓库的 AGENTS.md？")}:${encodeURIComponent("workspace/opencode")}|${encodeURIComponent("workspace/opencode-feishu-imui")}`,
      }),
    )
    const calls: Array<{ req: string; answers: string[][]; workspace?: string }> = []
    const oc = {
      ...opencode(),
      async answer(input) {
        calls.push({
          req: input.req,
          answers: input.answers,
          workspace: input.workspace,
        })
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_q_2",
        event_id: "evt_q_2",
        message_id: "msg_q_2",
        text: "都不选，测试一下",
      }),
    )

    expect(calls).toEqual([
      {
        req: "req_q_1",
        answers: [["都不选，测试一下"]],
        workspace: undefined,
      },
    ])
    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list[0]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "已提交补充信息",
      },
    })
  })
})
