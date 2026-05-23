import { describe, expect, test } from "bun:test"
import { explain, friendly, signal, status_text } from "../src/app/boot.ts"
import { stuck } from "../src/app/text.ts"
import type { AppCfg, ConnState, FeishuApi, ImSession, InboundMessage, RenderOut, Task } from "../src/contracts.ts"
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

function row(id: string, session_id: string, inbound_id: string, updated_at: number): Task {
  return {
    id,
    im_session_id: "ims_" + session_id,
    session_id,
    inbound_id,
    status: "running",
    created_at: 1,
    updated_at,
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

describe("error helpers", () => {
  test("maps common transport errors to user friendly text", () => {
    expect(friendly("unknown certificate verification error")).toBe(
      "网络请求失败：证书校验失败，请检查代理、HTTPS 证书或企业网关配置。",
    )
    expect(friendly("opencode request failed: 401 Unauthorized")).toBe(
      "认证失败：请检查 OpenCode 或飞书的账号、密码和权限配置。",
    )
    expect(friendly("opencode request failed: 429 Too Many Requests - rate limit")).toBe(
      "模型请求过于频繁：已触发限流，请稍后重试。",
    )
    expect(friendly("resource_exhausted")).toBe(
      "模型请求过于频繁：已触发限流，请稍后重试。",
    )
    expect(friendly("insufficient_quota")).toBe(
      "模型额度不足：请检查 provider 配额、账单或项目额度配置。",
    )
    expect(friendly("overloaded_error")).toBe(
      "模型服务繁忙：请稍后重试，或切换到其他模型。",
    )
    expect(friendly("opencode request failed: 400 Bad Request - context length exceeded")).toBe(
      "模型请求失败：上下文过长，请缩短问题、减少附件，或拆成多轮发送。",
    )
    expect(friendly("opencode request failed: 404 Not Found")).toBe(
      "OpenCode 接口不可用：请检查服务地址、接口版本或 base_url 配置。",
    )
    expect(friendly("opencode request failed: 500 Internal Server Error - Workspace not found: wrk_missing")).toBe(
      "Workspace 不存在：wrk_missing。请先用 /workspaces 查看当前目录下可用 ID；本地项目请省略 --workspace，若要清空当前绑定请直接使用 /repo --workspace。",
    )
    expect(friendly("feishu asset failed: 404 Not Found")).toBe(
      "附件下载失败：资源不存在、已失效，或当前消息上下文已不可访问。",
    )
    expect(friendly("attachment fetch failed: report.pdf - feishu asset failed: 404 Not Found")).toBe(
      "附件下载失败（report.pdf）：附件下载失败：资源不存在、已失效，或当前消息上下文已不可访问。",
    )
    expect(friendly("fetch failed")).toBe(
      "网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。",
    )
    expect(friendly("invalid_api_key")).toBe(
      "认证失败：请检查 OpenCode 或飞书的账号、密码和权限配置。",
    )
    expect(friendly("model_not_found")).toBe(
      "模型不可用：请检查当前 provider/model 配置，或切换到可用模型。",
    )
    expect(friendly("ETIMEDOUT while connecting to provider")).toBe(
      "请求超时：服务长时间没有响应，请稍后重试。",
    )
    expect(friendly("feishu api failed: 400 card content invalid")).toBe(
      "飞书接口请求失败：请求格式、卡片内容或目标消息状态不符合当前接口要求。",
    )
    expect(friendly("plain raw error")).toBe("plain raw error")
  })

  test("adds retry vs resend guidance for common runtime errors", () => {
    expect(explain("opencode request failed: 429 Too Many Requests - rate limit")).toContain(
      "建议：可稍后重试当前请求，一般不需要重发上一条消息。",
    )
    expect(explain("feishu asset failed: 404 Not Found")).toContain(
      "建议：请重新发送附件和说明，再试一次。",
    )
    expect(explain("opencode request failed: 500 Internal Server Error - Workspace not found: wrk_missing")).toContain(
      "建议：先发送 /workspaces 确认可用 workspace ID；如果你要用本地项目，请省略 --workspace；如果你要清空当前绑定，直接发送 /repo --workspace。",
    )
    expect(explain("opencode request failed: 400 Bad Request - session state invalid")).toContain(
      "建议：当前会话状态或请求参数可能异常，可先发送 /abort，再重试或重发上一条消息。",
    )
    expect(explain("ETIMEDOUT while connecting to provider")).toContain(
      "建议：可稍后重试当前请求，一般不需要重发上一条消息。",
    )
    expect(explain("model_not_found")).toContain(
      "建议：请先检查模型、凭证、配额或服务配置，修复后再重试。",
    )
    expect(explain("feishu api failed: 400 card content invalid")).toContain(
      "建议：请稍后重试；若持续失败，请检查卡片内容或目标消息是否仍可更新。",
    )
  })

  test("grades stuck guidance by task stage", () => {
    expect(stuck("queued")).toBe(
      "请求还在处理中，如长时间无变化可发送 /status 查看状态，或用 /abort 终止。",
    )
    expect(stuck("acked")).toBe(
      "请求还在处理中，如长时间无变化可发送 /status 查看状态，或用 /abort 终止。",
    )
    expect(stuck("running")).toBe(
      "还在处理中，如长时间无变化可发送 /status 查看状态，或用 /abort 终止。",
    )
  })

  test("shows guided failed summary in status text", () => {
    const message = {
      name: "message",
      status: "ready",
      updated_at: 1,
    } satisfies ConnState

    expect(
      status_text({
        row: {
          ...row("tsk_fail", "ses_fail", "in_fail", 1),
          status: "failed",
          err: "opencode request failed: 429 Too Many Requests - rate limit",
        },
        current: null,
        pref: {
          chat: null,
          user: null,
        },
        conf: cfg(),
        message,
        opencode: null,
      }),
    ).toContain("建议：可稍后重试当前请求，一般不需要重发上一条消息。")
  })

  test("throttles connection signals for recently updated tasks", async () => {
    const store = createMemoryStore()
    const svc = createTaskSvc(store)
    const ui = feishu()
    const ses = session("ses_1")
    const now = Date.now()
    await store.save_session(ses)
    await store.save_inbound(inbound("in_1"))
    await store.save_task(row("tsk_1", ses.session_id, "in_1", now))

    await signal(store, svc, ui.api, createRender(), "连接异常", ["running"], 1000)

    expect(ui.list.length).toBe(0)

    await signal(store, svc, ui.api, createRender(), "连接异常", ["running"], 0)

    expect(ui.list.length).toBe(1)
    expect(ui.list[0]).toMatchObject({
      kind: "reply",
      out: {
        kind: "card",
      },
    })
  })
})
