import { describe, expect, test } from "bun:test"
import { on_msg } from "../src/app/boot.ts"
import type { AppCfg, FeishuApi, InboundMessage, OpencodeSvc, RenderOut } from "../src/contracts.ts"
import { createSessionSvc } from "../src/gateway/session.ts"
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
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
    },
  } satisfies AppCfg
}

function inbound(id: string, input?: Partial<InboundMessage>): InboundMessage {
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
    text: "",
    message_id: "msg_" + id,
    assets: [],
    mentions: [],
    ...input,
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
      async fetch(input) {
        return {
          ...input.asset,
          mime: input.asset.kind === "image" ? "image/png" : "application/pdf",
          url: `file:///tmp/${input.asset.key}`,
          name: input.asset.name ?? input.asset.key,
        }
      },
      async sync() {},
      names() {
        return []
      },
    } satisfies FeishuApi,
    list,
  }
}

function opencode() {
  const prompts: Array<Parameters<OpencodeSvc["prompt"]>[0]> = []
  const aborts: Array<Parameters<OpencodeSvc["abort"]>[0]> = []
  let seq = 0
  return {
    svc: {
      async ensure() {
        seq += 1
        return { id: `ses_${seq}` }
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
      async prompt(input) {
        prompts.push(input)
      },
      async abort(input) {
        aborts.push(input)
      },
      async allow() {},
      async answer() {},
      async reject() {},
      async command() {
        return undefined
      },
      async last() {
        return undefined
      },
    } satisfies OpencodeSvc,
    prompts,
    aborts,
  }
}

describe("message flow", () => {
  test("accumulates attachments across turns before final text prompt", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_1", {
        assets: [
          {
            kind: "image",
            key: "img_1",
            name: "cover.png",
          },
        ],
      }),
    )

    const row = await store.get_last_task("ses_1")
    expect(row?.status).toBe("waiting_attachment")
    expect(await store.get_pending("ses_1")).toMatchObject({
      assets: [
        {
          kind: "image",
          key: "img_1",
        },
      ],
    })
    expect(ui.list[0]).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
        body: {
          text: "已收到：已收到 1 张图片，请再发一句你希望我做什么。我会把这些附件和你的说明一起处理。",
        },
      },
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_2", {
        assets: [
          {
            kind: "file",
            key: "file_1",
            name: "report.pdf",
          },
        ],
      }),
    )

    expect((await store.get_last_task("ses_1"))?.note).toBe("等待补充说明，已累计 1 张图片，1 个文件")
    expect(await store.get_pending("ses_1")).toMatchObject({
      assets: [
        {
          kind: "image",
          key: "img_1",
        },
        {
          kind: "file",
          key: "file_1",
        },
      ],
    })
    expect(ui.list[1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          text: "又收到 1 个文件，当前累计 1 张图片，1 个文件，请再发一句你希望我做什么。",
        },
      },
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_3", {
        text: "请总结这两个附件",
      }),
    )

    expect(await store.get_pending("ses_1")).toBeNull()
    expect((await store.get_last_task("ses_1"))?.status).toBe("running")
    expect(ui.list[2]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          text: "已提交补充说明",
        },
      },
    })
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toMatchObject({
      session_id: "ses_1",
      directory: "/tmp",
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
    })
    expect(ai.prompts[0]?.parts).toHaveLength(3)
    expect(ai.prompts[0]?.parts?.[0]).toMatchObject({
      type: "text",
    })
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("附件概览：1 张图片，1 个文件")
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("用户要求：请总结这两个附件")
    expect(ai.prompts[0]?.parts?.[1]).toMatchObject({
      type: "file",
      filename: "cover.png",
      mime: "image/png",
    })
    expect(ai.prompts[0]?.parts?.[2]).toMatchObject({
      type: "file",
      filename: "report.pdf",
      mime: "application/pdf",
    })
  })

  test("keeps waiting_attachment state when follow-up is blank", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_blank_1", {
        assets: [
          {
            kind: "image",
            key: "img_1",
          },
        ],
      }),
    )

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_blank_2", {
        text: "   ",
      }),
    )

    expect((await store.get_last_task("ses_1"))?.status).toBe("waiting_attachment")
    expect(await store.get_pending("ses_1")).not.toBeNull()
    expect(ai.prompts).toHaveLength(0)
    expect(ui.list.at(-1)).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
        body: {
          text: "已在等待你的补充说明，请再发一句你希望我做什么。",
        },
      },
    })
  })

  test("aborts waiting_attachment and clears pending context", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_abort_1", {
        assets: [
          {
            kind: "file",
            key: "file_1",
            name: "report.pdf",
          },
        ],
      }),
    )

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_abort_2", {
        text: "/abort",
      }),
    )

    expect((await store.get_last_task("ses_1"))?.status).toBe("aborted")
    expect((await store.get_last_task("ses_1"))?.note).toBe("已取消等待中的附件上下文。")
    expect(await store.get_pending("ses_1")).toBeNull()
    expect(ai.prompts).toHaveLength(0)
    expect(ai.aborts).toHaveLength(0)
    expect(ui.list.at(-1)).toMatchObject({
      kind: "reply",
      out: {
        kind: "text",
        body: {
          text: "已取消等待中的附件上下文。",
        },
      },
    })
  })

  test("creates a new session from waiting_attachment without remote abort", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_new_1", {
        assets: [
          {
            kind: "image",
            key: "img_1",
          },
        ],
      }),
    )

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_new_2", {
        text: "/new",
      }),
    )

    expect((await store.get_task_by_inbound("in_new_1"))?.status).toBe("aborted")
    expect((await store.get_task_by_inbound("in_new_1"))?.note).toBe("已取消等待中的附件上下文，并创建新会话。")
    expect(await store.get_pending("ses_1")).toBeNull()
    expect(ai.aborts).toHaveLength(0)
    expect(
      await store.get_session({
        tenant_id: "tenant",
        chat_id: "chat",
        thread_id: undefined,
      }),
    ).toMatchObject({
      session_id: "ses_2",
      directory: "/tmp",
    })
    expect(ui.list.at(-1)).toMatchObject({
      kind: "reply",
      out: {
        kind: "text",
        body: {
          text: "已创建新会话。\n目录：/tmp",
        },
      },
    })
  })

  test("builds prompt for multiple images with a single question", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_multi_1", {
        text: "比较这两张图的差异",
        assets: [
          {
            kind: "image",
            key: "img_1",
            name: "before.png",
          },
          {
            kind: "image",
            key: "img_2",
            name: "after.png",
          },
        ],
      }),
    )

    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]?.parts).toHaveLength(3)
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("附件概览：2 张图片")
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("1. 图片 before.png")
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("2. 图片 after.png")
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("用户要求：比较这两张图的差异")
    expect(ai.prompts[0]?.parts?.[1]).toMatchObject({
      type: "file",
      filename: "before.png",
      mime: "image/png",
    })
    expect(ai.prompts[0]?.parts?.[2]).toMatchObject({
      type: "file",
      filename: "after.png",
      mime: "image/png",
    })
  })

  test("keeps accumulating attachments across repeated attachment-only followups", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_hold_1", {
        assets: [
          {
            kind: "file",
            key: "file_1",
            name: "spec.pdf",
          },
        ],
      }),
    )

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_hold_2", {
        assets: [
          {
            kind: "image",
            key: "img_1",
            name: "cover.png",
          },
        ],
      }),
    )

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_hold_3", {
        assets: [
          {
            kind: "file",
            key: "file_2",
            name: "notes.txt",
          },
        ],
      }),
    )

    expect((await store.get_last_task("ses_1"))?.status).toBe("waiting_attachment")
    expect((await store.get_last_task("ses_1"))?.note).toBe("等待补充说明，已累计 1 张图片，2 个文件")
    expect(await store.get_pending("ses_1")).toMatchObject({
      assets: [
        { kind: "file", key: "file_1" },
        { kind: "image", key: "img_1" },
        { kind: "file", key: "file_2" },
      ],
    })
    expect(ui.list.at(-1)).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          text: "又收到 1 个文件，当前累计 1 张图片，2 个文件，请再发一句你希望我做什么。",
        },
      },
    })
    expect(ai.prompts).toHaveLength(0)
  })

  test("submits all accumulated files and images after repeated attachment-only turns", async () => {
    const store = createMemoryStore()
    const task = createTaskSvc(store)
    const ui = feishu()
    const ai = opencode()
    const conf = cfg()
    const render = createRender()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
      model: conf.opencode.model,
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_final_1", {
        assets: [
          {
            kind: "file",
            key: "file_1",
            name: "brief.pdf",
          },
        ],
      }),
    )

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_final_2", {
        assets: [
          {
            kind: "image",
            key: "img_1",
            name: "shot.png",
          },
        ],
      }),
    )

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_final_3", {
        text: "请结合这些材料给我最终结论",
      }),
    )

    expect(await store.get_pending("ses_1")).toBeNull()
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]?.parts).toHaveLength(3)
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("附件概览：1 张图片，1 个文件")
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("1. 文件 brief.pdf")
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("2. 图片 shot.png")
    expect((ai.prompts[0]?.parts?.[0] as { text?: string } | undefined)?.text).toContain("用户要求：请结合这些材料给我最终结论")
    expect(ai.prompts[0]?.parts?.[1]).toMatchObject({
      type: "file",
      filename: "brief.pdf",
      mime: "application/pdf",
    })
    expect(ai.prompts[0]?.parts?.[2]).toMatchObject({
      type: "file",
      filename: "shot.png",
      mime: "image/png",
    })
  })
})
