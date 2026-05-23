/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { body, guide, holdmsg, moremsg, on_cmd, on_conn, on_msg, publish, recover, status_text } from "../src/app/boot.ts"
import type { AppCfg, ConnState, FeishuApi, ImSession, InboundMessage, OpencodeResult, OpencodeSession, OpencodeStatus, OpencodeSvc, RenderOut, SessionSvc, Task } from "../src/contracts.ts"
import { createSessionSvc } from "../src/gateway/session.ts"
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

function cfg(input?: Partial<AppCfg["opencode"]>) {
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
      ...input,
    },
  } satisfies AppCfg
}

function feishu(input?: { patch_err?: string }) {
  const list: Array<{ kind: "send" | "reply" | "patch"; out: RenderOut }> = []
  const patches: Array<{ msg_id: string; out: RenderOut }> = []
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
        patches.push({ msg_id: item.msg_id, out: item.out })
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
    patches,
  }
}

function opencode(input?: { status?: Record<string, OpencodeStatus> | null; last?: string | undefined; result?: OpencodeResult }) {
  const ensures: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
  const svc = {
    async ensure(payload?: { directory?: string; workspace?: string; session_id?: string }) {
      ensures.push(payload ?? {})
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
    async status(_input: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>> {
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
    async last(_input: { session_id: string; directory?: string; workspace?: string }): Promise<string | undefined> {
      return input?.last
    },
    async result(_input: { session_id: string; directory?: string; workspace?: string }): Promise<OpencodeResult> {
      if (input?.result) return input.result
      if (input?.last) return { state: "ok" as const, text: input.last }
      return { state: "empty" as const }
    },
  } satisfies OpencodeSvc
  return Object.assign(svc, {
    ensures,
  })
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
  const outbound = {
    id: `aso_${input.id}_${input.req}`,
    task_id: input.id,
    session_id: taskRow.session_id,
    seq: input.seq ?? 1,
    kind: input.kind,
    action,
    state: "open" as const,
    origin_inbound_id: input.inbound_id,
    origin_message_id: `msg_${input.inbound_id}`,
    req_key: input.req,
    terminal: false,
    feishu_message_id: input.outbound_id,
    payload: input.payload,
    created_at: input.created_at ?? 1,
    updated_at: input.updated_at ?? 1,
  }
  await store.save_task(taskRow)
  await store.save_assistant_outbound(outbound)
}

function route(store: ReturnType<typeof createMemoryStore>) {
  return {
    async current(input) {
      return store.get_session(input)
    },
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
    const current = {
      session_id: "ses_1",
      directory: "/tmp/work",
      workspace_id: "wrk_1",
      state: "active" as const,
    }
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
        current,
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
        current,
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
        current,
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
        current,
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
        current,
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
        current,
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

  test("renders card-first next-step hints while preserving text fallback", () => {
    const current = {
      session_id: "ses_1",
      directory: "/tmp/work",
      workspace_id: "wrk_1",
      state: "active" as const,
    }

    expect(
      status_text({
        row: row({
          status: "waiting_permission",
          note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/tmp" }))}`,
        }),
        current,
        pref: { chat: null, user: null },
        conf: cfg(),
      }),
    ).toContain("下一步：请点击卡片按钮继续；如需更正本次操作，请直接发送非数字文本说明。")

    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: `question:0:${encodeURIComponent("请选择")}:${encodeURIComponent("A")}|${encodeURIComponent("B")}`,
        }),
        current,
        pref: { chat: null, user: null },
        conf: cfg(),
      }),
    ).toContain("下一步：请在卡片中选择后提交。")

    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: `question:1:${encodeURIComponent("请选择")}:${encodeURIComponent("A")}|${encodeURIComponent("B")}`,
        }),
        current,
        pref: { chat: null, user: null },
        conf: cfg(),
      }),
    ).toContain("下一步：请在卡片中选择后提交；如需自定义补充，请直接发送非数字文本。")

    expect(
      status_text({
        row: row({
          status: "waiting_question",
          note: `question:1:${encodeURIComponent("请补充说明")}`,
        }),
        current,
        pref: { chat: null, user: null },
        conf: cfg(),
      }),
    ).toContain("下一步：请直接发送你的回答继续。")
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
    await store.save_task_pending({
      task_id: "tsk_1",
      session_id: "ses_1",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
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

    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "飞书消息连接已恢复，仍在等待你的补充说明。",
      },
    })
  })

  test("message reconnect clears invalid waiting attachment pending", async () => {
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
    await store.save_task_pending({
      task_id: "tsk_1",
      session_id: "ses_1",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      assets: [
        {
          kind: "image",
          key: "img_1",
          name: "broken.png",
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

    expect((await store.get_task("tsk_1"))?.status).toBe("failed")
    expect(await store.get_task_pending("tsk_1")).toBeNull()
    const out = ui.list[ui.list.length - 1]?.out as { body?: { text?: string; template?: string } } | undefined
    expect(out?.body?.template).toBe("red")
    expect(out?.body?.text ?? "").toContain("附件缓存已失效")
  })

  test("/session replay does not duplicate identical waiting attachment history", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const assets = [
      {
        kind: "image" as const,
        key: "img_1",
        name: "a.png",
        mime: "image/png",
        url: "file:///tmp/a.png",
      },
    ]
    const hold = render.progress({
      text: holdmsg(assets),
    })
    await store.save_session(session({ session_id: "ses_current" }))
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        session_id: "ses_wait",
        status: "waiting_attachment",
        note: "等待补充说明",
        outbound_id: "out_wait",
      }),
    )
    await store.save_outbound({
      task_id: "tsk_1",
      msg_id: "out_wait",
      kind: hold.kind,
      payload: hold.body,
      created_at: 1,
      updated_at: 1,
    })
    await store.save_assistant_outbound({
      id: "aso_1",
      task_id: "tsk_1",
      session_id: "ses_wait",
      seq: 1,
      kind: "attachment",
      action: "patch",
      state: "emitted",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      terminal: false,
      feishu_message_id: "out_wait",
      payload: hold.body,
      created_at: 1,
      updated_at: 1,
    })
    await store.save_task_pending({
      task_id: "tsk_1",
      session_id: "ses_wait",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      assets,
      created_at: 1,
      updated_at: 1,
    })
    const oc = {
      ...opencode(),
      async session(id: string) {
        return {
          id,
          title: "picked",
          directory: "/tmp",
          created_at: 1,
          updated_at: 1,
        } satisfies OpencodeSession
      },
    } satisfies OpencodeSvc

    const first = await on_cmd(
      "/session ses_wait",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_cmd_1",
        event_id: "evt_cmd_1",
        message_id: "msg_cmd_1",
        text: "/session ses_wait",
      }),
    )
    const second = await on_cmd(
      "/session ses_wait",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_cmd_2",
        event_id: "evt_cmd_2",
        message_id: "msg_cmd_2",
        text: "/session ses_wait",
      }),
    )

    expect(first).toBeTrue()
    expect(second).toBeTrue()
    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "reply"])
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      kind: "attachment",
      action: "patch",
      state: "emitted",
      feishu_message_id: "out_wait",
      payload: hold.body,
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
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
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
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
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
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
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
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "飞书消息连接已恢复，正在继续同步执行状态…",
      },
    })
  })

  test("message reconnect checkpoints first idle observation and settles on repeated identical output", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      render,
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

    const checkpointed = await store.get_task("tsk_1")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(checkpointed?.status_outbound_id).toBe("out_reply")
    expect(checkpointed?.terminal_kind).toBeUndefined()
    expect(checkpointed?.terminal_outbound_id).toBeUndefined()
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({ text: "resume done" }),
      },
    ])

    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "ok",
          text: "resume done",
          completed: true,
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

    const settled = await store.get_task("tsk_1")
    expect(settled).toMatchObject({
      status: "completed",
      status_outbound_id: "out_reply",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "reply", "patch"])
    expect(ui.list[ui.list.length - 2]?.out).toEqual(render.final({ text: "resume done" }))
    expect(ui.patches).toHaveLength(1)
    expect(ui.patches[0]).toMatchObject({
      msg_id: "out_reply",
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
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
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

    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
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

    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
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

  test("boot recovered running task checkpoints first idle observation, settles once, and ignores later recovery passes", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "running",
      }),
    )

    await recover(cfg(), store, svc, ui.api, render, opencode({ status: null }), "boot")
    await on_conn(
      cfg(),
      store,
      svc,
      ui.api,
      render,
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

    const checkpointed = await store.get_task("tsk_1")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(checkpointed?.terminal_kind).toBeUndefined()
    expect(checkpointed?.terminal_outbound_id).toBeUndefined()
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
    expect(ui.list[1]).toEqual({
      kind: "reply",
      out: render.intermediate({ text: "done after reconnect" }),
    })

    await recover(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "ok",
          text: "done after reconnect",
          completed: true,
        },
      }),
      "boot",
    )

    const settled = await store.get_task("tsk_1")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list[2]).toEqual({
      kind: "reply",
      out: render.final({ text: "done after reconnect" }),
    })
    expect(ui.list[3]).toMatchObject({
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

    await recover(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "done after reconnect",
      }),
      "boot",
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("completed")
    const history = await store.list_assistant_outbounds("tsk_1")
    const terminals = history.filter((item) => item.terminal && item.state === "emitted")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      feishu_message_id: "out_reply",
      payload: expect.objectContaining({
        template: "green",
        state: "final",
        title: "最终完成",
        text: "done after reconnect",
      }),
    })
    expect(ui.list).toHaveLength(4)
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
    expect(ui.list[ui.list.length - 1]).toMatchObject({
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

    expect(ui.list[ui.list.length - 1]).toMatchObject({
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
    expect(ui.list[ui.list.length - 1]).toMatchObject({
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

    expect(ui.list[ui.list.length - 1]).toMatchObject({
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
        status_outbound_id: "out_old",
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
      undefined,
      { kind: "progress" },
    )

    expect(ui.list).toEqual([])
    expect(await store.list_assistant_outbounds("tsk_1")).toEqual([])
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
      undefined,
      { kind: "progress" },
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
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 1,
      kind: "progress",
      action: "patch",
      state: "emitted",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      terminal: false,
      feishu_message_id: "out_old",
      payload: {
        title: "OpenCode",
        template: "blue",
        step: "步骤 2",
        text: "处理中…",
      },
    })
  })

  test("appends generic history row when first publish replies", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    await store.save_inbound(inbound())
    await store.save_task(row())

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
          template: "wathet",
          text: "已收到：开始处理",
        },
      },
      undefined,
      undefined,
      { kind: "ack" },
    )

    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "wathet",
            text: "已收到：开始处理",
          },
        },
      },
    ])
    expect((await store.get_task("tsk_1"))?.outbound_id).toBe("out_reply")
    expect(await store.get_outbound("tsk_1")).toMatchObject({
      msg_id: "out_reply",
    })
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 1,
      kind: "ack",
      action: "reply",
      state: "emitted",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      terminal: false,
      feishu_message_id: "out_reply",
      payload: {
        title: "OpenCode",
        template: "wathet",
        text: "已收到：开始处理",
      },
    })
  })

  test("first publish prefers reply anchor over inbound lookup", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const list: Array<{ kind: "send" | "reply"; msg_id?: string; chat_id?: string; out: RenderOut }> = []
    const api = {
      async send(item) {
        list.push({ kind: "send", chat_id: item.chat_id, out: item.out })
        return { id: "out_send" }
      },
      async reply(item) {
        list.push({ kind: "reply", msg_id: item.msg_id, out: item.out })
        return { id: "out_reply" }
      },
      async patch() {
        throw new Error("not used")
      },
      async fetch() {
        throw new Error("not used")
      },
      async sync() {},
      names() {
        return []
      },
    } satisfies FeishuApi
    await store.save_inbound(
      inbound({
        message_id: "msg_inbound",
      }),
    )
    await store.save_task(
      row({
        reply_anchor_message_id: "msg_anchor",
      }),
    )

    await publish(
      store,
      task,
      api,
      "ses_1",
      "chat",
      {
        kind: "card",
        body: {
          title: "OpenCode",
          template: "wathet",
          text: "已收到：开始处理",
        },
      },
      undefined,
      undefined,
      { kind: "ack" },
    )

    expect(list).toEqual([
      {
        kind: "reply",
        msg_id: "msg_anchor",
        out: {
          kind: "card",
          body: {
            title: "OpenCode",
            template: "wathet",
            text: "已收到：开始处理",
          },
        },
      },
    ])
    expect((await store.get_task("tsk_1"))?.outbound_id).toBe("out_reply")
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      kind: "ack",
      action: "reply",
      state: "emitted",
      origin_message_id: "msg_anchor",
      feishu_message_id: "out_reply",
    })
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
        status_outbound_id: "out_old",
      }),
    )
    await store.save_assistant_outbound({
      id: "aso_old",
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 1,
      kind: "progress",
      action: "patch",
      state: "emitted",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      terminal: false,
      feishu_message_id: "out_old",
      payload: {
        title: "OpenCode",
        template: "blue",
        step: "步骤 1",
        text: "处理中…",
      },
      created_at: 1,
      updated_at: 1,
    })

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
        undefined,
        undefined,
        { kind: "final", terminal: true },
      )
    } finally {
      console.warn = warn
    }

    expect(ui.list.map((item) => item.kind)).toEqual(["patch", "reply"])
    expect((await store.get_task("tsk_1"))?.outbound_id).toBe("out_reply")
    expect((await store.get_task("tsk_1"))?.status_outbound_id).toBe("out_reply")
    expect(await store.get_outbound("tsk_1")).toMatchObject({
      msg_id: "out_reply",
    })
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
      id: "aso_old",
      kind: "progress",
      action: "patch",
      state: "emitted",
      feishu_message_id: "out_old",
    })
    expect(history[1]).toMatchObject({
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 2,
      kind: "final",
      action: "reply",
      state: "emitted",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      terminal: true,
      feishu_message_id: "out_reply",
      payload: {
        title: "OpenCode",
        template: "green",
        text: "done",
      },
    })
  })

  test("does not fall back to reply when post-patch bookkeeping fails", async () => {
    const scenarios = [
      {
        name: "assistant history write",
        expectedError: "assistant history failed",
        inject(store: ReturnType<typeof createMemoryStore>) {
          store.save_assistant_outbound = async (_input) => {
            throw new Error("assistant history failed")
          }
        },
      },
      {
        name: "visible slot mirror write",
        expectedError: "visible slot mirror failed",
        inject(store: ReturnType<typeof createMemoryStore>) {
          store.save_outbound = async (_input) => {
            throw new Error("visible slot mirror failed")
          }
        },
      },
    ] as const

    for (const scenario of scenarios) {
      const store = createMemoryStore()
      const task = createTaskSvc(store)
      const ui = feishu()
      await store.save_inbound(inbound())
      await store.save_task(
        row({
          outbound_id: "out_old",
          status_outbound_id: "out_old",
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
      await store.save_assistant_outbound({
        id: "aso_old",
        task_id: "tsk_1",
        session_id: "ses_1",
        seq: 1,
        kind: "progress",
        action: "patch",
        state: "emitted",
        origin_inbound_id: "in_1",
        origin_message_id: "msg_1",
        terminal: false,
        feishu_message_id: "out_old",
        payload: {
          title: "OpenCode",
          template: "blue",
          step: "步骤 1",
          text: "处理中…",
        },
        created_at: 1,
        updated_at: 1,
      })
      scenario.inject(store)

      await expect(
        publish(
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
          undefined,
          undefined,
          { kind: "final", terminal: true },
        ),
        `${scenario.name} should surface without a fallback reply`,
      ).rejects.toThrow(scenario.expectedError)

      expect(ui.list.map((item) => item.kind), scenario.name).toEqual(["patch"])
      expect((await store.get_task("tsk_1"))?.outbound_id, scenario.name).toBe("out_old")
      expect((await store.get_task("tsk_1"))?.status_outbound_id, scenario.name).toBe("out_old")
      expect((await store.get_outbound("tsk_1"))?.msg_id, scenario.name).toBe("out_old")
    }
  })


  test("final after emitted intermediate replies with a new card and patches the initial card status", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        outbound_id: "out_old",
        status_outbound_id: "out_old",
      }),
    )
    await store.save_assistant_outbound({
      id: "aso_intermediate",
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 1,
      kind: "intermediate",
      action: "reply",
      state: "emitted",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      terminal: false,
      feishu_message_id: "out_old",
      payload: {
        title: "OpenCode",
        template: "blue",
        state: "intermediate",
        text: "阶段性完成\n\npartial",
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
          template: "green",
          text: "done",
        },
      },
      undefined,
      undefined,
      { kind: "final", terminal: true },
    )

    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "patch"])
    expect(ui.list[0]).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
        body: {
          title: "OpenCode",
          template: "green",
          text: "done",
        },
      },
    })
    expect(ui.patches).toHaveLength(1)
    expect(ui.patches[0]).toMatchObject({
      msg_id: "out_old",
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
    expect((await store.get_task("tsk_1"))?.outbound_id).toBe("out_reply")
    expect((await store.get_task("tsk_1"))?.status_outbound_id).toBe("out_old")
    expect(await store.get_outbound("tsk_1")).toMatchObject({
      msg_id: "out_reply",
    })
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
      id: "aso_intermediate",
      kind: "intermediate",
      action: "reply",
      feishu_message_id: "out_old",
    })
    expect(history[1]).toMatchObject({
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 2,
      kind: "final",
      action: "reply",
      state: "emitted",
      terminal: true,
      feishu_message_id: "out_reply",
    })
  })

  test("final without prior intermediate still patches the visible slot", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        outbound_id: "out_old",
      }),
    )
    await store.save_assistant_outbound({
      id: "aso_progress",
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 1,
      kind: "progress",
      action: "patch",
      state: "emitted",
      origin_inbound_id: "in_1",
      origin_message_id: "msg_1",
      terminal: false,
      feishu_message_id: "out_old",
      payload: {
        title: "OpenCode",
        template: "blue",
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
          template: "green",
          text: "done",
        },
      },
      undefined,
      undefined,
      { kind: "final", terminal: true },
    )

    expect(ui.list.map((item) => item.kind)).toEqual(["patch"])
    expect((await store.get_task("tsk_1"))?.outbound_id).toBe("out_old")
    expect(await store.get_outbound("tsk_1")).toMatchObject({
      msg_id: "out_old",
    })
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({
      kind: "final",
      action: "patch",
      feishu_message_id: "out_old",
    })
  })

  test("same-task follow-up final still patches the preserved processing card", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    await store.save_inbound(
      inbound({
        id: "in_prev",
        event_id: "evt_prev",
        message_id: "msg_prev",
      }),
    )
    await store.save_inbound(
      inbound({
        id: "in_rebind",
        event_id: "evt_rebind",
        message_id: "msg_rebind",
      }),
    )
    await store.save_task(
      row({
        inbound_id: "in_rebind",
        reply_anchor_message_id: "msg_rebind",
        outbound_id: "out_followup_ack",
        status_outbound_id: "out_processing",
      }),
    )
    await store.save_assistant_outbound({
      id: "aso_prev_intermediate",
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 1,
      kind: "intermediate",
      action: "reply",
      state: "emitted",
      origin_inbound_id: "in_prev",
      origin_message_id: "msg_prev",
      terminal: false,
      feishu_message_id: "out_intermediate_prev",
      payload: {
        title: "OpenCode",
        template: "blue",
        state: "intermediate",
        text: "阶段性完成\n\npartial",
      },
      created_at: 1,
      updated_at: 1,
    })
    await store.save_assistant_outbound({
      id: "aso_followup_ack",
      task_id: "tsk_1",
      session_id: "ses_1",
      seq: 2,
      kind: "ack",
      action: "reply",
      state: "emitted",
      origin_inbound_id: "in_rebind",
      origin_message_id: "msg_rebind",
      terminal: false,
      feishu_message_id: "out_followup_ack",
      payload: {
        title: "OpenCode",
        template: "wathet",
        text: "已收到：继续往下做",
      },
      created_at: 2,
      updated_at: 2,
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
          template: "green",
          text: "done",
        },
      },
      undefined,
      undefined,
      { kind: "final", terminal: true },
    )

    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "patch"])
    expect(ui.patches).toHaveLength(1)
    expect(ui.patches[0]).toMatchObject({
      msg_id: "out_processing",
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
    expect(ui.patches.some((item) => item.msg_id === "out_followup_ack")).toBe(false)
    expect((await store.get_task("tsk_1"))?.outbound_id).toBe("out_reply")
    expect((await store.get_task("tsk_1"))?.status_outbound_id).toBe("out_processing")
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history).toHaveLength(3)
    expect(history[2]).toMatchObject({
      kind: "final",
      action: "reply",
      origin_inbound_id: "in_rebind",
      origin_message_id: "msg_rebind",
      terminal: true,
      feishu_message_id: "out_reply",
    })
  })
})

