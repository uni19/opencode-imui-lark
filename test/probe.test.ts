/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { probe } from "../src/app/boot.ts"
import { done_msg } from "../src/app/text.ts"
import type {
  AppCfg,
  FeishuApi,
  ImSession,
  InboundMessage,
  OpencodeResult,
  OpencodeStatus,
  OpencodeSvc,
  RenderOut,
  Task,
} from "../src/contracts.ts"
import { createTaskSvc } from "../src/gateway/task.ts"
import { createRender } from "../src/render/text.ts"
import { createMemoryStore } from "../src/storage/db.ts"

function cfg(input?: Partial<AppCfg["opencode"]>) {
  return {
    log: { level: "info" },
    storage: { path: ":memory:" },
    feishu: { mode: "off" },
    opencode: {
      base_url: "http://127.0.0.1:4096",
      username: "opencode",
      directory: "/tmp",
      ...input,
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

function opencode(input: { status?: Record<string, OpencodeStatus>; last?: string | undefined; result?: OpencodeResult; fail?: boolean }) {
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
    async workspaces() {
      return []
    },
    async status(_input: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>> {
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
    async last(_input: { session_id: string; directory?: string; workspace?: string }): Promise<string | undefined> {
      return input.last
    },
    async result(_input: { session_id: string; directory?: string; workspace?: string }): Promise<OpencodeResult> {
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
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      kind: "card",
      body: {
        template: "blue",
        text: "已重新确认：请求已提交，仍在处理中…",
      },
    })
  })

  test("preserves unscoped runtime workspace for downstream probe calls", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_unscoped")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_unscoped"))
    await store.save_task(row("tsk_unscoped", ses.session_id, "in_unscoped", "running"))
    const calls: Array<{ name: string; input: { session_id?: string; directory?: string; workspace?: string } }> = []
    const oc = {
      ...opencode({
        status: {},
      }),
      async status(input: { directory?: string; workspace?: string }) {
        calls.push({ name: "status", input })
        return {}
      },
      async sessions(input: { directory?: string; workspace?: string; limit?: number; roots?: boolean }) {
        calls.push({
          name: "sessions",
          input: {
            directory: input.directory,
            workspace: input.workspace,
          },
        })
        return [
          {
            id: ses.session_id,
            title: "unscoped",
            directory: "/tmp",
            created_at: 1,
            updated_at: 1,
          },
        ]
      },
      async result(input: { session_id: string; directory?: string; workspace?: string }): Promise<OpencodeResult> {
        calls.push({
          name: "result",
          input: {
            session_id: input.session_id,
            directory: input.directory,
            workspace: input.workspace,
          },
        })
        return {
          state: "empty",
          completed: true,
        }
      },
    } satisfies OpencodeSvc

    const state = await probe(
      cfg({ workspace: "wrk_default" }),
      store,
      svc,
      ui.api,
      render,
      oc,
      (await store.get_task("tsk_unscoped"))!,
      false,
    )

    expect(state).toBe("settled")
    expect(calls).toEqual([
      { name: "status", input: { directory: "/tmp", workspace: undefined } },
      { name: "result", input: { session_id: "ses_unscoped", directory: "/tmp", workspace: undefined } },
      { name: "status", input: { directory: "/tmp", workspace: undefined } },
      { name: "sessions", input: { directory: "/tmp", workspace: undefined } },
    ])
  })

  test("ignores busy descendants from other workspaces when classifying idle probes", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = {
      ...session("ses_workspace_root"),
      workspace_id: "wrk_chat",
    } satisfies ImSession
    await store.save_session(ses)
    await store.save_inbound(inbound("in_workspace_root"))
    await store.save_task({
      ...row("tsk_workspace_root", ses.session_id, "in_workspace_root", "running"),
      workspace_id: "wrk_chat",
    })
    const calls: Array<{ name: string; input: { session_id?: string; directory?: string; workspace?: string } }> = []
    const oc = {
      ...opencode({
        result: {
          state: "ok",
          text: "done",
          completed: true,
        },
      }),
      async status(input: { directory?: string; workspace?: string }) {
        calls.push({ name: "status", input })
        return {
          ses_other_workspace_child: { type: "busy" },
        }
      },
      async sessions(input: { directory?: string; workspace?: string; limit?: number; roots?: boolean }) {
        calls.push({
          name: "sessions",
          input: {
            directory: input.directory,
            workspace: input.workspace,
          },
        })
        return [
          {
            id: ses.session_id,
            title: "current",
            directory: "/tmp",
            workspace_id: "wrk_chat",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "ses_other_workspace_child",
            title: "other workspace child",
            directory: "/tmp",
            workspace_id: "wrk_other",
            parent_id: ses.session_id,
            created_at: 1,
            updated_at: 1,
          },
        ]
      },
      async result(input: { session_id: string; directory?: string; workspace?: string }): Promise<OpencodeResult> {
        calls.push({
          name: "result",
          input: {
            session_id: input.session_id,
            directory: input.directory,
            workspace: input.workspace,
          },
        })
        return {
          state: "ok",
          text: "done",
          completed: true,
        }
      },
    } satisfies OpencodeSvc

    const state = await probe(
      cfg({ workspace: "wrk_default" }),
      store,
      svc,
      ui.api,
      render,
      oc,
      (await store.get_task("tsk_workspace_root"))!,
      false,
    )

    expect(state).toBe("settled")
    expect(calls).toEqual([
      { name: "status", input: { directory: "/tmp", workspace: "wrk_chat" } },
      { name: "result", input: { session_id: "ses_workspace_root", directory: "/tmp", workspace: "wrk_chat" } },
      { name: "status", input: { directory: "/tmp", workspace: "wrk_chat" } },
      { name: "sessions", input: { directory: "/tmp", workspace: "wrk_chat" } },
    ])
    expect((await store.get_task("tsk_workspace_root"))).toMatchObject({
      status: "completed",
      terminal_kind: "final",
    })
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject(
      render.final({
        text: "done",
      }),
    )
  })

  test("checkpoints running task on first idle probe and settles on repeated identical output", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_2")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_2"))
    await store.save_task(row("tsk_2", ses.session_id, "in_2", "running"))

    const first = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "final answer",
      }),
      (await store.get_task("tsk_2"))!,
      false,
    )

    const checkpointed = await store.get_task("tsk_2")
    expect(first).toBe("resumable")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(checkpointed?.terminal_kind).toBeUndefined()
    expect(checkpointed?.terminal_outbound_id).toBeUndefined()
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({
          text: "final answer",
        }),
      },
    ])

    const second = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "ok",
          text: "final answer",
          completed: true,
        },
      }),
      (await store.get_task("tsk_2"))!,
      false,
    )

    const settled = await store.get_task("tsk_2")
    expect(second).toBe("settled")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "reply", "patch"])
    expect(ui.list[ui.list.length - 2]?.out).toMatchObject({
      ...render.final({
        text: "final answer",
      }),
    })
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

  test("checkpoints empty idle probe once and fails on repeated identical observation", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_3")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3"))
    await store.save_task(row("tsk_3", ses.session_id, "in_3", "running"))

    const first = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
      }),
      (await store.get_task("tsk_3"))!,
      false,
    )

    const checkpointed = await store.get_task("tsk_3")
    expect(first).toBe("resumable")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(ui.list).toEqual([])

    const second = await probe(
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
      (await store.get_task("tsk_3"))!,
      false,
    )

    const settled = await store.get_task("tsk_3")
    expect(second).toBe("settled")
    expect(settled).toMatchObject({
      status: "failed",
      terminal_kind: "error",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      ...render.err({
        text: "已重新检查上一条执行状态：当前会话已结束，但没有可恢复结果，请重新发送上一条消息。",
      }),
    })
  })

  test("checkpoints filtered idle probe once and completes on repeated identical observation", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_3_filtered")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_3_filtered"))
    await store.save_task(row("tsk_3_filtered", ses.session_id, "in_3_filtered", "running"))

    const first = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "filtered",
        },
      }),
      (await store.get_task("tsk_3_filtered"))!,
      false,
    )

    const checkpointed = await store.get_task("tsk_3_filtered")
    expect(first).toBe("resumable")
    expect(checkpointed?.status).toBe("running")
    expect(typeof checkpointed?.result_hash).toBe("string")
    expect(ui.list).toEqual([])

    const second = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "filtered",
          completed: true,
        },
      }),
      (await store.get_task("tsk_3_filtered"))!,
      false,
    )

    const settled = await store.get_task("tsk_3_filtered")
    expect(second).toBe("settled")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(checkpointed?.result_hash)
    expect(ui.list[ui.list.length - 1]?.out).toMatchObject({
      ...render.final({
        text: done_msg({
          state: "filtered",
        }),
      }),
    })
  })

  test("resets non-wait checkpoint when probe result hash changes before settling", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const render = createRender()
    const ses = session("ses_hash_reset")
    await store.save_session(ses)
    await store.save_inbound(inbound("in_hash_reset"))
    await store.save_task(row("tsk_hash_reset", ses.session_id, "in_hash_reset", "running"))

    const first = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "first answer",
      }),
      (await store.get_task("tsk_hash_reset"))!,
      false,
    )

    const firstRow = await store.get_task("tsk_hash_reset")
    expect(first).toBe("resumable")
    expect(firstRow?.status).toBe("running")
    expect(typeof firstRow?.result_hash).toBe("string")
    expect(ui.list).toEqual([
      {
        kind: "reply",
        out: render.intermediate({
          text: "first answer",
        }),
      },
    ])

    const second = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        last: "second answer",
      }),
      (await store.get_task("tsk_hash_reset"))!,
      false,
    )

    const secondRow = await store.get_task("tsk_hash_reset")
    expect(second).toBe("resumable")
    expect(secondRow?.status).toBe("running")
    expect(typeof secondRow?.result_hash).toBe("string")
    expect(secondRow?.result_hash).not.toBe(firstRow?.result_hash)
    expect(ui.list[ui.list.length - 1]?.out).toEqual(
      render.intermediate({
        text: "second answer",
      }),
    )

    const third = await probe(
      cfg(),
      store,
      svc,
      ui.api,
      render,
      opencode({
        status: {},
        result: {
          state: "ok",
          text: "second answer",
          completed: true,
        },
      }),
      (await store.get_task("tsk_hash_reset"))!,
      false,
    )

    const settled = await store.get_task("tsk_hash_reset")
    expect(third).toBe("settled")
    expect(settled).toMatchObject({
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: "out_reply",
    })
    expect(settled?.result_hash).toBe(secondRow?.result_hash)
    expect(ui.list.map((item) => item.kind)).toEqual(["reply", "reply", "reply", "patch"])
    expect(ui.list[ui.list.length - 2]?.out).toMatchObject({
      ...render.final({
        text: "second answer",
      }),
    })
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

    const history = await store.list_assistant_outbounds("tsk_hash_reset")
    expect(history.filter((item) => item.terminal && item.state === "emitted")).toHaveLength(1)
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
