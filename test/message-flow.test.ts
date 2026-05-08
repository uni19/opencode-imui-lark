/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { holdmsg, on_msg, probe } from "../src/app/boot.ts"
import type { AppCfg, FeishuApi, InboundMessage, OpencodeResult, OpencodeStatus, OpencodeSvc, RenderOut } from "../src/contracts.ts"
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
      workspace: undefined,
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
  const replies: Array<{ id: string; msg_id: string; out: RenderOut }> = []
  const patches: Array<{ msg_id: string; out: RenderOut }> = []
  let replySeq = 0
  let sendSeq = 0
  return {
    api: {
      async send(input) {
        list.push({ kind: "send", out: input.out })
        sendSeq += 1
        return { id: `out_send_${sendSeq}` }
      },
      async reply(input) {
        list.push({ kind: "reply", out: input.out })
        replySeq += 1
        const id = `out_reply_${replySeq}`
        replies.push({ id, msg_id: input.msg_id, out: input.out })
        return { id }
      },
      async patch(input) {
        list.push({ kind: "patch", out: input.out })
        patches.push({ msg_id: input.msg_id, out: input.out })
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
    replies,
    patches,
  }
}

function opencode() {
  const prompts: Array<Parameters<OpencodeSvc["prompt"]>[0]> = []
  const aborts: Array<Parameters<OpencodeSvc["abort"]>[0]> = []
  const ensures: Array<Parameters<OpencodeSvc["ensure"]>[0]> = []
  let seq = 0
  const svc: OpencodeSvc = {
    async ensure(input) {
      ensures.push(input)
      seq += 1
      return { id: `ses_${seq}` }
    },
    async session(id: string) {
      return {
        id,
        title: `Session ${id}`,
        directory: "/tmp",
        created_at: 1,
        updated_at: 1,
      }
    },
    async sessions() {
      return []
    },
    async workspaces() {
      return []
    },
    async status(_input: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>> {
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
    async last(_input: { session_id: string; directory?: string; workspace?: string }): Promise<string | undefined> {
      return undefined
    },
  }
  return {
    svc,
    prompts,
    aborts,
    ensures,
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
    if (!row) throw new Error("missing task row")
    expect(row.status).toBe("waiting_attachment")
    expect(await store.get_task_pending(row.id)).toMatchObject({
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
    expect(await store.get_task_pending(row.id)).toMatchObject({
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

    expect(await store.get_task_pending(row.id)).toBeNull()
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
    })
    expect(ai.prompts[0]).not.toHaveProperty("model")
    expect(ai.prompts[0]).not.toHaveProperty("agent")
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
    const history = await store.list_assistant_outbounds(row.id)
    expect(history.map((item) => item.kind)).toEqual(["attachment", "attachment", "progress"])
    expect(history.map((item) => item.action)).toEqual(["reply", "patch", "patch"])
    expect(history.every((item) => item.state === "emitted")).toBe(true)
  })

  test("repo rebind omits default agent and model without explicit session override", async () => {
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
    })

    const current = await route.resolve({
      tenant_id: "tenant",
      chat_id: "chat",
      chat_type: undefined,
      thread_id: undefined,
      root_message_id: undefined,
      user_id: "user",
    })
    const rebound = await route.bind({
      session_id: current.session_id,
      directory: "/tmp/alt",
      workspace_id: "ws_alt",
    })
    if (!rebound) throw new Error("missing rebound session")

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_rebind_default", {
        text: "切到新目录后继续",
      }),
    )

    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toMatchObject({
      session_id: rebound.session_id,
      directory: "/tmp/alt",
      workspace: "ws_alt",
    })
    expect(ai.prompts[0]).not.toHaveProperty("model")
    expect(ai.prompts[0]).not.toHaveProperty("agent")
  })

  test("repo rebind clears stale workspace when directory changes and workspace is omitted", async () => {
    const store = createMemoryStore()
    const ai = opencode()
    const conf = cfg()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
    })

    const current = await route.resolve({
      tenant_id: "tenant",
      chat_id: "chat",
      chat_type: undefined,
      thread_id: undefined,
      root_message_id: undefined,
      user_id: "user",
    })
    const scoped = await route.bind({
      session_id: current.session_id,
      workspace_id: "ws_alt",
    })
    if (!scoped) throw new Error("missing scoped session")

    const rebound = await route.bind({
      session_id: scoped.session_id,
      directory: "/tmp/alt",
      workspace_id: undefined,
    })
    if (!rebound) throw new Error("missing rebound session")

    expect(rebound).toMatchObject({
      directory: "/tmp/alt",
      workspace_id: undefined,
    })
    expect(rebound.session_id).not.toBe(scoped.session_id)
  })

  test("repo rebind preserves workspace when directory is unchanged and workspace is omitted", async () => {
    const store = createMemoryStore()
    const ai = opencode()
    const conf = cfg()
    const route = createSessionSvc({
      store,
      opencode: ai.svc,
      directory: conf.opencode.directory,
      workspace: conf.opencode.workspace,
    })

    const current = await route.resolve({
      tenant_id: "tenant",
      chat_id: "chat",
      chat_type: undefined,
      thread_id: undefined,
      root_message_id: undefined,
      user_id: "user",
    })
    const scoped = await route.bind({
      session_id: current.session_id,
      workspace_id: "ws_alt",
    })
    if (!scoped) throw new Error("missing scoped session")

    const rebound = await route.bind({
      session_id: scoped.session_id,
      directory: "/tmp",
    })
    if (!rebound) throw new Error("missing rebound session")

    expect(rebound).toMatchObject({
      session_id: scoped.session_id,
      directory: "/tmp",
      workspace_id: "ws_alt",
    })
  })

  test("repo rebind keeps explicit session model override", async () => {

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
    })

    const current = await route.resolve({
      tenant_id: "tenant",
      chat_id: "chat",
      chat_type: undefined,
      thread_id: undefined,
      root_message_id: undefined,
      user_id: "user",
    })
    const updated = await route.model({
      session_id: current.session_id,
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
    })
    if (!updated) throw new Error("missing updated session")
    const rebound = await route.bind({
      session_id: updated.session_id,
      directory: "/tmp/alt",
      workspace_id: "ws_alt",
    })
    if (!rebound) throw new Error("missing rebound session")

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_model_rebind", {
        text: "切到新目录后继续",
      }),
    )

    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toMatchObject({
      session_id: rebound.session_id,
      directory: "/tmp/alt",
      workspace: "ws_alt",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
    })
    expect(ai.prompts[0]).not.toHaveProperty("agent")
  })

  test("reuses the same session and task for resumable follow-up", async () => {
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
    })
    let statuses: Record<string, OpencodeStatus> = {}
    let last: string | undefined
    ai.svc.status = async (_input: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>> => statuses
    ai.svc.last = async (_input: { session_id: string; directory?: string; workspace?: string }): Promise<string | undefined> => last

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_resume_1", {
        text: "先做第一步分析",
      }),
    )

    const first = await store.get_task_by_inbound("in_resume_1")
    if (!first) throw new Error("missing first task")
    expect(first.status).toBe("running")
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]?.session_id).toBe("ses_1")

    statuses = {
      ses_1: { type: "idle" },
    }
    last = "阶段性答案"

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_resume_2", {
        text: "继续往下做",
      }),
    )

    const rebound = await store.get_task(first.id)
    const active = await store.get_task_by_inbound("in_resume_2")
    if (!rebound || !active) throw new Error("missing rebound task")
    expect(rebound).toMatchObject({
      id: first.id,
      status: "running",
      session_id: "ses_1",
      inbound_id: "in_resume_2",
      reply_anchor_message_id: "msg_in_resume_2",
    })
    expect(rebound.superseded_by_task_id).toBeUndefined()
    expect(rebound.terminal_kind).toBeUndefined()
    expect(rebound.result_hash).toBeUndefined()
    expect(active.id).toBe(first.id)
    expect(active.session_id).toBe("ses_1")
    expect(await store.list_tasks()).toHaveLength(1)
    expect(
      await store.get_session({
        tenant_id: "tenant",
        chat_id: "chat",
        thread_id: undefined,
      }),
    ).toMatchObject({
      session_id: "ses_1",
    })
    expect(ai.prompts).toHaveLength(2)
    expect(ai.prompts.map((item) => item.session_id)).toEqual(["ses_1", "ses_1"])
    expect(ai.aborts).toHaveLength(0)
    expect(ui.replies[1]).toMatchObject({
      id: "out_reply_2",
      msg_id: "msg_in_resume_1",
      out: render.intermediate({ text: "阶段性答案" }),
    })
    const history = await store.list_assistant_outbounds(first.id)
    expect(history[history.length - 2]).toMatchObject({
      kind: "intermediate",
      action: "reply",
      origin_inbound_id: "in_resume_1",
      origin_message_id: "msg_in_resume_1",
      feishu_message_id: "out_reply_2",
    })
    expect(history[history.length - 1]).toMatchObject({
      kind: "ack",
      action: "reply",
      origin_inbound_id: "in_resume_2",
      origin_message_id: "msg_in_resume_2",
      feishu_message_id: "out_reply_3",
    })
  })

  test("intermediate task follow-up keeps original status card as terminal patch target", async () => {
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
    })
    let statuses: Record<string, OpencodeStatus> = {}
    let result: OpencodeResult = { state: "empty" }
    ai.svc.status = async (_input: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>> => statuses
    ai.svc.result = async (_input: { session_id: string; directory?: string; workspace?: string }): Promise<OpencodeResult> => result
    ai.svc.last = async (_input: { session_id: string; directory?: string; workspace?: string }): Promise<string | undefined> => result.text

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_chain_1", {
        text: "先做第一步分析",
      }),
    )

    const first = await store.get_task_by_inbound("in_chain_1")
    if (!first) throw new Error("missing first task")
    expect(first.outbound_id).toBe("out_reply_1")

    statuses = {
      ses_1: { type: "idle" },
    }
    result = {
      state: "ok",
      text: "阶段性答案",
      completed: false,
    }

    const probeState = await probe(conf, store, task, ui.api, render, ai.svc, first)
    expect(probeState).toBe("resumable")

    const checkpointed = await store.get_task(first.id)
    if (!checkpointed) throw new Error("missing checkpointed task")
    expect(checkpointed).toMatchObject({
      id: first.id,
      outbound_id: "out_reply_1",
      status_outbound_id: "out_reply_1",
      result_hash: expect.any(String),
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_chain_2", {
        text: "继续往下做",
      }),
    )

    const rebound = await store.get_task(first.id)
    if (!rebound) throw new Error("missing rebound task")
    expect(rebound).toMatchObject({
      id: first.id,
      session_id: "ses_1",
      inbound_id: "in_chain_2",
      reply_anchor_message_id: "msg_in_chain_2",
      outbound_id: "out_reply_4",
      status_outbound_id: "out_reply_1",
    })
    expect(await store.list_tasks()).toHaveLength(1)

    result = {
      state: "ok",
      text: "最终完成",
      completed: true,
    }

    const settled = await probe(conf, store, task, ui.api, render, ai.svc, rebound)
    expect(settled).toBe("settled")

    const finished = await store.get_task(first.id)
    if (!finished) throw new Error("missing finished task")
    expect(finished).toMatchObject({
      id: first.id,
      session_id: "ses_1",
      outbound_id: "out_reply_5",
      status_outbound_id: "out_reply_1",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply_5",
      status: "completed",
    })

    expect(ui.replies.map((item) => item.id)).toEqual(["out_reply_1", "out_reply_2", "out_reply_3", "out_reply_4", "out_reply_5"])
    expect(ui.replies[0]).toMatchObject({
      id: "out_reply_1",
      msg_id: "msg_in_chain_1",
      out: render.ack({ text: "先做第一步分析" }),
    })
    expect(ui.replies[1]).toMatchObject({
      id: "out_reply_2",
      msg_id: "msg_in_chain_1",
      out: render.intermediate({ text: "阶段性答案" }),
    })
    expect(ui.replies[2]).toMatchObject({
      id: "out_reply_3",
      msg_id: "msg_in_chain_1",
      out: render.intermediate({ text: "阶段性答案" }),
    })
    expect(ui.replies[3]).toMatchObject({
      id: "out_reply_4",
      msg_id: "msg_in_chain_2",
      out: render.ack({ text: "继续往下做" }),
    })
    expect(ui.replies[4]).toMatchObject({
      id: "out_reply_5",
      msg_id: "msg_in_chain_2",
      out: render.final({ text: "最终完成" }),
    })
    expect(ui.patches).toHaveLength(1)
    expect(ui.patches[0]).toMatchObject({
      msg_id: "out_reply_1",
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
    expect(ui.patches.some((item) => item.msg_id === "out_reply_3")).toBe(false)

    const history = await store.list_assistant_outbounds(first.id)
    expect(history.map((item) => item.kind)).toEqual(["ack", "intermediate", "intermediate", "ack", "final"])
    expect(history[0]).toMatchObject({
      kind: "ack",
      action: "reply",
      origin_inbound_id: "in_chain_1",
      origin_message_id: "msg_in_chain_1",
      feishu_message_id: "out_reply_1",
    })
    expect(history[1]).toMatchObject({
      kind: "intermediate",
      action: "reply",
      origin_inbound_id: "in_chain_1",
      origin_message_id: "msg_in_chain_1",
      feishu_message_id: "out_reply_2",
    })
    expect(history[2]).toMatchObject({
      kind: "intermediate",
      action: "reply",
      origin_inbound_id: "in_chain_1",
      origin_message_id: "msg_in_chain_1",
      feishu_message_id: "out_reply_3",
    })
    expect(history[3]).toMatchObject({
      kind: "ack",
      action: "reply",
      origin_inbound_id: "in_chain_2",
      origin_message_id: "msg_in_chain_2",
      feishu_message_id: "out_reply_4",
    })
    expect(history[4]).toMatchObject({
      kind: "final",
      action: "reply",
      origin_inbound_id: "in_chain_2",
      origin_message_id: "msg_in_chain_2",
      terminal: true,
      feishu_message_id: "out_reply_5",
    })
  })

  test("clears pending when attachment follow-up prompt submission fails", async () => {
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
    })

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_fail_1", {
        assets: [
          {
            kind: "image",
            key: "img_fail_1",
            name: "broken.png",
          },
        ],
      }),
    )

    const waiting = await store.get_last_task("ses_1")
    if (!waiting) throw new Error("missing waiting task")
    ai.svc.prompt = async () => {
      throw new Error("prompt failed")
    }

    let err: unknown
    try {
      await on_msg(
        conf,
        route,
        task,
        store,
        ui.api,
        render,
        ai.svc,
        inbound("in_fail_2", {
          text: "请继续处理这张图",
        }),
      )
    } catch (caught) {
      err = caught
    }

    expect((err as Error | undefined)?.message).toBe("prompt failed")
    expect((await store.get_task(waiting.id))?.status).toBe("failed")
    expect(await store.get_task_pending(waiting.id)).toBeNull()
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          template: "red",
        },
      },
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

    const waiting = await store.get_last_task("ses_1")
    if (!waiting) throw new Error("missing waiting task")
    expect(waiting.status).toBe("waiting_attachment")
    expect(await store.get_task_pending(waiting.id)).not.toBeNull()
    expect(ai.prompts).toHaveLength(0)
    expect(ui.list[ui.list.length - 1]).toMatchObject({
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

    const aborted = await store.get_last_task("ses_1")
    if (!aborted) throw new Error("missing aborted task")
    expect(aborted.status).toBe("aborted")
    expect(aborted.note).toBe("已取消等待中的附件上下文。")
    expect(await store.get_task_pending(aborted.id)).toBeNull()
    expect(ai.prompts).toHaveLength(0)
    expect(ai.aborts).toHaveLength(0)
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "reply",
      out: {
        kind: "text",
        body: {
          text: "已取消等待中的附件上下文。",
        },
      },
    })
  })

  test("creates a new session from waiting_attachment without remote abort and replays wait when switched back", async () => {
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

    const original = await store.get_task_by_inbound("in_new_1")
    if (!original) throw new Error("missing original waiting task")
    expect(original.status).toBe("waiting_attachment")
    expect(await store.get_task_pending(original.id)).not.toBeNull()
    expect(ai.aborts).toHaveLength(0)
    expect(ai.ensures).toHaveLength(1)
    expect(
      await store.get_session({
        tenant_id: "tenant",
        chat_id: "chat",
        thread_id: undefined,
      }),
    ).toMatchObject({
      session_id: expect.stringMatching(/^pending_new:/),
      directory: "/tmp",
      state: "pending_new",
    })
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "reply",
      out: {
        kind: "text",
        body: {
          text: "已切换到新会话，首次发送消息时创建。\n目录：/tmp",
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
      inbound("in_new_3", {
        text: "/session ses_1",
      }),
    )

    expect(ui.list[ui.list.length - 2]).toMatchObject({
      kind: "reply",
      out: {
        kind: "text",
        body: {
          text: "已切换当前会话。\nsession: ses_1\n目录：/tmp\n模型：openai/gpt-5.4",
        },
      },
    })
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          text: holdmsg([
            {
              kind: "image",
              key: "img_1",
              mime: "image/png",
              url: "file:///tmp/img_1",
              name: "img_1",
            },
          ]),
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
      inbound("in_new_4", {
        text: "/new",
      }),
    )

    expect(ai.ensures).toHaveLength(1)

    await on_msg(
      conf,
      route,
      task,
      store,
      ui.api,
      render,
      ai.svc,
      inbound("in_new_5", {
        text: "请分析这张图",
      }),
    )

    expect(ai.ensures).toHaveLength(2)
    expect(ai.prompts[ai.prompts.length - 1]).toMatchObject({
      session_id: "ses_2",
    })
    expect(await store.get_session({ tenant_id: "tenant", chat_id: "chat", thread_id: undefined })).toMatchObject({
      session_id: "ses_2",
      state: "active",
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

    const latest = await store.get_last_task("ses_1")
    if (!latest) throw new Error("missing accumulated task")
    expect(latest.status).toBe("waiting_attachment")
    expect(latest.note).toBe("等待补充说明，已累计 1 张图片，2 个文件")
    expect(await store.get_task_pending(latest.id)).toMatchObject({
      assets: [
        { kind: "file", key: "file_1" },
        { kind: "image", key: "img_1" },
        { kind: "file", key: "file_2" },
      ],
    })
    expect(ui.list[ui.list.length - 1]).toMatchObject({
      kind: "patch",
      out: {
        kind: "card",
        body: {
          text: "又收到 1 个文件，当前累计 1 张图片，2 个文件，请再发一句你希望我做什么。",
        },
      },
    })
    expect(ai.prompts).toHaveLength(0)
    const history = await store.list_assistant_outbounds(latest.id)
    expect(history.map((item) => item.kind)).toEqual(["attachment", "attachment", "attachment"])
    expect(history.map((item) => item.action)).toEqual(["reply", "patch", "patch"])
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

    const waiting = await store.get_last_task("ses_1")
    if (!waiting) throw new Error("missing waiting task")

    expect(await store.get_task_pending(waiting.id)).toBeNull()
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