describe("commands", () => {
  test("/session does not auto-create when no current session exists", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const actual_route = createSessionSvc({
      store,
      opencode: ai,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    const ok = await on_cmd("/session", conf, actual_route, svc, store, ui.api, createRender(), ai, inbound({ text: "/session" }))

    expect(ok).toBeTrue()
    expect(ai.ensures).toEqual([])
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toBeNull()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("当前会话：未创建")
    expect(text).toContain("模型：openai/gpt-5.4")
  })

  test("/session shows current session with repo and model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        workspace_id: "wrk_1",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
        },
      }),
    )

    const ok = await on_cmd("/session", cfg(), route(store), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/session" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("当前会话：ses_1")
    expect(text).toContain("目录：/tmp (workspace=wrk_1)")
    expect(text).toContain("模型：anthropic/claude-sonnet-4")
    expect(text).toContain("使用 /session <session_id> 切换当前会话。")
  })

  test("/session shows the pref-rehydrated current session model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    await store.save_session(
      session({
        workspace_id: "wrk_pref",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      }),
    )
    await store.save_session_model_pref("ses_1", {
      mode: "explicit",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variant: "max",
      },
    })
    const actual_route = createSessionSvc({
      store,
      opencode: ai,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    const ok = await on_cmd("/session", conf, actual_route, svc, store, ui.api, createRender(), ai, inbound({ text: "/session" }))

    expect(ok).toBeTrue()
    expect(ai.ensures).toEqual([])
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("当前会话：ses_1")
    expect(text).toContain("目录：/tmp (workspace=wrk_pref)")
    expect(text).toContain("模型：anthropic/claude-sonnet-4@max")
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variant: "max",
      },
    })
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
          workspace_id: "wrk_alt",
          created_at: 1,
          updated_at: 1,
        } satisfies OpencodeSession
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/session ses_alt", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/session ses_alt" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "已切换当前会话。",
          "session: ses_alt",
          "目录：/tmp/alt (workspace=wrk_alt)",
          "模型：anthropic/claude-sonnet-4",
        ].join("\n"),
      },
    })
  })

  test("/session <id> switches even when current task is running", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())
    const oc = {
      ...opencode(),
      async session(id: string) {
        return {
          id,
          title: "picked",
          directory: "/tmp/alt",
          workspace_id: "wrk_alt",
          created_at: 1,
          updated_at: 1,
        } satisfies OpencodeSession
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/session ses_alt", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/session ses_alt" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "已切换当前会话。",
          "session: ses_alt",
          "目录：/tmp/alt (workspace=wrk_alt)",
          "模型：anthropic/claude-sonnet-4",
        ].join("\n"),
      },
    })
    expect((await store.get_task("tsk_1"))?.status).toBe("running")
  })

  test("/session <id> replays deferred approval when switched back", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ session_id: "ses_current" }))
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        session_id: "ses_wait",
        status: "waiting_permission",
        req: "req_1",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/tmp" }))}`,
        outbound_id: "out_wait",
      }),
    )
    const oc = {
      ...opencode(),
      async session(id: string) {
        return {
          id,
          title: "picked",
          directory: "/tmp",
          created_at: 1,
          updated_at: 1,
        } satisfies OpencodeSession
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/session ses_wait", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/session ses_wait" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.kind).toBe("reply")
    expect(ui.list[1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          type: "approval",
          req: "req_1",
          tool: "external_directory",
          detail: JSON.stringify({ filepath: "/tmp" }),
        },
      },
    })
  })

  test("slash command reuses the same task for resumable follow-up", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const oc = {
      ...opencode(),
      async commands(input?: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp",
          workspace: "wrk_cmd",
        })
        return [
          {
            name: "init",
            description: "init repo",
            hints: [],
          },
        ]
      },
      async command(input: { session_id: string; command: string; arguments: string; directory?: string; workspace?: string }) {
        expect(input).toMatchObject({
          session_id: "ses_1",
          command: "init",
          arguments: "--quick",
          directory: "/tmp",
          workspace: "wrk_cmd",
        })
        return "已执行 /init。"
      },
    } satisfies OpencodeSvc
    await store.save_session(session({ workspace_id: "wrk_cmd" }))
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        result_hash: "hash_old",
        note: "阶段性答案",
      }),
    )

    const ok = await on_cmd(
      "/init --quick",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      {
        ...oc,
        async status() {
          return {
            ses_1: { type: "idle" },
          }
        },
        async last() {
          return "阶段性答案"
        },
      },
      inbound({
        id: "in_cmd_resume",
        event_id: "evt_cmd_resume",
        message_id: "msg_cmd_resume",
        text: "/init --quick",
      }),
    )

    expect(ok).toBeTrue()
    const rebound = await store.get_task("tsk_1")
    expect(rebound).toMatchObject({
      id: "tsk_1",
      session_id: "ses_1",
      inbound_id: "in_cmd_resume",
      reply_anchor_message_id: "msg_cmd_resume",
      status: "completed",
      terminal_kind: "final",
    })
    expect(rebound?.superseded_by_task_id).toBeUndefined()
    expect(rebound?.result_hash).toBeUndefined()
    expect(await store.list_tasks()).toHaveLength(1)
    const current = await store.get_session({
      tenant_id: "tenant",
      chat_id: "chat",
      thread_id: undefined,
    })
    expect(current?.session_id).toBe("ses_1")
    const history = await store.list_assistant_outbounds("tsk_1")
    expect(history.filter((item) => item.kind === "ack")).toHaveLength(1)
    expect(history.filter((item) => item.kind === "final")).toHaveLength(1)
    expect(history[history.length - 2]).toMatchObject({
      kind: "ack",
      action: "reply",
      origin_inbound_id: "in_cmd_resume",
      origin_message_id: "msg_cmd_resume",
    })
    expect(history[history.length - 1]).toMatchObject({
      kind: "final",
      action: "reply",
      origin_inbound_id: "in_cmd_resume",
      origin_message_id: "msg_cmd_resume",
    })
    expect(ui.list[ui.list.length - 2]?.kind).toBe("reply")
    expect(ui.list[ui.list.length - 1]?.kind).toBe("reply")
  })

  test("slash command uses the pref-rehydrated current session model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const conf = cfg()
    await store.save_session(session({ workspace_id: "wrk_cmd" }))
    await store.save_session_model_pref("ses_1", {
      mode: "explicit",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
    })
    const oc = {
      ...opencode(),
      async commands(input?: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp",
          workspace: "wrk_cmd",
        })
        return [
          {
            name: "init",
            description: "init repo",
            hints: [],
          },
        ]
      },
      async command(input: {
        session_id: string
        command: string
        arguments: string
        directory?: string
        workspace?: string
        model?: { providerID: string; modelID: string; variant?: string }
      }) {
        expect(input).toMatchObject({
          session_id: "ses_1",
          command: "init",
          arguments: "--quick",
          directory: "/tmp",
          workspace: "wrk_cmd",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4",
          },
        })
        return "已执行 /init。"
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    const ok = await on_cmd(
      "/init --quick",
      conf,
      actual_route,
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_cmd_pref_model",
        event_id: "evt_cmd_pref_model",
        message_id: "msg_cmd_pref_model",
        text: "/init --quick",
      }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
    })
  })

  test("/repo shows session over chat and user defaults", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/session", workspace_id: "wrk_session" }))
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat",
      workspace_id: "wrk_chat",
    })
    await store.save_pref({
      scope: "user",
      tenant_id: "tenant",
      user_id: "user",
      directory: "/tmp/user",
      workspace_id: "wrk_user",
    })

    const ok = await on_cmd("/repo", cfg(), route(store), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/repo" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "当前目录：/tmp/session (workspace=wrk_session)",
          "聊天默认：/tmp/chat (workspace=wrk_chat)",
          "用户默认：/tmp/user (workspace=wrk_user)",
        ].join("\n"),
      },
    })
  })

  test("/repo --chat updates chat default with workspace", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const oc = {
      ...opencode(),
      async workspaces(input?: { directory?: string }) {
        expect(input).toEqual({ directory: "/tmp/chat-next" })
        return [{ id: "wrk_chat_next" }]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd(
      "/repo --chat /tmp/chat-next --workspace wrk_chat_next",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({ text: "/repo --chat /tmp/chat-next --workspace wrk_chat_next" }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_pref({ scope: "chat", tenant_id: "tenant", chat_id: "chat" })).toMatchObject({
      directory: "/tmp/chat-next",
      workspace_id: "wrk_chat_next",
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已设置当前聊天默认绑定：/tmp/chat-next (workspace=wrk_chat_next)",
      },
    })
  })


  test("/repo --chat changes directory without workspace and clears stale workspace binding", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat",
      workspace_id: "wrk_chat",
    })

    const ok = await on_cmd(
      "/repo --chat /tmp/chat-next",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --chat /tmp/chat-next" }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_pref({ scope: "chat", tenant_id: "tenant", chat_id: "chat" })).toMatchObject({
      directory: "/tmp/chat-next",
      workspace_id: undefined,
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已设置当前聊天默认绑定：/tmp/chat-next",
      },
    })
  })

  test("/status explains current session and scope context", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        workspace_id: "wrk_session",
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
      workspace_id: "wrk_chat",
    })
    await store.save_pref({
      scope: "user",
      tenant_id: "tenant",
      user_id: "user",
      directory: "/tmp/user",
      workspace_id: "wrk_user",
    })
    await store.set_conn({
      name: "message",
      status: "ready",
      updated_at: 1,
    })
    await store.set_conn({
      name: "opencode",
      status: "ready",
      updated_at: 1,
    })

    const ok = await on_cmd("/status", cfg(), route(store), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/status" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "会话状态：idle",
        template: "blue",
      },
    })
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).not.toContain("会话状态：idle")
    expect(text).toContain("目录：/tmp (workspace=wrk_session)")
    expect(text).toContain("当前模型：anthropic/claude-sonnet-4")
    expect(text).toContain("聊天默认：/tmp/chat (workspace=wrk_chat)")
    expect(text).toContain("用户默认：/tmp/user (workspace=wrk_user)")
    expect(text).toContain("session: ses_1")
  })

  test("/status shows the pref-rehydrated current session model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    await store.save_session(
      session({
        workspace_id: "wrk_status",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      }),
    )
    await store.save_session_model_pref("ses_1", {
      mode: "explicit",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variant: "max",
      },
    })
    await store.set_conn({
      name: "message",
      status: "ready",
      updated_at: 1,
    })
    await store.set_conn({
      name: "opencode",
      status: "ready",
      updated_at: 1,
    })
    const actual_route = createSessionSvc({
      store,
      opencode: ai,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    const ok = await on_cmd("/status", conf, actual_route, svc, store, ui.api, createRender(), ai, inbound({ text: "/status" }))

    expect(ok).toBeTrue()
    expect(ai.ensures).toEqual([])
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("目录：/tmp (workspace=wrk_status)")
    expect(text).toContain("当前模型：anthropic/claude-sonnet-4@max")
    expect(text).toContain("默认模型：openai/gpt-5.4")
    expect(text).toContain("session: ses_1")
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variant: "max",
      },
    })
  })

  test("/sessions uses current scope, locally filters exact workspace, and marks current session", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/chat", workspace_id: "wrk_chat" }))
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat",
      workspace_id: "wrk_chat",
    })
    const oc = {
      ...opencode(),
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        expect(input).toEqual({
          directory: "/tmp/chat",
          workspace: "wrk_chat",
          roots: true,
          limit: 8,
        })
        return [
          {
            id: "ses_1",
            title: "current",
            directory: "/tmp/chat",
            workspace_id: "wrk_chat",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_2",
            title: "older",
            directory: "/tmp/chat",
            workspace_id: "wrk_chat",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_other_ws",
            title: "wrong workspace",
            directory: "/tmp/chat",
            workspace_id: "wrk_other",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_unscoped",
            title: "unscoped",
            directory: "/tmp/chat",
            created_at: 1,
            updated_at: 1,
          },
        ]
      },
      async status(input: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp/chat",
          workspace: "wrk_chat",
        })
        return {
          ses_1: { type: "busy" },
          ses_2: { type: "idle" },
        }
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/sessions", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/sessions" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 2 条）：")
    expect(text).toContain("[当前] [busy] current")
    expect(text).toContain("session: ses_2")
    expect(text).toContain("目录: /tmp/chat (workspace=wrk_chat)")
    expect(text).not.toContain("wrong workspace")
    expect(text).not.toContain("unscoped")
  })

  test("/sessions surfaces deferred waiting state from local task", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/chat", workspace_id: "wrk_chat" }))
    await store.save_task(
      row({
        session_id: "ses_2",
        status: "waiting_question",
      }),
    )
    const oc = {
      ...opencode(),
      async sessions() {
        return [
          {
            id: "ses_1",
            title: "current",
            directory: "/tmp/chat",
            workspace_id: "wrk_chat",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_2",
            title: "background",
            directory: "/tmp/chat",
            workspace_id: "wrk_chat",
            created_at: 1,
            updated_at: 1,
          },
        ]
      },
      async status() {
        return {
          ses_1: { type: "idle" },
          ses_2: { type: "idle" },
        }
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/sessions", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/sessions" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("[waiting_question] background")
  })

  test("/sessions filters out sessions from other workspaces in the same directory", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/chat", workspace_id: "wrk_chat" }))
    const oc = {
      ...opencode(),
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        expect(input).toEqual({
          directory: "/tmp/chat",
          workspace: "wrk_chat",
          roots: true,
          limit: 8,
        })
        return [
          {
            id: "ses_1",
            title: "current",
            directory: "/tmp/chat",
            workspace_id: "wrk_chat",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_other_workspace",
            title: "other workspace",
            directory: "/tmp/chat",
            workspace_id: "wrk_other",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_unscoped",
            title: "unscoped",
            directory: "/tmp/chat",
            created_at: 1,
            updated_at: 1,
          },
        ]
      },
      async status(input: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp/chat",
          workspace: "wrk_chat",
        })
        return {
          ses_1: { type: "busy" },
          ses_other_workspace: { type: "busy" },
          ses_unscoped: { type: "idle" },
        }
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/sessions", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/sessions" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 1 条）：")
    expect(text).toContain("[当前] [busy] current")
    expect(text).not.toContain("other workspace")
    expect(text).not.toContain("ses_other_workspace")
    expect(text).not.toContain("ses_unscoped")
  })

  test("/workspaces lists available workspaces under current directory", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/chat", workspace_id: "wrk_chat" }))
    const oc = {
      ...opencode(),
      async workspaces(input?: { directory?: string }) {
        expect(input).toEqual({ directory: "/tmp/chat" })
        return [
          {
            id: "wrk_chat",
            name: "Chat",
            type: "git",
            branch: "main",
            current: true,
          },
          {
            id: "wrk_other",
            name: "Other",
            type: "git",
            branch: "feat/demo",
          },
        ]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/workspaces", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/workspaces" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("当前目录 /tmp/chat 下的 workspace（共 2 项）：")
    expect(text).toContain("[当前] Chat (wrk_chat)")
    expect(text).toContain("hint: /repo --workspace wrk_other")
  })

  test("/workspaces shows a clear fallback when experimental endpoint is unsupported", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/chat", workspace_id: "wrk_chat" }))
    const oc = {
      ...opencode(),
      async workspaces() {
        throw new Error("opencode request failed: 404 Not Found - /experimental/workspace")
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/workspaces", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/workspaces" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "当前 OpenCode 服务不支持实验接口 /experimental/workspace，暂时无法列出 workspace。",
      },
    })
  })

  test("/sessions keeps current scope unscoped even when global default workspace exists", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/chat", workspace_id: undefined }))
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat",
      workspace_id: undefined,
    })
    const calls: Array<{ name: string; input: { directory?: string; workspace?: string } }> = []
    const oc = {
      ...opencode(),
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        calls.push({
          name: "sessions",
          input: {
            directory: input.directory,
            workspace: input.workspace,
          },
        })
        return [
          {
            id: "ses_1",
            title: "current",
            directory: "/tmp/chat",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_default_ws",
            title: "scoped",
            directory: "/tmp/chat",
            workspace_id: "wrk_default",
            created_at: 1,
            updated_at: 1,
          },
        ]
      },
      async status(input: { directory?: string; workspace?: string }) {
        calls.push({ name: "status", input })
        return {
          ses_1: { type: "idle" },
          ses_default_ws: { type: "busy" },
        }
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd(
      "/sessions",
      cfg({ workspace: "wrk_default" }),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({ text: "/sessions" }),
    )

    expect(ok).toBeTrue()
    expect(calls).toEqual([
      { name: "sessions", input: { directory: "/tmp/chat", workspace: undefined } },
      { name: "status", input: { directory: "/tmp/chat", workspace: undefined } },
    ])
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 1 条）：")
    expect(text).toContain("目录: /tmp/chat")
    expect(text).not.toContain("workspace=wrk_default")
    expect(text).not.toContain("scoped")
  })

  test("/new followed by /sessions lists same-directory pending history regardless of workspace without a synthetic current session", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    const session_inputs: Array<{ directory?: string; workspace?: string; roots?: boolean; limit?: number }> = []
    let status_calls = 0
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: "ses_new" }
      },
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        session_inputs.push(input)
        expect(input).toEqual({
          directory: "/tmp/local-new",
          workspace: undefined,
          roots: true,
          limit: 8,
        })
        return [
          {
            id: "ses_new",
            title: "New session - 2026-05-06T13:31:05.597Z",
            directory: "/tmp/local-new",
            workspace_id: "wrk_local_new",
            created_at: 3,
            updated_at: 3,
          },
          {
            id: "ses_other_ws",
            title: "Other workspace",
            directory: "/tmp/local-new",
            workspace_id: "wrk_other",
            created_at: 4,
            updated_at: 4,
          },
          {
            id: "ses_unscoped",
            title: "Unscoped",
            directory: "/tmp/local-new",
            created_at: 5,
            updated_at: 5,
          },
          {
            id: "ses_other_dir",
            title: "other dir",
            directory: "/tmp/elsewhere",
            workspace_id: "wrk_local_new",
            created_at: 6,
            updated_at: 6,
          },
        ] satisfies OpencodeSession[]
      },
      async status(input: { directory?: string; workspace?: string }) {
        status_calls += 1
        expect(input).toEqual({
          directory: "/tmp/local-new",
          workspace: undefined,
        })
        return {
          ses_new: { type: "idle" },
          ses_other_ws: { type: "busy" },
          ses_unscoped: { type: "idle" },
          ses_other_dir: { type: "busy" },
        }
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp/local-new",
      workspace: "wrk_local_new",
    })

    const created = await on_cmd(
      "/new",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_new",
        event_id: "evt_new",
        message_id: "msg_new",
        text: "/new",
      }),
    )

    expect(created).toBeTrue()
    expect(ensure_calls).toEqual([])

    const listed = await on_cmd(
      "/sessions",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_sessions_new",
        event_id: "evt_sessions_new",
        message_id: "msg_sessions_new",
        text: "/sessions",
      }),
    )

    expect(listed).toBeTrue()
    expect(session_inputs).toEqual([
      {
        directory: "/tmp/local-new",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
    ])
    expect(status_calls).toBe(1)
    const text = ((ui.list[1]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 3 条）：")
    expect(text).toContain("session: ses_new")
    expect(text).toContain("session: ses_other_ws")
    expect(text).toContain("session: ses_unscoped")
    expect(text).toContain("[busy] Other workspace")
    expect(text).toContain("目录: /tmp/local-new")
    expect(text).not.toContain("[当前]")
    expect(text).not.toContain("pending_new:")
    expect(text).not.toContain("other dir")
  })

  test("/repo bare workspace clear followed by /sessions falls back to the rebound local current session when remote exact scope is empty", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_session(session({ session_id: "ses_current", directory: "/tmp", workspace_id: "wrk_other" }))
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    const session_inputs: Array<{ directory?: string; workspace?: string; roots?: boolean; limit?: number }> = []
    let status_calls = 0
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: "ses_rebound" }
      },
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        session_inputs.push(input)
        return []
      },
      async status(input: { directory?: string; workspace?: string }) {
        status_calls += 1
        expect(input).toEqual({
          directory: "/tmp",
          workspace: undefined,
        })
        return {}
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp",
      workspace: undefined,
    })

    const rebound = await on_cmd(
      "/repo --workspace",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_repo",
        event_id: "evt_repo",
        message_id: "msg_repo",
        text: "/repo --workspace",
      }),
    )

    expect(rebound).toBeTrue()
    expect(ensure_calls).toEqual([{ directory: "/tmp", workspace: undefined }])
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      session_id: "ses_rebound",
      directory: "/tmp",
      workspace_id: undefined,
    })

    const listed = await on_cmd(
      "/sessions",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_sessions_repo",
        event_id: "evt_sessions_repo",
        message_id: "msg_sessions_repo",
        text: "/sessions",
      }),
    )

    expect(listed).toBeTrue()
    expect(session_inputs).toEqual([
      {
        directory: "/tmp",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
      {
        directory: "",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
    ])
    expect(status_calls).toBe(1)
    const text = ((ui.list[1]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).not.toContain("当前绑定：/tmp 下暂无会话。")
    expect(text).toContain("最近会话（共 1 条）：")
    expect(text).toContain("[当前] [idle] ses_rebound")
    expect(text).toContain("session: ses_rebound")
    expect(text).toContain("目录: /tmp")
    expect(text).not.toContain("workspace=")
  })

  test("recover treats invalid stored task workspace as unscoped instead of inheriting session workspace", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_remote" }))
    await store.save_inbound(inbound())
    await store.save_task(row({ status: "running", workspace_id: "ws_bad" }))
    const status_inputs: Array<{ directory?: string; workspace?: string }> = []
    const oc = {
      ...opencode(),
      async status(input: { directory?: string; workspace?: string }) {
        status_inputs.push(input)
        throw new Error("status failed")
      },
    } satisfies OpencodeSvc

    await recover(cfg(), store, svc, ui.api, createRender(), oc, "boot")

    expect(status_inputs).toEqual([
      {
        directory: "/tmp",
        workspace: undefined,
      },
    ])
  })

  test("/repo rejects invalid remote workspace selector", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()

    const ok = await on_cmd(
      "/repo --workspace ws_bad",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --workspace ws_bad" }),
    )

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "workspace 无效：ws_bad。显式 workspace 必须使用 wrk*；本地项目请省略 --workspace，若要清空当前绑定请直接使用 /repo --workspace。可先用 /workspaces 查看可用 ID。",
      },
    })
  })

  test("/new followed by /sessions renders same-directory remote roots regardless of workspace without marking a pending foreground current", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    const session_inputs: Array<{ directory?: string; workspace?: string; roots?: boolean; limit?: number }> = []
    const remote_history: OpencodeSession[] = [
      {
        id: "ses_new",
        title: "New session - 2026-05-06T13:31:05.597Z",
        directory: "/tmp/local-new",
        workspace_id: "wrk_local_new",
        created_at: 3,
        updated_at: 3,
      },
      {
        id: "ses_old_1",
        title: "Greeting",
        directory: "/tmp/local-new",
        workspace_id: "wrk_local_new",
        created_at: 2,
        updated_at: 2,
      },
      {
        id: "ses_old_2",
        title: "seedream 4.2 sft 飞书文档查找",
        directory: "/tmp/local-new",
        workspace_id: "wrk_local_new",
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "ses_other_ws",
        title: "Other workspace",
        directory: "/tmp/local-new",
        workspace_id: "wrk_other",
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "ses_unscoped",
        title: "Unscoped",
        directory: "/tmp/local-new",
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "ses_other_dir",
        title: "other dir",
        directory: "/tmp/other",
        workspace_id: "wrk_local_new",
        created_at: 1,
        updated_at: 1,
      },
    ]
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: "ses_new" }
      },
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        session_inputs.push(input)
        expect(input).toEqual({
          directory: "/tmp/local-new",
          workspace: undefined,
          roots: true,
          limit: 8,
        })
        return remote_history
      },
      async status(input: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp/local-new",
          workspace: undefined,
        })
        return {
          ses_new: { type: "idle" },
          ses_old_1: { type: "idle" },
          ses_old_2: { type: "busy" },
          ses_other_ws: { type: "busy" },
          ses_unscoped: { type: "idle" },
          ses_other_dir: { type: "busy" },
        }
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp/local-new",
      workspace: "wrk_local_new",
    })

    const created = await on_cmd(
      "/new",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_new_history",
        event_id: "evt_new_history",
        message_id: "msg_new_history",
        text: "/new",
      }),
    )

    expect(created).toBeTrue()
    expect(ensure_calls).toEqual([])

    const listed = await on_cmd(
      "/sessions",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_sessions_history",
        event_id: "evt_sessions_history",
        message_id: "msg_sessions_history",
        text: "/sessions",
      }),
    )

    expect(listed).toBeTrue()
    expect(session_inputs).toEqual([
      {
        directory: "/tmp/local-new",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
    ])
    const text = ((ui.list[1]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 5 条）：")
    expect(text).toContain("[idle] New session - 2026-05-06T13:31:05.597Z")
    expect(text).not.toContain("[当前]")
    expect(text).toContain("session: ses_new")
    expect(text).toContain("session: ses_old_1")
    expect(text).toContain("session: ses_old_2")
    expect(text).toContain("session: ses_other_ws")
    expect(text).toContain("session: ses_unscoped")
    expect(text).toContain("[busy] seedream 4.2 sft 飞书文档查找")
    expect(text).not.toContain("other dir")
  })

  test("/new followed by /sessions does not synthesize a current session when directory-first pending lookups miss same-directory history", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    const session_inputs: Array<{ directory?: string; workspace?: string; roots?: boolean; limit?: number }> = []
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: "ses_new" }
      },
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        session_inputs.push(input)
        if (session_inputs.length === 1) {
          expect(input).toEqual({
            directory: "/tmp/local-new",
            workspace: undefined,
            roots: true,
            limit: 8,
          })
          return [
            {
              id: "ses_other_dir_first",
              title: "other dir first",
              directory: "/tmp/another",
              workspace_id: "wrk_other",
              created_at: 2,
              updated_at: 2,
            },
          ] satisfies OpencodeSession[]
        }
        expect(input).toEqual({
          directory: "",
          workspace: undefined,
          roots: true,
          limit: 8,
        })
        return [
          {
            id: "ses_other_ws_global",
            title: "wrong workspace elsewhere",
            directory: "/tmp/another",
            workspace_id: "wrk_other",
            created_at: 3,
            updated_at: 3,
          },
          {
            id: "ses_unscoped_elsewhere",
            title: "unscoped elsewhere",
            directory: "/tmp/another",
            created_at: 4,
            updated_at: 4,
          },
        ] satisfies OpencodeSession[]
      },
      async status(input: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp/local-new",
          workspace: undefined,
        })
        return {
          ses_other_dir_first: { type: "busy" },
          ses_other_ws_global: { type: "busy" },
          ses_unscoped_elsewhere: { type: "idle" },
        }
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp/local-new",
      workspace: "wrk_local_new",
    })

    const created = await on_cmd(
      "/new",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_new_miss",
        event_id: "evt_new_miss",
        message_id: "msg_new_miss",
        text: "/new",
      }),
    )

    expect(created).toBeTrue()
    expect(ensure_calls).toEqual([])

    const listed = await on_cmd(
      "/sessions",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_sessions_miss",
        event_id: "evt_sessions_miss",
        message_id: "msg_sessions_miss",
        text: "/sessions",
      }),
    )

    expect(listed).toBeTrue()
    expect(session_inputs).toEqual([
      {
        directory: "/tmp/local-new",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
      {
        directory: "",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
    ])
    const text = ((ui.list[1]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("当前目录：/tmp/local-new 下暂无会话。")
    expect(text).not.toContain("[当前]")
    expect(text).not.toContain("session: ses_new")
    expect(text).not.toContain("wrong workspace")
    expect(text).not.toContain("unscoped")
  })

  test("/repo away and back followed by /sessions renders all exact-scoped remote roots when remote history is present", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    await store.save_session(session({ session_id: "ses_current", directory: "/tmp/history", workspace_id: undefined }))
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    const remote_history: OpencodeSession[] = [
      {
        id: "ses_rebound",
        title: "New session - 2026-05-06T13:31:05.597Z",
        directory: "/tmp/history",
        created_at: 3,
        updated_at: 3,
      },
      {
        id: "ses_old_1",
        title: "Greeting",
        directory: "/tmp/history",
        created_at: 2,
        updated_at: 2,
      },
      {
        id: "ses_old_2",
        title: "seedream 4.2 sft 飞书文档查找",
        directory: "/tmp/history",
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "ses_other_dir",
        title: "other dir",
        directory: "/tmp/other",
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "ses_other_ws",
        title: "wrong workspace",
        directory: "/tmp/history",
        workspace_id: "wrk_other",
        created_at: 1,
        updated_at: 1,
      },
    ]
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: ensure_calls.length === 1 ? "ses_other" : "ses_rebound" }
      },
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        expect(input).toEqual({
          directory: "/tmp/history",
          workspace: undefined,
          roots: true,
          limit: 8,
        })
        return remote_history
      },
      async status(input: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp/history",
          workspace: undefined,
        })
        return {
          ses_rebound: { type: "idle" },
          ses_old_1: { type: "idle" },
          ses_old_2: { type: "busy" },
          ses_other_dir: { type: "busy" },
          ses_other_ws: { type: "idle" },
        }
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp",
      workspace: undefined,
    })

    const away = await on_cmd(
      "/repo /tmp/other",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_repo_away",
        event_id: "evt_repo_away",
        message_id: "msg_repo_away",
        text: "/repo /tmp/other",
      }),
    )

    expect(away).toBeTrue()

    const back = await on_cmd(
      "/repo /tmp/history",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_repo_back",
        event_id: "evt_repo_back",
        message_id: "msg_repo_back",
        text: "/repo /tmp/history",
      }),
    )

    expect(back).toBeTrue()
    expect(ensure_calls).toEqual([
      { directory: "/tmp/other", workspace: undefined },
      { directory: "/tmp/history", workspace: undefined },
    ])
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      session_id: "ses_rebound",
      directory: "/tmp/history",
      workspace_id: undefined,
    })

    const listed = await on_cmd(
      "/sessions",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_sessions_roundtrip",
        event_id: "evt_sessions_roundtrip",
        message_id: "msg_sessions_roundtrip",
        text: "/sessions",
      }),
    )

    expect(listed).toBeTrue()
    const text = ((ui.list[2]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 3 条）：")
    expect(text).toContain("[当前] [idle] New session - 2026-05-06T13:31:05.597Z")
    expect(text).toContain("session: ses_rebound")
    expect(text).toContain("session: ses_old_1")
    expect(text).toContain("session: ses_old_2")
    expect(text).not.toContain("other dir")
    expect(text).not.toContain("wrong workspace")
  })

  test("/new followed by /sessions retries broader roots and renders recovered same-directory history without marking pending current", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    const session_inputs: Array<{ directory?: string; workspace?: string; roots?: boolean; limit?: number }> = []
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: "ses_new" }
      },
      async sessions(input: { directory?: string; workspace?: string; roots?: boolean; limit?: number }) {
        session_inputs.push(input)
        if (session_inputs.length === 1) {
          expect(input).toEqual({
            directory: "/tmp/local-new",
            workspace: undefined,
            roots: true,
            limit: 8,
          })
          return [
            {
              id: "ses_other_dir_first",
              title: "other dir first",
              directory: "/tmp/other",
              workspace_id: "wrk_local_new",
              created_at: 2,
              updated_at: 2,
            },
          ] satisfies OpencodeSession[]
        }
        expect(input).toEqual({
          directory: "",
          workspace: undefined,
          roots: true,
          limit: 8,
        })
        return [
          {
            id: "ses_new",
            title: "New session - 2026-05-07T03:37:36.193Z",
            directory: "/tmp/local-new",
            workspace_id: "wrk_local_new",
            created_at: 3,
            updated_at: 3,
          },
          {
            id: "ses_old_1",
            title: "Greeting",
            directory: "/tmp/local-new",
            workspace_id: "wrk_other",
            created_at: 2,
            updated_at: 2,
          },
          {
            id: "ses_other_dir",
            title: "other dir",
            directory: "/tmp/other",
            workspace_id: "wrk_local_new",
            created_at: 1,
            updated_at: 1,
          },
        ] satisfies OpencodeSession[]
      },
      async status(input: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp/local-new",
          workspace: undefined,
        })
        return {
          ses_new: { type: "idle" },
          ses_old_1: { type: "busy" },
          ses_other_dir_first: { type: "idle" },
          ses_other_dir: { type: "busy" },
        }
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp/local-new",
      workspace: "wrk_local_new",
    })

    const created = await on_cmd(
      "/new",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_new_retry",
        event_id: "evt_new_retry",
        message_id: "msg_new_retry",
        text: "/new",
      }),
    )

    expect(created).toBeTrue()
    expect(ensure_calls).toEqual([])

    const listed = await on_cmd(
      "/sessions",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      render,
      oc,
      inbound({
        id: "in_sessions_retry",
        event_id: "evt_sessions_retry",
        message_id: "msg_sessions_retry",
        text: "/sessions",
      }),
    )

    expect(listed).toBeTrue()
    expect(session_inputs).toEqual([
      {
        directory: "/tmp/local-new",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
      {
        directory: "",
        workspace: undefined,
        roots: true,
        limit: 8,
      },
    ])
    const text = ((ui.list[1]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("最近会话（共 2 条）：")
    expect(text).toContain("[idle] New session - 2026-05-07T03:37:36.193Z")
    expect(text).not.toContain("[当前]")
    expect(text).toContain("session: ses_new")
    expect(text).toContain("[busy] Greeting")
    expect(text).toContain("session: ses_old_1")
    expect(text).not.toContain("wrong workspace")
    expect(text).not.toContain("other dir")
  })

  test("/new followed by the first normal message lazily creates and binds the real session", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg({
      directory: "/tmp/local-new",
      workspace: "wrk_local_new",
    })
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai,
      inbound({
        id: "in_lazy_new_1",
        event_id: "evt_lazy_new_1",
        message_id: "msg_lazy_new_1",
        text: "/new",
      }),
    )

    expect(ai.ensures).toEqual([])

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai,
      inbound({
        id: "in_lazy_new_2",
        event_id: "evt_lazy_new_2",
        message_id: "msg_lazy_new_2",
        text: "hello",
      }),
    )

    expect(ai.ensures).toEqual([{ directory: "/tmp/local-new", workspace: "wrk_local_new" }])
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      session_id: "ses_1",
      directory: "/tmp/local-new",
      workspace_id: "wrk_local_new",
      state: "active",
    })
  })

  test("/new enters pending foreground with chat default scope", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_pref({
      scope: "chat",
      tenant_id: "tenant",
      chat_id: "chat",
      directory: "/tmp/chat-default",
      workspace_id: "wrk_chat_default",
    })
    const svc_route = {
      ...route(store),
      async reset() {
        return session({
          session_id: "ses_new",
          directory: "/tmp/chat-default",
          workspace_id: "wrk_chat_default",
        })
      },
    } satisfies SessionSvc

    const ok = await on_cmd("/new", cfg(), svc_route, svc, store, ui.api, createRender(), opencode(), inbound({ text: "/new" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已切换到新会话，首次发送消息时创建。", "目录：/tmp/chat-default (workspace=wrk_chat_default)"].join("\n"),
      },
    })
  })

  test("/new enters pending foreground and keeps current running task alive in background", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(row())
    const oc = {
      ...opencode(),
      async abort() {
        throw new Error("should not abort")
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/new", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/new" }))

    expect(ok).toBeTrue()
    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已切换到新会话，首次发送消息时创建。", "目录：/tmp/new"].join("\n"),
      },
    })
  })

  test("/repo --me updates user default with workspace", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const oc = {
      ...opencode(),
      async workspaces(input?: { directory?: string }) {
        expect(input).toEqual({ directory: "/tmp/me-next" })
        return [{ id: "wrk_me_next" }]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd(
      "/repo --me /tmp/me-next --workspace wrk_me_next",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({ text: "/repo --me /tmp/me-next --workspace wrk_me_next" }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_pref({ scope: "user", tenant_id: "tenant", user_id: "user" })).toMatchObject({
      directory: "/tmp/me-next",
      workspace_id: "wrk_me_next",
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已设置当前用户默认绑定：/tmp/me-next (workspace=wrk_me_next)",
      },
    })
  })


  test("/repo --me changes directory without workspace and clears stale workspace binding", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_pref({
      scope: "user",
      tenant_id: "tenant",
      user_id: "user",
      directory: "/tmp/me",
      workspace_id: "wrk_me",
    })

    const ok = await on_cmd(
      "/repo --me /tmp/me-next",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --me /tmp/me-next" }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_pref({ scope: "user", tenant_id: "tenant", user_id: "user" })).toMatchObject({
      directory: "/tmp/me-next",
      workspace_id: undefined,
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已设置当前用户默认绑定：/tmp/me-next",
      },
    })
  })

  test("/repo --me with bare workspace flag clears to unscoped default binding", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()

    const ok = await on_cmd(
      "/repo --me /tmp/me-local --workspace",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --me /tmp/me-local --workspace" }),
    )

    expect(ok).toBeTrue()
    expect(await store.get_pref({ scope: "user", tenant_id: "tenant", user_id: "user" })).toMatchObject({
      directory: "/tmp/me-local",
      workspace_id: undefined,
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已设置当前用户默认绑定：/tmp/me-local",
      },
    })
  })

  test("/repo bare workspace flag binds current session and switches when scope changes", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_current" }))

    const ok = await on_cmd(
      "/repo --workspace",
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({ text: "/repo --workspace" }),
    )

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已绑定：/tmp", "已切换到新会话。"].join("\n"),
      },
    })
  })

  test("/repo --workspace blocks rebinding current session when explicit workspace is missing", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/current", workspace_id: "wrk_current" }))
    let bind_calls = 0
    let workspaces_calls = 0
    const svc_route = {
      ...route(store),
      async bind() {
        bind_calls += 1
        return session({ session_id: "ses_should_not_bind" })
      },
    } satisfies SessionSvc
    const oc = {
      ...opencode(),
      async workspaces(input?: { directory?: string }) {
        workspaces_calls += 1
        expect(input).toEqual({ directory: "/tmp/current" })
        return [
          {
            id: "wrk_other",
            name: "Other",
          },
        ]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd(
      "/repo --workspace wrk_missing",
      cfg(),
      svc_route,
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({ text: "/repo --workspace wrk_missing" }),
    )

    expect(ok).toBeTrue()
    expect(workspaces_calls).toBe(1)
    expect(bind_calls).toBe(0)
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      session_id: "ses_1",
      directory: "/tmp/current",
      workspace_id: "wrk_current",
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "未找到 workspace：wrk_missing。当前目录 /tmp/current 下没有这个 workspace；可先用 /workspaces 查看可用 ID。本地项目请省略 --workspace，若要清空当前绑定请直接使用 /repo --workspace。",
      },
    })
  })

  test("/repo changes directory without workspace, clears stale workspace, and does not auto-create one", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/current", workspace_id: "wrk_current" }))
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    let workspaces_calls = 0
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: "ses_rebound" }
      },
      async workspaces() {
        workspaces_calls += 1
        return []
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp",
      workspace: undefined,
    })

    const ok = await on_cmd(
      "/repo /tmp/next",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({ text: "/repo /tmp/next" }),
    )

    expect(ok).toBeTrue()
    expect(ensure_calls).toEqual([{ directory: "/tmp/next", workspace: undefined }])
    expect(workspaces_calls).toBe(0)
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      session_id: "ses_rebound",
      directory: "/tmp/next",
      workspace_id: undefined,
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已绑定：/tmp/next", "已切换到新会话。"].join("\n"),
      },
    })
  })

  test("/repo omitting workspace preserves existing binding when directory is unchanged", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/current", workspace_id: "wrk_current" }))
    const ensure_calls: Array<{ directory?: string; workspace?: string; session_id?: string }> = []
    const oc = {
      ...opencode(),
      async ensure(input: { directory?: string; workspace?: string; session_id?: string }) {
        ensure_calls.push(input)
        return { id: "ses_should_not_change" }
      },
    } satisfies OpencodeSvc
    const actual_route = createSessionSvc({
      store,
      opencode: oc,
      directory: "/tmp",
      workspace: undefined,
    })

    const ok = await on_cmd(
      "/repo /tmp/current",
      cfg(),
      actual_route,
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({ text: "/repo /tmp/current" }),
    )

    expect(ok).toBeTrue()
    expect(ensure_calls).toEqual([])
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      session_id: "ses_1",
      directory: "/tmp/current",
      workspace_id: "wrk_current",
    })
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "已绑定：/tmp/current (workspace=wrk_current)",
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

    const ok = await on_cmd("/model", cfg(), route(store), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/model" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "当前模型：anthropic/claude-sonnet-4",
          "默认模型：openai/gpt-5.4",
          "session: ses_1",
          "可用 /models 查看 variants；去掉当前 variant：/model <provider>/<model_id>。",
          "切换：/model <provider>/<model_id>[@<variant>]；重置：/model reset。",
        ].join("\n"),
      },
    })
  })

  test("/model shows the pref-rehydrated current session model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    await store.save_session(
      session({
        workspace_id: "wrk_model",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      }),
    )
    await store.save_session_model_pref("ses_1", {
      mode: "explicit",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variant: "max",
      },
    })
    const actual_route = createSessionSvc({
      store,
      opencode: ai,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    const ok = await on_cmd("/model", conf, actual_route, svc, store, ui.api, createRender(), ai, inbound({ text: "/model" }))

    expect(ok).toBeTrue()
    expect(ai.ensures).toEqual([])
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toContain("当前模型：anthropic/claude-sonnet-4@max")
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variant: "max",
      },
    })
  })

  test("/models shows visible variants and actionable footer", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_model" }))
    const oc = {
      ...opencode(),
      async providers(input?: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp",
          workspace: "wrk_model",
        })
        return [
          {
            id: "openai",
            name: "OpenAI",
            connected: true,
            default_model: "gpt-5.4",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4",
                variants: ["balanced", "fast"],
              },
              {
                id: "gpt-4.1",
                name: "gpt-4.1",
              },
            ],
          },
          {
            id: "anthropic",
            name: "Anthropic",
            connected: true,
            default_model: "claude-sonnet-4",
            models: [
              {
                id: "claude-sonnet-4",
                name: "Claude Sonnet 4",
              },
            ],
          },
        ]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/models", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/models" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: [
          "当前目录 / workspace 下已连接 provider / model（共 2 项）：",
          [
            "1. OpenAI [connected]",
            "provider: openai",
            "default: gpt-5.4",
            "models: GPT 5.4 (gpt-5.4) [variants: balanced, fast]、gpt-4.1",
          ].join("\n"),
          [
            "2. Anthropic [connected]",
            "provider: anthropic",
            "default: claude-sonnet-4",
            "models: Claude Sonnet 4 (claude-sonnet-4)",
          ].join("\n"),
          "",
          "切换：/model <provider>/<model_id>[@<variant>]；重置：/model reset。",
          "",
          "去掉当前 variant：/model <provider>/<model_id>。",
        ].join("\n\n"),
      },
    })
  })

  test("/models omits the variants footer when no variants are visible", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_model" }))
    const oc = {
      ...opencode(),
      async providers(input?: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp",
          workspace: "wrk_model",
        })
        return [
          {
            id: "openai",
            name: "OpenAI",
            connected: true,
            default_model: "gpt-5.4",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4",
              },
              {
                id: "gpt-4.1",
                name: "gpt-4.1",
              },
            ],
          },
          {
            id: "anthropic",
            name: "Anthropic",
            connected: true,
            default_model: "claude-sonnet-4",
            models: [
              {
                id: "claude-sonnet-4",
                name: "Claude Sonnet 4",
              },
            ],
          },
        ]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/models", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/models" }))

    expect(ok).toBeTrue()
    const text = ((ui.list[0]?.out as { body?: { text?: string } } | undefined)?.body?.text ?? "")
    expect(text).toEqual([
      "当前目录 / workspace 下已连接 provider / model（共 2 项）：",
      [
        "1. OpenAI [connected]",
        "provider: openai",
        "default: gpt-5.4",
        "models: GPT 5.4 (gpt-5.4)、gpt-4.1",
      ].join("\n"),
      [
        "2. Anthropic [connected]",
        "provider: anthropic",
        "default: claude-sonnet-4",
        "models: Claude Sonnet 4 (claude-sonnet-4)",
      ].join("\n"),
      "",
      "切换：/model <provider>/<model_id>[@<variant>]；重置：/model reset。",
    ].join("\n\n"))
    expect(text).not.toContain("去掉当前 variant：/model <provider>/<model_id>。")
  })

  test("metadata listing commands query the current scope", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ directory: "/tmp/scoped", workspace_id: "wrk_scoped" }))

    const calls: Array<{ name: string; input?: { directory?: string; workspace?: string } }> = []
    const oc = {
      ...opencode(),
      async skills(input?: { directory?: string; workspace?: string }) {
        calls.push({ name: "skills", input })
        return []
      },
      async agents(input?: { directory?: string; workspace?: string }) {
        calls.push({ name: "agents", input })
        return []
      },
      async providers(input?: { directory?: string; workspace?: string }) {
        calls.push({ name: "providers", input })
        return []
      },
      async mcps(input?: { directory?: string; workspace?: string }) {
        calls.push({ name: "mcps", input })
        return []
      },
      async commands(input?: { directory?: string; workspace?: string }) {
        calls.push({ name: "commands", input })
        return []
      },
    } satisfies OpencodeSvc

    for (const [i, text] of ["/skills", "/agents", "/models", "/mcps", "/commands"].entries()) {
      const ok = await on_cmd(
        text,
        cfg(),
        route(store),
        svc,
        store,
        ui.api,
        createRender(),
        oc,
        inbound({
          id: `in_scope_${i}`,
          event_id: `evt_scope_${i}`,
          message_id: `msg_scope_${i}`,
          text,
        }),
      )

      expect(ok).toBeTrue()
    }

    expect(calls).toEqual([
      { name: "skills", input: { directory: "/tmp/scoped", workspace: "wrk_scoped" } },
      { name: "agents", input: { directory: "/tmp/scoped", workspace: "wrk_scoped" } },
      { name: "providers", input: { directory: "/tmp/scoped", workspace: "wrk_scoped" } },
      { name: "mcps", input: { directory: "/tmp/scoped", workspace: "wrk_scoped" } },
      { name: "commands", input: { directory: "/tmp/scoped", workspace: "wrk_scoped" } },
    ])
  })

  test("/model provider/model switches current model", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_model" }))
    const models_calls: Array<{ directory?: string; workspace?: string }> = []
    const model_calls: Array<{ session_id: string; model?: { providerID: string; modelID: string; variant?: string }; mode?: "default" | "explicit" }> = []
    const oc = {
      ...opencode(),
      async providers(input?: { directory?: string; workspace?: string }) {
        models_calls.push(input ?? {})
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
    const svc_route = {
      ...route(store),
      async model(input) {
        model_calls.push(input)
        return session({
          session_id: input.session_id,
          model: input.model,
        })
      },
    } satisfies SessionSvc

    const ok = await on_cmd("/model openai/gpt-5.4", cfg(), svc_route, svc, store, ui.api, createRender(), oc, inbound({ text: "/model openai/gpt-5.4" }))

    expect(ok).toBeTrue()
    expect(models_calls).toEqual([{ directory: "/tmp", workspace: "wrk_model" }])
    expect(model_calls).toEqual([
      {
        session_id: "ses_1",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
    ])
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已切换当前模型。", "当前模型：openai/gpt-5.4", "session: ses_1"].join("\n"),
      },
    })
  })

  test("/model provider/model@variant switches current model variant", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_model" }))
    const model_calls: Array<{ session_id: string; model?: { providerID: string; modelID: string; variant?: string }; mode?: "default" | "explicit" }> = []
    const oc = {
      ...opencode(),
      async providers(input?: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp",
          workspace: "wrk_model",
        })
        return [
          {
            id: "openai",
            name: "OpenAI",
            connected: true,
            default_model: "gpt-5.4",
            models: [{ id: "gpt-5.4", name: "gpt-5.4", variants: ["balanced", "fast"] }],
          },
        ]
      },
    } satisfies OpencodeSvc
    const svc_route = {
      ...route(store),
      async model(input) {
        model_calls.push(input)
        return session({
          session_id: input.session_id,
          model: input.model,
        })
      },
    } satisfies SessionSvc

    const ok = await on_cmd("/model openai/gpt-5.4@fast", cfg(), svc_route, svc, store, ui.api, createRender(), oc, inbound({ text: "/model openai/gpt-5.4@fast" }))

    expect(ok).toBeTrue()
    expect(model_calls).toEqual([
      {
        session_id: "ses_1",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
          variant: "fast",
        },
      },
    ])
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已切换当前模型。", "当前模型：openai/gpt-5.4@fast", "session: ses_1"].join("\n"),
      },
    })
  })

  test("/model provider/model clears an existing explicit variant override", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        workspace_id: "wrk_model",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
          variant: "fast",
        },
      }),
    )
    const model_calls: Array<{ session_id: string; model?: { providerID: string; modelID: string; variant?: string }; mode?: "default" | "explicit" }> = []
    const oc = {
      ...opencode(),
      async providers(input?: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp",
          workspace: "wrk_model",
        })
        return [
          {
            id: "openai",
            name: "OpenAI",
            connected: true,
            default_model: "gpt-5.4",
            models: [{ id: "gpt-5.4", name: "gpt-5.4", variants: ["balanced", "fast"] }],
          },
        ]
      },
    } satisfies OpencodeSvc
    const svc_route = {
      ...route(store),
      async model(input) {
        model_calls.push(input)
        return session({
          session_id: input.session_id,
          model: input.model,
        })
      },
    } satisfies SessionSvc

    const ok = await on_cmd("/model openai/gpt-5.4", cfg(), svc_route, svc, store, ui.api, createRender(), oc, inbound({ text: "/model openai/gpt-5.4" }))

    expect(ok).toBeTrue()
    expect(model_calls).toEqual([
      {
        session_id: "ses_1",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
    ])
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已切换当前模型。", "当前模型：openai/gpt-5.4", "session: ses_1"].join("\n"),
      },
    })
  })

  test("/model provider/model@variant accepts explicit variant when provider metadata omits variants list", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session({ workspace_id: "wrk_model" }))
    const model_calls: Array<{ session_id: string; model?: { providerID: string; modelID: string; variant?: string }; mode?: "default" | "explicit" }> = []
    const oc = {
      ...opencode(),
      async providers(input?: { directory?: string; workspace?: string }) {
        expect(input).toEqual({
          directory: "/tmp",
          workspace: "wrk_model",
        })
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
    const svc_route = {
      ...route(store),
      async model(input) {
        model_calls.push(input)
        return session({
          session_id: input.session_id,
          model: input.model,
        })
      },
    } satisfies SessionSvc

    const ok = await on_cmd("/model openai/gpt-5.4@fast", cfg(), svc_route, svc, store, ui.api, createRender(), oc, inbound({ text: "/model openai/gpt-5.4@fast" }))

    expect(ok).toBeTrue()
    expect(model_calls).toEqual([
      {
        session_id: "ses_1",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
          variant: "fast",
        },
      },
    ])
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: ["已切换当前模型。", "当前模型：openai/gpt-5.4@fast", "session: ses_1"].join("\n"),
      },
    })
  })

  test("/model rejects invalid format", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()

    const ok = await on_cmd("/model badformat", cfg(), route(store), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/model badformat" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "模型格式应为 <provider>/<model_id>[@<variant>]，例如 /model cba_openai/gpt-5.4@fast",
      },
    })
  })

  test("/model rejects unavailable variant target", async () => {
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
            models: [{ id: "gpt-5.4", name: "gpt-5.4", variants: ["balanced"] }],
          },
        ]
      },
    } satisfies OpencodeSvc

    const ok = await on_cmd("/model openai/gpt-5.4@fast", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/model openai/gpt-5.4@fast" }))

    expect(ok).toBeTrue()
    expect(ui.list[0]?.out).toMatchObject({
      kind: "text",
      body: {
        text: "当前没有可用模型：openai/gpt-5.4@fast",
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

    const ok = await on_cmd("/model anthropic/claude-sonnet-4", cfg(), route(store), svc, store, ui.api, createRender(), oc, inbound({ text: "/model anthropic/claude-sonnet-4" }))

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

    const ok = await on_cmd("/model reset", cfg(), route(store), svc, store, ui.api, createRender(), opencode(), inbound({ text: "/model reset" }))

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

  test("/model reset persists the configured default model into session state", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(
      session({
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
          variant: "fast",
        },
      }),
    )

    const model_calls: Array<{ session_id: string; model?: { providerID: string; modelID: string; variant?: string }; mode?: "default" | "explicit" }> = []
    const svc_route = {
      ...route(store),
      async model(input) {
        model_calls.push(input)
        return session({
          session_id: input.session_id,
          model: input.model,
        })
      },
    } satisfies SessionSvc

    const ok = await on_cmd("/model reset", cfg(), svc_route, svc, store, ui.api, createRender(), opencode(), inbound({ text: "/model reset" }))

    expect(ok).toBeTrue()
    expect(model_calls).toEqual([
      {
        session_id: "ses_1",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        mode: "default",
      },
    ])
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

  test("numeric text no longer answers current waiting question or surfaces the next queued question", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await saveWait(store, {
      id: "tsk_q_1",
      inbound_id: "in_q_1",
      status: "waiting_question",
      req: "req_q_1",
      kind: "question",
      outbound_id: "out_q_1",
      payload: {
        title: "第一个问题",
        opts: ["A", "B"],
        custom: false,
      },
      seq: 1,
    })
    await store.save_inbound(inbound({ id: "in_q_2", event_id: "evt_q_2", message_id: "msg_q_2" }))
    await store.save_assistant_outbound({
      id: "aso_tsk_q_1_req_q_2",
      task_id: "tsk_q_1",
      session_id: "ses_1",
      seq: 2,
      kind: "question",
      action: "deferred",
      state: "open",
      origin_inbound_id: "in_q_1",
      origin_message_id: "msg_in_q_1",
      req_key: "req_q_2",
      terminal: false,
      payload: {
        title: "第二个问题",
        opts: ["X", "Y"],
        custom: false,
      },
      created_at: 2,
      updated_at: 2,
    })
    const calls: Array<{ req: string; answers: string[][] }> = []
    const oc = {
      ...opencode(),
      async answer(input) {
        calls.push({ req: input.req, answers: input.answers })
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_q_answer",
        event_id: "evt_q_answer",
        message_id: "msg_q_answer",
        text: "1",
      }),
    )

    expect(calls).toEqual([])
    expect((await store.get_task("tsk_q_1"))?.status).toBe("waiting_question")
    expect((await store.get_task("tsk_q_1"))?.req).toBe("req_q_1")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "当前这一步请在卡片中选择后提交。",
      },
    })
    expect(
      ui.list.some((item) =>
        item.out.kind === "card" &&
        !!item.out.body &&
        typeof item.out.body === "object" &&
        "type" in item.out.body &&
        (item.out.body as { type?: string; req?: string }).type === "question" &&
        (item.out.body as { type?: string; req?: string }).req === "req_q_2",
      ),
    ).toBe(false)
  })

  test("numeric text no longer answers current waiting permission or surfaces the next queued approval", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await saveWait(store, {
      id: "tsk_perm_1",
      inbound_id: "in_perm_1",
      status: "waiting_permission",
      req: "req_perm_1",
      kind: "approval",
      outbound_id: "out_perm_1",
      payload: {
        tool: "external_directory",
        detail: JSON.stringify({ filepath: "/tmp" }),
      },
      seq: 1,
    })
    await store.save_inbound(inbound({ id: "in_perm_2", event_id: "evt_perm_2", message_id: "msg_perm_2" }))
    await store.save_assistant_outbound({
      id: "aso_tsk_perm_1_req_perm_2",
      task_id: "tsk_perm_1",
      session_id: "ses_1",
      seq: 2,
      kind: "approval",
      action: "deferred",
      state: "open",
      origin_inbound_id: "in_perm_1",
      origin_message_id: "msg_in_perm_1",
      req_key: "req_perm_2",
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

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_perm_answer",
        event_id: "evt_perm_answer",
        message_id: "msg_perm_answer",
        text: "1",
      }),
    )

    expect(calls).toEqual([])
    expect((await store.get_task("tsk_perm_1"))?.status).toBe("waiting_permission")
    expect((await store.get_task("tsk_perm_1"))?.req).toBe("req_perm_1")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "当前在等待权限审批，请点击卡片按钮继续；如需更正本次操作，请直接发送非数字文本说明。",
      },
    })
    expect(
      ui.list.some((item) =>
        item.out.kind === "card" &&
        !!item.out.body &&
        typeof item.out.body === "object" &&
        "type" in item.out.body &&
        (item.out.body as { type?: string; req?: string }).type === "approval" &&
        (item.out.body as { type?: string; req?: string }).req === "req_perm_2",
      ),
    ).toBe(false)
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
    const prompt_calls: Array<{ session_id: string; text?: string }> = []
    const oc = {
      ...opencode(),
      async answer(input) {
        calls.push({
          req: input.req,
          answers: input.answers,
          workspace: input.workspace,
        })
      },
      async prompt(input) {
        prompt_calls.push({
          session_id: input.session_id,
          text: input.text,
        })
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(store),
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
    expect(prompt_calls).toEqual([])
    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "已提交补充信息",
      },
    })
  })

  test("waiting_question with custom options rejects numeric-only text and keeps waiting", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_question",
        req_type: "question",
        req: "req_q_numeric",
        note: `question:1:${encodeURIComponent("要更新哪个仓库的 AGENTS.md？")}:${encodeURIComponent("workspace/opencode")}|${encodeURIComponent("workspace/opencode-feishu-imui")}`,
      }),
    )
    const calls: Array<{ req: string; answers: string[][] }> = []
    const oc = {
      ...opencode(),
      async answer(input) {
        calls.push({ req: input.req, answers: input.answers })
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_q_numeric",
        event_id: "evt_q_numeric",
        message_id: "msg_q_numeric",
        text: "1",
      }),
    )

    expect(calls).toEqual([])
    expect((await store.get_task("tsk_1"))?.status).toBe("waiting_question")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "当前这一步请在卡片中选择后提交；如需自定义补充，请直接发送非数字文本。",
      },
    })
  })

  test("waiting_question without options accepts numeric-looking free text", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_question",
        req_type: "question",
        req: "req_q_port",
        note: `question:1:${encodeURIComponent("请输入端口号")}`,
      }),
    )
    const calls: Array<{ req: string; answers: string[][] }> = []
    const oc = {
      ...opencode(),
      async answer(input) {
        calls.push({ req: input.req, answers: input.answers })
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_q_port",
        event_id: "evt_q_port",
        message_id: "msg_q_port",
        text: "4096",
      }),
    )

    expect(calls).toEqual([{ req: "req_q_port", answers: [["4096"]] }])
    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "已提交补充信息",
      },
    })
  })

  test("waiting_question without a valid choice reminds about card submit", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_question",
        req_type: "question",
        req: "req_q_invalid",
        note: `question:0:${encodeURIComponent("请选择")}:${encodeURIComponent("A")}|${encodeURIComponent("B")}`,
      }),
    )

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      opencode(),
      inbound({
        id: "in_q_invalid",
        event_id: "evt_q_invalid",
        message_id: "msg_q_invalid",
        text: "不是序号",
      }),
    )

    expect((await store.get_task("tsk_1"))?.status).toBe("waiting_question")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "当前这一步请在卡片中选择后提交。",
      },
    })
  })

  test("waiting_permission treats direct text as correction, rejects permission, and continues task", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_permission",
        req_type: "permission",
        req: "req_perm_1",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/usr" }))}`,
      }),
    )
    const allow_calls: Array<{ req: string; reply: "once" | "always" | "reject"; message?: string; workspace?: string }> = []
    const prompt_calls: Array<{ session_id: string; text?: string; workspace?: string }> = []
    const steps: string[] = []
    const oc = {
      ...opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      async allow(input) {
        steps.push("allow")
        allow_calls.push({
          req: input.req,
          reply: input.reply,
          message: input.message,
          workspace: input.workspace,
        })
      },
      async prompt(input) {
        steps.push("prompt")
        prompt_calls.push({
          session_id: input.session_id,
          text: input.text,
          workspace: input.workspace,
        })
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_perm_2",
        event_id: "evt_perm_2",
        message_id: "msg_perm_2",
        text: "说错了，我要看的是 /tmp/",
      }),
    )

    expect(steps).toEqual(["allow", "prompt"])
    expect(allow_calls).toEqual([
      {
        req: "req_perm_1",
        reply: "reject",
        message: "说错了，我要看的是 /tmp/",
        workspace: undefined,
      },
    ])
    expect(prompt_calls).toEqual([
      {
        session_id: "ses_1",
        text: "说错了，我要看的是 /tmp/",
        workspace: undefined,
      },
    ])
    expect((await store.get_task("tsk_1"))?.status).toBe("running")
    expect((await store.get_task("tsk_1"))?.note).toBe("已收到你的更正说明，正在继续执行…")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "blue",
        text: "已收到你的更正说明，正在继续执行…",
      },
    })
  })
  test("waiting_permission keeps waiting when correction reject request fails", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_permission",
        req_type: "permission",
        req: "req_perm_invalid",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/usr" }))}`,
      }),
    )
    let prompt_calls = 0
    const oc = {
      ...opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      async allow() {
        throw new Error("permission reply failed")
      },
      async prompt() {
        prompt_calls += 1
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_perm_invalid",
        event_id: "evt_perm_invalid",
        message_id: "msg_perm_invalid",
        text: "点错了，应该看 /tmp",
      }),
    )

    expect(prompt_calls).toBe(0)
    expect((await store.get_task("tsk_1"))?.status).toBe("waiting_permission")
    expect((await store.get_task("tsk_1"))?.req).toBe("req_perm_invalid")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "red",
        text: expect.stringContaining("permission reply failed"),
      },
    })
  })

  test("waiting_permission fails task when follow-up correction prompt fails", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    await store.save_session(session())
    await store.save_inbound(inbound())
    await store.save_task(
      row({
        status: "waiting_permission",
        req_type: "permission",
        req: "req_perm_prompt_fail",
        note: `approval:${encodeURIComponent("external_directory")}:${encodeURIComponent(JSON.stringify({ filepath: "/usr" }))}`,
      }),
    )
    const steps: string[] = []
    const oc = {
      ...opencode({
        status: {
          ses_1: { type: "busy" },
        },
      }),
      async allow() {
        steps.push("allow")
      },
      async prompt() {
        steps.push("prompt")
        throw new Error("prompt failed")
      },
    } satisfies OpencodeSvc

    await on_msg(
      cfg(),
      route(store),
      svc,
      store,
      ui.api,
      createRender(),
      oc,
      inbound({
        id: "in_perm_prompt_fail",
        event_id: "evt_perm_prompt_fail",
        message_id: "msg_perm_prompt_fail",
        text: "点错了，应该看 /tmp",
      }),
    )

    expect(steps).toEqual(["allow", "prompt"])
    expect((await store.get_task("tsk_1"))?.status).toBe("failed")
    expect((await store.get_task("tsk_1"))?.req).toBe("req_perm_prompt_fail")
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        title: "OpenCode",
        template: "red",
        text: expect.stringContaining("prompt failed"),
      },
    })
  })

})

// 第二张权限卡如果还没有 outbound_id，必须新发消息，不能错误 patch 到第一张卡上。
test("next queued approval is sent only after correction prompt succeeds", async () => {
  const store = createMemoryStore()
  const svc = createTaskSvc(store)
  const ui = feishu()
  await store.save_session(session())
  await store.save_inbound(inbound())
  await saveWait(store, {
    id: "tsk_perm_chain_1",
    inbound_id: "in_perm_chain_1",
    status: "waiting_permission",
    req: "req_perm_chain_1",
    kind: "approval",
    outbound_id: "out_perm_chain_1",
    payload: {
      tool: "external_directory",
      detail: JSON.stringify({ filepath: "/tmp" }),
    },
    seq: 1,
  })
  await store.save_inbound(inbound({ id: "in_perm_chain_2", event_id: "evt_perm_chain_2", message_id: "msg_perm_chain_2" }))
  await store.save_assistant_outbound({
    id: "aso_tsk_perm_chain_1_req_perm_chain_2",
    task_id: "tsk_perm_chain_1",
    session_id: "ses_1",
    seq: 2,
    kind: "approval",
    action: "deferred",
    state: "open",
    origin_inbound_id: "in_perm_chain_1",
    origin_message_id: "msg_in_perm_chain_1",
    req_key: "req_perm_chain_2",
    terminal: false,
    payload: {
      tool: "external_directory",
      detail: JSON.stringify({ filepath: "/etc" }),
    },
    created_at: 2,
    updated_at: 2,
  })
  const steps: string[] = []
  let prompt_started!: () => void
  const started = new Promise<void>((resolve) => {
    prompt_started = resolve
  })
  let release_prompt!: () => void
  const blocked = new Promise<void>((resolve) => {
    release_prompt = resolve
  })
  const oc = {
    ...opencode({
      status: {
        ses_1: { type: "busy" },
      },
    }),
    async allow() {
      steps.push("allow")
    },
    async prompt() {
      steps.push("prompt")
      prompt_started()
      await blocked
      steps.push("prompt_done")
    },
  } satisfies OpencodeSvc

  const pending = on_msg(
    cfg(),
    route(store),
    svc,
    store,
    ui.api,
    createRender(),
    oc,
    inbound({
      id: "in_perm_chain_answer",
      event_id: "evt_perm_chain_answer",
      message_id: "msg_perm_chain_answer",
      text: "路径写错了，请改看 /srv",
    }),
  )

  await started
  expect(steps).toEqual(["allow", "prompt"])
  expect((await store.get_task("tsk_perm_chain_1"))?.status).toBe("waiting_permission")
  expect((await store.get_task("tsk_perm_chain_1"))?.req).toBe("req_perm_chain_1")
  expect(
    ui.list.some((item) =>
      item.out.kind === "card" &&
      !!item.out.body &&
      typeof item.out.body === "object" &&
      "type" in item.out.body &&
      (item.out.body as { type?: string; req?: string }).type === "approval" &&
      (item.out.body as { type?: string; req?: string }).req === "req_perm_chain_2",
    ),
  ).toBe(false)

  release_prompt()
  await pending

  expect(steps).toEqual(["allow", "prompt", "prompt_done"])
  expect(ui.list[ui.list.length - 1]).toMatchObject({
    kind: "reply",
    out: {
      kind: "card",
      body: {
        type: "approval",
        req: "req_perm_chain_2",
      },
    },
  })
  const waits = await store.list_assistant_outbounds("tsk_perm_chain_1")
  const next = waits.find((item) => item.req_key === "req_perm_chain_2")
  expect(next?.feishu_message_id).toBeTruthy()
})
